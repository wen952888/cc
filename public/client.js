// client.js
document.addEventListener('DOMContentLoaded', () => {
    const CLIENT_VERSION = "1.1.0";
    console.log(`[CLIENT] DOM loaded. KK Poker Client v${CLIENT_VERSION}. Attempting to connect to Socket.IO server...`);

    // io() will try to connect to the host that served the page.
    // If your server is elsewhere, you'd specify: const socket = io('https://your-socket-server.com');
    const socket = io({
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
        // transports: ['websocket', 'polling'] // Usually default is fine
    });

    // --- Global State ---
    let myUserId = null;
    let myUsername = null;
    let currentRoomId = null;
    let currentRoomState = null;
    let selectedCardsForPlay = [];
    let currentHintCards = null;
    let currentHintIndexFromServer = 0;
    let initialReauthAttempted = false;
    console.log(`[CLIENT INIT] initialReauthAttempted set to false.`);
    let isAi托管激活 = false;

    // --- DOM Elements (已在之前版本中定义，保持不变) ---
    const loadingView = document.getElementById('loadingView');
    const authView = document.getElementById('auth-view');
    const lobbyView = document.getElementById('lobby-view');
    const gameView = document.getElementById('game-view');
    const allViews = [loadingView, authView, lobbyView, gameView];
    const loadingMessage = document.getElementById('loadingMessage');
    // ... (其他所有DOM元素获取) ...
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const loginUsernameInput = document.getElementById('login-username');
    const loginPasswordInput = document.getElementById('login-password');
    const loginButton = document.getElementById('login-button');
    const registerUsernameInput = document.getElementById('register-username');
    const registerPasswordInput = document.getElementById('register-password');
    const registerButton = document.getElementById('register-button');
    const showRegisterLink = document.getElementById('show-register');
    const showLoginLink = document.getElementById('show-login');
    const authErrorElement = document.getElementById('authError');
    const roomNameInput = document.getElementById('roomNameInput');
    const roomPasswordInput = document.getElementById('roomPasswordInput');
    const createRoomButton = document.getElementById('createRoomButton');
    const roomsListUl = document.getElementById('rooms');
    const lobbyUsernameSpan = document.getElementById('lobbyUsername');
    const refreshRoomListButton = document.getElementById('refreshRoomListButton');
    const logoutButtonLobby = document.getElementById('logoutButtonLobby');
    const playerHandArea = document.getElementById('player-hand-area');
    const discardedCardsArea = document.getElementById('discarded-cards-area');
    const playButton = document.getElementById('play-button');
    const passButton = document.getElementById('pass-button');
    const hintButton = document.getElementById('hint-button');
    const micButton = document.getElementById('micButton');
    const leaveRoomButton = document.getElementById('leaveRoomButton');
    const readyButton = document.getElementById('ready-button');
    const infoBarRoomName = document.getElementById('infoBarRoomName');
    const infoBarRoomId = document.getElementById('infoBarRoomId');
    const infoBarRoomStatus = document.getElementById('infoBarRoomStatus');
    const infoBarCurrentTurn = document.getElementById('infoBarCurrentTurn');
    const aiToggleButton = document.getElementById('ai-toggle-button');
    const myInfoInBar = document.getElementById('my-info-in-bar');
    const lastHandTypeDisplay = document.getElementById('lastHandType');
    const gameOverOverlay = document.getElementById('gameOverOverlay');
    const gameOverTitle = document.getElementById('gameOverTitle');
    const gameOverReasonText = document.getElementById('gameOverReasonText');
    const gameOverScoresDiv = document.getElementById('gameOverScores');
    const backToLobbyBtnOverlay = gameOverOverlay.querySelector('#backToLobbyBtn');

    // --- Voice & Card GFX Constants (已在之前版本中定义，保持不变) ---
    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;
    const rankToImageNamePart = { 'A': 'ace', 'K': 'king', 'Q': 'queen', 'J': 'jack', 'T': '10', '9': '9', '8': '8', '7': '7', '6': '6', '5': '5', '4': '4', '3': '3', '2': '2' };
    const suitToImageNamePart = { 'S': 'spades', 'H': 'hearts', 'D': 'diamonds', 'C': 'clubs' };
    const CARD_IMAGE_EXTENSION = '.jpg';
    const CARD_BACK_IMAGE = 'back.jpg';
    const CARD_IMAGE_PATH = '/images/cards/';


    // --- Utility Functions (已在之前版本中定义，保持不变) ---
    function cardObjectToKey(card) { if (!card || typeof card.rank === 'undefined' || typeof card.suit === 'undefined') return null; return `${card.rank}${card.suit}`; }
    function showTemporaryMessage(message, duration = 3000, isError = false) { const toast = document.createElement('div'); toast.textContent = message; toast.style.cssText = `position:fixed; bottom:70px; left:50%; transform:translateX(-50%); background-color:${isError ? 'rgba(200,0,0,0.85)' : 'rgba(0,0,0,0.8)'}; color:white; padding:10px 20px; border-radius:6px; z-index:10001; font-size:0.9em; box-shadow: 0 3px 15px rgba(0,0,0,0.3); text-align:center; max-width: 80%;`; document.body.appendChild(toast); setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration); }
    function switchToView(targetViewId, messageForLoading = "加载中...") { /* console.log(`[VIEW CLIENT] Switching to: ${targetViewId}`); */ allViews.forEach(view => { if (view) { if (view.id === targetViewId) { view.classList.remove('hidden-view'); view.style.display = 'flex'; if (view.id === 'game-view') view.style.flexDirection = 'column'; } else { view.classList.add('hidden-view'); view.style.display = 'none'; } } }); if (targetViewId === 'loadingView' && loadingMessage) { loadingMessage.textContent = messageForLoading; } }
    function showAuthError(message) { if (authErrorElement) { authErrorElement.textContent = message; authErrorElement.style.display = 'block'; } else { showTemporaryMessage(message, 3000, true); console.error("Auth Error (UI element #authError missing):", message); } }
    function clearAuthError() { if (authErrorElement) { authErrorElement.textContent = ''; authErrorElement.style.display = 'none'; } }

    function handleAuthSuccess(data) {
        console.log("[AUTH CLIENT] Success data:", data);
        if (!data || !data.userId || !data.username) { console.error("[AUTH CLIENT] Invalid/incomplete auth success data:", data); showAuthError("认证数据不完整。"); switchToView('auth-view'); return; }
        myUserId = data.userId; myUsername = data.username;
        localStorage.setItem('userId', data.userId); localStorage.setItem('username', data.username);
        if (lobbyUsernameSpan) lobbyUsernameSpan.textContent = myUsername;
        clearAuthError(); console.log(`[AUTH CLIENT] Logged in: ${myUsername} (ID: ${myUserId})`);
        if (data.roomState && data.roomState.roomId) {
            currentRoomId = data.roomState.roomId; currentRoomState = data.roomState;
            console.log(`[AUTH CLIENT] Restoring to room ${currentRoomId}.`);
            displayGameState(data.roomState, true); switchToView('game-view');
        } else {
            currentRoomId = null; currentRoomState = null;
            switchToView('lobby-view');
            if (socket.connected) { console.log("[AUTH CLIENT] Requesting room list for lobby."); socket.emit('listRooms', updateRoomList); }
        }
    }
    function handleAuthResponse(response) {
        console.log('[AUTH CLIENT] Auth response (login/re-auth):', response);
        if (response && response.success) { handleAuthSuccess(response); }
        else { const errorMsg = response ? response.message : "认证失败，未知错误。"; showAuthError(errorMsg); localStorage.removeItem('userId'); localStorage.removeItem('username'); myUserId = null; myUsername = null; initialReauthAttempted = false; console.log(`[AUTH CLIENT] Auth failed, initialReauthAttempted reset to ${initialReauthAttempted}.`); switchToView('auth-view');}
    }
    
    // --- Socket Connection Handling ---
    switchToView('loadingView', "连接服务器...");
    const storedUserIdOnLoad = localStorage.getItem('userId');
    if (!storedUserIdOnLoad) {
        initialReauthAttempted = true; // No ID, so no initial reauth needed on first connect
        console.log(`[CLIENT INIT] No stored userId. initialReauthAttempted set to true.`);
    } else {
        console.log(`[CLIENT INIT] Found stored userId: ${storedUserIdOnLoad}. Reauth will be attempted if initialReauthAttempted is false.`);
    }

    socket.on('connect', () => {
        console.log(`[SOCKET CLIENT] Successfully connected to server. Socket ID: ${socket.id}. myUserId: ${myUserId}, initialReauthAttempted: ${initialReauthAttempted}`);
        const lsUserId = localStorage.getItem('userId');

        if (!myUserId && lsUserId && !initialReauthAttempted) {
            console.log("[SOCKET CLIENT] 'connect': Has lsUserId, session not active, initial reauth not yet attempted. Attempting reauthenticate.");
            initialReauthAttempted = true;
            console.log(`[SOCKET CLIENT] initialReauthAttempted set to true before emit reauthenticate.`);
            socket.emit('reauthenticate', lsUserId, handleAuthResponse);
        } else if (myUserId && currentRoomId) {
            console.log(`[SOCKET CLIENT] 'connect': Reconnected. User ${myUsername} was in room ${currentRoomId}. Requesting game state.`);
            switchToView('loadingView', "重新连接房间...");
            socket.emit('requestGameState', (state) => {
                if (state && state.roomId === currentRoomId) {
                    console.log("[SOCKET CLIENT] Reconnected in room, received valid game state:", state);
                    currentRoomState = state; displayGameState(state, false); switchToView('game-view');
                } else {
                    console.warn("[SOCKET CLIENT] Reconnected but failed to get valid game state for current room. Current:", currentRoomId, "Received:", state ? state.roomId : "null state");
                    showTemporaryMessage("重新加入房间失败或房间已不存在，将返回登录。", 4000, true);
                    currentRoomId = null; currentRoomState = null; myUserId = null; myUsername = null;
                    localStorage.removeItem('userId'); localStorage.removeItem('username');
                    initialReauthAttempted = false; // Allow reauth attempt again on next connect cycle
                    console.log(`[SOCKET CLIENT] Failed rejoin, initialReauthAttempted reset to ${initialReauthAttempted}.`);
                    switchToView('auth-view');
                }
            });
        } else if (myUserId && !currentRoomId) {
            console.log(`[SOCKET CLIENT] 'connect': Reconnected. User ${myUsername} was in lobby.`);
            switchToView('lobby-view');
            console.log("[SOCKET CLIENT] Requesting room list for lobby after reconnect.");
            socket.emit('listRooms', updateRoomList);
        } else {
             console.log(`[SOCKET CLIENT] 'connect': No active login (myUserId: ${myUserId}) or initial reauth already handled (initialReauthAttempted: ${initialReauthAttempted}).`);
             if (!myUserId) {
                console.log("[SOCKET CLIENT] Not logged in, ensuring auth view.");
                if (loadingView.style.display !== 'none' || gameView.style.display !== 'none' || lobbyView.style.display !== 'none') {
                    switchToView('auth-view');
                }
             }
             if (!initialReauthAttempted && lsUserId) {
                console.warn("[SOCKET CLIENT] 'connect': Edge case? lsUserId exists but initialReauthAttempted is false and myUserId is null. This shouldn't happen if logic is correct.");
             } else if (!lsUserId) {
                initialReauthAttempted = true; // Mark as true if no lsUserId, no reauth needed
                console.log(`[SOCKET CLIENT] No lsUserId, initialReauthAttempted set to ${initialReauthAttempted}.`);
             }
        }
    });

    socket.on('disconnect', (reason) => {
        console.warn(`[SOCKET CLIENT] Disconnected from server. Reason: ${reason}. myUserId: ${myUserId}, currentRoomId: ${currentRoomId}`);
        let message = '连接已断开，尝试重连...';
        if (reason === 'io server disconnect') { message = '服务器已关闭连接。'; }
        else if (reason === 'io client disconnect') { message = '您已断开连接。'; }
        
        showTemporaryMessage(message, (reason === 'io client disconnect' ? 2000 : 3000) , reason !== 'io client disconnect');
        switchToView('loadingView', message);
        // On disconnect, don't reset auth state immediately. Reconnect attempt might restore it.
        // 'initialReauthAttempted' state management on disconnect is tricky.
        // If it's a brief network blip, we want reauth. If it's a long disconnect, new connect cycle handles it.
        // For now, let connect handler manage initialReauthAttempted.
    });

    socket.on('connect_error', (err) => {
        console.error(`[SOCKET CLIENT] Connection error: Type: ${err.type}, Message: ${err.message}`, err.data || err);
        if (loadingMessage) loadingMessage.textContent = `连接错误 (${err.message}). 尝试重连...`;
    });

    socket.on('error', (error) => { // General errors from the server on this socket
        console.error('[SOCKET CLIENT] Received "error" event from server:', error);
        showTemporaryMessage(`服务器错误: ${typeof error === 'string' ? error : (error.message || '未知错误')}`, 3000, true);
    });


    // --- Auth View Listeners (已在之前版本中定义，保持不变) ---
    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); loginForm.style.display = 'none'; registerForm.style.display = 'block'; });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); registerForm.style.display = 'none'; loginForm.style.display = 'block'; });
    if (loginButton) loginButton.addEventListener('click', () => { clearAuthError(); const phone = loginUsernameInput.value.trim(); const pass = loginPasswordInput.value; if (!phone || !pass) { showAuthError("手机号和密码均不能为空。"); return; } console.log(`[AUTH CLIENT] Attempting login for: ${phone}`); socket.emit('login', { phoneNumber: phone, password: pass }, handleAuthResponse); });
    if (registerButton) registerButton.addEventListener('click', () => { clearAuthError(); const phone = registerUsernameInput.value.trim(); const pass = registerPasswordInput.value; if (!phone || pass.length < 4) { showAuthError("手机号不能为空，密码至少4位。"); return; } console.log(`[AUTH CLIENT] Attempting registration for: ${phone}`); socket.emit('register', { phoneNumber: phone, password: pass }, (response) => { showTemporaryMessage(response.message, 3000, !response.success); if (response.success) { loginForm.style.display = 'block'; registerForm.style.display = 'none'; loginUsernameInput.value = phone; loginPasswordInput.value = ""; loginPasswordInput.focus(); } else { showAuthError(response.message); } }); });

    // --- Lobby View Listeners (已在之前版本中定义，保持不变) ---
    if (createRoomButton) createRoomButton.addEventListener('click', () => { const roomName = roomNameInput.value.trim(); const password = roomPasswordInput.value; if (!roomName) { showTemporaryMessage("请输入房间名称。", 2000, true); return; } if (roomName.length > 10) { showTemporaryMessage("房间名称不能超过10个字符。", 2000, true); return; } if (password && password.length > 10) { showTemporaryMessage("房间密码不能超过10个字符。", 2000, true); return; } console.log(`[LOBBY CLIENT] Creating room: "${roomName}", Pwd: ${password ? 'Yes' : 'No'}`); socket.emit('createRoom', { roomName, password }, (response) => { console.log('[LOBBY CLIENT] Create room response:', response); if (response.success) { currentRoomId = response.roomId; currentRoomState = response.roomState; displayGameState(response.roomState); switchToView('game-view'); roomNameInput.value = ''; roomPasswordInput.value = ''; } else { showTemporaryMessage(`创建房间失败: ${response.message}`, 3000, true); } }); });
    if (refreshRoomListButton) { refreshRoomListButton.addEventListener('click', () => { if(socket.connected) { console.log("[LOBBY CLIENT] Refreshing room list manually..."); socket.emit('listRooms', updateRoomList); } else { showTemporaryMessage("网络未连接，无法刷新房间列表。", 2000, true); } }); }
    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => { console.log('[LOBBY CLIENT] Logging out...'); if (socket.connected) socket.disconnect(); localStorage.removeItem('userId'); localStorage.removeItem('username'); myUserId = null; myUsername = null; currentRoomId = null; currentRoomState = null; initialReauthAttempted = true; /* Mark as "logged out, no immediate reauth" */ console.log(`[LOBBY CLIENT] Logged out, initialReauthAttempted set to ${initialReauthAttempted}.`); switchToView('auth-view'); roomsListUl.innerHTML = '<li>请先登录查看房间列表</li>'; }); }
    function updateRoomList(rooms) { /* console.log("[UI CLIENT] updateRoomList called with rooms:", rooms); */ if (!roomsListUl) { console.warn("[UI CLIENT] roomsListUl element not found."); return; } roomsListUl.innerHTML = ''; if (rooms && Array.isArray(rooms) && rooms.length > 0) { rooms.forEach(room => { if (!room || typeof room.roomId === 'undefined') { console.warn("[UI CLIENT] Invalid room object in list:", room); return; } const li = document.createElement('li'); const maxP = room.maxPlayers || 4; const countP = room.playerCount || 0; const statusMap = { 'waiting': '等待中', 'playing': '游戏中', 'finished': '已结束' }; const statusTxt = statusMap[room.status] || room.status || '未知'; let joinBtnDisabled = room.status !== 'waiting' || countP >= maxP; let btnClass = room.hasPassword ? "join-room-btn-pwd" : "join-room-btn"; let btnText = "加入"; if (room.hasPassword && !joinBtnDisabled) {btnText = "加入 (有密码)";} else if (room.hasPassword && joinBtnDisabled) {btnText = "加入 (有密码)";} li.innerHTML = `<span>${room.roomName || `房间 ${room.roomId}`} (${countP}/${maxP}) - ${statusTxt} ${room.hasPassword ? '' : ''}</span> <button data-roomid="${room.roomId}" data-roomname="${room.roomName}" class="${btnClass}" ${joinBtnDisabled ? 'disabled' : ''}>${btnText}</button>`; roomsListUl.appendChild(li); }); document.querySelectorAll('.join-room-btn, .join-room-btn-pwd').forEach(button => { if (button.disabled) return; button.addEventListener('click', (e) => { const roomIdToJoin = e.target.dataset.roomid; let passwordToJoin = null; if (e.target.classList.contains('join-room-btn-pwd')) { passwordToJoin = prompt(`请输入房间 "${e.target.dataset.roomname || roomIdToJoin}" 的密码:`); if (passwordToJoin === null) return; } console.log(`[LOBBY CLIENT] Attempting to join room: ${roomIdToJoin}, Pwd: ${!!passwordToJoin}`); socket.emit('joinRoom', { roomId: roomIdToJoin, password: passwordToJoin }, (response) => { console.log('[LOBBY CLIENT] Join room response:', response); if (response && response.success) { currentRoomId = response.roomId; currentRoomState = response.roomState; displayGameState(response.roomState); switchToView('game-view'); } else { showTemporaryMessage(`加入房间失败: ${response ? response.message : '未知错误'}`, 3000, true); } }); }); }); } else { roomsListUl.innerHTML = '<li>当前没有可加入的房间。</li>'; } }
    socket.on('roomListUpdate', (rooms) => { if (lobbyView.style.display !== 'none') { updateRoomList(rooms); } });

    // --- Game View Listeners & Socket Handlers (已在之前版本中定义，保持大部分不变，仅做对齐) ---
    // Assume displayGameState, updatePlayerHandUI etc. are correctly implemented from previous version
    if (readyButton) readyButton.addEventListener('click', () => { if (!currentRoomState || !myUserId || currentRoomState.status !== 'waiting') { showTemporaryMessage("无法准备：不在等待状态或信息错误。", 2000, true); return; } const myPlayer = currentRoomState.players.find(p => p.userId === myUserId); if (!myPlayer) { showTemporaryMessage("错误：找不到您的玩家信息。", 2000, true); return; } if (isAi托管激活 || myPlayer.isAiControlled) { showTemporaryMessage("AI托管中，请先取消托管再准备。", 2500, true); return; } const newReadyState = !myPlayer.isReady; console.log(`[ACTION CLIENT] Emitting 'playerReady': ${newReadyState}`); socket.emit('playerReady', newReadyState, (response) => { if (!response || !response.success) { showTemporaryMessage(`设置准备状态失败: ${response ? response.message : '无响应'}`, 2500, true);}}); });
    if (playButton) playButton.addEventListener('click', () => { if (!currentRoomState || !myUserId || currentRoomState.currentPlayerId !== myUserId || selectedCardsForPlay.length === 0) { showTemporaryMessage("不满足出牌条件。", 2000, true); return; } console.log(`[ACTION CLIENT] Playing cards:`, selectedCardsForPlay.map(c=>cardObjectToKey(c))); socket.emit('playCard', selectedCardsForPlay, (response) => { if (response && response.success) { selectedCardsForPlay = []; currentHintCards = null; currentHintIndexFromServer = 0; } else { showTemporaryMessage(`出牌失败: ${response ? response.message : '未知错误'}`, 2500, true); } updatePlayButtonState(); }); });
    if (passButton) passButton.addEventListener('click', () => { if (!currentRoomState || !myUserId || currentRoomState.currentPlayerId !== myUserId) { showTemporaryMessage("现在不是您的回合。", 2000, true); return; } const iAmStarterOfNewRound = !currentRoomState.lastHandInfo || (currentRoomState.lastPlayerWhoPlayedId === myUserId && currentRoomState.consecutivePasses > 0) || (currentRoomState.lastPlayerWhoPlayedId === myUserId && currentRoomState.players.filter(p => p.connected && !p.finished).length <=1) ; if (iAmStarterOfNewRound && !currentRoomState.isFirstTurn ) { showTemporaryMessage("您是本轮首个出牌者，必须出牌。", 2500, true); return; } console.log('[ACTION CLIENT] Passing turn.'); socket.emit('passTurn', (response) => { if (response && response.success) { selectedCardsForPlay = []; currentHintCards = null; currentHintIndexFromServer = 0;} else { showTemporaryMessage(`操作“过”失败: ${response ? response.message : '未知错误'}`, 2500, true); } updatePlayButtonState(); }); });
    if (hintButton) hintButton.addEventListener('click', () => { if (!currentRoomState || !myUserId || currentRoomState.currentPlayerId !== myUserId) { showTemporaryMessage("现在不是您的回合。", 2000, true); return; } console.log(`[ACTION CLIENT] Requesting hint, client index for server: ${currentHintIndexFromServer}`); socket.emit('requestHint', currentHintIndexFromServer, (response) => { console.log('[ACTION CLIENT] Hint response:', response); if (response && response.success && response.hint) { clearSelectionAndHighlights(); selectedCardsForPlay = response.hint.map(cardKey => ({ rank: cardKey.rank, suit: cardKey.suit })); currentHintCards = [...selectedCardsForPlay]; highlightHintedCards(currentHintCards, true); currentHintIndexFromServer = response.nextHintIndex; } else { showTemporaryMessage(response.message || "没有可用的提示。", 2000, !response.success); clearSelectionAndHighlights(); currentHintCards = null; selectedCardsForPlay = []; currentHintIndexFromServer = 0; } updatePlayButtonState(); }); });
    if (aiToggleButton) aiToggleButton.addEventListener('click', () => { if (!currentRoomState || !myUserId) { showTemporaryMessage("无法切换AI：无房间或用户信息。", 2000, true); return; } const myPlayer = currentRoomState.players.find(p => p.userId === myUserId); if (!myPlayer) { showTemporaryMessage("错误：找不到您的玩家信息。", 2000, true); return; } const newAiState = !myPlayer.isAiControlled; console.log(`[ACTION CLIENT] Toggling AI to: ${newAiState}`); socket.emit('toggleAI', newAiState, (response) => { if (response && response.success) { isAi托管激活 = response.isAiEnabled; aiToggleButton.textContent = isAi托管激活 ? "取消托管" : "AI托管"; aiToggleButton.classList.toggle('ai-active', isAi托管激活); showTemporaryMessage(isAi托管激活 ? "AI托管已激活。" : "AI托管已取消。", 2000); } else { showTemporaryMessage(`AI切换失败: ${response ? response.message : '未知错误'}`, 2500, true); } }); });
    const commonLeaveRoomLogic = () => { console.log('[ACTION CLIENT] Leaving room...'); socket.emit('leaveRoom', (response) => { if (response && response.success) { currentRoomId = null; currentRoomState = null; selectedCardsForPlay = []; currentHintCards = null; currentHintIndexFromServer = 0; isAi托管激活 = false; if(aiToggleButton){ aiToggleButton.textContent = "AI托管"; aiToggleButton.classList.remove('ai-active');} switchToView('lobby-view'); if(socket.connected) socket.emit('listRooms', updateRoomList); if(gameOverOverlay) gameOverOverlay.classList.add('hidden-view'); } else { showTemporaryMessage(`离开房间失败: ${response ? response.message : '未知错误'}`, 2500, true); } }); };
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', commonLeaveRoomLogic);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', commonLeaveRoomLogic);

    socket.on('gameStateUpdate', (state) => { if (state && state.roomId === currentRoomId) { currentRoomState = state; displayGameState(state); } else if (state && state.roomId && !currentRoomId) { console.log('[EVENT CLIENT] Received gameStateUpdate for new room (auto-join?):', state.roomId); currentRoomId = state.roomId; currentRoomState = state; displayGameState(state); switchToView('game-view'); }});
    socket.on('gameStarted', (initialGameState) => { console.log('[EVENT CLIENT] GameStarted received:', initialGameState); if (initialGameState && initialGameState.roomId === currentRoomId) { currentRoomState = initialGameState; selectedCardsForPlay = []; currentHintCards = null; currentHintIndexFromServer = 0; const myP = initialGameState.players.find(p => p.userId === myUserId); isAi托管激活 = myP?.isAiControlled || false; if(aiToggleButton){aiToggleButton.textContent = isAi托管激活 ? "取消托管" : "AI托管"; aiToggleButton.classList.toggle('ai-active', isAi托管激活);} displayGameState(initialGameState, true); if(gameOverOverlay) gameOverOverlay.classList.add('hidden-view'); }});
    socket.on('playerJoined', (playerInfo) => { showTemporaryMessage(`玩家 ${playerInfo.username} 加入了房间。`, 2000); /* Full update via gameStateUpdate */ });
    socket.on('playerLeft', ({ userId, username }) => { showTemporaryMessage(`玩家 ${username} 离开了房间。`, 2000); if (currentRoomState && currentRoomState.players) { const p = currentRoomState.players.find(pl => pl.userId === userId); if (p) p.connected = false; displayGameState(currentRoomState); } });
    socket.on('playerReadyUpdate', ({ userId, isReady }) => { if (currentRoomState && currentRoomState.players) { const player = currentRoomState.players.find(p => p.userId === userId); if (player) { player.isReady = isReady; updatePlayerReadyStatusUI(userId, isReady); if (userId === myUserId && readyButton) { readyButton.textContent = isReady ? "取消准备" : "准备"; readyButton.classList.toggle('cancel-ready', isReady); } } } });
    socket.on('gameStartFailed', ({ message }) => { showTemporaryMessage(`游戏开始失败: ${message}`, 3000, true); if (readyButton) { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); } });
    socket.on('invalidPlay', ({ message }) => { showTemporaryMessage(`无效操作: ${message}`, 2500, true); });
    socket.on('gameOver', ({ reason, scoreResult }) => { console.log('[EVENT CLIENT] GameOver:', reason, scoreResult); if(currentRoomState) {currentRoomState.status = 'finished'; currentRoomState.gameFinished = true; if (scoreResult) { currentRoomState.finalScores = scoreResult.finalScores; currentRoomState.scoreChanges = scoreResult.scoreChanges; currentRoomState.players.forEach(p => { const fs = scoreResult.finalScores.find(s => s.id === p.userId); if (fs) p.score = fs.score; }); }} if(gameOverTitle) gameOverTitle.textContent = reason || "游戏结束"; if(gameOverReasonText) gameOverReasonText.textContent = `当局结果: ${reason}`; if(gameOverScoresDiv) { gameOverScoresDiv.innerHTML = ''; if (scoreResult && scoreResult.finalScores) { scoreResult.finalScores.forEach(ps => { const chg = scoreResult.scoreChanges ? (scoreResult.scoreChanges[ps.id] || 0) : 0; const chgStr = chg > 0 ? `+${chg}` : (chg < 0 ? `${chg}` : '0'); const scCls = chg > 0 ? 'score-plus' : (chg < 0 ? 'score-minus' : 'score-zero'); gameOverScoresDiv.innerHTML += `<p>${ps.name} (${ps.role || 'N/A'}): <span class="${scCls}">${chgStr}</span> (总分: ${ps.score})</p>`; }); }} switchToView('game-view'); if(gameOverOverlay){ gameOverOverlay.classList.remove('hidden-view'); gameOverOverlay.style.display = 'flex';} if (readyButton) { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); } selectedCardsForPlay = []; currentHintCards = null; currentHintIndexFromServer = 0; updatePlayButtonState(); });
    
    // --- Voice Functionality (已在之前版本中定义，保持不变) ---
    if (micButton) { micButton.addEventListener('mousedown', handleVoicePress); micButton.addEventListener('mouseup', handleVoiceRelease); micButton.addEventListener('touchstart', handleVoicePress, { passive: false }); micButton.addEventListener('touchend', handleVoiceRelease); micButton.addEventListener('mouseleave', handleVoiceLeave); }
    async function handleVoicePress(event) { event.preventDefault(); if (isRecording || !currentRoomId || !myUserId) return; console.log('[VOICE CLIENT] Mic pressed.'); try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); mediaRecorder = new MediaRecorder(stream); audioChunks = []; mediaRecorder.ondataavailable = e => audioChunks.push(e.data); mediaRecorder.onstop = () => { if (audioChunks.length > 0) { const audioBlob = new Blob(audioChunks, { type: 'audio/webm' }); console.log(`[VOICE CLIENT] Sending voice data. Size: ${audioBlob.size}`); if (audioBlob.size > 100) { socket.emit('sendVoiceMessage', { roomId: currentRoomId, audioBlob }); } else { console.log('[VOICE CLIENT] Audio data too small.');}} stream.getTracks().forEach(track => track.stop()); }; mediaRecorder.start(); isRecording = true; micButton.classList.add('recording'); micButton.textContent = "录制中"; socket.emit('playerStartedSpeaking', { userId: myUserId, roomId: currentRoomId }); } catch (err) { console.error('[VOICE CLIENT] Mic error:', err); showTemporaryMessage("麦克风错误。", 2000, true);}}
    function handleVoiceRelease() { if (!isRecording || !mediaRecorder) return; console.log('[VOICE CLIENT] Mic released.'); mediaRecorder.stop(); isRecording = false; micButton.classList.remove('recording'); micButton.textContent = "🎤"; socket.emit('playerStoppedSpeaking', { userId: myUserId, roomId: currentRoomId });}
    function handleVoiceLeave() { if (isRecording) { console.log('[VOICE CLIENT] Mic left, stopping.'); handleVoiceRelease();}}
    socket.on('playerStartedSpeaking', ({ userId, username }) => { const sa = findSpeakingPlayerArea(userId); if (sa) { const ind = sa.querySelector('.voice-indicator'); if (ind) ind.classList.add('speaking');}});
    socket.on('playerStoppedSpeaking', ({ userId, username }) => { const sa = findSpeakingPlayerArea(userId); if (sa) { const ind = sa.querySelector('.voice-indicator'); if (ind) ind.classList.remove('speaking');}});
    function findSpeakingPlayerArea(speakingUserId) { if (speakingUserId === myUserId && myInfoInBar) return myInfoInBar.querySelector('.player-avatar-container'); return document.querySelector(`.player-area[data-player-id="${speakingUserId}"] .player-avatar-container`);}
    socket.on('receiveVoiceMessage', ({ userId, username, audioBlob }) => { if (userId === myUserId) return; console.log(`[VOICE CLIENT] Received voice from ${username}. Size: ${audioBlob.size}`); try { const audioUrl = URL.createObjectURL(audioBlob); const audio = new Audio(audioUrl); audio.play().catch(e => console.error('[VOICE CLIENT] Play audio error:', e)); audio.onended = () => URL.revokeObjectURL(audioUrl); } catch (e) { console.error('[VOICE CLIENT] Process audioBlob error:', e);}});

    // --- Core UI Update Function PLACEHOLDERS ---
    // IMPORTANT: You need to ensure these functions are fully implemented based on your previous correct version.
    // The following are simplified stubs or direct calls assuming they exist and work.
    function displayGameState(state, animateHand = false) {
        // console.log("[UI CLIENT STUB] displayGameState called with state:", state, "Animate:", animateHand);
        currentRoomState = state; // Update global state

        // Update Info Bar
        if (infoBarRoomName) infoBarRoomName.textContent = state.roomName || '未知房间';
        if (infoBarRoomId) infoBarRoomId.textContent = state.roomId || '----';
        const statusMap = { 'waiting': '等待中', 'playing': '游戏中', 'finished': '已结束' };
        if (infoBarRoomStatus) infoBarRoomStatus.textContent = statusMap[state.status] || state.status || '未知';
        const currentPlayer = state.players.find(p => p.userId === state.currentPlayerId);
        if (infoBarCurrentTurn) infoBarCurrentTurn.textContent = state.gameStarted && !state.gameFinished && currentPlayer ? currentPlayer.username : (state.gameFinished ? '游戏结束' : 'N/A');
        
        const myPlayer = state.players.find(p => p.userId === myUserId);
        const opponents = state.players.filter(p => p.userId !== myUserId);

        if (myPlayer) {
            updateMyPlayerArea(myPlayer, state.currentPlayerId === myUserId, state.gameFinished, state.status);
            if (myPlayer.hand && playerHandArea) { // playerHandArea might not be defined if error in HTML
                updatePlayerHandUI(myPlayer.hand, state.currentPlayerId === myUserId && !state.gameFinished && !myPlayer.finished, animateHand);
            } else if(playerHandArea) { playerHandArea.innerHTML = state.status === 'playing' ? '<p style="font-size:0.8em; color:#aaa;">等待发牌...</p>' : ''; }
            isAi托管激活 = myPlayer.isAiControlled;
            if (aiToggleButton) { aiToggleButton.textContent = isAi托管激活 ? "取消托管" : "AI托管"; aiToggleButton.classList.toggle('ai-active', isAi托管激活); }
        }

        if (myPlayer && opponents.length >= 0) { // Allow 0 opponents for 1-player testing or if others haven't joined
            const mySlot = myPlayer.slot;
            const maxP = state.players.length > 0 ? state.players.length : 4;
            const opponentSlots = opponents.map(op => ({...op, relativeSlot: (op.slot - mySlot + maxP) % maxP }));
            const topOpponent = opponentSlots.find(op => op.relativeSlot === Math.floor(maxP / 2));
            const leftOpponent = opponentSlots.find(op => (maxP === 4 && op.relativeSlot === 1) || (maxP === 3 && op.relativeSlot === 1) );
            const rightOpponent = opponentSlots.find(op => (maxP === 4 && op.relativeSlot === 3) || (maxP === 3 && op.relativeSlot === 2));
            updateOpponentUIElement(document.getElementById('player-top'), topOpponent, state.currentPlayerId, state.gameFinished, state.status);
            updateOpponentUIElement(document.getElementById('player-left'), leftOpponent, state.currentPlayerId, state.gameFinished, state.status);
            updateOpponentUIElement(document.getElementById('player-right'), rightOpponent, state.currentPlayerId, state.gameFinished, state.status);
        } else {
            updateOpponentUIElement(document.getElementById('player-top'), null, null, state.gameFinished, state.status);
            updateOpponentUIElement(document.getElementById('player-left'), null, null, state.gameFinished, state.status);
            updateOpponentUIElement(document.getElementById('player-right'), null, null, state.gameFinished, state.status);
        }
        updateCenterPileUI(state.centerPile, state.lastHandInfo);
        updateGameActionButtons(state);
        // GameOver overlay is handled by 'gameOver' event or this function if state.gameFinished is true
        if (state.gameFinished && gameOverOverlay && gameOverOverlay.classList.contains('hidden-view')) {
             console.log("[UI CLIENT] displayGameState forcing gameOver display as state.gameFinished is true.");
             // Simplified gameOver display directly from state if 'gameOver' event was missed
             gameOverTitle.textContent = state.gameResultText || "游戏结束";
             gameOverReasonText.textContent = `当局结果: ${state.gameResultText}`;
             gameOverScoresDiv.innerHTML = '';
             if (state.finalScores) {
                 state.finalScores.forEach(ps => {
                     const change = state.scoreChanges ? (state.scoreChanges[ps.id] || 0) : 0;
                     const changeStr = change > 0 ? `+${change}` : (change < 0 ? `${change}` : '0');
                     const scoreClass = change > 0 ? 'score-plus' : (change < 0 ? 'score-minus' : 'score-zero');
                     gameOverScoresDiv.innerHTML += `<p>${ps.name} (${ps.role || 'N/A'}): <span class="${scoreClass}">${changeStr}</span> (总分: ${ps.score})</p>`;
                 });
             }
             gameOverOverlay.classList.remove('hidden-view');
             gameOverOverlay.style.display = 'flex';
        } else if (!state.gameFinished && gameOverOverlay && !gameOverOverlay.classList.contains('hidden-view')) {
            gameOverOverlay.classList.add('hidden-view');
            gameOverOverlay.style.display = 'none';
        }
    }
    function updateMyPlayerArea(playerData, isMyTurn, isGameFinished, roomStatus) { /* Your full implementation */ if (!myInfoInBar) return; const nameEl = myInfoInBar.querySelector('.playerName'); const cardCountEl = myInfoInBar.querySelector('.card-count'); const readyStatusEl = myInfoInBar.querySelector('.player-ready-status'); if (nameEl) nameEl.textContent = playerData.username || "我"; if (cardCountEl) cardCountEl.textContent = playerData.handCount; myInfoInBar.classList.toggle('current-turn', isMyTurn && !isGameFinished && roomStatus === 'playing'); myInfoInBar.classList.toggle('player-disconnected', !playerData.connected && !playerData.isAiControlled); myInfoInBar.classList.toggle('player-finished', playerData.finished); if (readyStatusEl) { if (roomStatus === 'waiting') { readyStatusEl.textContent = playerData.isReady ? "已准备" : "未准备"; readyStatusEl.className = 'player-ready-status ' + (playerData.isReady ? 'ready' : 'not-ready'); readyStatusEl.style.display = 'inline'; } else { readyStatusEl.style.display = 'none';}}}
    function updatePlayerHandUI(handCards, isMyTurnAndCanAct, animate = false) { /* Your full implementation */ if (!playerHandArea) return; playerHandArea.innerHTML = ''; selectedCardsForPlay = selectedCardsForPlay.filter(sc => handCards.some(hc => cardObjectToKey(hc) === cardObjectToKey(sc))); handCards.forEach((card, index) => { const cardDiv = document.createElement('div'); cardDiv.classList.add('card', 'my-card'); if (animate) cardDiv.classList.add('card-in-hand'); const rankName = rankToImageNamePart[card.rank]; const suitName = suitToImageNamePart[card.suit]; if (rankName && suitName) { cardDiv.style.backgroundImage = `url('${CARD_IMAGE_PATH}${rankName}_of_${suitName}${CARD_IMAGE_EXTENSION}')`; } else { cardDiv.style.backgroundImage = `url('${CARD_IMAGE_PATH}${CARD_BACK_IMAGE}')`; cardDiv.textContent = `${card.rank}${card.suit}`; } cardDiv.dataset.rank = card.rank; cardDiv.dataset.suit = card.suit; cardDiv.dataset.key = cardObjectToKey(card); if (isMyTurnAndCanAct) { cardDiv.classList.add('selectable'); cardDiv.addEventListener('click', () => toggleCardSelection(cardDiv, card)); } if (selectedCardsForPlay.some(sc => cardObjectToKey(sc) === cardObjectToKey(card))) { cardDiv.classList.add('selected'); } if (currentHintCards && currentHintCards.some(hc => cardObjectToKey(hc) === cardObjectToKey(card))) { cardDiv.classList.add('hinted'); } playerHandArea.appendChild(cardDiv); if (animate) { setTimeout(() => cardDiv.classList.add('dealt'), index * 50 + 50); } }); updatePlayButtonState(); }
    function toggleCardSelection(cardDiv, cardData) { /* Your full implementation */ const cardKey = cardObjectToKey(cardData); const index = selectedCardsForPlay.findIndex(c => cardObjectToKey(c) === cardKey); if (index > -1) { selectedCardsForPlay.splice(index, 1); cardDiv.classList.remove('selected'); } else { selectedCardsForPlay.push(cardData); cardDiv.classList.add('selected'); } if (currentHintCards && !currentHintCards.some(hc => cardObjectToKey(hc) === cardKey)) { document.querySelectorAll('#player-hand-area .card.hinted').forEach(c => c.classList.remove('hinted')); currentHintCards = null; currentHintIndexFromServer = 0; } updatePlayButtonState(); }
    function updatePlayButtonState() { /* Your full implementation */ if (!playButton || !currentRoomState || !myUserId) return; const myPlayer = currentRoomState.players.find(p => p.userId === myUserId); const canPlay = currentRoomState.gameStarted && !currentRoomState.gameFinished && myPlayer && !myPlayer.finished && currentRoomState.currentPlayerId === myUserId && selectedCardsForPlay.length > 0; playButton.disabled = !canPlay; if(passButton) { const canPass = currentRoomState.gameStarted && !currentRoomState.gameFinished && myPlayer && !myPlayer.finished && currentRoomState.currentPlayerId === myUserId && (!!currentRoomState.lastHandInfo && currentRoomState.lastPlayerWhoPlayedId !== myUserId && !currentRoomState.isFirstTurn); passButton.disabled = !canPass; } if(hintButton) { const canHint = currentRoomState.gameStarted && !currentRoomState.gameFinished && myPlayer && !myPlayer.finished && currentRoomState.currentPlayerId === myUserId; hintButton.disabled = !canHint;}}
    function clearSelectionAndHighlights() { /* Your full implementation */ selectedCardsForPlay = []; currentHintCards = null; document.querySelectorAll('#player-hand-area .card.selected').forEach(c => c.classList.remove('selected')); document.querySelectorAll('#player-hand-area .card.hinted').forEach(c => c.classList.remove('hinted')); updatePlayButtonState(); }
    function highlightHintedCards(hintedCardsArray, alsoSelectThem = false) { /* Your full implementation */ document.querySelectorAll('#player-hand-area .card.hinted').forEach(c => c.classList.remove('hinted')); if (alsoSelectThem) { document.querySelectorAll('#player-hand-area .card.selected').forEach(c => c.classList.remove('selected')); selectedCardsForPlay = []; } currentHintCards = hintedCardsArray.map(c => ({rank: c.rank, suit: c.suit})); hintedCardsArray.forEach(hintCard => { const cardKey = cardObjectToKey(hintCard); const cardDiv = playerHandArea.querySelector(`.card[data-key="${cardKey}"]`); if (cardDiv) { cardDiv.classList.add('hinted'); if (alsoSelectThem) { cardDiv.classList.add('selected'); if (!selectedCardsForPlay.find(sc => cardObjectToKey(sc) === cardKey)) { selectedCardsForPlay.push({rank: hintCard.rank, suit: hintCard.suit}); } } } }); updatePlayButtonState(); }
    function updateOpponentUIElement(areaElement, playerData, currentTurnPlayerId, isGameFinished, roomStatus) { /* Your full implementation */ if (!areaElement) return; const nameEl = areaElement.querySelector('.playerName'); const cardCountEl = areaElement.querySelector('.card-count'); const roleEl = areaElement.querySelector('.playerRole'); const readyStatusEl = areaElement.querySelector('.player-ready-status'); if (playerData) { areaElement.style.visibility = 'visible'; if (nameEl) nameEl.textContent = playerData.username; if (cardCountEl) cardCountEl.textContent = playerData.handCount; if (roleEl && roomStatus === 'playing' && playerData.role) { roleEl.textContent = playerData.role; roleEl.style.display = 'block'; } else if (roleEl) { roleEl.style.display = 'none'; } if (readyStatusEl) { if (roomStatus === 'waiting') { readyStatusEl.textContent = playerData.isReady ? "已准备" : "未准备"; readyStatusEl.className = 'player-ready-status ' + (playerData.isReady ? 'ready' : 'not-ready'); readyStatusEl.style.display = 'inline'; } else { readyStatusEl.style.display = 'none'; } } areaElement.classList.toggle('current-turn', playerData.userId === currentTurnPlayerId && !isGameFinished && roomStatus === 'playing'); areaElement.classList.toggle('player-disconnected', !playerData.connected && !playerData.isAiControlled); areaElement.classList.toggle('player-finished', playerData.finished); areaElement.dataset.playerId = playerData.userId; } else { areaElement.style.visibility = 'hidden'; if (nameEl) nameEl.textContent = '等待玩家...'; if (cardCountEl) cardCountEl.textContent = '?'; if (roleEl) roleEl.style.display = 'none'; if (readyStatusEl) readyStatusEl.style.display = 'none'; areaElement.classList.remove('current-turn', 'player-disconnected', 'player-finished'); areaElement.dataset.playerId = ""; } }
    function updatePlayerReadyStatusUI(pUserId, isReady) { /* Your full implementation */ let playerArea = null; if (currentRoomState && myUserId === pUserId && myInfoInBar) playerArea = myInfoInBar; else playerArea = document.querySelector(`.player-area[data-player-id="${pUserId}"]`); if (playerArea) { const readyStatusEl = playerArea.querySelector('.player-ready-status'); if (readyStatusEl) { if (currentRoomState && currentRoomState.status === 'waiting') { readyStatusEl.textContent = isReady ? "已准备" : "未准备"; readyStatusEl.className = 'player-ready-status ' + (isReady ? 'ready' : 'not-ready'); readyStatusEl.style.display = 'inline'; } else { readyStatusEl.style.display = 'none';}}} if (myUserId === pUserId && readyButton) { readyButton.textContent = isReady ? "取消准备" : "准备"; readyButton.classList.toggle('cancel-ready', isReady);}}
    function updateCenterPileUI(pileCards, lastHandInfoData) { /* Your full implementation */ if (!discardedCardsArea || !lastHandTypeDisplay) return; discardedCardsArea.innerHTML = ''; if (pileCards && pileCards.length > 0) { pileCards.forEach(card => { const cardDiv = document.createElement('div'); cardDiv.classList.add('card', 'center-pile-card'); const rankName = rankToImageNamePart[card.rank]; const suitName = suitToImageNamePart[card.suit]; if (rankName && suitName) { cardDiv.style.backgroundImage = `url('${CARD_IMAGE_PATH}${rankName}_of_${suitName}${CARD_IMAGE_EXTENSION}')`; } else { cardDiv.style.backgroundImage = `url('${CARD_IMAGE_PATH}${CARD_BACK_IMAGE}')`; cardDiv.textContent = `${card.rank}${card.suit}`; } discardedCardsArea.appendChild(cardDiv); }); lastHandTypeDisplay.textContent = lastHandInfoData ? `类型: ${lastHandInfoData.type}` : '等待出牌'; } else { lastHandTypeDisplay.textContent = '等待出牌'; } }
    function updateGameActionButtons(state) { /* Your full implementation */ if (!state || !myUserId) return; const myPlayer = state.players.find(p => p.userId === myUserId); const isMyTurn = state.gameStarted && !state.gameFinished && myPlayer && !myPlayer.finished && state.currentPlayerId === myUserId; if (readyButton) { readyButton.disabled = state.status !== 'waiting' || (myPlayer && myPlayer.isAiControlled); if (myPlayer && state.status === 'waiting') { readyButton.textContent = myPlayer.isReady ? "取消准备" : "准备"; readyButton.classList.toggle('cancel-ready', myPlayer.isReady); } else if (state.status !== 'waiting') { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); }} if (playButton) playButton.disabled = !isMyTurn || selectedCardsForPlay.length === 0; if (passButton) passButton.disabled = !isMyTurn || (!state.lastHandInfo || (state.lastPlayerWhoPlayedId === myUserId && !state.isFirstTurn)); if (hintButton) hintButton.disabled = !isMyTurn; if (aiToggleButton) aiToggleButton.disabled = state.status === 'finished' || (myPlayer && state.status === 'waiting' && myPlayer.isReady && !myPlayer.isAiControlled) ; /* Disable AI if ready and not AI */}

}); // END DOMContentLoaded
