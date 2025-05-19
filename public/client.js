// client.js
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed. Client v1.0.34'); // 版本号更新
    const socket = io({
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
    });

    let myUserId = null;
    let myUsername = null;
    let currentRoomId = null;
    let currentRoomState = null;
    let selectedCardsForPlay = [];
    let currentHint = null;
    let currentHintIndexFromServer = 0;
    let initialReauthAttempted = false;

    // Views
    const loadingView = document.getElementById('loadingView');
    const authView = document.getElementById('auth-view');
    const lobbyView = document.getElementById('lobby-view');
    const gameView = document.getElementById('game-view');
    const allViews = [loadingView, authView, lobbyView, gameView];

    // Auth elements
    // ... (保持不变) ...
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
    // ... (保持不变) ...
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
    const aiToggleButton = document.getElementById('ai-toggle-button'); // 新增

    // Game Over Overlay elements
    // ... (保持不变) ...
    const gameOverOverlay = document.getElementById('gameOverOverlay');
    const gameOverTitle = document.getElementById('gameOverTitle');
    const gameOverReasonText = document.getElementById('gameOverReasonText');
    const gameOverScoresDiv = document.getElementById('gameOverScores');
    const backToLobbyBtnOverlay = gameOverOverlay.querySelector('#backToLobbyBtn');


    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;
    let isAi托管激活 = false; // 新增: AI托管状态

    // Card Image Mapping (保持不变)
    // ... (省略) ...
    const rankToImageNamePart = { 'A': 'ace', 'K': 'king', 'Q': 'queen', 'J': 'jack', 'T': '10', '9': '9', '8': '8', '7': '7', '6': '6', '5': '5', '4': '4', '3': '3', '2': '2' };
    const suitToImageNamePart = { 'S': 'spades', 'H': 'hearts', 'D': 'diamonds', 'C': 'clubs' };
    const CARD_IMAGE_EXTENSION = '.jpg';
    const CARD_BACK_IMAGE = 'back.jpg';


    function switchToView(targetViewId) { /* ... (保持不变) ... */ 
        console.log(`[VIEW] Switching to view: ${targetViewId}`);
        allViews.forEach(view => {
            if (view) {
                if (view.id === targetViewId) {
                    view.classList.remove('hidden-view');
                    view.style.display = 'flex';
                    if (view.id === 'game-view') view.style.flexDirection = 'column';
                } else {
                    view.classList.add('hidden-view');
                    view.style.display = 'none';
                }
            } else {
                console.warn(`[VIEW] Element with ID ${view ? view.id : 'unknown'} not found during view switch.`);
            }
        });
    }

    // Auth and Connection Logic (大部分保持不变)
    // ... (省略switchToView之后到Lobby Logic之前的部分，假设它们不需要大改) ...
    switchToView('loadingView');
    const storedUserId = localStorage.getItem('userId');
    if (storedUserId) {
        initialReauthAttempted = true;
        console.log(`[AUTH] Initial: Found stored user ID: ${storedUserId}, attempting reauthentication.`);
        socket.emit('reauthenticate', storedUserId, (response) => {
            console.log('[AUTH] Initial Reauthenticate response:', response);
            if (response && response.success) handleAuthSuccess(response);
            else {
                showAuthError(response ? response.message : "重认证失败");
                localStorage.removeItem('userId'); localStorage.removeItem('username');
                switchToView('auth-view');
            }
        });
    } else {
        initialReauthAttempted = true;
        console.log('[AUTH] Initial: No stored user ID found.');
        switchToView('auth-view');
    }
    function showAuthError(message) { if (authErrorElement) { authErrorElement.textContent = message; authErrorElement.style.display = 'block'; } else alert(message); }
    function clearAuthError() { if (authErrorElement) { authErrorElement.textContent = ''; authErrorElement.style.display = 'none'; } }
    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (loginForm) loginForm.style.display = 'none'; if (registerForm) registerForm.style.display = 'block'; });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (registerForm) registerForm.style.display = 'none'; if (loginForm) loginForm.style.display = 'block'; });
    if (loginButton) loginButton.addEventListener('click', () => { clearAuthError(); const phoneNumber = loginUsernameInput.value; const password = loginPasswordInput.value; if (!phoneNumber || !password) { showAuthError("手机号和密码不能为空。"); return; } console.log(`[AUTH] Attempting login for: ${phoneNumber}`); socket.emit('login', { phoneNumber, password }, handleAuthResponse); });
    if (registerButton) registerButton.addEventListener('click', () => { clearAuthError(); const phoneNumber = registerUsernameInput.value; const password = registerPasswordInput.value; if (!phoneNumber || password.length < 4) { showAuthError("手机号不能为空，密码至少4位。"); return; } console.log(`[AUTH] Attempting registration for: ${phoneNumber}`); socket.emit('register', { phoneNumber, password }, (response) => { alert(response.message); if (response.success) { if (loginForm) loginForm.style.display = 'block'; if (registerForm) registerForm.style.display = 'none'; loginUsernameInput.value = phoneNumber; loginPasswordInput.value = ""; loginPasswordInput.focus(); } else showAuthError(response.message); }); });
    function handleAuthSuccess(data) { if (!data || !data.userId) { console.error("[AUTH] handleAuthSuccess called with invalid data:", data); showAuthError("认证数据无效，请重试。"); switchToView('auth-view'); return; } myUserId = data.userId; myUsername = data.username; localStorage.setItem('userId', data.userId); if(lobbyUsernameSpan) lobbyUsernameSpan.textContent = myUsername; clearAuthError(); console.log(`[AUTH] Auth success for user: ${myUsername} (ID: ${myUserId})`); if (data.roomState && data.roomState.roomId) { currentRoomId = data.roomState.roomId; console.log(`[AUTH] User was in room ${currentRoomId}, displaying game state.`); displayGameState(data.roomState, true); switchToView('game-view'); } else { if (currentRoomId) { currentRoomId = null; currentRoomState = null; } console.log('[AUTH] User not in a room, switching to lobby.'); switchToView('lobby-view'); if (socket.connected) socket.emit('listRooms', updateRoomList); else console.warn("[AUTH] Socket not connected, cannot fetch room list yet."); } }
    function handleAuthResponse(response) { console.log('[AUTH] Login/Re-auth response received:', response); if (response && response.success) handleAuthSuccess(response); else {  showAuthError(response ? response.message : "认证失败，请重试。");  localStorage.removeItem('userId'); myUserId = null; myUsername = null;  switchToView('auth-view');  } }
    socket.on('connect', () => { console.log('[SOCKET] Connected to server with ID:', socket.id); const lsUserId = localStorage.getItem('userId'); if (!myUserId && lsUserId) {  console.log("[SOCKET] Connect event: Attempting reauthenticate as user not logged in but has stored ID."); socket.emit('reauthenticate', lsUserId, handleAuthResponse);  } else if (myUserId) {  console.log("[SOCKET] Socket reconnected, user was logged in. Requesting sync data."); if (currentRoomId) { socket.emit('requestGameState', (state) => { if (state) {  console.log("[SOCKET] Reconnected in room, received game state:", state); currentRoomState = state;  displayGameState(state);  } else {  console.warn("[SOCKET] Reconnected in room, but failed to get game state. Returning to lobby."); currentRoomId = null; currentRoomState = null;  switchToView('lobby-view');  socket.emit('listRooms', updateRoomList);  } }); } else { console.log("[SOCKET] Reconnected in lobby, fetching room list."); socket.emit('listRooms', updateRoomList); if (authView.style.display !== 'none' || loadingView.style.display !== 'none') {  switchToView('lobby-view'); } } } else {  console.log("[SOCKET] Connect event: No active login session or stored ID. Displaying auth view."); if (loadingView.style.display !== 'none') {  switchToView('auth-view'); } } initialReauthAttempted = true;  });
    socket.on('disconnect', (reason) => { console.log('[SOCKET] Disconnected from server:', reason); alert('与服务器断开连接: ' + reason + ". 请刷新页面重试。"); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent='已断开连接...'; initialReauthAttempted = false; });
    socket.on('connect_error', (err) => { console.error('[SOCKET] Connection error:', err.message); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent=`连接错误: ${err.message}.`; });

    // Lobby Logic (保持不变)
    // ... (省略) ...
    if (createRoomButton) { createRoomButton.addEventListener('click', () => { const roomName = roomNameInput.value.trim(); const password = roomPasswordInput.value; if (!roomName) { alert('请输入房间名称'); return; } console.log(`[CLIENT] Attempting to create room: "${roomName}", password: "${password || '无'}"`); socket.emit('createRoom', { roomName, password: password || null }, (response) => { console.log('[CLIENT] Create room response from server:', response); if (response && response.success) { currentRoomId = response.roomId; displayGameState(response.roomState);  switchToView('game-view'); console.log(`[CLIENT] Room "${roomName}" created successfully! ID: ${response.roomId}`); } else { alert(`创建房间失败: ${response ? response.message : '服务器未响应或发生未知错误。'}`); } }); }); }
    socket.on('roomListUpdate', (rooms) => { console.log("[EVENT] roomListUpdate received:", rooms); updateRoomList(rooms); });
    function updateRoomList(rooms) { if (!roomsListUl) return; roomsListUl.innerHTML = ''; if (rooms && rooms.length > 0) { rooms.forEach(room => { const li = document.createElement('li'); let joinBtnDisabled = room.status !== 'waiting' || room.playerCount >= room.maxPlayers; let joinButtonHtml = `<button data-roomid="${room.roomId}" class="join-room-btn" ${joinBtnDisabled ? 'disabled' : ''}>加入</button>`; if (room.hasPassword && !joinBtnDisabled) {  joinButtonHtml = `<button data-roomid="${room.roomId}" data-roomname="${room.roomName}" class="join-room-btn-pwd" ${joinBtnDisabled ? 'disabled' : ''}>加入 (有密码)</button>`; } else if (room.hasPassword && joinBtnDisabled) {  joinButtonHtml = `<button data-roomid="${room.roomId}" class="join-room-btn" disabled>加入 (有密码)</button>`; } li.innerHTML = `<span>${room.roomName} (${room.playerCount}/${room.maxPlayers}) - ${room.status} ${room.hasPassword ? '' : ''}</span> ${joinButtonHtml}`; roomsListUl.appendChild(li); }); document.querySelectorAll('.join-room-btn, .join-room-btn-pwd').forEach(button => { if (button.disabled) return;  button.addEventListener('click', (e) => { const roomIdToJoin = e.target.dataset.roomid; let passwordToJoin = null; if (e.target.classList.contains('join-room-btn-pwd')) { passwordToJoin = prompt(`请输入房间 "${e.target.dataset.roomname}" 的密码:`); if (passwordToJoin === null) return; } console.log(`[CLIENT] Attempting to join room: ${roomIdToJoin}, password: ${passwordToJoin ? "******" : "无"}`); socket.emit('joinRoom', { roomId: roomIdToJoin, password: passwordToJoin }, (response) => { console.log('[CLIENT] Join room response:', response); if (response && response.success) { currentRoomId = response.roomId;  displayGameState(response.roomState);   switchToView('game-view'); } else alert(`加入房间失败: ${response ? response.message : '未知错误'}`); }); }); }); } else roomsListUl.innerHTML = '<li>没有可用的房间</li>'; }
    if (refreshRoomListButton) refreshRoomListButton.addEventListener('click', () => { if(socket.connected) socket.emit('listRooms', updateRoomList); else console.warn("Socket not connected for refresh."); });
    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => { localStorage.removeItem('userId'); localStorage.removeItem('username'); myUserId=null;myUsername=null;currentRoomId=null;currentRoomState=null;if(loginForm)loginForm.reset();if(registerForm)registerForm.reset();switchToView('auth-view');initialReauthAttempted=false;});


    // Game Logic - Ready Button (保持不变)
    // ... (省略) ...
    if (readyButton) { readyButton.addEventListener('click', () => { if (!currentRoomState || !myUserId) { console.warn("[READY] No room state or user ID."); return; } const myPlayer = currentRoomState.players.find(p => p.userId === myUserId); if (!myPlayer || currentRoomState.status !== 'waiting') { console.warn("[READY] Not in waiting state or player not found."); return; } const newReadyState = !myPlayer.isReady; console.log(`[CLIENT] Sending playerReady: ${newReadyState}`); socket.emit('playerReady', newReadyState, (response) => { console.log('[CLIENT] playerReady callback response:', response); if (!response || !response.success) alert(`设置准备状态失败: ${response ? response.message : '未知错误'}`); }); }); }


    // AI Toggle Button Logic
    if (aiToggleButton) {
        aiToggleButton.addEventListener('click', () => {
            if (!currentRoomState || !myUserId) {
                alert("无法切换AI状态：不在房间内或未登录。");
                return;
            }
            const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
            if (!myPlayer) {
                alert("无法切换AI状态：找不到玩家信息。");
                return;
            }

            // 假设服务器会通过gameStateUpdate同步AI状态，客户端只发送请求
            // 如果需要本地立即反馈，可以先切换isAi托管激活，请求失败再恢复
            const newAiState = !isAi托管激活; // 预期的AI新状态

            console.log(`[CLIENT] Requesting AI托管 toggle. New state: ${newAiState}`);
            socket.emit('toggleAI', { enabled: newAiState }, (response) => {
                if (response && response.success) {
                    // isAi托管激活 = newAiState; // 由服务器通过gameStateUpdate来最终确认状态
                    // aiToggleButton.classList.toggle('ai-active', isAi托管激活);
                    // aiToggleButton.textContent = isAi托管激活 ? "取消AI" : "AI托管";
                    console.log(`[AI] AI托管请求已发送，等待服务器状态更新。`);
                    if (response.message) {
                        showTemporaryMessage(response.message);
                    }
                } else {
                    alert(`AI托管操作失败: ${response ? response.message : '未知错误'}`);
                }
            });
        });
    }

    function showTemporaryMessage(message, duration = 2500) {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.position = 'fixed';
        toast.style.bottom = '70px'; 
        toast.style.left = '50%';
        toast.style.transform = 'translateX(-50%)';
        toast.style.backgroundColor = 'rgba(0,0,0,0.75)';
        toast.style.color = 'white';
        toast.style.padding = '10px 15px';
        toast.style.borderRadius = '5px';
        toast.style.zIndex = '2000';
        toast.style.fontSize = '0.9em';
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.remove();
        }, duration);
    }


    // Game Socket Event Handlers (大部分保持不变)
    // ... (省略) ...
    socket.on('gameStarted', (gameState) => {  console.log('[EVENT] gameStarted received:', gameState);  currentRoomState = gameState;  displayGameState(gameState, true);  switchToView('game-view');  const mp=gameState.players.find(p=>p.userId===myUserId);  console.log("[CLIENT] Game started!" + (mp && mp.role ? ` Your role: ${mp.role}` : ''));  });
    socket.on('gameStateUpdate', (gameState) => {  console.log('[EVENT] gameStateUpdate received:', gameState);  currentRoomState = gameState;  displayGameState(gameState, false);  });
    socket.on('playerJoined', (playerInfo) => {  console.log('[EVENT] playerJoined:', playerInfo); if (currentRoomState && currentRoomState.players) { const existingPlayer = currentRoomState.players.find(p => p.userId === playerInfo.userId); if (!existingPlayer) { currentRoomState.players.push(playerInfo); } else {  Object.assign(existingPlayer, playerInfo); } displayGameState(currentRoomState);  } });
    socket.on('playerLeft', ({userId}) => {  console.log('[EVENT] playerLeft:', userId); if (currentRoomState && currentRoomState.players) { currentRoomState.players = currentRoomState.players.filter(p => p.userId !== userId); displayGameState(currentRoomState);  } });
    socket.on('playerReadyUpdate', ({ userId, isReady }) => { console.log(`[EVENT] playerReadyUpdate: User ${userId} is ${isReady}`); if (currentRoomState && currentRoomState.players) { const player = currentRoomState.players.find(p => p.userId === userId); if (player) { player.isReady = isReady;  updatePlayerReadyStatusUI(player.userId, isReady); if (userId === myUserId && readyButton) {  readyButton.textContent = isReady ? "取消" : "准备";  readyButton.classList.toggle('cancel-ready', isReady);  } } else { console.warn(`[EVENT] playerReadyUpdate: Player ${userId} not found in currentRoomState.players. Current players:`, currentRoomState.players.map(p=>p.userId)); } } else { console.warn("[EVENT] playerReadyUpdate: currentRoomState or players array is null/undefined."); } });
    socket.on('allPlayersResetReady', () => { console.log('[EVENT] allPlayersResetReady'); if (currentRoomState && currentRoomState.players) { currentRoomState.players.forEach(p => { p.isReady = false; updatePlayerReadyStatusUI(p.userId, false); }); if (myUserId && readyButton) { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); } } });
    socket.on('invalidPlay', (data) => { console.warn('[EVENT] invalidPlay', data); alert(`无效操作: ${data.message}`); });
    socket.on('gameOver', (data) => { console.log('[EVENT] gameOver', data); currentRoomState = { ...(currentRoomState || {}), ...data, gameFinished: true, gameStarted: false, currentPlayerId: null }; displayGameState(currentRoomState); });
    
    // Leave Room, Game Action Buttons (保持不变)
    // ... (省略) ...
    function handleLeaveRoomAndReturnToLobby() { console.log("[CLIENT] Attempting to leave room."); socket.emit('leaveRoom', (response) => { console.log('[CLIENT] Leave room response:', response); currentRoomId = null; currentRoomState = null; selectedCardsForPlay = []; currentHint = null; switchToView('lobby-view'); socket.emit('listRooms', updateRoomList); if (gameOverOverlay) { gameOverOverlay.classList.add('hidden-view'); gameOverOverlay.style.display = 'none';} }); }
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', handleLeaveRoomAndReturnToLobby);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', handleLeaveRoomAndReturnToLobby);
    if (playButton) playButton.addEventListener('click', () => { if (selectedCardsForPlay.length===0){alert('请选择要出的牌');return;} console.log("[CLIENT] Playing cards:", selectedCardsForPlay.map(c=>c.rank+c.suit)); socket.emit('playCard',selectedCardsForPlay,(res)=>{if(res&&res.success)selectedCardsForPlay=[];else alert(`出牌失败: ${res?res.message:'未知错误'}`);}); });
    if (passButton) passButton.addEventListener('click', () => { console.log("[CLIENT] Passing turn."); socket.emit('passTurn', (res) => { if (res && !res.success) alert(`操作失败: ${res.message}`); }); });
    if (hintButton) hintButton.addEventListener('click', () => { console.log("[CLIENT] Requesting hint."); socket.emit('requestHint', currentHintIndexFromServer, (res) => { if (res.success && res.hint && res.hint.cards) { currentHint = res.hint.cards; currentHintIndexFromServer = res.nextHintIndex || 0; highlightHintedCards(currentHint); } else { alert(res.message || '没有可用的提示。'); currentHint = null; currentHintIndexFromServer = 0; highlightHintedCards([]); } }); });
    function cardObjectToKey(card) { return `${card.rank}${card.suit}`; }
    function highlightHintedCards(hintedCardsArray) { if (!playerHandArea) return; playerHandArea.querySelectorAll('.my-card.hinted').forEach(c => c.classList.remove('hinted')); if (hintedCardsArray && hintedCardsArray.length > 0) { const hintedKeys = new Set(hintedCardsArray.map(cardObjectToKey)); playerHandArea.querySelectorAll('.my-card').forEach(cardEl => { if (hintedKeys.has(`${cardEl.dataset.rank}${cardEl.dataset.suit}`)) cardEl.classList.add('hinted'); }); } }


    // Display Game State (核心UI更新逻辑)
    function displayGameState(state, animateHandOnDisplay = false) {
        if (!state) { console.warn("[DISPLAY] displayGameState called with null state."); if(myUserId)switchToView('lobby-view');else switchToView('auth-view'); return; }
        currentRoomState = state; 
        const myPlayer = state.players ? state.players.find(p => p.userId === myUserId) : null;

        if (infoBarRoomName) infoBarRoomName.textContent = state.roomName || '未知';
        if (infoBarRoomId) infoBarRoomId.textContent = state.roomId || '----';
        if (infoBarRoomStatus) infoBarRoomStatus.textContent = state.status === 'waiting' ? '等待中' : (state.status === 'playing' ? '游戏中' : (state.gameFinished ? '已结束' : state.status));
        if (infoBarCurrentTurn) { const cP = state.players.find(p => p.userId === state.currentPlayerId); infoBarCurrentTurn.textContent = cP ? cP.username : (state.gameFinished ? '游戏结束' : 'N/A'); }

        if (myInfoInBar && myPlayer) { /* ... (my-info-in-bar 更新，保持不变) ... */ }
        else if (myInfoInBar) { /* ... (myPlayer 未找到时的处理，保持不变) ... */ }

        const opponentSlotMap = {};
        if (myPlayer && state.players && state.players.length > 0) { /* ... (对手位置映射，保持不变) ... */ }
        else if (state.players) { /* ... (无myPlayer时的对手映射，保持不变) ... */ }
        ['top', 'left', 'right'].forEach(pK => updateOpponentUIElement(document.getElementById(`player-${pK}`), opponentSlotMap[pK], state.currentPlayerId, state.gameFinished, state.status));

        // 更新AI按钮状态 (基于服务器返回的isAiControlled，如果服务器实现了这个字段)
        if (myPlayer && aiToggleButton) {
            // 假设服务器通过 gameState.players[...].isAiControlled 同步AI状态
            // 如果没有这个字段，isAi托管激活将只在本地切换，并通过'toggleAI'事件通知服务器
            isAi托管激活 = !!myPlayer.isAiControlled; // 从服务器同步AI状态
            aiToggleButton.classList.toggle('ai-active', isAi托管激活);
            aiToggleButton.textContent = isAi托管激活 ? "取消AI" : "AI托管";
        }


        if (myPlayer) {
            updatePlayerHandUI(myPlayer.hand || [], state.status === 'playing' && state.currentPlayerId === myPlayer.userId && myPlayer.connected && !myPlayer.finished && !isAi托管激活, animateHandOnDisplay);
            const isWaiting = state.status === 'waiting';
            const isPlaying = state.status === 'playing';
            const canPlayerActManually = isPlaying && myPlayer.connected && !myPlayer.finished && !isAi托管激活;

            if(readyButton) { readyButton.style.display = isWaiting && !state.gameFinished ? 'inline-block' : 'none'; readyButton.disabled = state.gameFinished || isAi托管激活; readyButton.textContent = myPlayer.isReady ? "取消" : "准备"; readyButton.classList.toggle('cancel-ready', myPlayer.isReady); }
            
            const showGameplayButtons = isPlaying && myPlayer.connected && !myPlayer.finished;
            [hintButton, passButton, playButton, micButton, aiToggleButton].forEach(btn => { 
                if(btn) btn.style.display = showGameplayButtons || (btn === readyButton && isWaiting) ? 'inline-block' : 'none'; 
            });
            
            if (playButton) playButton.disabled = !(canPlayerActManually && state.currentPlayerId === myPlayer.userId);
            if (passButton) passButton.disabled = !(canPlayerActManually && state.currentPlayerId === myPlayer.userId && !state.isFirstTurn && state.lastHandInfo && (!state.lastPlayerWhoPlayedId || state.lastPlayerWhoPlayedId !== myUserId));
            if (hintButton) hintButton.disabled = !(canPlayerActManually && state.currentPlayerId === myPlayer.userId);
            if (micButton) micButton.disabled = state.gameFinished || !myPlayer.connected;
            if (aiToggleButton) aiToggleButton.disabled = state.gameFinished || !myPlayer.connected || state.status !== 'playing'; // AI托管只在游戏中可用

        } else { 
            updatePlayerHandUI([], false, false); 
            [readyButton, hintButton, passButton, playButton, micButton, aiToggleButton].forEach(btn => { if(btn) {btn.style.display = 'none'; btn.disabled = true;} }); 
        }

        updateCenterPileUI(state.centerPile, state.lastHandInfo);
        if (gameOverOverlay) { /* ... (游戏结束浮层，保持不变) ... */ }
    }

    // UI更新辅助函数 (大部分保持不变)
    // ... (省略 updateOpponentUIElement, updatePlayerReadyStatusUI, updatePlayerHandUI, toggleCardSelection, updateCenterPileUI, createCardElement) ...
    // (确保 createCardElement 使用之前定义的映射表)
    function updateOpponentUIElement(areaEl, pData, cTurnPId, isGFinished, rStatus) { if (!areaEl) return; const nE=areaEl.querySelector('.playerName'), rE=areaEl.querySelector('.playerRole'), cE=areaEl.querySelector('.playerInfo .card-count'), readyE=areaEl.querySelector('.player-ready-status'); if (pData) { areaEl.dataset.playerId = pData.userId; if(nE)nE.textContent=pData.username; if(rE)rE.textContent=pData.role?`(${pData.role})`:''; if(cE)cE.textContent=pData.handCount!==undefined?pData.handCount:'?'; if(readyE){readyE.textContent=pData.isReady?"✓ 已准备":"✗ 未准备"; readyE.className=`player-ready-status ${pData.isReady?'ready':'not-ready'}`; readyE.style.display=rStatus==='waiting'&&!isGFinished?'inline-block':'none';}  areaEl.classList.toggle('current-turn', rStatus==='playing' && cTurnPId===pData.userId && !isGFinished); areaEl.classList.toggle('player-finished',!!pData.finished); areaEl.classList.toggle('player-disconnected',!pData.connected); areaEl.style.opacity=pData.connected?'1':'0.5'; } else { if(nE)nE.textContent='等待玩家...';if(rE)rE.textContent='';if(cE)cE.textContent='?';if(readyE)readyE.style.display='none'; areaEl.classList.remove('current-turn','player-finished','player-disconnected'); areaEl.removeAttribute('data-player-id');areaEl.style.opacity='0.7'; } }
    function updatePlayerReadyStatusUI(pUserId, isReady) { let tA; if (pUserId === myUserId) tA = document.getElementById('my-info-in-bar'); else tA = document.querySelector(`.opponent-area[data-player-id="${pUserId}"]`);  if (tA) { const rSE = tA.querySelector('.player-ready-status'); if (rSE) { rSE.textContent = isReady ? "✓ 已准备" : "✗ 未准备"; rSE.className = `player-ready-status ${isReady ? 'ready' : 'not-ready'}`; if (currentRoomState) { rSE.style.display = currentRoomState.status === 'waiting' && !currentRoomState.gameFinished ? 'inline-block' : 'none'; } else {  rSE.style.display = 'none';  } } } else { console.warn(`[UI] updatePlayerReadyStatusUI: Target area for player ${pUserId} not found.`); } }
    function updatePlayerHandUI(hCards, isMTurn, anim=false) { if(!playerHandArea)return; playerHandArea.innerHTML=''; if(!hCards||hCards.length===0)return; hCards.forEach((cD,idx)=>{ const cDiv=createCardElement(cD); cDiv.classList.add('my-card'); if(anim){cDiv.classList.add('card-in-hand');void cDiv.offsetWidth;setTimeout(()=>cDiv.classList.add('dealt'),idx*70+50);} else cDiv.classList.add('card-in-hand','dealt'); if(selectedCardsForPlay.some(sC=>cardObjectToKey(sC)===cardObjectToKey(cD)))cDiv.classList.add('selected'); playerHandArea.appendChild(cDiv); if(isMTurn){ cDiv.classList.add('selectable'); cDiv.addEventListener('click',()=>{ toggleCardSelection(cDiv,cD); if(currentHint){currentHint=null;currentHintIndexFromServer=0;highlightHintedCards([]);} }); } }); if(currentHint && currentHint.length > 0) highlightHintedCards(currentHint); }
    function toggleCardSelection(cDiv,cD){const cK=cardObjectToKey(cD);const idx=selectedCardsForPlay.findIndex(c=>cardObjectToKey(c)===cK);if(idx>-1){selectedCardsForPlay.splice(idx,1);cDiv.classList.remove('selected');}else{selectedCardsForPlay.push(cD);cDiv.classList.add('selected');}console.log("[CLIENT] Selected cards:",selectedCardsForPlay.map(c=>c.rank+c.suit));}
    function updateCenterPileUI(cPileCards,lHInfo) {  if(!discardedCardsArea)return; const lHTDisp=document.getElementById('lastHandType'); discardedCardsArea.innerHTML=''; let csToDisp=[]; let hTMsg="等待出牌"; if(lHInfo&&lHInfo.cards&&lHInfo.cards.length>0){csToDisp=lHInfo.cards;hTMsg=`类型: ${lHInfo.type||'未知'}`;}else if(cPileCards&&cPileCards.length>0&&(!lHInfo||(lHInfo.cards&&lHInfo.cards.length===0))){csToDisp=cPileCards;hTMsg="当前出牌";}if(lHTDisp)lHTDisp.textContent=hTMsg;if(csToDisp.length>0)csToDisp.forEach(cD=>{const cDiv=createCardElement(cD);cDiv.classList.add('center-pile-card');discardedCardsArea.appendChild(cDiv);});}
    function createCardElement(cardData) { const cardDiv = document.createElement('div'); cardDiv.className = 'card'; cardDiv.dataset.rank = cardData.rank; cardDiv.dataset.suit = cardData.suit; const rankPart = rankToImageNamePart[cardData.rank]; const suitPart = suitToImageNamePart[cardData.suit]; let imageName; if (rankPart && suitPart) { imageName = `${rankPart}_of_${suitPart}${CARD_IMAGE_EXTENSION}`; } else { console.warn(`[GFX] Failed to map card data: suit=${cardData.suit}, rank=${cardData.rank}. Using back.`); imageName = CARD_BACK_IMAGE;  cardDiv.textContent = `${cardData.suit}${cardData.rank}`;  } const imagePath = `/images/cards/${imageName}`; try { cardDiv.style.backgroundImage = `url('${imagePath}')`; } catch (e) { console.error(`[GFX] Error setting image for ${imagePath}:`, e); cardDiv.textContent = `${cardData.suit}${cardData.rank}`; } return cardDiv; }


    // Voice Functionality (保持不变)
    // ... (省略) ...
    if(micButton){micButton.addEventListener('mousedown',handleVoicePress);micButton.addEventListener('mouseup',handleVoiceRelease);micButton.addEventListener('mouseleave',handleVoiceRelease);micButton.addEventListener('touchstart',handleVoicePress,{passive:false});micButton.addEventListener('touchend',handleVoiceRelease);micButton.addEventListener('touchcancel',handleVoiceRelease);}
    async function handleVoicePress(evt){ evt.preventDefault(); if(isRecording || !currentRoomId || (currentRoomState && currentRoomState.gameFinished)) return; console.log('[VOICE] Mic pressed'); if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){alert("浏览器不支持麦克风访问(getUserMedia不可用)。请更新浏览器或使用HTTPS/localhost。");return;} isRecording=true;audioChunks=[]; if(micButton)micButton.classList.add('recording'); if(socket&&socket.connected)socket.emit('playerStartSpeaking'); try{ const strm=await navigator.mediaDevices.getUserMedia({audio:true}); const mTs=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4']; let selMT=''; for(const mT of mTs){if(MediaRecorder.isTypeSupported(mT)){selMT=mT;break;}} console.log("[VOICE] Using MIME:",selMT||'default'); mediaRecorder=selMT?new MediaRecorder(strm,{mimeType:selMT}):new MediaRecorder(strm); mediaRecorder.ondataavailable=e=>{if(e.data.size>0)audioChunks.push(e.data);}; mediaRecorder.onstop=()=>{ console.log('[VOICE] Recorder stopped'); if(audioChunks.length > 0 && currentRoomId && socket && socket.connected){ const bMT=selMT||(audioChunks[0]&&audioChunks[0].type)||'application/octet-stream'; const aB=new Blob(audioChunks,{type:bMT}); console.log(`[VOICE] Sending blob type ${aB.type}, size ${aB.size}`); socket.emit('sendVoiceMessage',{roomId:currentRoomId,audioBlob:aB}); } else console.log("[VOICE] No chunks/room/socket to send voice"); audioChunks=[]; if(strm)strm.getTracks().forEach(t=>t.stop()); }; mediaRecorder.start(); console.log('[VOICE] Recorder started'); }catch(err){ console.error('[VOICE] Mic err:',err); alert(`麦克风错误: ${err.name} - ${err.message}\n请检查权限和HTTPS。`); isRecording=false; if(micButton)micButton.classList.remove('recording'); if(socket&&socket.connected)socket.emit('playerStopSpeaking'); if(mediaRecorder&&mediaRecorder.stream)mediaRecorder.stream.getTracks().forEach(t=>t.stop()); else if(err.stream)err.stream.getTracks().forEach(t=>t.stop()); } }
    function handleVoiceRelease(evt){evt.preventDefault();if(!isRecording)return;console.log('[VOICE] Mic released');isRecording=false;if(micButton)micButton.classList.remove('recording');if(socket&&socket.connected)socket.emit('playerStopSpeaking');if(mediaRecorder&&mediaRecorder.state==='recording')mediaRecorder.stop();else if(mediaRecorder&&mediaRecorder.stream)mediaRecorder.stream.getTracks().forEach(t=>t.stop());}
    function findSpeakingPlayerArea(sUID){if(sUID===myUserId)return document.getElementById('my-info-in-bar');return document.querySelector(`.opponent-area[data-player-id="${sUID}"]`);}
    socket.on('playerStartedSpeaking',({userId,username})=>{console.log(`[VOICE] ${username}(${userId}) started speaking`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.add('speaking');}});
    socket.on('playerStoppedSpeaking',({userId})=>{console.log(`[VOICE] ${userId} stopped speaking`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.remove('speaking');}});
    socket.on('receiveVoiceMessage',(data)=>{if(!data||!data.audioBlob){console.error("[VOICE] Received invalid voice message data", data); return;}console.log('[VOICE] Voice from:',data.userId,"type:",data.audioBlob.type,"size:",data.audioBlob.size);const{userId,audioBlob}=data;if(!(audioBlob instanceof Blob)||audioBlob.size===0){console.error("[VOICE] Invalid blob received:",audioBlob);return;}const aUrl=URL.createObjectURL(audioBlob);const aud=new Audio(aUrl);aud.play().catch(e=>console.error('[VOICE] Playback err:',e));aud.onended=()=>URL.revokeObjectURL(aUrl);aud.onerror=(e)=>{console.error(`[VOICE] Audio err ${userId}:`,e);URL.revokeObjectURL(aUrl);};});


}); // END DOMContentLoaded
