// roomManager.js
const { Game } = require('./game');
const crypto = require('crypto');

let activeGames = {}; // Stores room objects: { roomId: roomObject, ... }
let ioInstance; // To store the io object from server.js

function generateRoomId() {
    return crypto.randomBytes(3).toString('hex'); // 6-char hex string
}

function getRoomById(roomId) { // Added function
    return activeGames[roomId];
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
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。' });
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: '房间或游戏不存在。' });
        if (room.status !== 'playing') return callback({ success: false, message: '游戏未在进行中。' });

        const result = room.game.playCard(socket.userId, cards);
        console.log(`[PLAY CARD] User: ${socket.username}, Room: ${socket.roomId}, Cards: ${JSON.stringify(cards)}, Result: ${JSON.stringify(result)}`);
        if (result.success) {
            if (result.gameOver) {
                room.status = 'finished';
                const finalRoomState = getRoomStateForPlayer(room, socket.userId, true); // isGameUpdate=true
                ioInstance.to(socket.roomId).emit('gameOver', finalRoomState); // Use finalRoomState for gameOver event
                console.log(`[GAME OVER] Room ${socket.roomId} finished. Result: ${result.scoreResult.result}`);
                broadcastRoomList(); // Update lobby with finished status
            } else {
                // Emit gameStateUpdate to all players in the room
                room.players.forEach(p => {
                    if (p.connected && p.socketId) {
                        const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                        if (playerSocket) {
                             playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                        }
                    }
                });
            }
        }
        if (typeof callback === 'function') callback(result);
    });

    socket.on('passTurn', (callback) => {
        // ... (passTurn logic - unchanged, ensure logging is present)
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。' });
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: '房间或游戏不存在。' });
        if (room.status !== 'playing') return callback({ success: false, message: '游戏未在进行中。' });

        const result = room.game.handlePass(socket.userId);
        console.log(`[PASS TURN] User: ${socket.username}, Room: ${socket.roomId}, Result: ${JSON.stringify(result)}`);
        if (result.success) {
            room.players.forEach(p => {
                if (p.connected && p.socketId) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) {
                        playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                    }
                }
            });
        }
        if (typeof callback === 'function') callback(result);
    });

    socket.on('requestHint', (currentHintCycleIndex, callback) => {
        // ... (requestHint logic - unchanged, ensure logging is present)
        if (!socket.userId || !socket.roomId) return callback({ success: false, message: '无效操作。' });
        const room = activeGames[socket.roomId];
        if (!room || !room.game) return callback({ success: false, message: '房间或游戏不存在。' });
        if (room.status !== 'playing') return callback({ success: false, message: '游戏未在进行中。' });
        
        const result = room.game.findHint(socket.userId, currentHintCycleIndex);
        console.log(`[REQUEST HINT] User: ${socket.username}, Room: ${socket.roomId}, Result: ${result.success ? 'Hint found' : result.message}`);
        if (typeof callback === 'function') callback(result);
    });

    socket.on('leaveRoom', (callback) => {
        // ... (leaveRoom logic - unchanged, ensure logging is present)
        if (!socket.userId || !socket.roomId) {
            console.warn(`[LEAVE ROOM] Invalid op: User ${socket.userId} trying to leave room ${socket.roomId} but one is missing. Socket: ${socket.id}`);
            return callback({ success: false, message: '无效操作，无法确定用户或房间。' });
        }
        const room = activeGames[socket.roomId];
        if (!room) {
            console.warn(`[LEAVE ROOM] Room ${socket.roomId} not found for user ${socket.username} (ID: ${socket.userId}).`);
            socket.roomId = null; // Clear potentially stale roomId on socket
            return callback({ success: true, message: '房间已不存在。' }); // Success as user is effectively out
        }

        handlePlayerLeavingRoom(room, socket);
        if (typeof callback === 'function') callback({ success: true });
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
             slot: p.slot,
             score: p.score // Pass current score to game instance
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

function handlePlayerLeavingRoom(room, socket) {
    const playerIndex = room.players.findIndex(p => p.userId === socket.userId);
    if (playerIndex === -1) {
        console.warn(`[LEAVE ROOM] Player ${socket.username} (ID: ${socket.userId}) not found in room ${room.roomId} player list.`);
        return; // Player not in list, nothing to do for room.players
    }

    const leavingPlayer = room.players[playerIndex];
    console.log(`[LEAVE ROOM] Player ${leavingPlayer.username} (ID: ${leavingPlayer.userId}) is leaving room "${room.roomName}" (${room.roomId}). Socket: ${socket.id}`);
    
    socket.leave(room.roomId);
    socket.roomId = null; // Clear roomId from socket

    if (room.status === 'playing' && room.game) {
        console.log(`[LEAVE ROOM] Game in progress in room ${room.roomId}. Marking player ${leavingPlayer.username} as disconnected in game.`);
        room.game.markPlayerConnected(leavingPlayer.userId, false); // Mark as disconnected in game logic
        leavingPlayer.connected = false; // Mark as disconnected in room.players
        leavingPlayer.isReady = false; // Player is no longer ready

        // Notify other players about disconnection
        ioInstance.to(room.roomId).emit('playerDisconnected', { userId: leavingPlayer.userId, username: leavingPlayer.username });
        
        // Check if game needs to end due to disconnections
        const connectedGamePlayers = room.game.players.filter(p => p.connected && !p.finished);
        if (connectedGamePlayers.length < 2 && room.game.gameStarted && !room.game.gameFinished) { // Or your game's minimum player rule
            console.log(`[LEAVE ROOM] Not enough players to continue game in room ${room.roomId}. Ending game.`);
            const gameEndResult = room.game.endGame("玩家离开导致人数不足");
            room.status = 'finished';
            ioInstance.to(room.roomId).emit('gameOver', getRoomStateForPlayer(room, null, true)); // Send final state to everyone
        } else {
            // If game continues, just update state
             room.players.forEach(p => {
                if (p.connected && p.socketId) {
                    const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                    if (playerSocket) {
                        playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                    }
                }
            });
        }

    } else { // Room is 'waiting' or 'finished', or game object is missing
        room.players.splice(playerIndex, 1); // Remove player from waiting room list entirely
        console.log(`[LEAVE ROOM] Player ${leavingPlayer.username} removed from room ${room.roomId} (status: ${room.status}).`);
        ioInstance.to(room.roomId).emit('playerLeft', { userId: leavingPlayer.userId, username: leavingPlayer.username });
         // Update game instance if it exists
        if (room.game) {
            room.game.removePlayer(leavingPlayer.userId); // Ensure game instance is also updated
        }
    }

    // If room becomes empty, delete it
    const connectedPlayersInRoom = room.players.filter(p => p.connected);
    if (connectedPlayersInRoom.length === 0 && room.status !== 'playing') { // Only delete if not in active play or ensure game handles cleanup
        console.log(`[LEAVE ROOM] Room ${room.roomId} is now empty. Deleting.`);
        delete activeGames[room.roomId];
    } else {
        // If creator leaves a waiting room, might need to assign a new creator or close room
        if (room.creatorId === leavingPlayer.userId && room.status === 'waiting' && room.players.length > 0) {
            room.creatorId = room.players[0].userId; // Assign to next player
            console.log(`[LEAVE ROOM] Creator left waiting room ${room.roomId}. New creator: ${room.players[0].username}`);
             // Notify clients about new creator if necessary (not implemented on client)
        }
    }
    broadcastRoomList(); // Update lobby for everyone
}


function handleDisconnect(socket) {
    if (!socket.userId) { // User wasn't logged in or reauthenticated fully
        console.log(`[DISCONNECT] Socket ${socket.id} disconnected (was not fully authenticated or in a room).`);
        return;
    }

    const room = findRoomByUserId(socket.userId); // This needs to check activeGames
    if (room) {
        console.log(`[DISCONNECT] Player ${socket.username} (ID: ${socket.userId}) disconnected from room "${room.roomName}" (${room.roomId}). Socket: ${socket.id}`);
        const playerInRoom = room.players.find(p => p.userId === socket.userId);

        if (playerInRoom) {
            playerInRoom.connected = false;
            playerInRoom.isReady = false; // Player is no longer ready upon disconnect
            
            if (room.status === 'playing' && room.game) {
                room.game.markPlayerConnected(socket.userId, false);
                ioInstance.to(room.roomId).emit('playerDisconnected', { userId: socket.userId, username: socket.username, message: "玩家已断开连接。" });

                // Check if game needs to end
                const connectedGamePlayers = room.game.players.filter(p => p.connected && !p.finished);
                if (connectedGamePlayers.length < 2 && room.game.gameStarted && !room.game.gameFinished) {
                     console.log(`[DISCONNECT] Not enough players to continue game in room ${room.roomId} after disconnect. Ending game.`);
                     const gameEndResult = room.game.endGame("玩家断线导致人数不足");
                     room.status = 'finished';
                     ioInstance.to(room.roomId).emit('gameOver', getRoomStateForPlayer(room, null, true));
                } else {
                    // If game continues, update other players
                    room.players.forEach(p => {
                        if (p.connected && p.socketId && p.userId !== socket.userId) {
                            const otherPlayerSocket = ioInstance.sockets.sockets.get(p.socketId);
                            if (otherPlayerSocket) {
                                otherPlayerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                            }
                        }
                    });
                     // If it was the disconnected player's turn, advance it if game logic doesn't handle it
                    if (room.game.currentPlayerIndex !== -1 && room.game.players[room.game.currentPlayerIndex]?.id === socket.userId) {
                        console.log(`[DISCONNECT] It was ${socket.username}'s turn. Advancing turn.`);
                        room.game.nextTurn(true); // Force advance due to player action (disconnect)
                        // Send updated state after turn advance
                        room.players.forEach(p => {
                           if (p.connected && p.socketId) {
                               const playerSocket = ioInstance.sockets.sockets.get(p.socketId);
                               if (playerSocket) {
                                   playerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, true));
                               }
                           }
                        });
                    }
                }
            } else if (room.status === 'waiting') {
                // In waiting room, player is just marked disconnected.
                // Could remove them if they don't reconnect after a timeout, or upon next interaction.
                // For now, just update the room list and player status in room.
                ioInstance.to(room.roomId).emit('playerDisconnected', { userId: socket.userId, username: socket.username, message: "玩家已离开等待。" });
            }

            // If all players in a room are disconnected, consider closing the room
            const anyConnected = room.players.some(p => p.connected);
            if (!anyConnected && room.status !== 'playing') { // Or add a timeout for playing rooms
                console.log(`[DISCONNECT] All players in room ${room.roomId} are disconnected. Deleting room.`);
                delete activeGames[room.roomId];
            }
        }
        broadcastRoomList();
    } else {
        console.log(`[DISCONNECT] Player ${socket.username || socket.id} (ID: ${socket.userId}) disconnected (was not in an active room).`);
    }
}
function findRoomByUserId(userId) {
    for (const roomId in activeGames) {
        if (activeGames[roomId].players.some(p => p.userId === userId)) {
            return activeGames[roomId];
        }
    }
    return null;
}
function handleReconnect(socket, roomId) {
    const room = activeGames[roomId];
    if (!room || !socket.userId) {
        console.warn(`[RECONNECT] Room ${roomId} or socket.userId missing for re-connection.`);
        return { success: false, message: '无法重新连接: 房间或用户信息丢失。' };
    }

    const player = room.players.find(p => p.userId === socket.userId);
    if (!player) {
        console.warn(`[RECONNECT] Player ${socket.username} (ID: ${socket.userId}) not found in room ${roomId} for re-connection.`);
        // This might happen if player was removed due to inactivity. Treat as fresh join?
        // For now, fail reconnect if not in player list.
        return { success: false, message: '重新连接失败: 玩家数据未在房间内找到。' };
    }

    player.connected = true;
    player.socketId = socket.id; // Update socket ID
    socket.join(roomId);
    socket.roomId = roomId;

    if (room.game) {
        room.game.markPlayerConnected(socket.userId, true);
    }

    console.log(`[RECONNECT] Player ${player.username} (ID: ${player.userId}) reconnected to room "${room.roomName}" (${roomId}). Socket: ${socket.id}`);

    // Notify other players about re-connection (optional, gameStateUpdate usually covers it)
    socket.to(roomId).emit('playerReconnected', { userId: player.userId, username: player.username });

    // Send current game state to reconnected player
    const roomStateForPlayer = getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting');

    // Update all players in the room with the potentially new connection status / socketId linkage
    // This is important if the game state UI depends on player.connected status for everyone.
    room.players.forEach(p => {
        if (p.socketId && p.userId !== socket.userId) { // Exclude the rejoining player, they get it from callback
            const otherPlayerSocket = ioInstance.sockets.sockets.get(p.socketId);
            if (otherPlayerSocket) {
                 otherPlayerSocket.emit('gameStateUpdate', getRoomStateForPlayer(room, p.userId, room.status !== 'waiting'));
            }
        }
    });
    broadcastRoomList(); // Player count might effectively change if they were the only one disconnected.
    return { success: true, roomState: roomStateForPlayer };
}
function getPublicRoomList() {
    return Object.values(activeGames).map(room => ({
        roomId: room.roomId,
        roomName: room.roomName,
        playerCount: room.players.filter(p => p.connected).length, // Count only connected players for public list
        maxPlayers: 4, // Or room.game.maxPlayers if dynamic
        status: room.status,
        hasPassword: !!room.password
    }));
}
function broadcastRoomList() {
    if (ioInstance) {
        ioInstance.emit('roomListUpdate', getPublicRoomList());
        console.log("[BROADCAST] Room list updated for all clients.");
    }
}
function handleAuthentication(socket) {
    // This function can be called after successful login or reauthentication
    // to ensure the user's socket is known to the roomManager if they were in a room.
    if (socket.userId) {
        const room = findRoomByUserId(socket.userId);
        if (room) {
            const player = room.players.find(p => p.userId === socket.userId);
            if (player && !player.connected) { // If player was in a room but marked disconnected
                console.log(`[AUTH SYNC] Player ${socket.username} authenticated and was in room ${room.roomId}, marking as reconnected.`);
                handleReconnect(socket, room.roomId); // This will set connected=true, update socketId, and send state
            } else if (player && player.connected && player.socketId !== socket.id) {
                 console.log(`[AUTH SYNC] Player ${socket.username} authenticated with new socket ${socket.id} (old: ${player.socketId}). Updating socketId.`);
                 player.socketId = socket.id; // Update socket ID if it changed (e.g. new tab)
                 socket.join(room.roomId); // Ensure this new socket is in the room
                 socket.roomId = room.roomId;
                 // Send current state to this specific socket
                 socket.emit('gameStateUpdate', getRoomStateForPlayer(room, socket.userId, room.status !== 'waiting'));
            }
        }
    }
}


module.exports = {
    init,
    handleDisconnect,
    handleAuthentication,
    getPublicRoomList,
    findRoomByUserId,
    handleReconnect, // Make sure this is exported if used elsewhere (e.g. authManager)
    getRoomById // Export the new function
};
