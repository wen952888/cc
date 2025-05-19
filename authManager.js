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
            if (data && data.trim() !== "") { // 确保文件不是空的或只包含空白
                users = JSON.parse(data);
                console.log(`[AUTH] Loaded ${Object.keys(users).length} users from ${USERS_FILE}`);
            } else {
                console.log(`[AUTH] ${USERS_FILE} is empty or contains only whitespace. Starting with empty user list.`);
                users = {};
            }
        } else {
            console.log(`[AUTH] ${USERS_FILE} not found. Starting with empty user list.`);
            users = {};
        }
    } catch (e) {
        console.error(`[AUTH] Error loading users from ${USERS_FILE}:`, e.message, e.stack);
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
        console.error('[AUTH] Error saving users:', e.message, e.stack);
    }
}

// 注意：这个函数在当前版本的 reauthenticate 中没有被直接使用，
// 但如果其他地方需要通过 userId 查找完整用户数据（包括密码哈希），可以保留。
// 为了 reauthenticate，我们直接遍历 users 对象。
function findUserById(userId) {
    for (const phone in users) {
        if (users[phone] && users[phone].userId === userId) {
            return {
                userId: users[phone].userId,
                username: users[phone].username,
                phoneNumber: phone, // 附加额外信息以便调试或使用
                passwordHash: users[phone].passwordHash // 附加额外信息
            };
        }
    }
    return null;
}


function init(socket) {
    socket.on('register', async (data, callback) => {
        const { phoneNumber, password } = data;
        console.log(`[AUTH SERVER] Received 'register' event for phoneNumber: ${phoneNumber}`);
        if (typeof callback !== 'function') { console.error(`[AUTH SERVER] CRITICAL: No callback for 'register' from socket ${socket.id}`); return; }

        if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0) {
            return callback({ success: false, message: '手机号不能为空。' });
        }
        if (!password || typeof password !== 'string' || password.length < 4) {
            return callback({ success: false, message: '密码至少需要4位。' });
        }

        const trimmedPhoneNumber = phoneNumber.trim();
        if (users[trimmedPhoneNumber]) {
            console.log(`[AUTH SERVER] Registration attempt for existing phoneNumber: "${trimmedPhoneNumber}"`);
            return callback({ success: false, message: '该手机号已被注册。' });
        }

        try {
            const passwordHash = await bcrypt.hash(password, saltRounds);
            const userId = uuidv4();
            const username = `用户${trimmedPhoneNumber.slice(trimmedPhoneNumber.length >= 4 ? -4 : 0)}`; // 生成默认用户名
            users[trimmedPhoneNumber] = { userId, passwordHash, username };
            saveUsers();
            console.log(`[AUTH SERVER] User registered: ${username} (Phone: ${trimmedPhoneNumber}, ID: ${userId})`);
            callback({ success: true, message: '注册成功！' });
        } catch (error) {
            console.error('[AUTH SERVER] Registration bcrypt.hash error or other error:', error.message, error.stack);
            callback({ success: false, message: '注册过程中发生服务器错误。' });
        }
    });

    socket.on('login', async (data, callback) => {
        const { phoneNumber, password } = data;
        console.log(`[AUTH SERVER] Received 'login' event for phoneNumber: ${phoneNumber}`);
        if (typeof callback !== 'function') { console.error(`[AUTH SERVER] CRITICAL: No callback for 'login' from socket ${socket.id}`); return; }

        if (!phoneNumber || typeof phoneNumber !== 'string' || !password) {
            return callback({ success: false, message: '需要手机号和密码。' });
        }

        const trimmedPhoneNumber = phoneNumber.trim();
        const userData = users[trimmedPhoneNumber];

        if (!userData) {
            console.log(`[AUTH SERVER] Login failed: User not found for phoneNumber: "${trimmedPhoneNumber}"`);
            return callback({ success: false, message: '手机号或密码错误。' });
        }

        if (!userData.passwordHash || typeof userData.passwordHash !== 'string') {
            console.error(`[AUTH SERVER] Login failed: Invalid or missing passwordHash for user "${trimmedPhoneNumber}".`);
            return callback({ success: false, message: '登录认证数据异常，请联系管理员。' });
        }

        try {
            const match = await bcrypt.compare(password, userData.passwordHash);
            if (match) {
                socket.userId = userData.userId;
                socket.username = userData.username;
                console.log(`[AUTH SERVER] User logged in: ${socket.username} (ID: ${socket.userId}), Socket: ${socket.id}`);
                
                const roomManager = require('./roomManager'); // 延迟加载以避免循环依赖
                roomManager.handleAuthentication(socket); // 通知 roomManager

                const previousRoom = roomManager.findRoomByUserId(socket.userId);
                let roomStatePayload = null;
                let loginMessage = '登录成功！';

                if (previousRoom) {
                    console.log(`[AUTH SERVER] User ${socket.username} was in room ${previousRoom.roomId}. Attempting reconnect.`);
                    const rejoinResult = roomManager.handleReconnect(socket, previousRoom.roomId);
                    if (rejoinResult && rejoinResult.success) {
                        roomStatePayload = rejoinResult.roomState;
                        loginMessage = '登录并重新加入房间成功！';
                    } else {
                        loginMessage = `登录成功，但重新加入房间失败: ${rejoinResult ? rejoinResult.message : '未知错误'}`;
                    }
                }
                callback({ success: true, message: loginMessage, userId: userData.userId, username: userData.username, roomState: roomStatePayload });
            } else {
                console.log(`[AUTH SERVER] Login failed: Password mismatch for user: "${trimmedPhoneNumber}"`);
                callback({ success: false, message: '手机号或密码错误。' });
            }
        } catch (error) {
            console.error('[AUTH SERVER] Login bcrypt.compare error or other critical error:', error.message, error.stack);
            callback({ success: false, message: '登录过程中发生服务器验证错误。' });
        }
    });

    socket.on('reauthenticate', (storedUserId, callback) => {
        console.log(`[AUTH SERVER] Received 'reauthenticate' event for userId: ${storedUserId} from socket: ${socket.id}`);

        if (typeof callback !== 'function') {
            console.error(`[AUTH SERVER] CRITICAL: No callback provided for 'reauthenticate' by socket ${socket.id}. Cannot respond to client.`);
            return; // 必须有回调才能响应客户端
        }

        if (!storedUserId || typeof storedUserId !== 'string') {
            console.warn(`[AUTH SERVER] Reauthentication failed for socket ${socket.id}: Invalid or missing userId provided by client. Value:`, storedUserId);
            return callback({ success: false, message: '无效的用户凭证 (ID格式错误或缺失)。' });
        }

        let userData = null;
        let userPhoneNumber = null; // 用于日志记录
        // 遍历用户数据查找匹配的 userId
        for (const phoneKey in users) {
            // 确保 users[phoneKey] 存在且有 userId 属性
            if (users.hasOwnProperty(phoneKey) && users[phoneKey] && users[phoneKey].userId === storedUserId) {
                userData = users[phoneKey];
                userPhoneNumber = phoneKey;
                break;
            }
        }

        if (userData && userData.userId && userData.username) { // 确保找到的用户数据是完整的
            socket.userId = userData.userId;
            socket.username = userData.username;
            console.log(`[AUTH SERVER] User reauthenticated successfully via stored ID: ${socket.username} (Phone: ${userPhoneNumber}, UserID: ${socket.userId}), Socket: ${socket.id}`);

            const roomManager = require('./roomManager'); // 延迟加载，避免循环依赖
            roomManager.handleAuthentication(socket); // 通知 roomManager 该 socket 已认证

            const previousRoom = roomManager.findRoomByUserId(socket.userId);
            let roomStatePayload = null;
            let reauthMessage = '重新认证成功！';

            if (previousRoom) {
                 console.log(`[AUTH SERVER] User ${socket.username} was previously in room ${previousRoom.roomId}. Attempting reconnect via roomManager.handleReconnect.`);
                 const rejoinResult = roomManager.handleReconnect(socket, previousRoom.roomId); // 这个函数也应该总是返回对象

                 if (rejoinResult && rejoinResult.success) {
                     roomStatePayload = rejoinResult.roomState; // rejoinResult.roomState 可能为 null 如果房间状态无法获取
                     reauthMessage = '重新认证并加入房间成功！';
                     console.log(`[AUTH SERVER] Rejoin to room ${previousRoom.roomId} successful for ${socket.username}.`);
                 } else {
                     // Reauth is success, but room rejoin failed or room no longer valid
                     reauthMessage = `重新认证成功，但重新加入房间 ${previousRoom.roomName || previousRoom.roomId} 失败: ${rejoinResult ? rejoinResult.message : '房间不再有效或内部错误'}`;
                     console.warn(`[AUTH SERVER] Rejoin to room ${previousRoom.roomId} failed for ${socket.username}: ${rejoinResult ? rejoinResult.message : 'No rejoin result or rejoin failed'}`);
                     // roomStatePayload 保持 null
                 }
            } else {
                console.log(`[AUTH SERVER] User ${socket.username} was not found in any active room after reauthentication.`);
                // reauthMessage 保持 "重新认证成功！"
                // roomStatePayload 保持 null
            }
            
            const responsePayload = {
                success: true,
                message: reauthMessage,
                userId: userData.userId,
                username: userData.username,
                roomState: roomStatePayload //可能是 null
            };
            console.log(`[AUTH SERVER] Sending reauthenticate SUCCESS callback to ${socket.username}. Payload:`, JSON.stringify(responsePayload));
            callback(responsePayload);

        } else {
            console.warn(`[AUTH SERVER] Reauthentication failed for socket ${socket.id}: userId "${storedUserId}" not found in current user data or data incomplete. Users object keys:`, Object.keys(users).length);
            // 如果需要，可以打印一部分 users 数据进行调试（注意隐私）
            // console.log('[AUTH SERVER] Current users data (sample):', JSON.stringify(Object.values(users).slice(0,2)));
            callback({ success: false, message: '无效的用户凭证或会话已过期，请重新登录。' });
        }
    });
}

module.exports = {
    init,
    loadUsers,
    saveUsers
    // findUserById, // 如果其他模块确实需要通过ID查找完整用户数据，则导出
};
