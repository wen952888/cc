// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const authManager = require('./authManager');
const roomManager = require('./roomManager');

const app = express();
const server = http.createServer(app);

// !!! IMPORTANT: 修改为你客户端实际访问的 URL !!!
// 例如，如果你通过 `https://mygame.example.com` 访问前端，这里就应该是那个 URL
// 如果是本地开发，并且客户端运行在 `http://localhost:8080`，则可以是 `http://localhost:8080`
const YOUR_CLIENT_FACING_URL = "https://9525.ip-ddns.com"; // <--- 确保这个URL是正确的，否则CORS会阻止连接

const io = new Server(server, {
    pingTimeout: 60000,    // 客户端在60秒内未发送 PONG 包则认为连接超时
    pingInterval: 25000,   // 服务器每25秒发送一个 PING 包
    transports: ['websocket', 'polling'], // 明确指定传输方式，优先 WebSocket
    // CORS 配置:
    cors: {
        origin: YOUR_CLIENT_FACING_URL, // 只允许来自指定源的连接
        // 如果你本地开发也需要连接这个服务器，可以像这样允许多个源:
        // origin: ["http://localhost:8080", YOUR_CLIENT_FACING_URL], // 假设本地客户端在8080端口
        methods: ["GET", "POST"],
        // allowedHeaders: ["my-custom-header"], // 如果客户端发送了自定义头部
        // credentials: true // 如果需要 cookie 或授权头部跨域
    }
});

app.disable('x-powered-by'); // 安全性考虑，移除 Express 的标识

const PORT = process.env.PORT || 16141; // <--- 修改端口

console.log("--- [SERVER] Startup Configuration ---");
const nodeEnv = process.env.NODE_ENV || 'development';
console.log(`NODE_ENV: ${nodeEnv}`);
console.log(`Effective port chosen for listening: ${PORT}`);
console.log(`Client URL for CORS: ${YOUR_CLIENT_FACING_URL}`);
console.log("------------------------------------");

// Serve static files from the 'public' directory with caching headers
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: nodeEnv === 'development' ? '0' : '7d', // 开发模式下禁用缓存，生产模式下7天
    etag: true,
    lastModified: true
}));

// Load user data on startup
authManager.loadUsers();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`[SERVER] Client connected: ${socket.id}`);

    // Initialize authentication and room/game event handlers for this socket
    authManager.init(socket);
    roomManager.init(socket, io); // Pass io instance for broadcasting

    socket.on('sendVoiceMessage', (data) => {
        if (!socket.userId) {
            console.warn(`[SERVER VOICE] Unauthorized voice message attempt from socket ${socket.id}. User not authenticated.`);
            // Optionally, send an error back to the client if they expect a response for failure
            // socket.emit('voiceMessageError', { message: 'Authentication required to send voice messages.' });
            return;
        }

        const { roomId, audioBlob } = data;
        const userId = socket.userId; // Use authenticated userId
        const username = socket.username || 'UnknownUser'; // Use username from socket if available

        console.log(`[SERVER VOICE] Received voice message from ${username} (ID: ${userId}, Socket: ${socket.id}) for room ${roomId}. Blob size: ${audioBlob ? audioBlob.size : 'N/A'}`);

        const room = roomManager.getRoomById(roomId);
        if (room) {
            // Check if the sender is actually a connected player in this room
            const playerInRoom = room.players.find(p => p.userId === userId && p.connected);
            if (!playerInRoom) {
                console.warn(`[SERVER VOICE] User ${username} (ID: ${userId}) attempted to send voice to room ${roomId}, but is not a connected member of this room.`);
                return;
            }

            if (audioBlob && audioBlob.size > 0) {
                // Broadcast to other players in the room
                // socket.to(roomId) sends to everyone in the room *except* the sender
                socket.to(roomId).emit('receiveVoiceMessage', { userId: userId, username: username, audioBlob: audioBlob });
                console.log(`[SERVER VOICE] Broadcasting voice message to room ${roomId} from ${username}.`);
            } else {
                console.warn(`[SERVER VOICE] Received empty or invalid audioBlob for room ${roomId} from ${username}.`);
            }
        } else {
            console.warn(`[SERVER VOICE] Room ${roomId} not found for voice message from ${username}.`);
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`[SERVER] Client disconnected: ${socket.id}. User: ${socket.username || 'N/A'}. Reason: ${reason}`);
        // roomManager.handleDisconnect will be called for cleanup if the user was in a room
        roomManager.handleDisconnect(socket);
    });

    // Example: Send initial room list when a client connects and is ready (e.g., after successful auth)
    // This is now typically handled by the client requesting it after auth, or as part of reauth response.
    // If you want to push it on connect (after auth logic in authManager.init runs), that's an option.
    // For now, client.js's 'listRooms' emit handles this.
    // socket.emit('roomListUpdate', roomManager.getPublicRoomList());
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Server running and listening on 0.0.0.0:${PORT}`);
    if (nodeEnv === 'production') {
         console.log(`[SERVER] Production mode: Access via your configured domain/URL pointing to this port.`);
    } else {
         console.log(`[SERVER] Development mode: Access typically via http://localhost:${PORT} or local IP.`);
    }
});

// Graceful shutdown handlers
process.on('uncaughtException', (error) => {
    console.error('--- UNCAUGHT EXCEPTION! Server is shutting down... ---');
    console.error('Error Name:', error.name);
    console.error('Error Message:', error.message);
    console.error('Error Stack:', error.stack);
    console.error('-------------------------------------------------------');
    
    const closeTimeout = 5000; // 5 seconds for graceful shutdown

    if (io) {
        io.close(() => {
            console.log('[SERVER] Socket.IO connections closed due to uncaught exception.');
            server.close(() => {
                console.log('[SERVER] HTTP server closed due to uncaught exception.');
                process.exit(1); // Exit with error code
            });
        });
    } else if (server && server.listening) {
        server.close(() => {
            console.log('[SERVER] HTTP server closed due to uncaught exception (no IO).');
            process.exit(1);
        });
    } else {
        console.error('[SERVER] No IO or HTTP server to close. Exiting immediately.');
        process.exit(1);
    }

    // Force exit if graceful shutdown takes too long
    setTimeout(() => {
        console.error('[SERVER] Graceful shutdown on uncaughtException timed out. Forcing exit.');
        process.exit(1);
    }, closeTimeout).unref(); // .unref() allows the program to exit if this is the only timer left.
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('--- UNHANDLED PROMISE REJECTION! ---');
    console.error('Reason:', reason);
    // console.error('Promise:', promise); // Promise object can be very verbose
    console.error('------------------------------------');
    // Depending on the severity, you might want to shut down here too,
    // but it's less critical than an uncaughtException.
    // For now, just log it.
});

process.on('SIGINT', () => { // Ctrl+C
    console.log('[SERVER] SIGINT signal received. Shutting down gracefully...');
    const closeTimeout = 10000; // 10 seconds

    if (io) {
        io.close(() => {
            console.log('[SERVER] Socket.IO connections closed on SIGINT.');
            server.close(() => {
                console.log('[SERVER] HTTP server closed on SIGINT.');
                process.exit(0); // Exit successfully
            });
        });
    } else if (server && server.listening) {
         server.close(() => {
            console.log('[SERVER] HTTP server closed on SIGINT (no IO).');
            process.exit(0);
        });
    } else {
        console.log('[SERVER] No IO or HTTP server running. Exiting on SIGINT.');
        process.exit(0);
    }

    setTimeout(() => {
        console.error('[SERVER] Graceful shutdown on SIGINT timed out. Forcing exit.');
        process.exit(1); // Exit with error if timeout
    }, closeTimeout).unref();
});
