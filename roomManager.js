// roomManager.js
const { Game } = require('./game');
const crypto = require('crypto');

let activeGames = {}; // { roomId: { roomId, roomName, password, game: GameInstance, players: [], status, hostId, lastActivityTime } }
let ioInstance; // Will be set by init

const ROOM_TTL_SECONDS = 30 * 60; // 30 minutes: Room inactive time before pruning
const PLAYER_RECONNECT_WINDOW_SECONDS = 2 * 60; // 2 minutes: Time a player slot is held after disconnect

function generateRoomId() { return crypto.randomBytes(3).toString('hex'); }
function getRoomById(roomId) { return activeGames[roomId]; }

function findRoomByUserId(userId) {
    for (const roomId in activeGames) {
        if (activeGames[roomId] && activeGames[roomId].status !== 'archived' &&
            activeGames[roomId].players.some(p => p.userId === userId)) {
            return activeGames[roomId];
        }
    }
    return null;
}

function broadcastRoomList() {
    if (ioInstance) {
        const publicList = getPublicRoomList();
        ioInstance.emit('roomListUpdate', publicList);
        // console.log("[BROADCAST RM] Room list updated. Count:", publicList.length);
    } else {
        console.warn("[BROADCAST RM] ioInstance not available for room list broadcast.");
    }
}

function getPublicRoomList() {
    return Object.values(activeGames)
        .filter(room => room && room.status !== 'archived') // Do not show archived rooms
        .map(room => ({
            roomId: room.roomId,
            roomName: room.roomName,
            playerCount: room.players.filter(p => p.connected).length, // Count only connected players for public list
            maxPlayers: room.game ? (room.game.maxPlayers || 4) : 4,
            status: room.status,
            hasPassword: !!room.password
        }));
}

function getRoomStateForPlayer(room, requestingUserId, isGameRelatedUpdate = false) {
    if (!room) return null;
    const gameExistsAndActive = !!room.game && (room.status === 'playing' || room.status === 'finished' || isGameRelatedUpdate);
    
    // Get base game state if game is active or it's a game-related update
    const baseGameState = gameExistsAndActive ? room.game.getStateForPlayer(requestingUserId) : null;

    const combinedPlayers = room.players.map(roomPlayer => {
        const gamePlayerFromBase = baseGameState && baseGameState.players ? baseGameState.players.find(gp => gp.id === roomPlayer.userId) : null;
        // Fallback to direct game instance player if baseGameState isn't fully populated (e.g. game just ended)
        const gameInstancePlayer = room.game ? room.game.players.find(gip => gip.id === roomPlayer.userId) : null;

        return {
            userId: roomPlayer.userId,
            username: roomPlayer.username,
            slot: roomPlayer.slot,
            isReady: roomPlayer.isReady, // Authoritative from room.players
            connected: roomPlayer.connected, // Authoritative from room.players
            isAiControlled: roomPlayer.isAiControlled, // Authoritative from room.players

            // Game-specific attributes, prefer baseGameState if available, then gameInstancePlayer
            score: gamePlayerFromBase ? gamePlayerFromBase.score : (gameInstancePlayer ? gameInstancePlayer.score : roomPlayer.score || 0),
            hand: (requestingUserId === roomPlayer.userId && gamePlayerFromBase) ? gamePlayerFromBase.hand : undefined,
            handCount: gamePlayerFromBase ? gamePlayerFromBase.handCount : (gameInstancePlayer ? gameInstancePlayer.hand.length : 0),
            role: gamePlayerFromBase ? gamePlayerFromBase.role : (gameInstancePlayer ? gameInstancePlayer.role : null),
            finished: gamePlayerFromBase ? gamePlayerFromBase.finished : (gameInstancePlayer ? gameInstancePlayer.finished : false),
        };
    });

    return {
        roomId: room.roomId,
        roomName: room.roomName,
        status: room.status,
        players: combinedPlayers,
        myUserId: requestingUserId,
        hostId: room.hostId,

        // Game state specific information (from baseGameState primarily)
        centerPile: baseGameState?.centerPile ?? [],
        lastHandInfo: baseGameState?.lastHandInfo ?? null,
        currentPlayerId: baseGameState?.currentPlayerId ?? null,
        isFirstTurn: baseGameState?.isFirstTurn ?? (room.status === 'playing' && room.game ? room.game.firstTurn : false),
        gameMode: room.game ? room.game.gameMode : null,

        gameStarted: baseGameState?.gameStarted ?? (room.status === 'playing'),
        gameFinished: baseGameState?.gameFinished ?? (room.status === 'finished'),
        gameResultText: baseGameState?.gameResultText ?? (room.game ? room.game.gameResultText : null),
        finalScores: baseGameState?.finalScores,
        scoreChanges: baseGameState?.scoreChanges,
    };
}

function addPlayerToRoom(room, socket) {
    if (!room || !room.game || !socket || !socket.userId || !socket.username) {
        console.error("[ADD PLAYER RM] Invalid params for addPlayerToRoom.", { room:!!room, game:!!room?.game, sock:!!socket, uid:socket?.userId, uname:socket?.username });
        return { success: false, message: "服务器内部错误：数据不完整。" };
    }
    const maxPlayers = room.game.maxPlayers || 4;
    const existingPlayerInRoom = room.players.find(p => p.userId === socket.userId);

    if (existingPlayerInRoom) { // Player is rejoining or already in (e.g. duplicate tab)
        console.log(`[ADD PLAYER RM] Player ${socket.username} (ID: ${socket.userId}) already in room.players for ${room.roomId}. Updating status.`);
        existingPlayerInRoom.socketId = socket.id;
        existingPlayerInRoom.connected = true;
        existingPlayerInRoom.username = socket.username;
        room.game.markPlayerConnected(socket.userId, true, existingPlayerInRoom.isAiControlled); // Update game instance
        const gamePlayer = room.game.players.find(gp => gp.id === socket.userId);
        if (gamePlayer) gamePlayer.name = socket.username; // Sync name in game too
        return { success: true, player: existingPlayerInRoom, rejoining: true };
    }

    if (room.players.filter(p => p.connected).length >= maxPlayers) {
        return { success: false, message: "房间已满。" };
    }

    const existingSlots = room.players.map(p => p.slot);
    let assignedSlot = -1;
    for (let i = 0; i < maxPlayers; i++) { if (!existingSlots.includes(i)) { assignedSlot = i; break; } }
    if (assignedSlot === -1) { return { success: false, message: "无法找到可用位置。" }; }

    const playerInfo = {
        userId: socket.userId, username: socket.username, socketId: socket.id,
        isReady: false, slot: assignedSlot, connected: true, score: 0, // Score is managed by game instance primarily per game, roomPlayer stores overall
        isAiControlled: false, // Default to not AI controlled
        // handCount, role, finished will be synced from game state
    };
    room.players.push(playerInfo);
    room.players.sort((a, b) => a.slot - b.slot);

    // Add to game instance if not already present (usually for waiting room state)
    if (!room.game.players.some(p => p.id === playerInfo.userId)) {
        if (!room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot)) {
            console.warn(`[ADD PLAYER RM] game.addPlayer failed for ${playerInfo.username} in ${room.roomId}, though added to room.players.`);
            // This could be an issue, potentially rollback adding to room.players or log error critically
        }
    } else { // Player was in game instance (e.g. from previous session before disconnect), update game instance
        room.game.markPlayerConnected(playerInfo.userId, true, playerInfo.isAiControlled);
        const gamePlayerToUpdate = room.game.players.find(gp => gp.id === playerInfo.userId);
        if (gamePlayerToUpdate) gamePlayerToUpdate.name = playerInfo.username;
    }
    
    room.lastActivityTime = Date.now();
    console.log(`[ADD PLAYER RM] Player ${playerInfo.username} added to room ${room.roomId}, slot ${assignedSlot}. Total in room.players: ${room.players.length}`);
    return { success: true, player: playerInfo, rejoining: false };
}

function checkAndStartGame(room, ioForEmit) {
    if (!room || !room.game || room.status !== 'waiting') return false;

    // Consider players who are connected OR AI controlled as eligible for game start
    const eligiblePlayers = room.players.filter(p => p.connected || p.isAiControlled);
    if (eligiblePlayers.length !== room.game.maxPlayers) {
      // console.log(`[RM Check&Start] Not enough eligible players for room ${room.roomId}. Have ${eligiblePlayers.length}, need ${room.game.maxPlayers}`);
      return false;
    }

    // All eligible players must be ready (AI is considered always ready)
    const allReady = eligiblePlayers.every(p => p.isReady || p.isAiControlled);
    if (!allReady) {
      // console.log(`[RM Check&Start] Not all eligible players ready in room ${room.roomId}.`);
      return false;
    }

    console.log(`[RM Check&Start] All ${room.game.maxPlayers} players ready in room ${room.roomId}. Starting game...`);

    const playerStartInfo = eligiblePlayers.map(p => ({
        id: p.userId, name: p.username, slot: p.slot,
        score: p.score || 0, // Use score from room.players
        isAiControlled: p.isAiControlled
    })).sort((a, b) => a.slot - b.slot);

    const startGameResult = room.game.startGame(playerStartInfo);
    if (startGameResult.success) {
        room.status = 'playing';
        room.lastActivityTime = Date.now();
        // Reset isReady for all players in room.players for the next game (after this one finishes)
        room.players.forEach(p => p.isReady = false);

        const initialStateForAll = getRoomStateForPlayer(room, null, true); // Null means broadcast state (no specific hand)
        ioForEmit.to(room.roomId).emit('gameStarted', initialStateForAll); // Signal game start specific event

        // Send individual state to each player so they get their hand
        room.players.forEach(p => {
            if (p.socketId) {
                const playerSocket = ioForEmit.sockets.sockets.get(p.socketId);
                if (playerSocket) {
                    playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            }
        });
        
        broadcastRoomList(); // Update lobby about room status change
        console.log(`[RM Check&Start] Game started successfully in room ${room.roomId}.`);
        return true;
    } else {
        console.error(`[RM Check&Start] Failed to start game in room ${room.roomId}: ${startGameResult.message}`);
        ioForEmit.to(room.roomId).emit('gameStartFailed', { message: startGameResult.message });
        // room.players.forEach(p => p.isReady = false); // Reset ready status on failure
        // ioForEmit.to(room.roomId).emit('allPlayersResetReady'); // Custom event if client needs it
        return false;
    }
}

function handlePlayerLeavingRoom(room, socket, reason = "left_generic") {
    if (!room || !socket || !socket.userId) {
        console.warn(`[LEAVE ROOM RM] Invalid params. Room:${!!room}, Sock:${!!socket}, UID:${socket?.userId}`);
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    console.log(`[LEAVE ROOM RM] ${username} (Socket:${socket.id}) leaving room ${room.roomId}. Reason: ${reason}`);

    const playerInRoom = room.players.find(p => p.userId === socket.userId);
    if (!playerInRoom) {
        console.warn(`[LEAVE ROOM RM] ${username} not in room.players for ${room.roomId}.`);
        socket.leave(room.roomId); // Ensure socket leaves Socket.IO room
        return;
    }

    playerInRoom.connected = false; // Mark as disconnected
    playerInRoom.isReady = false;   // Reset ready status

    if (room.game) { // Update game instance
        room.game.markPlayerConnected(socket.userId, false, playerInRoom.isAiControlled);
    }

    socket.leave(room.roomId);
    if (socket.roomId === room.roomId) socket.roomId = null;

    if (ioInstance) {
        ioInstance.to(room.roomId).emit('playerLeft', { userId: socket.userId, username: username });
        // Send updated state to remaining players
        room.players.forEach(p => {
            if (p.connected && p.socketId && p.userId !== socket.userId) {
                const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (targetSocket) {
                    targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                }
            }
        });
    }
    room.lastActivityTime = Date.now();
    broadcastRoomList(); // Player count changes

    // Actual room pruning is handled by pruneInactiveRooms interval
}

function handleDisconnect(socket) {
    if (!socket || !socket.userId) {
        // console.log(`[DISCONNECT RM] Socket ${socket ? socket.id : 'N/A'} disconnected (no userId).`);
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    // console.log(`[DISCONNECT RM] Handling disconnect for ${username} (Socket: ${socket.id})`);

    const room = findRoomByUserId(socket.userId);
    if (room) {
        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (playerInRoom) {
            if (playerInRoom.socketId === socket.id || !playerInRoom.socketId) { // Check if this is the current authoritative socket
                playerInRoom.connected = false;
                // playerInRoom.socketId = null; // Let new connection overwrite it
                console.log(`[DISCONNECT RM] Marked ${username} as disconnected in room ${room.roomId}.`);

                if (room.game) {
                    room.game.markPlayerConnected(socket.userId, false, playerInRoom.isAiControlled);
                }
                
                if (room.status === 'waiting' && playerInRoom.isReady) {
                    playerInRoom.isReady = false;
                    if (ioInstance) ioInstance.to(room.roomId).emit('playerReadyUpdate', { userId: playerInRoom.userId, isReady: false });
                }

                if (ioInstance) {
                    room.players.forEach(p => { // Notify remaining players
                        if (p.connected && p.socketId && p.userId !== socket.userId) {
                            const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                            if (targetSocket) targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                        }
                    });
                }
                room.lastActivityTime = Date.now();
                broadcastRoomList();
            } else {
                console.log(`[DISCONNECT RM] Socket ${socket.id} for ${username} disconnected, but player has newer socketId (${playerInRoom.socketId}) in room ${room.roomId}. No status change from this event.`);
            }
        }
    }
}

function handleReconnect(socket, roomId) {
    const username = socket.username || `User ${socket.userId ? socket.userId.substring(0,6) : 'Anon'}`;
    console.log(`[RECONNECT RM] Attempting reconnect for ${username} (Socket: ${socket.id}) to room ${roomId}.`);
    try {
        const room = activeGames[roomId];
        if (!room) return { success: false, message: "房间不存在。" };
        if (room.status === 'archived') return { success: false, message: "房间已关闭。" };
        if (!room.game) {
            console.error(`[RECONNECT RM CRITICAL] Room ${roomId} exists but no game instance!`);
            return { success: false, message: "房间数据损坏。" };
        }

        const playerInRoomData = room.players.find(p => p.userId === socket.userId);
        if (!playerInRoomData) return { success: false, message: "您不在此房间中。" };

        playerInRoomData.connected = true;
        playerInRoomData.socketId = socket.id; // Update to new socket
        playerInRoomData.username = socket.username; // Sync username

        room.game.markPlayerConnected(socket.userId, true, playerInRoomData.isAiControlled);
        const gamePlayer = room.game.players.find(p=>p.id === socket.userId);
        if(gamePlayer) gamePlayer.name = socket.username; // Sync name in game

        socket.join(roomId);
        socket.roomId = roomId;
        room.lastActivityTime = Date.now();
        console.log(`[RECONNECT RM] ${username} reconnected to ${roomId}. Broadcasting update.`);

        if (ioInstance) { // Send full state to everyone to sync
            room.players.forEach(p => {
                if (p.socketId) {
                    const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (targetSocket) {
                        targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                    }
                }
            });
        }
        broadcastRoomList();
        return { success: true, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting') };
    } catch (error) {
        console.error(`[RECONNECT RM] Error for ${username} to room ${roomId}:`, error);
        return { success: false, message: `服务器内部错误: ${error.message}` };
    }
}

function handleAuthentication(socket) { // Called by authManager
    console.log(`[RM Auth CB] Socket ${socket.id} (User: ${socket.username}, ID: ${socket.userId}) confirmed authenticated.`);
    // Further logic if needed upon any socket authentication.
}

function pruneInactiveRooms() {
    const now = Date.now();
    let prunedCount = 0;
    for (const roomId in activeGames) {
        const room = activeGames[roomId];
        if (!room || room.status === 'archived') continue;

        const connectedPlayersCount = room.players.filter(p => p.connected).length;
        const timeSinceLastActivity = (now - (room.lastActivityTime || now)) / 1000;

        if ((connectedPlayersCount === 0 && timeSinceLastActivity > PLAYER_RECONNECT_WINDOW_SECONDS) ||
            (timeSinceLastActivity > ROOM_TTL_SECONDS)) {
            
            console.log(`[PRUNE RM] Pruning room ${roomId} (${room.roomName}). Conn:${connectedPlayersCount}, Inactive:${timeSinceLastActivity.toFixed(0)}s.`);
            if (room.game && room.game.gameStarted && !room.game.gameFinished) {
                const scoreResult = room.game.endGame(`房间因不活跃被清理`);
                if (ioInstance) {
                    ioInstance.to(room.roomId).emit('gameOver', {
                        reason: scoreResult.result || "游戏因房间清理而结束",
                        scoreResult: scoreResult
                    });
                }
                // Sync scores back to room.players from game instance
                room.players.forEach(rp => {
                    const gp = room.game.players.find(g => g.id === rp.userId);
                    if (gp) rp.score = gp.score;
                });
            }
            room.status = 'archived';
            
            // Force remove any lingering sockets from the Socket.IO room
            if(ioInstance) {
                const socketsInIoRoom = ioInstance.sockets.adapter.rooms.get(roomId);
                if (socketsInIoRoom) {
                    socketsInIoRoom.forEach(socketIdInRoom => {
                        const lingeringSocket = ioInstance.sockets.sockets.get(socketIdInRoom);
                        if(lingeringSocket) lingeringSocket.leave(roomId);
                    });
                }
            }
            prunedCount++;
        }
    }
    if (prunedCount > 0) {
        console.log(`[PRUNE RM] Pruned ${prunedCount} room(s).`);
        broadcastRoomList();
    }
}
setInterval(pruneInactiveRooms, 1 * 60 * 1000); // Check every minute

// Main init for a new socket connection
function init(socket, ioMainInstance) {
    if (!ioInstance && ioMainInstance) ioInstance = ioMainInstance;
    if (!socket) { console.error("[RM INIT] Null socket."); return; }

    socket.on('createRoom', (data, callback) => {
        if (typeof callback !== 'function') { console.error("[RM createRoom] No CB."); return; }
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
        console.log(`[EVENT createRoom] By ${socket.username} (ID:${socket.userId}). Data:`, data);
        try {
            const { roomName, password } = data;
            if (findRoomByUserId(socket.userId)) return callback({ success: false, message: '您已在其他房间。' });
            if (!roomName || roomName.trim().length === 0 || roomName.trim().length > 10) return callback({ success: false, message: '房间名无效 (1-10字符)。' });
            
            let newRoomId = generateRoomId();
            while (activeGames[newRoomId]) newRoomId = generateRoomId();
            
            const game = new Game(newRoomId, 4); // Default 4 players
            const newRoom = {
                roomId: newRoomId, roomName: roomName.trim(), password: password || null, game,
                players: [], status: 'waiting', hostId: socket.userId, lastActivityTime: Date.now()
            };
            activeGames[newRoomId] = newRoom;

            const addResult = addPlayerToRoom(newRoom, socket);
            if (!addResult.success) {
                delete activeGames[newRoomId];
                return callback({ success: false, message: `创建房间失败: ${addResult.message}` });
            }
            socket.join(newRoomId); socket.roomId = newRoomId;
            if (newRoom.players.length > 0) newRoom.players[0].isReady = false; // Host not auto-ready

            callback({ success: true, roomId: newRoomId, roomState: getRoomStateForPlayer(newRoom, socket.userId, false) });
            broadcastRoomList();
            console.log(`[EVENT createRoom] Room "${newRoom.roomName}" (ID:${newRoomId}) created by ${socket.username}.`);
        } catch (error) {
            console.error(`[EVENT createRoom] Error:`, error);
            callback({ success: false, message: '服务器创建房间内部错误。' });
        }
    });

    socket.on('joinRoom', (data, callback) => {
        if (typeof callback !== 'function') { console.error("[RM joinRoom] No CB."); return; }
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
        const { roomId, password: joinPwd } = data;
        console.log(`[EVENT joinRoom] By ${socket.username} for ${roomId}. Pwd: ${!!joinPwd}`);
        try {
            const room = activeGames[roomId];
            if (!room || room.status === 'archived') return callback({ success: false, message: '房间不存在或已关闭。' });
            if (!room.game) return callback({ success: false, message: '房间数据损坏。'});
            
            const currentRoomOfPlayer = findRoomByUserId(socket.userId);
            if (currentRoomOfPlayer && currentRoomOfPlayer.roomId !== roomId) {
                return callback({ success: false, message: '您已在其他房间，请先离开。' });
            }
            
            const playerInThisRoom = room.players.find(p => p.userId === socket.userId);
            if (playerInThisRoom) { // Rejoining or already in (e.g. duplicate tab)
                 if (!playerInThisRoom.connected) { // Is a true reconnect attempt
                    const reconnResult = handleReconnect(socket, roomId); // This also calls callback
                    return reconnResult.success ? callback(reconnResult) : callback(reconnResult) ;
                 } else { // Already connected
                    playerInThisRoom.socketId = socket.id; // Update socket
                    socket.join(roomId); socket.roomId = roomId;
                    return callback({ success: true, roomId, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'), message: "您已在此房间。" });
                 }
            }

            if (room.status !== 'waiting') return callback({ success: false, message: '游戏已开始或结束。' });
            if (room.players.filter(p => p.connected).length >= (room.game.maxPlayers || 4)) return callback({ success: false, message: '房间已满。' });
            if (room.password && room.password !== joinPwd) return callback({ success: false, message: '房间密码错误。' });

            const addResult = addPlayerToRoom(room, socket);
            if (addResult.success && addResult.player) {
                socket.join(roomId); socket.roomId = roomId;
                room.lastActivityTime = Date.now();
                
                const {socketId, ...playerJoinedInfo} = addResult.player; // Don't broadcast socketId
                socket.to(roomId).emit('playerJoined', playerJoinedInfo); // Notify others
                
                // Send full state to all players AFTER new player added
                room.players.forEach(p => {
                    if (p.socketId && ioInstance.sockets.sockets.get(p.socketId)) {
                         ioInstance.sockets.sockets.get(p.socketId).emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, false));
                    }
                });

                callback({ success: true, roomId, roomState: getRoomStateForPlayer(room, socket.userId, false) });
                broadcastRoomList();
            } else { callback({ success: false, message: addResult.message || "加入房间错误。" }); }
        } catch (error) { console.error(`[EVENT joinRoom] Error:`, error); callback({ success: false, message: '服务器加入房间错误。' }); }
    });

    socket.on('playerReady', (isReady, callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: "房间无效。" });
        if (room.status !== 'waiting') return callback({ success: false, message: "游戏非等待状态。" });

        const player = room.players.find(p => p.userId === socket.userId);
        if (!player) return callback({ success: false, message: "未找到玩家。" });
        if (player.isAiControlled) return callback({ success: false, message: "AI托管中。" });

        player.isReady = !!isReady;
        room.lastActivityTime = Date.now();
        console.log(`[EVENT playerReady] ${socket.username} in ${socket.roomId} ready: ${player.isReady}`);

        ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: socket.userId, isReady: player.isReady });
        callback({ success: true });
        checkAndStartGame(room, ioInstance);
    });

    socket.on('playCard', (cards, callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
            return callback({ success: false, message: "游戏状态无效。" });
        }
        
        const result = room.game.playCard(socket.userId, cards);
        if (result.success) {
            room.lastActivityTime = Date.now();
            // Send individual state to each player
            room.players.forEach(p => {
                if (p.socketId) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            });

            if (result.gameOver) {
                room.players.forEach(rp => { // Sync scores from game to room.players
                    const gp = room.game.players.find(g => g.id === rp.userId);
                    if (gp) rp.score = gp.score;
                });
                room.status = 'finished';
                ioInstance.to(socket.roomId).emit('gameOver', {
                    reason: result.scoreResult.result,
                    scoreResult: result.scoreResult
                });
                broadcastRoomList();
            }
            callback({ success: true });
        } else {
            callback({ success: false, message: result.message });
        }
    });

    socket.on('passTurn', (callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
            return callback({ success: false, message: "游戏状态无效。" });
        }

        const result = room.game.handlePass(socket.userId);
        if (result.success) {
            room.lastActivityTime = Date.now();
            room.players.forEach(p => {
                if (p.socketId) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            });
            callback({ success: true });
        } else {
            callback({ success: false, message: result.message });
        }
    });

    socket.on('requestHint', (clientHintIndex, callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
            return callback({ success: false, message: "游戏状态无效。" });
        }
        const result = room.game.findHint(socket.userId, clientHintIndex);
        callback(result);
    });
    
    socket.on('leaveRoom', (callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room) return callback({ success: false, message: "房间不存在。" });

        handlePlayerLeavingRoom(room, socket, "voluntary_leave");
        // Game ending due to player leaving is complex and might depend on rules (e.g. if host leaves, or < min players)
        // For now, game continues, disconnected player is skipped or AI takes over.
        callback({ success: true, message: "已离开房间。" });
    });

    socket.on('requestGameState', (callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback(null);
        const room = activeGames[socket.roomId];
        if (!room) return callback(null);
        callback(getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'));
    });

    socket.on('toggleAI', (enableAI, callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: "房间无效。" });

        const player = room.players.find(p => p.userId === socket.userId);
        if (!player) return callback({ success: false, message: "未找到玩家。" });

        player.isAiControlled = !!enableAI;
        room.game.setPlayerAI(socket.userId, !!enableAI);
        room.lastActivityTime = Date.now();
        console.log(`[EVENT toggleAI] ${socket.username} AI: ${player.isAiControlled}`);

        room.players.forEach(p => {
            if (p.socketId) {
                const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
            }
        });
        callback({ success: true, isAiEnabled: player.isAiControlled });

        if (player.isAiControlled && room.game.gameStarted && !room.game.gameFinished &&
            room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
            console.log(`[AI] AI for ${socket.username} active, is current player. (AI action would trigger)`);
            // Placeholder: In a full system, you might have a dedicated AI player agent.
            // E.g., triggerAIPlay(room, socket.userId, ioInstance);
        }
    });

    socket.on('listRooms', (callback) => { // Client requests room list
        if (typeof callback === 'function') {
            callback(getPublicRoomList());
        } else { // Fallback if no callback, just emit
            socket.emit('roomListUpdate', getPublicRoomList());
        }
    });
}

module.exports = {
    init, handleDisconnect, handleAuthentication, getPublicRoomList,
    findRoomByUserId, handleReconnect, getRoomById
};
