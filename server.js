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
// 根据您的错误日志，您的页面是通过 'https://wenge.cloudns.ch/' 加载的。
// 因此，CORS origin 应该匹配这个。
const YOUR_CLIENT_FACING_URL = "https://wenge.cloudns.ch"; // <--- 修改这里以匹配您的域名

const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    cors: {
        origin: YOUR_CLIENT_FACING_URL, // 确保这与您浏览器地址栏中的域名和协议一致
        methods: ["GET", "POST"],
        // credentials: true, // 如果您需要发送 cookies 或授权头部
    }
});

app.disable('x-powered-by');

const PORT = process.env.PORT || 16141;

console.log("--- [SERVER] Startup Configuration ---");
const nodeEnv = process.env.NODE_ENV || 'development';
console.log(`NODE_ENV: ${nodeEnv}`);
console.log(`Effective port chosen for listening: ${PORT}`);
console.log(`Client URL for CORS: ${YOUR_CLIENT_FACING_URL}`); // 确认这个URL
console.log("------------------------------------");

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: nodeEnv === 'development' ? '0' : '7d',
    etag: true,
    lastModified: true
}));

// Load user data
authManager.loadUsers();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`[SERVER] Client connected: ${socket.id}. Remote Address: ${socket.handshake.address}`);

    authManager.init(socket);
    roomManager.init(socket, io);

    socket.on('sendVoiceMessage', (data) => {
        if (!socket.userId) {
            console.warn(`[SERVER VOICE] Unauthorized voice message from socket ${socket.id}.`);
            return;
        }
        const { roomId, audioBlob } = data;
        const userId = socket.userId;
        const username = socket.username || 'UnknownUser';
        console.log(`[SERVER VOICE] Received voice from ${username} (ID: ${userId}) for room ${roomId}. Blob size: ${audioBlob?.size || 'N/A'}`);

        const room = roomManager.getRoomById(roomId);
        if (room) {
            const playerInRoom = room.players.find(p => p.userId === userId && p.connected);
            if (!playerInRoom) {
                console.warn(`[SERVER VOICE] User ${username} (ID: ${userId}) not connected in room ${roomId}.`);
                return;
            }
            if (audioBlob && audioBlob.size > 0) {
                socket.to(roomId).emit('receiveVoiceMessage', { userId: userId, username: username, audioBlob: audioBlob });
                console.log(`[SERVER VOICE] Broadcasting voice to room ${roomId} from ${username}.`);
            } else {
                console.warn(`[SERVER VOICE] Empty/invalid audioBlob from ${username} for room ${roomId}.`);
            }
        } else {
            console.warn(`[SERVER VOICE] Room ${roomId} not found for voice message from ${username}.`);
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`[SERVER] Client disconnected: ${socket.id}. User: ${socket.username || 'N/A'}. Reason: ${reason}`);
        roomManager.handleDisconnect(socket);
    });

    // Log any general socket errors for this specific client
    socket.on('error', (err) => {
        console.error(`[SERVER SOCKET ERROR] Socket ${socket.id} (User: ${socket.username || 'N/A'}) reported error:`, err);
    });
});

// Log general IO errors
io.engine.on("connection_error", (err) => {
    console.error(`[SERVER IO ENGINE ERROR] Code: ${err.code}, Message: ${err.message}, Context: ${err.context}`);
});


server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Server running and listening on 0.0.0.0:${PORT}`);
    if (nodeEnv === 'production') {
         console.log(`[SERVER] Production mode: Access via your configured domain/URL pointing to this port.`);
    } else {
         console.log(`[SERVER] Development mode: Access typically via http://localhost:${PORT} or local IP.`);
         console.log(`[SERVER] Ensure your frontend is configured to connect to this server, and CORS origin ('${YOUR_CLIENT_FACING_URL}') is correct.`);
    }
});

// Graceful shutdown handlers (mostly unchanged, they are good)
process.on('uncaughtException', (error) => {
    console.error('--- UNCAUGHT EXCEPTION! Server is shutting down... ---');
    console.error('Error Name:', error.name);
    console.error('Error Message:', error.message);
    console.error('Error Stack:', error.stack);
    console.error('-------------------------------------------------------');
    const closeTimeout = 5000;
    if (io && typeof io.close === 'function') {
        io.close(() => {
            console.log('[SERVER] Socket.IO connections closed (uncaught exception).');
            if (server && server.listening) {
                server.close(() => {
                    console.log('[SERVER] HTTP server closed (uncaught exception).');
                    process.exit(1);
                });
            } else { process.exit(1); }
        });
    } else if (server && server.listening) {
        server.close(() => {
            console.log('[SERVER] HTTP server closed (uncaught exception, no IO).');
            process.exit(1);
        });
    } else { process.exit(1); }
    setTimeout(() => { console.error('[SERVER] Graceful shutdown timeout (uncaughtException). Forcing exit.'); process.exit(1); }, closeTimeout).unref();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('--- UNHANDLED PROMISE REJECTION! ---');
    console.error('Reason:', reason);
    // console.error('Promise:', promise); // Can be verbose
    console.error('------------------------------------');
});

process.on('SIGINT', () => { // Ctrl+C
    console.log('[SERVER] SIGINT signal received. Shutting down gracefully...');
    const closeTimeout = 10000;
    if (io && typeof io.close === 'function') {
        io.close(() => {
            console.log('[SERVER] Socket.IO connections closed (SIGINT).');
             if (server && server.listening) {
                server.close(() => {
                    console.log('[SERVER] HTTP server closed (SIGINT).');
                    process.exit(0);
                });
            } else { process.exit(0); }
        });
    } else if (server && server.listening) {
         server.close(() => {
            console.log('[SERVER] HTTP server closed (SIGINT, no IO).');
            process.exit(0);
        });
    } else { process.exit(0); }
    setTimeout(() => { console.error('[SERVER] Graceful shutdown timeout (SIGINT). Forcing exit.'); process.exit(1); }, closeTimeout).unref();
});
