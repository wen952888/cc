// client.js
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed. Client v1.0.27');
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
    let amIReady = false; // Track my ready state locally

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
    const createRoomButton = document.getElementById('createRoomButton');
    const roomsListUl = document.getElementById('rooms');
    const lobbyUsernameSpan = document.getElementById('lobbyUsername');
    const refreshRoomListButton = document.getElementById('refreshRoomListButton');
    const logoutButtonLobby = document.getElementById('logoutButtonLobby');
    const roomPasswordInput = document.getElementById('roomPasswordInput');

    // Game elements
    const playerHandArea = document.getElementById('player-hand-area');
    const discardedCardsArea = document.getElementById('discarded-cards-area');
    const playButton = document.getElementById('play-button');
    const passButton = document.getElementById('pass-button');
    const hintButton = document.getElementById('hint-button');
    const micButton = document.getElementById('micButton');
    const leaveRoomButton = document.getElementById('leaveRoomButton');
    const readyButton = document.getElementById('ready-button'); // New ready button

    const gameOverOverlay = document.getElementById('gameOverOverlay');
    const gameOverTitle = document.getElementById('gameOverTitle');
    const gameOverReasonText = document.getElementById('gameOverReasonText');
    const gameOverScoresDiv = document.getElementById('gameOverScores');
    const backToLobbyBtnOverlay = gameOverOverlay.querySelector('#backToLobbyBtn');

    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;

    function switchToView(targetViewId) {
        console.log(`Switching to view: ${targetViewId}`);
        allViews.forEach(view => {
            if (view) {
                if (view.id === targetViewId) {
                    view.classList.remove('hidden-view');
                    view.style.display = (view.id === 'game-view' || view.id === 'loadingView' || view.id === 'auth-view' || view.id === 'lobby-view') ? 'flex' : 'block';
                    if (view.id === 'game-view') view.style.flexDirection = 'column';
                } else {
                    view.classList.add('hidden-view');
                    view.style.display = 'none';
                }
            }
        });
    }
    switchToView('loadingView');

    const storedUserId = localStorage.getItem('userId');
    if (storedUserId) {
        initialReauthAttempted = true;
        console.log(`Initial: Found stored user ID: ${storedUserId}, attempting reauthentication.`);
        socket.emit('reauthenticate', storedUserId, (response) => {
            console.log('Initial Reauthenticate response:', response);
            if (response.success) handleAuthSuccess(response);
            else {
                showAuthError(response.message);
                localStorage.removeItem('userId'); localStorage.removeItem('username');
                switchToView('auth-view');
            }
        });
    } else {
        initialReauthAttempted = true;
        console.log('Initial: No stored user ID found.');
        switchToView('auth-view');
    }

    function showAuthError(message) {
        if (authErrorElement) { authErrorElement.textContent = message; authErrorElement.style.display = 'block'; }
        else alert(message);
    }
    function clearAuthError() { if (authErrorElement) { authErrorElement.textContent = ''; authErrorElement.style.display = 'none'; } }

    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (loginForm) loginForm.style.display = 'none'; if (registerForm) registerForm.style.display = 'block'; });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (registerForm) registerForm.style.display = 'none'; if (loginForm) loginForm.style.display = 'block'; });
    if (loginButton) loginButton.addEventListener('click', () => {
        clearAuthError(); const phoneNumber = loginUsernameInput.value; const password = loginPasswordInput.value;
        if (!phoneNumber || !password) { showAuthError("手机号和密码不能为空。"); return; }
        socket.emit('login', { phoneNumber, password }, handleAuthResponse);
    });
    if (registerButton) registerButton.addEventListener('click', () => {
        clearAuthError(); const phoneNumber = registerUsernameInput.value; const password = registerPasswordInput.value;
        if (!phoneNumber || password.length < 4) { showAuthError("手机号不能为空，密码至少4位。"); return; }
        socket.emit('register', { phoneNumber, password }, (response) => {
            alert(response.message);
            if (response.success) {
                if (loginForm) loginForm.style.display = 'block'; if (registerForm) registerForm.style.display = 'none';
                loginUsernameInput.value = phoneNumber; loginPasswordInput.value = ""; loginPasswordInput.focus();
            } else showAuthError(response.message);
        });
    });

    function handleAuthSuccess(data) {
        if (myUserId === data.userId && currentRoomId === data.roomState?.roomId && lobbyView.style.display === 'none' && authView.style.display === 'none') {
            if (data.roomState) currentRoomState = data.roomState;
            console.log(`Auth success (already authenticated or state consistent) for user: ${data.username} (ID: ${data.userId})`);
            if(currentRoomState) displayGameState(currentRoomState); // Re-render in case small details changed
            return;
        }
        myUserId = data.userId; myUsername = data.username; localStorage.setItem('userId', data.userId);
        console.log(`Auth success for user: ${myUsername} (ID: ${myUserId})`);
        if(lobbyUsernameSpan) lobbyUsernameSpan.textContent = myUsername; clearAuthError();
        if (data.roomState && data.roomState.roomId) {
            currentRoomId = data.roomState.roomId;
            displayGameState(data.roomState, true); switchToView('game-view');
        } else {
            if (currentRoomId) { currentRoomId = null; currentRoomState = null; }
            switchToView('lobby-view'); socket.emit('listRooms', updateRoomList);
        }
    }
    function handleAuthResponse(response) {
        if (response.success) handleAuthSuccess(response);
        else showAuthError(response.message || "认证失败，请重试。");
    }

    socket.on('connect', () => {
        console.log('Connected to server with ID:', socket.id);
        const lsUserId = localStorage.getItem('userId');
        if (!initialReauthAttempted && !myUserId && lsUserId) {
            initialReauthAttempted = true;
            socket.emit('reauthenticate', lsUserId, (response) => {
                if (response.success) handleAuthSuccess(response);
                else {
                    localStorage.removeItem('userId'); localStorage.removeItem('username');
                    if (authView.style.display === 'none' && gameView.style.display === 'none' && lobbyView.style.display === 'none') switchToView('auth-view');
                }
            });
        } else if (loadingView.style.display !== 'none' && !myUserId && !lsUserId) switchToView('auth-view');
        else if (myUserId) {
            if (currentRoomId) {
                socket.emit('requestGameState', (state) => {
                    if (state) { currentRoomState = state; displayGameState(state); }
                    else { currentRoomId = null; currentRoomState = null; switchToView('lobby-view'); socket.emit('listRooms', updateRoomList); }
                });
            } else {
                socket.emit('listRooms', updateRoomList);
                if (authView.style.display !== 'none' || loadingView.style.display !== 'none') switchToView('lobby-view');
            }
        }
    });
    socket.on('disconnect', (reason) => { console.log('Disconnected:', reason); alert('与服务器断开: ' + reason); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent='已断开';});
    socket.on('connect_error', (err) => { console.error('Connection error:', err.message); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent=`连接错误: ${err.message}`; });
    if (createRoomButton) createRoomButton.addEventListener('click', () => { /* ... (保持不变) ... */ });
    socket.on('roomListUpdate', updateRoomList);
    function updateRoomList(rooms) { /* ... (保持不变, 但可以考虑在房间信息中显示准备人数) ... */ }
    if (refreshRoomListButton) refreshRoomListButton.addEventListener('click', () => socket.emit('listRooms', updateRoomList));
    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => { /* ... initialReauthAttempted = false; ... */ });

    socket.on('gameStarted', (gameState) => {
        console.log('Game started event received!', gameState);
        amIReady = false; // Reset ready state on game start
        currentRoomState = gameState;
        displayGameState(gameState, true);
        switchToView('game-view');
        const myPlayer = gameState.players.find(p => p.userId === myUserId);
        alert("游戏开始！" + (myPlayer && myPlayer.role ? `你的身份是: ${myPlayer.role}` : ''));
    });
    socket.on('gameStateUpdate', (gameState) => { /* ... (保持不变) ... */ });
    socket.on('allPlayersResetReady', () => { // Server might send this if game start failed
        console.log("All players readiness reset by server.");
        amIReady = false;
        if (currentRoomState && currentRoomState.players) {
            currentRoomState.players.forEach(p => p.isReady = false);
            displayGameState(currentRoomState);
        }
    });


    socket.on('playerReadyUpdate', ({ userId, isReady }) => {
        console.log(`Player ${userId} ready status: ${isReady}`);
        if (currentRoomState && currentRoomState.players) {
            const player = currentRoomState.players.find(p => p.userId === userId);
            if (player) player.isReady = isReady;
            if (userId === myUserId) amIReady = isReady; // Update local tracked ready state
            displayGameState(currentRoomState);
        }
    });

    socket.on('invalidPlay', (data) => alert(`无效操作: ${data.message}`));
    socket.on('gameOver', (data) => {
        console.log('Game Over:', data);
        amIReady = false; // Reset ready state on game over, for next game
        currentRoomState = { ...(currentRoomState || {}), ...data, gameFinished: true, gameStarted: false, currentPlayerId: null };
        displayGameState(currentRoomState);
    });

    function handleLeaveRoomAndReturnToLobby() { /* ... amIReady = false; ... */ }
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', handleLeaveRoomAndReturnToLobby);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', handleLeaveRoomAndReturnToLobby);

    if (readyButton) readyButton.addEventListener('click', () => {
        if (!currentRoomId) {
            alert("请先加入一个房间。");
            return;
        }
        if (currentRoomState && (currentRoomState.status === 'playing' || currentRoomState.status === 'finished')) {
            // If game is over and we want "ready for next game"
            if (currentRoomState.status === 'finished') {
                 socket.emit('playerReady', !amIReady, (response) => { // Toggle ready for next game
                    if (!response.success) alert("操作失败: " + response.message);
                    // amIReady will be updated via 'playerReadyUpdate'
                });
            } else {
                alert("游戏已开始，无法更改准备状态。");
            }
            return;
        }

        // Default behavior: toggle ready state for waiting room
        socket.emit('playerReady', !amIReady, (response) => {
            if (response.success) {
                // amIReady = !amIReady; // State will be updated by server via 'playerReadyUpdate'
                // updateReadyButtonVisuals(); // Update button immediately or wait for server event
            } else {
                alert("操作失败: " + response.message);
            }
        });
    });


    if (playButton) playButton.addEventListener('click', () => { /* ... (保持不变) ... */ });
    if (passButton) passButton.addEventListener('click', () => { /* ... (保持不变) ... */ });
    if (hintButton) hintButton.addEventListener('click', () => { /* ... (保持不变) ... */ });

    function cardObjectToKey(card) { return `${card.rank}${card.suit}`; }
    function highlightHintedCards(hintedCardsArray) { /* ... (保持不变) ... */ }

    function displayGameState(state, animateHandOnDisplay = false) {
        if (!state) { /* ... (保持不变) ... */ }
        currentRoomState = state;
        const myPlayer = state.players ? state.players.find(p => p.userId === myUserId) : null;

        const infoBarRoomName = document.getElementById('infoBarRoomName');
        const infoBarRoomId = document.getElementById('infoBarRoomId');
        const infoBarRoomStatus = document.getElementById('infoBarRoomStatus'); // New
        const infoBarCurrentTurn = document.getElementById('infoBarCurrentTurn');
        if (infoBarRoomName) infoBarRoomName.textContent = state.roomName || '未知';
        if (infoBarRoomId) infoBarRoomId.textContent = state.roomId || '----';
        if (infoBarRoomStatus) infoBarRoomStatus.textContent = state.status === 'waiting' ? '等待中' : (state.status === 'playing' ? '游戏中' : '已结束'); // New
        let currentTurnPlayerName = "N/A";
        if (state.currentPlayerId && !state.gameFinished) { /* ... (保持不变) ... */ }
        if (infoBarCurrentTurn) infoBarCurrentTurn.textContent = currentTurnPlayerName;

        // Update My Info (including ready status)
        const myInfoInBar = document.getElementById('my-info-in-bar');
        if (myInfoInBar && myPlayer) {
            myInfoInBar.dataset.playerId = myPlayer.userId;
            const myNameEl = myInfoInBar.querySelector('#myPlayerName');
            const myStatusEl = myInfoInBar.querySelector('#myPlayerStatus .card-count');
            const myReadyStatusEl = myInfoInBar.querySelector('#myPlayerStatus .player-ready-status'); // New
            if (myNameEl) myNameEl.textContent = myPlayer.username;
            if (myStatusEl) myStatusEl.textContent = myPlayer.handCount !== undefined ? myPlayer.handCount : '?';
            if (myReadyStatusEl) { // New
                myReadyStatusEl.textContent = myPlayer.isReady ? "(已准备)" : "(未准备)";
                myReadyStatusEl.className = myPlayer.isReady ? 'player-ready-status ready' : 'player-ready-status';
            }
            myInfoInBar.classList.toggle('current-turn', state.currentPlayerId === myPlayer.userId && !state.gameFinished);
            myInfoInBar.classList.toggle('player-finished', !!myPlayer.finished);
            myInfoInBar.classList.toggle('player-disconnected', !myPlayer.connected);
        }

        // Update Opponents UI (including ready status)
        if (myPlayer && state.players && state.players.length === 4) { /* ... */ }
        else { /* ... */ }
        const opponentAreas = [document.getElementById('player-top'), document.getElementById('player-left'), document.getElementById('player-right')];
        const otherPlayers = state.players ? state.players.filter(p => p.userId !== myUserId) : [];

        // Simplified assignment for now, refine with slot logic later if needed
        opponentAreas.forEach((area, index) => {
            if (area) {
                updateOpponentUIElement(area, otherPlayers[index], state.currentPlayerId, state.gameFinished);
            }
        });


        // Update button states based on game status
        if (readyButton) {
            if (state.status === 'waiting') {
                readyButton.disabled = false;
                readyButton.textContent = amIReady ? "取消准备" : "准备";
                readyButton.classList.toggle('is-ready', amIReady);
            } else if (state.status === 'finished') {
                // For "ready for next game" logic if implemented
                // readyButton.disabled = false;
                // readyButton.textContent = amIReady ? "取消下局" : "准备下局";
                // readyButton.classList.toggle('is-ready', amIReady);
                 readyButton.disabled = true; // Temporarily disable after game over, until explicit "new game" flow
                 readyButton.textContent = "准备";
                 readyButton.classList.remove('is-ready');
            } else { // Playing
                readyButton.disabled = true;
                readyButton.textContent = "准备";
                readyButton.classList.remove('is-ready');
            }
        }

        if (myPlayer) {
            const canPlay = state.currentPlayerId === myUserId && !state.gameFinished && myPlayer.connected && !myPlayer.finished;
            if (playButton) playButton.style.display = (state.status === 'playing' && canPlay) ? 'inline-block' : 'none';
            if (passButton) passButton.style.display = (state.status === 'playing' && canPlay && !state.isFirstTurn && state.lastHandInfo && state.lastPlayerWhoPlayedId !== myUserId) ? 'inline-block' : 'none';
            if (hintButton) hintButton.style.display = (state.status === 'playing' && canPlay) ? 'inline-block' : 'none';
            if (micButton) micButton.disabled = state.gameFinished || !myPlayer.connected;
            updatePlayerHandUI(myPlayer.hand, canPlay, animateHandOnDisplay);
        } else {
            updatePlayerHandUI([], false, false);
            if (playButton) playButton.style.display = 'none';
            if (passButton) passButton.style.display = 'none';
            if (hintButton) hintButton.style.display = 'none';
            if (micButton) micButton.disabled = true;
        }
        if(playButton && state.status !== 'playing') playButton.style.display = 'none';
        if(passButton && state.status !== 'playing') passButton.style.display = 'none';
        if(hintButton && state.status !== 'playing') hintButton.style.display = 'none';


        updateCenterPileUI(state.centerPile, state.lastHandInfo);

        if (state.gameFinished) { /* ... (Game Over Overlay logic - 保持不变) ... */ }
        else { /* ... */ }
    }

    function updateOpponentUIElement(areaElement, playerData, currentTurnPlayerId, isGameFinished) {
        if (!areaElement) return;
        const nameElement = areaElement.querySelector('.playerName');
        const roleElement = areaElement.querySelector('.playerRole');
        const countElement = areaElement.querySelector('.playerInfo .card-count');
        const readyStatusEl = areaElement.querySelector('.playerInfo .player-ready-status'); // New

        if (playerData) {
            areaElement.dataset.playerId = playerData.userId;
            if (nameElement) nameElement.textContent = playerData.username;
            if (roleElement) roleElement.textContent = playerData.role ? `(${playerData.role})` : '';
            if (countElement) countElement.textContent = playerData.handCount !== undefined ? playerData.handCount : '?';
            if (readyStatusEl) { // New
                readyStatusEl.textContent = playerData.isReady ? "(已准备)" : "(未准备)";
                readyStatusEl.className = playerData.isReady ? 'player-ready-status ready' : 'player-ready-status';
            }
            areaElement.classList.toggle('current-turn', currentTurnPlayerId === playerData.userId && !isGameFinished);
            areaElement.classList.toggle('player-finished', !!playerData.finished);
            areaElement.classList.toggle('player-disconnected', !playerData.connected);
            areaElement.style.opacity = playerData.connected ? '1' : '0.5';
        } else { /* ... (保持不变) ... */ }
    }

    function updatePlayerHandUI(handCards, isMyTurn, animate = false) { /* ... (保持不变) ... */ }
    function toggleCardSelection(cardDiv, cardData) { /* ... (保持不变) ... */ }
    function updateCenterPileUI(centerPileCards, lastHandInfoData) { /* ... (保持不变) ... */ }
    function createCardElement(cardData) { /* ... (保持不变) ... */ }

    // Voice Functionality
    async function handleVoicePress(event) { /* ... (保持不变, 包含麦克风错误处理) ... */ }
    function handleVoiceRelease(event) { /* ... (保持不变) ... */ }
    function findSpeakingPlayerArea(speakerUserId) { /* ... (保持不变) ... */ }
    socket.on('playerStartedSpeaking', ({ userId, username }) => { /* ... (保持不变) ... */ });
    socket.on('playerStoppedSpeaking', ({ userId }) => { /* ... (保持不变) ... */ });
    socket.on('receiveVoiceMessage', (data) => { /* ... (保持不变) ... */ });

}); // END DOMContentLoaded
