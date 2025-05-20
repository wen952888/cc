// client.js
document.addEventListener('DOMContentLoaded', () => {
    const CLIENT_VERSION = "1.1.0"; // 请与HTML中的版本号对应
    console.log(`[CLIENT] DOM loaded. KK Poker Client v${CLIENT_VERSION}`);

    const socket = io({
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
    });

    // --- Global State ---
    let myUserId = null;
    let myUsername = null;
    let currentRoomId = null;
    let currentRoomState = null; // Stores the latest full state from server
    let myCurrentHand = [];       // <<<< NEW: Cache for the player's own hand
    let selectedCardsForPlay = [];
    let currentHintCards = null;
    let currentHintIndexFromServer = 0;
    let initialReauthAttempted = false;
    let isAi托管激活 = false;

    // Voice recording state
    let mediaRecorder;
    let audioChunks = [];
    let isRecording = false;
    let recordingTimer = null;
    const MAX_RECORDING_TIME = 20000;
    let allowVoiceBroadcast = true;
    let currentStream = null;

    // --- DOM Elements (assuming these are correctly defined as before) ---
    const loadingView = document.getElementById('loadingView');
    const authView = document.getElementById('auth-view');
    const lobbyView = document.getElementById('lobby-view');
    const gameView = document.getElementById('game-view');
    const allViews = [loadingView, authView, lobbyView, gameView];
    const loadingMessage = document.getElementById('loadingMessage');

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

    const toggleVoiceBroadcastButton = document.getElementById('toggleVoiceBroadcastButton');

    // Card GFX (assuming these are correctly defined as before)
    const rankToImageNamePart = { 'A': 'ace', 'K': 'king', 'Q': 'queen', 'J': 'jack', 'T': '10', '9': '9', '8': '8', '7': '7', '6': '6', '5': '5', '4': '4', '3': '3', '2': '2' };
    const suitToImageNamePart = { 'S': 'spades', 'H': 'hearts', 'D': 'diamonds', 'C': 'clubs' };
    const CARD_IMAGE_EXTENSION = '.jpg';
    const CARD_BACK_IMAGE = 'back.jpg';
    const CARD_IMAGE_PATH = '/images/cards/';

    // --- Utility Functions (cardObjectToKey, showTemporaryMessage, switchToView, showAuthError, clearAuthError, handleAuthSuccess, handleAuthResponse are assumed to be the same) ---
    function cardObjectToKey(card) {
        if (!card || typeof card.rank === 'undefined' || typeof card.suit === 'undefined') return null;
        return `${card.rank}${card.suit}`;
    }

    function showTemporaryMessage(message, duration = 3000, isError = false) {
        const toast = document.createElement('div');
        toast.textContent = message;
        toast.style.cssText = `
            position:fixed; bottom:70px; left:50%; transform:translateX(-50%);
            background-color:${isError ? 'rgba(200,0,0,0.85)' : 'rgba(0,0,0,0.8)'};
            color:white; padding:10px 20px; border-radius:6px; z-index:10001;
            font-size:0.9em; box-shadow: 0 3px 15px rgba(0,0,0,0.3); text-align:center;
            max-width: 80%;
        `;
        document.body.appendChild(toast);
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration);
    }

    function switchToView(targetViewId, messageForLoading = "加载中...") {
        allViews.forEach(view => {
            if (view) {
                if (view.id === targetViewId) {
                    view.classList.remove('hidden-view');
                    view.style.display = 'flex'; // Assuming flex is the default display for views
                    if (view.id === 'game-view') view.style.flexDirection = 'column';
                } else {
                    view.classList.add('hidden-view');
                    view.style.display = 'none';
                }
            }
        });
        if (targetViewId === 'loadingView' && loadingMessage) {
            loadingMessage.textContent = messageForLoading;
        }
    }

    function showAuthError(message) { if (authErrorElement) { authErrorElement.textContent = message; authErrorElement.style.display = 'block'; } else { showTemporaryMessage(message, 3000, true); console.error("Auth Error (UI element #authError missing):", message); } }
    function clearAuthError() { if (authErrorElement) { authErrorElement.textContent = ''; authErrorElement.style.display = 'none'; } }

    function handleAuthSuccess(data) {
        console.log("[AUTH CLIENT] Success data:", data);
        if (!data || !data.userId || !data.username) {
            console.error("[AUTH CLIENT] Invalid/incomplete auth success data:", data);
            showAuthError("认证数据不完整。"); switchToView('auth-view'); return;
        }
        myUserId = data.userId;
        myUsername = data.username;
        localStorage.setItem('userId', data.userId);
        localStorage.setItem('username', data.username);
        if (lobbyUsernameSpan) lobbyUsernameSpan.textContent = myUsername;
        clearAuthError();
        console.log(`[AUTH CLIENT] Logged in: ${myUsername} (ID: ${myUserId})`);

        if (data.roomState && data.roomState.roomId) {
            currentRoomId = data.roomState.roomId;
            currentRoomState = data.roomState; // Store the full state
            // If roomState contains hand for myUserId, it will be picked up by displayGameState
            if (data.roomState.players && data.roomState.players.find(p => p.userId === myUserId && p.hand)) {
                myCurrentHand = data.roomState.players.find(p => p.userId === myUserId).hand;
            } else {
                myCurrentHand = [];
            }
            console.log(`[AUTH CLIENT] Restoring to room ${currentRoomId}.`);
            displayGameState(data.roomState, true); // Pass true for animateHand
            switchToView('game-view');
        } else {
            currentRoomId = null; currentRoomState = null; myCurrentHand = [];
            switchToView('lobby-view');
            if (socket.connected) socket.emit('listRooms', updateRoomList);
        }
    }

    function handleAuthResponse(response) {
        console.log('[AUTH CLIENT] Auth response (login/re-auth):', response);
        if (response && response.success) {
            handleAuthSuccess(response);
        } else {
            const errorMsg = response ? response.message : "认证失败，未知错误。";
            showAuthError(errorMsg);
            localStorage.removeItem('userId'); localStorage.removeItem('username');
            myUserId = null; myUsername = null; myCurrentHand = [];
            switchToView('auth-view');
        }
    }


    // --- Socket Connection Handling ---
    switchToView('loadingView', "连接服务器...");
    const storedUserIdOnLoad = localStorage.getItem('userId');
    if (!storedUserIdOnLoad) initialReauthAttempted = true; // If no stored ID, no reauth to attempt initially

    socket.on('connect', () => {
        console.log('[SOCKET CLIENT] Connected to server. Socket ID:', socket.id);
        const lsUserId = localStorage.getItem('userId');

        if (!myUserId && lsUserId && !initialReauthAttempted) {
            console.log("[SOCKET CLIENT] 'connect': Attempting initial reauthenticate.");
            initialReauthAttempted = true;
            socket.emit('reauthenticate', lsUserId, handleAuthResponse); // handleAuthResponse will call handleAuthSuccess
        } else if (myUserId && currentRoomId) {
            console.log(`[SOCKET CLIENT] 'connect': Reconnected. User ${myUsername} was in room ${currentRoomId}. Requesting game state.`);
            switchToView('loadingView', "重新连接房间...");
            socket.emit('requestGameState', (state) => {
                if (state && state.roomId === currentRoomId) {
                    console.log("[SOCKET CLIENT] Reconnected in room, received valid game state:", state);
                    currentRoomState = state; // Store new full state
                    const myPlayerDataInState = state.players.find(p => p.userId === myUserId);
                    if (myPlayerDataInState && myPlayerDataInState.hand) {
                        myCurrentHand = myPlayerDataInState.hand; // Restore hand from server
                    } // else myCurrentHand remains as it was or empty if state doesn't provide it
                    displayGameState(state, false); // No animation on simple reconnect refresh
                    switchToView('game-view');
                } else {
                    console.warn("[SOCKET CLIENT] Reconnected but failed to get valid game state for current room. Current:", currentRoomId, "Received:", state ? state.roomId : "null");
                    showTemporaryMessage("重新加入房间失败，将返回大厅。", 3000, true);
                    currentRoomId = null; currentRoomState = null; myUserId = null; myUsername = null; myCurrentHand = [];
                    localStorage.removeItem('userId'); localStorage.removeItem('username');
                    initialReauthAttempted = false; // Allow reauth attempt on next connect
                    switchToView('auth-view');
                }
            });
        } else if (myUserId && !currentRoomId) {
            console.log(`[SOCKET CLIENT] 'connect': Reconnected. User ${myUsername} was in lobby.`);
            myCurrentHand = []; // Should not have hand in lobby
            switchToView('lobby-view');
            socket.emit('listRooms', updateRoomList);
        } else { // Not logged in, or initial reauth already handled/failed
             console.log("[SOCKET CLIENT] 'connect': No active login or initial reauth handled. Ensuring auth view if not logged in.");
             if (!myUserId && (loadingView.style.display !== 'none' || gameView.style.display !== 'none' || lobbyView.style.display !== 'none')) {
                myCurrentHand = [];
                switchToView('auth-view');
             }
             initialReauthAttempted = true; // Mark as attempted if we reached here
        }
    });

    socket.on('disconnect', (reason) => {
        console.warn('[SOCKET CLIENT] Disconnected from server. Reason:', reason);
        if (isRecording) forceStopRecording();
        if (reason === 'io server disconnect') {
            showTemporaryMessage('与服务器连接已断开。请稍后重试。', 5000, true);
        } else if (reason === 'io client disconnect') { /* Deliberate disconnect, no message needed */ }
        else { showTemporaryMessage('网络连接中断，尝试重连...', 3000, true); }
        switchToView('loadingView', '连接已断开，尝试重连...');
    });

    socket.on('connect_error', (err) => {
        console.error('[SOCKET CLIENT] Connection error:', err.message, err.data || '');
        if (loadingMessage) loadingMessage.textContent = `连接错误: ${err.message}. 尝试重连...`;
    });

    // --- Auth View Listeners (assumed to be the same) ---
    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); loginForm.style.display = 'none'; registerForm.style.display = 'block'; });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); registerForm.style.display = 'none'; loginForm.style.display = 'block'; });
    if (loginButton) loginButton.addEventListener('click', () => {
        clearAuthError(); const phone = loginUsernameInput.value.trim(); const pass = loginPasswordInput.value;
        if (!phone || !pass) { showAuthError("手机号和密码均不能为空。"); return; }
        socket.emit('login', { phoneNumber: phone, password: pass }, handleAuthResponse);
    });
    if (registerButton) registerButton.addEventListener('click', () => {
        clearAuthError(); const phone = registerUsernameInput.value.trim(); const pass = registerPasswordInput.value;
        if (!phone || pass.length < 4) { showAuthError("手机号不能为空，密码至少4位。"); return; }
        socket.emit('register', { phoneNumber: phone, password: pass }, (response) => {
            showTemporaryMessage(response.message, 3000, !response.success);
            if (response.success) {
                loginForm.style.display = 'block'; registerForm.style.display = 'none';
                loginUsernameInput.value = phone; loginPasswordInput.value = ""; loginPasswordInput.focus();
            } else { showAuthError(response.message); }
        });
    });

    // --- Lobby View Listeners (assumed to be the same, but ensure myCurrentHand is cleared on logout/room change) ---
    if (createRoomButton) createRoomButton.addEventListener('click', () => {
        const roomName = roomNameInput.value.trim();
        const password = roomPasswordInput.value;
        if (!roomName) { showTemporaryMessage("请输入房间名称。", 2000, true); return; }
        if (roomName.length > 10) { showTemporaryMessage("房间名称不能超过10个字符。", 2000, true); return; }
        if (password && password.length > 10) { showTemporaryMessage("房间密码不能超过10个字符。", 2000, true); return; }
        socket.emit('createRoom', { roomName, password }, (response) => {
            if (response.success) {
                currentRoomId = response.roomId;
                currentRoomState = response.roomState; // Store full state
                const myPlayerData = response.roomState.players.find(p => p.userId === myUserId);
                myCurrentHand = (myPlayerData && myPlayerData.hand) ? myPlayerData.hand : []; // Set hand from initial state
                displayGameState(response.roomState);
                switchToView('game-view');
                roomNameInput.value = ''; roomPasswordInput.value = '';
            } else {
                showTemporaryMessage(`创建房间失败: ${response.message}`, 3000, true);
            }
        });
    });

    if (refreshRoomListButton) {
        refreshRoomListButton.addEventListener('click', () => {
            if(socket.connected) socket.emit('listRooms', updateRoomList);
            else showTemporaryMessage("网络未连接，无法刷新房间列表。", 2000, true);
        });
    }

    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => {
        if (isRecording) forceStopRecording();
        if (socket.connected) socket.disconnect(); // This will trigger 'disconnect' event handler
        localStorage.removeItem('userId'); localStorage.removeItem('username');
        myUserId = null; myUsername = null; currentRoomId = null; currentRoomState = null; myCurrentHand = [];
        initialReauthAttempted = false; // Reset for next session
        switchToView('auth-view');
        if (roomsListUl) roomsListUl.innerHTML = '<li>请先登录查看房间列表</li>';
    });

    function updateRoomList(rooms) {
        // ... (updateRoomList logic remains the same, but joining a room should set myCurrentHand) ...
        if (!roomsListUl) return;
        roomsListUl.innerHTML = '';
        if (rooms && Array.isArray(rooms) && rooms.length > 0) {
            rooms.forEach(room => {
                if (!room || typeof room.roomId === 'undefined') return;
                const li = document.createElement('li');
                const maxP = room.maxPlayers || 4;
                const countP = room.playerCount || 0;
                const statusMap = { 'waiting': '等待中', 'playing': '游戏中', 'finished': '已结束' };
                const statusTxt = statusMap[room.status] || room.status || '未知';
                let joinBtnDisabled = (room.status !== 'waiting' && !room.isPermanent) || countP >= maxP;
                if(room.isPermanent && room.status === 'finished') joinBtnDisabled = false; // Allow joining finished permanent rooms

                let btnClass = room.hasPassword ? "join-room-btn-pwd" : "join-room-btn";
                let btnText = "加入";
                if (room.hasPassword) btnText += " (有密码)";
                
                const permanentMarker = room.isPermanent ? '⭐ ' : '';
                li.innerHTML = `<span>${permanentMarker}${room.roomName || `房间 ${room.roomId}`} (${countP}/${maxP}) - ${statusTxt} ${room.hasPassword ? '' : ''}</span>
                                <button data-roomid="${room.roomId}" data-roomname="${room.roomName}" class="${btnClass}" ${joinBtnDisabled ? 'disabled' : ''}>${btnText}</button>`;
                roomsListUl.appendChild(li);
            });

            document.querySelectorAll('.join-room-btn, .join-room-btn-pwd').forEach(button => {
                if (button.disabled) return;
                button.addEventListener('click', (e) => {
                    const roomIdToJoin = e.target.dataset.roomid;
                    let passwordToJoin = null;
                    if (e.target.classList.contains('join-room-btn-pwd')) {
                        passwordToJoin = prompt(`请输入房间 "${e.target.dataset.roomname || roomIdToJoin}" 的密码:`);
                        if (passwordToJoin === null) return; // User cancelled prompt
                    }
                    socket.emit('joinRoom', { roomId: roomIdToJoin, password: passwordToJoin }, (response) => {
                        if (response && response.success) {
                            currentRoomId = response.roomId;
                            currentRoomState = response.roomState; // Store full state
                            const myPlayerData = response.roomState.players.find(p => p.userId === myUserId);
                            myCurrentHand = (myPlayerData && myPlayerData.hand) ? myPlayerData.hand : []; // Set hand from initial state
                            displayGameState(response.roomState);
                            switchToView('game-view');
                        } else {
                            showTemporaryMessage(`加入房间失败: ${response ? response.message : '未知错误'}`, 3000, true);
                        }
                    });
                });
            });
        } else {
           if (roomsListUl) roomsListUl.innerHTML = '<li>当前没有可加入的房间。</li>';
        }
    }
    socket.on('roomListUpdate', (rooms) => { if (lobbyView.style.display !== 'none') updateRoomList(rooms); });


    // --- Game View Listeners & Logic (readyButton, playButton, passButton, hintButton, aiToggleButton are assumed to be the same) ---
    // Make sure commonLeaveRoomLogic clears myCurrentHand
    const commonLeaveRoomLogic = () => {
        if (isRecording) forceStopRecording();
        socket.emit('leaveRoom', (response) => {
            if (response && response.success) {
                currentRoomId = null; currentRoomState = null; myCurrentHand = [];
                selectedCardsForPlay = []; currentHintCards = null; currentHintIndexFromServer = 0;
                isAi托管激活 = false; if(aiToggleButton) { aiToggleButton.textContent = "AI托管"; aiToggleButton.classList.remove('ai-active');}
                switchToView('lobby-view');
                if(socket.connected) socket.emit('listRooms', updateRoomList);
                if (gameOverOverlay) gameOverOverlay.classList.add('hidden-view'); // Hide game over if leaving from there
            } else {
                showTemporaryMessage(`离开房间失败: ${response ? response.message : '未知错误'}`, 2500, true);
            }
        });
    };
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', commonLeaveRoomLogic);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', commonLeaveRoomLogic);

    if (readyButton) readyButton.addEventListener('click', () => {
        if (!currentRoomState || !myUserId || currentRoomState.status !== 'waiting') {
            showTemporaryMessage("无法准备：不在等待状态或信息错误。", 2000, true); return;
        }
        const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
        if (!myPlayer) { showTemporaryMessage("错误：找不到您的玩家信息。", 2000, true); return; }
        if (myPlayer.isAiControlled) { showTemporaryMessage("AI托管中，无需操作。", 2500, true); return; }

        const newReadyState = !myPlayer.isReady;
        socket.emit('playerReady', newReadyState, (response) => {
            if (!response || !response.success) {
                showTemporaryMessage(`设置准备状态失败: ${response ? response.message : '无响应'}`, 2500, true);
            }
            // UI update will come via gameStateUpdate or playerReadyUpdate
        });
    });

    if (playButton) playButton.addEventListener('click', () => {
        if (!currentRoomState || !myUserId || currentRoomState.currentPlayerId !== myUserId || selectedCardsForPlay.length === 0) {
            showTemporaryMessage("不满足出牌条件。", 2000, true); return;
        }
        const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
        if (myPlayer && myPlayer.isAiControlled) {
            showTemporaryMessage("AI托管中，不能手动出牌。", 2000, true); return;
        }
        socket.emit('playCard', selectedCardsForPlay, (response) => {
            if (response && response.success) {
                // Hand update will come via gameStateUpdate. If server confirms play,
                // selectedCardsForPlay are effectively removed from myCurrentHand implicitly by new state.
                selectedCardsForPlay = []; // Clear local selection
                currentHintCards = null;
                currentHintIndexFromServer = 0;
            } else {
                showTemporaryMessage(`出牌失败: ${response ? response.message : '未知错误'}`, 2500, true);
            }
            updatePlayButtonState(); // Reflect clearing of selection
        });
    });

    if (passButton) passButton.addEventListener('click', () => {
        if (!currentRoomState || !myUserId || currentRoomState.currentPlayerId !== myUserId) {
             showTemporaryMessage("现在不是您的回合。", 2000, true); return;
        }
        const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
        if (myPlayer && myPlayer.isAiControlled) {
            showTemporaryMessage("AI托管中，不能手动操作。", 2000, true); return;
        }
        // Check if I am the starter of a new round (lastValidHandInfo is null OR lastPlayerWhoPlayed is me)
        // AND it's not the very first turn of the game (where D4 must be played)
        const iAmStarterOfNewRound = !currentRoomState.lastHandInfo || currentRoomState.lastPlayerWhoPlayedId === myUserId;
        if (iAmStarterOfNewRound && !currentRoomState.isFirstTurn) { // Cannot pass if starting a new round (unless it's not the very first turn)
            showTemporaryMessage("您是本轮首个出牌者，必须出牌。", 2500, true); return;
        }
        // If it IS the first turn (isFirstTurn = true), this check is skipped, allowing D4 to be mandatory.

        socket.emit('passTurn', (response) => {
            if (response && response.success) {
                selectedCardsForPlay = []; currentHintCards = null; currentHintIndexFromServer = 0;
            } else {
                showTemporaryMessage(`操作“过”失败: ${response ? response.message : '未知错误'}`, 2500, true);
            }
            updatePlayButtonState();
        });
    });
    
    if (hintButton) hintButton.addEventListener('click', () => {
        if (!currentRoomState || !myUserId || currentRoomState.currentPlayerId !== myUserId) {
             showTemporaryMessage("现在不是您的回合。", 2000, true); return;
        }
        const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
        if (myPlayer && myPlayer.isAiControlled) {
            showTemporaryMessage("AI托管中。", 2000, true); return;
        }
        socket.emit('requestHint', currentHintIndexFromServer, (response) => {
            if (response && response.success && response.hint) {
                clearSelectionAndHighlights(false); // Clear previous, but don't clear selectedCardsForPlay yet
                selectedCardsForPlay = response.hint.map(cardKey => ({ rank: cardKey.rank, suit: cardKey.suit }));
                currentHintCards = [...selectedCardsForPlay]; // Store hint cards
                highlightHintedCardsUI(currentHintCards, true); // Highlight and select them
                currentHintIndexFromServer = response.nextHintIndex;
            } else {
                showTemporaryMessage(response.message || "没有可用的提示。", 2000, !response.success);
                clearSelectionAndHighlights(true); // Clear everything
                currentHintIndexFromServer = 0;
            }
            updatePlayButtonState();
        });
    });

    if (aiToggleButton) aiToggleButton.addEventListener('click', () => {
        if (!currentRoomState || !myUserId) { showTemporaryMessage("无法切换AI：无房间或用户信息。", 2000, true); return; }
        const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
        if (!myPlayer) { showTemporaryMessage("错误：找不到您的玩家信息。", 2000, true); return; }

        const newAiState = !myPlayer.isAiControlled; // Target AI state
        socket.emit('toggleAI', newAiState, (response) => {
            if (response && response.success) {
                // Server will send gameStateUpdate which updates isAi托管激活
                showTemporaryMessage(response.isAiEnabled ? "AI托管已激活。" : "AI托管已取消。", 2000);
            } else {
                showTemporaryMessage(`AI切换失败: ${response ? response.message : '未知错误'}`, 2500, true);
            }
        });
    });


    // --- Socket Event Handlers for Game Updates ---
    socket.on('gameStateUpdate', (state) => {
        if (state && state.roomId === currentRoomId) {
            console.log('[CLIENT] Received gameStateUpdate:', state);
            currentRoomState = state; // Crucial: update the master state object
            displayGameState(state);
        } else if (state && state.roomId && !currentRoomId) { // Joined a room via reauth or other means
             currentRoomId = state.roomId; currentRoomState = state;
             const myPlayerData = state.players.find(p => p.userId === myUserId);
             myCurrentHand = (myPlayerData && myPlayerData.hand) ? myPlayerData.hand : [];
             displayGameState(state); 
             switchToView('game-view');
        } else if (state && state.roomId !== currentRoomId) {
            // console.warn(`[EVENT CLIENT] Received gameStateUpdate for a different room (${state.roomId}) than current (${currentRoomId}). Ignoring.`);
        }
    });

    socket.on('gameStarted', (initialGameState) => {
        if (initialGameState && initialGameState.roomId === currentRoomId) {
            console.log('[CLIENT] Received gameStarted event.');
            myCurrentHand = []; // Clear cached hand for a new game
            currentRoomState = initialGameState; // Update master state
            selectedCardsForPlay = []; currentHintCards = null; currentHintIndexFromServer = 0;
            displayGameState(initialGameState, true); // Animate hand on game start
            if (gameOverOverlay) gameOverOverlay.classList.add('hidden-view');
        }
    });
    
    socket.on('roomResetForNewGame', ({ roomId }) => {
        if (currentRoomId === roomId) {
            console.log(`[CLIENT] Permanent room ${roomId} has been reset for a new game.`);
            myCurrentHand = []; // Clear hand, new cards will come with gameStateUpdate or gameStarted
            if (gameOverOverlay) {
                gameOverOverlay.classList.add('hidden-view');
                gameOverOverlay.style.display = 'none';
            }
            selectedCardsForPlay = [];
            currentHintCards = null;
            currentHintIndexFromServer = 0;
            // A gameStateUpdate usually follows this to refresh the UI to 'waiting' state.
        }
    });


    socket.on('playerJoined', (playerInfo) => { showTemporaryMessage(`玩家 ${playerInfo.username} 加入了房间。`, 2000); });
    socket.on('playerLeft', ({ userId, username }) => { showTemporaryMessage(`玩家 ${username} 离开了房间。`, 2000); });

    socket.on('playerReadyUpdate', ({ userId, isReady }) => {
        if (currentRoomState && currentRoomState.players) {
            const player = currentRoomState.players.find(p => p.userId === userId);
            if (player) player.isReady = isReady; // Update local cache of state
            updatePlayerReadyStatusUI(userId, isReady); // Direct UI update for responsiveness
            if (userId === myUserId && readyButton) {
                readyButton.textContent = isReady ? "取消准备" : "准备";
                readyButton.classList.toggle('cancel-ready', isReady);
            }
        }
    });

    socket.on('gameStartFailed', ({ message }) => {
        showTemporaryMessage(`游戏开始失败: ${message}`, 3000, true);
        if (readyButton) { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); }
    });

    socket.on('invalidPlay', ({ message }) => { showTemporaryMessage(`无效操作: ${message}`, 2500, true); });

    socket.on('gameOver', ({ reason, scoreResult }) => {
        myCurrentHand = []; // Clear hand on game over
        if (currentRoomState) { 
            currentRoomState.status = 'finished';
            currentRoomState.gameFinished = true;
            if (scoreResult) {
                currentRoomState.finalScores = scoreResult.finalScores;
                currentRoomState.scoreChanges = scoreResult.scoreChanges;
                if (currentRoomState.players && scoreResult.finalScores) { // Ensure players array exists
                    currentRoomState.players.forEach(p => {
                        const finalScoreInfo = scoreResult.finalScores.find(fs => fs.id === p.userId);
                        if (finalScoreInfo) p.score = finalScoreInfo.score;
                    });
                }
            }
        }

        gameOverTitle.textContent = reason || "游戏结束";
        gameOverReasonText.textContent = `当局结果: ${reason}`;
        gameOverScoresDiv.innerHTML = '';
        if (scoreResult && scoreResult.finalScores) {
            scoreResult.finalScores.forEach(ps => {
                const change = scoreResult.scoreChanges ? (scoreResult.scoreChanges[ps.id] || 0) : 0;
                const changeStr = change > 0 ? `+${change}` : (change < 0 ? `${change}` : '0');
                const scoreClass = change > 0 ? 'score-plus' : (change < 0 ? 'score-minus' : 'score-zero');
                gameOverScoresDiv.innerHTML += `<p>${ps.name} (${ps.role || '玩家'}): <span class="${scoreClass}">${changeStr}</span> (总分: ${ps.score})</p>`;
            });
        }
        switchToView('game-view'); 
        gameOverOverlay.classList.remove('hidden-view');
        gameOverOverlay.style.display = 'flex';

        if (readyButton) { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); }
        selectedCardsForPlay = []; currentHintCards = null; currentHintIndexFromServer = 0; updatePlayButtonState();
    });

    // --- UI Update Functions ---
    function displayGameState(state, animateNewHandDeal = false) {
        const oldPlayerHandCount = myCurrentHand.length;
        currentRoomState = state; // Always update the master state object

        if (infoBarRoomName) infoBarRoomName.textContent = state.roomName || '未知房间';
        if (infoBarRoomId) infoBarRoomId.textContent = state.roomId || '----';
        const statusMap = { 'waiting': '等待中', 'playing': '游戏中', 'finished': '已结束' };
        if (infoBarRoomStatus) infoBarRoomStatus.textContent = statusMap[state.status] || state.status || '未知';

        const currentPlayer = state.players.find(p => p.userId === state.currentPlayerId);
        if (infoBarCurrentTurn) infoBarCurrentTurn.textContent = state.gameStarted && !state.gameFinished && currentPlayer ? currentPlayer.username : (state.gameFinished ? '游戏结束' : 'N/A');

        const myPlayerFromServer = state.players.find(p => p.userId === myUserId);
        isAi托管激活 = myPlayerFromServer ? myPlayerFromServer.isAiControlled : false;
        if (aiToggleButton) {
            aiToggleButton.textContent = isAi托管激活 ? "取消托管" : "AI托管";
            aiToggleButton.classList.toggle('ai-active', isAi托管激活);
        }

        if (myPlayerFromServer) {
            updateMyPlayerArea(myPlayerFromServer, state.currentPlayerId === myUserId, state.gameFinished, state.status);

            // --- MODIFIED HAND UPDATE LOGIC ---
            let handToDisplay = myCurrentHand; // Default to cached hand
            let animateThisUpdate = false;

            if (myPlayerFromServer.hand && Array.isArray(myPlayerFromServer.hand)) {
                // Server explicitly sent a hand for me. This is the new source of truth.
                myCurrentHand = [...myPlayerFromServer.hand]; // Update cache, ensure it's a new array
                handToDisplay = myCurrentHand;
                animateThisUpdate = animateNewHandDeal || (myCurrentHand.length > 0 && oldPlayerHandCount === 0 && state.gameStarted && !state.gameFinished);
            } else if (state.gameStarted && !state.gameFinished && myPlayerFromServer && !myPlayerFromServer.finished) {
                // Server did NOT send a hand, but game is ongoing and I haven't finished. Use cached hand.
                // animateThisUpdate remains false unless explicitly passed as true for other reasons.
                animateThisUpdate = animateNewHandDeal; // Only animate if specifically requested (e.g. initial auth restore)
            } else {
                // Game not started, or finished, or I finished. Clear my hand.
                myCurrentHand = [];
                handToDisplay = myCurrentHand;
                if(playerHandArea) playerHandArea.innerHTML = ''; // Clear display immediately
            }
            
            if (handToDisplay.length > 0 || (state.status === 'playing' && myPlayerFromServer && !myPlayerFromServer.finished) ) {
                 updatePlayerHandUI(handToDisplay, state.currentPlayerId === myUserId && !state.gameFinished && !myPlayerFromServer.finished && !isAi托管激活, animateThisUpdate);
            } else if (playerHandArea) {
                playerHandArea.innerHTML = ''; // Ensure cleared if no hand to display
            }
            // --- END MODIFIED HAND UPDATE LOGIC ---

        } else { // I am not in the list of players from the server
            myCurrentHand = [];
            if(playerHandArea) playerHandArea.innerHTML = '';
        }

        // --- Opponent UI Update ---
        const opponentPlayerElements = {
            top: document.getElementById('player-top'),
            left: document.getElementById('player-left'),
            right: document.getElementById('player-right')
        };
        // Clear all opponent areas first to handle players leaving or changing slots
        Object.values(opponentPlayerElements).forEach(el => {
            if (el) updateOpponentUIElement(el, null, state.currentPlayerId, state.gameFinished, state.status);
        });

        if (myPlayerFromServer && state.players.length > 1) {
            const opponents = state.players.filter(p => p.userId !== myUserId);
            const mySlot = myPlayerFromServer.slot;
            // Determine maxPlayers for slot calculation: if game started, use actual players, else use room's max (default 4)
            const numPlayersForLayout = state.gameStarted ? state.players.length : (state.maxPlayers || 4);


            opponents.forEach(op => {
                // Calculate relative slot based on a fixed number of positions (e.g., 4 for KK)
                // This ensures opponents appear in consistent visual locations.
                const relativeSlot = (op.slot - mySlot + numPlayersForLayout) % numPlayersForLayout;
                let targetElementKey = null;

                if (numPlayersForLayout === 4) {
                    if (relativeSlot === 1) targetElementKey = 'left';      // Player to my left
                    else if (relativeSlot === 2) targetElementKey = 'top';   // Player opposite me
                    else if (relativeSlot === 3) targetElementKey = 'right'; // Player to my right
                } else if (numPlayersForLayout === 3) { // Example for 3 players
                    if (relativeSlot === 1) targetElementKey = 'left';   // Or 'top-left'
                    else if (relativeSlot === 2) targetElementKey = 'right';  // Or 'top-right'
                } else if (numPlayersForLayout === 2) { // Example for 2 players
                    if (relativeSlot === 1) targetElementKey = 'top';
                }
                
                if (targetElementKey && opponentPlayerElements[targetElementKey]) {
                    updateOpponentUIElement(opponentPlayerElements[targetElementKey], op, state.currentPlayerId, state.gameFinished, state.status);
                }
            });
        }
        // --- End Opponent UI Update ---

        updateCenterPileUI(state.centerPile, state.lastHandInfo);
        updateGameActionButtons(state);

        if (state.gameFinished && gameOverOverlay.classList.contains('hidden-view')) {
            // Game over logic moved to 'gameOver' event handler to ensure myCurrentHand is cleared there.
        } else if (!state.gameFinished && !gameOverOverlay.classList.contains('hidden-view')) {
            gameOverOverlay.classList.add('hidden-view');
            gameOverOverlay.style.display = 'none';
        }
    }

    function updateMyPlayerArea(playerData, isMyTurn, isGameFinished, roomStatus) {
        if (!myInfoInBar) return;
        const nameEl = myInfoInBar.querySelector('.playerName');
        const cardCountEl = myInfoInBar.querySelector('.card-count');
        const readyStatusEl = myInfoInBar.querySelector('.player-ready-status');

        if (nameEl) nameEl.textContent = playerData.username || "我";
        if (cardCountEl) cardCountEl.textContent = playerData.handCount;

        myInfoInBar.classList.toggle('current-turn', isMyTurn && !isGameFinished && roomStatus === 'playing' && !playerData.isAiControlled);
        myInfoInBar.classList.toggle('player-disconnected', !playerData.connected && !playerData.isAiControlled);
        myInfoInBar.classList.toggle('player-finished', playerData.finished);

        if (readyStatusEl) {
            if (roomStatus === 'waiting') {
                readyStatusEl.textContent = playerData.isReady ? "已准备" : (playerData.isAiControlled ? "AI托管" : "未准备");
                readyStatusEl.className = 'player-ready-status ' + (playerData.isReady ? 'ready' : (playerData.isAiControlled ? 'ai-ready' : 'not-ready')); // Add class for AI ready if needed
                readyStatusEl.style.display = 'inline';
            } else {
                readyStatusEl.style.display = 'none';
            }
        }
    }

    function updatePlayerHandUI(handCardsToDisplay, isMyTurnAndCanAct, animate = false) {
        if (!playerHandArea) return;
        playerHandArea.innerHTML = ''; // Clear previous cards

        // Filter selectedCardsForPlay to ensure they are still in the hand to display
        // This is important if handCardsToDisplay is from cache and server play reduced it.
        // However, with the new logic, handCardsToDisplay should be the definitive source from cache.
        // If a card was played, myCurrentHand should have been updated by a server state.
        selectedCardsForPlay = selectedCardsForPlay.filter(sc =>
            handCardsToDisplay.some(hc => cardObjectToKey(hc) === cardObjectToKey(sc))
        );

        if (!Array.isArray(handCardsToDisplay)) {
            console.warn("[CLIENT UI] updatePlayerHandUI called with non-array hand:", handCardsToDisplay);
            return;
        }
        
        if (handCardsToDisplay.length === 0 && currentRoomState && currentRoomState.status === 'playing') {
            const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
            if (myPlayer && !myPlayer.finished) { // If game is playing, I'm not finished, but hand is empty (e.g. after playing last card but before game over state)
                 playerHandArea.innerHTML = '<p style="font-size:0.8em; color:#aaa;">等待结算...</p>';
            }
            return;
        }


        handCardsToDisplay.forEach((card, index) => {
            const cardDiv = document.createElement('div');
            cardDiv.classList.add('card', 'my-card');
            if (animate) cardDiv.classList.add('card-in-hand');

            const rankName = rankToImageNamePart[card.rank];
            const suitName = suitToImageNamePart[card.suit];
            if (rankName && suitName) {
                cardDiv.style.backgroundImage = `url('${CARD_IMAGE_PATH}${rankName}_of_${suitName}${CARD_IMAGE_EXTENSION}')`;
            } else { // Fallback for unknown cards
                cardDiv.style.backgroundImage = `url('${CARD_IMAGE_PATH}${CARD_BACK_IMAGE}')`;
                cardDiv.textContent = `${card.rank || '?'}${card.suit || '?'}`;
            }
            cardDiv.dataset.rank = card.rank;
            cardDiv.dataset.suit = card.suit;
            cardDiv.dataset.key = cardObjectToKey(card);

            if (isMyTurnAndCanAct) {
                cardDiv.classList.add('selectable');
                cardDiv.addEventListener('click', () => toggleCardSelection(cardDiv, card));
            }

            if (selectedCardsForPlay.some(sc => cardObjectToKey(sc) === cardObjectToKey(card))) {
                cardDiv.classList.add('selected');
            }
            if (currentHintCards && currentHintCards.some(hc => cardObjectToKey(hc) === cardObjectToKey(card))) {
                cardDiv.classList.add('hinted');
            }

            playerHandArea.appendChild(cardDiv);
            if (animate) {
                setTimeout(() => cardDiv.classList.add('dealt'), index * 50 + 50);
            }
        });
        updatePlayButtonState(); // Update based on new hand and selection
    }

    function toggleCardSelection(cardDiv, cardData) {
        if (!currentRoomState) return;
        const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
        if (myPlayer && myPlayer.isAiControlled) return;

        const cardKey = cardObjectToKey(cardData);
        const index = selectedCardsForPlay.findIndex(c => cardObjectToKey(c) === cardKey);

        if (index > -1) {
            selectedCardsForPlay.splice(index, 1);
            cardDiv.classList.remove('selected');
        } else {
            selectedCardsForPlay.push(cardData);
            cardDiv.classList.add('selected');
        }
        // If a card is selected/deselected that was part of a hint, invalidate the current hint.
        if (currentHintCards && !currentHintCards.every(hc => selectedCardsForPlay.some(sc => cardObjectToKey(sc) === cardObjectToKey(hc))) ) {
            document.querySelectorAll('#player-hand-area .card.hinted').forEach(c => c.classList.remove('hinted'));
            currentHintCards = null;
            currentHintIndexFromServer = 0; // Reset hint cycle
        }
        updatePlayButtonState();
    }
    
    function updatePlayButtonState() {
        // ... (same as before, but now relies on myCurrentHand.length for some checks indirectly via currentRoomState.players[myIndex].handCount)
        if (!currentRoomState || !myUserId) {
             if(playButton) playButton.disabled = true;
             if(passButton) passButton.disabled = true;
             if(hintButton) hintButton.disabled = true;
             return;
        }
        const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
        const amAICcontrolled = myPlayer && myPlayer.isAiControlled;

        if (playButton) {
            const canPlay = currentRoomState.gameStarted &&
                            !currentRoomState.gameFinished &&
                            myPlayer &&
                            !myPlayer.finished &&
                            currentRoomState.currentPlayerId === myUserId &&
                            selectedCardsForPlay.length > 0 &&
                            !amAICcontrolled;
            playButton.disabled = !canPlay;
        }

        if(passButton) {
            const canPass = currentRoomState.gameStarted &&
                            !currentRoomState.gameFinished &&
                            myPlayer &&
                            !myPlayer.finished &&
                            currentRoomState.currentPlayerId === myUserId &&
                            (!!currentRoomState.lastHandInfo && currentRoomState.lastPlayerWhoPlayedId !== myUserId) && // Can pass if there's a last hand and it wasn't mine
                            !amAICcontrolled;
            passButton.disabled = !canPass;
        }
        if(hintButton) {
             const canHint = currentRoomState.gameStarted &&
                            !currentRoomState.gameFinished &&
                            myPlayer &&
                            !myPlayer.finished &&
                            currentRoomState.currentPlayerId === myUserId &&
                            myCurrentHand.length > 0 && // Added check for having cards
                            !amAICcontrolled;
            hintButton.disabled = !canHint;
        }
    }

    function clearSelectionAndHighlights(clearSelectedToo = true) {
        if (clearSelectedToo) {
            selectedCardsForPlay = [];
            document.querySelectorAll('#player-hand-area .card.selected').forEach(c => c.classList.remove('selected'));
        }
        currentHintCards = null; // Always clear hint cards
        document.querySelectorAll('#player-hand-area .card.hinted').forEach(c => c.classList.remove('hinted'));
        updatePlayButtonState();
    }
    
    function highlightHintedCardsUI(hintedCardsArray, alsoSelectThem = false) {
        // Clear previous hints
        document.querySelectorAll('#player-hand-area .card.hinted').forEach(c => c.classList.remove('hinted'));
        if (alsoSelectThem) { // If also selecting, clear previous selections first
             document.querySelectorAll('#player-hand-area .card.selected').forEach(c => c.classList.remove('selected'));
             selectedCardsForPlay = []; // Clear the array
        }

        currentHintCards = hintedCardsArray.map(c => ({rank: c.rank, suit: c.suit})); // Store a copy

        hintedCardsArray.forEach(hintCard => {
            const cardKey = cardObjectToKey(hintCard);
            const cardDiv = playerHandArea.querySelector(`.card[data-key="${cardKey}"]`);
            if (cardDiv) {
                cardDiv.classList.add('hinted');
                if (alsoSelectThem) {
                    cardDiv.classList.add('selected');
                    // Add to selectedCardsForPlay if not already (should be empty if alsoSelectThem is true due to clearing above)
                    if (!selectedCardsForPlay.find(sc => cardObjectToKey(sc) === cardKey)) {
                        selectedCardsForPlay.push({rank: hintCard.rank, suit: hintCard.suit});
                    }
                }
            }
        });
        updatePlayButtonState();
    }


    function updateOpponentUIElement(areaElement, playerData, currentTurnPlayerId, isGameFinished, roomStatus) {
        if (!areaElement) return;
        const nameEl = areaElement.querySelector('.playerName');
        const cardCountEl = areaElement.querySelector('.card-count');
        const roleEl = areaElement.querySelector('.playerRole');
        const readyStatusEl = areaElement.querySelector('.player-ready-status');

        if (playerData) {
            areaElement.style.visibility = 'visible';
            if (nameEl) nameEl.textContent = playerData.username + (playerData.isAiControlled ? " (AI)" : "");
            if (cardCountEl) cardCountEl.textContent = playerData.handCount;

            if (roleEl && roomStatus === 'playing' && playerData.role) {
                roleEl.textContent = playerData.role;
                roleEl.style.display = 'block';
            } else if (roleEl) {
                roleEl.style.display = 'none';
            }

            if (readyStatusEl) {
                if (roomStatus === 'waiting') {
                    readyStatusEl.textContent = playerData.isReady ? "已准备" : (playerData.isAiControlled ? "AI托管" : "未准备");
                    readyStatusEl.className = 'player-ready-status ' + (playerData.isReady ? 'ready' : (playerData.isAiControlled ? 'ai-ready' : 'not-ready'));
                    readyStatusEl.style.display = 'inline';
                } else {
                    readyStatusEl.style.display = 'none';
                }
            }
            areaElement.classList.toggle('current-turn', playerData.userId === currentTurnPlayerId && !isGameFinished && roomStatus === 'playing' && !playerData.isAiControlled);
            areaElement.classList.toggle('player-disconnected', !playerData.connected && !playerData.isAiControlled);
            areaElement.classList.toggle('player-finished', playerData.finished);
            areaElement.dataset.playerId = playerData.userId; // Ensure this is set for voice indicators
        } else {
            areaElement.style.visibility = 'hidden';
            if (nameEl) nameEl.textContent = '等待玩家...';
            if (cardCountEl) cardCountEl.textContent = '?';
            if (roleEl) roleEl.style.display = 'none';
            if (readyStatusEl) readyStatusEl.style.display = 'none';
            areaElement.classList.remove('current-turn', 'player-disconnected', 'player-finished');
            areaElement.dataset.playerId = "";
        }
    }

    function updatePlayerReadyStatusUI(pUserId, isReady) {
        let playerArea = null;
        if (currentRoomState && myUserId === pUserId) playerArea = myInfoInBar;
        else playerArea = document.querySelector(`.player-area[data-player-id="${pUserId}"]`);

        if (playerArea) {
            const readyStatusEl = playerArea.querySelector('.player-ready-status');
            if (readyStatusEl && currentRoomState) { // Added currentRoomState check
                const player = currentRoomState.players.find(pl => pl.userId === pUserId);
                if (currentRoomState.status === 'waiting') {
                    readyStatusEl.textContent = isReady ? "已准备" : (player && player.isAiControlled ? "AI托管" : "未准备");
                    readyStatusEl.className = 'player-ready-status ' + (isReady ? 'ready' : (player && player.isAiControlled ? 'ai-ready' : 'not-ready'));
                    readyStatusEl.style.display = 'inline';
                } else {
                     readyStatusEl.style.display = 'none';
                }
            }
        }
        // If this update is for the current client, also update the main ready button
        if (myUserId === pUserId && readyButton && currentRoomState && currentRoomState.status === 'waiting') {
             readyButton.textContent = isReady ? "取消准备" : "准备";
             readyButton.classList.toggle('cancel-ready', isReady);
        }
    }

    function updateCenterPileUI(pileCards, lastHandInfoData) {
        if (!discardedCardsArea || !lastHandTypeDisplay) return;
        discardedCardsArea.innerHTML = '';
        if (pileCards && pileCards.length > 0) {
            pileCards.forEach(card => {
                const cardDiv = document.createElement('div');
                cardDiv.classList.add('card', 'center-pile-card');
                const rankName = rankToImageNamePart[card.rank];
                const suitName = suitToImageNamePart[card.suit];
                if (rankName && suitName) {
                     cardDiv.style.backgroundImage = `url('${CARD_IMAGE_PATH}${rankName}_of_${suitName}${CARD_IMAGE_EXTENSION}')`;
                } else {
                    cardDiv.style.backgroundImage = `url('${CARD_IMAGE_PATH}${CARD_BACK_IMAGE}')`;
                    cardDiv.textContent = `${card.rank || '?'}${card.suit || '?'}`;
                }
                discardedCardsArea.appendChild(cardDiv);
            });
            lastHandTypeDisplay.textContent = lastHandInfoData ? `类型: ${lastHandInfoData.type}` : '等待出牌';
        } else {
            lastHandTypeDisplay.textContent = '等待出牌';
        }
    }

    function updateGameActionButtons(state) {
        if (!state || !myUserId) return;
        const myPlayer = state.players.find(p => p.userId === myUserId);
        const isMyTurn = state.gameStarted && !state.gameFinished && myPlayer && !myPlayer.finished && state.currentPlayerId === myUserId;
        const amAICcontrolledByServer = myPlayer && myPlayer.isAiControlled;

        if (readyButton) {
            readyButton.disabled = state.status !== 'waiting' || amAICcontrolledByServer;
            if (myPlayer && state.status === 'waiting') {
                readyButton.textContent = myPlayer.isReady ? "取消准备" : "准备";
                readyButton.classList.toggle('cancel-ready', myPlayer.isReady);
            } else if (state.status !== 'waiting') { // Game started or finished
                 readyButton.textContent = "准备";
                 readyButton.classList.remove('cancel-ready');
            }
        }
        if (playButton) playButton.disabled = !isMyTurn || selectedCardsForPlay.length === 0 || amAICcontrolledByServer;
        if (passButton) {
             const canPass = isMyTurn && 
                            (!!state.lastHandInfo && state.lastPlayerWhoPlayedId !== myUserId) && // Can pass if there's a last hand and it wasn't mine
                            !amAICcontrolledByServer;
             passButton.disabled = !canPass;
        }
        if (hintButton) hintButton.disabled = !isMyTurn || myCurrentHand.length === 0 || amAICcontrolledByServer;
        if (aiToggleButton) aiToggleButton.disabled = state.status === 'finished' || (myPlayer && !myPlayer.connected && !amAICcontrolledByServer);

        if (micButton) micButton.disabled = !currentRoomId || !myUserId;
    }

    // --- Voice Functionality (assumed to be the same: startRecording, forceStopRecording, micButton listener, toggleVoice listener, socket voice event handlers) ---
    async function startRecording() {
        if (isRecording || !currentRoomId || !myUserId) return;
        console.log('[VOICE CLIENT] Attempting to start recording...');
        try {
            currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(currentStream);
            audioChunks = [];

            mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };

            mediaRecorder.onstop = () => {
                console.log('[VOICE CLIENT] MediaRecorder.onstop triggered.');
                if (currentStream) { currentStream.getTracks().forEach(track => track.stop()); currentStream = null; }
                if (audioChunks.length > 0) {
                    const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
                    console.log(`[VOICE CLIENT] Sending voice data. Size: ${audioBlob.size}, Type: ${audioBlob.type}`);
                    if (audioBlob.size > 100) socket.emit('sendVoiceMessage', { roomId: currentRoomId, audioBlob });
                    else console.log('[VOICE CLIENT] Audio data too small or empty, not sending.');
                } else console.log('[VOICE CLIENT] No audio chunks to send.');
                audioChunks = []; isRecording = false;
                if (micButton) { micButton.classList.remove('recording'); micButton.textContent = "🎤"; }
            };
            mediaRecorder.start(); isRecording = true;
            if (micButton) { micButton.classList.add('recording'); micButton.textContent = "停止"; }
            socket.emit('playerStartedSpeaking', { userId: myUserId, roomId: currentRoomId });

            clearTimeout(recordingTimer);
            recordingTimer = setTimeout(() => {
                if (isRecording && mediaRecorder && mediaRecorder.state === "recording") {
                    console.log('[VOICE CLIENT] Max recording time reached. Stopping automatically.');
                    mediaRecorder.stop(); 
                    socket.emit('playerStoppedSpeaking', { userId: myUserId, roomId: currentRoomId });
                }
            }, MAX_RECORDING_TIME);
            console.log('[VOICE CLIENT] Recording started.');

        } catch (err) {
            console.error('[VOICE CLIENT] Error accessing microphone or starting recording:', err);
            showTemporaryMessage("无法访问麦克风或开始录音。", 2000, true);
            isRecording = false; if (micButton) { micButton.classList.remove('recording'); micButton.textContent = "🎤"; }
            if (currentStream) { currentStream.getTracks().forEach(track => track.stop()); currentStream = null; }
        }
    }

    function forceStopRecording() {
        console.log('[VOICE CLIENT] Forcing stop recording.');
        clearTimeout(recordingTimer);
        if (mediaRecorder && mediaRecorder.state === "recording") { mediaRecorder.onstop = null; mediaRecorder.stop(); }
        if (currentStream) { currentStream.getTracks().forEach(track => track.stop()); currentStream = null; }
        isRecording = false; audioChunks = [];
        if (micButton) { micButton.classList.remove('recording'); micButton.textContent = "🎤"; }
        if (currentRoomId && myUserId) socket.emit('playerStoppedSpeaking', { userId: myUserId, roomId: currentRoomId });
        mediaRecorder = null;
    }

    if (micButton) {
        micButton.addEventListener('click', () => {
            if (!currentRoomId || !myUserId) { showTemporaryMessage("请先加入房间。", 2000, true); return; }
            if (isRecording) {
                clearTimeout(recordingTimer); 
                if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop(); 
                else forceStopRecording(); 
                socket.emit('playerStoppedSpeaking', { userId: myUserId, roomId: currentRoomId });
            } else startRecording();
        });
    }

    if (toggleVoiceBroadcastButton) {
        toggleVoiceBroadcastButton.addEventListener('click', () => {
            allowVoiceBroadcast = !allowVoiceBroadcast;
            if (allowVoiceBroadcast) { toggleVoiceBroadcastButton.textContent = "🔊 开"; toggleVoiceBroadcastButton.classList.remove('voice-off'); showTemporaryMessage("语音接收已开启", 1500); }
            else { toggleVoiceBroadcastButton.textContent = "🔇 关"; toggleVoiceBroadcastButton.classList.add('voice-off'); showTemporaryMessage("语音接收已关闭", 1500); }
        });
    }
    
    function findSpeakingPlayerArea(speakingUserId) {
        if (speakingUserId === myUserId && myInfoInBar) return myInfoInBar.querySelector('.player-avatar-container');
        // Ensure opponent areas have data-player-id set correctly
        return document.querySelector(`.player-area[data-player-id="${speakingUserId}"] .player-avatar-container`);
    }

    socket.on('playerStartedSpeaking', ({ userId, username }) => {
        if (!allowVoiceBroadcast && userId !== myUserId) return;
        const speakerArea = findSpeakingPlayerArea(userId);
        if (speakerArea) { const indicator = speakerArea.querySelector('.voice-indicator'); if (indicator) indicator.classList.add('speaking'); }
    });
    socket.on('playerStoppedSpeaking', ({ userId, username }) => {
        const speakerArea = findSpeakingPlayerArea(userId);
        if (speakerArea) { const indicator = speakerArea.querySelector('.voice-indicator'); if (indicator) indicator.classList.remove('speaking'); }
    });

    socket.on('receiveVoiceMessage', ({ userId, username, audioBlob }) => {
        if (userId === myUserId || !allowVoiceBroadcast) return;
        console.log(`[VOICE CLIENT] Received voice from ${username}. Size: ${audioBlob.size}. Allowed: ${allowVoiceBroadcast}`);
        try {
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.play().catch(e => console.error('[VOICE CLIENT] Error playing received audio:', e));
            audio.onended = () => URL.revokeObjectURL(audioUrl);
            audio.onerror = (e) => { console.error(`[VOICE CLIENT] Error event on audio element for ${username}:`, e); URL.revokeObjectURL(audioUrl); };
        } catch (e) { console.error('[VOICE CLIENT] Error processing received audioBlob:', e); }
    });

}); // END DOMContentLoaded
