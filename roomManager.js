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
     // Ensure room.game exists before trying to access its properties
    const gameExists = !!room.game;
    const gameState = (isGameUpdate || room.status === 'playing' || room.status === 'finished') && gameExists
        ? room.game.getStateForPlayer(requestingUserId)
        : null;

    const combinedPlayers = room.players.map(roomPlayer => {
        const gamePlayerInfoFromGameState = gameState && gameState.players ? gameState.players.find(gp => gp.id === roomPlayer.userId) : null;

        let handForThisPlayer = undefined;
        let handCountForThisPlayer = roomPlayer.handCount || 0; // Default to 0 if not available
        
        if (gamePlayerInfoFromGameState) {
            handForThisPlayer = gamePlayerInfoFromGameState.hand;
            handCountForThisPlayer = gamePlayerInfoFromGameState.handCount;
        } else if (gameExists && room.game.players && roomPlayer.userId === requestingUserId) {
            const internalPlayer = room.game.players.find(p => p.id === roomPlayer.userId);
            if (internalPlayer) {
                 handForThisPlayer = internalPlayer.hand;
                 handCountForThisPlayer = internalPlayer.hand.length;
            }
        } else if (gameExists && room.game.players) { // For other players, just get hand count if possible
            const internalPlayer = room.game.players.find(p => p.id === roomPlayer.userId);
            if (internalPlayer) {
                handCountForThisPlayer = internalPlayer.hand.length;
            }
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
            role: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.role : (gameExists && room.game.playerRoles ? room.game.playerRoles[roomPlayer.userId] : roomPlayer.role),
            finished: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.finished : roomPlayer.finished,
            isAiControlled: roomPlayer.isAiControlled || (gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.isAiControlled : false)
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
        gameMode: gameExists ? room.game.gameMode : null,
        gameResultText: gameState?.gameResultText, // Ensure these come from gameState
        gameOverReason: gameState?.gameOverReason,
        finalScores: gameState?.finalScores,
        scoreChanges: gameState?.scoreChanges,
        gameFinished: gameState?.gameFinished ?? (room.status === 'finished'), // derive from gameState or room status
        gameStarted: gameState?.gameStarted ?? (room.status === 'playing') // derive
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
    const existingPlayer = room.players.find(p => p.userId === socket.userId);

    if (existingPlayer) {
        console.warn(`[ADD PLAYER] Player ${socket.username} (ID: ${socket.userId}) already in room ${room.roomId}. Updating info.`);
        existingPlayer.socketId = socket.id;
        existingPlayer.connected = true;
        existingPlayer.username = socket.username;
        // Ensure player is also marked connected in game.players
        const gamePlayer = room.game.players.find(p => p.id === socket.userId);
        if (gamePlayer) gamePlayer.connected = true;

        return { success: true, player: existingPlayer, rejoining: true };
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
        isAiControlled: false,
        handCount: 0, // Initialize handCount
        role: null, // Initialize role
        finished: false // Initialize finished
    };
    room.players.push(playerInfo);
    room.players.sort((a, b) => a.slot - b.slot);

    const gameAddResult = room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot);
    if (!gameAddResult) {
        console.warn(`[ADD PLAYER] Game.addPlayer for ${playerInfo.username} in room ${room.roomId} returned false. This might be okay if player already existed in game instance (e.g. rejoining and game player obj was persisted).`);
        if (!room.game.players.some(p => p.id === playerInfo.userId)) {
            console.error(`[ADD PLAYER] CRITICAL: Game.addPlayer failed AND player ${playerInfo.username} not found in game.players array for room ${room.roomId}. Cleaning up.`);
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
     const readyConnectedPlayers = connectedPlayers.filter(p => p.isReady);
     const requiredPlayers = room.game ? (room.game.maxPlayers || 4) : 4;

     console.log(`[CHECK START GAME] Room ${room.roomId}: TotalInRoom=${room.players.length}, Connected=${connectedPlayers.length}, ReadyAndConnected=${readyConnectedPlayers.length}, Required=${requiredPlayers}`);
     
     if (connectedPlayers.length === requiredPlayers && readyConnectedPlayers.length === requiredPlayers) {
         console.log(`[GAME STARTING] Room ${room.roomId}: All ${requiredPlayers} connected players are ready. Attempting start...`);
         
         if (!room.game) {
             console.error(`[CHECK START GAME] CRITICAL: room.game is null for room ${room.roomId}. Cannot start.`);
             room.status = 'waiting'; 
             ioInstance.to(room.roomId).emit('gameStartFailed', { message: "服务器内部错误：游戏对象丢失。" });
             return;
         }
         
         // Ensure players in playerStartInfo are sorted by slot, as game.startGame might expect this order
         const playerStartInfo = connectedPlayers
            .map(p => ({ id: p.userId, name: p.username, slot: p.slot, score: p.score || 0 }))
            .sort((a,b) => a.slot - b.slot);

         const startResult = room.game.startGame(playerStartInfo);
         if (startResult.success) {
             room.status = 'playing'; // Set status AFTER successful game start
             console.log(`[GAME STARTED] Game in room ${room.roomId} started successfully by Game instance.`);
             // Update room.players with roles from game instance
             room.players.forEach(rp => {
                 const gamePlayer = room.game.players.find(gp => gp.id === rp.userId);
                 if (gamePlayer) {
                     rp.role = gamePlayer.role;
                     rp.isAiControlled = gamePlayer.isAiControlled || false; // Sync AI state
                 }
             });

             room.players.forEach(pInRoom => {
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
             room.status = 'waiting'; // Keep status as waiting
             ioInstance.to(room.roomId).emit('gameStartFailed', { message: startResult.message || "游戏启动失败，请检查服务器日志。" });
             // Unready all players as game start failed
             ioInstance.to(room.roomId).emit('allPlayersResetReady');
             room.players.forEach(p => { p.isReady = false; });
         }
     } else { console.log(`[CHECK START GAME] Room ${room.roomId}: Conditions not met. (Connected: ${connectedPlayers.length}/${requiredPlayers}, Ready: ${readyConnectedPlayers.length}/${requiredPlayers})`); }
}


function handlePlayerLeavingRoom(room, socket, reason = "left") {
    if (!room || !socket || !socket.userId) {
        console.warn(`[LEAVE ROOM] Invalid parameters for handlePlayerLeavingRoom. Room: ${room?room.roomId:'N/A'}, Socket: ${socket?socket.id:'N/A'}`);
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    console.log(`[LEAVE ROOM] Player ${username} (Socket: ${socket.id}) is leaving room ${room.roomId}. Reason: ${reason}`);

    const playerIndexInRoom = room.players.findIndex(p => p.userId === socket.userId);
    if (playerIndexInRoom === -1) {
        console.warn(`[LEAVE ROOM] Player ${username} not found in room.players list for room ${room.roomId}. Already left or inconsistent state.`);
        return; // Player not found in room's list
    }

    // Remove player from room.players
    const leavingPlayer = room.players.splice(playerIndexInRoom, 1)[0];
    console.log(`[LEAVE ROOM] Player ${username} removed from room.players in ${room.roomId}.`);

    // If game instance exists, mark player as disconnected or remove
    if (room.game) {
        const playerInGame = room.game.players.find(p => p.id === socket.userId);
        if (playerInGame) {
            if (room.status === 'playing' || room.status === 'finished') {
                // In an ongoing/finished game, just mark as disconnected.
                // The game logic or AI might take over, or scores might be fixed.
                playerInGame.connected = false;
                console.log(`[LEAVE ROOM] Marked player ${username} as disconnected in game instance of room ${room.roomId}.`);
            } else {
                // If game is 'waiting', player can be fully removed from game instance too.
                room.game.players = room.game.players.filter(p => p.id !== socket.userId);
                console.log(`[LEAVE ROOM] Player ${username} removed from game instance players list in room ${room.roomId} (status: ${room.status}).`);
            }
        }
    }

    // Make socket leave the Socket.IO room channel
    socket.leave(room.roomId);
    if (socket.roomId === room.roomId) { // Clear current room from socket
        socket.roomId = null;
    }
    console.log(`[LEAVE ROOM] Socket ${socket.id} left Socket.IO channel for room ${room.roomId}.`);

    // Notify other players in the room
    if (ioInstance) {
        ioInstance.to(room.roomId).emit('playerLeft', { userId: socket.userId, username: username });

        // Send updated game state to remaining players
        room.players.forEach(p => {
            if (p.connected && p.socketId) {
                const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (targetSocket) {
                    targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
                }
            }
        });
        console.log(`[LEAVE ROOM] Emitted 'playerLeft' and 'gameStateUpdate' to remaining players in room ${room.roomId}.`);
    }

    // If room becomes empty and game not actively playing, or specific conditions met, clean up room
    if (room.players.length === 0 && room.status !== 'playing') { // Don't delete active games immediately
        console.log(`[LEAVE ROOM] Room ${room.roomId} is now empty and not playing. Deleting room.`);
        if (room.game && typeof room.game.endGame === 'function' && room.game.gameStarted) {
             room.game.endGame("Room empty"); // Formally end game if started
        }
        delete activeGames[room.roomId];
    } else if (room.status === 'waiting') {
        // If game was waiting and a player leaves, reset ready status of others if game cannot start
        const connectedPlayers = room.players.filter(p => p.connected);
        const requiredPlayers = room.game ? (room.game.maxPlayers || 4) : 4;
        if (connectedPlayers.length < requiredPlayers) {
            let unreadied = false;
            room.players.forEach(p => {
                if (p.isReady) {
                    p.isReady = false;
                    unreadied = true;
                }
            });
            if (unreadied && ioInstance) {
                ioInstance.to(room.roomId).emit('allPlayersResetReady');
                console.log(`[LEAVE ROOM] Not enough players to start in room ${room.roomId}, unreadied all.`);
            }
        }
    }
    broadcastRoomList(); // Update public list
}

function handleDisconnect(socket) {
    if (!socket || !socket.userId) {
        console.log(`[DISCONNECT] Socket ${socket ? socket.id : 'UNKNOWN'} disconnected without full authentication or userId.`);
        return;
    }
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    console.log(`[DISCONNECT] Handling disconnect for user ${username} (Socket: ${socket.id})`);

    const room = findRoomByUserId(socket.userId);
    if (room) {
        console.log(`[DISCONNECT] User ${username} was in room ${room.roomId}.`);
        const playerInRoom = room.players.find(p => p.userId === socket.userId);
        if (playerInRoom) {
            playerInRoom.connected = false;
            playerInRoom.socketId = null; // Important: clear socketId
            console.log(`[DISCONNECT] Marked player ${username} as disconnected in room.players for ${room.roomId}.`);

            if (room.game) {
                const gamePlayer = room.game.players.find(gp => gp.id === socket.userId);
                if (gamePlayer) {
                    gamePlayer.connected = false; // Mark as disconnected in game instance as well
                    console.log(`[DISCONNECT] Marked player ${username} as disconnected in game.players for ${room.roomId}.`);
                }
            }
            
            // If game is 'waiting', and player was ready, unready them
            if (room.status === 'waiting' && playerInRoom.isReady) {
                playerInRoom.isReady = false;
                if (ioInstance) {
                    ioInstance.to(room.roomId).emit('playerReadyUpdate', { userId: playerInRoom.userId, isReady: false });
                    console.log(`[DISCONNECT] Unreadied player ${username} in room ${room.roomId} due to disconnect.`);
                }
            }

            if (ioInstance) {
                // Notify other players that this player's connection status changed
                // A 'playerLeft' might be too strong if they can reconnect.
                // A 'gameStateUpdate' is more appropriate to reflect the 'connected: false' status.
                room.players.forEach(p => {
                    if (p.connected && p.socketId) { // Send to other connected players
                        const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                        if (targetSocket) {
                            const updatedRoomState = getRoomStateForPlayer(room, p.userId, room.status !== 'waiting');
                            targetSocket.emit('gameStateUpdate', updatedRoomState);
                        }
                    }
                });
                 console.log(`[DISCONNECT] Sent gameStateUpdate to other players in room ${room.roomId} after ${username} disconnected.`);
            }
        } else {
            console.warn(`[DISCONNECT] User ${username} was associated with room ${room.roomId} (via findRoomByUserId) but not found in room.players list.`);
        }

        // Check if room should be cleaned up (e.g., all players disconnected and game not resumable)
        const connectedPlayersInRoom = room.players.filter(p => p.connected);
        if (connectedPlayersInRoom.length === 0 && room.status !== 'playing') {
            console.log(`[DISCONNECT] Room ${room.roomId} has no connected players and is not 'playing'. Removing room.`);
            if (room.game && typeof room.game.endGame === 'function' && room.game.gameStarted) {
                room.game.endGame("All players disconnected");
            }
            delete activeGames[room.roomId];
        }
        broadcastRoomList(); // Update player count in public list
    } else {
        console.log(`[DISCONNECT] User ${username} was not in any active room upon disconnect.`);
    }
}

function handleReconnect(socket, roomId) {
    const username = socket.username || `User ${socket.userId.substring(0,6)}`;
    console.log(`[RECONNECT] Attempting to handle reconnect for ${username} (Socket: ${socket.id}) to room ${roomId}.`);

    const room = activeGames[roomId];
    if (!room) {
        console.warn(`[RECONNECT] Failed for ${username}: Room ${roomId} not found.`);
        return { success: false, message: "房间不存在，无法重连。" };
    }
    if (!room.game) {
        console.error(`[RECONNECT] CRITICAL for ${username}: Room ${roomId} exists but room.game is null!`);
        return { success: false, message: "房间数据损坏，无法重连。" };
    }

    const playerInRoomList = room.players.find(p => p.userId === socket.userId);
    if (!playerInRoomList) {
        console.warn(`[RECONNECT] Player ${username} not found in room.players list for room ${roomId}. Cannot reconnect.`);
        // This implies the player was fully removed, not just marked disconnected. Treat as new join if allowed.
        // For now, fail reconnect. If they try to "join" again, it might work if room is 'waiting'.
        return { success: false, message: "您已不在该房间中，请重新加入。" };
    }

    // Player is in room.players, mark as connected and update socket ID
    playerInRoomList.connected = true;
    playerInRoomList.socketId = socket.id;
    playerInRoomList.username = socket.username; // Update username in case it changed (unlikely)

    // Also update in game.players
    const playerInGameInstance = room.game.players.find(p => p.id === socket.userId);
    if (playerInGameInstance) {
        playerInGameInstance.connected = true;
        playerInGameInstance.name = socket.username; // Sync name
    } else {
        // This case is problematic: player in room.players but not game.players.
        // This might happen if game removed them but roomManager didn't.
        // For robust reconnect, might need to re-add to game instance if game is 'waiting'.
        // If 'playing', it's more complex.
        console.warn(`[RECONNECT] Player ${username} found in room.players but NOT in room.game.players for room ${roomId}. State might be inconsistent.`);
        // For now, we'll proceed but this indicates a potential earlier issue in leave/disconnect handling.
    }
    
    socket.join(roomId);
    socket.roomId = roomId;
    console.log(`[RECONNECT] Player ${username} reconnected to room ${roomId}. SocketId updated, joined channel.`);

    // Notify all players in the room (including the reconnected one) with the latest state
    if (ioInstance) {
        room.players.forEach(p => {
            if (p.connected && p.socketId) {
                const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                if (targetSocket) {
                    targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                }
            }
        });
         console.log(`[RECONNECT] Sent gameStateUpdate to all players in room ${roomId} after ${username} reconnected.`);
    }
    
    broadcastRoomList(); // Player count might change in public view

    return { success: true, roomState: getRoomStateForPlayer(room, socket.userId, true) };
}

// This function is usually called by authManager after successful authentication/reauthentication
// to let roomManager know that a socket is now associated with a userId.
function handleAuthentication(socket) {
    if (socket && socket.userId) {
        console.log(`[ROOM MANAGER AUTH] Socket ${socket.id} authenticated as User ${socket.username || socket.userId}.`);
        // You could potentially try to auto-rejoin them to a room if they were in one and disconnected
        // but reauthenticate in authManager already handles this.
        // This function is more for roomManager to be aware.
    } else {
        console.warn(`[ROOM MANAGER AUTH] handleAuthentication called with unauthenticated socket or missing userId. Socket: ${socket?socket.id:'N/A'}`);
    }
}


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
            const { roomName, password } = data;
            const creatorUsername = socket.username;

            const existingRoomForUser = findRoomByUserId(socket.userId);
            if (existingRoomForUser) {
                console.warn(`[ROOM CREATE] Failed for ${creatorUsername}: User already in room ${existingRoomForUser.roomId}.`);
                return callback({ success: false, message: `您已在房间 ${existingRoomForUser.roomName} 中，请先离开。` });
            }

            if (!roomName || typeof roomName !== 'string' || roomName.trim().length === 0 || roomName.length > 10) {
                console.warn(`[ROOM CREATE] Failed for ${creatorUsername}: Invalid room name "${roomName}".`);
                return callback({ success: false, message: '房间名称无效 (1-10字符)。' });
            }
            const trimmedRoomName = roomName.trim();

            let newRoomId = generateRoomId();
            while (activeGames[newRoomId]) {
                newRoomId = generateRoomId();
            }
            console.log(`[ROOM CREATE] Generated new Room ID: ${newRoomId} for name "${trimmedRoomName}" by ${creatorUsername}`);

            const gameInstance = new Game(newRoomId, 4); // Default 4 players

            const newRoom = {
                roomId: newRoomId,
                roomName: trimmedRoomName,
                password: password || null,
                game: gameInstance,
                players: [],
                status: 'waiting',
                hostId: socket.userId
            };
            activeGames[newRoomId] = newRoom;
            console.log(`[ROOM CREATE] New room object created and stored for ID: ${newRoomId}`);

            console.log(`[ROOM CREATE] Attempting to add creator ${creatorUsername} (Socket: ${socket.id}) to new room ${newRoomId}`);
            const addCreatorResult = addPlayerToRoom(newRoom, socket);

            if (!addCreatorResult.success) {
                console.error(`[ROOM CREATE] CRITICAL: Failed to add creator ${creatorUsername} to room ${newRoomId}. Message: ${addCreatorResult.message}`);
                delete activeGames[newRoomId]; // Clean up
                return callback({ success: false, message: `创建房间失败：无法将您添加到房间 (${addCreatorResult.message})` });
            }
            console.log(`[ROOM CREATE] Creator ${creatorUsername} added successfully to room ${newRoomId}.`);

            socket.join(newRoomId);
            socket.roomId = newRoomId;
            console.log(`[ROOM CREATE] Creator ${creatorUsername} (Socket: ${socket.id}) joined Socket.IO room channel ${newRoomId}`);

            const roomStateForCreator = getRoomStateForPlayer(newRoom, socket.userId, false);
            if (typeof callback === 'function') {
                console.log(`[ROOM CREATE] Sending success callback to ${creatorUsername} for ${newRoomId}`);
                callback({ success: true, roomId: newRoomId, roomState: roomStateForCreator });
            } else {
                console.warn(`[ROOM CREATE] No callback provided by client ${creatorUsername} for room ${newRoomId}`);
            }

            broadcastRoomList();
            console.log(`[ROOM CREATE] Room "${trimmedRoomName}" (ID: ${newRoomId}) created successfully by ${creatorUsername}.`);

        } catch (error) {
            console.error(`[ROOM CREATE] UNHANDLED CRITICAL ERROR for user ${socket.username || socket.id}, room attempt "${data.roomName || 'N/A'}":`, error.message, error.stack);
            if (typeof callback === 'function') {
                callback({ success: false, message: '创建房间时服务器发生严重内部错误。' });
            }
        }
    });

    socket.on('joinRoom', (data, callback) => {
        const { roomId, password: joinPassword } = data; // Renamed password to joinPassword to avoid conflict
        const requestingUsername = socket.username || socket.id;

        console.log(`[EVENT joinRoom] Received from ${requestingUsername} for room: ${roomId}. Password provided: ${!!joinPassword}`);
        
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
            console.log(`[JOIN ROOM] Room ${roomId} found. Status: ${room.status}, Players: ${room.players.length}/${room.game.maxPlayers || 4}, Has Pwd: ${!!room.password}`);

            const existingPlayerInRoomObject = room.players.find(p => p.userId === socket.userId);
            if (existingPlayerInRoomObject) {
                // Player is already conceptually in the room (in room.players list)
                if (!existingPlayerInRoomObject.connected) {
                    console.log(`[JOIN ROOM] Player ${requestingUsername} (ID: ${socket.userId}) is rejoining room ${roomId} (was disconnected).`);
                    const reconnectResult = handleReconnect(socket, roomId);
                    if (reconnectResult.success) {
                        console.log(`[JOIN ROOM] Reconnect successful for ${requestingUsername} to room ${roomId}.`);
                        return callback({ success: true, roomId: roomId, roomState: reconnectResult.roomState });
                    } else {
                        console.warn(`[JOIN ROOM] Reconnect failed for ${requestingUsername} to room ${roomId}: ${reconnectResult.message}`);
                        return callback({ success: false, message: reconnectResult.message });
                    }
                } else { 
                    console.log(`[JOIN ROOM] Player ${requestingUsername} (ID: ${socket.userId}) already connected in room ${roomId}. Updating socket ID if different.`);
                    if (existingPlayerInRoomObject.socketId !== socket.id) {
                        existingPlayerInRoomObject.socketId = socket.id;
                    }
                    socket.join(roomId); 
                    socket.roomId = roomId;
                    const currentState = getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting');
                    return callback({ success: true, roomId: roomId, roomState: currentState, message: "您已在此房间中。" });
                }
            }

            // New player trying to join for the first time
            if (room.status !== 'waiting') {
                console.warn(`[JOIN ROOM] Failed for ${requestingUsername} to join ${roomId}: Room not in 'waiting' state (is ${room.status}).`);
                return callback({ success: false, message: '游戏已开始或已结束，无法加入。' });
            }

            const maxPlayers = room.game.maxPlayers || 4;
            if (room.players.length >= maxPlayers) {
                console.warn(`[JOIN ROOM] Failed for ${requestingUsername} to join ${roomId}: Room is full (${room.players.length}/${maxPlayers}).`);
                return callback({ success: false, message: '房间已满。' });
            }

            if (room.password && room.password !== joinPassword) {
                console.warn(`[JOIN ROOM] Failed for ${requestingUsername} to join ${roomId}: Incorrect password. Expected: '${room.password}', Got: '${joinPassword}'`);
                return callback({ success: false, message: '房间密码错误。' });
            }

            console.log(`[JOIN ROOM] Attempting to add ${requestingUsername} to room ${roomId} via addPlayerToRoom.`);
            const addResult = addPlayerToRoom(room, socket);
            console.log(`[JOIN ROOM] addPlayerToRoom result for ${requestingUsername}:`, JSON.stringify(addResult));

            if (addResult.success && addResult.player) { // Ensure player object exists
                socket.join(roomId);
                socket.roomId = roomId; 
                console.log(`[JOIN ROOM] Player ${requestingUsername} successfully joined Socket.IO room ${roomId}.`);

                const playerJoinedInfo = {
                    userId: addResult.player.userId, username: addResult.player.username,
                    slot: addResult.player.slot, isReady: addResult.player.isReady,
                    connected: true, score: addResult.player.score || 0,
                    handCount: addResult.player.handCount || 0, 
                    isAiControlled: addResult.player.isAiControlled || false,
                    role: addResult.player.role || null,
                    finished: addResult.player.finished || false
                };
                
                socket.to(roomId).emit('playerJoined', playerJoinedInfo);
                console.log(`[JOIN ROOM] Emitted 'playerJoined' to room ${roomId} for new player ${playerJoinedInfo.username}.`);
                
                const roomStateForJoiningPlayer = getRoomStateForPlayer(room, socket.userId, false);
                callback({ success: true, roomId: roomId, roomState: roomStateForJoiningPlayer });
                broadcastRoomList();
                checkAndStartGame(room); // Check if game can start after new player joins
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
    
    socket.on('playerReady', (isReady, callback) => {
        const username = socket.username || socket.id;
        console.log(`[EVENT playerReady] Received from ${username} for room ${socket.roomId}. New ready state: ${isReady}`);
        try {
            if (!socket.userId || !socket.roomId) {
                return callback({ success: false, message: '无效操作：未认证或不在房间内。' });
            }
            const room = activeGames[socket.roomId];
            if (!room) {
                return callback({ success: false, message: '房间不存在。' });
            }
            if (room.status !== 'waiting') {
                return callback({ success: false, message: '游戏已开始或结束，无法更改准备状态。' });
            }
            const player = room.players.find(p => p.userId === socket.userId);
            if (!player) {
                return callback({ success: false, message: '玩家不在房间内。' });
            }
            if (!player.connected) {
                return callback({ success: false, message: '您已断线，无法设置准备。'});
            }

            player.isReady = !!isReady; // Ensure boolean
            console.log(`[PLAYER READY] Player ${username} in room ${socket.roomId} set ready status to: ${player.isReady}`);
            
            if(ioInstance) ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: socket.userId, isReady: player.isReady });
            callback({ success: true });
            checkAndStartGame(room);
        } catch (error) {
            console.error(`[PLAYER READY] Error for ${username} in room ${socket.roomId}:`, error);
            callback({ success: false, message: '服务器内部错误。' });
        }
    });

    socket.on('playCard', (cards, callback) => {
        const username = socket.username || socket.id;
        console.log(`[EVENT playCard] Received from ${username} in room ${socket.roomId}. Cards:`, cards ? cards.map(c=>c.rank+c.suit) : 'null/undefined');
        try {
            if (!socket.userId || !socket.roomId) return callback({ success: false, message: '未认证或不在房间内。' });
            const room = activeGames[socket.roomId];
            if (!room || !room.game) return callback({ success: false, message: '房间或游戏不存在。' });
            if (room.status !== 'playing' || room.game.gameFinished) return callback({ success: false, message: '游戏未开始或已结束。' });
            
            const playerInRoom = room.players.find(p => p.userId === socket.userId);
            if (playerInRoom && playerInRoom.isAiControlled) {
                return callback({ success: false, message: 'AI托管中，无法手动操作。'});
            }

            const result = room.game.playCard(socket.userId, cards);
            console.log(`[PLAY CARD] Game.playCard result for ${username}:`, result);

            if (result.success) {
                callback({ success: true });
                // Update all players with new game state
                room.players.forEach(p => {
                    if (p.connected && p.socketId) {
                        const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                        if (targetSocket) {
                             const currentRoomStateForPlayer = getRoomStateForPlayer(room, p.userId, true);
                             if (result.gameOver) { // If game over, include final results
                                 const scoreInfo = result.scoreResult || room.game.endGame("Game finished by play"); // endGame might be redundant if playCard handles it
                                 currentRoomStateForPlayer.gameResultText = scoreInfo.result;
                                 currentRoomStateForPlayer.finalScores = scoreInfo.finalScores;
                                 currentRoomStateForPlayer.scoreChanges = scoreInfo.scoreChanges;
                                 currentRoomStateForPlayer.gameOverReason = scoreInfo.reason || "游戏正常结束";
                                 currentRoomStateForPlayer.gameFinished = true; // Ensure flag is set
                                 targetSocket.emit('gameOver', currentRoomStateForPlayer); // Specific event for game over
                             } else {
                                 targetSocket.emit('gameStateUpdate', currentRoomStateForPlayer);
                             }
                        }
                    }
                });
                if (result.gameOver) {
                    room.status = 'finished'; // Update room status
                    broadcastRoomList(); // Update public list (e.g. to show finished)
                }
            } else {
                callback({ success: false, message: result.message });
                // Optionally send an 'invalidPlay' event to the player
                socket.emit('invalidPlay', { message: result.message });
            }
        } catch (error) {
            console.error(`[PLAY CARD] Error for ${username} in room ${socket.roomId}:`, error);
            callback({ success: false, message: '服务器内部错误。' });
        }
    });

    socket.on('passTurn', (callback) => {
        const username = socket.username || socket.id;
        console.log(`[EVENT passTurn] Received from ${username} in room ${socket.roomId}.`);
        try {
            if (!socket.userId || !socket.roomId) return callback({ success: false, message: '未认证或不在房间内。' });
            const room = activeGames[socket.roomId];
            if (!room || !room.game) return callback({ success: false, message: '房间或游戏不存在。' });
            if (room.status !== 'playing' || room.game.gameFinished) return callback({ success: false, message: '游戏未开始或已结束。' });

            const playerInRoom = room.players.find(p => p.userId === socket.userId);
            if (playerInRoom && playerInRoom.isAiControlled) {
                return callback({ success: false, message: 'AI托管中，无法手动操作。'});
            }

            const result = room.game.handlePass(socket.userId);
             console.log(`[PASS TURN] Game.handlePass result for ${username}:`, result);

            if (result.success) {
                callback({ success: true });
                // Update all players with new game state
                room.players.forEach(p => {
                    if (p.connected && p.socketId) {
                        const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                        if (targetSocket) {
                            targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                        }
                    }
                });
            } else {
                callback({ success: false, message: result.message });
                 socket.emit('invalidPlay', { message: result.message }); // Use invalidPlay for pass errors too
            }
        } catch (error) {
            console.error(`[PASS TURN] Error for ${username} in room ${socket.roomId}:`, error);
            callback({ success: false, message: '服务器内部错误。' });
        }
    });
    
    socket.on('requestHint', (currentHintCycleIndex, callback) => {
        const username = socket.username || socket.id;
        console.log(`[EVENT requestHint] Received from ${username} in room ${socket.roomId}. currentHintCycleIndex: ${currentHintCycleIndex}`);
        try {
            if (!socket.userId || !socket.roomId) return callback({ success: false, message: '未认证或不在房间内。' });
            const room = activeGames[socket.roomId];
            if (!room || !room.game) return callback({ success: false, message: '房间或游戏不存在。' });
            if (room.status !== 'playing' || room.game.gameFinished) return callback({ success: false, message: '游戏未开始或已结束。' });
            
            const playerInRoom = room.players.find(p => p.userId === socket.userId);
            if (playerInRoom && playerInRoom.isAiControlled) {
                return callback({ success: false, message: 'AI托管中，无法请求提示。'});
            }

            const hintResult = room.game.findHint(socket.userId, currentHintCycleIndex || 0);
            console.log(`[REQUEST HINT] Hint result for ${username}:`, hintResult);
            callback(hintResult); // Send hint directly back to requesting client
        } catch (error) {
            console.error(`[REQUEST HINT] Error for ${username} in room ${socket.roomId}:`, error);
            callback({ success: false, message: '服务器内部错误。' });
        }
    });

    socket.on('leaveRoom', (callback) => {
        const username = socket.username || socket.id;
        console.log(`[EVENT leaveRoom] Received from ${username} for room ${socket.roomId}.`);
        try {
            if (!socket.userId || !socket.roomId) {
                return callback({ success: false, message: '无效操作：未认证或未在房间中。' });
            }
            const room = activeGames[socket.roomId];
            if (!room) {
                console.warn(`[LEAVE ROOM] User ${username} tried to leave room ${socket.roomId}, but room not found.`);
                // Still acknowledge, client might be out of sync
                socket.roomId = null; // Clear their local room association
                return callback({ success: true, message: '您已不在任何房间中。' });
            }
            
            handlePlayerLeavingRoom(room, socket, "user_request");

            if (typeof callback === 'function') callback({ success: true });
        } catch (error) {
            console.error(`[LEAVE ROOM] Error for ${username} in room ${socket.roomId}:`, error);
            if (typeof callback === 'function') callback({ success: false, message: '服务器内部错误。' });
        }
    });

    socket.on('requestGameState', (callback) => {
        const username = socket.username || socket.id;
        console.log(`[EVENT requestGameState] Received from ${username} for room ${socket.roomId}.`);
        try {
            if (!socket.userId || !socket.roomId) {
                if (typeof callback === 'function') callback(null); // No state if not in room
                return;
            }
            const room = activeGames[socket.roomId];
            if (!room) {
                if (typeof callback === 'function') callback(null); // Room doesn't exist
                return;
            }
            if (typeof callback === 'function') {
                callback(getRoomStateForPlayer(room, socket.userId, true));
            }
        } catch (error) {
            console.error(`[REQUEST GAME STATE] Error for ${username} in room ${socket.roomId}:`, error);
            if (typeof callback === 'function') callback(null);
        }
    });
    
    socket.on('toggleAI', ({ enabled }, callback) => {
        const username = socket.username || socket.id;
        const desiredAiState = !!enabled; // Ensure boolean
        console.log(`[EVENT toggleAI] Received from ${username} in room ${socket.roomId}. Enable AI: ${desiredAiState}`);
        try {
            if (!socket.userId || !socket.roomId) {
                return callback({ success: false, message: '未认证或不在房间内。' });
            }
            const room = activeGames[socket.roomId];
            if (!room || !room.game) {
                return callback({ success: false, message: '房间或游戏不存在。' });
            }
            // Allow toggling AI in 'waiting' or 'playing' states, but not if game is 'finished'
            if (room.status === 'finished' || room.game.gameFinished) {
                return callback({ success: false, message: '游戏已结束，无法切换AI状态。' });
            }

            const playerInRoomList = room.players.find(p => p.userId === socket.userId);
            const playerInGameInstance = room.game.players.find(p => p.id === socket.userId);

            if (!playerInRoomList || !playerInGameInstance) {
                return callback({ success: false, message: '玩家数据未找到，无法切换AI。' });
            }
            if (!playerInRoomList.connected || !playerInGameInstance.connected) {
                return callback({ success: false, message: '您已断线，无法切换AI状态。'});
            }
            if (room.status === 'playing' && playerInGameInstance.finished) {
                return callback({ success: false, message: '您已出完牌，无法切换AI状态。'});
            }

            playerInRoomList.isAiControlled = desiredAiState;
            playerInGameInstance.isAiControlled = desiredAiState;
            console.log(`[TOGGLE AI] Player ${username} in room ${socket.roomId} AI state set to: ${desiredAiState}`);

            callback({ success: true, message: `AI托管已${desiredAiState ? '开启' : '关闭'}` });

            // Notify all players about the change via gameStateUpdate
            room.players.forEach(p => {
                if (p.connected && p.socketId) {
                    const targetSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (targetSocket) {
                        targetSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                    }
                }
            });

            // If AI is enabled and it's this player's turn, potentially trigger AI action
            if (desiredAiState && room.status === 'playing' && room.game.currentPlayerId === socket.userId && !playerInGameInstance.finished) {
                console.log(`[AI] AI activated for ${username}'s turn. Triggering AI play.`);
                // Placeholder for AI move logic
                // setTimeout(() => roomManager.triggerAiPlay(room.roomId, socket.userId), 500); 
            }

        } catch (error) {
            console.error(`[TOGGLE AI] Error for ${username} in room ${socket.roomId}:`, error);
            callback({ success: false, message: '服务器内部错误。' });
        }
    });


    console.log(`[ROOM MANAGER] Event listeners fully set up for socket ${socket.id}`);
}


module.exports = {
    init,
    handleDisconnect,
    handleAuthentication,
    getPublicRoomList,
    findRoomByUserId,
    handleReconnect,
    getRoomById // Exported for server.js voice message handler
};
