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

app.disable('x-powered-by'); // <<< 添加这一行

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

    socket.on('disconnect', (reason) => {
        console.log(`[SERVER] Client disconnected: ${socket.id}. Reason: ${reason}`);
        roomManager.handleDisconnect(socket);
    });

    // Send initial room list (can be moved to after auth if preferred)
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
