// client.js
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed. Client v1.0.25');
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


    // Game elements (in bottom-bar or general game view)
    const playerHandArea = document.getElementById('player-hand-area');
    const discardedCardsArea = document.getElementById('discarded-cards-area');
    const playButton = document.getElementById('play-button');
    const passButton = document.getElementById('pass-button');
    const hintButton = document.getElementById('hint-button');
    const micButton = document.getElementById('micButton');
    const leaveRoomButton = document.getElementById('leaveRoomButton'); // In gameInfoBar

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
                    view.style.display = (view.id === 'game-view' || view.id === 'loadingView' || view.id === 'auth-view' || view.id === 'lobby-view') ? 'flex' : 'block';
                    if (view.id === 'game-view') view.style.flexDirection = 'column'; // game-view's own flex direction
                } else {
                    view.classList.add('hidden-view');
                    view.style.display = 'none';
                }
            }
        });
    }

    switchToView('loadingView');

    // Reauthentication logic
    const storedUserId = localStorage.getItem('userId');
    if (storedUserId) {
        console.log(`Found stored user ID: ${storedUserId}, attempting reauthentication.`);
        socket.emit('reauthenticate', storedUserId, (response) => {
            console.log('Reauthenticate response:', response);
            if (response.success) {
                handleAuthSuccess(response);
            } else {
                showAuthError(response.message);
                localStorage.removeItem('userId');
                localStorage.removeItem('username');
                switchToView('auth-view');
            }
        });
    } else {
        console.log('No stored user ID found.');
        switchToView('auth-view');
    }

    function showAuthError(message) {
        if (authErrorElement) {
            authErrorElement.textContent = message;
            authErrorElement.style.display = 'block';
        } else {
            alert(message);
        }
    }
    function clearAuthError() {
        if (authErrorElement) {
            authErrorElement.textContent = '';
            authErrorElement.style.display = 'none';
        }
    }

    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => {
        e.preventDefault();
        clearAuthError();
        if (loginForm) loginForm.style.display = 'none';
        if (registerForm) registerForm.style.display = 'block';
    });

    if (showLoginLink) showLoginLink.addEventListener('click', (e) => {
        e.preventDefault();
        clearAuthError();
        if (registerForm) registerForm.style.display = 'none';
        if (loginForm) loginForm.style.display = 'block';
    });

    if (loginButton) loginButton.addEventListener('click', () => {
        clearAuthError();
        const phoneNumber = loginUsernameInput.value;
        const password = loginPasswordInput.value;
        if (!phoneNumber || !password) {
            showAuthError("手机号和密码不能为空。");
            return;
        }
        socket.emit('login', { phoneNumber, password }, handleAuthResponse);
    });

    if (registerButton) registerButton.addEventListener('click', () => {
        clearAuthError();
        const phoneNumber = registerUsernameInput.value;
        const password = registerPasswordInput.value;
        if (!phoneNumber || password.length < 4) {
            showAuthError("手机号不能为空，密码至少4位。");
            return;
        }
        socket.emit('register', { phoneNumber, password }, (response) => {
            alert(response.message);
            if (response.success) {
                if (loginForm) loginForm.style.display = 'block';
                if (registerForm) registerForm.style.display = 'none';
                loginUsernameInput.value = phoneNumber;
                loginPasswordInput.value = "";
                loginPasswordInput.focus();
            } else {
                showAuthError(response.message);
            }
        });
    });

    function handleAuthSuccess(data) {
        myUserId = data.userId;
        myUsername = data.username;
        localStorage.setItem('userId', data.userId);
        // localStorage.setItem('username', data.username); // Optional
        console.log(`Auth success for user: ${myUsername} (ID: ${myUserId})`);
        if(lobbyUsernameSpan) lobbyUsernameSpan.textContent = myUsername;
        clearAuthError();

        if (data.roomState && data.roomState.roomId) {
            currentRoomId = data.roomState.roomId;
            console.log(`User was in room ${currentRoomId}, displaying game state.`);
            displayGameState(data.roomState, true); // Animate hand if rejoining mid-game deal
            switchToView('game-view');
        } else {
            console.log('User not in a room, switching to lobby.');
            switchToView('lobby-view');
            socket.emit('listRooms', updateRoomList);
        }
    }

    function handleAuthResponse(response) {
        console.log('Login/Auth response received:', response);
        if (response.success) {
            handleAuthSuccess(response);
        } else {
            showAuthError(response.message || "认证失败，请重试。");
            localStorage.removeItem('userId');
            // switchToView('auth-view'); // Already in auth-view
        }
    }

    socket.on('connect', () => {
        console.log('Connected to server with ID:', socket.id);
        if (loadingView.style.display !== 'none' && !myUserId && localStorage.getItem('userId')) {
            console.log("Re-emitting reauthenticate on connect if needed.");
            socket.emit('reauthenticate', localStorage.getItem('userId'), (response) => {
                if (response.success) handleAuthSuccess(response);
                else {
                    localStorage.removeItem('userId');
                    switchToView('auth-view');
                }
            });
        } else if (loadingView.style.display !== 'none' && !myUserId) {
            switchToView('auth-view');
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        alert('与服务器断开连接: ' + reason + ". 请刷新页面重试。");
        switchToView('loadingView');
        const loadingViewP = loadingView.querySelector('p');
        if (loadingViewP) loadingViewP.textContent = '已断开连接...';
        // Consider clearing state, but re-auth should handle it
        // myUserId = null; currentRoomId = null;
    });

    socket.on('connect_error', (err) => {
        console.error('Connection error:', err.message);
        switchToView('loadingView');
        const loadingViewP = loadingView.querySelector('p');
        if (loadingViewP) loadingViewP.textContent = `连接错误: ${err.message}.`;
    });

    if (createRoomButton) createRoomButton.addEventListener('click', () => {
        const roomName = roomNameInput.value.trim();
        const password = roomPasswordInput.value; // Get password
        if (!roomName) { alert('请输入房间名称'); return; }
        socket.emit('createRoom', { roomName, password: password || null }, (response) => {
            if (response.success) {
                currentRoomId = response.roomId;
                displayGameState(response.roomState);
                switchToView('game-view');
                alert(`房间 "${roomName}" 创建成功! ID: ${response.roomId}`);
            } else {
                alert(`创建房间失败: ${response.message}`);
            }
        });
    });

    socket.on('roomListUpdate', updateRoomList);

    function updateRoomList(rooms) {
        if (!roomsListUl) return;
        roomsListUl.innerHTML = '';
        if (rooms && rooms.length > 0) {
            rooms.forEach(room => {
                const li = document.createElement('li');
                let joinButtonHtml = `<button data-roomid="${room.roomId}" class="join-room-btn" ${room.status !== 'waiting' || room.playerCount >= room.maxPlayers ? 'disabled' : ''}>加入</button>`;
                if (room.hasPassword) {
                     joinButtonHtml = `<button data-roomid="${room.roomId}" data-roomname="${room.roomName}" class="join-room-btn-pwd">加入 (有密码)</button>`;
                }

                li.innerHTML = `
                    <span>${room.roomName} (${room.playerCount}/${room.maxPlayers}) - ${room.status} ${room.hasPassword ? '' : ''}</span>
                    ${joinButtonHtml}
                `;
                roomsListUl.appendChild(li);
            });
            document.querySelectorAll('.join-room-btn, .join-room-btn-pwd').forEach(button => {
                button.addEventListener('click', (e) => {
                    const roomIdToJoin = e.target.dataset.roomid;
                    let passwordToJoin = null;
                    if (e.target.classList.contains('join-room-btn-pwd')) {
                        passwordToJoin = prompt(`请输入房间 "${e.target.dataset.roomname}" 的密码:`);
                        if (passwordToJoin === null) return; // User cancelled prompt
                    }
                    socket.emit('joinRoom', { roomId: roomIdToJoin, password: passwordToJoin }, (response) => {
                        if (response.success) {
                            currentRoomId = response.roomId;
                            displayGameState(response.roomState);
                            switchToView('game-view');
                        } else {
                            alert(`加入房间失败: ${response.message}`);
                        }
                    });
                });
            });
        } else {
            roomsListUl.innerHTML = '<li>没有可用的房间</li>';
        }
    }

    if (refreshRoomListButton) refreshRoomListButton.addEventListener('click', () => {
        socket.emit('listRooms', updateRoomList);
    });
    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => {
        localStorage.removeItem('userId');
        localStorage.removeItem('username');
        myUserId = null; myUsername = null; currentRoomId = null; currentRoomState = null;
        if(loginForm) loginForm.reset();
        if(registerForm) registerForm.reset();
        switchToView('auth-view');
        // socket.disconnect(); // Optional: force disconnect
        // socket.connect(); // If needed for clean slate
    });


    socket.on('gameStarted', (gameState) => {
        console.log('Game started event received!', gameState);
        currentRoomState = gameState;
        displayGameState(gameState, true);
        switchToView('game-view');
        const myPlayer = gameState.players.find(p => p.userId === myUserId);
        alert("游戏开始！" + (myPlayer && myPlayer.role ? `你的身份是: ${myPlayer.role}` : ''));
    });

    socket.on('gameStateUpdate', (gameState) => {
        console.log('Game state update received:', gameState);
        const oldHand = currentRoomState?.players.find(p => p.userId === myUserId)?.hand;
        currentRoomState = gameState;
        const myNewHand = gameState.players.find(p => p.userId === myUserId)?.hand;
        const shouldAnimateHand = !oldHand && myNewHand && myNewHand.length > 0; // Animate only if hand was empty before
        displayGameState(gameState, shouldAnimateHand);
    });
    socket.on('playerReadyUpdate', ({ userId, isReady }) => {
        console.log(`Player ${userId} ready status: ${isReady}`);
        if (currentRoomState && currentRoomState.players) {
            const player = currentRoomState.players.find(p => p.userId === userId);
            if (player) {
                player.isReady = isReady;
                displayGameState(currentRoomState); // Re-render to show ready status, or update specific element
            }
        }
         // TODO: Update UI for ready status more efficiently if needed
    });


    socket.on('invalidPlay', (data) => {
        alert(`无效操作: ${data.message}`);
    });

    socket.on('gameOver', (data) => {
        console.log('Game Over event received:', data);
        currentRoomState = {
            ...(currentRoomState || {}),
            ...data,
            gameFinished: true,
            gameStarted: false,
            currentPlayerId: null
         };
        displayGameState(currentRoomState); // This will now handle showing the overlay
    });

    function handleLeaveRoomAndReturnToLobby() {
        socket.emit('leaveRoom', (response) => {
            console.log('Leave room response:', response);
            currentRoomId = null;
            currentRoomState = null;
            selectedCardsForPlay = [];
            currentHint = null;
            switchToView('lobby-view');
            socket.emit('listRooms', updateRoomList);
            if (gameOverOverlay) {
                 gameOverOverlay.classList.add('hidden-view');
                 gameOverOverlay.style.display = 'none';
            }
        });
    }
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', handleLeaveRoomAndReturnToLobby);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', handleLeaveRoomAndReturnToLobby);


    if (playButton) playButton.addEventListener('click', () => {
        if (selectedCardsForPlay.length === 0) { alert('请选择要出的牌'); return; }
        socket.emit('playCard', selectedCardsForPlay, (response) => {
            if (response && response.success) {
                selectedCardsForPlay = []; // Clear selection on successful play
                // Game state update will refresh hand
            } else {
                alert(`出牌失败: ${response ? response.message : '未知错误'}`);
            }
        });
    });

    if (passButton) passButton.addEventListener('click', () => {
        socket.emit('passTurn', (response) => {
            if (response && !response.success) {
                alert(`操作失败: ${response.message}`);
            }
        });
    });

    if (hintButton) hintButton.addEventListener('click', () => {
        socket.emit('requestHint', currentHintIndexFromServer, (response) => {
            if (response.success && response.hint && response.hint.cards) {
                currentHint = response.hint.cards;
                currentHintIndexFromServer = response.nextHintIndex || 0; // Use 'nextHintIndex'
                highlightHintedCards(currentHint);
            } else {
                alert(response.message || '没有可用的提示。');
                currentHint = null;
                currentHintIndexFromServer = 0;
                highlightHintedCards([]);
            }
        });
    });

    function cardObjectToKey(card) { return `${card.rank}${card.suit}`; }

    function highlightHintedCards(hintedCardsArray) {
        if (!playerHandArea) return;
        playerHandArea.querySelectorAll('.my-card.hinted').forEach(c => c.classList.remove('hinted'));
        if (hintedCardsArray && hintedCardsArray.length > 0) {
            const hintedKeys = new Set(hintedCardsArray.map(cardObjectToKey));
            playerHandArea.querySelectorAll('.my-card').forEach(cardElement => {
                const cardKey = `${cardElement.dataset.rank}${cardElement.dataset.suit}`;
                if (hintedKeys.has(cardKey)) {
                    cardElement.classList.add('hinted');
                }
            });
        }
    }

    function displayGameState(state, animateHandOnDisplay = false) {
        if (!state) {
            console.warn("displayGameState called with null state.");
            if (myUserId) switchToView('lobby-view'); else switchToView('auth-view');
            return;
        }
        currentRoomState = state;
        const myPlayer = state.players ? state.players.find(p => p.userId === myUserId) : null;

        // Update Info Bar
        const infoBarRoomName = document.getElementById('infoBarRoomName');
        const infoBarRoomId = document.getElementById('infoBarRoomId');
        const infoBarCurrentTurn = document.getElementById('infoBarCurrentTurn');
        if (infoBarRoomName) infoBarRoomName.textContent = state.roomName || '未知';
        if (infoBarRoomId) infoBarRoomId.textContent = state.roomId || '----';
        let currentTurnPlayerName = "N/A";
        if (state.currentPlayerId && !state.gameFinished) {
            const cPlayer = state.players.find(p => p.userId === state.currentPlayerId);
            if (cPlayer) currentTurnPlayerName = cPlayer.username;
        }
        if (infoBarCurrentTurn) infoBarCurrentTurn.textContent = currentTurnPlayerName;

        // Update My Info in Bottom Bar
        const myInfoInBar = document.getElementById('my-info-in-bar');
        if (myInfoInBar && myPlayer) {
            myInfoInBar.dataset.playerId = myPlayer.userId; // For speaking indicator
            const myNameEl = myInfoInBar.querySelector('#myPlayerName');
            const myStatusEl = myInfoInBar.querySelector('#myPlayerStatus .card-count');
            if (myNameEl) myNameEl.textContent = myPlayer.username;
            if (myStatusEl) myStatusEl.textContent = myPlayer.handCount !== undefined ? myPlayer.handCount : '?';
            // Add current-turn, finished, disconnected classes
            myInfoInBar.classList.toggle('current-turn', state.currentPlayerId === myPlayer.userId && !state.gameFinished);
            myInfoInBar.classList.toggle('player-finished', !!myPlayer.finished);
            myInfoInBar.classList.toggle('player-disconnected', !myPlayer.connected);
        }


        // Update Opponents UI
        const opponentAreasIds = ['player-top', 'player-left', 'player-right'];
        const otherPlayers = state.players ? state.players.filter(p => p.userId !== myUserId) : [];
        
        // Simple mapping (can be improved with slot logic if players aren't always in fixed order)
        if (myPlayer && state.players && state.players.length === 4) { // Assuming 4 players
            const mySlot = myPlayer.slot;
            const numPlayers = 4;
            const relativeSlots = {
                top: (mySlot + 2) % numPlayers,
                left: (mySlot + 3) % numPlayers, // Anti-clockwise: mySlot -> right -> top -> left
                right: (mySlot + 1) % numPlayers,
            };
            Object.entries(relativeSlots).forEach(([positionKey, targetSlot]) => {
                const opponentPlayer = state.players.find(p => p.slot === targetSlot && p.userId !== myUserId);
                const areaElement = document.getElementById(`player-${positionKey}`);
                updateOpponentUIElement(areaElement, opponentPlayer, state.currentPlayerId, state.gameFinished);
            });
        } else { // Fallback for less than 4 players or if myPlayer not found yet
             opponentAreasIds.forEach((areaId, index) => {
                const areaElement = document.getElementById(areaId);
                updateOpponentUIElement(areaElement, otherPlayers[index], state.currentPlayerId, state.gameFinished);
            });
        }


        // Update Player Hand and Buttons
        if (myPlayer) {
            updatePlayerHandUI(myPlayer.hand, state.currentPlayerId === myUserId && !state.gameFinished && myPlayer.connected && !myPlayer.finished, animateHandOnDisplay);
            if (playButton) playButton.disabled = !(state.currentPlayerId === myUserId && !state.gameFinished && myPlayer.connected && !myPlayer.finished);
            if (passButton) passButton.disabled = !(state.currentPlayerId === myUserId && !state.gameFinished && myPlayer.connected && !myPlayer.finished && !state.isFirstTurn && state.lastHandInfo && state.lastPlayerWhoPlayedId !== myUserId);
            if (hintButton) hintButton.disabled = !(state.currentPlayerId === myUserId && !state.gameFinished && myPlayer.connected && !myPlayer.finished);
            if (micButton) micButton.disabled = state.gameFinished || !myPlayer.connected;
        } else {
            updatePlayerHandUI([], false, false);
            if (playButton) playButton.disabled = true;
            if (passButton) passButton.disabled = true;
            if (hintButton) hintButton.disabled = true;
            if (micButton) micButton.disabled = true;
        }

        updateCenterPileUI(state.centerPile, state.lastHandInfo);

        // Game Over Overlay
        if (state.gameFinished) {
            if (gameOverOverlay) {
                gameOverOverlay.classList.remove('hidden-view');
                gameOverOverlay.style.display = 'flex';
            }
            if (gameOverTitle) gameOverTitle.textContent = `游戏结束 - ${state.gameResultText || state.result || "结果未定"}`;
            if (gameOverReasonText) gameOverReasonText.textContent = state.gameOverReason || state.reason || "";
            if (gameOverScoresDiv && state.finalScores) {
                gameOverScoresDiv.innerHTML = '';
                state.finalScores.forEach(ps => {
                    const p = document.createElement('p');
                    const scoreChange = state.scoreChanges ? (state.scoreChanges[ps.id] || 0) : 0;
                    let changeClass = 'score-zero';
                    if (scoreChange > 0) changeClass = 'score-plus';
                    else if (scoreChange < 0) changeClass = 'score-minus';
                    p.innerHTML = `${ps.name} (${ps.role || '?'}) : ${ps.score} <span class="${changeClass}">(${scoreChange >= 0 ? '+' : ''}${scoreChange})</span>`;
                    gameOverScoresDiv.appendChild(p);
                });
            }
        } else {
            if (gameOverOverlay) {
                gameOverOverlay.classList.add('hidden-view');
                gameOverOverlay.style.display = 'none';
            }
        }
    }

    function updateOpponentUIElement(areaElement, playerData, currentTurnPlayerId, isGameFinished) {
        if (!areaElement) return;
        const nameElement = areaElement.querySelector('.playerName');
        const roleElement = areaElement.querySelector('.playerRole');
        const countElement = areaElement.querySelector('.playerInfo .card-count');

        if (playerData) {
            areaElement.dataset.playerId = playerData.userId;
            if (nameElement) nameElement.textContent = playerData.username;
            if (roleElement) roleElement.textContent = playerData.role ? `(${playerData.role})` : '';
            if (countElement) countElement.textContent = playerData.handCount !== undefined ? playerData.handCount : '?';
            areaElement.classList.toggle('current-turn', currentTurnPlayerId === playerData.userId && !isGameFinished);
            areaElement.classList.toggle('player-finished', !!playerData.finished);
            areaElement.classList.toggle('player-disconnected', !playerData.connected);
            areaElement.style.opacity = playerData.connected ? '1' : '0.5';
        } else {
            if (nameElement) nameElement.textContent = '等待玩家...';
            if (roleElement) roleElement.textContent = '';
            if (countElement) countElement.textContent = '?';
            areaElement.classList.remove('current-turn', 'player-finished', 'player-disconnected');
            areaElement.removeAttribute('data-player-id');
            areaElement.style.opacity = '0.7';
        }
    }

    function updatePlayerHandUI(handCards, isMyTurn, animate = false) {
        if (!playerHandArea) return;
        playerHandArea.innerHTML = '';
        // selectedCardsForPlay = []; // Don't clear here, user might be re-selecting after invalid play
        if (!handCards || handCards.length === 0) return;

        handCards.forEach((cardData, index) => {
            const cardDiv = createCardElement(cardData);
            cardDiv.classList.add('my-card');
            if (animate) {
                cardDiv.classList.add('card-in-hand');
                void cardDiv.offsetWidth;
                setTimeout(() => cardDiv.classList.add('dealt'), index * 70 + 50);
            } else {
                cardDiv.classList.add('card-in-hand', 'dealt');
            }
             // Re-apply selection if card is still in hand
            if (selectedCardsForPlay.some(selCard => cardObjectToKey(selCard) === cardObjectToKey(cardData))) {
                cardDiv.classList.add('selected');
            }

            playerHandArea.appendChild(cardDiv);
            if (isMyTurn) {
                cardDiv.classList.add('selectable');
                cardDiv.addEventListener('click', () => {
                    toggleCardSelection(cardDiv, cardData);
                    if (currentHint) {
                        currentHint = null; currentHintIndexFromServer = 0;
                        highlightHintedCards([]);
                    }
                });
            }
        });
        if (currentHint && currentHint.length > 0) highlightHintedCards(currentHint);
    }

    function toggleCardSelection(cardDiv, cardData) {
        const cardKey = cardObjectToKey(cardData);
        const indexInSelection = selectedCardsForPlay.findIndex(c => cardObjectToKey(c) === cardKey);
        if (indexInSelection > -1) {
            selectedCardsForPlay.splice(indexInSelection, 1);
            cardDiv.classList.remove('selected');
        } else {
            selectedCardsForPlay.push(cardData);
            cardDiv.classList.add('selected');
        }
        console.log("Selected cards:", selectedCardsForPlay.map(c => c.rank + c.suit));
    }

    function updateCenterPileUI(centerPileCards, lastHandInfoData) {
        if (!discardedCardsArea) return;
        const lastHandTypeDisplay = document.getElementById('lastHandType');
        discardedCardsArea.innerHTML = '';

        let cardsToDisplay = [];
        let handTypeMessage = "等待出牌";

        if (lastHandInfoData && lastHandInfoData.cards && lastHandInfoData.cards.length > 0) {
            cardsToDisplay = lastHandInfoData.cards;
            handTypeMessage = `类型: ${lastHandInfoData.type || '未知'}`;
        } else if (centerPileCards && centerPileCards.length > 0 && (!lastHandInfoData || lastHandInfoData.cards.length === 0)) {
            // This case handles when the pile is reset (new round), but still shows the cards *just played* before reset if game state provides them in centerPile
            // However, usually lastHandInfo is authoritative.
             cardsToDisplay = centerPileCards;
             handTypeMessage = "当前出牌"; // Or simply don't show type if it's just a pile for a new turn
        }
        
        if(lastHandTypeDisplay) lastHandTypeDisplay.textContent = handTypeMessage;

        if (cardsToDisplay.length > 0) {
            cardsToDisplay.forEach(cardData => {
                const cardDiv = createCardElement(cardData);
                cardDiv.classList.add('center-pile-card');
                discardedCardsArea.appendChild(cardDiv);
            });
        }
    }

    function createCardElement(cardData) {
        const cardDiv = document.createElement('div');
        cardDiv.className = 'card';
        cardDiv.dataset.rank = cardData.rank;
        cardDiv.dataset.suit = cardData.suit;
        const imageName = `${cardData.suit}${cardData.rank}.png`;
        try {
            cardDiv.style.backgroundImage = `url('/images/cards/${imageName}')`;
        } catch (e) {
            console.error("Error setting card background image:", e, imageName);
            cardDiv.textContent = `${cardData.suit}${cardData.rank}`;
        }
        return cardDiv;
    }

    // --- Voice Functionality ---
    if (micButton) {
        micButton.addEventListener('mousedown', handleVoicePress);
        micButton.addEventListener('mouseup', handleVoiceRelease);
        micButton.addEventListener('mouseleave', handleVoiceRelease);
        micButton.addEventListener('touchstart', handleVoicePress, { passive: false });
        micButton.addEventListener('touchend', handleVoiceRelease);
        micButton.addEventListener('touchcancel', handleVoiceRelease);
    }

    async function handleVoicePress(event) {
        event.preventDefault();
        if (isRecording || !currentRoomId || (currentRoomState && currentRoomState.gameFinished)) return;

        console.log('Voice button pressed. Attempting to record.');
        isRecording = true;
        audioChunks = [];
        if(micButton) micButton.classList.add('recording');
        if(socket) socket.emit('playerStartSpeaking');

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // Try common mimeTypes, fall back if specific ones fail
            const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
            let selectedMimeType = '';
            for (const mimeType of mimeTypes) {
                if (MediaRecorder.isTypeSupported(mimeType)) {
                    selectedMimeType = mimeType;
                    break;
                }
            }
            if (!selectedMimeType) {
                console.warn("No preferred MIME type supported, using default.");
            }
            console.log("Using MIME type:", selectedMimeType || 'default (browser chosen)');

            mediaRecorder = selectedMimeType ? new MediaRecorder(stream, { mimeType: selectedMimeType }) : new MediaRecorder(stream);

            mediaRecorder.ondataavailable = event => {
                if (event.data.size > 0) audioChunks.push(event.data);
            };
            mediaRecorder.onstop = () => {
                console.log('MediaRecorder stopped. Processing audio chunks.');
                if (audioChunks.length > 0 && currentRoomId && socket) {
                    // Use the selectedMimeType (or default if empty) when creating the Blob
                    const blobMimeType = selectedMimeType || (audioChunks[0] && audioChunks[0].type) || 'application/octet-stream';
                    const audioBlob = new Blob(audioChunks, { type: blobMimeType });

                    console.log(`Sending voice message blob of type ${audioBlob.type}, size ${audioBlob.size} to room ${currentRoomId}`);
                    socket.emit('sendVoiceMessage', { roomId: currentRoomId, audioBlob: audioBlob });
                } else {
                    console.log("No audio chunks to send or not in a room/socket not available.");
                }
                audioChunks = [];
                if (stream) stream.getTracks().forEach(track => track.stop());
            };
            mediaRecorder.start();
            console.log('MediaRecorder started.');
        } catch (err) {
            console.error('Error accessing/starting microphone:', err);
            alert(`无法访问麦克风: ${err.name} - ${err.message}\n\n请检查：\n1. 浏览器是否已授予麦克风权限（点击地址栏左侧的图标）。\n2. 操作系统是否允许浏览器访问麦克风。\n3. 是否有其他程序正在使用麦克风。\n4. 如果在服务器上运行，请确保使用 HTTPS 连接。`);
            isRecording = false;
            if(micButton) micButton.classList.remove('recording');
            if(socket) socket.emit('playerStopSpeaking');
        }
    }

    function handleVoiceRelease(event) {
        event.preventDefault();
        if (!isRecording) return;
        console.log('Voice button released.');
        isRecording = false;
        if(micButton) micButton.classList.remove('recording');
        if(socket) socket.emit('playerStopSpeaking');
        if (mediaRecorder && mediaRecorder.state === 'recording') {
            mediaRecorder.stop();
        } else if (mediaRecorder && mediaRecorder.stream) { // If recording didn't start but stream was acquired
             mediaRecorder.stream.getTracks().forEach(track => track.stop());
        }
    }
    
    function findSpeakingPlayerArea(speakerUserId) {
        // For self, the info is in #my-info-in-bar
        if (speakerUserId === myUserId) {
            return document.getElementById('my-info-in-bar');
        }
        // For opponents, their main area div has data-player-id
        return document.querySelector(`.opponent-area[data-player-id="${speakerUserId}"]`);
    }

    socket.on('playerStartedSpeaking', ({ userId, username }) => {
        console.log(`${username} (ID: ${userId}) started speaking`);
        const playerArea = findSpeakingPlayerArea(userId);
        if (playerArea) {
            const indicator = playerArea.querySelector('.voice-indicator');
            if (indicator) indicator.classList.add('speaking');
        }
    });

    socket.on('playerStoppedSpeaking', ({ userId }) => {
        console.log(`Player ID: ${userId} stopped speaking`);
        const playerArea = findSpeakingPlayerArea(userId);
        if (playerArea) {
            const indicator = playerArea.querySelector('.voice-indicator');
            if (indicator) indicator.classList.remove('speaking');
        }
    });

    socket.on('receiveVoiceMessage', (data) => {
        console.log('Received voice message from:', data.userId, "Blob type:", data.audioBlob.type, "size:", data.audioBlob.size);
        const { userId, audioBlob } = data;
        if (!(audioBlob instanceof Blob) || audioBlob.size === 0) {
            console.error("Received audio data is not a valid Blob or is empty:", audioBlob);
            return;
        }
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.play().catch(error => console.error('Audio playback failed:', error));
        audio.onended = () => URL.revokeObjectURL(audioUrl);
        audio.onerror = (e) => { console.error(`Error playing audio for ${userId}:`, e); URL.revokeObjectURL(audioUrl); };
    });

}); // END DOMContentLoaded
