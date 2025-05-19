// authManager.js
const fs = require('fs');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');

const USERS_FILE = './users.json'; // Path relative to server.js
const saltRounds = 10;
let users = {}; // In-memory user data: { phoneNumber: { userId, passwordHash, username } }

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            if (data && data.trim() !== "") { // Ensure file is not empty or just whitespace
                users = JSON.parse(data);
                console.log(`[AUTH] Loaded ${Object.keys(users).length} users from ${USERS_FILE}`);
            } else {
                console.log(`[AUTH] ${USERS_FILE} is empty or contains only whitespace. Initializing with empty user list.`);
                users = {};
            }
        } else {
            console.log(`[AUTH] ${USERS_FILE} not found. Will be created on first save. Initializing with empty user list.`);
            users = {}; // Initialize as empty if file doesn't exist
        }
    } catch (e) {
        console.error(`[AUTH] Error loading users from ${USERS_FILE}:`, e.message);
        if (e instanceof SyntaxError) {
            console.error(`[AUTH] CRITICAL: ${USERS_FILE} contains invalid JSON. Please check its content or delete the file to start fresh.`);
        }
        // In case of error (e.g., malformed JSON), start with an empty user list to prevent crash
        users = {};
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        // console.log(`[AUTH] Users data saved to ${USERS_FILE}. Total users: ${Object.keys(users).length}`);
    } catch (e) {
        console.error('[AUTH] Error saving users:', e.message, e.stack);
    }
}

// Helper to find user by their unique userId (used in reauthentication)
function findUserByStoredId(userIdToFind) {
    for (const phone in users) {
        if (users.hasOwnProperty(phone) && users[phone] && users[phone].userId === userIdToFind) {
            return { // Return a copy of user data relevant for auth
                userId: users[phone].userId,
                username: users[phone].username,
                phoneNumber: phone, // For logging or context
                passwordHash: users[phone].passwordHash // Though not directly used by reauth itself
            };
        }
    }
    return null;
}


function init(socket) {
    socket.on('register', async (data, callback) => {
        if (typeof callback !== 'function') { 
            console.error(`[AUTH SERVER REG] CRITICAL: No callback for 'register' from socket ${socket.id}`); 
            return; 
        }
        const { phoneNumber, password } = data;
        console.log(`[AUTH SERVER REG] Received 'register' for phoneNumber: ${phoneNumber}`);

        if (!phoneNumber || typeof phoneNumber !== 'string' || phoneNumber.trim().length < 5) { // Basic validation
            return callback({ success: false, message: '手机号无效或过短。' });
        }
        if (!password || typeof password !== 'string' || password.length < 4) {
            return callback({ success: false, message: '密码至少需要4位。' });
        }

        const trimmedPhoneNumber = phoneNumber.trim();
        if (users[trimmedPhoneNumber]) {
            console.log(`[AUTH SERVER REG] Attempt for existing phoneNumber: "${trimmedPhoneNumber}"`);
            return callback({ success: false, message: '该手机号已被注册。' });
        }

        try {
            const passwordHash = await bcrypt.hash(password, saltRounds);
            const userId = uuidv4();
            const username = `玩家${trimmedPhoneNumber.slice(-4)}`; // Default username e.g., "玩家1234"
            users[trimmedPhoneNumber] = { userId, passwordHash, username };
            saveUsers(); // Save after new registration
            console.log(`[AUTH SERVER REG] User registered: ${username} (Phone: ${trimmedPhoneNumber}, ID: ${userId})`);
            callback({ success: true, message: '注册成功！请使用手机号和密码登录。' });
        } catch (error) {
            console.error('[AUTH SERVER REG] bcrypt.hash error or other:', error.message, error.stack);
            callback({ success: false, message: '注册过程中发生服务器内部错误。' });
        }
    });

    socket.on('login', async (data, callback) => {
        if (typeof callback !== 'function') { 
            console.error(`[AUTH SERVER LOGIN] CRITICAL: No callback for 'login' from socket ${socket.id}`); 
            return; 
        }
        const { phoneNumber, password } = data;
        console.log(`[AUTH SERVER LOGIN] Received 'login' for phoneNumber: ${phoneNumber}`);

        if (!phoneNumber || typeof phoneNumber !== 'string' || !password) {
            return callback({ success: false, message: '手机号和密码均不能为空。' });
        }

        const trimmedPhoneNumber = phoneNumber.trim();
        const userData = users[trimmedPhoneNumber];

        if (!userData) {
            console.log(`[AUTH SERVER LOGIN] Failed: User not found for phoneNumber: "${trimmedPhoneNumber}"`);
            return callback({ success: false, message: '手机号或密码错误。' });
        }

        if (!userData.passwordHash || typeof userData.passwordHash !== 'string') {
            console.error(`[AUTH SERVER LOGIN] Failed: Invalid or missing passwordHash for user "${trimmedPhoneNumber}". UserData:`, JSON.stringify(userData));
            return callback({ success: false, message: '账户数据异常，请联系管理员。' });
        }

        try {
            const match = await bcrypt.compare(password, userData.passwordHash);
            if (match) {
                socket.userId = userData.userId;
                socket.username = userData.username;
                console.log(`[AUTH SERVER LOGIN] Success: ${socket.username} (ID: ${socket.userId}), Socket: ${socket.id}`);
                
                const roomManager = require('./roomManager'); // Lazy load to avoid circular deps
                roomManager.handleAuthentication(socket); // Notify roomManager (optional, if it needs to do something globally)

                const previousRoom = roomManager.findRoomByUserId(socket.userId);
                let roomStatePayload = null;
                let loginMessage = '登录成功！';

                if (previousRoom && previousRoom.status !== 'archived') {
                    console.log(`[AUTH SERVER LOGIN] User ${socket.username} was in room ${previousRoom.roomId}. Attempting reconnect.`);
                    const rejoinResult = roomManager.handleReconnect(socket, previousRoom.roomId);
                    if (rejoinResult && rejoinResult.success) {
                        roomStatePayload = rejoinResult.roomState;
                        loginMessage = '登录并重新加入房间成功！';
                        socket.roomId = previousRoom.roomId; // Ensure socket has roomId
                    } else {
                        loginMessage = `登录成功，但重新加入房间失败: ${rejoinResult ? rejoinResult.message : '房间可能已关闭或发生错误'}`;
                        // Client should be directed to lobby if rejoin fails
                    }
                }
                callback({ success: true, message: loginMessage, userId: userData.userId, username: userData.username, roomState: roomStatePayload });
            } else {
                console.log(`[AUTH SERVER LOGIN] Failed: Password mismatch for user: "${trimmedPhoneNumber}"`);
                callback({ success: false, message: '手机号或密码错误。' });
            }
        } catch (error) {
            console.error('[AUTH SERVER LOGIN] bcrypt.compare error or other:', error.message, error.stack);
            callback({ success: false, message: '登录过程中发生服务器验证错误。' });
        }
    });

    socket.on('reauthenticate', (storedUserId, callback) => {
        if (typeof callback !== 'function') { 
            console.error(`[AUTH SERVER REAUTH] CRITICAL: No callback for 'reauthenticate' from socket ${socket.id}`); 
            return; 
        }
        console.log(`[AUTH SERVER REAUTH] Received 'reauthenticate' for userId: ${storedUserId} from socket: ${socket.id}`);

        if (!storedUserId || typeof storedUserId !== 'string') {
            console.warn(`[AUTH SERVER REAUTH] Failed for socket ${socket.id}: Invalid/missing userId. Value:`, storedUserId);
            return callback({ success: false, message: '无效的用户凭证。' });
        }

        const userData = findUserByStoredId(storedUserId); // Uses helper to find by userId

        if (userData && userData.userId && userData.username) { // User found
            socket.userId = userData.userId;
            socket.username = userData.username;
            console.log(`[AUTH SERVER REAUTH] Success: ${socket.username} (Phone: ${userData.phoneNumber}, UserID: ${socket.userId}), Socket: ${socket.id}`);

            const roomManager = require('./roomManager'); // Lazy load
            roomManager.handleAuthentication(socket);

            const previousRoom = roomManager.findRoomByUserId(socket.userId);
            let roomStatePayload = null;
            let reauthMessage = '重新认证成功！';

            if (previousRoom && previousRoom.status !== 'archived') {
                 console.log(`[AUTH SERVER REAUTH] User ${socket.username} was previously in room ${previousRoom.roomId}. Attempting reconnect.`);
                 const rejoinResult = roomManager.handleReconnect(socket, previousRoom.roomId);
                 if (rejoinResult && rejoinResult.success) {
                     roomStatePayload = rejoinResult.roomState;
                     reauthMessage = '重新认证并成功加入房间！';
                     socket.roomId = previousRoom.roomId; // Ensure socket has roomId
                     console.log(`[AUTH SERVER REAUTH] Rejoin to room ${previousRoom.roomId} successful for ${socket.username}.`);
                 } else {
                     reauthMessage = `重新认证成功，但重新加入房间 ${previousRoom.roomName || previousRoom.roomId} 失败: ${rejoinResult ? rejoinResult.message : '房间不再有效或发生错误'}`;
                     console.warn(`[AUTH SERVER REAUTH] Rejoin to room ${previousRoom.roomId} failed for ${socket.username}: ${rejoinResult ? rejoinResult.message : 'Rejoin failed'}`);
                 }
            } else {
                console.log(`[AUTH SERVER REAUTH] User ${socket.username} not found in any active room after reauthentication.`);
            }
            
            const responsePayload = {
                success: true, message: reauthMessage,
                userId: userData.userId, username: userData.username,
                roomState: roomStatePayload // Can be null if no room or rejoin failed
            };
            callback(responsePayload);
        } else {
            console.warn(`[AUTH SERVER REAUTH] Failed for socket ${socket.id}: userId "${storedUserId}" not found or data incomplete.`);
            callback({ success: false, message: '用户凭证无效或会话已过期，请重新登录。' });
        }
    });
}

module.exports = {
    init,
    loadUsers,
    // saveUsers // Not typically needed by other modules, but good for potential admin tools/scripts
};
