// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const authManager = require('./authManager');
const roomManager = require('./roomManager');

const app = express();
const server = http.createServer(app);

// Socket.IO 服务器实例，移除了显式的 CORS 配置。
// 默认情况下，它将允许来自提供 HTML 的同一来源的连接。
// 如果前端和后端在不同域或端口，并且通过反向代理访问，
// 确保代理正确设置了 Origin 和其他必要的头部。
// 如果仍然遇到CORS问题，需要像之前一样添加 cors 配置：
// cors: { origin: "https://your-client-domain.com", methods: ["GET", "POST"] }
const io = new Server(server);

app.disable('x-powered-by'); // 安全性考虑

const PORT = process.env.PORT || 16141; // 修改端口

console.log("--- [SERVER] Startup Configuration ---");
const nodeEnv = process.env.NODE_ENV || 'development';
console.log(`NODE_ENV: ${nodeEnv}`);
console.log(`Effective port chosen for listening (internally): ${PORT}`);
console.log("------------------------------------");

// Serve static files from the 'public' directory
// 确保 'public' 文件夹在项目根目录下，并且包含 index.html, style.css, client.js 和 images/ 文件夹
app.use(express.static(path.join(__dirname, 'public')));

// Load user data on startup
authManager.loadUsers();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`[SERVER] Client connected: ${socket.id}`);

    // 初始化该 socket 的认证和房间/游戏事件处理器
    authManager.init(socket);
    roomManager.init(socket, io); // 传递 io 实例以供广播

    // 语音消息处理 (来自您之前的 server.js，保持不变)
    // 注意：client.js 中也需要有对应的 sendVoiceMessage 和 receiveVoiceMessage 逻辑
    socket.on('sendVoiceMessage', (data) => {
        if (!socket.userId) {
            console.warn(`[SERVER VOICE] Unauthorized voice message attempt from socket ${socket.id}. User not authenticated.`);
            return;
        }
        const { roomId, audioBlob } = data;
        const userId = socket.userId;
        const username = socket.username || 'UnknownUser';
        console.log(`[SERVER VOICE] Received voice message from ${username} (ID: ${userId}, Socket: ${socket.id}) for room ${roomId}. Blob size: ${audioBlob ? audioBlob.size : 'N/A'}`);

        const room = roomManager.getRoomById(roomId); // roomManager 需要有 getRoomById 方法
        if (room) {
            const playerInRoom = room.players.find(p => p.userId === userId && p.connected);
            if (!playerInRoom) {
                console.warn(`[SERVER VOICE] User ${username} (ID: ${userId}) attempted to send voice to room ${roomId}, but is not a connected member of this room.`);
                return;
            }
            if (audioBlob && audioBlob.size > 0) {
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
        roomManager.handleDisconnect(socket); // roomManager 处理断开连接的逻辑
    });

    // 初始房间列表发送 (client.js 中也有请求逻辑，这里作为备用或补充)
    // socket.emit('roomListUpdate', roomManager.getPublicRoomList());
});

server.listen(PORT, '0.0.0.0', () => { // 监听 0.0.0.0 以允许外部连接（通过代理）
    console.log(`[SERVER] Server running and listening on 0.0.0.0:${PORT} (internal port)`);
    if (nodeEnv === 'production') {
         console.log(`[SERVER] Production mode: Ensure your reverse proxy (e.g., on Serv00) correctly forwards requests from your public domain to this internal port.`);
    } else {
         console.log(`[SERVER] Development mode: Access typically via http://localhost:${PORT} or local IP.`);
    }
});

// 优雅关停处理 (保持不变)
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
