// roomManager.js
const { Game } = require('./game');
const crypto = require('crypto');

let activeGames = {}; 
let ioInstance; 

function generateRoomId() {
    return crypto.randomBytes(3).toString('hex');
}

function getRoomById(roomId) {
    return activeGames[roomId];
}

// function init(socket, io) { ... } 
// (这里应该是你完整的 init 函数定义)
// 为了简洁，我只写函数签名，你需要确保你的函数体是完整的
function init(socket, io) {
    if (!ioInstance && io) {
        ioInstance = io;
        console.log("[ROOM MANAGER] ioInstance initialized.");
    } else if (!ioInstance && !io) {
        console.error("[ROOM MANAGER] CRITICAL: init called without io object, ioInstance remains uninitialized.");
    }

    socket.on('createRoom', (data, callback) => {
        if (!socket.userId) {
            console.error("[ROOM CREATE] Error: User not logged in for socket.", socket.id);
            return callback({ success: false, message: '请先登录才能创建房间。' });
        }
        const { roomName, password } = data;

        console.log(`[ROOM CREATE ATTEMPT] User: ${socket.username} (ID: ${socket.userId}), RoomName: "${roomName}", Password provided: ${!!password}`);

        if (!roomName || typeof roomName !== 'string' || roomName.trim().length === 0) {
            console.warn("[ROOM CREATE] Invalid room name from user:", socket.username, "Name:", roomName);
            return callback({ success: false, message: '需要有效的房间名称。' });
        }
        if (password && (typeof password !== 'string' || password.length > 20)) {
            console.warn("[ROOM CREATE] Invalid password format for room:", roomName, "User:", socket.username);
            return callback({ success: false, message: '密码格式无效 (最多20字符)。' });
        }

        let roomId = generateRoomId();
        let attempts = 0;
        const MAX_ID_GEN_ATTEMPTS = 20;
        while(activeGames[roomId] && attempts < MAX_ID_GEN_ATTEMPTS) {
            console.log(`[ROOM CREATE] Room ID ${roomId} exists, generating new one. Attempt: ${attempts + 1}`);
            roomId = generateRoomId();
            attempts++;
        }
        if (activeGames[roomId]) {
             console.error("[ROOM CREATE] Failed to generate unique Room ID after", MAX_ID_GEN_ATTEMPTS, "attempts.");
             return callback({success: false, message: "创建房间失败，服务器繁忙，请稍后再试。"});
        }

        console.log(`[ROOM CREATE] Generated new Room ID: ${roomId} for "${roomName}"`);
        const game = new Game(roomId, 4); // Assuming maxPlayers is 4
        const newRoom = {
            roomId: roomId,
            roomName: roomName.trim(),
            password: (password && password.trim().length > 0) ? password.trim() : null,
            creatorId: socket.userId,
            players: [], 
            game: game,
            status: 'waiting'
        };

        activeGames[roomId] = newRoom;
        console.log(`[ROOM CREATED] Room: "${newRoom.roomName}" (ID: ${roomId}, Pwd: ${newRoom.password ? 'Yes' : 'No'}) by ${socket.username}`);

        const joinResult = addPlayerToRoom(newRoom, socket);
        if (joinResult.success) {
            socket.join(roomId); 
            socket.roomId = roomId; 
            
            console.log(`[ROOM CREATE] Creator ${socket.username} successfully added to room ${roomId}.`);
            
            const initialStateForCreator = getRoomStateForPlayer(newRoom, socket.userId, false);
            console.log(`[ROOM CREATE] Initial state for creator ${socket.username}:`, JSON.stringify(initialStateForCreator, null, 2).substring(0, 500) + "...");


            callback({ success: true, roomId: roomId, roomState: initialStateForCreator });
            broadcastRoomList();
        } else {
            console.error(`[ROOM CREATE] Critical error: Failed to add creator ${socket.username} to their own room ${roomId}. Deleting room. Reason: ${joinResult.message}`);
            delete activeGames[roomId]; 
            callback({ success: false, message: `创建房间后加入失败: ${joinResult.message}` });
        }
    });

    socket.on('joinRoom', (data, callback) => {
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
         const { roomId, password } = data;
         const room = activeGames[roomId];

         console.log(`[ROOM JOIN ATTEMPT] User: ${socket.username}, RoomID: ${roomId}, Pwd provided: ${!!password}`);

         if (!room) {
            console.warn(`[ROOM JOIN] Room ${roomId} not found for user ${socket.username}`);
            return callback({ success: false, message: '房间不存在。' });
         }

         const existingPlayer = room.players.find(p => p.userId === socket.userId);
         if (existingPlayer) {
            if (!existingPlayer.connected) { 
                console.log(`[ROOM JOIN] Player ${socket.username} is rejoining room ${roomId} (was disconnected).`);
                const reconnectResult = handleReconnect(socket, roomId); 
                if (reconnectResult.success) {
                    callback({ success: true, roomId: roomId, roomState: reconnectResult.roomState });
                } else {
                    callback({ success: false, message: reconnectResult.message });
                }
            } else { 
                 console.log(`[ROOM JOIN] Player ${socket.username} already connected in room ${roomId}. Re-syncing socket.`);
                 socket.join(roomId); 
                 socket.roomId = roomId;
                 existingPlayer.socketId = socket.id;
                 existingPlayer.connected = true; 

                 callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'), message: "您已在此房间中。" });
            }
            return;
         }

         if (room.status !== 'waiting') {
            console.warn(`[ROOM JOIN] Room ${roomId} not in 'waiting' state (is ${room.status}). User ${socket.username} cannot join.`);
            return callback({ success: false, message: '游戏已开始或已结束，无法加入。' });
         }
         if (room.players.length >= (room.game.maxPlayers || 4) ) { // Use game.maxPlayers
            console.warn(`[ROOM JOIN] Room ${roomId} is full. User ${socket.username} cannot join.`);
            return callback({ success: false, message: '房间已满。' });
         }
         if (room.password && room.password !== password) {
            console.warn(`[ROOM JOIN] Incorrect password for room ${roomId} by user ${socket.username}.`);
            return callback({ success: false, message: '房间密码错误。' });
         }

         const joinResult = addPlayerToRoom(room, socket);
         if (joinResult.success) {
             socket.join(roomId);
             socket.roomId = roomId;
             console.log(`[ROOM JOINED] Player ${socket.username} joined room "${room.roomName}" (${roomId})`);
             const playerJoinedInfo = { 
                userId: joinResult.player.userId, 
                username: joinResult.player.username, 
                slot: joinResult.player.slot,
                isReady: joinResult.player.isReady,
                connected: true, 
                score: joinResult.player.score || 0, 
                handCount: 0 
             };
             socket.to(roomId).emit('playerJoined', playerJoinedInfo);
             callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId, false) });
             broadcastRoomList();
         } else {
             console.error(`[ROOM JOIN] Failed to add player ${socket.username} to room ${roomId}. Reason: ${joinResult.message}`);
             callback({ success: false, message: joinResult.message });
         }
    });

    socket.on('listRooms', (callback) => {
        const roomList = getPublicRoomList();
         if (typeof callback === 'function') {
            callback(roomList);
         }
     });

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

        player.isReady = !!isReady; 
        console.log(`[ROOM ${socket.roomId}] Player ${player.username} (ID: ${player.userId}, Slot: ${player.slot}) readiness updated to: ${player.isReady}. Connected: ${player.connected}`);

        if (ioInstance && socket.roomId) { 
            ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: player.userId, isReady: player.isReady });
        } else {
            console.error("[PLAYER READY] ioInstance or socket.roomId is invalid, cannot emit 'playerReadyUpdate'.");
        }
        
        checkAndStartGame(room); 
        
        if(typeof callback === 'function') callback({ success: true });
    });

    socket.on('playCard', (cards, callback) => {
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。' });
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: '房间或游戏不存在。' });
        if (room.status !== 'playing') return callback({ success: false, message: '游戏未在进行中。' });

        const result = room.game.playCard(socket.userId, cards);
        console.log(`[PLAY CARD] User: ${socket.username}, Room: ${socket.roomId}, Cards: ${JSON.stringify(cards)}, Result: ${JSON.stringify(result)}`);
        if (result.success) {
            if (result.gameOver) {
                room.status = 'finished';
                const finalRoomState = getRoomStateForPlayer(room, null, true); // Pass null as requestingUserId for general game over state
                if(ioInstance) ioInstance.to(socket.roomId).emit('gameOver', finalRoomState);
                console.log(`[GAME OVER] Room ${socket.roomId} finished. Result: ${result.scoreResult ? result.scoreResult.result : 'N/A'}`);
                broadcastRoomList(); 
            } else {
                room.players.forEach(p => {
                    if (p.connected && p.socketId && ioInstance) {
                        const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                        if (playerSocket) {
                             playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                        }
                    }
                });
            }
        }
        if (typeof callback === 'function') callback(result);
    });

    socket.on('passTurn', (callback) => {
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。' });
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: '房间或游戏不存在。' });
        if (room.status !== 'playing') return callback({ success: false, message: '游戏未在进行中。' });

        const result = room.game.handlePass(socket.userId);
        console.log(`[PASS TURN] User: ${socket.username}, Room: ${socket.roomId}, Result: ${JSON.stringify(result)}`);
        if (result.success) {
            room.players.forEach(p => {
                if (p.connected && p.socketId && ioInstance) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) {
                        playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                    }
                }
            });
        }
        if (typeof callback === 'function') callback(result);
    });

    socket.on('requestHint', (currentHintCycleIndex, callback) => {
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。' });
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: '房间或游戏不存在。' });
        if (room.status !== 'playing') return callback({ success: false, message: '游戏未在进行中。' });
        
        const result = room.game.findHint(socket.userId, currentHintCycleIndex);
        console.log(`[REQUEST HINT] User: ${socket.username}, Room: ${socket.roomId}, Result: ${result.success ? 'Hint found' : result.message}`);
        if (typeof callback === 'function') callback(result);
    });

    socket.on('leaveRoom', (callback) => {
        if (!socket.userId || !socket.roomId) {
            console.warn(`[LEAVE ROOM] Invalid op: User ${socket.userId} trying to leave room ${socket.roomId} but one is missing. Socket: ${socket.id}`);
            return callback({ success: false, message: '无效操作，无法确定用户或房间。' });
        }
        const room = activeGames[socket.roomId];
        if (!room) {
            console.warn(`[LEAVE ROOM] Room ${socket.roomId} not found for user ${socket.username} (ID: ${socket.userId}).`);
            socket.roomId = null; 
            return callback({ success: true, message: '房间已不存在。' });
        }

        handlePlayerLeavingRoom(room, socket);
        if (typeof callback === 'function') callback({ success: true });
    });

    socket.on('requestGameState', (callback) => {
         if (!socket.userId || !socket.roomId) {
             console.log(`[REQUEST GAME STATE] Invalid: No userId or roomId for socket ${socket.id}`);
             if (typeof callback === 'function') callback(null);
             return;
         }
         const room = activeGames[socket.roomId];
         if (room && typeof callback === 'function') {
             console.log(`[REQUEST GAME STATE] Sending state for room ${socket.roomId} to ${socket.username}`);
             callback(getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'));
         } else if (typeof callback === 'function') {
             console.log(`[REQUEST GAME STATE] Room ${socket.roomId} not found for ${socket.username}.`);
             callback(null);
         }
     });
     
    socket.on('toggleAI', ({ enabled }, callback) => {
        if (!socket.userId || !socket.roomId) {
            return callback({ success: false, message: '无效操作，请先登录并进入房间。' });
        }
        const room = activeGames[socket.roomId];
        if (!room || !room.game) {
            return callback({ success: false, message: '房间或游戏不存在。' });
        }
        if (room.status !== 'playing') {
            return callback({ success: false, message: '游戏未在进行中，无法切换AI托管。' });
        }
        const player = room.game.players.find(p => p.id === socket.userId);
        if (player) {
            player.isAiControlled = !!enabled;
            console.log(`[AI TOGGLE] Player ${player.name} (ID: ${socket.userId}) in room ${socket.roomId} AI status set to: ${player.isAiControlled}`);
            
            // 广播状态更新，让所有客户端都能同步AI状态（如果UI上有显示）
            if (ioInstance) {
                room.players.forEach(pInRoom => {
                    if (pInRoom.connected && pInRoom.socketId) {
                        const playerSocket = ioInstance.sockets.sockets.get(pInRoom.socketId);
                        if (playerSocket) {
                             playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, pInRoom.userId, true));
                        }
                    }
                });
            }

            // 如果开启AI且轮到该玩家，则触发AI行动
            if (player.isAiControlled && room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
                console.log(`[AI TOGGLE] AI for ${player.name} activated and it's their turn. Triggering AI move.`);
                // room.game.makeAiMove(socket.userId); // 假设game.js有此方法
                // 为了安全，这里可以稍微延迟一下，或者让nextTurn的逻辑去触发
                setTimeout(() => {
                    if (room.game && room.game.players[room.game.currentPlayerIndex]?.id === socket.userId && room.game.players[room.game.currentPlayerIndex]?.isAiControlled) {
                         // 再次检查，确保条件仍然满足
                         // room.game.makeAiMove(socket.userId);
                         console.log(`[AI] (Delayed) Placeholder for AI move for ${player.name}`);
                         // 实际AI出牌/过牌后会再次广播gameStateUpdate
                    }
                }, 500); // 短暂延迟
            }
            callback({ success: true, message: `AI托管已${enabled ? '开启' : '关闭'}` });
        } else {
            callback({ success: false, message: '找不到玩家游戏数据。' });
        }
    });
}

// ... (addPlayerToRoom, checkAndStartGame, getRoomStateForPlayer, handlePlayerLeavingRoom, handleDisconnect, handleReconnect, getPublicRoomList, broadcastRoomList, handleAuthentication 等函数的完整定义)
// (确保这些函数都存在并且逻辑正确)
// ... 例如 ...
function addPlayerToRoom(room, socket) { /* ... 你的完整函数 ... */ }
function checkAndStartGame(room) { /* ... 你的完整函数 ... */ }
function getRoomStateForPlayer(room, requestingUserId, isGameUpdate = false) { /* ... 你的完整函数 ... */ }
function handlePlayerLeavingRoom(room, socket) { /* ... 你的完整函数 ... */ }
function handleDisconnect(socket) { /* ... 你的完整函数 ... */ }
function handleReconnect(socket, roomId) { /* ... 你的完整函数 ... */ }
function getPublicRoomList() { /* ... 你的完整函数 ... */ }
function broadcastRoomList() { /* ... 你的完整函数 ... */ }
function handleAuthentication(socket) { /* ... 你的完整函数 ... */ }


// --- 确保所有需要导出的函数都在这里 ---
module.exports = {
    init,
    handleDisconnect,
    handleAuthentication,
    getPublicRoomList,
    findRoomByUserId, // findRoomByUserId 应该在模块作用域内定义或从其他地方导入
    handleReconnect,
    getRoomById
};

// 简单实现 findRoomByUserId (如果它只在这个模块内用)
function findRoomByUserId(userId) {
    for (const roomId in activeGames) {
        if (activeGames[roomId].players.some(p => p.userId === userId)) {
            return activeGames[roomId];
        }
    }
    return null;
}
