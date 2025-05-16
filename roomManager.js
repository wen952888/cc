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

    // --- Create Room ---
    socket.on('createRoom', (data, callback) => {
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
        const { roomName, password } = data;
        if (!roomName || typeof roomName !== 'string' || roomName.trim().length === 0) {
            return callback({ success: false, message: '需要有效的房间名称。' });
        }
        if (password && (typeof password !== 'string' || password.length > 20)) { // Basic validation
            return callback({ success: false, message: '密码格式无效 (最多20字符)。' });
        }

        let roomId = generateRoomId();
        let attempts = 0;
        while(activeGames[roomId] && attempts < 5) { // Avoid collision, though unlikely with hex
            roomId = generateRoomId();
            attempts++;
        }
        if (activeGames[roomId]) {
             console.error("[ROOM] Failed to generate unique Room ID after multiple attempts.");
             return callback({success: false, message: "创建房间失败，请稍后再试。"});
        }

        const game = new Game(roomId, 4); // Assuming 4 players max for now
        const newRoom = {
            roomId: roomId,
            roomName: roomName.trim(),
            password: password || null, // Store null if no password
            creatorId: socket.userId,
            players: [], // { userId, username, socketId, isReady, slot, connected }
            game: game, // Game instance
            status: 'waiting' // 'waiting', 'playing', 'finished'
        };

        activeGames[roomId] = newRoom;
        console.log(`[ROOM] Room created: "${newRoom.roomName}" (${roomId}) by ${socket.username}`);

        // Creator automatically joins the room
        const joinResult = addPlayerToRoom(newRoom, socket);
        if (joinResult.success) {
            socket.join(roomId); // Socket.IO join
            socket.roomId = roomId; // Store roomId on socket for easy access
            callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(newRoom, socket.userId) });
            broadcastRoomList(); // Inform lobby of new room
        } else {
            // Should not happen if room was just created empty
            delete activeGames[roomId]; // Clean up
            callback({ success: false, message: '创建房间后加入失败。' });
        }
    });

    // --- Join Room ---
    socket.on('joinRoom', (data, callback) => {
        if (!socket.userId) return callback({ success: false, message: '请先登录。' });
         const { roomId, password } = data;
         const room = activeGames[roomId];

         if (!room) return callback({ success: false, message: '房间不存在。' });

         // Check if player is already in the room (e.g. rejoining after disconnect)
         const existingPlayer = room.players.find(p => p.userId === socket.userId);
         if (existingPlayer) {
            // If player is listed but not connected, treat as a reconnect
            if (!existingPlayer.connected) {
                console.log(`[ROOM] Player ${socket.username} rejoining room ${roomId}`);
                const reconnectResult = handleReconnect(socket, roomId); // Use the centralized reconnect logic
                if (reconnectResult.success) {
                    callback({ success: true, roomId: roomId, roomState: reconnectResult.roomState });
                } else {
                    // Reconnect failed, but player might still be "in" the room data-wise
                    callback({ success: false, message: reconnectResult.message });
                }
            } else {
                 // Player is already connected and in the room
                 console.log(`[ROOM] Player ${socket.username} already connected in room ${roomId}`);
                 // socket.join(roomId); // Ensure socket is in the room if it got disconnected weirdly
                 // socket.roomId = roomId;
                 callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId), message: "您已在此房间中。" });
            }
            return; // Exit after handling existing player
         }


         // Standard join for new player
         if (room.status !== 'waiting') return callback({ success: false, message: '游戏已开始或已结束，无法加入。' });
         if (room.players.length >= 4) return callback({ success: false, message: '房间已满。' });
         if (room.password && room.password !== password) return callback({ success: false, message: '房间密码错误。' });

         const joinResult = addPlayerToRoom(room, socket);
         if (joinResult.success) {
             socket.join(roomId);
             socket.roomId = roomId;
             console.log(`[ROOM] Player ${socket.username} joined room "${room.roomName}" (${roomId})`);
             // Inform other players in the room (excluding the new player themselves)
             // Send only necessary info, not socketId
             socket.to(roomId).emit('playerJoined', { ...joinResult.player, socketId: undefined });
             callback({ success: true, roomId: roomId, roomState: getRoomStateForPlayer(room, socket.userId) });
             broadcastRoomList();
         } else {
             callback({ success: false, message: joinResult.message });
         }
    });

    // --- List Rooms ---
    socket.on('listRooms', (callback) => {
         // No auth needed to list rooms for lobby
         if (typeof callback === 'function') {
            callback(getPublicRoomList());
         }
     });

    // --- Player Ready ---
    socket.on('playerReady', (isReady, callback) => {
         if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。' });
         const room = activeGames[socket.roomId];
         if (!room) return callback({success: false, message: "房间信息丢失。"}); // Should not happen if socket.roomId is set
         if (room.status !== 'waiting') return callback({ success: false, message: '不在等待中的房间内。' });

         const player = room.players.find(p => p.userId === socket.userId);
         if (!player) return callback({ success: false, message: '玩家数据异常。' });

         player.isReady = !!isReady; // Ensure boolean
         console.log(`[ROOM ${socket.roomId}] Player ${player.username} readiness updated: ${player.isReady}`);

         // Broadcast update to all in room
         ioInstance.to(socket.roomId).emit('playerReadyUpdate', { userId: player.userId, isReady: player.isReady });
         checkAndStartGame(room); // Check if all players are ready
         callback({ success: true });
    });

    // --- Play Card ---
    socket.on('playCard', (cards, callback) => {
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。'});
        const room = activeGames[socket.roomId];
        if (!room || room.status !== 'playing' || !room.game) return callback({ success: false, message: '不在游戏中或游戏未开始。' });
        if (!Array.isArray(cards)) return callback({success: false, message: '无效的卡牌数据格式。'});

        const game = room.game;
        const playResult = game.playCard(socket.userId, cards);

        if (playResult.success) {
             console.log(`[GAME ${room.roomId}] Player ${socket.username} played cards. Type: ${playResult.handInfo?.type || 'N/A'}`);
             // Broadcast new game state to everyone in the room
             // Each player will receive their personalized state (own hand vs hand counts)
             const newState = getRoomStateForPlayer(room, null, true); // isGameUpdate = true
             ioInstance.to(room.roomId).emit('gameStateUpdate', newState);

             if (playResult.gameOver) {
                 console.log(`[GAME ${room.roomId}] Game over signaled by playCard.`);
                 room.status = 'finished'; // Update room status
                 ioInstance.to(room.roomId).emit('gameOver', playResult.scoreResult);
                 broadcastRoomList(); // Update lobby
             }
             callback({success: true}); // Acknowledge to player
        } else {
            // Invalid play, inform only the current player
            console.log(`[GAME ${room.roomId}] Invalid play by ${socket.username}: ${playResult.message}`);
            socket.emit('invalidPlay', { message: playResult.message });
            callback({success: false, message: playResult.message});
        }
    });

    // --- Pass Turn ---
    socket.on('passTurn', (callback) => {
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。'});
        const room = activeGames[socket.roomId];
        if (!room || room.status !== 'playing' || !room.game) return callback({ success: false, message: '不在游戏中或游戏未开始。' });

        const game = room.game;
        const passResult = game.handlePass(socket.userId);

        if (passResult.success) {
            console.log(`[GAME ${room.roomId}] Player ${socket.username} passed.`);
            const newState = getRoomStateForPlayer(room, null, true); // isGameUpdate = true
            ioInstance.to(room.roomId).emit('gameStateUpdate', newState);
            callback({success: true});
        } else {
            console.log(`[GAME ${room.roomId}] Invalid pass by ${socket.username}: ${passResult.message}`);
            socket.emit('invalidPlay', { message: passResult.message }); // Use same event for consistency
            callback({success: false, message: passResult.message});
        }
    });

    // --- Request Hint ---
    socket.on('requestHint', (currentHintIndex, callback) => {
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。'});
        const room = activeGames[socket.roomId];
        if (!room || room.status !== 'playing' || !room.game) return callback({ success: false, message: '不在游戏中或游戏未开始。' });

        const game = room.game;
        const hintResult = game.findHint(socket.userId, currentHintIndex || 0);

        if (hintResult.success) {
            // Send hint only to the requesting player
            callback({ success: true, hint: hintResult.hint, nextHintIndex: hintResult.nextHintIndex });
        } else {
            callback({ success: false, message: hintResult.message });
        }
    });


    // --- Leave Room ---
    socket.on('leaveRoom', (callback) => {
        if (!socket.userId || !socket.roomId) {
            console.log(`[LEAVE ROOM] Invalid attempt: No userId or roomId for socket ${socket.id}`);
            if (typeof callback === 'function') callback({ success: true, message: '您已不在房间中。' }); // Benign response
            return;
        }

        const roomId = socket.roomId; // Get it before potentially deleting it
        const room = activeGames[roomId];

        if (!room) {
            console.log(`[LEAVE ROOM] Room ${roomId} not found for user ${socket.username} (socket ${socket.id}).`);
            delete socket.roomId; // Clean up stale roomId on socket
            if (typeof callback === 'function') callback({ success: true, message: '房间已不存在或您已离开。' });
            return;
        }

        const playerIndex = room.players.findIndex(p => p.userId === socket.userId);

        if (playerIndex === -1) {
            // This could happen if the player was already removed by another process (e.g. admin kick, rare)
            // or if disconnect logic ran first and removed them from players array but not socket.roomId
            console.log(`[LEAVE ROOM] User ${socket.username} not found in room ${roomId} player list.`);
            delete socket.roomId; // Clean up
            if (typeof callback === 'function') callback({ success: true, message: '您当前不在此房间的玩家列表中。' });
            return;
        }

        const player = room.players[playerIndex]; // Get player info before splice
        console.log(`[ROOM ${roomId}] Player ${player.username} (ID: ${player.userId}) is leaving room "${room.roomName}".`);

        // Remove player from room.players array
        room.players.splice(playerIndex, 1);

        // If game was in progress, inform game instance
        if (room.game && (room.status === 'playing' || room.status === 'waiting' && room.game.gameStarted)) { // Also handle if game started but room is waiting for some reason
            room.game.removePlayer(player.userId); // This should mark player as disconnected in game

            // Check if game needs to end due to insufficient players
            const activePlayersInGame = room.game.players.filter(p => p.connected && !p.finished).length;
            if (activePlayersInGame < 2 && room.game.gameStarted && !room.game.gameFinished) { // Typically need at least 2 to continue
                console.log(`[GAME ${roomId}] Game ending due to player leaving. Remaining active: ${activePlayersInGame}`);
                room.status = 'finished';
                const scoreResult = room.game.endGame('有玩家离开，游戏结束');
                ioInstance.to(roomId).emit('gameOver', scoreResult || { reason: '有玩家离开，游戏结束。' });
            } else if (!room.game.gameFinished) { // Game continues
                // If the leaving player was the current turn, advance turn
                if (room.game.currentPlayerId === player.userId) { // Check game's current player
                    room.game.nextTurn(true); // Force next turn as current player left
                }
                 // Always broadcast state update as player list changed
                 // or current player might have changed
                const newState = getRoomStateForPlayer(room, null, true);
                ioInstance.to(roomId).emit('gameStateUpdate', newState);
            }
        }

        // Notify other players in the room
        socket.to(roomId).emit('playerLeft', { userId: player.userId, username: player.username });

        // Make socket leave the Socket.IO room
        socket.leave(roomId);
        console.log(`[SOCKET] Socket ${socket.id} left Socket.IO room ${roomId}`);
        delete socket.roomId; // Clear roomId from socket

        // If room is empty, delete it
        if (room.players.length === 0) {
            console.log(`[ROOM ${roomId}] Room "${room.roomName}" is empty. Deleting.`);
            delete activeGames[roomId];
        }
        // Else, if all remaining players are disconnected, also consider deleting (optional, for cleanup)
        // else if (room.players.every(p => !p.connected)) {
        //     console.log(`[ROOM ${roomId}] All remaining players in room "${room.roomName}" are disconnected. Deleting.`);
        //     delete activeGames[roomId];
        // }

        broadcastRoomList(); // Update lobby for everyone

        if (typeof callback === 'function') callback({ success: true, message: '已成功离开房间。' });
    });


    // --- Request Game State --- (e.g. on reconnect or if client feels out of sync)
     socket.on('requestGameState', (callback) => {
         if (!socket.userId || !socket.roomId) return; // Or send error callback
         const room = activeGames[socket.roomId];
         if (room && typeof callback === 'function') {
             callback(getRoomStateForPlayer(room, socket.userId));
         }
     });

    // Note: Disconnect is handled globally in server.js, which calls roomManager.handleDisconnect
}

// --- Helper Functions ---
function addPlayerToRoom(room, socket) {
    if (room.players.length >= 4) return { success: false, message: "房间已满。" }; // Max players

    // Assign to the lowest available slot (0-3)
    const existingSlots = room.players.map(p => p.slot);
    let assignedSlot = -1;
    for (let i = 0; i < 4; i++) { if (!existingSlots.includes(i)) { assignedSlot = i; break; } }
    if (assignedSlot === -1) return { success: false, message: "无法找到可用位置。" }; // Should not happen if length < 4

    const playerInfo = {
        userId: socket.userId, username: socket.username, socketId: socket.id,
        isReady: false, slot: assignedSlot, connected: true
    };
    room.players.push(playerInfo);
    if (room.game) room.game.addPlayer(playerInfo.userId, playerInfo.username, playerInfo.slot); // Inform game instance
    console.log(`[ROOM ${room.roomId}] Player ${playerInfo.username} assigned to slot ${assignedSlot}`);
    return { success: true, player: playerInfo };
}

// --- MODIFICATION START ---
function checkAndStartGame(room) {
     if (room.status !== 'waiting') return; // Game already started or finished

     // Check for 4 connected players, all ready
     const connectedPlayers = room.players.filter(p => p.connected);
     const readyPlayers = connectedPlayers.filter(p => p.isReady);

     if (connectedPlayers.length === 4 && readyPlayers.length === 4) {
         console.log(`[ROOM ${room.roomId}] All 4 connected players ready. Starting game...`);
         room.status = 'playing'; // Update room status

         // Prepare player info for game.startGame
         const playerStartInfo = connectedPlayers.map(p => ({ id: p.userId, name: p.username, slot: p.slot }));
         const startResult = room.game.startGame(playerStartInfo);

         if (startResult.success) {
             console.log(`[GAME ${room.roomId}] Game started successfully. Broadcasting personalized gameStarted events.`);
             // Send personalized game state to each player upon game start
             // This ensures each player gets their initial hand correctly.
             room.players.forEach(playerInRoom => {
                 if (playerInRoom.connected && playerInRoom.socketId) { // Ensure player is still connected and has a socketId
                     const playerSocket = ioInstance.sockets.sockets.get(playerInRoom.socketId);
                     if (playerSocket) {
                         const initialStateForPlayer = getRoomStateForPlayer(room, playerInRoom.userId, true); // isGameUpdate = true for game context
                         playerSocket.emit('gameStarted', initialStateForPlayer);
                         console.log(`[GAME ${room.roomId}] Sent gameStarted to ${playerInRoom.username} (ID: ${playerInRoom.userId})`);
                     } else {
                         // This might happen if a socket disconnected right before this loop
                         console.warn(`[GAME ${room.roomId}] Could not find socket for player ${playerInRoom.username} (ID: ${playerInRoom.userId}, SocketID: ${playerInRoom.socketId}) to send gameStarted event.`);
                     }
                 } else {
                      // Player might have disconnected just as game was starting
                      console.log(`[GAME ${room.roomId}] Player ${playerInRoom.username} (ID: ${playerInRoom.userId}) is not connected or has no socketId, skipping gameStarted event.`);
                 }
             });
             broadcastRoomList(); // Update lobby (room status changed to 'playing')
         } else {
             // Game failed to start (e.g., card dealing error)
             console.error(`[ROOM ${room.roomId}] Failed to start game internally: ${startResult.message}`);
             room.status = 'waiting'; // Revert status
             // Inform players in room about failure
             ioInstance.to(room.roomId).emit('gameStartFailed', { message: startResult.message || "服务器内部错误导致游戏启动失败。" });
             // Optionally, reset ready status for all players in room
             room.players.forEach(p => p.isReady = false);
             ioInstance.to(room.roomId).emit('allPlayersResetReady'); // Custom event for clients to un-ready
         }
     }
}
// --- MODIFICATION END ---

// isGameUpdate flag helps determine if we should get state from game.js or just room.players
function getRoomStateForPlayer(room, requestingUserId, isGameUpdate = false) {
     // If it's a game update or game is playing/finished, get game-specific state
     const gameState = (isGameUpdate || room.status === 'playing' || room.status === 'finished') && room.game
         ? room.game.getStateForPlayer(requestingUserId)
         : null;

     // Combine room player info with game player info
     const combinedPlayers = room.players.map(roomPlayer => {
         const gamePlayer = gameState ? gameState.players.find(gp => gp.id === roomPlayer.userId) : null;
         return {
             userId: roomPlayer.userId, username: roomPlayer.username, slot: roomPlayer.slot,
             isReady: roomPlayer.isReady, connected: roomPlayer.connected, // From room.players
             // Game-specific attributes (score, hand, handCount, role, finished)
             score: gamePlayer ? gamePlayer.score : (roomPlayer.score || 0), // Fallback to roomPlayer.score if gamePlayer not found yet
             hand: gamePlayer ? gamePlayer.hand : (requestingUserId === roomPlayer.userId ? [] : undefined), // My hand if game state missing but it's me
             handCount: gamePlayer ? gamePlayer.handCount : (roomPlayer.connected ? (gamePlayer?.handCount ?? 0) : 0), // Show 0 if disconnected for non-self
             isCurrentPlayer: gameState ? gameState.currentPlayerId === roomPlayer.userId : false,
             role: gamePlayer ? gamePlayer.role : null,
             finished: gamePlayer ? gamePlayer.finished : false
         };
     });

     return {
         roomId: room.roomId, roomName: room.roomName, status: room.status,
         players: combinedPlayers,
         // Game-specific state (only if gameState is available)
         centerPile: gameState?.centerPile ?? [],
         lastHandInfo: gameState?.lastHandInfo ?? null, // Changed from lastHandType to full info
         currentPlayerId: gameState?.currentPlayerId ?? null,
         isFirstTurn: gameState?.isFirstTurn ?? false, // Default to false if no game state
         myUserId: requestingUserId, // So client knows which player data is theirs
         gameMode: room.game ? room.game.gameMode : null
         // gameFinished, winnerId etc. can be derived from gameState if needed, or added here
     };
}


// --- Disconnect and Reconnect Handling ---
function handleDisconnect(socket) {
     const roomId = socket.roomId; // Get roomId stored on socket during join/create
     if (!roomId) {
        //  console.log(`[DISCO] Socket ${socket.id} disconnected, was not in a room.`);
         return; // Not in any managed room
     }

     const room = activeGames[roomId];
     if (!room) {
         // This could happen if room was deleted while socket was still associated
         console.log(`[DISCO] Socket ${socket.id} disconnected, room ${roomId} no longer active.`);
         delete socket.roomId; // Clean up stale roomId
         return;
     }

     const player = room.players.find(p => p.socketId === socket.id);
     if (!player) {
         // This can happen if player reconnected with a new socket already,
         // and the old socket connection timed out later.
         // Or if player was removed via leaveRoom and then the socket disconnected.
         console.log(`[DISCO] Socket ${socket.id} was in room ${roomId} but player not found by socketId.`);
         delete socket.roomId;
         return;
     }

     console.log(`[ROOM ${roomId}] Player ${player.username} (ID: ${player.userId}) disconnected via socket ${socket.id}.`);
     player.connected = false;
     player.isReady = false; // Player is no longer ready

     // Inform other players in the room (use 'playerLeft' for consistency in client UI)
     // Send reason as 'disconnected'
     ioInstance.to(roomId).emit('playerLeft', { userId: player.userId, username: player.username, reason: 'disconnected' });


     // If game was in progress, handle game logic for disconnection
     if (room.game && (room.status === 'playing' || (room.status === 'waiting' && room.game.gameStarted))) {
         room.game.markPlayerConnected(player.userId, false); // Inform game instance

         const activePlayersInGame = room.game.players.filter(p => p.connected && !p.finished).length;
         if (activePlayersInGame < 2 && room.game.gameStarted && !room.game.gameFinished) {
             console.log(`[GAME ${roomId}] Game ending due to disconnect. Remaining active: ${activePlayersInGame}`);
             room.status = 'finished';
             const scoreResult = room.game.endGame('有玩家断线，游戏结束');
             ioInstance.to(roomId).emit('gameOver', scoreResult || { reason: '有玩家断线，游戏结束。' });
         } else if (!room.game.gameFinished) {
             // If the disconnected player was the current turn, advance turn
             if (room.game.currentPlayerId === player.userId) {
                 room.game.nextTurn(true); // Force advance turn
             }
             // Broadcast updated state (player disconnected, turn might have changed)
             const newState = getRoomStateForPlayer(room, null, true);
             ioInstance.to(room.roomId).emit('gameStateUpdate', newState);
         }
     } else if (room.status === 'waiting') {
        // If in waiting room, just update player ready status for display
        const newState = getRoomStateForPlayer(room, null, false);
        ioInstance.to(room.roomId).emit('gameStateUpdate', newState); // Or a more specific playerDisconnectedInLobby event
     }


     // Check if room should be deleted (e.g., if all players are now disconnected)
     const stillConnectedPlayersInRoom = room.players.filter(p => p.connected).length;
     if (stillConnectedPlayersInRoom === 0 && room.players.length > 0) { // Check if room had players and all are now disconnected
         console.log(`[ROOM ${roomId}] All players in room "${room.roomName}" are disconnected. Deleting room.`);
         delete activeGames[roomId];
     } else if (room.players.length === 0) { // Or if the player list is truly empty after a leave
          console.log(`[ROOM ${roomId}] Room "${room.roomName}" is empty. Deleting.`);
          delete activeGames[roomId];
     }


     broadcastRoomList(); // Update lobby
     delete socket.roomId; // Clean up after processing
}

function findRoomByUserId(userId) {
     for (const roomId in activeGames) {
         const room = activeGames[roomId];
         if (room.players.some(p => p.userId === userId)) {
             return room;
         }
     }
     return null;
}

function handleReconnect(socket, roomId) { // Called by authManager on reauthenticate or by joinRoom
      const room = activeGames[roomId];
      if (!room) return { success: false, message: '尝试重连的房间已不存在。' };

      const player = room.players.find(p => p.userId === socket.userId);
      if (!player) return { success: false, message: '玩家数据异常。' }; // Should exist if findRoomByUserId found it

      // If player was already marked as connected with a different socket, log it
      if (player.connected && player.socketId !== socket.id) {
          console.warn(`[RECONNECT ${roomId}] Player ${player.username} already connected with socket ${player.socketId}. Updating to ${socket.id}.`);
          // Optionally, disconnect the old socket if it's still somehow alive
          // const oldSocket = ioInstance.sockets.sockets.get(player.socketId);
          // if (oldSocket) oldSocket.disconnect(true);
      }

      player.socketId = socket.id; // Update to new socket
      player.connected = true;
      // Player's ready status should persist if they were ready before disconnect.
      // If a game was in progress, their hand also persists in the game object.
      console.log(`[RECONNECT ${roomId}] Player ${player.username} reconnected with new socket ${socket.id}`);

      if (room.game && room.status === 'playing') {
          room.game.markPlayerConnected(socket.userId, true); // Inform game instance
      }

      socket.join(roomId); // Essential: Socket joins the Socket.IO room
      socket.roomId = roomId; // Update socket's knowledge of its room

      // Inform other players (excluding self) that this player has reconnected
      // Use a specific event, or reuse playerJoined with a flag if desired
      socket.to(roomId).emit('playerReconnected', { userId: player.userId, username: player.username, slot: player.slot, isReady: player.isReady }); // Send relevant info

      // Return success and the full current room state for the reconnected player
      return { success: true, roomState: getRoomStateForPlayer(room, socket.userId) };
}

// --- Lobby and Room List ---
function getPublicRoomList() { // Info for the lobby
      return Object.values(activeGames).map(room => ({
         roomId: room.roomId, roomName: room.roomName,
         playerCount: room.players.filter(p => p.connected).length, // Count only connected players for public display
         maxPlayers: 4, // Assuming game.maxPlayers, make dynamic if needed
         status: room.status, hasPassword: !!room.password
     }));
}
function broadcastRoomList() {
    if (ioInstance) {
        ioInstance.emit('roomListUpdate', getPublicRoomList());
    }
}
function handleAuthentication(socket) { // Called after successful login/reauth
    // When a user authenticates, send them the current list of rooms.
    socket.emit('roomListUpdate', getPublicRoomList());
}


module.exports = {
    init,
    handleDisconnect,
    handleAuthentication, // Export for authManager to call
    getPublicRoomList,    // For initial list on connect
    findRoomByUserId,     // For reauthentication logic
    handleReconnect       // For reauthentication logic
};
