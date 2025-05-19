// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const authManager = require('./authManager');
const roomManager = require('./roomManager');

const app = express();
const server = http.createServer(app);

// Socket.IO 服务器初始化配置
const io = new Server(server, {
    pingTimeout: 60000,    // 客户端在60秒内未发送 PONG 包则认为连接超时 (默认 5000ms)
    pingInterval: 25000,   // 服务器每25秒发送一个 PING 包 (默认 25000ms)
    transports: ['websocket', 'polling'], // 明确指定传输方式，优先 WebSocket
    // 如果您的客户端和服务器不在同一域名或端口（例如开发时），
    // 或者您通过一个与 Node.js 服务器不同的域名访问客户端，
    // 您可能需要配置 CORS：
    /*
    cors: {
        origin: "*", // 允许所有来源，生产环境建议指定具体的客户端域名
        // origin: "http://your-client-domain.com",
        // origin: ["http://localhost:xxxx", "http://actual-client-domain.com"],
        methods: ["GET", "POST"],
        allowedHeaders: ["my-custom-header"], // 如果有自定义头部
        credentials: true // 如果需要传递 cookie
    }
    */
});

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

    // 传递 io 实例给 roomManager
    authManager.init(socket); // authManager 可能也需要 io 实例，如果它直接发送消息的话
    roomManager.init(socket, io);

    socket.on('sendVoiceMessage', (data) => {
        const { roomId, audioBlob } = data;
        const userId = socket.userId || 'UnknownUser'; // 确保 socket.userId 存在
        console.log(`[SERVER] Received voice message from ${userId} (Socket: ${socket.id}) for room ${roomId}.`);

        const room = roomManager.getRoomById(roomId);
        if (room) {
            // 确保 audioBlob 是有效的数据
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

    // 初始加载时发送一次房间列表给连接的客户端
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
    io.close(() => { // 优雅关闭 Socket.IO 连接
        console.log('[SERVER] Socket.IO connections closed.');
        server.close(() => {
            console.log('[SERVER] HTTP server closed.');
            process.exit(0);
        });
    });
});
