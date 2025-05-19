// client.js
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed. Client v1.0.35'); // 确保与 html 中的 ?v= 一致
    const socket = io({
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
        // transports: ['websocket', 'polling'] // 可选，明确传输方式
    });

    let myUserId = null;
    let myUsername = null;
    let currentRoomId = null;
    let currentRoomState = null; // 将持有从服务器获取的完整房间和游戏状态
    let selectedCardsForPlay = [];
    let currentHint = null;
    let currentHintIndexFromServer = 0;
    let initialReauthAttempted = false;
    let isAi托管激活 = false;

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

    const gameOverOverlay = document.getElementById('gameOverOverlay');
    const gameOverTitle = document.getElementById('gameOverTitle');
    const gameOverReasonText = document.getElementById('gameOverReasonText');
    const gameOverScoresDiv = document.getElementById('gameOverScores');
    const backToLobbyBtnOverlay = gameOverOverlay.querySelector('#backToLobbyBtn');

    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;

    const rankToImageNamePart = { 'A': 'ace', 'K': 'king', 'Q': 'queen', 'J': 'jack', 'T': '10', '9': '9', '8': '8', '7': '7', '6': '6', '5': '5', '4': '4', '3': '3', '2': '2' };
    const suitToImageNamePart = { 'S': 'spades', 'H': 'hearts', 'D': 'diamonds', 'C': 'clubs' };
    const CARD_IMAGE_EXTENSION = '.jpg';
    const CARD_BACK_IMAGE = 'back.jpg';


    function switchToView(targetViewId) {
        console.log(`[VIEW CLIENT] Switching to view: ${targetViewId}`);
        allViews.forEach(view => {
            if (view) {
                if (view.id === targetViewId) {
                    view.classList.remove('hidden-view');
                    view.style.display = 'flex'; // Default display for views
                    if (view.id === 'game-view') { // Game view has specific layout
                        view.style.flexDirection = 'column';
                    } else if (view.id === 'lobby-view' || view.id === 'auth-view' || view.id === 'loadingView') {
                        // Ensure these center content if they are fullscreen-view and flex-center-center
                        view.style.flexDirection = 'column'; // or as needed by their content
                        // view.classList.add('flex-center-center'); // If this class defines centering
                    }
                } else {
                    view.classList.add('hidden-view');
                    view.style.display = 'none';
                }
            }
        });
    }

    function showAuthError(message) { if (authErrorElement) { authErrorElement.textContent = message; authErrorElement.style.display = 'block'; } else { alert(message); console.error("Auth Error (no element):", message); } }
    function clearAuthError() { if (authErrorElement) { authErrorElement.textContent = ''; authErrorElement.style.display = 'none'; } }

    function handleAuthSuccess(data) {
        console.log("[AUTH CLIENT] handleAuthSuccess called with data:", data);
        if (!data || !data.userId || !data.username) {
            console.error("[AUTH CLIENT] handleAuthSuccess called with invalid or incomplete data:", data);
            showAuthError("认证数据无效或不完整，请重试。");
            switchToView('auth-view');
            return;
        }
        myUserId = data.userId;
        myUsername = data.username;
        localStorage.setItem('userId', data.userId);
        localStorage.setItem('username', data.username);

        if (lobbyUsernameSpan) lobbyUsernameSpan.textContent = myUsername;
        clearAuthError();
        console.log(`[AUTH CLIENT] Auth success for user: ${myUsername} (ID: ${myUserId})`);

        if (data.roomState && data.roomState.roomId) {
            currentRoomId = data.roomState.roomId;
            currentRoomState = data.roomState;
            console.log(`[AUTH CLIENT] User was in room ${currentRoomId}. Displaying game state.`);
            displayGameState(data.roomState, true);
            switchToView('game-view');
        } else {
            if (currentRoomId) { currentRoomId = null; currentRoomState = null; }
            console.log('[AUTH CLIENT] User not in a room or roomState not provided. Switching to lobby.');
            switchToView('lobby-view');
            if (socket.connected) {
                console.log('[AUTH CLIENT] Requesting initial room list for lobby.');
                socket.emit('listRooms', updateRoomList);
            } else {
                console.warn("[AUTH CLIENT] Socket not connected post-auth success, cannot fetch room list yet for lobby.");
            }
        }
    }

    function handleAuthResponse(response) {
        console.log('[AUTH CLIENT] Received Auth response (login/re-auth):', response);
        if (response && response.success) {
            handleAuthSuccess(response);
        } else {
            const errorMessage = response ? response.message : "认证失败，请重试或检查网络。";
            showAuthError(errorMessage);
            localStorage.removeItem('userId');
            localStorage.removeItem('username');
            myUserId = null; myUsername = null;
            switchToView('auth-view');
        }
    }
    
    switchToView('loadingView'); // Start with loading view
    const localStoredUserId = localStorage.getItem('userId'); // Check for stored ID early
    if (localStoredUserId) {
        console.log(`[CLIENT INIT] Found stored user ID: ${localStoredUserId}. Reauthentication will be attempted on socket 'connect'.`);
    } else {
        initialReauthAttempted = true; // No stored ID, so no initial reauth to attempt.
        console.log('[CLIENT INIT] No stored user ID found. Will switch to auth view on socket "connect" if still loading.');
    }

    socket.on('connect', () => {
        console.log('[SOCKET CLIENT] Connected to server with ID:', socket.id);
        const lsUserId = localStorage.getItem('userId'); // Re-check, as it might have been cleared

        if (!myUserId && lsUserId && !initialReauthAttempted) {
            console.log("[SOCKET CLIENT] Connect event: Attempting initial reauthenticate with stored ID.");
            initialReauthAttempted = true;
            socket.emit('reauthenticate', lsUserId, handleAuthResponse);
        } else if (myUserId && currentRoomId) {
            console.log("[SOCKET CLIENT] Socket reconnected. User logged in & in room. Requesting game state sync for room:", currentRoomId);
            socket.emit('requestGameState', (state) => {
                if (state && state.roomId === currentRoomId) {
                    console.log("[SOCKET CLIENT] Reconnected in room, received game state:", state);
                    currentRoomState = state; displayGameState(state, false); switchToView('game-view');
                } else {
                    console.warn("[SOCKET CLIENT] Reconnected in room, but failed to get valid game state or room ID mismatch. Current:", currentRoomId, "Received:", state ? state.roomId : "null state");
                    alert("重新连接房间失败。将返回大厅。");
                    currentRoomId = null; currentRoomState = null; switchToView('lobby-view'); socket.emit('listRooms', updateRoomList);
                }
            });
        } else if (myUserId && !currentRoomId) {
            console.log("[SOCKET CLIENT] Socket reconnected. User logged in & in lobby. Fetching room list.");
             if (loadingView.style.display !== 'none' || authView.style.display !== 'none') switchToView('lobby-view');
            socket.emit('listRooms', updateRoomList);
        } else if (!myUserId && initialReauthAttempted) { // No user, and initial reauth was done (or not needed)
             console.log("[SOCKET CLIENT] Connect event: No active login, initial reauth process completed. Ensuring auth view.");
             if (loadingView.style.display !== 'none' || gameView.style.display !== 'none' || lobbyView.style.display !== 'none') {
                switchToView('auth-view'); // If not already on auth view, switch to it
             }
        } else if (!myUserId && !initialReauthAttempted && !lsUserId) { // Fresh visit, no stored ID
            console.log("[SOCKET CLIENT] Connect event: Fresh visit, no stored ID. Switching to auth view.");
            initialReauthAttempted = true; // Mark as "no reauth needed" for this path
            switchToView('auth-view');
        } else {
            console.log("[SOCKET CLIENT] Connect event: Unhandled state. myUserId:", myUserId, "lsUserId:", lsUserId, "initialReauthAttempted:", initialReauthAttempted, "currentView:", allViews.find(v=>v.style.display !=='none')?.id);
            if (loadingView.style.display !== 'none') switchToView('auth-view'); // Fallback if stuck on loading
        }
    });
    socket.on('disconnect', (reason) => { console.log('[SOCKET CLIENT] Disconnected from server:', reason); if (reason !== 'io client disconnect' && reason !== 'io server disconnect') { alert('与服务器断开连接: ' + reason + "。请刷新或检查网络。"); } switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent='已断开连接...'; initialReauthAttempted = false; });
    socket.on('connect_error', (err) => { console.error('[SOCKET CLIENT] Connection error:', err.message, err); if (loadingView.querySelector('p')) loadingView.querySelector('p').textContent=`连接错误: ${err.message}. 尝试重连...`; /* Don't switch view here, socket.io handles retries */ });

    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (loginForm) loginForm.style.display = 'none'; if (registerForm) registerForm.style.display = 'block'; });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (registerForm) registerForm.style.display = 'none'; if (loginForm) loginForm.style.display = 'block'; });
    if (loginButton) loginButton.addEventListener('click', () => { clearAuthError(); const phoneNumber = loginUsernameInput.value; const password = loginPasswordInput.value; if (!phoneNumber || !password) { showAuthError("手机号和密码不能为空。"); return; } console.log(`[AUTH CLIENT] Attempting login for: ${phoneNumber}`); socket.emit('login', { phoneNumber, password }, handleAuthResponse); });
    if (registerButton) registerButton.addEventListener('click', () => { clearAuthError(); const phoneNumber = registerUsernameInput.value; const password = registerPasswordInput.value; if (!phoneNumber || password.length < 4) { showAuthError("手机号不能为空，密码至少4位。"); return; } console.log(`[AUTH CLIENT] Attempting registration for: ${phoneNumber}`); socket.emit('register', { phoneNumber, password }, (response) => { alert(response.message); if (response.success) { if (loginForm) loginForm.style.display = 'block'; if (registerForm) registerForm.style.display = 'none'; loginUsernameInput.value = phoneNumber; loginPasswordInput.value = ""; loginPasswordInput.focus(); } else showAuthError(response.message); }); });
    
    if (createRoomButton) { createRoomButton.addEventListener('click', () => { const roomName = roomNameInput.value.trim(); const password = roomPasswordInput.value; if (!roomName) { alert('请输入房间名称'); return; } console.log(`[LOBBY CLIENT] Attempting to create room: "${roomName}", password: "${password ? '******' : '无'}"`); socket.emit('createRoom', { roomName, password: password || null }, (response) => { console.log('[LOBBY CLIENT] Create room response:', response); if (response && response.success) { currentRoomId = response.roomId; currentRoomState = response.roomState; displayGameState(response.roomState); switchToView('game-view'); console.log(`[LOBBY CLIENT] Room "${roomName}" created! ID: ${response.roomId}`); } else { alert(`创建房间失败: ${response ? response.message : '未知错误。'}`); } }); }); }
    if (refreshRoomListButton) refreshRoomListButton.addEventListener('click', () => { if(socket.connected) { console.log("[LOBBY CLIENT] Refreshing room list..."); socket.emit('listRooms', updateRoomList); } else console.warn("Socket not connected for refresh room list."); });
    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => { console.log("[LOBBY CLIENT] Logging out."); socket.disconnect(); localStorage.removeItem('userId'); localStorage.removeItem('username'); myUserId=null;myUsername=null;currentRoomId=null;currentRoomState=null; if(loginUsernameInput) loginUsernameInput.value=''; if(loginPasswordInput) loginPasswordInput.value=''; if(registerUsernameInput) registerUsernameInput.value=''; if(registerPasswordInput) registerPasswordInput.value=''; switchToView('auth-view'); initialReauthAttempted=true; /* After logout, next connect won't try reauth unless new login */ });
    function updateRoomList(rooms) { if (!roomsListUl) return; roomsListUl.innerHTML = ''; if (rooms && rooms.length > 0) { rooms.forEach(room => { const li = document.createElement('li'); let joinBtnDisabled = room.status !== 'waiting' || room.playerCount >= room.maxPlayers; let joinButtonHtml = `<button data-roomid="${room.roomId}" class="join-room-btn" ${joinBtnDisabled ? 'disabled' : ''}>加入</button>`; if (room.hasPassword && !joinBtnDisabled) {  joinButtonHtml = `<button data-roomid="${room.roomId}" data-roomname="${room.roomName}" class="join-room-btn-pwd" ${joinBtnDisabled ? 'disabled' : ''}>加入 (有密码)</button>`; } else if (room.hasPassword && joinBtnDisabled) {  joinButtonHtml = `<button data-roomid="${room.roomId}" class="join-room-btn" disabled>加入 (有密码)</button>`; } li.innerHTML = `<span>${room.roomName} (${room.playerCount}/${room.maxPlayers}) - ${room.status === 'waiting' ? '等待中' : (room.status === 'playing' ? '游戏中' : '已结束')} ${room.hasPassword ? '' : ''}</span> ${joinButtonHtml}`; roomsListUl.appendChild(li); }); document.querySelectorAll('.join-room-btn, .join-room-btn-pwd').forEach(button => { if (button.disabled) return; button.addEventListener('click', (e) => { const roomIdToJoin = e.target.dataset.roomid; let passwordToJoin = null; if (e.target.classList.contains('join-room-btn-pwd')) { passwordToJoin = prompt(`请输入房间 "${e.target.dataset.roomname}" 的密码:`); if (passwordToJoin === null) return; } console.log(`[LOBBY CLIENT] Attempting to join room: ${roomIdToJoin}, password: ${passwordToJoin ? "******" : "无"}`); socket.emit('joinRoom', { roomId: roomIdToJoin, password: passwordToJoin }, (response) => { console.log('[LOBBY CLIENT] Join room response:', response); if (response && response.success) { currentRoomId = response.roomId; currentRoomState = response.roomState; displayGameState(response.roomState); switchToView('game-view'); } else alert(`加入房间失败: ${response ? response.message : '未知错误'}`); }); }); }); } else roomsListUl.innerHTML = '<li>没有可用的房间</li>'; }

    if (readyButton) { readyButton.addEventListener('click', () => { if (!currentRoomState || !myUserId) return; const myPlayer = currentRoomState.players.find(p => p.userId === myUserId); if (!myPlayer || currentRoomState.status !== 'waiting') return; const newReadyState = !myPlayer.isReady; console.log(`[GAME CLIENT] Sending playerReady: ${newReadyState}`); socket.emit('playerReady', newReadyState, (response) => { if (!response || !response.success) alert(`设置准备状态失败: ${response ? response.message : '未知错误'}`); }); }); }
    if (aiToggleButton) { aiToggleButton.addEventListener('click', () => { if (!currentRoomState || !myUserId) { alert("无法切换AI状态：不在房间内或未登录。"); return; } const myPlayer = currentRoomState.players.find(p => p.userId === myUserId); if (!myPlayer) { alert("无法切换AI状态：找不到玩家信息。"); return; } const newAiState = !isAi托管激活; console.log(`[GAME CLIENT] Requesting AI托管 toggle. New state: ${newAiState}`); socket.emit('toggleAI', { enabled: newAiState }, (response) => { if (response && response.success) { if (response.message) { showTemporaryMessage(response.message); } } else { alert(`AI托管操作失败: ${response ? response.message : '未知错误'}`); } }); }); }
    function showTemporaryMessage(message, duration = 2500) { const toast = document.createElement('div'); toast.textContent = message; toast.style.cssText = 'position:fixed; bottom:70px; left:50%; transform:translateX(-50%); background-color:rgba(0,0,0,0.75); color:white; padding:10px 15px; border-radius:5px; z-index:2000; font-size:0.9em; box-shadow: 0 2px 10px rgba(0,0,0,0.2);'; document.body.appendChild(toast); setTimeout(() => { toast.remove(); }, duration); }

    socket.on('gameStarted', (gameState) => { console.log('[EVENT GAME] gameStarted received:', gameState); currentRoomState = gameState; displayGameState(gameState, true); switchToView('game-view'); const mp=gameState.players.find(p=>p.userId===myUserId); console.log("[GAME CLIENT] Game started!" + (mp && mp.role ? ` Your role: ${mp.role}` : '')); });
    socket.on('gameStateUpdate', (gameState) => { console.log('[EVENT GAME] gameStateUpdate received:', gameState); currentRoomState = gameState; displayGameState(gameState, false); });
    socket.on('playerJoined', (playerInfo) => { console.log('[EVENT GAME] playerJoined:', playerInfo); if (currentRoomState && currentRoomState.players) { const existingPlayer = currentRoomState.players.find(p => p.userId === playerInfo.userId); if (!existingPlayer) { currentRoomState.players.push(playerInfo); } else { Object.assign(existingPlayer, playerInfo); } displayGameState(currentRoomState); } });
    socket.on('playerLeft', ({userId, username}) => { console.log(`[EVENT GAME] playerLeft: User ${username} (ID: ${userId})`); if (currentRoomState && currentRoomState.players) { currentRoomState.players = currentRoomState.players.filter(p => p.userId !== userId); displayGameState(currentRoomState); } });
    socket.on('playerReadyUpdate', ({ userId, isReady }) => { console.log(`[EVENT GAME] playerReadyUpdate: User ${userId} is ${isReady}`); if (currentRoomState && currentRoomState.players) { const player = currentRoomState.players.find(p => p.userId === userId); if (player) { player.isReady = isReady; updatePlayerReadyStatusUI(player.userId, isReady); if (userId === myUserId && readyButton) { readyButton.textContent = isReady ? "取消" : "准备"; readyButton.classList.toggle('cancel-ready', isReady); } } else { console.warn(`[EVENT GAME] playerReadyUpdate: Player ${userId} not found.`); } } });
    socket.on('allPlayersResetReady', () => { console.log('[EVENT GAME] allPlayersResetReady received.'); if (currentRoomState && currentRoomState.players) { currentRoomState.players.forEach(p => { p.isReady = false; updatePlayerReadyStatusUI(p.userId, false); }); if (myUserId && readyButton) { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); } } });
    socket.on('invalidPlay', (data) => { console.warn('[EVENT GAME] invalidPlay', data); alert(`无效操作: ${data.message}`); });
    socket.on('gameOver', (data) => { console.log('[EVENT GAME] gameOver received:', data); currentRoomState = { ...(currentRoomState || {}), ...data, gameFinished: true, gameStarted: false, status: 'finished', currentPlayerId: null }; displayGameState(currentRoomState); });
    socket.on('gameStartFailed', (data) => { console.error('[EVENT GAME] gameStartFailed received:', data); alert(`游戏开始失败: ${data.message}`); if (currentRoomState) currentRoomState.status = 'waiting'; displayGameState(currentRoomState);});

    function handleLeaveRoomAndReturnToLobby() { console.log("[GAME CLIENT] Attempting to leave room."); socket.emit('leaveRoom', (response) => { console.log('[GAME CLIENT] Leave room response:', response); currentRoomId = null; currentRoomState = null; selectedCardsForPlay = []; currentHint = null; isAi托管激活 = false; switchToView('lobby-view'); socket.emit('listRooms', updateRoomList); if (gameOverOverlay) { gameOverOverlay.classList.add('hidden-view'); gameOverOverlay.style.display = 'none';} }); }
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', handleLeaveRoomAndReturnToLobby);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', handleLeaveRoomAndReturnToLobby);

    if (playButton) {
        playButton.addEventListener('click', () => {
            if (selectedCardsForPlay.length === 0) { alert('请选择要出的牌'); return; }
            console.log("[GAME CLIENT] Play button clicked. Selected cards:", selectedCardsForPlay.map(c => cardObjectToKey(c)).join(','));
            const myPlayerInState = currentRoomState && currentRoomState.players ? currentRoomState.players.find(p => p.userId === myUserId) : null;
            if (!myPlayerInState || myPlayerInState.userId !== currentRoomState.currentPlayerId || isAi托管激活 || myPlayerInState.finished) {
                alert('现在不能出牌。'); console.warn(`[GAME CLIENT] Play attempt rejected. Conditions not met.`); return;
            }
            socket.emit('playCard', selectedCardsForPlay, (res) => {
                if (res && res.success) {
                    selectedCardsForPlay = []; currentHint = null; currentHintIndexFromServer = 0;
                    // UI update by gameStateUpdate
                } else { alert(`出牌失败: ${res ? res.message : '未知错误'}`); }
            });
        });
    }
    if (passButton) { passButton.addEventListener('click', () => { console.log("[GAME CLIENT] Passing turn."); clearSelectionAndHighlights(); socket.emit('passTurn', (res) => { if (res && !res.success) alert(`操作失败: ${res.message}`); }); }); }
    if (hintButton) {
        hintButton.addEventListener('click', () => {
            console.log("[GAME CLIENT] Requesting hint.");
            clearSelectionAndHighlights(); // Clear previous before applying new hint
            socket.emit('requestHint', currentHintIndexFromServer, (res) => {
                if (res.success && res.hint && res.hint.cards && res.hint.cards.length > 0) {
                    currentHint = res.hint.cards; currentHintIndexFromServer = res.nextHintIndex || 0;
                    selectedCardsForPlay = [...currentHint]; // Auto-select hinted cards
                    highlightHintedCards(currentHint, true); // Highlight and mark as selected
                    console.log("[GAME CLIENT] Hint received and auto-selected cards:", selectedCardsForPlay.map(c=>cardObjectToKey(c)).join(','));
                } else {
                    alert(res.message || '没有可用的提示。'); currentHint = null; currentHintIndexFromServer = 0; highlightHintedCards([]);
                }
                updatePlayButtonState(); // Update button after hint processed
            });
        });
    }
    
    function displayGameState(state, animateHandOnDisplay = false) {
        if (!state) { console.warn("[DISPLAY] displayGameState with null state."); switchToView(myUserId ? 'lobby-view' : 'auth-view'); return; }
        currentRoomState = state; // CRITICAL: Update global currentRoomState
        const myPlayer = state.players ? state.players.find(p => p.userId === myUserId) : null;

        if(infoBarRoomName) infoBarRoomName.textContent = state.roomName || '未知';
        if(infoBarRoomId) infoBarRoomId.textContent = state.roomId || '----';
        if(infoBarRoomStatus) infoBarRoomStatus.textContent = state.status === 'waiting' ? '等待中' : (state.status === 'playing' ? '游戏中' : (state.gameFinished || state.status === 'finished' ? '已结束' : state.status));
        const turnPlayer = state.players.find(p => p.userId === state.currentPlayerId);
        if(infoBarCurrentTurn) infoBarCurrentTurn.textContent = turnPlayer ? turnPlayer.username : (state.gameFinished ? '结束' : (state.status === 'playing' ? '等待' : 'N/A'));

        if (myInfoInBar && myPlayer) {
            myInfoInBar.dataset.playerId = myPlayer.userId;
            myInfoInBar.querySelector('#myPlayerName').textContent = myPlayer.username || "我";
            myInfoInBar.querySelector('#myPlayerStatus .card-count').textContent = myPlayer.handCount !== undefined ? myPlayer.handCount : '?';
            const myReadyEl = myInfoInBar.querySelector('#myPlayerStatus .player-ready-status');
            myReadyEl.textContent = myPlayer.isReady ? "✓已备" : "✗未备";
            myReadyEl.className = `player-ready-status ${myPlayer.isReady ? 'ready' : 'not-ready'}`;
            myReadyEl.style.display = (state.status === 'waiting' && !state.gameFinished) ? 'inline' : 'none';
            myInfoInBar.classList.toggle('current-turn', state.status === 'playing' && state.currentPlayerId === myPlayer.userId && !state.gameFinished);
            myInfoInBar.classList.toggle('player-finished', !!myPlayer.finished);
            myInfoInBar.classList.toggle('player-disconnected', !myPlayer.connected);
        } else if (myInfoInBar) { /* Clear my info if not in game */ myInfoInBar.classList.remove('current-turn'); /* ... other clearings */ }

        const opponentSlotMap = {};
        if (myPlayer && state.players) { const mySlot = myPlayer.slot; const activePlayers = state.players.filter(p => p.id !== myPlayer.id); const numOpponents = activePlayers.length; if (numOpponents > 0) { activePlayers.sort((a,b) => (a.slot - mySlot + state.players.length) % state.players.length - (b.slot - mySlot + state.players.length) % state.players.length ); if (numOpponents === 1) opponentSlotMap['top'] = activePlayers[0]; else if (numOpponents === 2) { opponentSlotMap['right'] = activePlayers[0]; opponentSlotMap['left'] = activePlayers[1]; } else if (numOpponents >= 3) { opponentSlotMap['right'] = activePlayers[0]; opponentSlotMap['top'] = activePlayers[1]; opponentSlotMap['left'] = activePlayers[2]; } } }
        ['top', 'left', 'right'].forEach(pK => updateOpponentUIElement(document.getElementById(`player-${pK}`), opponentSlotMap[pK], state.currentPlayerId, state.gameFinished, state.status));
        
        isAi托管激活 = myPlayer ? !!myPlayer.isAiControlled : false;
        if (aiToggleButton) { aiToggleButton.classList.toggle('ai-active', isAi托管激活); aiToggleButton.textContent = isAi托管激活 ? "取消AI" : "AI托管"; }

        if (myPlayer) {
            updatePlayerHandUI(myPlayer.hand || [], state.status === 'playing' && state.currentPlayerId === myPlayer.userId && myPlayer.connected && !myPlayer.finished && !isAi托管激活, animateHandOnDisplay);
            const isWaiting = state.status === 'waiting'; const isPlaying = state.status === 'playing';
            if(readyButton) { readyButton.style.display = isWaiting && !state.gameFinished ? 'inline-block' : 'none'; readyButton.disabled = state.gameFinished || isAi托管激活; readyButton.textContent = myPlayer.isReady ? "取消" : "准备"; readyButton.classList.toggle('cancel-ready', myPlayer.isReady); }
            const showGameplayButtons = isPlaying && myPlayer.connected && !myPlayer.finished;
            [hintButton, passButton, playButton, micButton, aiToggleButton].forEach(btn => { if(btn) btn.style.display = showGameplayButtons || (btn === readyButton && isWaiting) ? 'inline-block' : 'none'; });
            updatePlayButtonState(); // Centralized update
            if (passButton) passButton.disabled = !(isPlaying && myPlayer.connected && !myPlayer.finished && !isAi托管激活 && state.currentPlayerId === myPlayer.userId && !state.isFirstTurn && state.lastHandInfo && (!state.lastPlayerWhoPlayedId || state.lastPlayerWhoPlayedId !== myPlayer.userId));
            if (hintButton) hintButton.disabled = !(isPlaying && myPlayer.connected && !myPlayer.finished && !isAi托管激活 && state.currentPlayerId === myPlayer.userId);
            if (micButton) micButton.disabled = state.gameFinished || !myPlayer.connected;
            if (aiToggleButton) aiToggleButton.disabled = state.gameFinished || !myPlayer.connected || (state.status !== 'playing' && state.status !== 'waiting');
        } else { updatePlayerHandUI([], false, false); [readyButton, hintButton, passButton, playButton, micButton, aiToggleButton].forEach(btn => { if(btn) {btn.style.display = 'none'; btn.disabled = true;} }); }
        updateCenterPileUI(state.centerPile, state.lastHandInfo);
        if (gameOverOverlay) { const showOverlay = !!state.gameFinished; gameOverOverlay.style.display = showOverlay ? 'flex' : 'none'; gameOverOverlay.classList.toggle('hidden-view', !showOverlay); if(showOverlay && gameOverTitle && gameOverReasonText && gameOverScoresDiv && state.finalScores) { gameOverTitle.textContent=`游戏结束 - ${state.gameResultText||state.result||"结果"}`; gameOverReasonText.textContent=state.gameOverReason||state.reason||""; gameOverScoresDiv.innerHTML='';state.finalScores.forEach(ps=>{const pEl=document.createElement('p');const sc=state.scoreChanges?(state.scoreChanges[ps.id]||0):0;pEl.innerHTML=`${ps.name}(${ps.role||'?'}) : ${ps.score} <span class="${sc>0?'score-plus':(sc<0?'score-minus':'score-zero')}">(${sc>=0?'+':''}${sc})</span>`;gameOverScoresDiv.appendChild(pEl);});}}
    }

    function updatePlayerHandUI(hCards, isMyTurnAndCanAct, animate = false) {
        if (!playerHandArea) return;
        playerHandArea.innerHTML = '';
        if (!hCards || hCards.length === 0) { updatePlayButtonState(); return; }
        hCards.forEach((cardData, idx) => {
            const cardDiv = createCardElement(cardData); cardDiv.classList.add('my-card');
            if (animate) { cardDiv.classList.add('card-in-hand'); void cardDiv.offsetWidth; setTimeout(() => cardDiv.classList.add('dealt'), idx * 70 + 50); }
            else { cardDiv.classList.add('card-in-hand', 'dealt'); }
            const cardKey = cardObjectToKey(cardData);
            if (selectedCardsForPlay.some(sc => cardObjectToKey(sc) === cardKey)) cardDiv.classList.add('selected');
            if (currentHint && currentHint.some(hc => cardObjectToKey(hc) === cardKey)) cardDiv.classList.add('hinted');
            playerHandArea.appendChild(cardDiv);
            if (isMyTurnAndCanAct) {
                cardDiv.classList.add('selectable');
                cardDiv.addEventListener('click', () => {
                    console.log(`[GAME CLIENT] Card clicked: ${cardObjectToKey(cardData)}`);
                    toggleCardSelection(cardDiv, cardData);
                    if (currentHint) {
                        const clickedKey = cardObjectToKey(cardData);
                        const isPartOfHint = currentHint.some(hc => cardObjectToKey(hc) === clickedKey);
                        const currentSelectionExactlyMatchesHint = selectedCardsForPlay.length === currentHint.length && selectedCardsForPlay.every(sc => currentHint.some(hc => cardObjectToKey(hc) === cardObjectToKey(sc)));
                        if (!isPartOfHint || !currentSelectionExactlyMatchesHint) {
                            highlightHintedCards([], false); currentHint = null; currentHintIndexFromServer = 0;
                        }
                    }
                });
            }
        });
        updatePlayButtonState();
    }

    function toggleCardSelection(cardDiv, cardData) {
        const cardKey = cardObjectToKey(cardData);
        const indexInSelection = selectedCardsForPlay.findIndex(c => cardObjectToKey(c) === cardKey);
        if (indexInSelection > -1) {
            selectedCardsForPlay.splice(indexInSelection, 1); cardDiv.classList.remove('selected');
            console.log(`[GAME CLIENT] Card unselected: ${cardKey}. Remaining: ${selectedCardsForPlay.length}`);
        } else {
            selectedCardsForPlay.push(cardData); cardDiv.classList.add('selected');
            console.log(`[GAME CLIENT] Card selected: ${cardKey}. Total selected: ${selectedCardsForPlay.length}`);
        }
        updatePlayButtonState(); // Always update button state after selection changes
    }

    function updatePlayButtonState() {
        if (!playButton || !currentRoomState) return;
        const myPlayer = currentRoomState.players ? currentRoomState.players.find(p => p.userId === myUserId) : null;
        let canPlay = false;
        if (myPlayer && currentRoomState.status === 'playing' &&
            myPlayer.userId === currentRoomState.currentPlayerId &&
            myPlayer.connected && !myPlayer.finished && !isAi托管激活 &&
            selectedCardsForPlay.length > 0) {
            canPlay = true;
        }
        playButton.disabled = !canPlay;
    }

    function clearSelectionAndHighlights() {
        if (!playerHandArea) return;
        playerHandArea.querySelectorAll('.my-card.selected').forEach(c => c.classList.remove('selected'));
        playerHandArea.querySelectorAll('.my-card.hinted').forEach(c => c.classList.remove('hinted'));
        selectedCardsForPlay = []; currentHint = null;
        updatePlayButtonState();
        console.log("[GAME CLIENT] Cleared card selections and highlights.");
    }

    function highlightHintedCards(hintedCardsArray, alsoSelectThem = false) {
        if (!playerHandArea) return;
        const hintedCardKeys = new Set((hintedCardsArray || []).map(cardObjectToKey).filter(k => k !== null));
        playerHandArea.querySelectorAll('.my-card').forEach(cardEl => {
            const cardElKey = cardObjectToKey(cardEl.dataset);
            if (hintedCardKeys.has(cardElKey)) cardEl.classList.add('hinted');
            else cardEl.classList.remove('hinted');
            if (alsoSelectThem) { // If applying hint as selection
                if (hintedCardKeys.has(cardElKey)) cardEl.classList.add('selected');
                else cardEl.classList.remove('selected'); // Unselect cards not in this specific hint
            }
        });
        if (alsoSelectThem) updatePlayButtonState(); // If selection changed due to hint, update button
    }

    function updateOpponentUIElement(areaEl, pData, cTurnPId, isGFinished, rStatus) { if (!areaEl) return; const nE=areaEl.querySelector('.playerName'), rE=areaEl.querySelector('.playerRole'), cE=areaEl.querySelector('.playerInfo .card-count'), readyE=areaEl.querySelector('.player-ready-status'); if (pData) { areaEl.dataset.playerId = pData.userId; if(nE)nE.textContent=pData.username; if(rE)rE.textContent=pData.role?`(${pData.role})`:''; if(cE)cE.textContent=pData.handCount!==undefined?pData.handCount:'?'; if(readyE){readyE.textContent=pData.isReady?"✓已备":"✗未备"; readyE.className=`player-ready-status ${pData.isReady?'ready':'not-ready'}`; readyE.style.display=rStatus==='waiting'&&!isGFinished?'inline':'none';} areaEl.classList.toggle('current-turn', rStatus==='playing' && cTurnPId===pData.userId && !isGFinished); areaEl.classList.toggle('player-finished',!!pData.finished); areaEl.classList.toggle('player-disconnected',!pData.connected); areaEl.style.opacity=pData.connected?'1':'0.6'; } else { if(nE)nE.textContent='等待...';if(rE)rE.textContent='';if(cE)cE.textContent='?';if(readyE)readyE.style.display='none'; areaEl.classList.remove('current-turn','player-finished','player-disconnected'); areaEl.removeAttribute('data-player-id');areaEl.style.opacity='0.7'; } }
    function updatePlayerReadyStatusUI(pUserId, isReady) { let tA; if (pUserId === myUserId) tA = myInfoInBar; else tA = document.querySelector(`.opponent-area[data-player-id="${pUserId}"]`); if (tA) { const rSE = tA.querySelector('.player-ready-status'); if (rSE) { rSE.textContent = isReady ? "✓已备" : "✗未备"; rSE.className = `player-ready-status ${isReady ? 'ready' : 'not-ready'}`; if (currentRoomState) { rSE.style.display = (currentRoomState.status === 'waiting' && !currentRoomState.gameFinished) ? 'inline' : 'none'; } else { rSE.style.display = 'none'; } } } }
    function updateCenterPileUI(cPileCards, lHInfo) {  if(!discardedCardsArea)return; const lHTDisp=document.getElementById('lastHandType'); discardedCardsArea.innerHTML=''; let csToDisp=[]; let hTMsg="等待出牌"; if(lHInfo&&lHInfo.cards&&lHInfo.cards.length>0){csToDisp=lHInfo.cards;hTMsg=`类型: ${lHInfo.type||'未知'}`;}else if(cPileCards&&cPileCards.length>0&&(!lHInfo||(lHInfo.cards&&lHInfo.cards.length===0))){csToDisp=cPileCards;hTMsg="当前出牌";}if(lHTDisp)lHTDisp.textContent=hTMsg;if(csToDisp.length>0)csToDisp.forEach(cD=>{const cDiv=createCardElement(cD);cDiv.classList.add('center-pile-card');discardedCardsArea.appendChild(cDiv);});}
    function createCardElement(cardData) { const cardDiv = document.createElement('div'); cardDiv.className = 'card'; if(!cardData || !cardData.rank || !cardData.suit) { console.error("[GFX] Invalid cardData for createCardElement:", cardData); cardDiv.textContent = "ERR"; return cardDiv;} cardDiv.dataset.rank = cardData.rank; cardDiv.dataset.suit = cardData.suit; const rankPart = rankToImageNamePart[cardData.rank]; const suitPart = suitToImageNamePart[cardData.suit]; let imageName; if (rankPart && suitPart) { imageName = `${rankPart}_of_${suitPart}${CARD_IMAGE_EXTENSION}`; } else { console.warn(`[GFX] Failed to map card: suit=${cardData.suit}, rank=${cardData.rank}. Using back.`); imageName = CARD_BACK_IMAGE; cardDiv.textContent = `${cardData.suit}${cardData.rank}`; } const imagePath = `/images/cards/${imageName}`; try { cardDiv.style.backgroundImage = `url('${imagePath}')`; } catch (e) { console.error(`[GFX] Error setting image for ${imagePath}:`, e); cardDiv.textContent = `${cardData.suit}${cardData.rank}`; } return cardDiv; }
    function cardObjectToKey(card) { if (!card || typeof card.rank === 'undefined' || typeof card.suit === 'undefined') { return null; } return `${card.rank}${card.suit}`; }
    async function handleVoicePress(evt){ evt.preventDefault(); if(isRecording || !currentRoomId || (currentRoomState && currentRoomState.gameFinished)) return; console.log('[VOICE] Mic pressed'); if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){alert("浏览器不支持麦克风(getUserMedia)。请更新或用HTTPS/localhost。");return;} isRecording=true;audioChunks=[]; if(micButton)micButton.classList.add('recording'); if(socket&&socket.connected)socket.emit('playerStartSpeaking'); try{ const strm=await navigator.mediaDevices.getUserMedia({audio:true}); const mTs=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4']; let selMT=''; for(const mT of mTs){if(MediaRecorder.isTypeSupported(mT)){selMT=mT;break;}} console.log("[VOICE] Using MIME:",selMT||'default'); mediaRecorder=selMT?new MediaRecorder(strm,{mimeType:selMT}):new MediaRecorder(strm); mediaRecorder.ondataavailable=e=>{if(e.data.size>0)audioChunks.push(e.data);}; mediaRecorder.onstop=()=>{ console.log('[VOICE] Recorder stopped'); if(audioChunks.length > 0 && currentRoomId && socket && socket.connected){ const bMT=selMT||(audioChunks[0]&&audioChunks[0].type)||'application/octet-stream'; const aB=new Blob(audioChunks,{type:bMT}); console.log(`[VOICE] Sending blob type ${aB.type}, size ${aB.size}`); socket.emit('sendVoiceMessage',{roomId:currentRoomId,audioBlob:aB}); } else console.log("[VOICE] No chunks/room/socket"); audioChunks=[]; if(strm)strm.getTracks().forEach(t=>t.stop()); }; mediaRecorder.start(); console.log('[VOICE] Recorder started'); }catch(err){ console.error('[VOICE] Mic err:',err); alert(`麦克风错误: ${err.name} - ${err.message}\n请检查权限和HTTPS。`); isRecording=false; if(micButton)micButton.classList.remove('recording'); if(socket&&socket.connected)socket.emit('playerStopSpeaking'); if(mediaRecorder&&mediaRecorder.stream)mediaRecorder.stream.getTracks().forEach(t=>t.stop()); else if(err.stream && typeof err.stream.getTracks === 'function')err.stream.getTracks().forEach(t=>t.stop()); } }
    function handleVoiceRelease(evt){evt.preventDefault();if(!isRecording)return;console.log('[VOICE] Mic released');isRecording=false;if(micButton)micButton.classList.remove('recording');if(socket&&socket.connected)socket.emit('playerStopSpeaking');if(mediaRecorder&&mediaRecorder.state==='recording')mediaRecorder.stop();else if(mediaRecorder&&mediaRecorder.stream)mediaRecorder.stream.getTracks().forEach(t=>t.stop());}
    function findSpeakingPlayerArea(sUID){if(sUID===myUserId)return myInfoInBar;return document.querySelector(`.opponent-area[data-player-id="${sUID}"]`);}
    socket.on('playerStartedSpeaking',({userId,username})=>{console.log(`[VOICE] ${username}(${userId}) speaking`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.add('speaking');}});
    socket.on('playerStoppedSpeaking',({userId})=>{console.log(`[VOICE] ${userId} stopped`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.remove('speaking');}});
    socket.on('receiveVoiceMessage',(data)=>{if(!data||!data.audioBlob){console.error("[VOICE] Invalid voice data", data); return;}console.log('[VOICE] Voice from:',data.userId,"type:",data.audioBlob.type,"size:",data.audioBlob.size);const{userId,audioBlob}=data;if(!(audioBlob instanceof Blob)||audioBlob.size===0){console.error("[VOICE] Invalid blob:",audioBlob);return;}try{const aUrl=URL.createObjectURL(audioBlob);const aud=new Audio(aUrl);aud.play().catch(e=>console.error('[VOICE] Playback err:',e));aud.onended=()=>URL.revokeObjectURL(aUrl);aud.onerror=(e)=>{console.error(`[VOICE] Audio err ${userId}:`,e);URL.revokeObjectURL(aUrl);};}catch(e){console.error("[VOICE] Create Object URL/play err:", e)}});

}); // END DOMContentLoaded
