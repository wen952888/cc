// authManager.js
const fs = require('fs');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const USERS_FILE = './users.json'; // 存储用户数据的文件路径
const saltRounds = 10; // bcrypt 哈希轮数
let users = {}; // 内存中的用户数据缓存 { phoneNumber: { userId, passwordHash, username } }

// 从文件加载用户数据到内存
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            if (data && data.trim() !== "") { // 确保文件不是空的或只包含空白
                users = JSON.parse(data);
                console.log(`[AUTH] 从 ${USERS_FILE} 加载了 ${Object.keys(users).length} 个用户。`);
            } else {
                console.log(`[AUTH] ${USERS_FILE} 为空或只包含空白。从空用户列表开始。`);
                users = {};
            }
        } else {
            console.log(`[AUTH] 未找到 ${USERS_FILE}。将会在首次保存时创建。从空用户列表开始。`);
            users = {};
        }
    } catch (e) {
        console.error(`[AUTH] 从 ${USERS_FILE} 加载用户时出错:`, e.message);
        if (e instanceof SyntaxError) {
            console.error(`[AUTH] 警告: ${USERS_FILE} 包含无效的 JSON。请检查文件内容或删除它以重新开始。`);
        }
        users = {}; // 如果加载出错，则从空列表开始，防止程序崩溃
    }
}

// 将内存中的用户数据保存到文件
function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        // console.log(`[AUTH] 用户数据已保存到 ${USERS_FILE}. 总用户数: ${Object.keys(users).length}`);
    } catch (e) {
        console.error('[AUTH] 保存用户数据时出错:', e.message, e.stack);
    }
}

// 通过 userId 查找用户（主要用于重新认证）
function findUserById(userIdToFind) {
    for (const phone in users) {
        if (users.hasOwnProperty(phone) && users[phone] && users[phone].userId === userIdToFind) {
            return { 
                userId: users[phone].userId, 
                username: users[phone].username,
                // phoneNumber: phone, // 可选，用于调试或上下文
                // passwordHash: users[phone].passwordHash // 通常不需要返回密码哈希给调用者
            };
        }
    }
    return null;
}


function init(socket) {
    // 处理用户注册请求
    socket.on('register', async (data, callback) => {
        if (typeof callback !== 'function') { console.error("[AUTH REG] 注册事件缺少回调函数。"); return; }
        const { phoneNumber, password } = data;

        if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.trim().length === 0 ||
            !password || typeof password !== 'string' || password.length < 4) {
            return callback({ success: false, message: '需要有效的手机号和至少4位数的密码。' });
        }
        const trimmedPhoneNumber = phoneNumber.trim();
        if (users[trimmedPhoneNumber]) {
            return callback({ success: false, message: '该手机号已被注册。' });
        }

        try {
            const passwordHash = await bcrypt.hash(password, saltRounds);
            const userId = uuidv4();
            const username = `用户${trimmedPhoneNumber.slice(-4)}`; // 例如 "用户1234"
            users[trimmedPhoneNumber] = { userId, passwordHash, username };
            saveUsers();
            console.log(`[AUTH REG] 用户注册成功: ${username} (手机号: ${trimmedPhoneNumber}), 用户ID: ${userId}`);
            callback({ success: true, message: '注册成功！请登录。' });
        } catch (error) {
            console.error('[AUTH REG] 注册过程中发生错误:', error);
            callback({ success: false, message: '注册过程中发生服务器内部错误。' });
        }
    });

    // 处理用户登录请求
    socket.on('login', async (data, callback) => {
        if (typeof callback !== 'function') { console.error("[AUTH LOGIN] 登录事件缺少回调函数。"); return; }
        const { phoneNumber, password } = data;

        if (!phoneNumber || !password) {
            return callback({ success: false, message: '需要手机号和密码。' });
        }

        const trimmedPhoneNumber = phoneNumber.trim();
        const userData = users[trimmedPhoneNumber];
        if (!userData) {
            return callback({ success: false, message: '用户不存在或手机号错误。' });
        }
        if (!userData.passwordHash) { // 数据完整性检查
            console.error(`[AUTH LOGIN] 用户 ${trimmedPhoneNumber} 数据异常: 缺少 passwordHash。`);
            return callback({ success: false, message: '账户数据异常，请联系管理员。'});
        }

        try {
            const match = await bcrypt.compare(password, userData.passwordHash);
            if (match) {
                socket.userId = userData.userId;
                socket.username = userData.username;
                console.log(`[AUTH LOGIN] 用户登录成功: ${socket.username} (ID: ${socket.userId}), Socket: ${socket.id}`);
                
                const roomManager = require('./roomManager'); // 延迟加载以避免循环依赖
                roomManager.handleAuthentication(socket); // 通知 roomManager 该 socket 已认证

                const previousRoom = roomManager.findRoomByUserId(socket.userId);
                let roomStatePayload = null;
                let loginMessage = '登录成功！';

                if (previousRoom && previousRoom.status !== 'archived') {
                     console.log(`[AUTH LOGIN] 用户 ${socket.username} 之前在房间 ${previousRoom.roomId} (${previousRoom.roomName})。尝试重连...`);
                     const rejoinResult = roomManager.handleReconnect(socket, previousRoom.roomId);
                     if (rejoinResult.success) {
                         roomStatePayload = rejoinResult.roomState;
                         loginMessage = '登录并成功重新加入之前的房间！';
                         socket.roomId = previousRoom.roomId; // 确保 socket 对象上有当前房间ID
                     } else {
                         loginMessage = `登录成功，但重新加入房间失败: ${rejoinResult.message || '房间可能已关闭或发生错误'}`;
                         // 此时用户已登录但未在房间内，客户端应导航到大厅
                         socket.emit('roomListUpdate', roomManager.getPublicRoomList()); // 主动推一次房间列表
                     }
                } else {
                    // 用户登录成功，但之前不在任何房间，或房间已归档
                    socket.emit('roomListUpdate', roomManager.getPublicRoomList()); // 主动推一次房间列表
                }
                callback({ success: true, message: loginMessage, userId: userData.userId, username: userData.username, roomState: roomStatePayload });
            } else {
                callback({ success: false, message: '密码错误。' });
            }
        } catch (error) {
            console.error('[AUTH LOGIN] 登录过程中发生错误:', error);
            callback({ success: false, message: '登录过程中发生服务器验证错误。' });
        }
    });

    // 处理客户端存储的用户ID进行重新认证
    socket.on('reauthenticate', (storedUserId, callback) => {
        if (typeof callback !== 'function') { console.error("[AUTH REAUTH] 重认证事件缺少回调函数。"); return; }
        console.log(`[AUTH REAUTH] 收到重认证请求，用户ID: ${storedUserId}, Socket: ${socket.id}`);
        
        if (!storedUserId) {
            return callback({ success: false, message: '无效的用户凭证。'});
        }
        const userData = findUserById(storedUserId); // 使用辅助函数查找

        if (userData) {
            socket.userId = userData.userId;
            socket.username = userData.username;
            console.log(`[AUTH REAUTH] 用户重认证成功: ${socket.username} (ID: ${socket.userId}), Socket: ${socket.id}`);

            const roomManager = require('./roomManager'); 
            roomManager.handleAuthentication(socket);

            const previousRoom = roomManager.findRoomByUserId(socket.userId);
            let roomStatePayload = null;
            let reauthMessage = '重新认证成功！';

            if (previousRoom && previousRoom.status !== 'archived') {
                 console.log(`[AUTH REAUTH] 用户 ${socket.username} 之前在房间 ${previousRoom.roomId} (${previousRoom.roomName})。尝试重连...`);
                 const rejoinResult = roomManager.handleReconnect(socket, previousRoom.roomId);
                 if (rejoinResult.success) {
                     roomStatePayload = rejoinResult.roomState;
                     reauthMessage = '重新认证并成功加入之前的房间！';
                     socket.roomId = previousRoom.roomId;
                 } else {
                     reauthMessage = `重新认证成功，但重新加入房间 "${previousRoom.roomName}" 失败: ${rejoinResult.message || '房间可能已关闭或发生错误'}`;
                     socket.emit('roomListUpdate', roomManager.getPublicRoomList());
                 }
            } else {
                // 用户重认证成功，但之前不在任何房间，或房间已归档
                socket.emit('roomListUpdate', roomManager.getPublicRoomList());
            }
            
            callback({
                success: true,
                message: reauthMessage,
                userId: userData.userId,
                username: userData.username,
                roomState: roomStatePayload // 可能是 null
            });

        } else {
            console.log(`[AUTH REAUTH] 重认证失败: 未找到用户ID ${storedUserId}。`);
            callback({ success: false, message: '无效的用户凭证或会话已过期，请重新登录。' });
        }
    });
}

module.exports = {
    init,
    loadUsers,
    saveUsers, // 导出以备其他模块（如管理脚本）可能需要
    findUserById // 导出以备其他模块可能需要
};
