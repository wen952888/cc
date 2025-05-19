// roomManager.js
const { Game, HAND_TYPES, RANK_VALUES, SUIT_VALUES, compareSingleCards, RANK_ORDER, SUIT_ORDER, compareHands } = require('./game'); // 确保导入 compareHands
const crypto = require('crypto');

// ... (其他变量和函数保持不变) ...
let activeGames = {};
let ioInstance;

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
            playerCount: room.players.filter(p => p.connected || p.isAiControlled).length, // AI也算人数
            maxPlayers: room.game ? (room.game.maxPlayers || 4) : 4,
            status: room.status,
            hasPassword: !!room.password
        }));
}

function getRoomStateForPlayer(room, requestingUserId, isGameRelatedUpdate = false) {
    // ... (保持不变)
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
    // ... (保持不变)
    if (!room || !room.game || !socket || !socket.userId || !socket.username) {
        console.error("[ADD PLAYER RM] Invalid params for addPlayerToRoom.", { room:!!room, game:!!room?.game, sock:!!socket, uid:socket?.userId, uname:socket?.username });
        return { success: false, message: "服务器内部错误：数据不完整。" };
    }
    const maxPlayers = room.game.maxPlayers || 4;
    const existingPlayerInRoom = room.players.find(p => p.userId === socket.userId);

    if (existingPlayerInRoom) {
        console.log(`[ADD PLAYER RM] Player ${socket.username} (ID: ${socket.userId}) already in room.players for ${room.roomId}. Updating status.`);
        existingPlayerInRoom.socketId = socket.id;
        existingPlayerInRoom.connected = true;
        existingPlayerInRoom.username = socket.username; // 同步名称
        room.game.markPlayerConnected(socket.userId, true, existingPlayerInRoom.isAiControlled);
        const gamePlayer = room.game.players.find(gp => gp.id === socket.userId);
        if (gamePlayer) gamePlayer.name = socket.username;
        return { success: true, player: existingPlayerInRoom, rejoining: true };
    }

    if (room.players.filter(p => p.connected || p.isAiControlled).length >= maxPlayers) { // AI也算人数
        return { success: false, message: "房间已满。" };
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
            console.warn(`[ADD PLAYER RM] game.addPlayer failed for ${playerInfo.username} in ${room.roomId}, though added to room.players.`);
        }
    } else {
        room.game.markPlayerConnected(playerInfo.userId, true, playerInfo.isAiControlled);
        const gamePlayerToUpdate = room.game.players.find(gp => gp.id === playerInfo.userId);
        if (gamePlayerToUpdate) gamePlayerToUpdate.name = playerInfo.username;
    }

    room.lastActivityTime = Date.now();
    console.log(`[ADD PLAYER RM] Player ${playerInfo.username} added to room ${room.roomId}, slot ${assignedSlot}. Total in room.players: ${room.players.length}`);
    return { success: true, player: playerInfo, rejoining: false };
}


function checkAndStartGame(room, ioForEmit) {
    // ... (保持不变)
    if (!room || !room.game || room.status !== 'waiting') return false;

    const eligiblePlayers = room.players.filter(p => p.connected || p.isAiControlled);
    if (eligiblePlayers.length < 2 || eligiblePlayers.length > room.game.maxPlayers) { // 至少需要2人开始游戏
      return false;
    }
     // KK 规则如果要求必须4人，则这里判断  eligiblePlayers.length !== room.game.maxPlayers

    const allReady = eligiblePlayers.every(p => p.isReady || p.isAiControlled);
    if (!allReady) {
      return false;
    }

    console.log(`[RM Check&Start] All ${eligiblePlayers.length} eligible players ready in room ${room.roomId}. Starting game...`);

    const playerStartInfo = eligiblePlayers.map(p => ({
        id: p.userId, name: p.username, slot: p.slot,
        score: p.score || 0,
        isAiControlled: p.isAiControlled
    })).sort((a, b) => a.slot - b.slot);

    const startGameResult = room.game.startGame(playerStartInfo); // game.startGame 现在也处理人数问题
    if (startGameResult.success) {
        room.status = 'playing';
        room.lastActivityTime = Date.now();
        room.players.forEach(p => p.isReady = false); // 重置准备状态

        // 首次发送状态，包含AI延迟信息
        const initialStateForAll = getRoomStateForPlayer(room, null, true);
        ioForEmit.to(room.roomId).emit('gameStarted', initialStateForAll);

        room.players.forEach(p => {
            if (p.socketId && (p.connected || p.isAiControlled)) { // AI也需要状态（虽然它不通过socket接收）
                const playerSocket = ioForEmit.sockets.sockets.get(p.socketId);
                if (playerSocket) {
                    playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            }
        });

        broadcastRoomList();
        console.log(`[RM Check&Start] Game started successfully in room ${room.roomId}.`);
        // 检查第一个出牌的是否是AI
        checkAndTriggerAI(room, ioForEmit);
        return true;
    } else {
        console.error(`[RM Check&Start] Failed to start game in room ${room.roomId}: ${startGameResult.message}`);
        ioForEmit.to(room.roomId).emit('gameStartFailed', { message: startGameResult.message });
        return false;
    }
}

// 新增：检查并触发AI行动的函数
function checkAndTriggerAI(room, ioForEmit) {
    if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
        return;
    }
    const currentPlayerInGame = room.game.players[room.game.currentPlayerIndex];
    if (currentPlayerInGame && currentPlayerInGame.isAiControlled && !currentPlayerInGame.finished) {
        console.log(`[AI TRIGGER] AI player ${currentPlayerInGame.name}'s turn in room ${room.roomId}.`);
        // 使用 game.aiPlayDelay
        setTimeout(() => {
            // 再次检查游戏状态，防止在延迟期间游戏已结束或玩家状态改变
            if (!room.game || !room.game.gameStarted || room.game.gameFinished) return;
            const currentTurnPlayerNow = room.game.players[room.game.currentPlayerIndex];
            if (currentTurnPlayerNow && currentTurnPlayerNow.id === currentPlayerInGame.id && currentTurnPlayerNow.isAiControlled && !currentTurnPlayerNow.finished) {
                const aiDecision = room.game.decideAiPlay(currentPlayerInGame.id);
                let result;
                if (aiDecision.action === 'play') {
                    result = room.game.playCard(currentPlayerInGame.id, aiDecision.cards);
                } else { // action === 'pass'
                    result = room.game.handlePass(currentPlayerInGame.id);
                }

                // 处理AI行动的结果
                if (result && result.success) {
                    room.lastActivityTime = Date.now();
                    const newStateForAll = getRoomStateForPlayer(room, null, true);
                    ioForEmit.to(room.roomId).emit('gameStateUpdate', newStateForAll); // 广播给所有人

                    // 单独给每个真实玩家发送手牌信息（如果他们的手牌在全局状态中被隐藏了）
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
                        // 如果游戏未结束，检查下一个回合是否还是AI
                        checkAndTriggerAI(room, ioForEmit);
                    }
                } else if (result) {
                    console.error(`[AI PLAY FAILED] AI ${currentPlayerInGame.name} action failed: ${result.message}`);
                    // AI出牌失败，这通常意味着AI逻辑或游戏规则校验有问题。
                    // 简单处理：让AI pass （如果允许）或者记录错误。
                    // 为避免卡死，如果AI必须出牌但失败，尝试让它pass
                    if (room.game.lastValidHandInfo && room.game.lastPlayerWhoPlayed !== currentPlayerInGame.id) {
                        const passResult = room.game.handlePass(currentPlayerInGame.id);
                        if (passResult.success) {
                            // ... 广播 gameStateUpdate ...
                            const newStateForAll = getRoomStateForPlayer(room, null, true);
                            ioForEmit.to(room.roomId).emit('gameStateUpdate', newStateForAll);
                            checkAndTriggerAI(room, ioForEmit); // 检查下一个
                        } else {
                             console.error(`[AI PLAY FAILED] AI ${currentPlayerInGame.name} also failed to pass after failed play.`);
                             // 可能需要管理员介入或游戏自动结束
                        }
                    } else {
                        console.error(`[AI PLAY FAILED] AI ${currentPlayerInGame.name} failed mandatory play.`);
                        // 强制游戏结束或标记错误
                         room.game.endGame(`AI ${currentPlayerInGame.name} 决策错误`);
                         const scoreRes = room.game.calculateScores(); // 使用endGame内部的计分
                         ioInstance.to(room.roomId).emit('gameOver', { reason: scoreRes.result, scoreResult: scoreRes });
                         broadcastRoomList();

                    }
                }
            }
        }, room.game.aiPlayDelay || 1500); // 使用game实例中的延迟
    }
}


function handlePlayerLeavingRoom(room, socket, reason = "left_generic") {
    // ... (基本逻辑保持不变)
    if (!room || !socket || !socket.userId) {
        console.warn(`[LEAVE ROOM RM] Invalid params. Room:${!!room}, Sock:${!!socket}, UID:${socket?.userId}`);
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    console.log(`[LEAVE ROOM RM] ${username} (Socket:${socket.id}) leaving room ${room.roomId}. Reason: ${reason}`);

    const playerInRoomIdx = room.players.findIndex(p => p.userId === socket.userId);
    if (playerInRoomIdx === -1) {
        console.warn(`[LEAVE ROOM RM] ${username} not in room.players for ${room.roomId}.`);
        socket.leave(room.roomId);
        return;
    }
    const playerInRoom = room.players[playerInRoomIdx];

    if (room.status === 'playing' && room.game && !room.game.gameFinished) {
        // 如果游戏中途离开，可以选择让其变为AI托管，或者直接算作游戏结束/放弃
        // 当前行为：标记为断开，AI托管状态由客户端切换。这里服务器端可以强制AI接管
        console.log(`[LEAVE ROOM RM] Player ${username} left mid-game. Marking as AI controlled.`);
        playerInRoom.isAiControlled = true; // 强制AI接管
        playerInRoom.connected = false; // 标记为断开连接，但AI仍在
        room.game.setPlayerAI(socket.userId, true);
        room.game.markPlayerConnected(socket.userId, true, true); // AI在游戏中总是"connected"

        // 如果离开的是当前回合玩家，AI需要立即行动
        if (room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
            console.log(`[LEAVE ROOM RM] Current player ${username} left, AI takes over immediately.`);
            checkAndTriggerAI(room, ioInstance);
        }

    } else { // 等待状态或游戏已结束
        room.players.splice(playerInRoomIdx, 1); // 从房间玩家列表中移除
        if (room.game) {
            room.game.removePlayer(socket.userId); // 从游戏实例中也移除
        }
         // 如果是房主离开，且房间是等待状态，需要选新房主或解散房间
        if (room.hostId === socket.userId && room.status === 'waiting' && room.players.length > 0) {
            const connectedNonAIPlayers = room.players.filter(p => p.connected && !p.isAiControlled);
            if (connectedNonAIPlayers.length > 0) {
                room.hostId = connectedNonAIPlayers[0].userId;
                console.log(`[LEAVE ROOM RM] Host ${username} left, new host is ${connectedNonAIPlayers[0].username}`);
            } else { // 没有其他真人玩家了，全是AI或者空了
                 // 可以选择解散房间，或者让AI成为房主（如果允许）
                 // 为简单起见，如果只剩AI或空了，可以考虑清理房间
                 if (room.players.every(p => p.isAiControlled) && room.players.length > 0) {
                     room.hostId = room.players[0].userId; // 第一个AI当房主
                 } else if (room.players.length === 0) {
                     console.log(`[LEAVE ROOM RM] Host left and room ${room.roomId} is now empty. Will be pruned.`);
                     // pruneInactiveRooms 会处理
                 }
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

    // 如果因玩家离开导致人数不足以继续游戏
    if (room.status === 'playing' && room.game && !room.game.gameFinished) {
        const activePlayersInGame = room.game.players.filter(p => !p.finished).length;
        if (activePlayersInGame < 2) { // 通常至少需要2人
            console.log(`[LEAVE ROOM RM] Not enough players to continue game in ${room.roomId} after ${username} left. Ending game.`);
            const scoreResult = room.game.endGame("玩家离开，人数不足");
            ioInstance.to(room.roomId).emit('gameOver', { reason: scoreResult.result, scoreResult });
            // 更新房间状态等
            room.status = 'finished'; // 或 'archived' 如果直接清理
            broadcastRoomList();
        }
    }
}

function handleDisconnect(socket) {
    // ... (基本逻辑保持不变，但当玩家断开连接时，如果游戏正在进行，可以考虑将其标记为AI)
    if (!socket || !socket.userId) {
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;

    const room = findRoomByUserId(socket.userId);
    if (room) {
        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (playerInRoom) {
            if (playerInRoom.socketId === socket.id || !playerInRoom.socketId || !ioInstance.sockets.sockets.get(playerInRoom.socketId)) {
                playerInRoom.connected = false;
                console.log(`[DISCONNECT RM] Marked ${username} as disconnected in room ${room.roomId}.`);

                if (room.game) {
                    // 如果游戏正在进行且玩家未完成，可以选择自动切换为AI
                    const gamePlayer = room.game.players.find(p => p.id === socket.userId);
                    if (room.status === 'playing' && gamePlayer && !gamePlayer.finished && !playerInRoom.isAiControlled) {
                        console.log(`[DISCONNECT RM] Player ${username} disconnected mid-game. Enabling AI control.`);
                        playerInRoom.isAiControlled = true;
                        room.game.setPlayerAI(socket.userId, true);
                        // AI在游戏中保持"connected"状态
                        room.game.markPlayerConnected(socket.userId, true, true);

                        // 如果断开的是当前回合的玩家，AI需要立即行动
                        if (room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
                            checkAndTriggerAI(room, ioInstance);
                        }
                    } else if (room.game) { // 其他情况，只标记游戏内断开
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

function handleReconnect(socket, roomId) {
    // ... (基本逻辑保持不变，确保重连时如果之前是AI，现在恢复为人类控制)
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
        playerInRoomData.socketId = socket.id;
        playerInRoomData.username = socket.username;
        // 如果玩家重连，应该取消AI托管状态（除非客户端再次显式开启）
        if (playerInRoomData.isAiControlled) {
            console.log(`[RECONNECT RM] Player ${username} reconnected, disabling AI control.`);
            playerInRoomData.isAiControlled = false;
            room.game.setPlayerAI(socket.userId, false);
        }
        room.game.markPlayerConnected(socket.userId, true, false); // 标记为人类连接
        const gamePlayer = room.game.players.find(p=>p.id === socket.userId);
        if(gamePlayer) gamePlayer.name = socket.username;

        socket.join(roomId); socket.roomId = roomId;
        room.lastActivityTime = Date.now();
        console.log(`[RECONNECT RM] ${username} reconnected to ${roomId}. Broadcasting update.`);

        const roomStateForReconnectedPlayer = getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting');
        if (ioInstance) {
            // 给重连的玩家发送他的特定状态
            socket.emit('gameStateUpdate', roomStateForReconnectedPlayer);
            // 给房间内其他人广播通用状态更新
            socket.to(roomId).emit('gameStateUpdate', getRoomStateForPlayer(room, null, room.status !== 'waiting'));
        }
        broadcastRoomList();
        return { success: true, roomState: roomStateForReconnectedPlayer };
    } catch (error) {
        console.error(`[RECONNECT RM] Error for ${username} to room ${roomId}:`, error);
        return { success: false, message: `服务器内部错误: ${error.message}` };
    }
}


// init 函数中的 socket 事件监听
function init(socket, ioMainInstance) {
    if (!ioInstance && ioMainInstance) ioInstance = ioMainInstance;
    if (!socket) { console.error("[RM INIT] Null socket."); return; }

    // ... (createRoom, joinRoom, playerReady 事件处理逻辑保持不变) ...
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

            const game = new Game(newRoomId, 4); // 默认4人，可根据创建参数修改
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
            // 主持人默认不准备
            // if (newRoom.players.length > 0) newRoom.players[0].isReady = false;

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
            if (playerInThisRoom) {
                 if (!playerInThisRoom.connected) {
                    return handleReconnect(socket, roomId); // handleReconnect现在返回对象，让调用者处理callback
                 } else {
                    playerInThisRoom.socketId = socket.id;
                    socket.join(roomId); socket.roomId = roomId;
                    return callback({ success: true, roomId, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'), message: "您已在此房间。" });
                 }
            }

            if (room.status !== 'waiting') return callback({ success: false, message: '游戏已开始或结束。' });
            if (room.players.filter(p => p.connected || p.isAiControlled).length >= (room.game.maxPlayers || 4)) return callback({ success: false, message: '房间已满。' });
            if (room.password && room.password !== joinPwd) return callback({ success: false, message: '房间密码错误。' });

            const addResult = addPlayerToRoom(room, socket);
            if (addResult.success && addResult.player) {
                socket.join(roomId); socket.roomId = roomId;
                room.lastActivityTime = Date.now();

                const {socketId, ...playerJoinedInfo} = addResult.player;
                socket.to(roomId).emit('playerJoined', playerJoinedInfo);

                const fullStateForNewPlayer = getRoomStateForPlayer(room, socket.userId, false);
                callback({ success: true, roomId, roomState: fullStateForNewPlayer });

                // 给房间内其他玩家也发送更新（因为人数等信息变了）
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
        if (player.isAiControlled) return callback({ success: false, message: "AI托管中，无需准备。" }); // AI 不能手动准备

        player.isReady = !!isReady;
        room.lastActivityTime = Date.now();
        console.log(`[EVENT playerReady] ${socket.username} in ${socket.roomId} ready: ${player.isReady}`);

        ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: socket.userId, isReady: player.isReady });
        callback({ success: true });
        checkAndStartGame(room, ioInstance);
    });


    socket.on('playCard', (cards, callback) => {
        if (typeof callback !== 'function') return;
        // ... (校验保持不变)
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
            return callback({ success: false, message: "游戏状态无效。" });
        }
        const player = room.game.players.find(p => p.id === socket.userId);
        if (player && player.isAiControlled) return callback({ success: false, message: "AI托管中，不能手动出牌。" }); // AI托管时不能手动出牌


        const result = room.game.playCard(socket.userId, cards);
        if (result.success) {
            room.lastActivityTime = Date.now();
            const newStateForAll = getRoomStateForPlayer(room, null, true);
            ioInstance.to(socket.roomId).emit('gameStateUpdate', newStateForAll);
             // 单独给每个真实玩家发送手牌信息
            room.players.forEach(p => {
                if (p.connected && !p.isAiControlled && p.socketId) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            });


            if (result.gameOver) {
                // ... (游戏结束逻辑)
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
                // 检查下一回合是否是AI
                checkAndTriggerAI(room, ioInstance);
            }
            callback({ success: true });
        } else {
            callback({ success: false, message: result.message });
        }
    });

    socket.on('passTurn', (callback) => {
        if (typeof callback !== 'function') return;
        // ... (校验保持不变)
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
             // 单独给每个真实玩家发送手牌信息
            room.players.forEach(p => {
                if (p.connected && !p.isAiControlled && p.socketId) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            });

            checkAndTriggerAI(room, ioInstance); // 检查下一回合
            callback({ success: true });
        } else {
            callback({ success: false, message: result.message });
        }
    });

    socket.on('requestHint', (clientHintIndex, callback) => {
        // ... (保持不变，但AI不会通过这个事件请求提示)
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
            return callback({ success: false, message: "游戏状态无效。" });
        }
        const player = room.game.players.find(p => p.id === socket.userId);
        if (player && player.isAiControlled) return callback({ success: false, message: "AI托管中。" });

        const result = room.game.findHint(socket.userId, clientHintIndex, false); // forAI is false
        callback(result);
    });

    socket.on('toggleAI', (enableAI, callback) => {
        if (typeof callback !== 'function') return;
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "无玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: "房间无效。" });

        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (!playerInRoom) return callback({ success: false, message: "未找到玩家。" });

        playerInRoom.isAiControlled = !!enableAI;
        // AI 玩家在游戏逻辑中总是 connected，但 room.players 中的 connected 反映真实socket连接
        // 所以，如果开启AI，game.markPlayerConnected 的 connected 参数应为 true
        room.game.setPlayerAI(socket.userId, !!enableAI);
        if (enableAI) {
            room.game.markPlayerConnected(socket.userId, true, true); // AI is active and "connected" in game logic
            playerInRoom.isReady = true; // AI 总是准备好的 (如果在等待阶段)
        } else {
            // 关闭AI时，恢复玩家真实的连接状态
            room.game.markPlayerConnected(socket.userId, playerInRoom.connected, false);
        }


        room.lastActivityTime = Date.now();
        console.log(`[EVENT toggleAI] ${socket.username} AI: ${playerInRoom.isAiControlled}`);

        const newStateForAll = getRoomStateForPlayer(room, null, room.status !== 'waiting');
        ioInstance.to(socket.roomId).emit('gameStateUpdate', newStateForAll);
         // 单独给每个真实玩家发送手牌信息
        room.players.forEach(p => {
            if (p.connected && !p.isAiControlled && p.socketId) {
                const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
            }
        });


        callback({ success: true, isAiEnabled: playerInRoom.isAiControlled });

        // 如果开启AI并且轮到该玩家
        if (playerInRoom.isAiControlled && room.game.gameStarted && !room.game.gameFinished &&
            room.game.players[room.game.currentPlayerIndex]?.id === socket.userId &&
            !room.game.players[room.game.currentPlayerIndex]?.finished) {
            console.log(`[AI] AI for ${socket.username} activated, is current player. Triggering AI play.`);
            checkAndTriggerAI(room, ioInstance);
        }
        // 如果在等待阶段开启AI，并且所有人都准备好了，则开始游戏
        if (room.status === 'waiting' && playerInRoom.isAiControlled) {
            checkAndStartGame(room, ioInstance);
        }
    });
    // ... (listRooms 事件处理逻辑保持不变)
    socket.on('listRooms', (callback) => {
        if (typeof callback === 'function') {
            callback(getPublicRoomList());
        } else {
            socket.emit('roomListUpdate', getPublicRoomList());
        }
    });

}

module.exports = {
    init, handleDisconnect, handleAuthentication, getPublicRoomList,
    findRoomByUserId, handleReconnect, getRoomById, checkAndTriggerAI // 导出 checkAndTriggerAI
};
