// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const authManager = require('./authManager');
const roomManager = require('./roomManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');

const PORT = process.env.PORT || 23502;

console.log("--- [SERVER] Startup Configuration ---");
console.log(`Initial process.env.PORT: ${process.env.PORT}`);
const nodeEnv = process.env.NODE_ENV || 'development';
console.log(`NODE_ENV: ${nodeEnv}`);
console.log(`Effective port chosen for listening: ${PORT}`);
console.log("------------------------------------");

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Load user data on startup
authManager.loadUsers();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`[SERVER] Client connected: ${socket.id}`);

    authManager.init(socket);
    roomManager.init(socket, io);

    // 添加语音消息处理
    socket.on('sendVoiceMessage', (data) => {
        const { roomId, audioBlob } = data;
        console.log(`[SERVER] Received voice message from ${socket.id} for room ${roomId}.`);

        // 查找房间
        const room = roomManager.getRoomById(roomId); // 假设 roomManager 有 getRoomById 方法
        if (room) {
            // 广播语音消息给房间内除发送者外的其他玩家
            socket.to(roomId).emit('receiveVoiceMessage', { userId: socket.userId, audioBlob: audioBlob }); // 假设 socket.userId 已经被 authManager 设置
            console.log(`[SERVER] Broadcasting voice message to room ${roomId}.`);
        } else {
            console.warn(`[SERVER] Room ${roomId} not found for voice message.`);
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

process.on('SIGINT', () => {
    console.log('[SERVER] Shutting down...');
    server.close(() => {
        console.log('[SERVER] Server closed.');
        process.exit(0);
    });
});
