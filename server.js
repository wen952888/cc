// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const authManager = require('./authManager');
const roomManager = require('./roomManager');

const app = express();
const server = http.createServer(app);

const YOUR_CLIENT_FACING_URL = "https://9525.ip-ddns.com"; // <--- 修改这里

const io = new Server(server, {
    pingTimeout: 60000,    // 客户端在60秒内未发送 PONG 包则认为连接超时
    pingInterval: 25000,   // 服务器每25秒发送一个 PING 包
    transports: ['websocket', 'polling'], // 明确指定传输方式，优先 WebSocket
    // CORS 配置:
    cors: {
        origin: YOUR_CLIENT_FACING_URL,
        // 如果你本地开发也需要连接这个服务器，可以像这样允许多个源:
        // origin: ["http://localhost:YOUR_LOCAL_CLIENT_PORT", YOUR_CLIENT_FACING_URL],
        methods: ["GET", "POST"],
        // allowedHeaders: ["my-custom-header"], // 如果客户端发送了自定义头部
        // credentials: true // 如果需要 cookie 或授权头部跨域
    }
});

app.disable('x-powered-by'); // 安全性考虑，移除 Express 的标识

const PORT = process.env.PORT || 23502;

console.log("--- [SERVER] Startup Configuration ---");
const nodeEnv = process.env.NODE_ENV || 'development';
console.log(`NODE_ENV: ${nodeEnv}`);
console.log(`Effective port chosen for listening: ${PORT}`);
console.log("------------------------------------");

// Serve static files from the 'public' directory with caching headers
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: nodeEnv === 'development' ? '0' : '7d',
    etag: true,
    lastModified: true
}));

// Load user data on startup
authManager.loadUsers();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`[SERVER] Client connected: ${socket.id}`);

    authManager.init(socket);
    roomManager.init(socket, io);

    socket.on('sendVoiceMessage', (data) => {
        const { roomId, audioBlob } = data;
        const userId = socket.userId || 'UnknownUser';
        console.log(`[SERVER] Received voice message from ${userId} (Socket: ${socket.id}) for room ${roomId}.`);

        const room = roomManager.getRoomById(roomId);
        if (room) {
            if (audioBlob && audioBlob.size > 0) {
                socket.to(roomId).emit('receiveVoiceMessage', { userId: userId, audioBlob: audioBlob });
                console.log(`[SERVER] Broadcasting voice message to room ${roomId} from ${userId}.`);
            } else {
                console.warn(`[SERVER] Received empty or invalid audioBlob for room ${roomId} from ${userId}.`);
            }
        } else {
            console.warn(`[SERVER] Room ${roomId} not found for voice message from ${userId}.`);
        }
    });

    socket.on('disconnect', (reason) => {
        console.log(`[SERVER] Client disconnected: ${socket.id}. Reason: ${reason}`);
        roomManager.handleDisconnect(socket);
    });

    socket.emit('roomListUpdate', roomManager.getPublicRoomList());
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Server running and listening on 0.0.0.0:${PORT}`);
    if (nodeEnv === 'production') {
         console.log(`[SERVER] On production, access via your assigned domain/URL.`);
    }
});

process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION! Server is shutting down...', error.name, error.message, error.stack);
    if (io) {
        io.close(() => {
            console.log('[SERVER] Socket.IO connections closed due to uncaught exception.');
            process.exit(1);
        });
    } else {
        process.exit(1);
    }
    setTimeout(() => {
        console.error('[SERVER] Graceful shutdown on uncaughtException timed out. Forcing exit.');
        process.exit(1);
    }, 5000).unref();
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED PROMISE REJECTION!');
    console.error('Reason:', reason);
    console.error('Promise:', promise);
});

process.on('SIGINT', () => {
    console.log('[SERVER] SIGINT signal received. Shutting down gracefully...');
    io.close(() => {
        console.log('[SERVER] Socket.IO connections closed.');
        server.close(() => {
            console.log('[SERVER] HTTP server closed.');
            process.exit(0);
        });
    });
    setTimeout(() => {
        console.error('[SERVER] Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 10000).unref();
});
