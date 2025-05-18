// roomManager.js
const { Game } = require('./game');
const crypto = require('crypto');

let activeGames = {}; // Stores room objects: { roomId: roomObject, ... }
let ioInstance; // To store the io object from server.js

function generateRoomId() {
    return crypto.randomBytes(3).toString('hex'); // 6-char hex string
}

function init(socket, io) {
    if (!ioInstance) ioInstance = io;

    socket.on('createRoom', (data, callback) => {
        if (!socket.userId) {
            console.error("[ROOM CREATE] Error: User not logged in for socket.", socket.id);
            return callback({ success: false, message: '请先登录才能创建房间。' });
        }
        const { roomName, password } = data;

        console.log(`[ROOM CREATE ATTEMPT] User: ${socket.username} (ID: ${socket.userId}), RoomName: "${roomName}", Password provided: ${!!password}`);

        if (!roomName || typeof roomName !== 'string' || roomName.trim().length === 0) {
            console.warn("[ROOM CREATE] Invalid room name from user:", socket.username, "Name:", roomName);
            return callback({ success: false, message: '需要有效的房间名称。' });
        }
        if (password && (typeof password !== 'string' || password.length > 20)) {
            console.warn("[ROOM CREATE] Invalid password format for room:", roomName, "User:", socket.username);
            return callback({ success: false, message: '密码格式无效 (最多20字符)。' });
        }

        let roomId = generateRoomId();
        let attempts = 0;
        const MAX_ID_GEN_ATTEMPTS = 20; // Increased attempts slightly
        while(activeGames[roomId] && attempts < MAX_ID_GEN_ATTEMPTS) {
            console.log(`[ROOM CREATE] Room ID ${roomId} exists, generating new one. Attempt: ${attempts + 1}`);
            roomId = generateRoomId();
            attempts++;
        }
        if (activeGames[roomId]) {
             console.error("[ROOM CREATE] Failed to generate unique Room ID after", MAX_ID_GEN_ATTEMPTS, "attempts.");
             return callback({success: false, message: "创建房间失败，服务器繁忙，请稍后再试。"});
        }

        console.log(`[ROOM CREATE] Generated new Room ID: ${roomId} for "${roomName}"`);
        const game = new Game(roomId, 4);
        const newRoom = {
            roomId: roomId,
            roomName: roomName.trim(),
            password: (password && password.trim().length > 0) ? password.trim() : null,
            creatorId: socket.userId,
            players: [], // Will be populated by addPlayerToRoom
            game: game,
            status: 'waiting'
        };

        activeGames[roomId] = newRoom;
        console.log(`[ROOM CREATED] Room: "${newRoom.roomName}" (ID: ${roomId}, Pwd: ${newRoom.password ? 'Yes' : 'No'}) by ${socket.username}`);

        const joinResult = addPlayerToRoom(newRoom, socket); // Creator joins the room
        if (joinResult.success) {
            socket.join(roomId); // Socket.IO join
            socket.roomId = roomId; // Store roomId on socket for future reference
            
            console.log(`[ROOM CREATE] Creator ${socket.username} successfully added to room ${roomId}.`);
            
            // Get the initial state for the creator
            const initialStateForCreator = getRoomStateForPlayer(newRoom, socket.userId, false); // isGameUpdate = false for initial state
            console.log(`[ROOM CREATE] Initial state for creator ${socket.username}:`, JSON.stringify(initialStateForCreator, null, 2).substring(0, 500) + "..."); // Log part of the state


            callback({ success: true, roomId: roomId, roomState: initialStateForCreator });
            broadcastRoomList();
        } else {
            console.error(`[ROOM CREATE] Critical error: Failed to add creator ${socket.username} to their own room ${roomId}. Deleting room. Reason: ${joinResult.message}`);
            delete activeGames[roomId]; // Clean up if creator can't join
            callback({ success: false, message: `创建房间后加入失败: ${joinResult.message}` });
        }
    });

    socket.on('joinRoom', (data, callback) => {
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
         const { roomId, password } = data;
         const room = activeGames[roomId];

         console.log(`[ROOM JOIN ATTEMPT] User: ${socket.username}, RoomID: ${roomId}, Pwd provided: ${!!password}`);

         if (!room) {
            console.warn(`[ROOM JOIN] Room ${roomId} not found for user ${socket.username}`);
            return callback({ success: false, message: '房间不存在。' });
         }

         const existingPlayer = room.players.find(p => p.userId === socket.userId);
         if (existingPlayer) {
            if (!existingPlayer.connected) { // Player is in room.players but disconnected
                console.log(`[ROOM JOIN] Player ${socket.username} is rejoining room ${roomId} (was disconnected).`);
                const reconnectResult = handleReconnect(socket, roomId); // Use handleReconnect logic
                if (reconnectResult.success) {
                    callback({ success: true, roomId: roomId, roomState: reconnectResult.roomState });
                } else {
                    callback({ success: false, message: reconnectResult.message });
                }
            } else { // Player is already in room.players and connected (e.g. opening new tab)
                 console.log(`[ROOM JOIN] Player ${socket.username} already connected in room ${roomId}. Re-syncing socket.`);
                 socket.join(roomId); // Ensure socket is in the Socket.IO room
                 socket.roomId = roomId;
                 // Update socket ID for the player if it changed (e.g. new tab, old socket might still be lingering)
                 existingPlayer.socketId = socket.id;
                 existingPlayer.connected = true; // Mark as connected again

                 callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'), message: "您已在此房间中。" });
            }
            return;
         }

         if (room.status !== 'waiting') {
            console.warn(`[ROOM JOIN] Room ${roomId} not in 'waiting' state (is ${room.status}). User ${socket.username} cannot join.`);
            return callback({ success: false, message: '游戏已开始或已结束，无法加入。' });
         }
         if (room.players.length >= 4) {
            console.warn(`[ROOM JOIN] Room ${roomId} is full. User ${socket.username} cannot join.`);
            return callback({ success: false, message: '房间已满。' });
         }
         if (room.password && room.password !== password) {
            console.warn(`[ROOM JOIN] Incorrect password for room ${roomId} by user ${socket.username}.`);
            return callback({ success: false, message: '房间密码错误。' });
         }

         const joinResult = addPlayerToRoom(room, socket);
         if (joinResult.success) {
             socket.join(roomId);
             socket.roomId = roomId;
             console.log(`[ROOM JOINED] Player ${socket.username} joined room "${room.roomName}" (${roomId})`);
             // Send only necessary info for 'playerJoined', sensitive data like hand is sent via getRoomStateForPlayer to the joining player
             const playerJoinedInfo = { 
                userId: joinResult.player.userId, 
                username: joinResult.player.username, 
                slot: joinResult.player.slot,
                isReady: joinResult.player.isReady, // Send initial ready state
                connected: true, // They just connected
                score: joinResult.player.score || 0, // Send current score
                handCount: 0 // They have 0 cards initially before game start
             };
             socket.to(roomId).emit('playerJoined', playerJoinedInfo);
             callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId, false) });
             broadcastRoomList();
         } else {
             console.error(`[ROOM JOIN] Failed to add player ${socket.username} to room ${roomId}. Reason: ${joinResult.message}`);
             callback({ success: false, message: joinResult.message });
         }
    });

    socket.on('listRooms', (callback) => {
        const roomList = getPublicRoomList();
        // console.log("[ROOM LIST] Sending room list:", roomList);
         if (typeof callback === 'function') {
            callback(roomList);
         }
     });

    socket.on('playerReady', (isReady, callback) => {
         if (!socket.userId || !socket.roomId) {
            console.warn("[PLAYER READY] Invalid op: no userId or roomId. Socket:", socket.id);
            return callback({ success: false, message: '无效操作。' });
         }
         const room = activeGames[socket.roomId];
         if (!room) {
            console.warn("[PLAYER READY] Room not found:", socket.roomId, "User:", socket.username);
            return callback({success: false, message: "房间信息丢失。"});
        }
         if (room.status !== 'waiting') {
            console.warn("[PLAYER READY] Room not in 'waiting' state:", socket.roomId, "User:", socket.username);
            return callback({ success: false, message: '不在等待中的房间内。' });
        }

         const player = room.players.find(p => p.userId === socket.userId);
         if (!player) {
            console.error("[PLAYER READY] Player data not found in room:", socket.roomId, "User ID:", socket.userId);
            return callback({ success: false, message: '玩家数据异常。' });
        }

         player.isReady = !!isReady; // Ensure boolean
         console.log(`[ROOM ${socket.roomId}] Player ${player.username} readiness updated: ${player.isReady}`);

         ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: player.userId, isReady: player.isReady });
         checkAndStartGame(room); // This should handle starting the game if all are ready
         if(typeof callback === 'function') callback({ success: true }); // Always callback
    });

    socket.on('playCard', (cards, callback) => {
        // ... (playCard logic - unchanged, ensure logging is present)
    });

    socket.on('passTurn', (callback) => {
        // ... (passTurn logic - unchanged, ensure logging is present)
    });

    socket.on('requestHint', (currentHintIndex, callback) => {
        // ... (requestHint logic - unchanged, ensure logging is present)
    });

    socket.on('leaveRoom', (callback) => {
        // ... (leaveRoom logic - unchanged, ensure logging is present)
    });

    socket.on('requestGameState', (callback) => {
         if (!socket.userId || !socket.roomId) {
             console.log(`[REQUEST GAME STATE] Invalid: No userId or roomId for socket ${socket.id}`);
             if (typeof callback === 'function') callback(null);
             return;
         }
         const room = activeGames[socket.roomId];
         if (room && typeof callback === 'function') {
             console.log(`[REQUEST GAME STATE] Sending state for room ${socket.roomId} to ${socket.username}`);
             callback(getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'));
         } else if (typeof callback === 'function') {
             console.log(`[REQUEST GAME STATE] Room ${socket.roomId} not found for ${socket.username}.`);
             callback(null);
         }
     });

    socket.on('audioChunk', (audioChunk) => { /* ... (unchanged) ... */ });
    socket.on('playerStartSpeaking', () => { /* ... (unchanged) ... */ });
    socket.on('playerStopSpeaking', () => { /* ... (unchanged) ... */ });
} // End of init function

function addPlayerToRoom(room, socket) {
    if (room.players.length >= 4) {
        console.warn(`[ADD PLAYER] Room ${room.roomId} is full. Cannot add ${socket.username}`);
        return { success: false, message: "房间已满。" };
    }

    // Find the first available slot (0 to 3)
    const existingSlots = room.players.map(p => p.slot);
    let assignedSlot = -1;
    for (let i = 0; i < 4; i++) {
        if (!existingSlots.includes(i)) {
            assignedSlot = i;
            break;
        }
    }
    if (assignedSlot === -1) { // Should not happen if length < 4
        console.error(`[ADD PLAYER] Critical: No available slot in room ${room.roomId} for ${socket.username}, though player count is ${room.players.length}.`);
        return { success: false, message: "无法找到可用位置。" };
    }

    const playerInfo = {
        userId: socket.userId,
        username: socket.username,
        socketId: socket.id,
        isReady: false, // New players are not ready by default
        slot: assignedSlot,
        connected: true,
        score: 0 // Assuming new players start with 0 score for the session
    };
    room.players.push(playerInfo);
    // Sort players by slot for consistent order, though game logic might handle its own player array.
    room.players.sort((a, b) => a.slot - b.slot);

    if (room.game) {
        // Add player to the game instance as well. This is important.
        room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot);
    }
    console.log(`[ADD PLAYER] Player ${playerInfo.username} (ID: ${playerInfo.userId}) added to room ${room.roomId}, assigned to slot ${assignedSlot}`);
    return { success: true, player: playerInfo };
}

function checkAndStartGame(room) {
     if (room.status !== 'waiting') {
        // console.log(`[CHECK START GAME] Room ${room.roomId} is not in 'waiting' state (is ${room.status}). Skipping start check.`);
        return;
     }

     const connectedPlayers = room.players.filter(p => p.connected);
     const readyPlayers = connectedPlayers.filter(p => p.isReady);

     console.log(`[CHECK START GAME] Room ${room.roomId}: Connected=${connectedPlayers.length}, Ready=${readyPlayers.length}`);

     // Game typically needs 4 players
     if (connectedPlayers.length === 4 && readyPlayers.length === 4) {
         console.log(`[GAME STARTING] Room ${room.roomId}: All 4 connected players are ready. Starting game...`);
         room.status = 'playing'; // Update room status

         // Prepare player info for game.startGame
         const playerStartInfo = connectedPlayers.map(p => ({
             id: p.userId,
             name: p.username,
             slot: p.slot
             // score could be passed if game.js needs to preserve it across rounds
         }));

         const startResult = room.game.startGame(playerStartInfo);

         if (startResult.success) {
             console.log(`[GAME STARTED] Game in room ${room.roomId} started successfully.`);
             // Send personalized 'gameStarted' event with initial hand to each player
             room.players.forEach(playerInRoom => {
                 if (playerInRoom.connected && playerInRoom.socketId) {
                     const playerSocket = ioInstance.sockets.sockets.get(playerInRoom.socketId);
                     if (playerSocket) {
                         const initialStateForPlayer = getRoomStateForPlayer(room, playerInRoom.userId, true); // isGameUpdate = true
                         playerSocket.emit('gameStarted', initialStateForPlayer);
                         console.log(`[GAME STARTED] Sent 'gameStarted' to ${playerInRoom.username} (ID: ${playerInRoom.userId}) in room ${room.roomId}`);
                     } else {
                         console.warn(`[GAME STARTED] Could not find socket for player ${playerInRoom.username} (SocketID: ${playerInRoom.socketId}) in room ${room.roomId}.`);
                     }
                 }
             });
             broadcastRoomList(); // Update lobby that room is now 'playing'
         } else {
             console.error(`[GAME START FAILED] Room ${room.roomId}: Game.startGame failed: ${startResult.message}`);
             room.status = 'waiting'; // Revert status
             ioInstance.to(room.roomId).emit('gameStartFailed', { message: startResult.message || "服务器内部错误导致游戏启动失败。" });
             // Reset ready status for all players in this room so they have to ready up again
             room.players.forEach(p => p.isReady = false);
             ioInstance.to(room.roomId).emit('allPlayersResetReady'); // Inform clients to uncheck ready
         }
     } else {
        // console.log(`[CHECK START GAME] Room ${room.roomId}: Conditions not met to start. Connected: ${connectedPlayers.length}/4, Ready: ${readyPlayers.length}/4`);
     }
}

function getRoomStateForPlayer(room, requestingUserId, isGameUpdate = false) {
    // console.log(`[GET ROOM STATE] For user ${requestingUserId} in room ${room.roomId}. isGameUpdate: ${isGameUpdate}`);
    // console.log(`[GET ROOM STATE] Room object:`, JSON.stringify(room, (key, value) => (key === 'game' ? '[Game Object]' : value), 2).substring(0,300) + "...");


    const gameState = (isGameUpdate || room.status === 'playing' || room.status === 'finished') && room.game
        ? room.game.getStateForPlayer(requestingUserId) // This should give hand for requestingPlayerId
        : null;
    
    // if (gameState) console.log(`[GET ROOM STATE] gameState for ${requestingUserId}:`, JSON.stringify(gameState, null, 2).substring(0,300) + "...");
    // else console.log(`[GET ROOM STATE] No gameState available or needed for ${requestingUserId}. Room status: ${room.status}`);


    const combinedPlayers = room.players.map(roomPlayer => {
        const gamePlayerInfoFromGameState = gameState ? gameState.players.find(gp => gp.id === roomPlayer.userId) : null;
        let handForThisPlayer;
        let handCountForThisPlayer;

        if (gamePlayerInfoFromGameState) { // Game has started and provided state
            handForThisPlayer = gamePlayerInfoFromGameState.hand; // This is already correctly undefined for others by game.js
            handCountForThisPlayer = gamePlayerInfoFromGameState.handCount;
        } else if (room.game && room.game.players.find(p=>p.id === roomPlayer.userId)) { // Game exists but gameState not used (e.g. 'waiting' state)
            const gamePlayer = room.game.players.find(p=>p.id === roomPlayer.userId);
            handCountForThisPlayer = gamePlayer ? gamePlayer.hand.length : 0;
            // In 'waiting' state, hand should not be sent unless it's the requesting user AND we intend to show pre-dealt cards (unlikely)
            handForThisPlayer = (roomPlayer.userId === requestingUserId && room.status === 'waiting' /* and some other condition? */) ? [] : undefined;
        } else { // No game or player not in game instance yet
            handCountForThisPlayer = 0;
            handForThisPlayer = undefined;
        }


        return {
            userId: roomPlayer.userId,
            username: roomPlayer.username,
            slot: roomPlayer.slot,
            isReady: roomPlayer.isReady, // Crucial for waiting room
            connected: roomPlayer.connected,
            score: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.score : (roomPlayer.score || 0),
            // Hand is only for the requesting player if game state provides it
            hand: handForThisPlayer,
            handCount: handCountForThisPlayer,
            // isCurrentPlayer and role come from game state if available
            isCurrentPlayer: gameState ? gameState.currentPlayerId === roomPlayer.userId : false,
            role: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.role : null,
            finished: gamePlayerInfoFromGameState ? gamePlayerInfoFromGameState.finished : false
        };
    });

    return {
        roomId: room.roomId,
        roomName: room.roomName,
        status: room.status, // e.g., 'waiting', 'playing', 'finished'
        players: combinedPlayers,
        // Game-specific state, only if game is active or just finished
        centerPile: gameState?.centerPile ?? [],
        lastHandInfo: gameState?.lastHandInfo ?? null,
        currentPlayerId: gameState?.currentPlayerId ?? null,
        isFirstTurn: gameState?.isFirstTurn ?? (room.status === 'playing' ? true : false), // Default isFirstTurn if playing
        myUserId: requestingUserId, // So client knows who they are in the list
        gameMode: room.game ? room.game.gameMode : null,
        // Fields from game.js getStateForPlayer
        gameResultText: gameState?.gameResultText,
        gameOverReason: gameState?.gameOverReason,
        finalScores: gameState?.finalScores,
        scoreChanges: gameState?.scoreChanges
    };
}

function handleDisconnect(socket) { /* ... (unchanged, ensure logging and player.isReady = false) ... */ }
function findRoomByUserId(userId) { /* ... (unchanged) ... */ }
function handleReconnect(socket, roomId) { /* ... (unchanged, ensure logging) ... */ }
function getPublicRoomList() { /* ... (unchanged) ... */ }
function broadcastRoomList() { /* ... (unchanged) ... */ }
function handleAuthentication(socket) { /* ... (unchanged) ... */ }


module.exports = {
    init,
    handleDisconnect,
    handleAuthentication,
    getPublicRoomList,
    findRoomByUserId,
    handleReconnect // Make sure this is exported if used elsewhere (e.g. authManager)
};
