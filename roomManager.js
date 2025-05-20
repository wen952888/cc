// roomManager.js
const { Game, HAND_TYPES, RANK_VALUES, SUIT_VALUES, compareSingleCards, RANK_ORDER, SUIT_ORDER, compareHands } = require('./game');
const crypto = require('crypto');

let activeGames = {};
let ioInstance; // Will be set by init

const ROOM_TTL_SECONDS = 30 * 60;
const PLAYER_RECONNECT_WINDOW_SECONDS = 2 * 60;

// --- MODIFICATION START: Define permanent room IDs and names ---
const PERMANENT_ROOM_IDS = {
    "gong": "恭",
    "xi": "喜",
    "fa": "发",
    "cai": "财"
};
const PERMANENT_ROOM_ID_ARRAY = Object.keys(PERMANENT_ROOM_IDS);
// --- MODIFICATION END ---

function generateRoomId() { 
    let newId = crypto.randomBytes(3).toString('hex');
    // Ensure generated ID doesn't clash with permanent room IDs or existing rooms
    while (PERMANENT_ROOM_ID_ARRAY.includes(newId) || activeGames[newId]) {
        newId = crypto.randomBytes(3).toString('hex');
    }
    return newId;
}
function getRoomById(roomId) { return activeGames[roomId]; }

// --- MODIFICATION START: Initialize permanent rooms ---
function initializePermanentRooms() {
    for (const id in PERMANENT_ROOM_IDS) {
        if (!activeGames[id]) { // Only create if not already existing (e.g., server restart)
            const game = new Game(id, 4); // Max players for KK is 4
            activeGames[id] = {
                roomId: id,
                roomName: PERMANENT_ROOM_IDS[id],
                password: null, // Permanent rooms are public
                game,
                players: [],
                status: 'waiting', // Initial status
                hostId: null, // Permanent rooms might not have a traditional host, or assign one dynamically
                lastActivityTime: Date.now(),
                isPermanent: true // Flag to identify permanent rooms
            };
            console.log(`[RM INIT] Initialized permanent room: ${PERMANENT_ROOM_IDS[id]} (ID: ${id})`);
        }
    }
}
// Call this at the start, after activeGames is defined.
// We will call this within the main init function.
// --- MODIFICATION END ---


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
    } else {
        console.warn("[BROADCAST RM] ioInstance not available for room list broadcast.");
    }
}

function getPublicRoomList() {
    return Object.values(activeGames)
        .filter(room => room && room.status !== 'archived')
        .map(room => ({
            roomId: room.roomId,
            roomName: room.roomName,
            playerCount: room.players.filter(p => p.connected || p.isAiControlled).length,
            maxPlayers: room.game ? (room.game.maxPlayers || 4) : 4,
            status: room.status,
            hasPassword: !!room.password,
            isPermanent: !!room.isPermanent // Add this to client if needed for display
        }));
}

function getRoomStateForPlayer(room, requestingUserId, isGameRelatedUpdate = false) {
    if (!room) return null;
    const gameExistsAndActive = !!room.game && (room.status === 'playing' || room.status === 'finished' || isGameRelatedUpdate);
    // --- MODIFICATION: If game is finished in a permanent room, we might want to show 'waiting' like state
    // or allow a new game to be set up. For now, baseGameState will correctly reflect 'finished'.
    const baseGameState = gameExistsAndActive ? room.game.getStateForPlayer(requestingUserId) : null;

    const combinedPlayers = room.players.map(roomPlayer => {
        const gamePlayerFromBase = baseGameState && baseGameState.players ? baseGameState.players.find(gp => gp.id === roomPlayer.userId) : null;
        const gameInstancePlayer = room.game ? room.game.players.find(gip => gip.id === roomPlayer.userId) : null;

        return {
            userId: roomPlayer.userId,
            username: roomPlayer.username,
            slot: roomPlayer.slot,
            isReady: roomPlayer.isReady,
            connected: roomPlayer.connected,
            isAiControlled: roomPlayer.isAiControlled,
            score: gamePlayerFromBase ? gamePlayerFromBase.score : (gameInstancePlayer ? gameInstancePlayer.score : roomPlayer.score || 0), // Persist score for permanent rooms
            hand: (requestingUserId === roomPlayer.userId && gamePlayerFromBase && baseGameState.gameStarted && !baseGameState.gameFinished && !(gamePlayerFromBase.finished)) ? gamePlayerFromBase.hand : undefined,
            handCount: gamePlayerFromBase ? gamePlayerFromBase.handCount : (gameInstancePlayer && gameInstancePlayer.hand ? gameInstancePlayer.hand.length : 0),
            role: gamePlayerFromBase ? gamePlayerFromBase.role : (gameInstancePlayer ? gameInstancePlayer.role : null),
            finished: gamePlayerFromBase ? gamePlayerFromBase.finished : (gameInstancePlayer ? gameInstancePlayer.finished : false),
        };
    });

    return {
        roomId: room.roomId,
        roomName: room.roomName,
        status: room.status, // This will show 'finished' for permanent rooms after game end
        players: combinedPlayers,
        myUserId: requestingUserId,
        hostId: room.hostId,
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
        aiPlayDelay: room.game ? room.game.aiPlayDelay : 1500,
        isPermanent: !!room.isPermanent
    };
}

// --- MODIFICATION START: Function to reset a permanent room for a new game ---
function resetPermanentRoomForNewGame(room, ioForEmit) {
    if (!room || !room.isPermanent) return;

    console.log(`[RM PERMANENT] Resetting permanent room ${room.roomName} (ID: ${room.roomId}) for a new game.`);
    // Reset game instance within the room. Players' scores are kept in room.players.score
    // Create a new game instance, but preserve player scores from the room.players objects
    const playerScores = {};
    room.players.forEach(p => { playerScores[p.userId] = p.score || 0; });

    room.game = new Game(room.roomId, 4); // New game instance
    room.status = 'waiting';
    room.lastActivityTime = Date.now();
    // Players are kept, but their ready status is reset. AI control might also be reset or kept based on preference.
    // For simplicity, let's reset ready status and AI for now.
    room.players.forEach(p => {
        p.isReady = false;
        // p.isAiControlled = false; // Decide if AI should persist or be reset
        // Re-add players to the new game instance with their existing scores
        if (room.game.players.find(gp => gp.id === p.userId)) {
            const gamePlayer = room.game.players.find(gp => gp.id === p.userId);
            gamePlayer.score = playerScores[p.userId] || 0;
            gamePlayer.name = p.username;
            gamePlayer.slot = p.slot;
            gamePlayer.isAiControlled = p.isAiControlled; // Keep AI status
            gamePlayer.connected = p.connected; // Keep connection status
        } else {
             room.game.addPlayer(p.userId, p.username, p.slot);
             const gamePlayer = room.game.players.find(gp => gp.id === p.userId);
             if (gamePlayer) {
                gamePlayer.score = playerScores[p.userId] || 0;
                gamePlayer.isAiControlled = p.isAiControlled;
                gamePlayer.connected = p.connected;
             }
        }
    });
    
    // Host logic for permanent rooms: If no human host, maybe the first human player becomes host?
    // Or, permanent rooms might not need a host in the same way if they auto-start or have fixed settings.
    // For now, let's try to assign a host if one is missing and there are players.
    if (!room.hostId && room.players.length > 0) {
        const firstHuman = room.players.find(p => p.connected && !p.isAiControlled);
        if (firstHuman) {
            room.hostId = firstHuman.userId;
        } else if (room.players.length > 0) {
            room.hostId = room.players[0].userId; // Fallback to any player
        }
    }


    const newStateForAll = getRoomStateForPlayer(room, null, false);
    ioForEmit.to(room.roomId).emit('gameStateUpdate', newStateForAll); // Notify all players of reset
    ioForEmit.to(room.roomId).emit('roomResetForNewGame', { roomId: room.roomId }); // Specific event for client handling

    room.players.forEach(p => {
        if (p.socketId && p.connected && !p.isAiControlled) {
            const playerSocket = ioForEmit.sockets.sockets.get(p.socketId);
            if (playerSocket) {
                playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, false));
            }
        }
    });

    broadcastRoomList(); // Update room list as status changes to 'waiting'
}
// --- MODIFICATION END ---


function addPlayerToRoom(room, socket) {
    if (!room || !room.game || !socket || !socket.userId || !socket.username) {
        console.error("[ADD PLAYER RM] Invalid params for addPlayerToRoom.", { room:!!room, game:!!room?.game, sock:!!socket, uid:socket?.userId, uname:socket?.username });
        return { success: false, message: "服务器内部错误：数据不完整。" };
    }
    const maxPlayers = room.game.maxPlayers || 4;
    const existingPlayerInRoom = room.players.find(p => p.userId === socket.userId);

    if (existingPlayerInRoom) {
        existingPlayerInRoom.socketId = socket.id;
        existingPlayerInRoom.connected = true;
        existingPlayerInRoom.username = socket.username; // Update username on rejoin
        if (room.game) { // Ensure game exists
            room.game.markPlayerConnected(socket.userId, true, existingPlayerInRoom.isAiControlled);
            const gamePlayer = room.game.players.find(gp => gp.id === socket.userId);
            if (gamePlayer) gamePlayer.name = socket.username; // Update name in game instance too
        }
        return { success: true, player: existingPlayerInRoom, rejoining: true };
    }

    if (room.players.filter(p => p.connected || p.isAiControlled).length >= maxPlayers) {
        return { success: false, message: "房间已满 (最多4人)。" };
    }

    const existingSlots = room.players.map(p => p.slot);
    let assignedSlot = -1;
    for (let i = 0; i < maxPlayers; i++) { if (!existingSlots.includes(i)) { assignedSlot = i; break; } }
    if (assignedSlot === -1) { return { success: false, message: "无法找到可用位置。" }; }

    const playerInfo = {
        userId: socket.userId, username: socket.username, socketId: socket.id,
        isReady: false, slot: assignedSlot, connected: true, 
        score: room.isPermanent ? (room.players.find(p=>p.userId === socket.userId)?.score || 0) : 0, // Preserve score if rejoining permanent room, else 0
        isAiControlled: false,
    };
    room.players.push(playerInfo);
    room.players.sort((a, b) => a.slot - b.slot);
    
    // Assign host if it's the first player in a non-permanent room or an empty permanent room
    if (!room.hostId && (!room.isPermanent || room.players.length === 1)) {
        room.hostId = playerInfo.userId;
    }


    if (room.game) { // Ensure game exists
        if (!room.game.players.some(p => p.id === playerInfo.userId)) {
            if (!room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot)) {
                // console.warn(`[ADD PLAYER RM] game.addPlayer failed for ${playerInfo.username} in ${room.roomId}, though added to room.players.`);
            }
            const gamePlayer = room.game.players.find(gp => gp.id === playerInfo.userId);
            if (gamePlayer && room.isPermanent) gamePlayer.score = playerInfo.score; // Set score for new game player
        } else {
            room.game.markPlayerConnected(playerInfo.userId, true, playerInfo.isAiControlled);
            const gamePlayerToUpdate = room.game.players.find(gp => gp.id === playerInfo.userId);
            if (gamePlayerToUpdate) {
                 gamePlayerToUpdate.name = playerInfo.username; // Update name in game instance
                 if(room.isPermanent) gamePlayerToUpdate.score = playerInfo.score; // Update score
            }
        }
    }


    room.lastActivityTime = Date.now();
    // console.log(`[ADD PLAYER RM] Player ${playerInfo.username} added to room ${room.roomId}, slot ${assignedSlot}. Total in room.players: ${room.players.length}`);
    return { success: true, player: playerInfo, rejoining: false };
}

function checkAndStartGame(room, ioForEmit) {
    if (!room || !room.game || room.status !== 'waiting') return false;
    const eligiblePlayers = room.players.filter(p => p.connected || p.isAiControlled);

    if (eligiblePlayers.length !== 4) {
    //   console.log(`[RM Check&Start] Not enough/too many eligible players for room ${room.roomId}. Have ${eligiblePlayers.length}, need 4.`);
      return false;
    }

    const allReady = eligiblePlayers.every(p => p.isReady || p.isAiControlled);
    if (!allReady) {
      return false;
    }

    // console.log(`[RM Check&Start] All 4 eligible players ready in room ${room.roomId}. Starting game...`);
    const playerStartInfo = eligiblePlayers.map(p => ({
        id: p.userId, name: p.username, slot: p.slot,
        score: p.score || 0, // Pass current scores to game instance
        isAiControlled: p.isAiControlled
    })).sort((a, b) => a.slot - b.slot);

    const startGameResult = room.game.startGame(playerStartInfo);
    if (startGameResult.success) {
        room.status = 'playing';
        room.lastActivityTime = Date.now();
        room.players.forEach(p => p.isReady = false); // Reset ready status after game starts

        const initialStateForAll = getRoomStateForPlayer(room, null, true);
        ioForEmit.to(room.roomId).emit('gameStarted', initialStateForAll);

        room.players.forEach(p => {
            if (p.socketId && (p.connected && !p.isAiControlled)) {
                const playerSocket = ioForEmit.sockets.sockets.get(p.socketId);
                if (playerSocket) {
                    playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            }
        });
        broadcastRoomList();
        // console.log(`[RM Check&Start] Game started successfully in room ${room.roomId}.`);
        checkAndTriggerAI(room, ioForEmit);
        return true;
    } else {
        console.error(`[RM Check&Start] Failed to start game in room ${room.roomId}: ${startGameResult.message}`);
        ioForEmit.to(room.roomId).emit('gameStartFailed', { message: startGameResult.message });
        return false;
    }
}

function checkAndTriggerAI(room, ioForEmit) {
    if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
        return;
    }
    const currentPlayerInGame = room.game.players[room.game.currentPlayerIndex];
    if (currentPlayerInGame && currentPlayerInGame.isAiControlled && !currentPlayerInGame.finished) {
        // console.log(`[AI TRIGGER] AI player ${currentPlayerInGame.name}'s turn in room ${room.roomId}.`);
        setTimeout(() => {
            if (!room.game || !room.game.gameStarted || room.game.gameFinished) return; // Check again, game might have ended
            const currentTurnPlayerNow = room.game.players[room.game.currentPlayerIndex];
            if (currentTurnPlayerNow && currentTurnPlayerNow.id === currentPlayerInGame.id && currentTurnPlayerNow.isAiControlled && !currentTurnPlayerNow.finished) {
                const aiDecision = room.game.decideAiPlay(currentPlayerInGame.id);
                let result;
                if (aiDecision.action === 'play') {
                    result = room.game.playCard(currentPlayerInGame.id, aiDecision.cards);
                } else {
                    result = room.game.handlePass(currentPlayerInGame.id);
                }

                if (result && result.success) {
                    room.lastActivityTime = Date.now();
                    const newStateForAll = getRoomStateForPlayer(room, null, true);
                    ioForEmit.to(room.roomId).emit('gameStateUpdate', newStateForAll);

                    room.players.forEach(p => {
                        if (p.connected && !p.isAiControlled && p.socketId) {
                            const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                            if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                        }
                    });

                    if (result.gameOver) {
                        // --- MODIFICATION: Handle permanent room game over ---
                        room.players.forEach(rp => { // Update scores in room.players
                            const gp = room.game.players.find(g => g.id === rp.userId);
                            if (gp) rp.score = gp.score;
                        });
                        room.status = 'finished'; // Mark as finished first
                        ioForEmit.to(room.roomId).emit('gameOver', {
                            reason: result.scoreResult.result,
                            scoreResult: result.scoreResult
                        });
                        broadcastRoomList(); // Show 'finished' status temporarily

                        if (room.isPermanent) {
                            // After a short delay, reset the permanent room
                            setTimeout(() => {
                                resetPermanentRoomForNewGame(room, ioForEmit);
                            }, 5000); // 5 second delay before reset
                        }
                        // --- MODIFICATION END ---
                    } else {
                        checkAndTriggerAI(room, ioForEmit); // Next AI turn if applicable
                    }
                } else if (result) { // AI play failed
                    console.error(`[AI PLAY FAILED] AI ${currentPlayerInGame.name} action failed: ${result.message}`);
                    // Existing fallback logic for AI failure
                    if (room.game.lastValidHandInfo && room.game.lastPlayerWhoPlayed !== currentPlayerInGame.id) {
                        const passResult = room.game.handlePass(currentPlayerInGame.id);
                        if (passResult.success) {
                            const newStateForAll = getRoomStateForPlayer(room, null, true);
                            ioForEmit.to(room.roomId).emit('gameStateUpdate', newStateForAll);
                            checkAndTriggerAI(room, ioForEmit);
                        } else {
                             console.error(`[AI PLAY FAILED] AI ${currentPlayerInGame.name} also failed to pass after failed play.`);
                             const scoreResult = room.game.endGame(`AI ${currentPlayerInGame.name} 故障，游戏结束`);
                             ioInstance.to(room.roomId).emit('gameOver', { reason: scoreResult.result, scoreResult });
                             room.status = 'finished';
                             broadcastRoomList();
                             if (room.isPermanent) { setTimeout(() => resetPermanentRoomForNewGame(room, ioForEmit), 5000); }
                        }
                    } else { // AI failed mandatory play
                        console.error(`[AI PLAY FAILED] AI ${currentPlayerInGame.name} failed mandatory play.`);
                         const scoreResult = room.game.endGame(`AI ${currentPlayerInGame.name} 决策错误`);
                         ioInstance.to(room.roomId).emit('gameOver', { reason: scoreResult.result, scoreResult });
                         room.status = 'finished';
                         broadcastRoomList();
                         if (room.isPermanent) { setTimeout(() => resetPermanentRoomForNewGame(room, ioForEmit), 5000); }
                    }
                }
            }
        }, room.game.aiPlayDelay || 1500);
    }
}

// ... (handleDisconnect, handlePlayerLeavingRoom, handleReconnect, handleAuthentication remain largely the same, but ensure they interact correctly with permanent room logic if needed, e.g., host assignment on leave)

function pruneInactiveRooms() {
    const now = Date.now();
    let prunedCount = 0;
    for (const roomId in activeGames) {
        const room = activeGames[roomId];
        // --- MODIFICATION: Skip permanent rooms from pruning ---
        if (!room || room.status === 'archived' || room.isPermanent) {
            if (room && room.isPermanent && room.status === 'finished') {
                // This case should ideally be handled by the auto-reset logic after game over.
                // If a permanent room is somehow stuck in 'finished', we might manually reset it here or log.
                // console.log(`[PRUNE RM] Permanent room ${room.roomId} is finished, should auto-reset. If not, investigate.`);
            }
            continue;
        }
        // --- MODIFICATION END ---

        const connectedHumanPlayersCount = room.players.filter(p => p.connected && !p.isAiControlled).length;
        const timeSinceLastActivity = (now - (room.lastActivityTime || now)) / 1000;

        if ((connectedHumanPlayersCount === 0 && timeSinceLastActivity > PLAYER_RECONNECT_WINDOW_SECONDS) ||
            (timeSinceLastActivity > ROOM_TTL_SECONDS)) {
            // console.log(`[PRUNE RM] Pruning room ${roomId} (${room.roomName}). ConnHumans:${connectedHumanPlayersCount}, Inactive:${timeSinceLastActivity.toFixed(0)}s.`);
            if (room.game && room.game.gameStarted && !room.game.gameFinished) {
                const scoreResult = room.game.endGame(`房间因长时间无真实玩家活动而被清理`);
                if (ioInstance) {
                    ioInstance.to(room.roomId).emit('gameOver', {
                        reason: scoreResult.result || "游戏因房间清理而结束",
                        scoreResult: scoreResult
                    });
                }
                // Scores are updated in game.endGame and then reflected in room.players by gameOver logic
            }
            room.status = 'archived'; // Mark for removal / hiding
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
        // console.log(`[PRUNE RM] Pruned ${prunedCount} room(s).`);
        broadcastRoomList(); // Update list if any non-permanent rooms were archived
    }
}
setInterval(pruneInactiveRooms, 1 * 60 * 1000);


function init(socket, ioMainInstance) {
    if (!ioInstance && ioMainInstance) {
        ioInstance = ioMainInstance;
        initializePermanentRooms(); // Initialize permanent rooms when ioInstance is first set
    }
    if (!socket) { console.error("[RM INIT] Null socket."); return; }

    socket.on('createRoom', (data, callback) => {
        if (typeof callback !== 'function') { /* console.error("[RM createRoom] No CB."); */ return; }
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
        // console.log(`[EVENT createRoom] By ${socket.username} (ID:${socket.userId}). Data:`, data);
        try {
            const { roomName, password } = data;
            if (findRoomByUserId(socket.userId)) return callback({ success: false, message: '您已在其他房间。' });
            if (!roomName || roomName.trim().length === 0 || roomName.trim().length > 10) return callback({ success: false, message: '房间名无效 (1-10字符)。' });

            // --- MODIFICATION: Prevent creating rooms with permanent room names/IDs (optional, for clarity) ---
            if (Object.values(PERMANENT_ROOM_IDS).includes(roomName.trim()) || PERMANENT_ROOM_ID_ARRAY.includes(roomName.trim().toLowerCase())) {
                return callback({ success: false, message: '该房间名为永久房间预留，请选择其他名称。'});
            }
            // --- MODIFICATION END ---

            let newRoomId = generateRoomId(); // generateRoomId now avoids permanent IDs
            // while (activeGames[newRoomId]) newRoomId = generateRoomId(); // This check is now inside generateRoomId
            
            const game = new Game(newRoomId, 4);
            const newRoom = {
                roomId: newRoomId, roomName: roomName.trim(), password: password || null, game,
                players: [], status: 'waiting', hostId: socket.userId, lastActivityTime: Date.now(),
                isPermanent: false // User-created rooms are not permanent
            };
            activeGames[newRoomId] = newRoom;
            const addResult = addPlayerToRoom(newRoom, socket);
            if (!addResult.success) {
                delete activeGames[newRoomId]; // Clean up if player add failed
                return callback({ success: false, message: `创建房间失败: ${addResult.message}` });
            }
            socket.join(newRoomId); socket.roomId = newRoomId;
            callback({ success: true, roomId: newRoomId, roomState: getRoomStateForPlayer(newRoom, socket.userId, false) });
            broadcastRoomList();
            // console.log(`[EVENT createRoom] Room "${newRoom.roomName}" (ID:${newRoomId}) created by ${socket.username}.`);
        } catch (error) {
            console.error(`[EVENT createRoom] Error:`, error);
            callback({ success: false, message: '服务器创建房间内部错误。' });
        }
    });

    // ... (joinRoom, playerReady etc. need to consider permanent room scores if applicable)
    // In joinRoom, when a player joins a permanent room, their score should be loaded if they were previously in it.
    // The addPlayerToRoom function was updated to try and preserve scores for permanent rooms.

    // --- MODIFICATION: Game Over event needs to trigger reset for permanent rooms ---
    socket.on('playCard', (cards, callback) => {
        // ... (existing logic)
        const room = activeGames[socket.roomId];
        // ...
        const result = room.game.playCard(socket.userId, cards);
        if (result.success) {
            // ... (existing broadcasting)
            if (result.gameOver) {
                room.players.forEach(rp => { // Update scores in room.players
                    const gp = room.game.players.find(g => g.id === rp.userId);
                    if (gp) rp.score = gp.score;
                });
                room.status = 'finished';
                ioInstance.to(socket.roomId).emit('gameOver', {
                    reason: result.scoreResult.result,
                    scoreResult: result.scoreResult
                });
                broadcastRoomList(); // Show 'finished' status

                if (room.isPermanent) { // Check if permanent room
                    setTimeout(() => {
                        resetPermanentRoomForNewGame(room, ioInstance);
                    }, 5000); // Delay before reset
                }
            } else {
                checkAndTriggerAI(room, ioInstance);
            }
            callback({ success: true });
        } else {
            callback({ success: false, message: result.message });
        }
    });
    
    // Similarly, handle game over in passTurn
    socket.on('passTurn', (callback) => {
        // ... (existing logic for finding room, player)
        const room = activeGames[socket.roomId];
        // ...
        const result = room.game.handlePass(socket.userId);
        if (result.success) {
            // ... (existing broadcasting)
            // The game over check is implicit if all pass and a new round starts for someone who then finishes,
            // or if a player finishes. The playCard handler above is more direct for game over.
            // checkAndTriggerAI will handle AI plays which might lead to game over.
            checkAndTriggerAI(room, ioInstance); // This call can lead to game over for AI.
            callback({ success: true });
        } else {
            callback({ success: false, message: result.message });
        }
    });
    // ... (rest of the init function)
}

module.exports = {
    init,
    handleDisconnect,
    handleAuthentication,
    getPublicRoomList,
    findRoomByUserId,
    handleReconnect,
    getRoomById,
    checkAndTriggerAI,
    // Expose for potential admin or testing:
    // initializePermanentRooms, 
    // resetPermanentRoomForNewGame 
};
