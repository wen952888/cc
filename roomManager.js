// roomManager.js
const { Game } = require('./game');
const crypto = require('crypto');

let activeGames = {}; // { roomId: { roomId, roomName, password, game: GameInstance, players: [], status, hostId, lastActivityTime } }
let ioInstance;

const ROOM_TTL_SECONDS = 30 * 60; // 房间在无活动（例如所有人都断线）后多久被清理，例如30分钟
const PLAYER_RECONNECT_WINDOW_SECONDS = 60; // 玩家断线后，保留其在房间内位置的时间窗口，例如60秒

function generateRoomId() { return crypto.randomBytes(3).toString('hex'); }
function getRoomById(roomId) { return activeGames[roomId]; }

function findRoomByUserId(userId) {
    for (const roomId in activeGames) {
        if (activeGames[roomId] && activeGames[roomId].players.some(p => p.userId === userId)) {
            return activeGames[roomId];
        }
    }
    return null;
}

function broadcastRoomList() {
    if (ioInstance) {
        const publicList = getPublicRoomList();
        ioInstance.emit('roomListUpdate', publicList);
        console.log("[BROADCAST RM] Room list updated. Count:", publicList.length);
    } else {
        console.warn("[BROADCAST RM] ioInstance not available for room list broadcast.");
    }
}

function getPublicRoomList() {
    return Object.values(activeGames)
        .filter(room => room && room.status !== 'archived') // 不显示已归档的房间
        .map(room => ({
            roomId: room.roomId,
            roomName: room.roomName,
            playerCount: room.players.filter(p => p.connected).length,
            maxPlayers: room.game ? (room.game.maxPlayers || 4) : 4,
            status: room.status,
            hasPassword: !!room.password
        }));
}

function getRoomStateForPlayer(room, requestingUserId, isGameUpdate = false) {
    // ... (此函数逻辑与之前版本基本一致，确保它能正确组装状态) ...
    // (请参考您项目中已有的、功能正确的 getRoomStateForPlayer 版本)
    // 为简洁起见，这里不重复粘贴，假设它已能正常工作并返回包含所有必要字段的对象
    // 例如：roomId, roomName, status, players (含手牌、角色等), centerPile, currentPlayerId 等
    if (!room) return null;
    const gameExists = !!room.game;
    const gameState = (isGameUpdate || room.status === 'playing' || room.status === 'finished') && gameExists
        ? room.game.getStateForPlayer(requestingUserId)
        : null;
    const combinedPlayers = room.players.map(roomPlayer => { /* ... 您的玩家信息合并逻辑 ... */
        const gamePlayerInfo = gameState && gameState.players ? gameState.players.find(gp => gp.id === roomPlayer.userId) : null;
        return {
            userId: roomPlayer.userId, username: roomPlayer.username, slot: roomPlayer.slot,
            isReady: roomPlayer.isReady, connected: roomPlayer.connected,
            score: gamePlayerInfo ? gamePlayerInfo.score : (roomPlayer.score || 0),
            hand: gamePlayerInfo ? gamePlayerInfo.hand : undefined, // 只给自己的手牌
            handCount: gamePlayerInfo ? gamePlayerInfo.handCount : (roomPlayer.handCount || (gameExists && room.game.players.find(p=>p.id===roomPlayer.userId)?.hand.length) || 0),
            isCurrentPlayer: gameState ? gameState.currentPlayerId === roomPlayer.userId : false,
            role: gamePlayerInfo ? gamePlayerInfo.role : (gameExists && room.game.playerRoles ? room.game.playerRoles[roomPlayer.userId] : roomPlayer.role),
            finished: gamePlayerInfo ? gamePlayerInfo.finished : roomPlayer.finished,
            isAiControlled: roomPlayer.isAiControlled || (gamePlayerInfo ? gamePlayerInfo.isAiControlled : false)
        };
    });
    return {
        roomId: room.roomId, roomName: room.roomName, status: room.status, players: combinedPlayers,
        centerPile: gameState?.centerPile ?? [], lastHandInfo: gameState?.lastHandInfo ?? null,
        currentPlayerId: gameState?.currentPlayerId ?? null, isFirstTurn: gameState?.isFirstTurn ?? (room.status === 'playing'),
        myUserId: requestingUserId, gameMode: gameExists ? room.game.gameMode : null,
        gameResultText: gameState?.gameResultText, gameOverReason: gameState?.gameOverReason,
        finalScores: gameState?.finalScores, scoreChanges: gameState?.scoreChanges,
        gameFinished: gameState?.gameFinished ?? (room.status === 'finished'),
        gameStarted: gameState?.gameStarted ?? (room.status === 'playing')
    };
}


function addPlayerToRoom(room, socket) {
    // ... (此函数逻辑与之前版本基本一致，确保它能正确添加玩家或更新重连玩家信息) ...
    // (请参考您项目中已有的、功能正确的 addPlayerToRoom 版本)
    // 确保在玩家已存在于 room.players 时，正确更新 socketId 和 connected 状态
    if (!room || !room.game || !socket || !socket.userId || !socket.username) {
        console.error("[ADD PLAYER RM] Critical: Invalid parameters for addPlayerToRoom.");
        return { success: false, message: "服务器内部错误：玩家或房间信息不完整。" };
    }
    const maxPlayers = room.game.maxPlayers || 4;
    const existingPlayer = room.players.find(p => p.userId === socket.userId);
    if (existingPlayer) {
        console.log(`[ADD PLAYER RM] Player ${socket.username} (ID: ${socket.userId}) already in room ${room.roomId}. Updating connection.`);
        existingPlayer.socketId = socket.id;
        existingPlayer.connected = true;
        existingPlayer.username = socket.username; // Sync name
        const gamePlayer = room.game.players.find(p => p.id === socket.userId);
        if (gamePlayer) gamePlayer.connected = true; else room.game.addPlayer(socket.userId, socket.username, existingPlayer.slot); // Ensure in game instance
        return { success: true, player: existingPlayer, rejoining: true };
    }
    if (room.players.filter(p => p.connected).length >= maxPlayers) { /* Check connected players */
        return { success: false, message: "房间已满。" };
    }
    const existingSlots = room.players.map(p => p.slot);
    let assignedSlot = -1;
    for (let i = 0; i < maxPlayers; i++) { if (!existingSlots.includes(i)) { assignedSlot = i; break; } }
    if (assignedSlot === -1) { return { success: false, message: "无法找到可用位置。" }; }
    const playerInfo = { userId: socket.userId, username: socket.username, socketId: socket.id, isReady: false, slot: assignedSlot, connected: true, score: 0, isAiControlled: false, handCount: 0, role: null, finished: false };
    room.players.push(playerInfo);
    room.players.sort((a, b) => a.slot - b.slot);
    if (!room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot)) {
        console.warn(`[ADD PLAYER RM] game.addPlayer failed for ${playerInfo.username} in ${room.roomId}, but added to room.players.`);
    }
    room.lastActivityTime = Date.now(); // Update room activity time
    console.log(`[ADD PLAYER RM] Player ${playerInfo.username} added to room ${room.roomId}, slot ${assignedSlot}.`);
    return { success: true, player: playerInfo, rejoining: false };
}

function checkAndStartGame(room) { /* ... (保持之前的逻辑) ... */ }

function handlePlayerLeavingRoom(room, socket, reason = "left") {
    if (!room || !socket || !socket.userId) return;
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    console.log(`[LEAVE ROOM RM] Player ${username} (Socket: ${socket.id}) is leaving room ${room.roomId}. Reason: ${reason}`);

    const playerIndexInRoom = room.players.findIndex(p => p.userId === socket.userId);
    if (playerIndexInRoom === -1) {
        console.warn(`[LEAVE ROOM RM] Player ${username} not found in room.players for ${room.roomId}.`);
        socket.leave(room.roomId); // Still ensure they leave the socket.io room
        return;
    }

    // 关键：不是直接删除玩家，而是标记为断开，除非特定情况
    // room.players.splice(playerIndexInRoom, 1)[0]; // 旧的直接删除逻辑
    const leavingPlayer = room.players[playerIndexInRoom];
    leavingPlayer.connected = false; // 标记为断开
    leavingPlayer.socketId = null;   // 清除 socketId
    console.log(`[LEAVE ROOM RM] Marked player ${username} as disconnected in room.players for ${room.roomId}.`);

    if (room.game) {
        const playerInGame = room.game.players.find(p => p.id === socket.userId);
        if (playerInGame) playerInGame.connected = false;
    }

    socket.leave(room.roomId);
    if (socket.roomId === room.roomId) socket.roomId = null;

    if (ioInstance) {
        ioInstance.to(room.roomId).emit('playerLeft', { userId: socket.userId, username: username }); // 仍然通知其他人该玩家“离开”（UI上可能表现为断线）
        room.players.forEach(p => { // 给房间内剩余玩家发送更新
            if (p.connected && p.socketId) {
                const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (targetSocket) targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
            }
        });
    }
    room.lastActivityTime = Date.now();

    // 清理房间的逻辑现在由 pruneEmptyOrInactiveRooms 处理
    // checkAndPruneRoom(room); // 改为定时清理
    broadcastRoomList();
}

function handleDisconnect(socket) {
    if (!socket || !socket.userId) {
        console.log(`[DISCONNECT RM] Socket ${socket ? socket.id : 'N/A'} disconnected without userId.`);
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    console.log(`[DISCONNECT RM] Handling disconnect for user ${username} (Socket: ${socket.id})`);

    const room = findRoomByUserId(socket.userId);
    if (room) {
        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (playerInRoom) {
            if (playerInRoom.socketId === socket.id) { //确保是同一个socket实例断开
                playerInRoom.connected = false;
                playerInRoom.socketId = null; // 清除旧的socketId
                console.log(`[DISCONNECT RM] Marked player ${username} as disconnected in room.players for ${room.roomId}.`);

                if (room.game) {
                    const gamePlayer = room.game.players.find(gp => gp.id === socket.userId);
                    if (gamePlayer) gamePlayer.connected = false;
                }
                
                if (room.status === 'waiting' && playerInRoom.isReady) {
                    playerInRoom.isReady = false;
                    if (ioInstance) ioInstance.to(room.roomId).emit('playerReadyUpdate', { userId: playerInRoom.userId, isReady: false });
                }

                if (ioInstance) {
                    room.players.forEach(p => {
                        if (p.connected && p.socketId) {
                            const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                            if (targetSocket) targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                        }
                    });
                }
                room.lastActivityTime = Date.now();
                // checkAndPruneRoom(room); // 改为定时清理
            } else {
                console.log(`[DISCONNECT RM] Socket ${socket.id} disconnected, but player ${username} in room ${room.roomId} has a different socketId (${playerInRoom.socketId}). Likely reconnected on new socket.`);
            }
        }
        broadcastRoomList();
    }
}

function handleReconnect(socket, roomId) {
    // ... (此函数逻辑与之前版本基本一致，确保它能正确处理重连) ...
    // (请参考您项目中已有的、功能正确的 handleReconnect 版本，并确保其中有 try-catch)
    // 关键是成功后返回 { success: true, roomState: ... }
    const username = socket.username || `User ${socket.userId ? socket.userId.substring(0,6) : 'Unknown'}`;
    console.log(`[RECONNECT RM] Handling reconnect for ${username} (Socket: ${socket.id}) to room ${roomId}.`);
    try {
        const room = activeGames[roomId];
        if (!room) return { success: false, message: "房间不存在。" };
        if (room.status === 'archived') return { success: false, message: "房间已关闭。" }; // 不能重连到已归档房间
        if (!room.game) return { success: false, message: "房间数据损坏。" };
        const playerInRoomList = room.players.find(p => p.userId === socket.userId);
        if (!playerInRoomList) return { success: false, message: "您不在此房间中。" };

        playerInRoomList.connected = true;
        playerInRoomList.socketId = socket.id;
        playerInRoomList.username = socket.username;
        const playerInGameInstance = room.game.players.find(p => p.id === socket.userId);
        if (playerInGameInstance) { playerInGameInstance.connected = true; playerInGameInstance.name = socket.username; }
        else if (room.status === 'waiting') { room.game.addPlayer(socket.userId, socket.username, playerInRoomList.slot); }

        socket.join(roomId);
        socket.roomId = roomId;
        room.lastActivityTime = Date.now();
        console.log(`[RECONNECT RM] Player ${username} reconnected to room ${roomId}.`);
        if (ioInstance) {
            room.players.forEach(p => {
                if (p.socketId && ioInstance.sockets.sockets.get(p.socketId)) { // 确保socket存在
                     ioInstance.sockets.sockets.get(p.socketId).emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                }
            });
        }
        broadcastRoomList();
        return { success: true, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting') };
    } catch (error) {
        console.error(`[RECONNECT RM] Error during handleReconnect for ${username} to room ${roomId}:`, error);
        return { success: false, message: `服务器内部错误: ${error.message}` };
    }
}

function handleAuthentication(socket) { /* ... (保持不变) ... */ }

// 新增：定期清理不活跃或空房间的函数
function pruneInactiveRooms() {
    const now = Date.now();
    let prunedCount = 0;
    for (const roomId in activeGames) {
        const room = activeGames[roomId];
        if (!room) continue;

        const connectedPlayers = room.players.filter(p => p.connected).length;
        const timeSinceLastActivity = (now - (room.lastActivityTime || now)) / 1000; // seconds

        // 条件1: 房间内没有已连接的玩家，并且超过了玩家重连窗口时间
        // 条件2: 房间长时间不活跃（例如，即使有“断开”的玩家记录，但很久没人回来了）
        if ((connectedPlayers === 0 && timeSinceLastActivity > PLAYER_RECONNECT_WINDOW_SECONDS * 2) || // 给足重连时间
            (timeSinceLastActivity > ROOM_TTL_SECONDS)) {
            
            console.log(`[PRUNE RM] Pruning room ${roomId} (${room.roomName}). Connected: ${connectedPlayers}, Inactive for: ${timeSinceLastActivity.toFixed(0)}s.`);
            if (room.game && typeof room.game.endGame === 'function' && room.game.gameStarted && !room.game.gameFinished) {
                room.game.endGame("Room inactive or empty, pruned by server.");
            }
            // 可以选择彻底删除，或者标记为 archived 以便后续分析
            // delete activeGames[roomId];
            room.status = 'archived'; // 标记为已归档，getPublicRoomList会过滤掉
            prunedCount++;
        }
    }
    if (prunedCount > 0) {
        console.log(`[PRUNE RM] Pruned ${prunedCount} inactive/empty room(s).`);
        broadcastRoomList(); // 因为可能有房间从列表中消失
    }
}
// 定时器，例如每5分钟检查一次
setInterval(pruneInactiveRooms, 5 * 60 * 1000);


function init(socket, io) {
    if (!ioInstance && io) ioInstance = io;
    if (!socket) { console.error("[ROOM MANAGER INIT] CRITICAL: null socket."); return; }
    console.log(`[ROOM MANAGER INIT] Events for socket ${socket.id}, User: ${socket.username || 'N/A'}`);

    socket.on('createRoom', (data, callback) => {
        console.log(`[EVENT createRoom RM] From ${socket.username || socket.id}. Data:`, data);
        if (typeof callback !== 'function') { console.error("No callback for createRoom"); return; }
        try {
            if (!socket.userId) return callback({ success: false, message: '请先登录。' });
            const { roomName, password } = data;
            if (findRoomByUserId(socket.userId)) return callback({ success: false, message: '您已在其他房间中。' });
            if (!roomName || roomName.trim().length === 0 || roomName.length > 10) return callback({ success: false, message: '房间名无效 (1-10字符)。' });
            
            let newRoomId = generateRoomId();
            while (activeGames[newRoomId]) newRoomId = generateRoomId();
            
            const gameInstance = new Game(newRoomId, 4);
            const newRoom = {
                roomId: newRoomId, roomName: roomName.trim(), password: password || null,
                game: gameInstance, players: [], status: 'waiting', hostId: socket.userId,
                lastActivityTime: Date.now() // 初始化活动时间
            };
            activeGames[newRoomId] = newRoom;

            const addCreatorResult = addPlayerToRoom(newRoom, socket);
            if (!addCreatorResult.success) {
                delete activeGames[newRoomId]; // 清理未成功创建的房间
                return callback({ success: false, message: `创建房间失败: ${addCreatorResult.message}` });
            }
            socket.join(newRoomId);
            socket.roomId = newRoomId;
            callback({ success: true, roomId: newRoomId, roomState: getRoomStateForPlayer(newRoom, socket.userId, false) });
            broadcastRoomList(); // 创建成功后广播
            console.log(`[EVENT createRoom RM] Room "${newRoom.roomName}" (ID: ${newRoomId}) created by ${socket.username}.`);
        } catch (error) {
            console.error(`[EVENT createRoom RM] Error:`, error);
            callback({ success: false, message: '服务器创建房间时发生内部错误。' });
        }
    });

    // ... (其他 socket.on 事件处理器，如 joinRoom, playerReady, playCard, passTurn, requestHint, leaveRoom, requestGameState, toggleAI)
    // 确保这些处理器在修改房间状态（如玩家加入/离开，游戏开始/结束）后，都调用 broadcastRoomList()
    // 以及在适当的时候更新 room.lastActivityTime = Date.now();

    // 示例：joinRoom 修改后
    socket.on('joinRoom', (data, callback) => {
        // ... (大部分逻辑保持不变)
        // 在成功加入后:
        // room.lastActivityTime = Date.now();
        // broadcastRoomList();
        // checkAndStartGame(room);
        // ...
        const { roomId, password: joinPassword } = data;
        const requestingUsername = socket.username || socket.id;
        console.log(`[EVENT joinRoom RM] From ${requestingUsername} for room: ${roomId}. Pwd: ${!!joinPassword}`);
        if (typeof callback !== 'function') { console.error("No callback for joinRoom"); return; }
        try {
            if (!socket.userId) return callback({ success: false, message: '请先登录。' });
            const room = activeGames[roomId];
            if (!room || room.status === 'archived') return callback({ success: false, message: '房间不存在或已关闭。' });
            if (!room.game) return callback({ success: false, message: '房间数据损坏。'});
            
            const existingPlayerInThisRoom = room.players.find(p => p.userId === socket.userId);
            if (existingPlayerInThisRoom) { // 玩家已在此房间，可能是重连
                 if (!existingPlayerInThisRoom.connected) { // 确实是断线重连
                    const reconnectResult = handleReconnect(socket, roomId); // handleReconnect会更新socketId和状态
                    return callback(reconnectResult);
                 } else { // 已经在房间且连接着 (例如，开了两个标签页)
                    existingPlayerInThisRoom.socketId = socket.id; // 更新为新的socket
                    socket.join(roomId); socket.roomId = roomId;
                    return callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'), message: "您已在此房间中。" });
                 }
            }
            if (findRoomByUserId(socket.userId)) return callback({ success: false, message: '您已在其他房间中。' }); // 不能同时加入多个房间
            if (room.status !== 'waiting') return callback({ success: false, message: '游戏已开始或结束。' });
            if (room.players.filter(p => p.connected).length >= (room.game.maxPlayers || 4)) return callback({ success: false, message: '房间已满。' });
            if (room.password && room.password !== joinPassword) return callback({ success: false, message: '房间密码错误。' });

            const addResult = addPlayerToRoom(room, socket);
            if (addResult.success && addResult.player) {
                socket.join(roomId); socket.roomId = roomId;
                room.lastActivityTime = Date.now();
                socket.to(roomId).emit('playerJoined', { /* playerJoinedInfo from addResult.player */
                    userId: addResult.player.userId, username: addResult.player.username, slot: addResult.player.slot, 
                    isReady: addResult.player.isReady, connected: true, score: addResult.player.score || 0, 
                    handCount: 0, isAiControlled: addResult.player.isAiControlled || false,
                    role: null, finished: false
                });
                callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId, false) });
                broadcastRoomList();
                checkAndStartGame(room);
            } else { callback({ success: false, message: addResult.message || "加入房间内部错误。" }); }
        } catch (error) { console.error(`[EVENT joinRoom RM] Error:`, error); callback({ success: false, message: '服务器加入房间时发生内部错误。' }); }
    });

    // 确保其他事件如 playerReady, playCard, passTurn, leaveRoom, toggleAI 也在改变房间状态或玩家列表后调用 broadcastRoomList()
    // 并且在有玩家活动的事件中更新 room.lastActivityTime
}

module.exports = {
    init,
    handleDisconnect, // 由 server.js 调用
    handleAuthentication, // 由 authManager.js 调用
    getPublicRoomList, // 由 server.js 和其他地方调用
    findRoomByUserId,  // 由 authManager.js 和其他地方调用
    handleReconnect,   // 由 authManager.js 调用
    getRoomById
};
