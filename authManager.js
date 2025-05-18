// authManager.js
const fs = require('fs');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const USERS_FILE = './users.json'; // 确保这个路径相对于 server.js 是正确的
const saltRounds = 10;
let users = {}; // 内存中的用户数据

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            if (data) { // 确保文件不是空的
                users = JSON.parse(data);
                console.log(`[AUTH] Loaded ${Object.keys(users).length} users from ${USERS_FILE}`);
            } else {
                console.log(`[AUTH] ${USERS_FILE} is empty. Starting with empty user list.`);
                users = {};
            }
        } else {
            console.log(`[AUTH] ${USERS_FILE} not found. Starting with empty user list.`);
            users = {};
        }
    } catch (e) {
        console.error(`[AUTH] Error loading users from ${USERS_FILE}:`, e.message);
        if (e instanceof SyntaxError) {
            console.error(`[AUTH] ${USERS_FILE} contains invalid JSON. Please check or delete the file.`);
        }
        users = {}; // 如果加载出错，则从空用户列表开始，防止程序崩溃
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        console.log(`[AUTH] Users data saved to ${USERS_FILE}. Total users: ${Object.keys(users).length}`);
    } catch (e) {
        console.error('[AUTH] Error saving users:', e);
    }
}

function findUserById(userId) {
    for (const phone in users) {
        if (users[phone].userId === userId) {
            return { userId: users[phone].userId, username: users[phone].username };
        }
    }
    return null;
}


function init(socket) {
    socket.on('register', async (data, callback) => {
        const { phoneNumber, password } = data;

        if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
            return callback({ success: false, message: '手机号不能为空。' });
        }
        if (!password || typeof password !== 'string' || password.length < 4) {
            return callback({ success: false, message: '密码至少需要4位。' });
        }

        const trimmedPhoneNumber = phoneNumber.trim();
        // 可以添加更严格的手机号格式校验，例如：
        // if (!/^\d{11}$/.test(trimmedPhoneNumber)) {
        //     return callback({ success: false, message: '请输入有效的11位手机号码。'});
        // }

        if (users[trimmedPhoneNumber]) {
            console.log(`[AUTH] Registration attempt for existing phoneNumber: "${trimmedPhoneNumber}"`);
            return callback({ success: false, message: '该手机号已被注册。' });
        }

        try {
            const passwordHash = await bcrypt.hash(password, saltRounds);
            const userId = uuidv4();
            const username = `用户${trimmedPhoneNumber.slice(trimmedPhoneNumber.length >= 4 ? -4 : 0)}`;
            users[trimmedPhoneNumber] = { userId, passwordHash, username };
            saveUsers();
            console.log(`[AUTH] User registered: ${username} (Phone: ${trimmedPhoneNumber}, ID: ${userId})`);
            callback({ success: true, message: '注册成功！' });
        } catch (error) {
            console.error('[AUTH] Registration bcrypt.hash error or other error:', error);
            callback({ success: false, message: '注册过程中发生服务器错误。' });
        }
    });

    socket.on('login', async (data, callback) => {
        const { phoneNumber, password } = data;
        if (!phoneNumber || typeof phoneNumber !== 'string' || !password) {
            return callback({ success: false, message: '需要手机号和密码。' });
        }

        const trimmedPhoneNumber = phoneNumber.trim();
        console.log(`[AUTH] Login attempt for phoneNumber: "${trimmedPhoneNumber}"`);

        const userData = users[trimmedPhoneNumber];
        if (!userData) {
            console.log(`[AUTH] Login failed: User not found for phoneNumber: "${trimmedPhoneNumber}"`);
            return callback({ success: false, message: '手机号或密码错误。' });
        }

        console.log(`[AUTH] User data found for "${trimmedPhoneNumber}": Username: ${userData.username}, UserID: ${userData.userId}, HasPasswordHash: ${!!userData.passwordHash}`);

        if (!userData.passwordHash || typeof userData.passwordHash !== 'string') {
            console.error(`[AUTH] Login failed: Invalid or missing passwordHash for user "${trimmedPhoneNumber}".`);
            return callback({ success: false, message: '登录认证数据异常，请联系管理员。' });
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
                console.log(`[AUTH] Login failed: Password mismatch for user: "${trimmedPhoneNumber}"`);
                callback({ success: false, message: '手机号或密码错误。' });
            }
        } catch (error) {
            console.error('[AUTH] Login bcrypt.compare error or other critical error:', error);
            callback({ success: false, message: '登录过程中发生服务器验证错误。' });
        }
    });

    socket.on('reauthenticate', (storedUserId, callback) => {
        console.log(`[AUTH] Reauthentication attempt for userId: ${storedUserId} on socket: ${socket.id}`);
        if (!storedUserId) {
            return callback({ success: false, message: '无效的用户凭证 (ID缺失)。' });
        }

        let userData = null;
        let userPhoneNumber = null; // 用于日志
        for (const phoneKey in users) {
            if (users[phoneKey].userId === storedUserId) {
                userData = users[phoneKey];
                userPhoneNumber = phoneKey;
                break;
            }
        }

        if (userData) {
            socket.userId = userData.userId;
            socket.username = userData.username;
            console.log(`[AUTH] User reauthenticated: ${socket.username} (Phone: ${userPhoneNumber}, ID: ${socket.userId}), Socket: ${socket.id}`);

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
                         message: `重新认证成功，但重加房间失败: ${rejoinResult.message || '未知错误'}`,
                         userId: userData.userId,
                         username: userData.username,
                         roomState: null
                     });
                     socket.emit('roomListUpdate', roomManager.getPublicRoomList()); // Still send room list
                 }
            } else {
                 callback({
                     success: true,
                     message: '重新认证成功！',
                     userId: userData.userId,
                     username: userData.username,
                     roomState: null
                 });
                 socket.emit('roomListUpdate', roomManager.getPublicRoomList());
            }
            // Ensure roomManager knows about this authenticated socket
            roomManager.handleAuthentication(socket);

        } else {
            console.log(`[AUTH] Reauthentication failed: userId ${storedUserId} not found in current user data.`);
            callback({ success: false, message: '无效的用户凭证或会话已过期。' });
        }
    });
}

module.exports = {
    init,
    loadUsers,
    saveUsers,
    findUserById
};
