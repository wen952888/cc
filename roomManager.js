// roomManager.js
const { Game } = require('./game');
const crypto = require('crypto');

let activeGames = {}; 
let ioInstance; 

function generateRoomId() { /* ... */ }
function getRoomById(roomId) { /* ... */ }

function init(socket, io) {
    if (!ioInstance && io) { // 确保ioInstance只被初始化一次，并且io对象有效
        ioInstance = io;
        console.log("[ROOM MANAGER] ioInstance initialized.");
    } else if (!ioInstance && !io) {
        console.error("[ROOM MANAGER] CRITICAL: init called without io object, ioInstance remains uninitialized.");
    }


    socket.on('createRoom', (data, callback) => { /* ... (检查日志输出) ... */ });
    socket.on('joinRoom', (data, callback) => { /* ... (检查日志输出) ... */ });
    socket.on('listRooms', (callback) => { /* ... */ });

    socket.on('playerReady', (isReady, callback) => {
        if (!socket.userId || !socket.roomId) {
            console.warn("[PLAYER READY] Invalid op: no userId or roomId. Socket:", socket.id);
            return callback({ success: false, message: '无效操作。' });
        }
        const room = activeGames[socket.roomId];
        if (!room) {
            console.warn("[PLAYER READY] Room not found:", socket.roomId, "User:", socket.username);
            return callback({success: false, message: "房间信息丢失。"});
        }
        if (room.status !== 'waiting') {
            console.warn(`[PLAYER READY] Room ${socket.roomId} status is ${room.status}, not 'waiting'. User: ${socket.username}`);
            return callback({ success: false, message: '不在等待中的房间内或游戏已开始。' });
        }

        const player = room.players.find(p => p.userId === socket.userId);
        if (!player) {
            console.error("[PLAYER READY] Player data not found in room:", socket.roomId, "User ID:", socket.userId);
            return callback({ success: false, message: '玩家数据异常。' });
        }

        player.isReady = !!isReady; // 确保是布尔值
        console.log(`[ROOM ${socket.roomId}] Player ${player.username} (ID: ${player.userId}, Slot: ${player.slot}) readiness updated to: ${player.isReady}. Connected: ${player.connected}`);

        if (ioInstance && socket.roomId) { // 确保 ioInstance 和 roomId 有效
            ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: player.userId, isReady: player.isReady });
        } else {
            console.error("[PLAYER READY] ioInstance or socket.roomId is invalid, cannot emit 'playerReadyUpdate'.");
        }
        
        // --- 关键调用 ---
        checkAndStartGame(room); 
        
        if(typeof callback === 'function') callback({ success: true });
    });

    // ... (playCard, passTurn, requestHint, leaveRoom, requestGameState, audio处理等保持不变) ...
    // 在 leaveRoom 之后，如果房间内人数变化且仍在等待，可以考虑调用 checkAndStartGame
    // 但通常是 playerReady 触发，或重连后。
}


function addPlayerToRoom(room, socket) { /* ... (确保 connected 和 isReady 初始状态正确) ... */ }

function checkAndStartGame(room) {
     if (!room) {
        console.error("[CHECK START GAME] Critical: Room object is null or undefined.");
        return;
     }
     console.log(`[CHECK START GAME] Evaluating room ${room.roomId}, current status: ${room.status}`);

     if (room.status !== 'waiting') {
        console.log(`[CHECK START GAME] Room ${room.roomId} is not in 'waiting' state (is ${room.status}). Skipping start check.`);
        return;
     }

     // 打印详细的玩家状态
     console.log(`[CHECK START GAME] Players in room ${room.roomId}:`);
     room.players.forEach(p => {
         console.log(`  - Player: ${p.username} (ID: ${p.userId}), Connected: ${p.connected}, Ready: ${p.isReady}, Slot: ${p.slot}`);
     });

     const connectedPlayers = room.players.filter(p => p.connected);
     const readyPlayers = connectedPlayers.filter(p => p.isReady); // 现在基于所有已连接玩家来筛选准备好的

     console.log(`[CHECK START GAME] Room ${room.roomId}: Total Players in room.players = ${room.players.length}, Connected = ${connectedPlayers.length}, Ready (among connected) = ${readyPlayers.length}, Required = ${room.game.maxPlayers || 4}`);
     
     const requiredPlayers = room.game.maxPlayers || 4; // 从game实例获取或默认为4

     // 修改条件：确保是已连接的玩家数量达到要求，并且这些已连接的玩家都准备好了
     if (connectedPlayers.length === requiredPlayers && readyPlayers.length === requiredPlayers) {
         console.log(`[GAME STARTING] Room ${room.roomId}: All ${requiredPlayers} connected players are ready. Attempting to start game...`);
         room.status = 'playing'; //乐观地更新状态，如果失败会回滚

         const playerStartInfo = connectedPlayers.map(p => ({
             id: p.userId,
             name: p.username,
             slot: p.slot,
             score: p.score || 0 
         })).sort((a,b) => a.slot - b.slot); // 确保按slot顺序给game.js

         if (!room.game) {
             console.error(`[CHECK START GAME] Critical: room.game instance is null for room ${room.roomId}. Cannot start game.`);
             room.status = 'waiting'; // 回滚状态
             if (ioInstance) ioInstance.to(room.roomId).emit('gameStartFailed', { message: "服务器内部错误：游戏对象丢失。" });
             return;
         }

         const startResult = room.game.startGame(playerStartInfo);

         if (startResult.success) {
             console.log(`[GAME STARTED] Game in room ${room.roomId} started successfully by Game instance.`);
             if (!ioInstance) {
                 console.error("[GAME STARTED] CRITICAL: ioInstance is not available. Cannot emit 'gameStarted' to clients.");
                 // 游戏实际上开始了，但客户端不知道，这是个大问题
                 return;
             }
             // 给每个在房间内且连接的玩家发送个性化的 gameStarted 事件
             room.players.forEach(playerInRoom => {
                 if (playerInRoom.connected && playerInRoom.socketId) {
                     const playerSocket = ioInstance.sockets.sockets.get(playerInRoom.socketId);
                     if (playerSocket) {
                         const initialStateForPlayer = getRoomStateForPlayer(room, playerInRoom.userId, true);
                         playerSocket.emit('gameStarted', initialStateForPlayer);
                         console.log(`[GAME STARTED] Sent 'gameStarted' to ${playerInRoom.username} (SocketID: ${playerInRoom.socketId}) in room ${room.roomId}`);
                     } else {
                         console.warn(`[GAME STARTED] Could not find socket for player ${playerInRoom.username} (SocketID: ${playerInRoom.socketId}) in room ${room.roomId}. They might miss the game start.`);
                     }
                 }
             });
             broadcastRoomList(); 
         } else {
             console.error(`[GAME START FAILED] Room ${room.roomId}: Game.startGame failed with message: "${startResult.message}". Reverting room status to 'waiting'.`);
             room.status = 'waiting'; // 启动失败，回滚状态
             if (ioInstance) {
                ioInstance.to(room.roomId).emit('gameStartFailed', { message: startResult.message || "游戏启动失败，请检查日志。" });
                // 重置所有玩家的准备状态，因为游戏启动失败了
                room.players.forEach(p => { 
                    if(p.isReady) { // 只对之前点了准备的玩家操作
                        p.isReady = false; 
                        // 还需要通知客户端更新这个状态
                        ioInstance.to(room.roomId).emit('playerReadyUpdate', { userId: p.userId, isReady: p.isReady });
                    }
                });
                // 或者发送一个特定事件让客户端统一取消准备
                // ioInstance.to(room.roomId).emit('allPlayersResetReady'); // 如果客户端有对应处理
             }
         }
     } else {
        console.log(`[CHECK START GAME] Room ${room.roomId}: Conditions not met to start. (Connected: ${connectedPlayers.length}/${requiredPlayers}, Ready: ${readyPlayers.length}/${requiredPlayers})`);
     }
}


function getRoomStateForPlayer(room, requestingUserId, isGameUpdate = false) { /* ... (确保这里返回的 player.connected 和 player.isReady 是准确的) ... */ }

function handleDisconnect(socket) {
    if (!socket.userId) {
        console.log(`[DISCONNECT] Socket ${socket.id} disconnected (was not fully authenticated).`);
        return;
    }

    const room = findRoomByUserId(socket.userId); 
    if (room) {
        console.log(`[DISCONNECT] Player ${socket.username} (ID: ${socket.userId}) disconnected from room "${room.roomName}" (${room.roomId}).`);
        const playerInRoom = room.players.find(p => p.userId === socket.userId);

        if (playerInRoom) {
            playerInRoom.connected = false;
            playerInRoom.isReady = false; // 断线即取消准备
            
            console.log(`[DISCONNECT] Player ${playerInRoom.username} in room ${room.roomId} marked as connected: false, isReady: false.`);

            if (ioInstance) { // 确保 ioInstance 有效
                ioInstance.to(room.roomId).emit('playerDisconnected', { userId: socket.userId, username: socket.username });
                 // 还需要更新其他玩家看到的这个玩家的准备状态
                ioInstance.to(room.roomId).emit('playerReadyUpdate', { userId: socket.userId, isReady: false });
            }


            if (room.status === 'playing' && room.game) {
                // ... (原有的游戏中断线处理逻辑) ...
            } else if (room.status === 'waiting') {
                // 如果在等待状态，有人断线，可能会影响开始条件，检查一下
                console.log(`[DISCONNECT] Player disconnected from waiting room ${room.roomId}. Re-evaluating start conditions.`);
                checkAndStartGame(room); // 虽然不太可能因为断线而开始游戏，但保持一致性
            }
            // ... (清理空房间等逻辑) ...
        }
        broadcastRoomList();
    } else { /* ... */ }
}

function handleReconnect(socket, roomId) {
    // ... (之前的重连逻辑) ...
    const room = activeGames[roomId];
    if (!room || !socket.userId) { /* ... */ return { success: false, message: '...' }; }
    const player = room.players.find(p => p.userId === socket.userId);
    if (!player) { /* ... */ return { success: false, message: '...' }; }

    player.connected = true;
    player.socketId = socket.id;
    // player.isReady = false; // 通常重连后需要重新准备，或者从服务器恢复状态（如果服务器有保存）
                           // 当前规则下，如果希望保持准备状态，则不修改。如果希望重连后取消准备，则设置为 false.
                           // 假设保持之前的准备状态，但如果之前是false，重连后应该还是false。
                           // 如果之前是true，现在重连，是应该保持true还是false？
                           // 考虑到游戏可能因为他断线而未能开始，重连后让他保持之前的准备状态可能更合理。
                           // 如果他断线时游戏正在进行，isReady意义不大。

    socket.join(roomId);
    socket.roomId = roomId;

    if (room.game) {
        room.game.markPlayerConnected(socket.userId, true);
    }
    console.log(`[RECONNECT] Player ${player.username} reconnected to room ${room.roomId}. Current ready state: ${player.isReady}`);

    socket.to(roomId).emit('playerReconnected', { userId: player.userId, username: player.username });
    const roomStateForPlayer = getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting');
    
    // 更新所有其他玩家的状态
    room.players.forEach(p => { /* ... */ });
    
    // 如果房间在等待状态，重连后检查是否可以开始游戏
    if (room.status === 'waiting') {
        console.log(`[RECONNECT] Player reconnected to waiting room ${room.roomId}. Re-evaluating start conditions.`);
        checkAndStartGame(room);
    }
    broadcastRoomList();
    return { success: true, roomState: roomStateForPlayer };
}

// ... (getPublicRoomList, broadcastRoomList, handleAuthentication 等) ...

module.exports = { /* ... exports ... */ };
