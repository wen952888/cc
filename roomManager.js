// roomManager.js
const { Game } = require('./game'); // 从 game.js 导入 Game 类
const crypto = require('crypto');

let activeGames = {}; // 存储活跃的游戏房间: { roomId: roomObject, ... }
let ioInstance;       // Socket.IO 服务器实例，由 init 函数设置

const ROOM_TTL_SECONDS = 30 * 60; // 房间无活动后被清理的时间 (30分钟)
const PLAYER_RECONNECT_WINDOW_SECONDS = 2 * 60; // 玩家断线后保留位置的时间 (2分钟)


// 生成唯一的房间ID
function generateRoomId() {
    return crypto.randomBytes(3).toString('hex'); // 生成一个6个字符的十六进制字符串
}

// 通过ID获取房间对象
function getRoomById(roomId) {
    return activeGames[roomId];
}

// 通过用户ID查找该用户所在的房间
function findRoomByUserId(userId) {
    for (const roomId in activeGames) {
        const room = activeGames[roomId];
        // 确保房间未归档，且玩家在房间的 players 列表中
        if (room && room.status !== 'archived' && room.players.some(p => p.userId === userId)) {
            return room;
        }
    }
    return null;
}

// 广播最新的公共房间列表给所有连接的客户端
function broadcastRoomList() {
    if (ioInstance) {
        ioInstance.emit('roomListUpdate', getPublicRoomList());
    } else {
        console.warn("[RM] broadcastRoomList: ioInstance 未初始化。");
    }
}

// 获取对所有客户端可见的房间列表信息
function getPublicRoomList() {
    return Object.values(activeGames)
        .filter(room => room && room.status !== 'archived') // 不显示已归档的房间
        .map(room => ({
            roomId: room.roomId,
            roomName: room.roomName,
            playerCount: room.players.filter(p => p.connected).length, // 只计算已连接的玩家
            maxPlayers: room.game ? (room.game.maxPlayers || 4) : 4, // 从游戏实例或默认获取最大玩家数
            status: room.status, // 'waiting', 'playing', 'finished'
            hasPassword: !!room.password // 是否有密码
        }));
}

// 为特定玩家组装房间和游戏的完整状态
function getRoomStateForPlayer(room, requestingUserId, isGameContextUpdate = false) {
    if (!room) return null;

    // 只有在游戏活跃（进行中/已结束）或明确是游戏相关更新时，才尝试获取详细游戏状态
    const shouldGetGameDetails = (isGameContextUpdate || room.status === 'playing' || room.status === 'finished') && room.game;
    const gameStateFromGameInstance = shouldGetGameDetails ? room.game.getStateForPlayer(requestingUserId) : null;

    // 组合 room.players (房间层面信息) 和 gameStateFromGameInstance (游戏层面信息)
    const combinedPlayers = room.players.map(roomPlayer => {
        const gamePlayerDetails = gameStateFromGameInstance?.players.find(gp => gp.id === roomPlayer.userId);
        return {
            userId: roomPlayer.userId,
            username: roomPlayer.username,
            slot: roomPlayer.slot,
            isReady: roomPlayer.isReady,        // 房间层面的准备状态
            connected: roomPlayer.connected,    // 房间层面的连接状态
            isAiControlled: roomPlayer.isAiControlled, // AI控制状态

            // 游戏相关属性，优先从 gameStateFromGameInstance 获取
            score: gamePlayerDetails?.score ?? roomPlayer.score ?? 0, // 玩家总分
            hand: (requestingUserId === roomPlayer.userId && gamePlayerDetails) ? gamePlayerDetails.hand : undefined, // 只有请求者能看到自己的手牌
            handCount: gamePlayerDetails?.handCount ?? 0,
            role: gamePlayerDetails?.role ?? null,
            finished: gamePlayerDetails?.finished ?? false,
        };
    });

    return {
        roomId: room.roomId,
        roomName: room.roomName,
        status: room.status,
        players: combinedPlayers,
        myUserId: requestingUserId, // 方便客户端识别自己
        hostId: room.creatorId,     // 房主ID (如果需要)

        // 游戏桌面和进程信息 (优先从 gameStateFromGameInstance 获取)
        centerPile: gameStateFromGameInstance?.centerPile ?? [],
        lastHandInfo: gameStateFromGameInstance?.lastHandInfo ?? null,
        currentPlayerId: gameStateFromGameInstance?.currentPlayerId ?? null,
        isFirstTurn: gameStateFromGameInstance?.isFirstTurn ?? (room.status === 'playing' && room.game ? room.game.firstTurn : false),
        gameMode: room.game ? room.game.gameMode : null,

        // 游戏开始/结束状态
        gameStarted: gameStateFromGameInstance?.gameStarted ?? (room.status === 'playing'),
        gameFinished: gameStateFromGameInstance?.gameFinished ?? (room.status === 'finished'),
        
        // 游戏结果
        gameResultText: gameStateFromGameInstance?.gameResultText ?? null,
        gameOverReason: gameStateFromGameInstance?.gameOverReason ?? null,
        finalScores: gameStateFromGameInstance?.finalScores ?? null,
        scoreChanges: gameStateFromGameInstance?.scoreChanges ?? null,
    };
}

// 添加玩家到房间 (或更新已存在玩家的信息)
function addPlayerToRoom(room, socket) {
    if (!room || !room.game || !socket || !socket.userId || !socket.username) {
        console.error("[RM ADD PLAYER] 参数无效:", { room:!!room, game:!!room?.game, socket:!!socket, userId:socket?.userId, username:socket?.username });
        return { success: false, message: "内部错误：玩家或房间数据不完整。" };
    }
    const maxPlayers = room.game.maxPlayers || 4;

    const existingPlayerInRoom = room.players.find(p => p.userId === socket.userId);
    if (existingPlayerInRoom) { // 玩家已在房间 players 列表 (可能是重连或重复加入请求)
        console.log(`[RM ADD PLAYER] ${socket.username} (ID: ${socket.userId}) 已在房间 ${room.roomId}。更新连接信息。`);
        existingPlayerInRoom.socketId = socket.id;
        existingPlayerInRoom.connected = true;
        existingPlayerInRoom.username = socket.username; // 同步名称
        if (room.game) { // 确保游戏实例中的状态也更新
            room.game.markPlayerConnected(socket.userId, true, existingPlayerInRoom.isAiControlled);
            const gamePlayer = room.game.players.find(gp => gp.id === socket.userId);
            if (gamePlayer) gamePlayer.name = socket.username;
        }
        return { success: true, player: existingPlayerInRoom, rejoining: true };
    }

    if (room.players.filter(p=>p.connected).length >= maxPlayers) {
        return { success: false, message: "房间已满。" };
    }

    // 分配座位
    const existingSlots = room.players.map(p => p.slot);
    let assignedSlot = -1;
    for (let i = 0; i < maxPlayers; i++) { if (!existingSlots.includes(i)) { assignedSlot = i; break; } }
    if (assignedSlot === -1) { return { success: false, message: "无法找到可用座位（可能已满或逻辑错误）。" }; }

    const playerInfo = {
        userId: socket.userId, username: socket.username, socketId: socket.id,
        isReady: false, slot: assignedSlot, connected: true, 
        score: 0, // 新加入玩家，房间内累计分数为0 (游戏实例会继承这个)
        isAiControlled: false // 默认为非AI
    };
    room.players.push(playerInfo);
    room.players.sort((a, b) => a.slot - b.slot); // 按座位排序

    // 将玩家添加到游戏实例中
    if (room.game) {
        // 如果游戏实例中没有这个玩家，则添加
        if (!room.game.players.some(p => p.id === playerInfo.userId)) {
            room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot);
            // room.game.players 的 score 会在 startGame 时基于 room.players 的 score 设置
        } else { // 如果已存在 (理论上不应在此分支，除非是异常状态恢复)
            room.game.markPlayerConnected(playerInfo.userId, true, playerInfo.isAiControlled);
        }
    }
    
    room.lastActivityTime = Date.now();
    console.log(`[RM ADD PLAYER] ${playerInfo.username} 加入房间 ${room.roomId}，座位 ${assignedSlot}.`);
    return { success: true, player: playerInfo, rejoining: false };
}

// 检查是否所有玩家都准备好并开始游戏
function checkAndStartGame(room) {
    if (!room || !ioInstance || room.status !== 'waiting' || !room.game) return false;

    const eligiblePlayers = room.players.filter(p => p.connected || p.isAiControlled);
    if (eligiblePlayers.length !== room.game.maxPlayers) return false;

    const allReady = eligiblePlayers.every(p => p.isReady || p.isAiControlled);
    if (!allReady) return false;

    console.log(`[RM START GAME] 所有 ${room.game.maxPlayers} 位玩家已准备完毕，房间 ${room.roomId} 开始游戏...`);

    // 准备传递给 game.startGame 的玩家信息，包含累计分数和AI状态
    const playerStartInfo = eligiblePlayers.map(p => ({
        id: p.userId, name: p.username, slot: p.slot,
        score: p.score || 0, // 从 room.players 中获取累计分数
        isAiControlled: p.isAiControlled
    })).sort((a, b) => a.slot - b.slot);

    const startGameResult = room.game.startGame(playerStartInfo); // Game 实例开始游戏
    if (startGameResult.success) {
        room.status = 'playing';
        room.lastActivityTime = Date.now();
        room.players.forEach(p => p.isReady = false); // 重置房间内玩家的准备状态，为下局做准备

        // 向每个玩家发送包含其手牌的 'gameStarted' 事件
        room.players.forEach(playerInRoom => {
            if (playerInRoom.socketId && (playerInRoom.connected || playerInRoom.isAiControlled)) {
                const playerSocket = ioInstance.sockets.sockets.get(playerInRoom.socketId);
                if (playerSocket) {
                    playerSocket.emit('gameStarted', getRoomStateForPlayer(room, playerInRoom.userId, true));
                }
            }
        });
        
        broadcastRoomList(); // 状态变为 'playing'，更新大厅列表
        console.log(`[RM START GAME] 房间 ${room.roomId} 游戏成功开始。`);
        return true;
    } else {
        console.error(`[RM START GAME] 房间 ${room.roomId} 游戏启动失败: ${startGameResult.message}`);
        ioInstance.to(room.roomId).emit('gameStartFailed', { message: startGameResult.message });
        // 游戏启动失败，可以考虑是否重置玩家的准备状态
        // room.players.forEach(p => p.isReady = false);
        // ioInstance.to(room.roomId).emit('allPlayersResetReady'); // 通知客户端取消准备
        return false;
    }
}

// 处理玩家离开房间 (主动离开或被踢)
function handlePlayerLeavingRoom(room, socket, reason = "left_voluntarily") {
    if (!room || !socket || !socket.userId) {
        console.warn(`[RM LEAVE] 参数无效。Room: ${!!room}, Socket: ${!!socket}, UserID: ${socket?.userId}`);
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    console.log(`[RM LEAVE] ${username} (Socket: ${socket.id}) 正在离开房间 ${room.roomId}. 原因: ${reason}`);

    const playerIndex = room.players.findIndex(p => p.userId === socket.userId);
    if (playerIndex === -1) {
        console.warn(`[RM LEAVE] ${username} 未在房间 ${room.roomId} 的玩家列表中。`);
        socket.leave(room.roomId); // 确保 socket 离开 Socket.IO 房间
        if (socket.roomId === room.roomId) delete socket.roomId;
        return;
    }
    
    const leavingPlayer = room.players.splice(playerIndex, 1)[0]; // 从房间玩家列表中移除
    if (room.game) { // 从游戏实例中也移除或标记
        room.game.removePlayer(socket.userId); // Game.removePlayer 会调用 markPlayerConnected(false)
    }

    socket.leave(room.roomId);
    if (socket.roomId === room.roomId) delete socket.roomId;

    if (ioInstance) {
        socket.to(room.roomId).emit('playerLeft', { userId: socket.userId, username: username, reason });
        // 向剩余玩家发送更新后的状态
        room.players.forEach(p => {
            if (p.connected && p.socketId) {
                const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (targetSocket) {
                    targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                }
            }
        });
    }
    room.lastActivityTime = Date.now();

    // 检查游戏是否应因玩家离开而结束
    if (room.game && room.game.gameStarted && !room.game.gameFinished) {
        const activePlayersInGame = room.game.players.filter(p => p.connected || p.isAiControlled).length; // Game 实例中的活跃玩家
        if (activePlayersInGame < 2 && room.players.length > 0) { // 少于2人无法继续 (除非是1人游戏规则)
            console.log(`[RM LEAVE] 房间 ${room.roomId} 因玩家离开导致人数不足 (${activePlayersInGame})，游戏结束。`);
            room.status = 'finished';
            const scoreResult = room.game.endGame('有玩家离开，游戏人数不足');
            ioInstance.to(room.roomId).emit('gameOver', scoreResult);
        } else if (room.game.currentPlayerId === socket.userId && !room.game.gameFinished) { // 如果离开的是当前玩家
            room.game.nextTurn(true); // 强制轮转
             room.players.forEach(p => { // 发送更新状态
                if (p.connected && p.socketId) ioInstance.sockets.sockets.get(p.socketId)?.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
            });
        }
    }
    
    // 检查房间是否应被删除
    if (room.players.length === 0) {
        console.log(`[RM LEAVE] 房间 ${room.roomId} (${room.roomName}) 已空，将被删除。`);
        delete activeGames[room.roomId];
    }
    broadcastRoomList();
}

// 处理 socket 断开连接事件
function handleDisconnect(socket) {
    if (!socket.userId) { /* console.log(`[RM DISCO] Socket ${socket.id} 断开 (无userId).`); */ return; }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    
    const room = findRoomByUserId(socket.userId); // 查找玩家所在的房间
    if (room) {
        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (playerInRoom) {
            // 只有当断开的 socket 是该玩家当前记录的 socketId 时才处理
            // 这可以防止旧标签页关闭导致的误判
            if (playerInRoom.socketId === socket.id || !playerInRoom.socketId) {
                console.log(`[RM DISCO] ${username} (Socket: ${socket.id}) 从房间 ${room.roomId} 断开.`);
                playerInRoom.connected = false;
                playerInRoom.isReady = false; // 断开连接则取消准备

                if (room.game) { // 通知游戏实例玩家已断开
                    room.game.markPlayerConnected(socket.userId, false, playerInRoom.isAiControlled);
                }
                
                if (ioInstance) {
                    ioInstance.to(room.roomId).emit('playerLeft', { userId: socket.userId, username: username, reason: 'disconnected' });
                    // 向房间内其他玩家广播状态更新
                    room.players.forEach(p => {
                        if (p.connected && p.socketId && p.userId !== socket.userId) {
                            const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                            if (targetSocket) targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                        }
                    });
                }
                room.lastActivityTime = Date.now();

                // 检查游戏是否应因玩家断开而结束 (逻辑同 handlePlayerLeavingRoom)
                if (room.game && room.game.gameStarted && !room.game.gameFinished) {
                    const activePlayersInGame = room.game.players.filter(p => p.connected || p.isAiControlled).length;
                    if (activePlayersInGame < 2 && room.players.filter(p => p.connected).length > 0) { // 如果游戏内活跃玩家少于2，且房间内还有其他连接玩家
                        console.log(`[RM DISCO] 房间 ${room.roomId} 因玩家 ${username} 断开导致人数不足 (${activePlayersInGame})，游戏结束。`);
                        room.status = 'finished';
                        const scoreResult = room.game.endGame('有玩家断线，游戏人数不足');
                        ioInstance.to(room.roomId).emit('gameOver', scoreResult);
                    } else if (room.game.currentPlayerId === socket.userId && !room.game.gameFinished) {
                         room.game.nextTurn(true); // 强制轮转
                         room.players.forEach(p => {
                            if (p.connected && p.socketId) ioInstance.sockets.sockets.get(p.socketId)?.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                        });
                    }
                }
                 // 如果房间内所有玩家都断开了 (且非游戏中)，则可以考虑归档房间 (由pruneInactiveRooms处理)
                const connectedPlayersInRoom = room.players.filter(p => p.connected).length;
                if (connectedPlayersInRoom === 0 && room.status !== 'playing') {
                     console.log(`[RM DISCO] 房间 ${room.roomId} (${room.roomName}) 所有玩家均已断开 (非游戏中). 将等待清理.`);
                }
            } else {
                console.log(`[RM DISCO] Socket ${socket.id} (${username})断开，但玩家在房间 ${room.roomId} 中记录的 socketId 为 ${playerInRoom.socketId}. 可能已通过新连接重连。`);
            }
        }
    }
    broadcastRoomList(); // 可能影响房间玩家数
}

// 处理玩家重新连接
function handleReconnect(socket, roomId) {
    const username = socket.username || `User ${socket.userId ? socket.userId.substring(0,6) : 'Anon'}`;
    console.log(`[RM RECONN] ${username} (Socket: ${socket.id}) 尝试重连房间 ${roomId}.`);
    try {
        const room = activeGames[roomId];
        if (!room) return { success: false, message: "尝试重连的房间已不存在。" };
        if (room.status === 'archived') return { success: false, message: "房间已关闭，无法重连。" };
        if (!room.game) {
            console.error(`[RM RECONN CRITICAL] 房间 ${roomId} 存在但游戏实例丢失!`);
            return { success: false, message: "房间数据已损坏。" };
        }

        const playerInRoomData = room.players.find(p => p.userId === socket.userId);
        if (!playerInRoomData) return { success: false, message: "您之前不在此房间中。" };

        // 如果旧的socket仍然存在于房间的Socket.IO room中，可以尝试让它离开
        if (playerInRoomData.socketId && playerInRoomData.socketId !== socket.id) {
            const oldSocketInstance = ioInstance?.sockets?.sockets?.get(playerInRoomData.socketId);
            if (oldSocketInstance) {
                console.log(`[RM RECONN] 发现玩家 ${username} 的旧Socket ${playerInRoomData.socketId}，令其离开房间 ${roomId}`);
                oldSocketInstance.leave(roomId);
                // oldSocketInstance.disconnect(true); // 也可以考虑直接断开旧连接
            }
        }
        
        playerInRoomData.connected = true;
        playerInRoomData.socketId = socket.id; // 更新为新的 socket
        playerInRoomData.username = socket.username; // 同步用户名

        if (room.game) { // 更新游戏实例中的连接状态
            room.game.markPlayerConnected(socket.userId, true, playerInRoomData.isAiControlled);
            const gamePlayer = room.game.players.find(p=>p.id === socket.userId);
            if(gamePlayer) gamePlayer.name = socket.username;
        }

        socket.join(roomId); // 将新的 socket 加入 Socket.IO 房间
        socket.roomId = roomId; // 在 socket 对象上记录当前房间ID
        room.lastActivityTime = Date.now();
        console.log(`[RM RECONN] ${username} 成功重连到房间 ${roomId}. 向房间广播更新。`);

        if (ioInstance) { //向房间内所有玩家（包括重连者）发送最新的完整状态
            room.players.forEach(p => {
                if (p.socketId) {
                    const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (targetSocket) {
                        targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                    }
                }
            });
             // 单独给重连的玩家再发一次 playerReconnected (可选，gameStateUpdate应该已足够)
            socket.emit('playerReconnected', { userId: playerInRoomData.userId, username: playerInRoomData.username });
        }
        broadcastRoomList(); // 玩家数可能在列表中变化
        return { success: true, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting') };
    } catch (error) {
        console.error(`[RM RECONN] 处理 ${username} 重连到房间 ${roomId} 时发生错误:`, error);
        return { success: false, message: `服务器内部错误: ${error.message}` };
    }
}

// 当 authManager 确认一个 socket 已认证后调用
function handleAuthentication(socket) {
    console.log(`[RM AUTH CB] Socket ${socket.id} (用户: ${socket.username}, ID: ${socket.userId}) 已通过认证.`);
    // 可以在这里做一些全局的、与房间无关的、认证后立即需要做的事
    // 例如，如果用户之前在某个房间，authManager 中的 login/reauth 逻辑会处理重连
    // 如果用户是新登录且不在任何房间，则简单地向其推送房间列表
    if (!findRoomByUserId(socket.userId)) {
        socket.emit('roomListUpdate', getPublicRoomList());
    }
}

// 定期清理不活跃或空房间
function pruneInactiveRooms() {
    const now = Date.now();
    let prunedCount = 0;
    for (const roomId in activeGames) {
        const room = activeGames[roomId];
        if (!room || room.status === 'archived') continue;

        const connectedPlayerCount = room.players.filter(p => p.connected).length;
        const timeSinceLastActivitySec = (now - (room.lastActivityTime || now)) / 1000;

        // 条件1: 房间内没有已连接的玩家，并且超过了玩家重连窗口时间 (给足时间让断线玩家重连)
        // 条件2: 房间长时间不活跃 (例如，即使有“断开”的玩家记录，但很久没人活动了)
        if ((connectedPlayerCount === 0 && timeSinceLastActivitySec > PLAYER_RECONNECT_WINDOW_SECONDS * 1.5) || // 给重连窗口多一点余地
            (timeSinceLastActivitySec > ROOM_TTL_SECONDS)) {
            
            console.log(`[RM PRUNE] 清理房间 ${roomId} (${room.roomName}). 连接数: ${connectedPlayerCount}, 不活跃时长: ${timeSinceLastActivitySec.toFixed(0)}s.`);
            if (room.game && typeof room.game.endGame === 'function' && room.game.gameStarted && !room.game.gameFinished) {
                console.log(`[RM PRUNE] 房间 ${roomId} 内游戏正在进行，将强制结束。`);
                const scoreResult = room.game.endGame(`房间因长时间无活动或空置而被服务器清理。`);
                if (ioInstance) {
                    ioInstance.to(room.roomId).emit('gameOver', scoreResult);
                }
                // 将游戏实例中的最终分数同步回 room.players
                room.players.forEach(rp => {
                    const gp = room.game.players.find(g => g.id === rp.userId);
                    if (gp) rp.score = gp.score;
                });
            }
            room.status = 'archived'; // 标记为已归档，而不是立即删除，方便日志或分析
            
            // 强制房间内所有 (可能残留的) socket 离开
            if(ioInstance) {
                const socketsInIoRoom = ioInstance.sockets.adapter.rooms.get(roomId);
                if (socketsInIoRoom) {
                    socketsInIoRoom.forEach(socketIdInRoom => {
                        const lingeringSocket = ioInstance.sockets.sockets.get(socketIdInRoom);
                        if(lingeringSocket) {
                            console.log(`[RM PRUNE] 令残留的 socket ${socketIdInRoom} 离开已归档房间 ${roomId}`);
                            lingeringSocket.leave(roomId);
                            // lingeringSocket.disconnect(true); // 也可以考虑直接断开
                        }
                    });
                }
            }
            prunedCount++;
        }
    }
    if (prunedCount > 0) {
        console.log(`[RM PRUNE] 本轮清理了 ${prunedCount} 个不活跃/空房间。`);
        broadcastRoomList(); // 因为可能有房间从列表中消失
    }
}
// 每隔一段时间运行清理函数 (例如，每5分钟)
setInterval(pruneInactiveRooms, 5 * 60 * 1000);


// 初始化 socket 的房间和游戏相关事件监听器
function init(socket, ioMainInstance) {
    if (!ioInstance && ioMainInstance) ioInstance = ioMainInstance; // 保存 Socket.IO 服务器实例
    if (!socket) { console.error("[RM INIT] 传入的 socket 为 null。"); return; }

    // 创建房间
    socket.on('createRoom', (data, callback) => {
        if (typeof callback !== 'function') { console.error("[RM createRoom] 缺少回调函数。"); return; }
        if (!socket.userId) return callback({ success: false, message: '请先登录才能创建房间。' });
        
        console.log(`[RM EVENT createRoom] 用户 ${socket.username} (ID: ${socket.userId}) 请求创建房间. 数据:`, data);
        try {
            const { roomName, password } = data;
            if (findRoomByUserId(socket.userId)) {
                return callback({ success: false, message: '您已在其他房间中。请先离开原房间。' });
            }
            if (!roomName || roomName.trim().length === 0 || roomName.trim().length > 10) { // 假设房间名1-10字符
                return callback({ success: false, message: '房间名必须为1-10个字符。' });
            }
            
            let newRoomId = generateRoomId(); let attempts = 0;
            while (activeGames[newRoomId] && attempts < 10) { newRoomId = generateRoomId(); attempts++; } // 尝试生成唯一ID
            if (activeGames[newRoomId]) return callback({ success: false, message: "创建房间失败，请稍后再试 (ID冲突)。"});
            
            const game = new Game(newRoomId, 4); // 默认4人游戏
            const newRoom = {
                roomId: newRoomId, roomName: roomName.trim(), password: password || null,
                game: game, players: [], status: 'waiting', creatorId: socket.userId,
                lastActivityTime: Date.now()
            };
            activeGames[newRoomId] = newRoom;

            const addCreatorResult = addPlayerToRoom(newRoom, socket); // 将创建者加入房间
            if (!addCreatorResult.success) {
                delete activeGames[newRoomId]; // 如果加入失败，清理房间
                return callback({ success: false, message: `创建房间时加入失败: ${addCreatorResult.message}` });
            }
            socket.join(newRoomId); // socket 加入 Socket.IO room
            socket.roomId = newRoomId; // 在 socket 对象上记录当前房间ID
            // newRoom.players[0].isReady = false; // 房主默认不准备 (您之前的版本有此逻辑，可选)

            callback({ success: true, roomId: newRoomId, roomState: getRoomStateForPlayer(newRoom, socket.userId, false) });
            broadcastRoomList(); // 广播房间列表更新
            console.log(`[RM EVENT createRoom] 房间 "${newRoom.roomName}" (ID: ${newRoomId}) 由 ${socket.username} 创建成功。`);
        } catch (error) {
            console.error(`[RM EVENT createRoom] 创建房间时发生异常:`, error);
            callback({ success: false, message: '服务器创建房间时发生内部错误。' });
        }
    });

    // 加入房间
    socket.on('joinRoom', (data, callback) => {
        if (typeof callback !== 'function') { console.error("[RM joinRoom] 缺少回调函数。"); return; }
        if (!socket.userId) return callback({ success: false, message: '请先登录才能加入房间。' });
        
        const { roomId, password: joinPassword } = data;
        console.log(`[RM EVENT joinRoom] 用户 ${socket.username} (ID: ${socket.userId}) 请求加入房间 ${roomId}. 密码提供情况: ${!!joinPassword}`);
        try {
            const room = activeGames[roomId];
            if (!room || room.status === 'archived') return callback({ success: false, message: '房间不存在或已关闭。' });
            if (!room.game) { console.error(`[RM joinRoom CRITICAL] 房间 ${roomId} 存在但游戏实例丢失!`); return callback({ success: false, message: '房间数据似乎已损坏。'});}
            
            const currentRoomOfPlayer = findRoomByUserId(socket.userId); // 检查玩家是否已在其他房间
            if (currentRoomOfPlayer && currentRoomOfPlayer.roomId !== roomId) {
                return callback({ success: false, message: '您已在另一个房间中。请先离开原房间才能加入新房间。' });
            }
            
            const playerAlreadyInThisRoom = room.players.find(p => p.userId === socket.userId);
            if (playerAlreadyInThisRoom) { // 玩家已在此房间 (可能是刷新页面或重连)
                 if (!playerAlreadyInThisRoom.connected) { // 如果记录为未连接，则走重连逻辑
                    console.log(`[RM joinRoom] 玩家 ${socket.username} 尝试重连房间 ${roomId}`);
                    const reconnResult = handleReconnect(socket, roomId);
                    return callback(reconnResult); 
                 } else { // 已连接，可能是重复加入请求 (例如开了两个标签页)
                    console.log(`[RM joinRoom] 玩家 ${socket.username} 已连接在房间 ${roomId}，更新socket信息。`);
                    playerAlreadyInThisRoom.socketId = socket.id; // 更新为新的socket
                    socket.join(roomId); socket.roomId = roomId;
                    return callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'), message: "您已在此房间中。" });
                 }
            }

            // 新玩家加入
            if (room.status !== 'waiting') return callback({ success: false, message: '游戏已开始或结束，无法加入。' });
            if (room.players.filter(p => p.connected).length >= (room.game.maxPlayers || 4)) return callback({ success: false, message: '房间已满。' });
            if (room.password && room.password !== joinPassword) return callback({ success: false, message: '房间密码错误。' });

            const addResult = addPlayerToRoom(room, socket);
            if (addResult.success && addResult.player) {
                socket.join(roomId); socket.roomId = roomId;
                room.lastActivityTime = Date.now();
                
                const {socketId, ...playerJoinedInfoForBroadcast} = addResult.player; // 移除敏感信息
                socket.to(roomId).emit('playerJoined', playerJoinedInfoForBroadcast); // 通知房间内其他玩家
                
                // 向房间内所有玩家发送更新后的完整状态
                room.players.forEach(p => {
                    if (p.socketId && ioInstance.sockets.sockets.get(p.socketId)) {
                         ioInstance.sockets.sockets.get(p.socketId).emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, false));
                    }
                });

                callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId, false) });
                broadcastRoomList();
                // checkAndStartGame(room); // 游戏开始由玩家准备状态决定，不在此处自动开始
            } else { callback({ success: false, message: addResult.message || "加入房间时发生内部错误。" }); }
        } catch (error) { console.error(`[RM EVENT joinRoom] 加入房间时发生异常:`, error); callback({ success: false, message: '服务器加入房间时发生内部错误。' }); }
    });

    // 玩家准备/取消准备
    socket.on('playerReady', (isReady, callback) => {
        if (typeof callback !== 'function') { console.error("[RM playerReady] 缺少回调函数。"); return; }
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "未找到玩家或房间信息。" });
        
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: "房间不存在或已损坏。" });
        if (room.status !== 'waiting') return callback({ success: false, message: "游戏已开始或结束，无法更改准备状态。" });

        const player = room.players.find(p => p.userId === socket.userId);
        if (!player) return callback({ success: false, message: "未在此房间找到您。" });
        if (player.isAiControlled) return callback({ success: false, message: "AI托管中，无法手动更改准备状态。" });

        player.isReady = !!isReady; // 强制转换为布尔值
        room.lastActivityTime = Date.now();
        console.log(`[RM EVENT playerReady] 玩家 ${socket.username} 在房间 ${socket.roomId} 设置准备状态为: ${player.isReady}`);

        ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: socket.userId, isReady: player.isReady });
        callback({ success: true });
        checkAndStartGame(room); // 每次有玩家更新准备状态后，都检查是否可以开始游戏
    });

    // 玩家出牌
    socket.on('playCard', (cards, callback) => {
        if (typeof callback !== 'function') { console.error("[RM playCard] 缺少回调函数。"); return; }
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "未找到玩家或房间信息。" });
        
        const room = activeGames[socket.roomId];
        if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
            return callback({ success: false, message: "游戏未开始、已结束或房间无效。" });
        }
        if (!Array.isArray(cards)) return callback({success: false, message: '无效的卡牌数据格式。'});
        
        const result = room.game.playCard(socket.userId, cards);
        if (result.success) {
            room.lastActivityTime = Date.now();
            // 向房间内所有玩家广播最新的游戏状态
            room.players.forEach(p => {
                if (p.socketId && (p.connected || p.isAiControlled)) { // 也给AI"发送"状态（如果AI有独立socket client）
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            });

            if (result.gameOver) {
                console.log(`[RM EVENT playCard] 游戏在房间 ${room.roomId} 结束. 结果:`, result.scoreResult.result);
                // 将游戏实例中的最终分数同步回 room.players
                room.players.forEach(rp => {
                    const gp = room.game.players.find(g => g.id === rp.userId);
                    if (gp) rp.score = gp.score; // 更新累计分数
                });
                room.status = 'finished'; // 更新房间状态
                ioInstance.to(socket.roomId).emit('gameOver', result.scoreResult); // 广播游戏结束事件
                broadcastRoomList(); // 更新大厅列表
            }
            callback({success: true}); // 响应出牌操作本身成功
        } else {
            // 出牌失败，只通知当前操作的玩家
            socket.emit('invalidPlay', { message: result.message }); // 使用 'invalidPlay' 或自定义错误事件
            callback({success: false, message: result.message});
        }
    });

    // 玩家Pass
    socket.on('passTurn', (callback) => {
        if (typeof callback !== 'function') { console.error("[RM passTurn] 缺少回调函数。"); return; }
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "未找到玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
            return callback({ success: false, message: "游戏未开始、已结束或房间无效。" });
        }

        const result = room.game.handlePass(socket.userId);
        if (result.success) {
            room.lastActivityTime = Date.now();
            room.players.forEach(p => {
                if (p.socketId && (p.connected || p.isAiControlled)) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            });
            callback({success: true});
        } else {
            socket.emit('invalidPlay', { message: result.message });
            callback({success: false, message: result.message});
        }
    });

    // 请求提示
    socket.on('requestHint', (clientHintIndex, callback) => {
        if (typeof callback !== 'function') { console.error("[RM requestHint] 缺少回调函数。"); return; }
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "未找到玩家或房间信息。" });
        const room = activeGames[socket.roomId];
        if (!room || !room.game || !room.game.gameStarted || room.game.gameFinished) {
            return callback({ success: false, message: "游戏未开始、已结束或房间无效。" });
        }
        const result = room.game.findHint(socket.userId, clientHintIndex || 0); // 如果客户端未传索引，默认为0
        callback(result); // result 包含 { success, hint?, message?, nextHintIndex }
    });
    
    // 离开房间
    socket.on('leaveRoom', (callback) => {
        if (typeof callback !== 'function') { console.error("[RM leaveRoom] 缺少回调函数。"); return; }
        if (!socket.userId || !socket.roomId) { // socket.roomId 可能已被清除
            const playerRoom = findRoomByUserId(socket.userId); // 尝试通过 userId 再次查找
            if (playerRoom) {
                console.log(`[RM EVENT leaveRoom] socket.roomId 未设置, 但通过 userId 找到玩家在房间 ${playerRoom.roomId}`);
                socket.roomId = playerRoom.roomId; // 恢复roomId以进行处理
            } else {
                return callback({ success: false, message: "未找到玩家或房间信息。" });
            }
        }
        const room = activeGames[socket.roomId];
        if (!room) return callback({ success: false, message: "您当前不在任何房间中或房间已解散。" });

        handlePlayerLeavingRoom(room, socket, "voluntary_leave");
        callback({ success: true, message: "已成功离开房间。" });
    });

    // 请求当前游戏状态 (例如，重连后或视图切换时)
    socket.on('requestGameState', (callback) => {
        if (typeof callback !== 'function') { console.error("[RM requestGameState] 缺少回调函数。"); return; }
        if (!socket.userId || !socket.roomId) return callback(null); // 或者返回错误对象
        
        const room = activeGames[socket.roomId];
        if (!room) return callback(null);
        callback(getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'));
    });

    // 切换AI托管状态
    socket.on('toggleAI', (enableAI, callback) => {
        if (typeof callback !== 'function') { console.error("[RM toggleAI] 缺少回调函数。"); return; }
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: "未找到玩家或房间信息。" });

        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: "房间不存在或已损坏。" });

        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (!playerInRoom) return callback({ success: false, message: "未在此房间找到您。" });

        playerInRoom.isAiControlled = !!enableAI;
        room.game.setPlayerAI(socket.userId, !!enableAI); // 更新游戏实例中的AI状态
        
        // 如果开启AI且之前是准备状态，则取消准备 (AI不需要手动准备)
        if (playerInRoom.isAiControlled && playerInRoom.isReady && room.status === 'waiting') {
            playerInRoom.isReady = false;
            ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: socket.userId, isReady: false });
        }
        
        room.lastActivityTime = Date.now();
        console.log(`[RM EVENT toggleAI] 玩家 ${socket.username} AI托管状态设置为: ${playerInRoom.isAiControlled}`);

        // 向房间内所有玩家广播状态更新
        room.players.forEach(p => {
            if (p.socketId && (p.connected || p.isAiControlled)) {
                const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (playerSocket) playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
            }
        });
        callback({ success: true, isAiEnabled: playerInRoom.isAiControlled });

        // 如果AI被激活且轮到该玩家，AI应自动行动 (这部分逻辑可能较复杂，需要AI决策模块)
        if (playerInRoom.isAiControlled && room.game.gameStarted && !room.game.gameFinished &&
            room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
            console.log(`[AI TRIGGER] AI 为 ${socket.username} 激活且是其回合。 (AI行动逻辑应在此触发)`);
            // 示例: triggerAIPlay(room.game, socket.userId, ioInstance);
        }
    });

    // 客户端首次连接或进入大厅时请求房间列表
    socket.on('listRooms', (callback) => {
        if (typeof callback === 'function') {
            callback(getPublicRoomList());
        } else { // 如果客户端不提供回调，则直接用事件推送
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
    getRoomById // 导出以便 server.js 中的 sendVoiceMessage 使用
};
