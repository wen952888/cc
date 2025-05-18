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
    const infoBarRoomStatus = document.getElementById('infoBarRoomStatus');

    // Game Over Overlay elements
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
                    view.style.display = 'flex'; // All main views are flex now
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
        if (myUserId === data.userId && currentRoomId === data.roomState?.roomId && authView.style.display === 'none' && loadingView.style.display === 'none') {
             if (data.roomState) {
                currentRoomState = data.roomState; // Still update state if minor changes
                // displayGameState(currentRoomState); // Optionally re-render
            }
            console.log(`Auth success (state potentially consistent) for user: ${data.username} (ID: ${data.userId})`);
            // If already in game or lobby, ensure the view is correct
            if (currentRoomId && gameView.style.display === 'none') switchToView('game-view');
            else if (!currentRoomId && lobbyView.style.display === 'none') switchToView('lobby-view');
            return;
        }

        myUserId = data.userId; myUsername = data.username;
        localStorage.setItem('userId', data.userId);
        if(lobbyUsernameSpan) lobbyUsernameSpan.textContent = myUsername;
        clearAuthError(); console.log(`Auth success for user: ${myUsername} (ID: ${myUserId})`);

        if (data.roomState && data.roomState.roomId) {
            currentRoomId = data.roomState.roomId;
            console.log(`User was in room ${currentRoomId}, displaying game state.`);
            displayGameState(data.roomState, true); switchToView('game-view');
        } else {
            if (currentRoomId) { currentRoomId = null; currentRoomState = null; }
            console.log('User not in a room, switching to lobby.');
            switchToView('lobby-view'); socket.emit('listRooms', updateRoomList);
        }
    }
    function handleAuthResponse(response) {
        if (response.success) handleAuthSuccess(response);
        else { showAuthError(response.message || "认证失败，请重试。"); localStorage.removeItem('userId');}
    }

    socket.on('connect', () => {
        console.log('Connected to server with ID:', socket.id);
        const lsUserId = localStorage.getItem('userId');
        if (!initialReauthAttempted && !myUserId && lsUserId) {
            console.log("Connect event: Re-emitting reauthenticate");
            initialReauthAttempted = true;
            socket.emit('reauthenticate', lsUserId, (response) => {
                if (response.success) handleAuthSuccess(response);
                else {
                    localStorage.removeItem('userId'); localStorage.removeItem('username');
                    if (authView.style.display === 'none' && gameView.style.display === 'none' && lobbyView.style.display === 'none') {
                        switchToView('auth-view');
                    }
                }
            });
        } else if (loadingView.style.display !== 'none' && !myUserId && !lsUserId) switchToView('auth-view');
        else if (myUserId) {
            console.log("Socket reconnected, user was logged in. Requesting sync data.");
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
         initialReauthAttempted = true; // After connect, always mark initial reauth as "done" for this connection lifecycle
    });
    socket.on('disconnect', (reason) => { console.log('Disconnected from server:', reason); alert('与服务器断开连接: ' + reason + ". 请刷新页面重试。"); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent='已断开连接...'; initialReauthAttempted = false; /* Allow reauth on next connect */ });
    socket.on('connect_error', (err) => { console.error('Connection error:', err.message); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent=`连接错误: ${err.message}.`; });

    if (createRoomButton) createRoomButton.addEventListener('click', () => { /* ... (Lobby logic - unchanged) ... */ });
    socket.on('roomListUpdate', updateRoomList);
    function updateRoomList(rooms) { /* ... (Lobby logic - unchanged) ... */ }
    if (refreshRoomListButton) refreshRoomListButton.addEventListener('click', () => socket.emit('listRooms', updateRoomList) );
    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => { /* ... (Lobby logic - set initialReauthAttempted to false) ... */ localStorage.removeItem('userId'); localStorage.removeItem('username'); myUserId = null; myUsername = null; currentRoomId = null; currentRoomState = null; if(loginForm) loginForm.reset(); if(registerForm) registerForm.reset(); switchToView('auth-view'); initialReauthAttempted = false; });

    if (readyButton) {
        readyButton.addEventListener('click', () => {
            if (!currentRoomState || !myUserId) return;
            const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
            if (!myPlayer || currentRoomState.status !== 'waiting') return; // Can only ready up in 'waiting' state
            const newReadyState = !myPlayer.isReady;
            socket.emit('playerReady', newReadyState, (response) => {
                if (!response || !response.success) alert(`设置准备状态失败: ${response ? response.message : '未知错误'}`);
            });
        });
    }

    socket.on('gameStarted', (gameState) => { console.log('Game started!', gameState); currentRoomState = gameState; displayGameState(gameState, true); switchToView('game-view'); const mp=gameState.players.find(p=>p.userId===myUserId); alert("游戏开始！"+(mp&&mp.role?`你的身份是: ${mp.role}`:'')); });
    socket.on('gameStateUpdate', (gameState) => { console.log('Game state update:', gameState); currentRoomState = gameState; displayGameState(gameState, false); });
    socket.on('playerReadyUpdate', ({ userId, isReady }) => {
        console.log(`Player ${userId} ready: ${isReady}`);
        if (currentRoomState && currentRoomState.players) {
            const player = currentRoomState.players.find(p => p.userId === userId);
            if (player) {
                player.isReady = isReady;
                updatePlayerReadyStatusUI(player.userId, isReady); // Use userId for robust update
                if (userId === myUserId && readyButton) {
                    readyButton.textContent = isReady ? "取消" : "准备"; // Shorter text
                    readyButton.classList.toggle('cancel-ready', isReady);
                }
            }
        }
    });
    socket.on('allPlayersResetReady', () => {
        console.log('All players readiness reset');
        if (currentRoomState && currentRoomState.players) {
            currentRoomState.players.forEach(p => { p.isReady = false; updatePlayerReadyStatusUI(p.userId, false); });
            if (myUserId && readyButton) { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); }
        }
    });

    socket.on('invalidPlay', (data) => alert(`无效操作: ${data.message}`) );
    socket.on('gameOver', (data) => { console.log('Game Over:', data); currentRoomState = { ...(currentRoomState || {}), ...data, gameFinished: true, gameStarted: false, currentPlayerId: null }; displayGameState(currentRoomState); });
    function handleLeaveRoomAndReturnToLobby() { /* ... (Game logic - unchanged) ... */ }
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', handleLeaveRoomAndReturnToLobby);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', handleLeaveRoomAndReturnToLobby);

    if (playButton) playButton.addEventListener('click', () => { /* ... (Game logic - unchanged) ... */ });
    if (passButton) passButton.addEventListener('click', () => { /* ... (Game logic - unchanged) ... */ });
    if (hintButton) hintButton.addEventListener('click', () => { /* ... (Game logic - unchanged) ... */ });

    function cardObjectToKey(card) { return `${card.rank}${card.suit}`; }
    function highlightHintedCards(hintedCardsArray) { /* ... (Game logic - unchanged) ... */ }

    function displayGameState(state, animateHandOnDisplay = false) {
        if (!state) { console.warn("displayGameState: null state"); if(myUserId)switchToView('lobby-view');else switchToView('auth-view'); return; }
        currentRoomState = state;
        const myPlayer = state.players ? state.players.find(p => p.userId === myUserId) : null;

        if (infoBarRoomStatus) infoBarRoomStatus.textContent = state.status === 'waiting' ? '等待中' : (state.status === 'playing' ? '游戏中' : (state.gameFinished ? '已结束' : state.status));
        const infoBarCurrent = document.getElementById('infoBarCurrentTurn');
        if(infoBarCurrent) {
            const cPlayer = state.players.find(p => p.userId === state.currentPlayerId);
            infoBarCurrent.textContent = cPlayer ? cPlayer.username : (state.gameFinished ? '游戏结束' : 'N/A');
        }


        const myInfoInBar = document.getElementById('my-info-in-bar');
        if (myInfoInBar && myPlayer) {
            myInfoInBar.dataset.playerId = myPlayer.userId;
            const myNameEl = myInfoInBar.querySelector('#myPlayerName');
            const myStatusEl = myInfoInBar.querySelector('#myPlayerStatus .card-count');
            const myReadyEl = myInfoInBar.querySelector('.player-ready-status');
            if (myNameEl) myNameEl.textContent = myPlayer.username;
            if (myStatusEl) myStatusEl.textContent = myPlayer.handCount !== undefined ? myPlayer.handCount : '?';
            if (myReadyEl) {
                myReadyEl.textContent = myPlayer.isReady ? "✓ 已准备" : "✗ 未准备";
                myReadyEl.className = `player-ready-status ${myPlayer.isReady ? 'ready' : 'not-ready'}`;
                myReadyEl.style.display = state.status === 'waiting' ? 'inline-block' : 'none';
            }
            myInfoInBar.classList.toggle('current-turn', state.currentPlayerId === myPlayer.userId && !state.gameFinished);
            myInfoInBar.classList.toggle('player-finished', !!myPlayer.finished);
            myInfoInBar.classList.toggle('player-disconnected', !myPlayer.connected);
        }

        const opponentSlotMap = {}; // { 'player-top': playerObj, ... }
        if (myPlayer && state.players.length === 4) {
            const mySlot = myPlayer.slot;
            const numPlayers = 4;
            const relativeSlots = { top: (mySlot + 2) % numPlayers, left: (mySlot + 3) % numPlayers, right: (mySlot + 1) % numPlayers };
            for (const posKey in relativeSlots) {
                opponentSlotMap[posKey] = state.players.find(p => p.slot === relativeSlots[posKey] && p.userId !== myUserId);
            }
        } else { // Fallback if not 4 players or myPlayer missing
            const otherPlayers = state.players.filter(p => p.userId !== myUserId);
            if (otherPlayers[0]) opponentSlotMap['top'] = otherPlayers[0];
            if (otherPlayers[1]) opponentSlotMap['left'] = otherPlayers[1];
            if (otherPlayers[2]) opponentSlotMap['right'] = otherPlayers[2];
        }
        ['top', 'left', 'right'].forEach(posKey => {
            const areaElement = document.getElementById(`player-${posKey}`);
            updateOpponentUIElement(areaElement, opponentSlotMap[posKey], state.currentPlayerId, state.gameFinished, state.status);
        });


        if (myPlayer) {
            updatePlayerHandUI(myPlayer.hand, state.status === 'playing' && state.currentPlayerId === myUserId && myPlayer.connected && !myPlayer.finished, animateHandOnDisplay);
            const isWaiting = state.status === 'waiting';
            const isPlaying = state.status === 'playing';
            if(readyButton) {
                readyButton.style.display = isWaiting && !state.gameFinished ? 'inline-block' : 'none';
                readyButton.disabled = state.gameFinished || (state.players.length < 2 && isWaiting); // Example: disable if not enough players
                readyButton.textContent = myPlayer.isReady ? "取消" : "准备";
                readyButton.classList.toggle('cancel-ready', myPlayer.isReady);
            }
            if (hintButton) hintButton.style.display = isPlaying ? 'inline-block' : 'none';
            if (passButton) passButton.style.display = isPlaying ? 'inline-block' : 'none';
            if (playButton) playButton.style.display = isPlaying ? 'inline-block' : 'none';

            if (playButton) playButton.disabled = !(isPlaying && state.currentPlayerId === myUserId && myPlayer.connected && !myPlayer.finished);
            if (passButton) passButton.disabled = !(isPlaying && state.currentPlayerId === myUserId && myPlayer.connected && !myPlayer.finished && !state.isFirstTurn && state.lastHandInfo && state.lastPlayerWhoPlayedId !== myUserId);
            if (hintButton) hintButton.disabled = !(isPlaying && state.currentPlayerId === myUserId && myPlayer.connected && !myPlayer.finished);
            if (micButton) micButton.disabled = state.gameFinished || !myPlayer.connected;
        } else {
            updatePlayerHandUI([], false, false);
            [readyButton, hintButton, passButton, playButton, micButton].forEach(btn => { if(btn) {btn.style.display = 'none'; btn.disabled = true;} });
        }

        updateCenterPileUI(state.centerPile, state.lastHandInfo);
        if (gameOverOverlay) { /* ... (Game Over Overlay logic - unchanged) ... */ }
    }

    function updateOpponentUIElement(areaElement, playerData, currentTurnPlayerId, isGameFinished, roomStatus) {
        if (!areaElement) return;
        const nameEl = areaElement.querySelector('.playerName');
        const roleEl = areaElement.querySelector('.playerRole');
        const countEl = areaElement.querySelector('.playerInfo .card-count');
        const readyEl = areaElement.querySelector('.player-ready-status');

        if (playerData) {
            areaElement.dataset.playerId = playerData.userId;
            if(nameEl) nameEl.textContent = playerData.username;
            if(roleEl) roleEl.textContent = playerData.role ? `(${playerData.role})` : '';
            if(countEl) countEl.textContent = playerData.handCount !== undefined ? playerData.handCount : '?';
            if(readyEl) {
                readyEl.textContent = playerData.isReady ? "✓ 已准备" : "✗ 未准备";
                readyEl.className = `player-ready-status ${playerData.isReady ? 'ready' : 'not-ready'}`;
                readyEl.style.display = roomStatus === 'waiting' ? 'inline-block' : 'none';
            }
            areaElement.classList.toggle('current-turn', currentTurnPlayerId === playerData.userId && !isGameFinished);
            areaElement.classList.toggle('player-finished', !!playerData.finished);
            areaElement.classList.toggle('player-disconnected', !playerData.connected);
            areaElement.style.opacity = playerData.connected ? '1' : '0.5';
        } else {
            if(nameEl) nameEl.textContent = '等待玩家...'; if(roleEl) roleEl.textContent = ''; if(countEl) countEl.textContent = '?';
            if(readyEl) readyEl.style.display = 'none';
            areaElement.classList.remove('current-turn', 'player-finished', 'player-disconnected');
            areaElement.removeAttribute('data-player-id'); areaElement.style.opacity = '0.7';
        }
    }

    function updatePlayerReadyStatusUI(pUserId, isReady) { // Changed param to pUserId
        let targetArea;
        if (pUserId === myUserId) {
            targetArea = document.getElementById('my-info-in-bar');
        } else {
            targetArea = document.querySelector(`.opponent-area[data-player-id="${pUserId}"]`);
        }
        if (targetArea) {
            const readyStatusElement = targetArea.querySelector('.player-ready-status');
            if (readyStatusElement) {
                readyStatusElement.textContent = isReady ? "✓ 已准备" : "✗ 未准备";
                readyStatusElement.className = `player-ready-status ${isReady ? 'ready' : 'not-ready'}`;
                readyStatusElement.style.display = currentRoomState && currentRoomState.status === 'waiting' ? 'inline-block' : 'none';
            }
        }
    }
    function updatePlayerHandUI(handCards, isMyTurn, animate = false) { /* ... (Game logic - unchanged from previous full client.js) ... */ }
    function toggleCardSelection(cardDiv, cardData) { /* ... (Game logic - unchanged) ... */ }
    function updateCenterPileUI(centerPileCards, lastHandInfoData) { /* ... (Game logic - unchanged) ... */ }
    function createCardElement(cardData) { /* ... (Game logic - unchanged) ... */ }

    // --- Voice Functionality ---
    if (micButton) { /* ... (Voice logic - unchanged from previous full client.js) ... */ }
    async function handleVoicePress(event) { /* ... (Voice logic - unchanged, with navigator.mediaDevices check) ... */ }
    function handleVoiceRelease(event) { /* ... (Voice logic - unchanged) ... */ }
    function findSpeakingPlayerArea(speakerUserId) { /* ... (Voice logic - unchanged) ... */ }
    socket.on('playerStartedSpeaking', ({ userId, username }) => { /* ... (Voice logic - unchanged) ... */ });
    socket.on('playerStoppedSpeaking', ({ userId }) => { /* ... (Voice logic - unchanged) ... */ });
    socket.on('receiveVoiceMessage', (data) => { /* ... (Voice logic - unchanged) ... */ });

}); // END DOMContentLoaded

// Ensure the placeholder functions are defined if you copy-pasted partial client.js before
// For brevity, using the ones from the last complete client.js provided.
// Make sure updatePlayerHandUI, toggleCardSelection, updateCenterPileUI, createCardElement,
// and all voice functions are present and correct.
