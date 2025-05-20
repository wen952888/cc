// roomManager.js
const { Game, HAND_TYPES, RANK_VALUES, SUIT_VALUES, compareSingleCards, RANK_ORDER, SUIT_ORDER, compareHands } = require('./game');
const crypto = require('crypto');

let activeGames = {};
let ioInstance; // Will be set by init

const ROOM_TTL_SECONDS = 30 * 60;
const PLAYER_RECONNECT_WINDOW_SECONDS = 2 * 60;

const PERMANENT_ROOM_IDS = {
    "gong": "恭",
    "xi": "喜",
    "fa": "发",
    "cai": "财"
};
const PERMANENT_ROOM_ID_ARRAY = Object.keys(PERMANENT_ROOM_IDS);

function generateRoomId() {
    let newId = crypto.randomBytes(3).toString('hex');
    while (PERMANENT_ROOM_ID_ARRAY.includes(newId) || activeGames[newId]) {
        newId = crypto.randomBytes(3).toString('hex');
    }
    return newId;
}

function getRoomById(roomId) {
    return activeGames[roomId];
}

function initializePermanentRooms() {
    for (const id in PERMANENT_ROOM_IDS) {
        if (!activeGames[id]) {
            const game = new Game(id, 4);
            activeGames[id] = {
                roomId: id,
                roomName: PERMANENT_ROOM_IDS[id],
                password: null,
                game,
                players: [],
                status: 'waiting',
                hostId: null,
                lastActivityTime: Date.now(),
                isPermanent: true
            };
            console.log(`[RM INIT] Initialized permanent room: ${PERMANENT_ROOM_IDS[id]} (ID: ${id})`);
        }
    }
}

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
            isPermanent: !!room.isPermanent
        }));
}

function getRoomStateForPlayer(room, requestingUserId, isGameRelatedUpdate = false) {
    if (!room) return null;
    const gameExistsAndActive = !!room.game && (room.status === 'playing' || room.status === 'finished' || isGameRelatedUpdate);
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
            score: gamePlayerFromBase ? gamePlayerFromBase.score : (gameInstancePlayer ? gameInstancePlayer.score : roomPlayer.score || 0),
            hand: (requestingUserId === roomPlayer.userId && gamePlayerFromBase && baseGameState.gameStarted && !baseGameState.gameFinished && !(gamePlayerFromBase.finished)) ? gamePlayerFromBase.hand : undefined,
            handCount: gamePlayerFromBase ? gamePlayerFromBase.handCount : (gameInstancePlayer && gameInstancePlayer.hand ? gameInstancePlayer.hand.length : 0),
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

function resetPermanentRoomForNewGame(room, ioForEmit) {
    if (!room || !room.isPermanent || !ioForEmit) { // Added ioForEmit check
        console.warn(`[RM PERMANENT] Cannot reset room ${room ? room.roomId : 'N/A'}. IsPermanent: ${room ? room.isPermanent : 'N/A'}, IO: ${!!ioForEmit}`);
        return;
    }

    console.log(`[RM PERMANENT] Resetting permanent room ${room.roomName} (ID: ${room.roomId}) for a new game.`);
    
    const playerScoresAndDetails = {};
    room.players.forEach(p => {
        playerScoresAndDetails[p.userId] = {
            score: p.score || 0,
            username: p.username,
            slot: p.slot,
            isAiControlled: p.isAiControlled, // Persist AI status
            connected: p.connected // Persist connection status
        };
    });

    room.game = new Game(room.roomId, 4);
    room.status = 'waiting';
    room.lastActivityTime = Date.now();
    
    // Clear existing game players from the new game instance before re-adding
    room.game.players = []; 
    
    // Re-populate room.players with persisted details and add to new game instance
    const newRoomPlayersList = [];
    for (const userId in playerScoresAndDetails) {
        const details = playerScoresAndDetails[userId];
        const playerForRoom = {
            userId: userId,
            username: details.username,
            socketId: room.players.find(p => p.userId === userId)?.socketId, // Keep socketId if player is still there
            isReady: false, // Reset ready
            slot: details.slot,
            connected: details.connected,
            score: details.score,
            isAiControlled: details.isAiControlled,
        };
        newRoomPlayersList.push(playerForRoom);

        room.game.addPlayer(userId, details.username, details.slot);
        const gamePlayer = room.game.players.find(gp => gp.id === userId);
        if (gamePlayer) {
            gamePlayer.score = details.score;
            gamePlayer.isAiControlled = details.isAiControlled;
            gamePlayer.connected = details.connected; // Game's connected status should reflect room's
        }
    }
    room.players = newRoomPlayersList.sort((a, b) => a.slot - b.slot);

    if (!room.hostId && room.players.length > 0) {
        const firstHuman = room.players.find(p => p.connected && !p.isAiControlled);
        room.hostId = firstHuman ? firstHuman.userId : room.players[0].userId;
    }

    const newStateForAll = getRoomStateForPlayer(room, null, false);
    ioForEmit.to(room.roomId).emit('gameStateUpdate', newStateForAll);
    ioForEmit.to(room.roomId).emit('roomResetForNewGame', { roomId: room.roomId });

    room.players.forEach(p => {
        if (p.socketId && p.connected && !p.isAiControlled) {
            const playerSocket = ioForEmit.sockets.sockets.get(p.socketId);
            if (playerSocket) {
                playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, false));
            }
        }
    });
    broadcastRoomList();
}


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
        existingPlayerInRoom.username = socket.username;
        if (room.game) {
            room.game.markPlayerConnected(socket.userId, true, existingPlayerInRoom.isAiControlled);
            const gamePlayer = room.game.players.find(gp => gp.id === socket.userId);
            if (gamePlayer) gamePlayer.name = socket.username;
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

    // Retrieve score if player was in this permanent room before (even if not currently in room.players list, e.g. after server restart)
    // This part is tricky without full persistence. For now, we rely on room.players if they are there.
    let previousScore = 0;
    if (room.isPermanent) {
        // If we had a more robust way to fetch historical scores for this room, it would go here.
        // For now, if they are not in current room.players, they start with 0 for this session.
        const prevPlayerRecord = room.players.find(p => p.userId === socket.userId);
        if (prevPlayerRecord) previousScore = prevPlayerRecord.score || 0;
    }

    const playerInfo = {
        userId: socket.userId, username: socket.username, socketId: socket.id,
        isReady: false, slot: assignedSlot, connected: true,
        score: previousScore,
        isAiControlled: false,
    };
    room.players.push(playerInfo);
    room.players.sort((a, b) => a.slot - b.slot);

    if (!room.hostId && (!room.isPermanent || room.players.length === 1)) {
        room.hostId = playerInfo.userId;
    }

    if (room.game) {
        if (!room.game.players.some(p => p.id === playerInfo.userId)) {
            room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot);
            const gamePlayer = room.game.players.find(gp => gp.id === playerInfo.userId);
            if (gamePlayer) gamePlayer.score = playerInfo.score; // Set score in game instance
        } else {
            room.game.markPlayerConnected(playerInfo.userId, true, playerInfo.isAiControlled);
            const gamePlayerToUpdate = room.game.players.find(gp => gp.id === playerInfo.userId);
            if (gamePlayerToUpdate) {
                gamePlayerToUpdate.name = playerInfo.username;
                gamePlayerToUpdate.score = playerInfo.score; // Update score in game instance
            }
        }
    }

    room.lastActivityTime = Date.now();
    return { success: true, player: playerInfo, rejoining: false };
}

function checkAndStartGame(room, ioForEmit) {
    if (!room || !room.game || room.status !== 'waiting' || !ioForEmit) return false; // Added ioForEmit check
    const eligiblePlayers = room.players.filter(p => p.connected || p.isAiControlled);

    if (eligiblePlayers.length !== 4) {
      return false;
    }

    const allReady = eligiblePlayers.every(p => p.isReady || p.isAiControlled);
    if (!allReady) {
      return false;
    }

    const playerStartInfo = eligiblePlayers.map(p => ({
        id: p.userId, name: p.username, slot: p.slot,
        score: p.score || 0,
        isAiControlled: p.isAiControlled
    })).sort((a, b) => a.slot - b.slot);

    const startGameResult = room.game.startGame(playerStartInfo);
    if (startGameResult.success) {
        room.status = 'playing';
        room.lastActivityTime = Date.now();
        room.players.forEach(p => p.isReady = false);

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
        checkAndTriggerAI(room, ioForEmit);
        return true;
    } else {
        console.error(`[RM Check&Start] Failed to start game in room ${room.roomId}: ${startGameResult.message}`);
        ioForEmit.to(room.roomId).emit('gameStartFailed', { message: startGameResult.message });
        return false;
    }
}

function checkAndTriggerAI(room, ioForEmit) {
    if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished || !ioForEmit) { // Added ioForEmit check
        return;
    }
    const currentPlayerInGame = room.game.players[room.game.currentPlayerIndex];
    if (currentPlayerInGame && currentPlayerInGame.isAiControlled && !currentPlayerInGame.finished) {
        setTimeout(() => {
            if (!room.game || !room.game.gameStarted || room.game.gameFinished) return;
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
                        room.players.forEach(rp => {
                            const gp = room.game.players.find(g => g.id === rp.userId);
                            if (gp) rp.score = gp.score;
                        });
                        room.status = 'finished';
                        ioForEmit.to(room.roomId).emit('gameOver', {
                            reason: result.scoreResult.result,
                            scoreResult: result.scoreResult
                        });
                        broadcastRoomList();

                        if (room.isPermanent) {
                            setTimeout(() => {
                                resetPermanentRoomForNewGame(room, ioForEmit);
                            }, 5000);
                        }
                    } else {
                        checkAndTriggerAI(room, ioForEmit);
                    }
                } else if (result) {
                    console.error(`[AI PLAY FAILED] AI ${currentPlayerInGame.name} action failed: ${result.message}`);
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
                    } else {
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

// THIS IS THE FUNCTION THAT WAS CAUSING THE ERROR
function handleDisconnect(socket) {
    if (!socket || !socket.userId) {
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    const room = findRoomByUserId(socket.userId);
    if (room) {
        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (playerInRoom) {
            // Only act if this is the primary socket for the player or if their listed socketId is dead
            if (playerInRoom.socketId === socket.id || !playerInRoom.socketId || (ioInstance && !ioInstance.sockets.sockets.get(playerInRoom.socketId))) {
                playerInRoom.connected = false;
                // console.log(`[DISCONNECT RM] Marked ${username} as disconnected in room ${room.roomId}. Current socket: ${socket.id}, Stored socket: ${playerInRoom.socketId}`);

                if (room.game) {
                    const gamePlayer = room.game.players.find(p => p.id === socket.userId);
                    if (room.status === 'playing' && gamePlayer && !gamePlayer.finished && !playerInRoom.isAiControlled) {
                        // console.log(`[DISCONNECT RM] Player ${username} disconnected mid-game. Enabling AI control.`);
                        playerInRoom.isAiControlled = true; // Room player becomes AI
                        room.game.setPlayerAI(socket.userId, true); // Game player becomes AI
                        room.game.markPlayerConnected(socket.userId, true, true); // Mark as connected for AI to play

                        if (room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
                            checkAndTriggerAI(room, ioInstance);
                        }
                    } else if (room.game) { // Not playing, or already AI, or finished
                         room.game.markPlayerConnected(socket.userId, false, playerInRoom.isAiControlled);
                    }
                }

                // If player was ready in waiting room, mark as not ready (unless AI took over and is ready)
                if (room.status === 'waiting' && playerInRoom.isReady && !playerInRoom.isAiControlled) {
                    playerInRoom.isReady = false;
                    if (ioInstance) ioInstance.to(room.roomId).emit('playerReadyUpdate', { userId: playerInRoom.userId, isReady: false });
                }

                if (ioInstance) {
                    const updatedRoomState = getRoomStateForPlayer(room, null, room.status !== 'waiting');
                    ioInstance.to(room.roomId).emit('gameStateUpdate', updatedRoomState);
                }
                room.lastActivityTime = Date.now();
                broadcastRoomList();
                
                // Check if room needs to be ended (for non-permanent rooms)
                if (!room.isPermanent && room.status === 'playing' && room.game && !room.game.gameFinished) {
                    const activeHumanPlayers = room.players.filter(p => p.connected && !p.isAiControlled).length;
                    if (activeHumanPlayers === 0) { // Or based on your game rules for minimum players
                        // console.log(`[DISCONNECT RM] No human players left in non-permanent room ${room.roomId}. Ending game.`);
                        // const scoreResult = room.game.endGame("所有人类玩家离开，游戏结束");
                        // ioInstance.to(room.roomId).emit('gameOver', { reason: scoreResult.result, scoreResult });
                        // room.status = 'finished'; // Will be pruned later
                        // broadcastRoomList();
                        // For now, let pruneInactiveRooms handle this for non-permanent rooms with no humans.
                    }
                }
            } else {
                // console.log(`[DISCONNECT RM] ${username} disconnected with socket ${socket.id}, but has an active connection with socket ${playerInRoom.socketId}. No action taken on room state.`);
            }
        }
    }
}


function handlePlayerLeavingRoom(room, socket, reason = "left_generic") {
    if (!room || !socket || !socket.userId || !ioInstance) { // Added ioInstance check
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;

    const playerInRoomIdx = room.players.findIndex(p => p.userId === socket.userId);
    if (playerInRoomIdx === -1) {
        socket.leave(room.roomId); // Ensure socket leaves if somehow not in players list
        return;
    }
    const playerInRoom = room.players[playerInRoomIdx];

    if (room.status === 'playing' && room.game && !room.game.gameFinished) {
        playerInRoom.isAiControlled = true;
        playerInRoom.connected = false; // Explicitly mark as disconnected
        room.game.setPlayerAI(socket.userId, true);
        room.game.markPlayerConnected(socket.userId, true, true); // AI is logically 'connected'

        if (room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
            checkAndTriggerAI(room, ioInstance);
        }
    } else { // Waiting or Finished status, or permanent room just reset
        if (!room.isPermanent) { // Only remove from non-permanent rooms
            room.players.splice(playerInRoomIdx, 1);
            if (room.game) {
                room.game.removePlayer(socket.userId);
            }
            // Re-assign host if the host left a non-permanent room
            if (room.hostId === socket.userId && room.players.length > 0) {
                const connectedNonAIPlayers = room.players.filter(p => p.connected && !p.isAiControlled);
                if (connectedNonAIPlayers.length > 0) {
                    room.hostId = connectedNonAIPlayers[0].userId;
                } else if (room.players.every(p => p.isAiControlled) && room.players.length > 0) {
                    room.hostId = room.players[0].userId; // Fallback to an AI player
                } else {
                    room.hostId = null; // No suitable host
                }
            } else if (room.players.length === 0) {
                room.hostId = null;
            }
        } else { // For permanent rooms, mark as disconnected, don't remove
            playerInRoom.connected = false;
            if (room.game) room.game.markPlayerConnected(socket.userId, false, playerInRoom.isAiControlled);
        }
    }

    socket.leave(room.roomId);
    if (socket.roomId === room.roomId) socket.roomId = null;

    ioInstance.to(room.roomId).emit('playerLeft', { userId: socket.userId, username: username });
    const updatedRoomState = getRoomStateForPlayer(room, null, room.status !== 'waiting');
    ioInstance.to(room.roomId).emit('gameStateUpdate', updatedRoomState);
    
    room.lastActivityTime = Date.now();
    broadcastRoomList();

    if (!room.isPermanent && room.status === 'playing' && room.game && !room.game.gameFinished) {
        const activePlayersInGame = room.game.players.filter(p => !p.finished).length;
        if (activePlayersInGame < 2) { // Or your minimum player rule
            const scoreResult = room.game.endGame("玩家离开，人数不足");
            ioInstance.to(room.roomId).emit('gameOver', { reason: scoreResult.result, scoreResult });
            room.status = 'finished'; // Will be pruned
            broadcastRoomList();
        }
    }
}

function handleReconnect(socket, roomId) {
    const username = socket.username || `User ${socket.userId ? socket.userId.substring(0,6) : 'Anon'}`;
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
        playerInRoomData.socketId = socket.id;
        playerInRoomData.username = socket.username; // Update username on reconnect

        if (playerInRoomData.isAiControlled) { // If player was AI controlled before
            playerInRoomData.isAiControlled = false; // Human takes back control
            room.game.setPlayerAI(socket.userId, false);
        }
        room.game.markPlayerConnected(socket.userId, true, false); // Mark as human connected
        const gamePlayer = room.game.players.find(p=>p.id === socket.userId);
        if(gamePlayer) gamePlayer.name = socket.username;


        socket.join(roomId); socket.roomId = roomId;
        room.lastActivityTime = Date.now();

        const roomStateForReconnectedPlayer = getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting');
        if (ioInstance) {
            socket.emit('gameStateUpdate', roomStateForReconnectedPlayer);
            // Send update to others as well, as player's connected/AI status might have changed
            socket.to(roomId).emit('gameStateUpdate', getRoomStateForPlayer(room, null, room.status !== 'waiting'));
        }
        broadcastRoomList();
        return { success: true, roomState: roomStateForReconnectedPlayer };
    } catch (error) {
        console.error(`[RECONNECT RM] Error for ${username} to room ${roomId}:`, error);
        return { success: false, message: `服务器内部错误: ${error.message}` };
    }
}

function handleAuthentication(socket) {
    console.log(`[RM Auth CB] Socket ${socket.id} (User: ${socket.username}, ID: ${socket.userId}) confirmed authenticated.`);
}


function pruneInactiveRooms() {
    const now = Date.now();
    let prunedCount = 0;
    for (const roomId in activeGames) {
        const room = activeGames[roomId];
        if (!room || room.status === 'archived' || room.isPermanent) {
            if (room && room.isPermanent && room.status === 'finished' && ioInstance) {
                 console.warn(`[PRUNE RM] Permanent room ${room.roomId} is 'finished'. Attempting reset if stuck.`);
                 // Check if it's been finished for too long without auto-resetting
                 const timeSinceFinish = room.game && room.game.gameFinishedTime ? (now - room.game.gameFinishedTime) / 1000 : 0;
                 if (timeSinceFinish > 30) { // If stuck for 30s
                    resetPermanentRoomForNewGame(room, ioInstance);
                 }
            }
            continue;
        }

        const connectedHumanPlayersCount = room.players.filter(p => p.connected && !p.isAiControlled).length;
        const timeSinceLastActivity = (now - (room.lastActivityTime || now)) / 1000;

        if ((connectedHumanPlayersCount === 0 && timeSinceLastActivity > PLAYER_RECONNECT_WINDOW_SECONDS) ||
            (timeSinceLastActivity > ROOM_TTL_SECONDS)) {
            if (room.game && room.game.gameStarted && !room.game.gameFinished) {
                const scoreResult = room.game.endGame(`房间因长时间无真实玩家活动而被清理`);
                if (ioInstance) {
                    ioInstance.to(room.roomId).emit('gameOver', {
                        reason: scoreResult.result || "游戏因房间清理而结束",
                        scoreResult: scoreResult
                    });
                }
            }
            room.status = 'archived';
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
        broadcastRoomList();
    }
}
setInterval(pruneInactiveRooms, 1 * 60 * 1000);


function init(socket, ioMainInstance) {
    if (!ioInstance && ioMainInstance) {
        ioInstance = ioMainInstance;
        initializePermanentRooms();
    }
    if (!socket) { console.error("[RM INIT] Null socket."); return; }

    socket.on('createRoom', (data, callback) => {
        if (typeof callback !== 'function') { return; }
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
        try {
            const { roomName, password } = data;
            if (findRoomByUserId(socket.userId)) return callback({ success: false, message: '您已在其他房间。' });
            if (!roomName || roomName.trim().length === 0 || roomName.trim().length > 10) return callback({ success: false, message: '房间名无效 (1-10字符)。' });

            if (Object.values(PERMANENT_ROOM_IDS).includes(roomName.trim()) || PERMANENT_ROOM_ID_ARRAY.includes(roomName.trim().toLowerCase())) {
                return callback({ success: false, message: '该房间名为永久房间预留，请选择其他名称。'});
            }

            let newRoomId = generateRoomId();
            const game = new Game(newRoomId, 4);
            const newRoom = {
                roomId: newRoomId, roomName: roomName.trim(), password: password || null, game,
                players: [], status: 'waiting', hostId: socket.userId, lastActivityTime: Date.now(),
                isPermanent: false
            };
            activeGames[newRoomId] = newRoom;
            const addResult = addPlayerToRoom(newRoom, socket);
            if (!addResult.success) {
                delete activeGames[newRoomId];
                return callback({ success: false, message: `创建房间失败: ${addResult.message}` });
            }
            socket.join(newRoomId); socket.roomId = newRoomId;
            callback({ success: true, roomId: newRoomId, roomState: getRoomStateForPlayer(newRoom, socket.userId, false) });
            broadcastRoomList();
        } catch (error) {
            console.error(`[EVENT createRoom] Error:`, error);
            callback({ success: false, message: '服务器创建房间内部错误。' });
        }
    });

    socket.on('joinRoom', (data, callback) => {
        if (typeof callback !== 'function') { return; }
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
        const { roomId, password: joinPwd } = data;
        try {
            const room = activeGames[roomId];
            if (!room || room.status === 'archived') return callback({ success: false, message: '房间不存在或已关闭。' });
            if (!room.game) return callback({ success: false, message: '房间数据损坏。'});
            if (room.game.maxPlayers !== 4) return callback({ success: false, message: '此房间不是4人模式。'});

            const currentRoomOfPlayer = findRoomByUserId(socket.userId);
            if (currentRoomOfPlayer && currentRoomOfPlayer.roomId !== roomId) {
                return callback({ success: false, message: '您已在其他房间，请先离开。' });
            }
            const playerInThisRoom = room.players.find(p => p.userId === socket.userId);
            if (playerInThisRoom) {
                 if (!playerInThisRoom.connected) { // Was disconnected, now rejoining
                    const reconnResult = handleReconnect(socket, roomId); // This will update socketId, connected status etc.
                    return callback(reconnResult);
                 } else { // Already connected (e.g. multiple tabs, or client thinks it's not in room but server does)
                    playerInThisRoom.socketId = socket.id; // Update to new socket
                    socket.join(roomId); socket.roomId = roomId;
                    return callback({ success: true, roomId, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'), message: "您已在此房间。" });
                 }
            }
            // Player not in room.players list yet
            if (room.status !== 'waiting' && !room.isPermanent) { // Non-permanent room, game started/finished
                return callback({ success: false, message: '游戏已开始或结束。' });
            }
            // For permanent rooms, players can join even if 'finished' because it will reset.
            // Or if 'playing', they join as spectator or wait for next game (current logic adds them to player list).
            // Let's refine: if permanent and 'playing', don't allow new joins mid-game unless designed for it.
            if (room.status === 'playing' && !room.players.some(p => p.userId === socket.userId)) {
                 return callback({ success: false, message: '游戏进行中，请稍后再试或等待下一局。'});
            }

            if (room.players.filter(p => p.connected || p.isAiControlled).length >= room.game.maxPlayers) {
                return callback({ success: false, message: '房间已满。' });
            }
            if (room.password && room.password !== joinPwd) return callback({ success: false, message: '房间密码错误。' });

            const addResult = addPlayerToRoom(room, socket);
            if (addResult.success && addResult.player) {
                socket.join(roomId); socket.roomId = roomId;
                room.lastActivityTime = Date.now();
                const {socketId, ...playerJoinedInfo} = addResult.player; // Don't send socketId to other clients
                socket.to(roomId).emit('playerJoined', playerJoinedInfo);
                
                const fullStateForNewPlayer = getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting');
                callback({ success: true, roomId, roomState: fullStateForNewPlayer });
                // Send updated state to all other players in the room
                room.players.forEach(p => {
                    if (p.userId !== socket.userId && p.socketId && ioInstance.sockets.sockets.get(p.socketId)) {
                         ioInstance.sockets.sockets.get(p.socketId).emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                    }
                });
                broadcastRoomList();
                 // If room was finished and is permanent, joining might trigger reset if it's empty and waiting for players
                 if (room.isPermanent && room.status === 'finished' && room.players.length === 1) {
                    resetPermanentRoomForNewGame(room, ioInstance);
                 } else if (room.status === 'waiting') { // If joining a waiting room, check if game can start
                    checkAndStartGame(room, ioInstance);
                 }

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
        if (player.isAiControlled) return callback({ success: false, message: "AI托管中，无需准备。" });
        
        player.isReady = !!isReady;
        room.lastActivityTime = Date.now();
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
        const player = room.game.players.find(p => p.id === socket.userId);
        if (player && player.isAiControlled) return callback({ success: false, message: "AI托管中，不能手动出牌。" });

        const result = room.game.playCard(socket.userId, cards);
        if (result.success) {
            room.lastActivityTime = Date.now();
            const newStateForAll = getRoomStateForPlayer(room, null, true);
            ioInstance.to(socket.roomId).emit('gameStateUpdate', newStateForAll);
            room.players.forEach(p => {
                if (p.connected && !p.isAiControlled && p.socketId) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            });
            if (result.gameOver) {
                room.players.forEach(rp => {
                    const gp = room.game.players.find(g => g.id === rp.userId);
                    if (gp) rp.score = gp.score;
                });
                room.status = 'finished';
                // Add gameFinishedTime to room.game if it's not there in game.js
                if (room.game && !room.game.gameFinishedTime) room.game.gameFinishedTime = Date.now();

                ioInstance.to(socket.roomId).emit('gameOver', {
                    reason: result.scoreResult.result,
                    scoreResult: result.scoreResult
                });
                broadcastRoomList();
                if (room.isPermanent) {
                    setTimeout(() => {
                        resetPermanentRoomForNewGame(room, ioInstance);
                    }, 5000);
                }
            } else {
                checkAndTriggerAI(room, ioInstance);
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
        const player = room.game.players.find(p => p.id === socket.userId);
        if (player && player.isAiControlled) return callback({ success: false, message: "AI托管中，不能手动操作。" });

        const result = room.game.handlePass(socket.userId);
        if (result.success) {
            room.lastActivityTime = Date.now();
            const newStateForAll = getRoomStateForPlayer(room, null, true);
            ioInstance.to(socket.roomId).emit('gameStateUpdate', newStateForAll);
            room.players.forEach(p => {
                if (p.connected && !p.isAiControlled && p.socketId) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            });
            checkAndTriggerAI(room, ioInstance);
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
        const player = room.game.players.find(p => p.id === socket.userId);
        if (player && player.isAiControlled) return callback({ success: false, message: "AI托管中。" });
        const result = room.game.findHint(socket.userId, clientHintIndex, false);
        callback(result);
    });

    socket.on('leaveRoom', (callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room) return callback({ success: false, message: "房间不存在。" });
        
        handlePlayerLeavingRoom(room, socket, "voluntary_leave"); // This function now uses ioInstance internally
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
        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (!playerInRoom) return callback({ success: false, message: "未找到玩家。" });

        playerInRoom.isAiControlled = !!enableAI;
        room.game.setPlayerAI(socket.userId, !!enableAI);
        if (enableAI) {
            room.game.markPlayerConnected(socket.userId, true, true); // AI is logically connected
            if(room.status === 'waiting') playerInRoom.isReady = true; // AI is always ready
        } else {
            // When disabling AI, ensure connected status reflects actual socket connection
            room.game.markPlayerConnected(socket.userId, playerInRoom.connected, false);
        }
        room.lastActivityTime = Date.now();
        
        const newStateForAll = getRoomStateForPlayer(room, null, room.status !== 'waiting');
        ioInstance.to(socket.roomId).emit('gameStateUpdate', newStateForAll);
        room.players.forEach(p => {
            if (p.connected && !p.isAiControlled && p.socketId) { // Update human players
                const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
            }
        });
        callback({ success: true, isAiEnabled: playerInRoom.isAiControlled });

        if (playerInRoom.isAiControlled && room.game.gameStarted && !room.game.gameFinished &&
            room.game.players[room.game.currentPlayerIndex]?.id === socket.userId &&
            !room.game.players[room.game.currentPlayerIndex]?.finished) {
            checkAndTriggerAI(room, ioInstance);
        }
        if (room.status === 'waiting' && playerInRoom.isAiControlled) { // If AI made ready, check start
            checkAndStartGame(room, ioInstance);
        }
    });

    socket.on('listRooms', (callback) => {
        if (typeof callback === 'function') {
            callback(getPublicRoomList());
        } else { // Fallback if client doesn't send callback
            socket.emit('roomListUpdate', getPublicRoomList());
        }
    });
}


module.exports = {
    init,
    handleDisconnect,
    handleAuthentication,
    getPublicRoomList,
    findRoomByUserId,
    handleReconnect,
    getRoomById,
    checkAndTriggerAI
};
