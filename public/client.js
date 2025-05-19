// client.js
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed. Client v1.0.35'); // 保持与实际版本一致
    const socket = io({
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
        // transports: ['websocket', 'polling'] // 可选，明确传输方式
    });

    let myUserId = null;
    let myUsername = null;
    let currentRoomId = null;
    let currentRoomState = null;
    let selectedCardsForPlay = []; // 存储当前玩家选择要出的牌 [{rank, suit}, ...]
    let currentHint = null;          // 存储服务器返回的当前提示牌组 [{rank, suit}, ...]
    let currentHintIndexFromServer = 0; // 用于向服务器请求不同提示的索引
    let initialReauthAttempted = false;
    let isAi托管激活 = false; // AI托管状态

    // Views
    const loadingView = document.getElementById('loadingView');
    const authView = document.getElementById('auth-view');
    const lobbyView = document.getElementById('lobby-view');
    const gameView = document.getElementById('game-view');
    const allViews = [loadingView, authView, lobbyView, gameView];

    // Auth elements
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

    // Lobby elements
    const roomNameInput = document.getElementById('roomNameInput');
    const roomPasswordInput = document.getElementById('roomPasswordInput');
    const createRoomButton = document.getElementById('createRoomButton');
    const roomsListUl = document.getElementById('rooms');
    const lobbyUsernameSpan = document.getElementById('lobbyUsername');
    const refreshRoomListButton = document.getElementById('refreshRoomListButton');
    const logoutButtonLobby = document.getElementById('logoutButtonLobby');

    // Game elements
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

    // Game Over Overlay elements
    const gameOverOverlay = document.getElementById('gameOverOverlay');
    const gameOverTitle = document.getElementById('gameOverTitle');
    const gameOverReasonText = document.getElementById('gameOverReasonText');
    const gameOverScoresDiv = document.getElementById('gameOverScores');
    const backToLobbyBtnOverlay = gameOverOverlay.querySelector('#backToLobbyBtn');

    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;

    // Card Image Mapping
    const rankToImageNamePart = { 'A': 'ace', 'K': 'king', 'Q': 'queen', 'J': 'jack', 'T': '10', '9': '9', '8': '8', '7': '7', '6': '6', '5': '5', '4': '4', '3': '3', '2': '2' };
    const suitToImageNamePart = { 'S': 'spades', 'H': 'hearts', 'D': 'diamonds', 'C': 'clubs' };
    const CARD_IMAGE_EXTENSION = '.jpg'; // 假设您的图片是.jpg, 如果是.png或其他请修改
    const CARD_BACK_IMAGE = 'back.jpg'; // 牌背面图片

    function switchToView(targetViewId) {
        console.log(`[VIEW] Switching to view: ${targetViewId}`);
        allViews.forEach(view => {
            if (view) {
                if (view.id === targetViewId) {
                    view.classList.remove('hidden-view');
                    view.style.display = 'flex'; // Use flex for fullscreen-view
                    if (view.id === 'game-view') view.style.flexDirection = 'column'; // Game view specific
                } else {
                    view.classList.add('hidden-view');
                    view.style.display = 'none';
                }
            } else {
                console.warn(`[VIEW] Element for view ID (or one of its children) not found during view switch.`);
            }
        });
    }

    // --- Auth and Connection Logic ---
    switchToView('loadingView');
    const storedUserId = localStorage.getItem('userId');
    if (storedUserId) {
        initialReauthAttempted = true;
        console.log(`[AUTH] Initial: Found stored user ID: ${storedUserId}, attempting reauthentication.`);
        socket.emit('reauthenticate', storedUserId, (response) => {
            console.log('[AUTH] Initial Reauthenticate response:', response);
            if (response && response.success) {
                handleAuthSuccess(response);
            } else {
                showAuthError(response ? response.message : "重认证失败，请重新登录。");
                localStorage.removeItem('userId'); localStorage.removeItem('username');
                switchToView('auth-view');
            }
        });
    } else {
        initialReauthAttempted = true;
        console.log('[AUTH] Initial: No stored user ID found.');
        switchToView('auth-view');
    }

    function showAuthError(message) { if (authErrorElement) { authErrorElement.textContent = message; authErrorElement.style.display = 'block'; } else { alert(message); console.error("Auth Error (no element):", message); } }
    function clearAuthError() { if (authErrorElement) { authErrorElement.textContent = ''; authErrorElement.style.display = 'none'; } }

    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (loginForm) loginForm.style.display = 'none'; if (registerForm) registerForm.style.display = 'block'; });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (registerForm) registerForm.style.display = 'none'; if (loginForm) loginForm.style.display = 'block'; });
    if (loginButton) loginButton.addEventListener('click', () => { clearAuthError(); const phoneNumber = loginUsernameInput.value; const password = loginPasswordInput.value; if (!phoneNumber || !password) { showAuthError("手机号和密码不能为空。"); return; } console.log(`[AUTH] Attempting login for: ${phoneNumber}`); socket.emit('login', { phoneNumber, password }, handleAuthResponse); });
    if (registerButton) registerButton.addEventListener('click', () => { clearAuthError(); const phoneNumber = registerUsernameInput.value; const password = registerPasswordInput.value; if (!phoneNumber || password.length < 4) { showAuthError("手机号不能为空，密码至少4位。"); return; } console.log(`[AUTH] Attempting registration for: ${phoneNumber}`); socket.emit('register', { phoneNumber, password }, (response) => { alert(response.message); if (response.success) { if (loginForm) loginForm.style.display = 'block'; if (registerForm) registerForm.style.display = 'none'; loginUsernameInput.value = phoneNumber; loginPasswordInput.value = ""; loginPasswordInput.focus(); } else showAuthError(response.message); }); });

    function handleAuthSuccess(data) { if (!data || !data.userId) { console.error("[AUTH] handleAuthSuccess called with invalid data:", data); showAuthError("认证数据无效。"); switchToView('auth-view'); return; } myUserId = data.userId; myUsername = data.username; localStorage.setItem('userId', data.userId); localStorage.setItem('username', data.username); if(lobbyUsernameSpan) lobbyUsernameSpan.textContent = myUsername; clearAuthError(); console.log(`[AUTH] Auth success for user: ${myUsername} (ID: ${myUserId})`); if (data.roomState && data.roomState.roomId) { currentRoomId = data.roomState.roomId; console.log(`[AUTH] User was in room ${currentRoomId}, rejoining/displaying game state.`); currentRoomState = data.roomState; displayGameState(data.roomState, true); switchToView('game-view'); } else { if (currentRoomId) { currentRoomId = null; currentRoomState = null; } console.log('[AUTH] User not in a room, switching to lobby.'); switchToView('lobby-view'); if (socket.connected) socket.emit('listRooms', updateRoomList); else console.warn("[AUTH] Socket not connected post-auth, cannot fetch room list yet."); } }
    function handleAuthResponse(response) { console.log('[AUTH] Login/Re-auth response received:', response); if (response && response.success) handleAuthSuccess(response); else { showAuthError(response ? response.message : "认证失败。"); localStorage.removeItem('userId'); localStorage.removeItem('username'); myUserId = null; myUsername = null; switchToView('auth-view'); } }

    socket.on('connect', () => { console.log('[SOCKET] Connected to server with ID:', socket.id); const lsUserId = localStorage.getItem('userId'); if (!myUserId && lsUserId && !initialReauthAttempted) { console.log("[SOCKET] Connect event: Attempting reauthenticate on fresh connect with stored ID."); initialReauthAttempted = true; socket.emit('reauthenticate', lsUserId, handleAuthResponse); } else if (myUserId) { console.log("[SOCKET] Socket reconnected, user was already logged in. Requesting sync data."); if (currentRoomId) { socket.emit('requestGameState', (state) => { if (state) { console.log("[SOCKET] Reconnected in room, received game state:", state); currentRoomState = state; displayGameState(state); } else { console.warn("[SOCKET] Reconnected in room, but failed to get game state. Returning to lobby."); currentRoomId = null; currentRoomState = null; switchToView('lobby-view'); socket.emit('listRooms', updateRoomList); } }); } else { console.log("[SOCKET] Reconnected in lobby, fetching room list."); switchToView('lobby-view'); socket.emit('listRooms', updateRoomList); } } else if (!initialReauthAttempted) { console.log("[SOCKET] Connect event: No active login or stored ID. Displaying auth view (initialReauthAttempted false)."); switchToView('auth-view'); initialReauthAttempted = true; } else { console.log("[SOCKET] Connect event: No active login, initial reauth already attempted/failed. Staying in auth view or current view if not loading."); if (loadingView.style.display !== 'none' && authView.style.display === 'none') { switchToView('auth-view');}} });
    socket.on('disconnect', (reason) => { console.log('[SOCKET] Disconnected from server:', reason); if (reason !== 'io client disconnect') { alert('与服务器断开连接: ' + reason + ". 请刷新页面或检查网络。"); } switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent='已断开连接...'; initialReauthAttempted = false; /* Allow reauth on next connect */ });
    socket.on('connect_error', (err) => { console.error('[SOCKET] Connection error:', err.message, err); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent=`连接错误: ${err.message}. 正在尝试重连...`; });

    // --- Lobby Logic ---
    if (createRoomButton) { createRoomButton.addEventListener('click', () => { const roomName = roomNameInput.value.trim(); const password = roomPasswordInput.value; if (!roomName) { alert('请输入房间名称'); return; } console.log(`[CLIENT] Attempting to create room: "${roomName}", password: "${password ? '******' : '无'}"`); socket.emit('createRoom', { roomName, password: password || null }, (response) => { console.log('[CLIENT] Create room response from server:', response); if (response && response.success) { currentRoomId = response.roomId; currentRoomState = response.roomState; displayGameState(response.roomState); switchToView('game-view'); console.log(`[CLIENT] Room "${roomName}" created successfully! ID: ${response.roomId}`); } else { alert(`创建房间失败: ${response ? response.message : '未知错误。'}`); } }); }); }
    socket.on('roomListUpdate', (rooms) => { console.log("[EVENT] roomListUpdate received:", rooms); updateRoomList(rooms); });
    function updateRoomList(rooms) { if (!roomsListUl) return; roomsListUl.innerHTML = ''; if (rooms && rooms.length > 0) { rooms.forEach(room => { const li = document.createElement('li'); let joinBtnDisabled = room.status !== 'waiting' || room.playerCount >= room.maxPlayers; let joinButtonHtml = `<button data-roomid="${room.roomId}" class="join-room-btn" ${joinBtnDisabled ? 'disabled' : ''}>加入</button>`; if (room.hasPassword && !joinBtnDisabled) {  joinButtonHtml = `<button data-roomid="${room.roomId}" data-roomname="${room.roomName}" class="join-room-btn-pwd" ${joinBtnDisabled ? 'disabled' : ''}>加入 (有密码)</button>`; } else if (room.hasPassword && joinBtnDisabled) {  joinButtonHtml = `<button data-roomid="${room.roomId}" class="join-room-btn" disabled>加入 (有密码)</button>`; } li.innerHTML = `<span>${room.roomName} (${room.playerCount}/${room.maxPlayers}) - ${room.status === 'waiting' ? '等待中' : (room.status === 'playing' ? '游戏中' : '已结束')} ${room.hasPassword ? '' : ''}</span> ${joinButtonHtml}`; roomsListUl.appendChild(li); }); document.querySelectorAll('.join-room-btn, .join-room-btn-pwd').forEach(button => { if (button.disabled) return; button.addEventListener('click', (e) => { const roomIdToJoin = e.target.dataset.roomid; let passwordToJoin = null; if (e.target.classList.contains('join-room-btn-pwd')) { passwordToJoin = prompt(`请输入房间 "${e.target.dataset.roomname}" 的密码:`); if (passwordToJoin === null) return; } console.log(`[CLIENT] Attempting to join room: ${roomIdToJoin}, password: ${passwordToJoin ? "******" : "无"}`); socket.emit('joinRoom', { roomId: roomIdToJoin, password: passwordToJoin }, (response) => { console.log('[CLIENT] Join room response:', response); if (response && response.success) { currentRoomId = response.roomId; currentRoomState = response.roomState; displayGameState(response.roomState); switchToView('game-view'); } else alert(`加入房间失败: ${response ? response.message : '未知错误'}`); }); }); }); } else roomsListUl.innerHTML = '<li>没有可用的房间</li>'; }
    if (refreshRoomListButton) refreshRoomListButton.addEventListener('click', () => { if(socket.connected) { console.log("[CLIENT] Refreshing room list..."); socket.emit('listRooms', updateRoomList); } else console.warn("Socket not connected for refresh room list."); });
    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => { socket.disconnect(); localStorage.removeItem('userId'); localStorage.removeItem('username'); myUserId=null;myUsername=null;currentRoomId=null;currentRoomState=null; if(loginUsernameInput) loginUsernameInput.value=''; if(loginPasswordInput) loginPasswordInput.value=''; if(registerUsernameInput) registerUsernameInput.value=''; if(registerPasswordInput) registerPasswordInput.value=''; switchToView('auth-view'); initialReauthAttempted=false; });

    // --- Game Logic & Event Handlers ---
    if (readyButton) { readyButton.addEventListener('click', () => { if (!currentRoomState || !myUserId) { console.warn("[READY] No room state or user ID."); return; } const myPlayer = currentRoomState.players.find(p => p.userId === myUserId); if (!myPlayer || currentRoomState.status !== 'waiting') { console.warn("[READY] Not in waiting state or player not found."); return; } const newReadyState = !myPlayer.isReady; console.log(`[CLIENT] Sending playerReady: ${newReadyState}`); socket.emit('playerReady', newReadyState, (response) => { console.log('[CLIENT] playerReady callback response:', response); if (!response || !response.success) alert(`设置准备状态失败: ${response ? response.message : '未知错误'}`); }); }); }
    if (aiToggleButton) { aiToggleButton.addEventListener('click', () => { if (!currentRoomState || !myUserId) { alert("无法切换AI状态：不在房间内或未登录。"); return; } const myPlayer = currentRoomState.players.find(p => p.userId === myUserId); if (!myPlayer) { alert("无法切换AI状态：找不到玩家信息。"); return; } const newAiState = !isAi托管激活; console.log(`[CLIENT] Requesting AI托管 toggle. New state: ${newAiState}`); socket.emit('toggleAI', { enabled: newAiState }, (response) => { if (response && response.success) { console.log(`[AI] AI托管请求已发送，等待服务器状态更新。`); if (response.message) { showTemporaryMessage(response.message); } } else { alert(`AI托管操作失败: ${response ? response.message : '未知错误'}`); } }); }); }
    function showTemporaryMessage(message, duration = 2500) { const toast = document.createElement('div'); toast.textContent = message; toast.style.cssText = 'position:fixed; bottom:70px; left:50%; transform:translateX(-50%); background-color:rgba(0,0,0,0.75); color:white; padding:10px 15px; border-radius:5px; z-index:2000; font-size:0.9em; box-shadow: 0 2px 10px rgba(0,0,0,0.2);'; document.body.appendChild(toast); setTimeout(() => { toast.remove(); }, duration); }

    socket.on('gameStarted', (gameState) => {  console.log('[EVENT] gameStarted received:', gameState); currentRoomState = gameState; displayGameState(gameState, true); switchToView('game-view'); const mp=gameState.players.find(p=>p.userId===myUserId); console.log("[CLIENT] Game started!" + (mp && mp.role ? ` Your role: ${mp.role}` : '')); });
    socket.on('gameStateUpdate', (gameState) => {  console.log('[EVENT] gameStateUpdate received:', gameState); currentRoomState = gameState; displayGameState(gameState, false); });
    socket.on('playerJoined', (playerInfo) => {  console.log('[EVENT] playerJoined:', playerInfo); if (currentRoomState && currentRoomState.players) { const existingPlayer = currentRoomState.players.find(p => p.userId === playerInfo.userId); if (!existingPlayer) { currentRoomState.players.push(playerInfo); } else { Object.assign(existingPlayer, playerInfo); } displayGameState(currentRoomState); } });
    socket.on('playerLeft', ({userId, username}) => {  console.log(`[EVENT] playerLeft: User ${username} (ID: ${userId})`); if (currentRoomState && currentRoomState.players) { currentRoomState.players = currentRoomState.players.filter(p => p.userId !== userId); displayGameState(currentRoomState); } });
    socket.on('playerReadyUpdate', ({ userId, isReady }) => { console.log(`[EVENT] playerReadyUpdate: User ${userId} is ${isReady}`); if (currentRoomState && currentRoomState.players) { const player = currentRoomState.players.find(p => p.userId === userId); if (player) { player.isReady = isReady; updatePlayerReadyStatusUI(player.userId, isReady); if (userId === myUserId && readyButton) { readyButton.textContent = isReady ? "取消" : "准备"; readyButton.classList.toggle('cancel-ready', isReady); } } else { console.warn(`[EVENT] playerReadyUpdate: Player ${userId} not found.`); } } });
    socket.on('allPlayersResetReady', () => { console.log('[EVENT] allPlayersResetReady received.'); if (currentRoomState && currentRoomState.players) { currentRoomState.players.forEach(p => { p.isReady = false; updatePlayerReadyStatusUI(p.userId, false); }); if (myUserId && readyButton) { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); } } });
    socket.on('invalidPlay', (data) => { console.warn('[EVENT] invalidPlay', data); alert(`无效操作: ${data.message}`); });
    socket.on('gameOver', (data) => { console.log('[EVENT] gameOver received:', data); currentRoomState = { ...(currentRoomState || {}), ...data, gameFinished: true, gameStarted: false, status: 'finished', currentPlayerId: null }; displayGameState(currentRoomState); });
    socket.on('gameStartFailed', (data) => { console.error('[EVENT] gameStartFailed received:', data); alert(`游戏开始失败: ${data.message}`); if (currentRoomState) currentRoomState.status = 'waiting'; /* Reset status */ displayGameState(currentRoomState);});

    function handleLeaveRoomAndReturnToLobby() { console.log("[CLIENT] Attempting to leave room."); socket.emit('leaveRoom', (response) => { console.log('[CLIENT] Leave room response:', response); currentRoomId = null; currentRoomState = null; selectedCardsForPlay = []; currentHint = null; isAi托管激活 = false; switchToView('lobby-view'); socket.emit('listRooms', updateRoomList); if (gameOverOverlay) { gameOverOverlay.classList.add('hidden-view'); gameOverOverlay.style.display = 'none';} }); }
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', handleLeaveRoomAndReturnToLobby);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', handleLeaveRoomAndReturnToLobby);

    if (playButton) {
        playButton.addEventListener('click', () => {
            if (selectedCardsForPlay.length === 0) {
                alert('请选择要出的牌');
                return;
            }
            console.log("[CLIENT] Playing cards:", selectedCardsForPlay.map(c => cardObjectToKey(c)).join(','));
            socket.emit('playCard', selectedCardsForPlay, (res) => {
                if (res && res.success) {
                    // Clear selection on successful play from client side for immediate feedback,
                    // server gameStateUpdate will eventually confirm and re-render.
                    selectedCardsForPlay = [];
                    currentHint = null; 
                    currentHintIndexFromServer = 0;
                    // No need to manually update UI here, gameStateUpdate will handle it
                } else {
                    alert(`出牌失败: ${res ? res.message : '未知错误'}`);
                }
            });
        });
    }

    if (passButton) passButton.addEventListener('click', () => { console.log("[CLIENT] Passing turn."); clearSelectionAndHighlights(); /* Clear selection on pass */ socket.emit('passTurn', (res) => { if (res && !res.success) alert(`操作失败: ${res.message}`); }); });

    if (hintButton) {
        hintButton.addEventListener('click', () => {
            console.log("[CLIENT] Requesting hint.");
            clearSelectionAndHighlights(); // Clear previous user selections before applying hint

            socket.emit('requestHint', currentHintIndexFromServer, (res) => {
                if (res.success && res.hint && res.hint.cards && res.hint.cards.length > 0) {
                    currentHint = res.hint.cards;
                    currentHintIndexFromServer = res.nextHintIndex || 0;
                    
                    // --- CORE CHANGE for Hint then Play ---
                    selectedCardsForPlay = [...currentHint]; // Automatically select hinted cards
                    highlightHintedCards(currentHint, true); // Highlight and mark as selected in UI
                    // --- END CORE CHANGE ---

                    console.log("[CLIENT] Hint received and auto-selected cards:", selectedCardsForPlay.map(c=>cardObjectToKey(c)).join(','));
                } else {
                    alert(res.message || '没有可用的提示。');
                    currentHint = null;
                    currentHintIndexFromServer = 0;
                    highlightHintedCards([]); // Clear any old hint UI
                }
            });
        });
    }
    
    // --- UI Update Functions ---
    function displayGameState(state, animateHandOnDisplay = false) {
        if (!state) { console.warn("[DISPLAY] displayGameState called with null state."); if(myUserId)switchToView('lobby-view');else switchToView('auth-view'); return; }
        currentRoomState = state;
        const myPlayer = state.players ? state.players.find(p => p.userId === myUserId) : null;

        if (infoBarRoomName) infoBarRoomName.textContent = state.roomName || '未知房间';
        if (infoBarRoomId) infoBarRoomId.textContent = state.roomId || '----';
        if (infoBarRoomStatus) infoBarRoomStatus.textContent = state.status === 'waiting' ? '等待中' : (state.status === 'playing' ? '游戏中' : (state.gameFinished || state.status === 'finished' ? '已结束' : state.status));
        if (infoBarCurrentTurn) { const cP = state.players.find(p => p.userId === state.currentPlayerId); infoBarCurrentTurn.textContent = cP ? cP.username : (state.gameFinished ? '游戏结束' : (state.status === 'playing' ? '等待玩家' : 'N/A')); }

        if (myInfoInBar && myPlayer) {
            myInfoInBar.dataset.playerId = myPlayer.userId;
            const myNameEl = myInfoInBar.querySelector('#myPlayerName');
            const myAvatarEl = myInfoInBar.querySelector('#myAvatar'); // Assuming you might set avatar image
            const myStatusEl = myInfoInBar.querySelector('#myPlayerStatus .card-count');
            const myReadyEl = myInfoInBar.querySelector('#myPlayerStatus .player-ready-status');
            if (myNameEl) myNameEl.textContent = myPlayer.username || "我";
            if (myStatusEl) myStatusEl.textContent = myPlayer.handCount !== undefined ? myPlayer.handCount : '?';
            if (myReadyEl) { myReadyEl.textContent = myPlayer.isReady ? "✓已备" : "✗未备"; myReadyEl.className = `player-ready-status ${myPlayer.isReady ? 'ready' : 'not-ready'}`; myReadyEl.style.display = (state.status === 'waiting' && !state.gameFinished) ? 'inline' : 'none'; }
            myInfoInBar.classList.toggle('current-turn', state.status === 'playing' && state.currentPlayerId === myPlayer.userId && !state.gameFinished);
            myInfoInBar.classList.toggle('player-finished', !!myPlayer.finished);
            myInfoInBar.classList.toggle('player-disconnected', !myPlayer.connected);
        } else if (myInfoInBar) {
            myInfoInBar.removeAttribute('data-player-id');
            const myNameEl = myInfoInBar.querySelector('#myPlayerName');
            const myStatusEl = myInfoInBar.querySelector('#myPlayerStatus .card-count');
            const myReadyEl = myInfoInBar.querySelector('#myPlayerStatus .player-ready-status');
            if(myNameEl) myNameEl.textContent = myUsername || "玩家?"; // Fallback to stored username
            if(myStatusEl) myStatusEl.textContent = "?";
            if(myReadyEl) myReadyEl.style.display = 'none';
            myInfoInBar.classList.remove('current-turn', 'player-finished', 'player-disconnected');
        }

        const opponentSlotMap = {};
        if (myPlayer && state.players && state.players.length > 0) { const mySlot = myPlayer.slot; const numPlayers = state.players.filter(p=>p.connected).length > 1 ? state.players.filter(p=>p.connected).length : Math.max(2, state.players.length); const actualPlayers = state.players.filter(p => p.id !== myPlayer.id).sort((a,b) => (a.slot - mySlot + numPlayers) % numPlayers - (b.slot - mySlot + numPlayers) % numPlayers ); if (numPlayers === 2) { opponentSlotMap['top'] = actualPlayers[0]; } else if (numPlayers === 3) { opponentSlotMap['right'] = actualPlayers[0]; opponentSlotMap['left'] = actualPlayers[1]; } else if (numPlayers >= 4) { opponentSlotMap['right'] = actualPlayers[0]; opponentSlotMap['top'] = actualPlayers[1]; opponentSlotMap['left'] = actualPlayers[2]; } }
        else if (!myPlayer && state.players && state.players.length > 0) { /* Observer mode or player data not yet loaded */ const sortedPlayers = [...state.players].sort((a,b)=>a.slot-b.slot); if(sortedPlayers[0]) opponentSlotMap['self_substitute_UI_at_bottom'] = sortedPlayers[0]; if(sortedPlayers[1]) opponentSlotMap['right'] = sortedPlayers[1]; if(sortedPlayers[2]) opponentSlotMap['top'] = sortedPlayers[2]; if(sortedPlayers[3]) opponentSlotMap['left'] = sortedPlayers[3]; }
        ['top', 'left', 'right'].forEach(pK => updateOpponentUIElement(document.getElementById(`player-${pK}`), opponentSlotMap[pK], state.currentPlayerId, state.gameFinished, state.status));

        isAi托管激活 = myPlayer ? !!myPlayer.isAiControlled : false;
        if (aiToggleButton) { aiToggleButton.classList.toggle('ai-active', isAi托管激活); aiToggleButton.textContent = isAi托管激活 ? "取消AI" : "AI托管"; }

        if (myPlayer) {
            updatePlayerHandUI(myPlayer.hand || [], state.status === 'playing' && state.currentPlayerId === myPlayer.userId && myPlayer.connected && !myPlayer.finished && !isAi托管激活, animateHandOnDisplay);
            const isWaiting = state.status === 'waiting'; const isPlaying = state.status === 'playing';
            const canPlayerActManually = isPlaying && myPlayer.connected && !myPlayer.finished && !isAi托管激活;
            if(readyButton) { readyButton.style.display = isWaiting && !state.gameFinished ? 'inline-block' : 'none'; readyButton.disabled = state.gameFinished || isAi托管激活; readyButton.textContent = myPlayer.isReady ? "取消" : "准备"; readyButton.classList.toggle('cancel-ready', myPlayer.isReady); }
            const showGameplayButtons = isPlaying && myPlayer.connected && !myPlayer.finished;
            [hintButton, passButton, playButton, micButton, aiToggleButton].forEach(btn => { if(btn) btn.style.display = showGameplayButtons || (btn === readyButton && isWaiting) ? 'inline-block' : 'none'; });
            if (playButton) playButton.disabled = !(canPlayerActManually && state.currentPlayerId === myPlayer.userId && selectedCardsForPlay.length > 0); // Disabled if no cards selected
            if (passButton) passButton.disabled = !(canPlayerActManually && state.currentPlayerId === myPlayer.userId && !state.isFirstTurn && state.lastHandInfo && (!state.lastPlayerWhoPlayedId || state.lastPlayerWhoPlayedId !== myPlayer.userId));
            if (hintButton) hintButton.disabled = !(canPlayerActManually && state.currentPlayerId === myPlayer.userId);
            if (micButton) micButton.disabled = state.gameFinished || !myPlayer.connected;
            if (aiToggleButton) aiToggleButton.disabled = state.gameFinished || !myPlayer.connected || (state.status !== 'playing' && state.status !== 'waiting');
        } else { updatePlayerHandUI([], false, false); [readyButton, hintButton, passButton, playButton, micButton, aiToggleButton].forEach(btn => { if(btn) {btn.style.display = 'none'; btn.disabled = true;} }); }

        updateCenterPileUI(state.centerPile, state.lastHandInfo);
        if (gameOverOverlay) { const showOverlay = !!state.gameFinished; gameOverOverlay.style.display = showOverlay ? 'flex' : 'none'; gameOverOverlay.classList.toggle('hidden-view', !showOverlay); if(showOverlay) { if(gameOverTitle)gameOverTitle.textContent=`游戏结束 - ${state.gameResultText||state.result||"结果未定"}`; if(gameOverReasonText)gameOverReasonText.textContent=state.gameOverReason||state.reason||""; if(gameOverScoresDiv&&state.finalScores){gameOverScoresDiv.innerHTML='';state.finalScores.forEach(ps=>{const p=document.createElement('p');const sc=state.scoreChanges?(state.scoreChanges[ps.id]||0):0;let cCls='score-zero';if(sc>0)cCls='score-plus';else if(sc<0)cCls='score-minus';p.innerHTML=`${ps.name}(${ps.role||'?'}) : ${ps.score} <span class="${cCls}">(${sc>=0?'+':''}${sc})</span>`;gameOverScoresDiv.appendChild(p);});}}}
    }

    function updateOpponentUIElement(areaEl, pData, cTurnPId, isGFinished, rStatus) { if (!areaEl) return; const nE=areaEl.querySelector('.playerName'), rE=areaEl.querySelector('.playerRole'), cE=areaEl.querySelector('.playerInfo .card-count'), readyE=areaEl.querySelector('.player-ready-status'); if (pData) { areaEl.dataset.playerId = pData.userId; if(nE)nE.textContent=pData.username; if(rE)rE.textContent=pData.role?`(${pData.role})`:''; if(cE)cE.textContent=pData.handCount!==undefined?pData.handCount:'?'; if(readyE){readyE.textContent=pData.isReady?"✓已备":"✗未备"; readyE.className=`player-ready-status ${pData.isReady?'ready':'not-ready'}`; readyE.style.display=rStatus==='waiting'&&!isGFinished?'inline':'none';} areaEl.classList.toggle('current-turn', rStatus==='playing' && cTurnPId===pData.userId && !isGFinished); areaEl.classList.toggle('player-finished',!!pData.finished); areaEl.classList.toggle('player-disconnected',!pData.connected); areaEl.style.opacity=pData.connected?'1':'0.6'; } else { if(nE)nE.textContent='等待玩家...';if(rE)rE.textContent='';if(cE)cE.textContent='?';if(readyE)readyE.style.display='none'; areaEl.classList.remove('current-turn','player-finished','player-disconnected'); areaEl.removeAttribute('data-player-id');areaEl.style.opacity='0.7'; } }
    function updatePlayerReadyStatusUI(pUserId, isReady) { let tA; if (pUserId === myUserId) tA = document.getElementById('my-info-in-bar'); else tA = document.querySelector(`.opponent-area[data-player-id="${pUserId}"]`); if (tA) { const rSE = tA.querySelector('.player-ready-status'); if (rSE) { rSE.textContent = isReady ? "✓已备" : "✗未备"; rSE.className = `player-ready-status ${isReady ? 'ready' : 'not-ready'}`; if (currentRoomState) { rSE.style.display = (currentRoomState.status === 'waiting' && !currentRoomState.gameFinished) ? 'inline' : 'none'; } else { rSE.style.display = 'none'; } } } else { console.warn(`[UI] updatePlayerReadyStatusUI: Target area for player ${pUserId} not found.`); } }

    function updatePlayerHandUI(hCards, isMyTurn, animate = false) {
        if (!playerHandArea) return;
        playerHandArea.innerHTML = ''; // Clear previous cards
        if (!hCards || hCards.length === 0) return;

        hCards.forEach((cardData, idx) => {
            const cardDiv = createCardElement(cardData);
            cardDiv.classList.add('my-card');
            if (animate) {
                cardDiv.classList.add('card-in-hand'); // Initial state for animation
                void cardDiv.offsetWidth; // Force reflow for transition to trigger
                setTimeout(() => cardDiv.classList.add('dealt'), idx * 70 + 50); // Staggered animation
            } else {
                cardDiv.classList.add('card-in-hand', 'dealt'); // Show immediately
            }

            // Check if this card is in selectedCardsForPlay or currentHint
            const cardKey = cardObjectToKey(cardData);
            if (selectedCardsForPlay.some(sc => cardObjectToKey(sc) === cardKey)) {
                cardDiv.classList.add('selected');
            }
            if (currentHint && currentHint.some(hc => cardObjectToKey(hc) === cardKey)) {
                cardDiv.classList.add('hinted');
            }

            playerHandArea.appendChild(cardDiv);

            if (isMyTurn) { // Only allow selection if it's my turn and I'm not AI controlled
                cardDiv.classList.add('selectable');
                cardDiv.addEventListener('click', () => {
                    toggleCardSelection(cardDiv, cardData);
                    // If user manually selects a card, clear any existing hint highlight
                    // UNLESS the selected card is part of the current hint.
                    // More robustly: if a hint was active and user clicks a non-hinted card, clear hint.
                    // If user clicks a card that IS part of the hint, it's fine.
                    // Simpler: always clear hint display on manual selection IF a hint was active.
                    if (currentHint) {
                        // Only clear visual hint if the click wasn't to complete the hint selection
                        // This logic is tricky. For now, clicking always clears visual hint to force re-hint if needed.
                        const clickedCardIsPartOfHint = currentHint.some(hc => cardObjectToKey(hc) === cardObjectToKey(cardData));
                        if(!clickedCardIsPartOfHint && !selectedCardsForPlay.every(sc => currentHint.some(hc => cardObjectToKey(hc) === cardObjectToKey(sc)))){
                            // If user clicks a card NOT in current hint, or selection is now different from hint
                            highlightHintedCards([]); // Clear visual hint highlights
                            currentHint = null; // Clear stored hint data
                            currentHintIndexFromServer = 0;
                        }
                    }
                });
            }
        });
        // After re-rendering hand, if a hint is active, re-apply its visual style
        // This is now handled inside the loop by checking currentHint
        // if (currentHint && currentHint.length > 0) highlightHintedCards(currentHint, selectedCardsForPlay.length > 0 && selectedCardsForPlay.every(sc => currentHint.some(hc => cardObjectToKey(hc) === cardObjectToKey(sc))));
    }

    function toggleCardSelection(cardDiv, cardData) {
        const cardKey = cardObjectToKey(cardData);
        const indexInSelection = selectedCardsForPlay.findIndex(c => cardObjectToKey(c) === cardKey);

        if (indexInSelection > -1) { // Card is already selected, so unselect it
            selectedCardsForPlay.splice(indexInSelection, 1);
            cardDiv.classList.remove('selected');
        } else { // Card is not selected, so select it
            selectedCardsForPlay.push(cardData);
            cardDiv.classList.add('selected');
        }
        console.log("[CLIENT] Selected cards:", selectedCardsForPlay.map(c => cardObjectToKey(c)).join(','));
        // Enable/disable play button based on selection
        if(playButton) playButton.disabled = selectedCardsForPlay.length === 0 || !(currentRoomState && currentRoomState.players.find(p=>p.userId===myUserId)?.id === currentRoomState.currentPlayerId && !isAi托管激活);
    }
    
    // Helper function to clear all selections and UI highlights
    function clearSelectionAndHighlights() {
        if (!playerHandArea) return;
        playerHandArea.querySelectorAll('.my-card.selected').forEach(c => c.classList.remove('selected'));
        playerHandArea.querySelectorAll('.my-card.hinted').forEach(c => c.classList.remove('hinted'));
        selectedCardsForPlay = [];
        currentHint = null;
        // currentHintIndexFromServer is usually reset when a new hint is requested or play is made.
        if(playButton) playButton.disabled = true; // Disable play button as no cards are selected
        console.log("[CLIENT] Cleared card selections and highlights.");
    }

    // Modified highlightHintedCards to handle both hint and selection state
    function highlightHintedCards(hintedCardsArray, alsoSelectThem = false) {
        if (!playerHandArea) return;
        
        const hintedCardKeys = new Set(hintedCardsArray.map(cardObjectToKey));

        playerHandArea.querySelectorAll('.my-card').forEach(cardEl => {
            const cardElKey = cardObjectToKey(cardEl.dataset); // Assuming rank/suit are in dataset

            // Handle hinted state
            if (hintedCardKeys.has(cardElKey)) {
                cardEl.classList.add('hinted');
            } else {
                cardEl.classList.remove('hinted');
            }

            // Handle selected state if alsoSelectThem is true
            if (alsoSelectThem) {
                if (hintedCardKeys.has(cardElKey)) {
                    cardEl.classList.add('selected');
                } else {
                    // If alsoSelectThem is true, it means we are applying a new selection based on hint,
                    // so any card NOT in the hint should be unselected.
                    cardEl.classList.remove('selected');
                }
            }
        });
        if(playButton) playButton.disabled = selectedCardsForPlay.length === 0 || !(currentRoomState && currentRoomState.players.find(p=>p.userId===myUserId)?.id === currentRoomState.currentPlayerId && !isAi托管激活);
    }


    function updateCenterPileUI(cPileCards, lHInfo) { if(!discardedCardsArea)return; const lHTDisp=document.getElementById('lastHandType'); discardedCardsArea.innerHTML=''; let csToDisp=[]; let hTMsg="等待出牌"; if(lHInfo&&lHInfo.cards&&lHInfo.cards.length>0){csToDisp=lHInfo.cards;hTMsg=`类型: ${lHInfo.type||'未知'}`;}else if(cPileCards&&cPileCards.length>0&&(!lHInfo||(lHInfo.cards&&lHInfo.cards.length===0))){csToDisp=cPileCards;hTMsg="当前出牌";}if(lHTDisp)lHTDisp.textContent=hTMsg;if(csToDisp.length>0)csToDisp.forEach(cD=>{const cDiv=createCardElement(cD);cDiv.classList.add('center-pile-card');discardedCardsArea.appendChild(cDiv);});}
    function createCardElement(cardData) { const cardDiv = document.createElement('div'); cardDiv.className = 'card'; if(!cardData || !cardData.rank || !cardData.suit) { console.error("[GFX] Invalid cardData for createCardElement:", cardData); cardDiv.textContent = "ERR"; return cardDiv;} cardDiv.dataset.rank = cardData.rank; cardDiv.dataset.suit = cardData.suit; const rankPart = rankToImageNamePart[cardData.rank]; const suitPart = suitToImageNamePart[cardData.suit]; let imageName; if (rankPart && suitPart) { imageName = `${rankPart}_of_${suitPart}${CARD_IMAGE_EXTENSION}`; } else { console.warn(`[GFX] Failed to map card data: suit=${cardData.suit}, rank=${cardData.rank}. Using back.`); imageName = CARD_BACK_IMAGE; cardDiv.textContent = `${cardData.suit}${cardData.rank}`; } const imagePath = `/images/cards/${imageName}`; try { cardDiv.style.backgroundImage = `url('${imagePath}')`; } catch (e) { console.error(`[GFX] Error setting image for ${imagePath}:`, e); cardDiv.textContent = `${cardData.suit}${cardData.rank}`; } return cardDiv; }
    function cardObjectToKey(card) { if (!card || typeof card.rank === 'undefined' || typeof card.suit === 'undefined') { return null; } return `${card.rank}${card.suit}`; }

    // --- Voice Functionality ---
    if(micButton){micButton.addEventListener('mousedown',handleVoicePress);micButton.addEventListener('mouseup',handleVoiceRelease);micButton.addEventListener('mouseleave',handleVoiceRelease);micButton.addEventListener('touchstart',handleVoicePress,{passive:false});micButton.addEventListener('touchend',handleVoiceRelease);micButton.addEventListener('touchcancel',handleVoiceRelease);}
    async function handleVoicePress(evt){ evt.preventDefault(); if(isRecording || !currentRoomId || (currentRoomState && currentRoomState.gameFinished)) return; console.log('[VOICE] Mic pressed'); if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){alert("您的浏览器不支持麦克风访问(getUserMedia不可用)。请尝试更新浏览器或确保在HTTPS/localhost环境下运行。");return;} isRecording=true;audioChunks=[]; if(micButton)micButton.classList.add('recording'); if(socket&&socket.connected)socket.emit('playerStartSpeaking'); try{ const strm=await navigator.mediaDevices.getUserMedia({audio:true}); const mTs=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4']; let selMT=''; for(const mT of mTs){if(MediaRecorder.isTypeSupported(mT)){selMT=mT;break;}} console.log("[VOICE] Using MIME Type for recording:",selMT||'default (browser specific)'); mediaRecorder=selMT?new MediaRecorder(strm,{mimeType:selMT}):new MediaRecorder(strm); mediaRecorder.ondataavailable=e=>{if(e.data.size>0)audioChunks.push(e.data);}; mediaRecorder.onstop=()=>{ console.log('[VOICE] Recorder stopped.'); if(audioChunks.length > 0 && currentRoomId && socket && socket.connected){ const blobMimeType = selMT || (audioChunks[0] && audioChunks[0].type) || 'application/octet-stream'; const audioBlobToSend = new Blob(audioChunks,{type:blobMimeType}); console.log(`[VOICE] Sending audio blob. Type: ${audioBlobToSend.type}, Size: ${audioBlobToSend.size} bytes.`); socket.emit('sendVoiceMessage',{roomId:currentRoomId,audioBlob:audioBlobToSend}); } else console.log("[VOICE] No audio chunks, or not in room, or socket disconnected. Not sending voice."); audioChunks=[]; if(strm)strm.getTracks().forEach(t=>t.stop()); }; mediaRecorder.start(); console.log('[VOICE] Recorder started.'); }catch(err){ console.error('[VOICE] Microphone access or recording error:',err); alert(`麦克风错误: ${err.name} - ${err.message}\n请检查麦克风权限，并确保页面是通过HTTPS或localhost访问的。`); isRecording=false; if(micButton)micButton.classList.remove('recording'); if(socket&&socket.connected)socket.emit('playerStopSpeaking'); if(mediaRecorder&&mediaRecorder.stream)mediaRecorder.stream.getTracks().forEach(t=>t.stop()); else if(err.stream && typeof err.stream.getTracks === 'function')err.stream.getTracks().forEach(t=>t.stop()); } }
    function handleVoiceRelease(evt){evt.preventDefault();if(!isRecording)return;console.log('[VOICE] Mic released');isRecording=false;if(micButton)micButton.classList.remove('recording');if(socket&&socket.connected)socket.emit('playerStopSpeaking');if(mediaRecorder&&mediaRecorder.state==='recording')mediaRecorder.stop();else if(mediaRecorder&&mediaRecorder.stream)mediaRecorder.stream.getTracks().forEach(t=>t.stop());}
    function findSpeakingPlayerArea(sUID){if(sUID===myUserId)return document.getElementById('my-info-in-bar');return document.querySelector(`.opponent-area[data-player-id="${sUID}"]`);}
    socket.on('playerStartedSpeaking',({userId,username})=>{console.log(`[VOICE] ${username}(${userId}) started speaking`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.add('speaking');}});
    socket.on('playerStoppedSpeaking',({userId})=>{console.log(`[VOICE] Player ${userId} stopped speaking`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.remove('speaking');}});
    socket.on('receiveVoiceMessage',(data)=>{if(!data||!data.audioBlob){console.error("[VOICE] Received invalid voice message data from server:", data); return;}console.log('[VOICE] Voice message received from:',data.userId,"Type:",data.audioBlob.type,"Size:",data.audioBlob.size);const{userId,audioBlob}=data;if(!(audioBlob instanceof Blob)||audioBlob.size===0){console.error("[VOICE] Invalid audio Blob received:",audioBlob);return;}try{const aUrl=URL.createObjectURL(audioBlob);const aud=new Audio(aUrl);aud.play().catch(e=>console.error('[VOICE] Audio playback error:',e));aud.onended=()=>URL.revokeObjectURL(aUrl);aud.onerror=(e)=>{console.error(`[VOICE] Error playing audio from ${userId}:`,e);URL.revokeObjectURL(aUrl);};}catch(e){console.error("[VOICE] Error creating Object URL or playing audio:", e)}});

}); // END DOMContentLoaded
