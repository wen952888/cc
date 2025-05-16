const fs = require('fs');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const USERS_FILE = './users.json';
const saltRounds = 10;
let users = {};

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            users = JSON.parse(data);
            console.log(`[AUTH] Loaded ${Object.keys(users).length} users from ${USERS_FILE}`);
        } else {
            console.log(`[AUTH] ${USERS_FILE} not found. Starting with empty user list.`);
            users = {};
        }
    } catch (e) {
        console.error('[AUTH] Error loading users:', e);
        users = {};
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('[AUTH] Error saving users:', e);
    }
}

function findUserById(userId) {
    for (const phone in users) {
        if (users[phone].userId === userId) {
            // Return a copy of user data excluding sensitive info if needed
            return { userId: users[phone].userId, username: users[phone].username };
        }
    }
    return null;
}


function init(socket) {
    socket.on('register', async (data, callback) => {
        const { phoneNumber, password } = data;
        if (!phoneNumber || !password || typeof phoneNumber !== 'string' || typeof password !== 'string' || password.length < 4) {
            return callback({ success: false, message: '需要有效的手机号和至少4位密码。' });
        }
        if (users[phoneNumber]) {
            return callback({ success: false, message: '该手机号已被注册。' });
        }

        try {
            const passwordHash = await bcrypt.hash(password, saltRounds);
            const userId = uuidv4();
            const username = `用户${phoneNumber.slice(-4)}`;
            users[phoneNumber] = { userId, passwordHash, username };
            saveUsers();
            console.log(`[AUTH] User registered: ${username} (${phoneNumber}), ID: ${userId}`);
            callback({ success: true, message: '注册成功！' });
        } catch (error) {
            console.error('[AUTH] Registration error:', error);
            callback({ success: false, message: '注册过程中发生服务器错误。' });
        }
    });

    socket.on('login', async (data, callback) => {
        const { phoneNumber, password } = data;
        if (!phoneNumber || !password) {
            return callback({ success: false, message: '需要手机号和密码。' });
        }

        const userData = users[phoneNumber];
        if (!userData) {
            return callback({ success: false, message: '用户不存在或手机号错误。' });
        }

        try {
            const match = await bcrypt.compare(password, userData.passwordHash);
            if (match) {
                socket.userId = userData.userId;
                socket.username = userData.username;
                console.log(`[AUTH] User logged in: ${socket.username} (ID: ${socket.userId}), Socket: ${socket.id}`);
                callback({ success: true, message: '登录成功！', userId: userData.userId, username: userData.username });
                const roomManager = require('./roomManager');
                roomManager.handleAuthentication(socket);
            } else {
                callback({ success: false, message: '密码错误。' });
            }
        } catch (error) {
            console.error('[AUTH] Login error:', error);
            callback({ success: false, message: '登录过程中发生服务器错误。' });
        }
    });

    socket.on('reauthenticate', (storedUserId, callback) => {
        console.log(`[AUTH] Reauthentication attempt for userId: ${storedUserId} on socket: ${socket.id}`);
        let userData = null;
        // let userPhone = null; // Store the phone number for lookup (not strictly needed here)
        for (const phone in users) {
            if (users[phone].userId === storedUserId) {
                userData = users[phone];
                // userPhone = phone; // Found the user
                break;
            }
        }

        if (userData) {
            socket.userId = userData.userId;
            socket.username = userData.username;
            console.log(`[AUTH] User reauthenticated: ${socket.username} (ID: ${socket.userId}), Socket: ${socket.id}`);

            const roomManager = require('./roomManager');
            const previousRoom = roomManager.findRoomByUserId(socket.userId);

            if (previousRoom) {
                 console.log(`[AUTH] User ${socket.username} was previously in room ${previousRoom.roomId}`);
                 const rejoinResult = roomManager.handleReconnect(socket, previousRoom.roomId);
                 if (rejoinResult.success) {
                     callback({
                         success: true,
                         message: '重新认证并加入房间成功！',
                         userId: userData.userId,
                         username: userData.username,
                         roomState: rejoinResult.roomState
                     });
                 } else {
                     callback({
                         success: true, // Reauth itself was successful
                         message: '重新认证成功，但无法自动重加房间。',
                         userId: userData.userId,
                         username: userData.username,
                         roomState: null // Indicate no room state to restore immediately
                     });
                      // Send room list if couldn't rejoin
                     socket.emit('roomListUpdate', roomManager.getPublicRoomList());
                 }
            } else {
                 callback({
                     success: true,
                     message: '重新认证成功！',
                     userId: userData.userId,
                     username: userData.username,
                     roomState: null
                 });
                 // If not rejoining a room, send the general room list
                 socket.emit('roomListUpdate', roomManager.getPublicRoomList());
            }
            // Let room manager know about authenticated user (e.g., to update room list for this socket)
            roomManager.handleAuthentication(socket);

        } else {
            console.log(`[AUTH] Reauthentication failed: userId ${storedUserId} not found.`);
            callback({ success: false, message: '无效的用户凭证。' });
        }
    });
}

module.exports = {
    init,
    loadUsers,
    saveUsers,
    findUserById
};
