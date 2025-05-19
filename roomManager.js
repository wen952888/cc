// roomManager.js
const { Game } = require('./game'); // 确保 game.js 的路径正确
const crypto = require('crypto');

let activeGames = {}; 
let ioInstance; // 会在 init 中被赋值

// --- Helper Functions ---
function generateRoomId() {
    return crypto.randomBytes(3).toString('hex');
}

function getRoomById(roomId) {
    return activeGames[roomId];
}

function findRoomByUserId(userId) {
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
        ioInstance.emit('roomListUpdate', publicList);
        // console.log("[BROADCAST] Room list updated. Count:", publicList.length);
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
        console.error("[GET ROOM STATE] Error: Attempted to get state for a null/undefined room.");
        return null; 
    }
    // console.log(`[GET ROOM STATE] For user ${requestingUserId || 'N/A'} in room ${room.roomId}. isGameUpdate: ${isGameUpdate}`);
    
    const gameState = (isGameUpdate || room.status === 'playing' || room.status === 'finished') && room.game
        ? room.game.getStateForPlayer(requestingUserId) // getStateForPlayer should handle null requestingUserId if needed for general state
        : null;
    
    const combinedPlayers = room.players.map(roomPlayer => {
        const gamePlayerInfoFromGameState = gameState && gameState.players ? gameState.players.find(gp => gp.id === roomPlayer.userId) : null;
        
        let handForThisPlayer = undefined;
        let handCountForThisPlayer = roomPlayer.handCount || (room.game && room.game.players.find(p=>p.id === roomPlayer.userId) ? room.game.players.find(p=>p.id === roomPlayer.userId).hand.length : 0);

        if (gamePlayerInfoFromGameState) {
            handForThisPlayer = gamePlayerInfoFromGameState.hand; // Game state has priority
            handCountForThisPlayer = gamePlayerInfoFromGameState.handCount;
        } else if (roomPlayer.userId === requestingUserId && room.game && room.game.players.find(p=>p.id === roomPlayer.userId)) {
            // Fallback for specific cases if game state isn't fully formed but hand exists
            const internalPlayer = room.game.players.find(p=>p.id === roomPlayer.userId);
            if (internalPlayer) handForThisPlayer = internalPlayer.hand;
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
            role: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.role : (room.game && room.game.playerRoles ? room.game.playerRoles[roomPlayer.userId] : roomPlayer.role),
            finished: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.finished : roomPlayer.finished,
            isAiControlled: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.isAiControlled : (roomPlayer.isAiControlled || false)
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
    if (!room || !room.game) {
        console.error("[ADD PLAYER] Critical: Room or room.game object is null. RoomId:", room ? room.roomId : "Unknown");
        return { success: false, message: "服务器内部错误：房间或游戏数据丢失。" };
    }
    if (!socket || !socket.userId || !socket.username) {
        console.error("[ADD PLAYER] Critical: Socket, socket.userId, or socket.username is missing.");
        return { success: false, message: "服务器内部错误：玩家会话信息不完整。" };
    }

    const maxPlayers = room.game.maxPlayers || 4;
    if (room.players.some(p => p.userId === socket.userId)) {
        console.warn(`[ADD PLAYER] Player ${socket.username} (ID: ${socket.userId}) already in room ${room.roomId}. Updating info.`);
        const existingPlayer = room.players.find(p => p.userId === socket.userId);
        existingPlayer.socketId = socket.id;
        existingPlayer.connected = true;
        existingPlayer.username = socket.username; // Update username in case it changed (unlikely but good practice)
        // Do not reset score or ready status here, rejoining logic handles that if needed
        return { success: true, player: existingPlayer, rejoining: true }; // Indicate it's an update/rejoin
    }

    if (room.players.length >= maxPlayers) {
        console.warn(`[ADD PLAYER] Room ${room.roomId} is full (${room.players.length}/${maxPlayers}). Cannot add ${socket.username}`);
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
        console.error(`[ADD PLAYER] Critical: No available slot in room ${room.roomId} for ${socket.username}, player count ${room.players.length}/${maxPlayers}. Slots taken: ${existingSlots.join(',')}`);
        return { success: false, message: "无法找到可用位置。" };
    }

    const playerInfo = {
        userId: socket.userId,
        username: socket.username,
        socketId: socket.id,
        isReady: false,
        slot: assignedSlot,
        connected: true,
        score: 0,
        isAiControlled: false 
    };
    room.players.push(playerInfo);
    room.players.sort((a, b) => a.slot - b.slot);

    const gameAddResult = room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot);
    if (!gameAddResult) {
        console.warn(`[ADD PLAYER] Game.addPlayer for ${playerInfo.username} in room ${room.roomId} returned false. This might be okay if player already existed in game instance.`);
        // We should verify if the player is indeed in room.game.players
        if (!room.game.players.some(p => p.id === playerInfo.userId)) {
            console.error(`[ADD PLAYER] CRITICAL: Game.addPlayer failed AND player ${playerInfo.username} not found in game.players array for room ${room.roomId}.`);
            // Potentially remove player from room.players to maintain consistency
            room.players = room.players.filter(p => p.userId !== playerInfo.userId);
            return { success: false, message: "无法将玩家添加到游戏核心。" };
        }
    }
    
    console.log(`[ADD PLAYER] Player ${playerInfo.username} (ID: ${playerInfo.userId}) added to room ${room.roomId}, slot ${assignedSlot}.`);
    return { success: true, player: playerInfo, rejoining: false };
}

function checkAndStartGame(room) {
     if (!room) { console.error("[CHECK START GAME] Critical: Room object is null."); return; }
     if (!ioInstance) { console.warn("[CHECK START GAME] ioInstance not available. Cannot start game or send updates."); return;}

     console.log(`[CHECK START GAME] Evaluating room ${room.roomId}, current status: ${room.status}`);
     if (room.status !== 'waiting') { console.log(`[CHECK START GAME] Room ${room.roomId} not 'waiting' (is ${room.status}). Skipping.`); return; }

     console.log(`[CHECK START GAME] Players in room ${room.roomId}:`);
     room.players.forEach(p => { console.log(`  - P: ${p.username} (ID: ${p.userId}), Conn: ${p.connected}, Ready: ${p.isReady}, Slot: ${p.slot}, AI: ${p.isAiControlled}`); });

     const connectedPlayers = room.players.filter(p => p.connected);
     const readyConnectedPlayers = connectedPlayers.filter(p => p.isReady); // Filter from connected players
     const requiredPlayers = room.game ? (room.game.maxPlayers || 4) : 4;

     console.log(`[CHECK START GAME] Room ${room.roomId}: TotalInRoom=${room.players.length}, Connected=${connectedPlayers.length}, ReadyAndConnected=${readyConnectedPlayers.length}, Required=${requiredPlayers}`);
     
     if (connectedPlayers.length === requiredPlayers && readyConnectedPlayers.length === requiredPlayers) {
         console.log(`[GAME STARTING] Room ${room.roomId}: All ${requiredPlayers} connected players are ready. Attempting start...`);
         room.status = 'playing'; 
         // Ensure players in playerStartInfo are sorted by slot, as game.startGame might expect this order
         const playerStartInfo = connectedPlayers
            .map(p => ({ id: p.userId, name: p.username, slot: p.slot, score: p.score || 0 }))
            .sort((a,b) => a.slot - b.slot);

         if (!room.game) {
             console.error(`[CHECK START GAME] CRITICAL: room.game is null for room ${room.roomId}. Cannot start.`);
             room.status = 'waiting'; 
             ioInstance.to(room.roomId).emit('gameStartFailed', { message: "服务器内部错误：游戏对象丢失。" });
             return;
         }
         const startResult = room.game.startGame(playerStartInfo);
         if (startResult.success) {
             console.log(`[GAME STARTED] Game in room ${room.roomId} started successfully by Game instance.`);
             room.players.forEach(pInRoom => { // Iterate over room.players to get socketId
                 if (pInRoom.connected && pInRoom.socketId) {
                     const pSocket = ioInstance.sockets.sockets.get(pInRoom.socketId);
                     if (pSocket) {
                         pSocket.emit('gameStarted', getRoomStateForPlayer(room, pInRoom.userId, true));
                         console.log(`[GAME STARTED] Sent 'gameStarted' to ${pInRoom.username} (Socket: ${pInRoom.socketId}) in room ${room.roomId}`);
                     } else { console.warn(`[GAME STARTED] Socket for ${pInRoom.username} (SocketID: ${pInRoom.socketId}) not found. Might miss game start.`); }
                 }
             });
             broadcastRoomList(); 
         } else {
             console.error(`[GAME START FAILED] Room ${room.roomId}: Game.startGame failed with message: "${startResult.message}". Reverting room status.`);
             room.status = 'waiting';
             ioInstance.to(room.roomId).emit('gameStartFailed', { message: startResult.message || "游戏启动失败，请检查服务器日志。" });
             room.players.forEach(p => { 
                 if(p.isReady) { 
                     p.isReady = false; 
                     ioInstance.to(room.roomId).emit('playerReadyUpdate', { userId: p.userId, isReady: p.isReady });
                 }
             });
         }
     } else { console.log(`[CHECK START GAME] Room ${room.roomId}: Conditions not met. (Connected: ${connectedPlayers.length}/${requiredPlayers}, Ready: ${readyConnectedPlayers.length}/${requiredPlayers})`); }
}

function handlePlayerLeavingRoom(room, socket) { /* ... (需要你之前的完整逻辑，确保错误处理和日志) ... */ }
function handleDisconnect(socket) { /* ... (需要你之前的完整逻辑，确保错误处理和日志) ... */ }
function handleReconnect(socket, roomId) { /* ... (需要你之前的完整逻辑，确保错误处理和日志) ... */ }
function handleAuthentication(socket) { /* ... (需要你之前的完整逻辑) ... */ }


function init(socket, io) {
    if (!ioInstance && io) {
        ioInstance = io;
        console.log("[ROOM MANAGER] ioInstance initialized via init().");
    } else if (!ioInstance && !io && process.env.NODE_ENV !== 'test') {
        console.error("[ROOM MANAGER] CRITICAL: init called without valid io object, ioInstance remains uninitialized.");
    }
    if(!socket) {
        console.error("[ROOM MANAGER] CRITICAL: init called with null socket.");
        return;
    }
    console.log(`[ROOM MANAGER] Initializing events for socket ${socket.id}, User: ${socket.username || 'N/A (not yet fully authed?)'}`);

    socket.on('createRoom', (data, callback) => {
        console.log(`[EVENT createRoom] Received from ${socket.username || socket.id}. Data:`, data);
        try {
            if (!socket.userId) {
                console.error("[ROOM CREATE] Auth Error for socket:", socket.id);
                return callback({ success: false, message: '请先登录才能创建房间。' });
            }
            // ... (粘贴你之前增强了错误处理和日志的 createRoom 核心逻辑) ...
            // (确保new Game()的调用和后续步骤都在try-catch内)
        } catch (error) { 
            console.error(`[ROOM CREATE] UNHANDLED CRITICAL ERROR for user ${socket.username || socket.id}, room attempt "${data.roomName || 'N/A'}":`, error.message, error.stack);
            if (typeof callback === 'function') {
                callback({ success: false, message: '创建房间时服务器发生严重内部错误。' });
            }
        }
    });

    socket.on('joinRoom', (data, callback) => {
        const { roomId, password } = data;
        const requestingUsername = socket.username || socket.id;

        console.log(`[EVENT joinRoom] Received from ${requestingUsername} for room: ${roomId}. Password provided: ${!!password}`);
        
        try {
            if (!socket.userId) {
                console.warn(`[JOIN ROOM] Auth Error for ${requestingUsername}: User not logged in.`);
                return callback({ success: false, message: '请先登录。' });
            }

            const room = activeGames[roomId];
            if (!room) {
                console.warn(`[JOIN ROOM] Failed for ${requestingUsername}: Room ${roomId} not found.`);
                return callback({ success: false, message: '房间不存在。' });
            }
            if (!room.game) {
                console.error(`[JOIN ROOM] CRITICAL for ${requestingUsername}: Room ${roomId} exists but room.game is null!`);
                return callback({ success: false, message: '房间数据损坏，无法加入。'});
            }
            console.log(`[JOIN ROOM] Room ${roomId} found. Status: ${room.status}, Players: ${room.players.length}/${room.game.maxPlayers || 4}`);

            const existingPlayerInRoomObject = room.players.find(p => p.userId === socket.userId);
            if (existingPlayerInRoomObject) {
                if (!existingPlayerInRoomObject.connected) {
                    console.log(`[JOIN ROOM] Player ${requestingUsername} (ID: ${socket.userId}) is rejoining room ${roomId} (was disconnected).`);
                    const reconnectResult = handleReconnect(socket, roomId); // handleReconnect should ensure player is in game.players
                    if (reconnectResult.success) {
                        console.log(`[JOIN ROOM] Reconnect successful for ${requestingUsername} to room ${roomId}.`);
                        return callback({ success: true, roomId: roomId, roomState: reconnectResult.roomState });
                    } else {
                        console.warn(`[JOIN ROOM] Reconnect failed for ${requestingUsername} to room ${roomId}: ${reconnectResult.message}`);
                        return callback({ success: false, message: reconnectResult.message });
                    }
                } else { // Already connected, possibly new tab or re-attempt
                    console.log(`[JOIN ROOM] Player ${requestingUsername} (ID: ${socket.userId}) already connected in room ${roomId}. Updating socket ID.`);
                    existingPlayerInRoomObject.socketId = socket.id; // Update socket ID
                    socket.join(roomId); 
                    socket.roomId = roomId;
                    const currentState = getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting');
                    return callback({ success: true, roomId: roomId, roomState: currentState, message: "您已在此房间中。" });
                }
            }

            // New player joining
            if (room.status !== 'waiting') {
                console.warn(`[JOIN ROOM] Failed for ${requestingUsername} to join ${roomId}: Room not in 'waiting' state (is ${room.status}).`);
                return callback({ success: false, message: '游戏已开始或已结束，无法加入。' });
            }

            const maxPlayers = room.game.maxPlayers || 4;
            if (room.players.length >= maxPlayers) {
                console.warn(`[JOIN ROOM] Failed for ${requestingUsername} to join ${roomId}: Room is full (${room.players.length}/${maxPlayers}).`);
                return callback({ success: false, message: '房间已满。' });
            }

            if (room.password && room.password !== password) {
                console.warn(`[JOIN ROOM] Failed for ${requestingUsername} to join ${roomId}: Incorrect password.`);
                return callback({ success: false, message: '房间密码错误。' });
            }

            console.log(`[JOIN ROOM] Attempting to add ${requestingUsername} to room ${roomId} via addPlayerToRoom.`);
            const addResult = addPlayerToRoom(room, socket); // This now returns {success, player, rejoining}
            console.log(`[JOIN ROOM] addPlayerToRoom result for ${requestingUsername}:`, JSON.stringify(addResult));

            if (addResult.success) {
                socket.join(roomId);
                socket.roomId = roomId; 
                console.log(`[JOIN ROOM] Player ${requestingUsername} successfully joined Socket.IO room ${roomId}.`);

                const playerJoinedInfo = {
                    userId: addResult.player.userId, username: addResult.player.username,
                    slot: addResult.player.slot, isReady: addResult.player.isReady,
                    connected: true, score: addResult.player.score || 0,
                    handCount: 0, isAiControlled: addResult.player.isAiControlled || false
                };
                
                // Only emit 'playerJoined' if it's not a rejoining player (who might already be known)
                if (!addResult.rejoining) {
                    socket.to(roomId).emit('playerJoined', playerJoinedInfo);
                    console.log(`[JOIN ROOM] Emitted 'playerJoined' to room ${roomId} for new player ${playerJoinedInfo.username}.`);
                } else {
                    // For rejoining, other players might need a general gameStateUpdate if player's status changed significantly
                    // However, handleReconnect should ideally send updates already.
                    // For simplicity here, we might rely on the callback to the joining player to refresh their state.
                    // And other players would see updates if the game state changes (e.g. player becomes active).
                     console.log(`[JOIN ROOM] Player ${playerJoinedInfo.username} re-established connection (was already in room.players).`);
                     // We can send a gameStateUpdate to ensure all UIs are consistent
                     if(ioInstance) {
                        room.players.forEach(p => {
                            if (p.connected && p.socketId) {
                                const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                                if (targetSocket) {
                                    targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                                }
                            }
                        });
                     }
                }
                
                const roomStateForJoiningPlayer = getRoomStateForPlayer(room, socket.userId, false);
                callback({ success: true, roomId: roomId, roomState: roomStateForJoiningPlayer });
                broadcastRoomList();
                console.log(`[JOIN ROOM] Success callback sent to ${requestingUsername} for room ${roomId}. Handler finished.`);
            } else {
                console.error(`[JOIN ROOM] Logic error: addPlayerToRoom failed for ${requestingUsername} in room ${roomId}. Reason: ${addResult.message}`);
                callback({ success: false, message: addResult.message || "加入房间时发生内部错误。" });
            }

        } catch (error) {
            console.error(`[JOIN ROOM] UNHANDLED CRITICAL ERROR for user ${requestingUsername}, room attempt "${roomId || 'N/A'}":`, error.message, error.stack);
            if (typeof callback === 'function') {
                callback({ success: false, message: '加入房间时服务器发生严重内部错误。' });
            }
        }
    });
    
    // ... (其他 socket.on 事件，确保它们有类似的 try-catch 和日志)
    socket.on('playerReady', (isReady, callback) => { /* ... (如上次提供的包含详细日志和try-catch的版本) ... */ });
    socket.on('playCard', (cards, callback) => { /* ... (确保try-catch和日志) ... */ });
    socket.on('passTurn', (callback) => { /* ... (确保try-catch和日志) ... */ });
    socket.on('requestHint', (currentHintCycleIndex, callback) => { /* ... */ });
    socket.on('leaveRoom', (callback) => { /* ... (确保try-catch和日志) ... */ });
    socket.on('requestGameState', (callback) => { /* ... */ });
    socket.on('toggleAI', ({ enabled }, callback) => { /* ... (如上次提供的包含详细日志和try-catch的版本) ... */ });

    console.log(`[ROOM MANAGER] Event listeners fully set up for socket ${socket.id}`);
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
