// roomManager.js
const { Game, HAND_TYPES, RANK_VALUES, SUIT_VALUES, compareSingleCards, RANK_ORDER, SUIT_ORDER, compareHands } = require('./game');
const crypto = require('crypto');

let activeGames = {};
let ioInstance; // Will be set by init

const ROOM_TTL_SECONDS = 30 * 60;
const PLAYER_RECONNECT_WINDOW_SECONDS = 2 * 60;

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
            hasPassword: !!room.password
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
    };
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
        room.game.markPlayerConnected(socket.userId, true, existingPlayerInRoom.isAiControlled);
        const gamePlayer = room.game.players.find(gp => gp.id === socket.userId);
        if (gamePlayer) gamePlayer.name = socket.username;
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
        isReady: false, slot: assignedSlot, connected: true, score: 0,
        isAiControlled: false,
    };
    room.players.push(playerInfo);
    room.players.sort((a, b) => a.slot - b.slot);

    if (!room.game.players.some(p => p.id === playerInfo.userId)) {
        if (!room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot)) {
            // console.warn(`[ADD PLAYER RM] game.addPlayer failed for ${playerInfo.username} in ${room.roomId}, though added to room.players.`);
        }
    } else {
        room.game.markPlayerConnected(playerInfo.userId, true, playerInfo.isAiControlled);
        const gamePlayerToUpdate = room.game.players.find(gp => gp.id === playerInfo.userId);
        if (gamePlayerToUpdate) gamePlayerToUpdate.name = playerInfo.username;
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
                        }
                    } else {
                        console.error(`[AI PLAY FAILED] AI ${currentPlayerInGame.name} failed mandatory play.`);
                         const scoreResult = room.game.endGame(`AI ${currentPlayerInGame.name} 决策错误`);
                         ioInstance.to(room.roomId).emit('gameOver', { reason: scoreResult.result, scoreResult });
                         room.status = 'finished';
                         broadcastRoomList();
                    }
                }
            }
        }, room.game.aiPlayDelay || 1500);
    }
}

// --- THIS IS THE FUNCTION THAT WAS MISSING OR MISREFERENCED ---
function handleDisconnect(socket) {
    if (!socket || !socket.userId) {
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    const room = findRoomByUserId(socket.userId);
    if (room) {
        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (playerInRoom) {
            if (playerInRoom.socketId === socket.id || !playerInRoom.socketId || (ioInstance && !ioInstance.sockets.sockets.get(playerInRoom.socketId))) {
                playerInRoom.connected = false;
                // console.log(`[DISCONNECT RM] Marked ${username} as disconnected in room ${room.roomId}.`);

                if (room.game) {
                    const gamePlayer = room.game.players.find(p => p.id === socket.userId);
                    if (room.status === 'playing' && gamePlayer && !gamePlayer.finished && !playerInRoom.isAiControlled) {
                        // console.log(`[DISCONNECT RM] Player ${username} disconnected mid-game. Enabling AI control.`);
                        playerInRoom.isAiControlled = true;
                        room.game.setPlayerAI(socket.userId, true);
                        room.game.markPlayerConnected(socket.userId, true, true);

                        if (room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
                            checkAndTriggerAI(room, ioInstance);
                        }
                    } else if (room.game) {
                         room.game.markPlayerConnected(socket.userId, false, playerInRoom.isAiControlled);
                    }
                }

                if (room.status === 'waiting' && playerInRoom.isReady) {
                    playerInRoom.isReady = false;
                    if (ioInstance) ioInstance.to(room.roomId).emit('playerReadyUpdate', { userId: playerInRoom.userId, isReady: false });
                }

                if (ioInstance) {
                    const updatedRoomState = getRoomStateForPlayer(room, null, room.status !== 'waiting');
                    ioInstance.to(room.roomId).emit('gameStateUpdate', updatedRoomState);
                }
                room.lastActivityTime = Date.now();
                broadcastRoomList();
            }
        }
    }
}
// --- END OF handleDisconnect FUNCTION ---


function handlePlayerLeavingRoom(room, socket, reason = "left_generic") {
    if (!room || !socket || !socket.userId) {
        // console.warn(`[LEAVE ROOM RM] Invalid params. Room:${!!room}, Sock:${!!socket}, UID:${socket?.userId}`);
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    // console.log(`[LEAVE ROOM RM] ${username} (Socket:${socket.id}) leaving room ${room.roomId}. Reason: ${reason}`);

    const playerInRoomIdx = room.players.findIndex(p => p.userId === socket.userId);
    if (playerInRoomIdx === -1) {
        // console.warn(`[LEAVE ROOM RM] ${username} not in room.players for ${room.roomId}.`);
        socket.leave(room.roomId);
        return;
    }
    const playerInRoom = room.players[playerInRoomIdx];

    if (room.status === 'playing' && room.game && !room.game.gameFinished) {
        // console.log(`[LEAVE ROOM RM] Player ${username} left mid-game. Marking as AI controlled.`);
        playerInRoom.isAiControlled = true;
        playerInRoom.connected = false;
        room.game.setPlayerAI(socket.userId, true);
        room.game.markPlayerConnected(socket.userId, true, true);

        if (room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
            // console.log(`[LEAVE ROOM RM] Current player ${username} left, AI takes over immediately.`);
            checkAndTriggerAI(room, ioInstance);
        }
    } else {
        room.players.splice(playerInRoomIdx, 1);
        if (room.game) {
            room.game.removePlayer(socket.userId);
        }
        if (room.hostId === socket.userId && room.status === 'waiting' && room.players.length > 0) {
            const connectedNonAIPlayers = room.players.filter(p => p.connected && !p.isAiControlled);
            if (connectedNonAIPlayers.length > 0) {
                room.hostId = connectedNonAIPlayers[0].userId;
            } else if (room.players.every(p => p.isAiControlled) && room.players.length > 0) {
                room.hostId = room.players[0].userId;
            }
        }
    }

    socket.leave(room.roomId);
    if (socket.roomId === room.roomId) socket.roomId = null;

    if (ioInstance) {
        ioInstance.to(room.roomId).emit('playerLeft', { userId: socket.userId, username: username });
        const updatedRoomState = getRoomStateForPlayer(room, null, room.status !== 'waiting');
        ioInstance.to(room.roomId).emit('gameStateUpdate', updatedRoomState);
    }
    room.lastActivityTime = Date.now();
    broadcastRoomList();

    if (room.status === 'playing' && room.game && !room.game.gameFinished) {
        const activePlayersInGame = room.game.players.filter(p => !p.finished).length;
        if (activePlayersInGame < 2) {
            // console.log(`[LEAVE ROOM RM] Not enough players to continue game in ${room.roomId} after ${username} left. Ending game.`);
            const scoreResult = room.game.endGame("玩家离开，人数不足");
            ioInstance.to(room.roomId).emit('gameOver', { reason: scoreResult.result, scoreResult });
            room.status = 'finished';
            broadcastRoomList();
        }
    }
}


function handleReconnect(socket, roomId) {
    const username = socket.username || `User ${socket.userId ? socket.userId.substring(0,6) : 'Anon'}`;
    // console.log(`[RECONNECT RM] Attempting reconnect for ${username} (Socket: ${socket.id}) to room ${roomId}.`);
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
        playerInRoomData.username = socket.username;

        if (playerInRoomData.isAiControlled) {
            // console.log(`[RECONNECT RM] Player ${username} reconnected, disabling previous AI control.`);
            playerInRoomData.isAiControlled = false;
            room.game.setPlayerAI(socket.userId, false);
        }
        room.game.markPlayerConnected(socket.userId, true, false);
        const gamePlayer = room.game.players.find(p=>p.id === socket.userId);
        if(gamePlayer) gamePlayer.name = socket.username;

        socket.join(roomId); socket.roomId = roomId;
        room.lastActivityTime = Date.now();
        // console.log(`[RECONNECT RM] ${username} reconnected to ${roomId}. Broadcasting update.`);

        const roomStateForReconnectedPlayer = getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting');
        if (ioInstance) {
            socket.emit('gameStateUpdate', roomStateForReconnectedPlayer);
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
        if (!room || room.status === 'archived') continue;
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
                room.players.forEach(rp => {
                    const gp = room.game.players.find(g => g.id === rp.userId);
                    if (gp) rp.score = gp.score;
                });
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
        // console.log(`[PRUNE RM] Pruned ${prunedCount} room(s).`);
        broadcastRoomList();
    }
}
setInterval(pruneInactiveRooms, 1 * 60 * 1000);

function init(socket, ioMainInstance) {
    if (!ioInstance && ioMainInstance) ioInstance = ioMainInstance;
    if (!socket) { console.error("[RM INIT] Null socket."); return; }

    socket.on('createRoom', (data, callback) => {
        if (typeof callback !== 'function') { /* console.error("[RM createRoom] No CB."); */ return; }
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
        // console.log(`[EVENT createRoom] By ${socket.username} (ID:${socket.userId}). Data:`, data);
        try {
            const { roomName, password } = data;
            if (findRoomByUserId(socket.userId)) return callback({ success: false, message: '您已在其他房间。' });
            if (!roomName || roomName.trim().length === 0 || roomName.trim().length > 10) return callback({ success: false, message: '房间名无效 (1-10字符)。' });

            let newRoomId = generateRoomId();
            while (activeGames[newRoomId]) newRoomId = generateRoomId();
            const game = new Game(newRoomId, 4);
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
            callback({ success: true, roomId: newRoomId, roomState: getRoomStateForPlayer(newRoom, socket.userId, false) });
            broadcastRoomList();
            // console.log(`[EVENT createRoom] Room "${newRoom.roomName}" (ID:${newRoomId}) created by ${socket.username}.`);
        } catch (error) {
            console.error(`[EVENT createRoom] Error:`, error);
            callback({ success: false, message: '服务器创建房间内部错误。' });
        }
    });

    socket.on('joinRoom', (data, callback) => {
        if (typeof callback !== 'function') { /* console.error("[RM joinRoom] No CB."); */ return; }
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
        const { roomId, password: joinPwd } = data;
        // console.log(`[EVENT joinRoom] By ${socket.username} for ${roomId}. Pwd: ${!!joinPwd}`);
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
                 if (!playerInThisRoom.connected) {
                    const reconnResult = handleReconnect(socket, roomId);
                    return callback(reconnResult);
                 } else {
                    playerInThisRoom.socketId = socket.id;
                    socket.join(roomId); socket.roomId = roomId;
                    return callback({ success: true, roomId, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'), message: "您已在此房间。" });
                 }
            }
            if (room.status !== 'waiting') return callback({ success: false, message: '游戏已开始或结束。' });
            if (room.players.filter(p => p.connected || p.isAiControlled).length >= room.game.maxPlayers) return callback({ success: false, message: '房间已满。' });
            if (room.password && room.password !== joinPwd) return callback({ success: false, message: '房间密码错误。' });

            const addResult = addPlayerToRoom(room, socket);
            if (addResult.success && addResult.player) {
                socket.join(roomId); socket.roomId = roomId;
                room.lastActivityTime = Date.now();
                const {socketId, ...playerJoinedInfo} = addResult.player;
                socket.to(roomId).emit('playerJoined', playerJoinedInfo);
                const fullStateForNewPlayer = getRoomStateForPlayer(room, socket.userId, false);
                callback({ success: true, roomId, roomState: fullStateForNewPlayer });
                room.players.forEach(p => {
                    if (p.userId !== socket.userId && p.socketId && ioInstance.sockets.sockets.get(p.socketId)) {
                         ioInstance.sockets.sockets.get(p.socketId).emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, false));
                    }
                });
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
        if (player.isAiControlled) return callback({ success: false, message: "AI托管中，无需准备。" });
        player.isReady = !!isReady;
        room.lastActivityTime = Date.now();
        // console.log(`[EVENT playerReady] ${socket.username} in ${socket.roomId} ready: ${player.isReady}`);
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
                ioInstance.to(socket.roomId).emit('gameOver', {
                    reason: result.scoreResult.result,
                    scoreResult: result.scoreResult
                });
                broadcastRoomList();
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
        handlePlayerLeavingRoom(room, socket, "voluntary_leave");
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
            room.game.markPlayerConnected(socket.userId, true, true);
            if(room.status === 'waiting') playerInRoom.isReady = true;
        } else {
            room.game.markPlayerConnected(socket.userId, playerInRoom.connected, false);
        }
        room.lastActivityTime = Date.now();
        // console.log(`[EVENT toggleAI] ${socket.username} AI: ${playerInRoom.isAiControlled}`);
        const newStateForAll = getRoomStateForPlayer(room, null, room.status !== 'waiting');
        ioInstance.to(socket.roomId).emit('gameStateUpdate', newStateForAll);
        room.players.forEach(p => {
            if (p.connected && !p.isAiControlled && p.socketId) {
                const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
            }
        });
        callback({ success: true, isAiEnabled: playerInRoom.isAiControlled });
        if (playerInRoom.isAiControlled && room.game.gameStarted && !room.game.gameFinished &&
            room.game.players[room.game.currentPlayerIndex]?.id === socket.userId &&
            !room.game.players[room.game.currentPlayerIndex]?.finished) {
            // console.log(`[AI] AI for ${socket.username} activated, is current player. Triggering AI play.`);
            checkAndTriggerAI(room, ioInstance);
        }
        if (room.status === 'waiting' && playerInRoom.isAiControlled) {
            checkAndStartGame(room, ioInstance);
        }
    });

    socket.on('listRooms', (callback) => {
        if (typeof callback === 'function') {
            callback(getPublicRoomList());
        } else {
            socket.emit('roomListUpdate', getPublicRoomList());
        }
    });
}

module.exports = {
    init,
    handleDisconnect,       // 确保这个函数是定义的
    handleAuthentication,
    getPublicRoomList,
    findRoomByUserId,
    handleReconnect,
    getRoomById,
    checkAndTriggerAI
};
