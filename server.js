// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const authManager = require('./authManager');
const roomManager = require('./roomManager');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    pingTimeout: 60000,    // 客户端在60秒内未发送 PONG 包则认为连接超时
    pingInterval: 25000,   // 服务器每25秒发送一个 PING 包
    transports: ['websocket', 'polling'], // 明确指定传输方式，优先 WebSocket
    // CORS 配置:
    cors: {
        origin: "https://9525.ip-ddns.com", // 替换成你客户端实际访问的域名
        // 对于本地开发，你可能需要允许多个来源，例如:
        // origin: ["http://localhost:PORT_YOUR_CLIENT_USES_LOCALLY", "https://9525.ip-ddns.com"],
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
// 对于不经常更改的静态资源（如图片、CSS、客户端JS），设置较长的缓存时间
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: nodeEnv === 'development' ? '0' : '7d', // 开发模式不缓存或短缓存，生产模式缓存7天
    etag: true,           // 启用 ETag HTTP 头部
    lastModified: true    // 启用 Last-Modified HTTP 头部
}));

// Load user data on startup
authManager.loadUsers();

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`[SERVER] Client connected: ${socket.id}`);

    // 初始化认证和房间管理逻辑，传递必要的实例
    authManager.init(socket);
    roomManager.init(socket, io); // 确保 io 实例传递给 roomManager

    // 处理客户端发送的语音消息
    socket.on('sendVoiceMessage', (data) => {
        const { roomId, audioBlob } = data;
        const userId = socket.userId || 'UnknownUser'; // 从认证过的 socket 获取 userId
        console.log(`[SERVER] Received voice message from ${userId} (Socket: ${socket.id}) for room ${roomId}.`);

        const room = roomManager.getRoomById(roomId);
        if (room) {
            if (audioBlob && audioBlob.size > 0) { // 校验 audioBlob
                socket.to(roomId).emit('receiveVoiceMessage', { userId: userId, audioBlob: audioBlob });
                console.log(`[SERVER] Broadcasting voice message to room ${roomId} from ${userId}.`);
            } else {
                console.warn(`[SERVER] Received empty or invalid audioBlob for room ${roomId} from ${userId}.`);
            }
        } else {
            console.warn(`[SERVER] Room ${roomId} not found for voice message from ${userId}.`);
        }
    });

    // 处理客户端断开连接
    socket.on('disconnect', (reason) => {
        console.log(`[SERVER] Client disconnected: ${socket.id}. Reason: ${reason}`);
        roomManager.handleDisconnect(socket);
    });

    // 新客户端连接时，发送当前的房间列表
    socket.emit('roomListUpdate', roomManager.getPublicRoomList());
});

// 启动 HTTP 服务器
server.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Server running and listening on 0.0.0.0:${PORT}`);
    if (nodeEnv === 'production') {
         console.log(`[SERVER] On production, access via your assigned domain/URL.`);
    }
});

// 全局未捕获异常处理
process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION! Server is shutting down...', error.name, error.message, error.stack);
    // 尝试优雅关闭，但未捕获的异常通常表明程序处于不稳定状态
    if (io) {
        io.close(() => {
            console.log('[SERVER] Socket.IO connections closed due to uncaught exception.');
            process.exit(1); // 非正常退出
        });
    } else {
        process.exit(1); // 非正常退出
    }
    // 设置一个超时，以防关闭操作卡住
    setTimeout(() => {
        console.error('[SERVER] Graceful shutdown on uncaughtException timed out. Forcing exit.');
        process.exit(1);
    }, 5000).unref(); // 5秒超时, unref() 允许程序在超时前正常退出
});

// 全局未处理的 Promise Rejection 处理
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED PROMISE REJECTION!');
    console.error('Reason:', reason);
    console.error('Promise:', promise);
    // 根据您的策略，这里可以选择记录错误，或者也让进程退出
    // process.exit(1); // 如果您认为未处理的 rejection 是致命的
});

// 处理 SIGINT 信号 (例如 Ctrl+C) 实现优雅关机
process.on('SIGINT', () => {
    console.log('[SERVER] SIGINT signal received. Shutting down gracefully...');
    // 1. 关闭 Socket.IO 服务器，停止接受新连接并尝试关闭现有连接
    io.close(() => {
        console.log('[SERVER] Socket.IO connections closed.');
        // 2. 关闭 HTTP 服务器
        server.close(() => {
            console.log('[SERVER] HTTP server closed.');
            // 3. 退出进程
            process.exit(0); // 正常退出
        });
    });

    // 设置一个超时，以防优雅关机过程过长
    setTimeout(() => {
        console.error('[SERVER] Graceful shutdown timed out. Forcing exit.');
        process.exit(1); // 非正常退出
    }, 10000).unref(); // 10秒超时
});
