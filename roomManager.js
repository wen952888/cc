// roomManager.js
const { Game } = require('./game'); // 确保 game.js 在同一目录或正确路径
const crypto = require('crypto');

let activeGames = {}; 
let ioInstance; 

function generateRoomId() {
    return crypto.randomBytes(3).toString('hex');
}

function getRoomById(roomId) {
    return activeGames[roomId];
}

function findRoomByUserId(userId) { // 确保这个函数在这里定义或从别处正确导入
    for (const roomId in activeGames) {
        if (activeGames[roomId].players.some(p => p.userId === userId)) {
            return activeGames[roomId];
        }
    }
    return null;
}

function broadcastRoomList() {
    if (ioInstance) {
        const publicList = getPublicRoomList();
        // console.log("[BROADCAST] Broadcasting room list update:", publicList); // 可以取消注释以调试列表内容
        ioInstance.emit('roomListUpdate', publicList);
    } else {
        console.warn("[BROADCAST] ioInstance not available, cannot broadcast room list.");
    }
}

function getPublicRoomList() {
    return Object.values(activeGames).map(room => ({
        roomId: room.roomId,
        roomName: room.roomName,
        playerCount: room.players.filter(p => p.connected).length,
        maxPlayers: room.game ? (room.game.maxPlayers || 4) : 4,
        status: room.status,
        hasPassword: !!room.password
    }));
}


function getRoomStateForPlayer(room, requestingUserId, isGameUpdate = false) {
    if (!room) {
        console.error("[GET ROOM STATE] Attempted to get state for a null room.");
        return null; 
    }
    // console.log(`[GET ROOM STATE] For user ${requestingUserId} in room ${room.roomId}. isGameUpdate: ${isGameUpdate}`);
    
    const gameState = (isGameUpdate || room.status === 'playing' || room.status === 'finished') && room.game
        ? room.game.getStateForPlayer(requestingUserId)
        : null;
    
    const combinedPlayers = room.players.map(roomPlayer => {
        const gamePlayerInfoFromGameState = gameState ? gameState.players.find(gp => gp.id === roomPlayer.userId) : null;
        let handForThisPlayer;
        let handCountForThisPlayer;

        if (gamePlayerInfoFromGameState) {
            handForThisPlayer = gamePlayerInfoFromGameState.hand; 
            handCountForThisPlayer = gamePlayerInfoFromGameState.handCount;
        } else if (room.game && room.game.players.find(p=>p.id === roomPlayer.userId)) { 
            const gamePlayer = room.game.players.find(p=>p.id === roomPlayer.userId);
            handCountForThisPlayer = gamePlayer ? gamePlayer.hand.length : 0;
            handForThisPlayer = (roomPlayer.userId === requestingUserId && room.status === 'waiting') ? (gamePlayer.hand || []) : undefined;
        } else { 
            handCountForThisPlayer = 0;
            handForThisPlayer = undefined;
        }

        return {
            userId: roomPlayer.userId,
            username: roomPlayer.username,
            slot: roomPlayer.slot,
            isReady: roomPlayer.isReady, 
            connected: roomPlayer.connected,
            score: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.score : (roomPlayer.score || 0),
            hand: handForThisPlayer,
            handCount: handCountForThisPlayer,
            isCurrentPlayer: gameState ? gameState.currentPlayerId === roomPlayer.userId : false,
            role: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.role : (room.game && room.game.playerRoles ? room.game.playerRoles[roomPlayer.userId] : null),
            finished: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.finished : false,
            isAiControlled: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.isAiControlled : (roomPlayer.isAiControlled || false) // 同步AI状态
        };
    });

    return {
        roomId: room.roomId,
        roomName: room.roomName,
        status: room.status, 
        players: combinedPlayers,
        centerPile: gameState?.centerPile ?? [],
        lastHandInfo: gameState?.lastHandInfo ?? null,
        currentPlayerId: gameState?.currentPlayerId ?? null,
        isFirstTurn: gameState?.isFirstTurn ?? (room.status === 'playing' ? true : false), 
        myUserId: requestingUserId, 
        gameMode: room.game ? room.game.gameMode : null,
        gameResultText: gameState?.gameResultText,
        gameOverReason: gameState?.gameOverReason,
        finalScores: gameState?.finalScores,
        scoreChanges: gameState?.scoreChanges
    };
}


function addPlayerToRoom(room, socket) {
    if (!room) {
        console.error("[ADD PLAYER] Critical: Room object is null.");
        return { success: false, message: "服务器内部错误：房间对象丢失。" };
    }
    if (!socket || !socket.userId || !socket.username) {
        console.error("[ADD PLAYER] Critical: Socket, socket.userId, or socket.username is missing.");
        return { success: false, message: "服务器内部错误：玩家信息不完整。" };
    }

    const maxPlayers = room.game ? (room.game.maxPlayers || 4) : 4;
    if (room.players.length >= maxPlayers) {
        console.warn(`[ADD PLAYER] Room ${room.roomId} is full. Cannot add ${socket.username}`);
        return { success: false, message: "房间已满。" };
    }

    const existingSlots = room.players.map(p => p.slot);
    let assignedSlot = -1;
    for (let i = 0; i < maxPlayers; i++) {
        if (!existingSlots.includes(i)) {
            assignedSlot = i;
            break;
        }
    }
    if (assignedSlot === -1) {
        console.error(`[ADD PLAYER] Critical: No available slot in room ${room.roomId} for ${socket.username}, player count ${room.players.length}/${maxPlayers}.`);
        return { success: false, message: "无法找到可用位置。" };
    }

    const playerInfo = {
        userId: socket.userId,
        username: socket.username,
        socketId: socket.id,
        isReady: false,
        slot: assignedSlot,
        connected: true,
        score: 0, // 新玩家默认0分
        isAiControlled: false // 新玩家默认非AI控制
    };
    room.players.push(playerInfo);
    room.players.sort((a, b) => a.slot - b.slot);

    if (room.game) {
        // Game.addPlayer 应该能处理玩家已存在的情况（例如更新信息）
        const gameAddResult = room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot);
        if (!gameAddResult && !room.game.players.some(p => p.id === playerInfo.userId)) { // 如果添加失败且玩家不在游戏中
            console.warn(`[ADD PLAYER] Game.addPlayer for ${playerInfo.username} returned false, but player might already exist if rejoining logic.`)
        }
    } else {
        console.error(`[ADD PLAYER] Critical: room.game is null for room ${room.roomId}. Cannot add player to game instance.`);
    }
    console.log(`[ADD PLAYER] Player ${playerInfo.username} (ID: ${playerInfo.userId}) added to room ${room.roomId}, slot ${assignedSlot}`);
    return { success: true, player: playerInfo };
}


function checkAndStartGame(room) {
    // ... (这个函数的完整定义，包含详细日志，如上次提供) ...
    // (确保所有 ioInstance 调用前都有检查 if (ioInstance) )
     if (!room) { console.error("[CHECK START GAME] Critical: Room object is null."); return; }
     console.log(`[CHECK START GAME] Evaluating room ${room.roomId}, status: ${room.status}`);
     if (room.status !== 'waiting') { console.log(`[CHECK START GAME] Room ${room.roomId} not 'waiting'. Skipping.`); return; }

     console.log(`[CHECK START GAME] Players in room ${room.roomId}:`);
     room.players.forEach(p => { console.log(`  - P: ${p.username}, Conn: ${p.connected}, Ready: ${p.isReady}, Slot: ${p.slot}`); });

     const connectedPlayers = room.players.filter(p => p.connected);
     const readyConnectedPlayers = connectedPlayers.filter(p => p.isReady);
     const requiredPlayers = room.game ? (room.game.maxPlayers || 4) : 4;

     console.log(`[CHECK START GAME] Room ${room.roomId}: TotalInRoom=${room.players.length}, Connected=${connectedPlayers.length}, ReadyAndConnected=${readyConnectedPlayers.length}, Required=${requiredPlayers}`);
     
     if (connectedPlayers.length === requiredPlayers && readyConnectedPlayers.length === requiredPlayers) {
         console.log(`[GAME STARTING] Room ${room.roomId}: All ${requiredPlayers} connected players are ready. Attempting start...`);
         room.status = 'playing'; 
         const playerStartInfo = connectedPlayers.map(p => ({ id: p.userId, name: p.username, slot: p.slot, score: p.score || 0 })).sort((a,b) => a.slot - b.slot);

         if (!room.game) {
             console.error(`[CHECK START GAME] CRITICAL: room.game is null for room ${room.roomId}. Cannot start.`);
             room.status = 'waiting'; 
             if (ioInstance) ioInstance.to(room.roomId).emit('gameStartFailed', { message: "服务器内部错误：游戏对象丢失。" });
             return;
         }
         const startResult = room.game.startGame(playerStartInfo);
         if (startResult.success) {
             console.log(`[GAME STARTED] Game in room ${room.roomId} started by Game instance.`);
             if (!ioInstance) { console.error("[GAME STARTED] CRITICAL: ioInstance not available."); return; }
             room.players.forEach(pInRoom => {
                 if (pInRoom.connected && pInRoom.socketId) {
                     const pSocket = ioInstance.sockets.sockets.get(pInRoom.socketId);
                     if (pSocket) {
                         pSocket.emit('gameStarted', getRoomStateForPlayer(room, pInRoom.userId, true));
                         console.log(`[GAME STARTED] Sent 'gameStarted' to ${pInRoom.username} in room ${room.roomId}`);
                     } else { console.warn(`[GAME STARTED] Socket for ${pInRoom.username} not found.`); }
                 }
             });
             broadcastRoomList(); 
         } else {
             console.error(`[GAME START FAILED] Room ${room.roomId}: Game.startGame failed: "${startResult.message}". Reverting status.`);
             room.status = 'waiting';
             if (ioInstance) {
                ioInstance.to(room.roomId).emit('gameStartFailed', { message: startResult.message || "游戏启动失败。" });
                room.players.forEach(p => { 
                    if(p.isReady) { 
                        p.isReady = false; 
                        ioInstance.to(room.roomId).emit('playerReadyUpdate', { userId: p.userId, isReady: p.isReady });
                    }
                });
             }
         }
     } else { console.log(`[CHECK START GAME] Room ${room.roomId}: Conditions not met.`); }
}


function handlePlayerLeavingRoom(room, socket) { /* ... (你的完整函数，确保所有 ioInstance 调用前都有检查) ... */ }
function handleDisconnect(socket) { /* ... (你的完整函数，确保所有 ioInstance 调用前都有检查，并调用 checkAndStartGame 如果在等待状态) ... */ }
function handleReconnect(socket, roomId) { /* ... (你的完整函数，确保所有 ioInstance 调用前都有检查，并在等待状态时调用 checkAndStartGame) ... */ }
function handleAuthentication(socket) { /* ... (你的完整函数) ... */ }


// --- init 函数是核心 ---
function init(socket, io) {
    if (!ioInstance && io) {
        ioInstance = io;
        console.log("[ROOM MANAGER] ioInstance initialized via init().");
    } else if (!ioInstance && !io) {
        console.error("[ROOM MANAGER] CRITICAL: init called without valid io object, ioInstance remains uninitialized.");
        // 如果ioInstance无法初始化，后续很多操作会失败
    }
    if(!socket) {
        console.error("[ROOM MANAGER] CRITICAL: init called with null socket.");
        return;
    }

    console.log(`[ROOM MANAGER] Initializing events for socket ${socket.id}, User: ${socket.username || 'N/A'}`);

    socket.on('createRoom', (data, callback) => {
        console.log(`[EVENT createRoom] Received from ${socket.username || socket.id}. Data:`, data);
        try {
            if (!socket.userId) {
                console.error("[ROOM CREATE] Auth Error: User not logged in for socket.", socket.id);
                return callback({ success: false, message: '请先登录才能创建房间。' });
            }
            const { roomName, password } = data;
            console.log(`[ROOM CREATE ATTEMPT START] User: ${socket.username} (ID: ${socket.userId}), RoomName: "${roomName}"`);

            if (!roomName || typeof roomName !== 'string' || roomName.trim().length === 0) {
                console.warn("[ROOM CREATE] Validation Error: Invalid room name from user:", socket.username, "Name:", roomName);
                return callback({ success: false, message: '需要有效的房间名称。' });
            }
            if (password && (typeof password !== 'string' || password.length > 20)) {
                console.warn("[ROOM CREATE] Validation Error: Invalid password format for room:", roomName, "User:", socket.username);
                return callback({ success: false, message: '密码格式无效 (最多20字符)。' });
            }

            let roomId = generateRoomId();
            let attempts = 0;
            const MAX_ID_GEN_ATTEMPTS = 20;
            while(activeGames[roomId] && attempts < MAX_ID_GEN_ATTEMPTS) {
                roomId = generateRoomId();
                attempts++;
            }
            if (activeGames[roomId]) {
                 console.error("[ROOM CREATE] ID Gen Error: Failed to generate unique Room ID after", MAX_ID_GEN_ATTEMPTS, "attempts.");
                 return callback({success: false, message: "创建房间失败，服务器繁忙，请稍后再试。"});
            }
            console.log(`[ROOM CREATE] Generated Room ID: ${roomId} for room "${roomName}"`);

            let gameInstance;
            try {
                gameInstance = new Game(roomId, 4); // Assuming maxPlayers is 4
                console.log(`[ROOM CREATE] New Game instance successfully created for room ${roomId}`);
            } catch (gameError) {
                console.error(`[ROOM CREATE] CRITICAL: Error creating Game instance for room ${roomId}:`, gameError.message, gameError.stack);
                return callback({ success: false, message: '创建游戏核心失败，请联系管理员。' });
            }
            
            const newRoom = {
                roomId: roomId,
                roomName: roomName.trim(),
                password: (password && password.trim().length > 0) ? password.trim() : null,
                creatorId: socket.userId,
                players: [],
                game: gameInstance,
                status: 'waiting'
            };
            activeGames[roomId] = newRoom;
            console.log(`[ROOM CREATED] Room object stored. Room: "${newRoom.roomName}" (ID: ${roomId}), Creator: ${socket.username}`);

            const joinResult = addPlayerToRoom(newRoom, socket);
            console.log(`[ROOM CREATE] addPlayerToRoom result for creator ${socket.username}: ${JSON.stringify(joinResult)}`);

            if (joinResult.success) {
                socket.join(roomId);
                socket.roomId = roomId; // 非常重要，后续事件依赖这个
                console.log(`[ROOM CREATE] Creator ${socket.username} joined Socket.IO room ${roomId}.`);

                const initialStateForCreator = getRoomStateForPlayer(newRoom, socket.userId, false);
                if (!initialStateForCreator) {
                     console.error(`[ROOM CREATE] CRITICAL: getRoomStateForPlayer returned null for creator in new room ${roomId}.`);
                     // 即使这样，房间也创建了，但客户端可能收不到正确状态
                     callback({ success: true, roomId: roomId, roomState: null, message: "房间创建但状态获取失败" }); // 部分成功
                } else {
                    try {
                        // console.log(`[ROOM CREATE] Initial state for creator (full):`, JSON.stringify(initialStateForCreator)); // 谨慎使用，可能很大
                        console.log(`[ROOM CREATE] Initial state for creator (partial): roomId=${initialStateForCreator.roomId}, status=${initialStateForCreator.status}, numPlayers=${initialStateForCreator.players.length}`);
                    } catch (serializeError) {
                        console.error("[ROOM CREATE] Error serializing initialStateForCreator for logging:", serializeError.message);
                    }
                    callback({ success: true, roomId: roomId, roomState: initialStateForCreator });
                }
                broadcastRoomList();
                console.log(`[ROOM CREATE] Success callback sent for room ${roomId}. Handler finished.`);
            } else {
                console.error(`[ROOM CREATE] Abort: Failed to add creator ${socket.username} to their own room ${roomId}. Deleting room. Reason: ${joinResult.message}`);
                delete activeGames[roomId]; // 清理创建失败的房间
                callback({ success: false, message: `创建房间后加入失败: ${joinResult.message}` });
            }
        } catch (error) { 
            console.error(`[ROOM CREATE] UNHANDLED CRITICAL ERROR in 'createRoom' handler for user ${socket.username || socket.id}, room attempt "${data.roomName || 'N/A'}":`, error.message, error.stack);
            if (typeof callback === 'function') {
                callback({ success: false, message: '创建房间时服务器发生严重内部错误。' });
            }
            // 这里可以考虑是否需要更激烈的错误处理，比如关闭这个socket连接
        }
    });

    // ... (其他 socket.on 事件监听器，如 joinRoom, playerReady 等，确保它们内部也有足够的日志和错误捕获)
    // ... 例如 socket.on('joinRoom', ...) 和 socket.on('playerReady', ...) 应该使用上面 createRoom 类似的 try-catch 和日志级别
    // ... 其他事件处理器：playCard, passTurn, requestHint, leaveRoom, requestGameState, toggleAI, audioChunk, playerStartSpeaking, playerStopSpeaking
    // ... (省略这些事件处理器的完整代码，但假设它们都被正确定义和包含在 init 函数内)

    // 示例: playerReady 的错误捕获和日志增强
    socket.on('playerReady', (isReady, callback) => {
        console.log(`[EVENT playerReady] Received from ${socket.username || socket.id}. isReady: ${isReady}`);
        try {
            if (!socket.userId || !socket.roomId) {
                console.warn("[PLAYER READY] Auth/Room Error: No userId or roomId. Socket:", socket.id);
                return callback({ success: false, message: '无效操作（未登录或不在房间）。' });
            }
            const room = activeGames[socket.roomId];
            if (!room) {
                console.warn("[PLAYER READY] Room Error: Room not found:", socket.roomId, "User:", socket.username);
                return callback({success: false, message: "房间信息丢失。"});
            }
            if (room.status !== 'waiting') {
                console.warn(`[PLAYER READY] State Error: Room ${socket.roomId} status is ${room.status}, not 'waiting'. User: ${socket.username}`);
                return callback({ success: false, message: '不在等待中的房间内或游戏已开始。' });
            }
            const player = room.players.find(p => p.userId === socket.userId);
            if (!player) {
                console.error("[PLAYER READY] Data Error: Player data not found in room:", socket.roomId, "User ID:", socket.userId);
                return callback({ success: false, message: '玩家数据异常。' });
            }

            player.isReady = !!isReady;
            console.log(`[ROOM ${socket.roomId}] Player ${player.username} (ID: ${player.userId}) readiness updated to: ${player.isReady}. Connected: ${player.connected}`);

            if (ioInstance && socket.roomId) {
                ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: player.userId, isReady: player.isReady });
            } else {
                console.error("[PLAYER READY] Emission Error: ioInstance or socket.roomId is invalid for 'playerReadyUpdate'.");
            }
            
            checkAndStartGame(room);
            
            if(typeof callback === 'function') callback({ success: true });
            console.log(`[EVENT playerReady] Handler finished for ${socket.username || socket.id}.`);

        } catch (error) {
            console.error(`[PLAYER READY] UNHANDLED CRITICAL ERROR for user ${socket.username || socket.id}:`, error.message, error.stack);
            if (typeof callback === 'function') {
                callback({ success: false, message: '处理准备状态时服务器发生严重内部错误。' });
            }
        }
    });

    // ... 其他 socket.on 事件的定义 ...
    // 例如：
    socket.on('playCard', (cards, callback) => { /* ... 包含try-catch和日志 ... */ });
    socket.on('passTurn', (callback) => { /* ... 包含try-catch和日志 ... */ });
    socket.on('requestHint', (currentHintCycleIndex, callback) => { /* ... */ });
    socket.on('leaveRoom', (callback) => { /* ... 包含try-catch和日志 ... */ });
    socket.on('requestGameState', (callback) => { /* ... */ });
    socket.on('toggleAI', ({ enabled }, callback) => { /* ... 包含try-catch和日志 ... */ });
    // audioChunk, playerStartSpeaking, playerStopSpeaking 不需要回调，但其内部逻辑也应健壮


    console.log(`[ROOM MANAGER] Event listeners set up for socket ${socket.id}`);
}


module.exports = {
    init,
    handleDisconnect,
    handleAuthentication,
    getPublicRoomList,
    findRoomByUserId,
    handleReconnect,
    getRoomById
};
