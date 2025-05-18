// client.js
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed');
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

    // Lobby elements
    const roomNameInput = document.getElementById('roomNameInput');
    const createRoomButton = document.getElementById('createRoomButton');
    const roomsListUl = document.getElementById('rooms');

    // Game elements
    const playerHandArea = document.getElementById('player-hand-area');
    const discardedCardsArea = document.getElementById('discarded-cards-area');
    const playButton = document.getElementById('play-button');
    const passButton = document.getElementById('pass-button');
    const hintButton = document.getElementById('hint-button');
    
    // Opponent area elements (assuming specific IDs in index.html based on player-top, player-left, player-right)
    const opponentDisplayElements = {
        top: { name: document.getElementById('player-top-name'), count: document.getElementById('player2-card-count'), area: document.getElementById('player-top') }, // Corrected from player2-card-count
        left: { name: document.getElementById('player-left-name'), count: document.getElementById('player3-card-count'), area: document.getElementById('player-left') }, // Corrected
        right: { name: document.getElementById('player-right-name'), count: document.getElementById('player4-card-count'), area: document.getElementById('player-right') } // Corrected
    };


    function switchToView(targetView) {
        allViews.forEach(view => {
            if (view) view.classList.add('hidden-view');
        });
        if (targetView) {
            targetView.classList.remove('hidden-view');
            targetView.classList.add('view-block'); // Or view-flex depending on its layout needs
            if (targetView === gameView || targetView === lobbyView) { // Ensure they are block or flex
                 targetView.style.display = 'block'; // or 'flex' if that's the base
            }
        }
    }

    switchToView(loadingView);

    const storedUserId = localStorage.getItem('userId');
    if (storedUserId) {
        socket.emit('reauthenticate', storedUserId, (response) => {
            if (response.success) {
                handleAuthSuccess(response);
                // Game state will be requested or sent after successful re-auth if in room
            } else {
                localStorage.removeItem('userId');
                switchToView(authView);
            }
        });
    } else {
        switchToView(authView);
    }

    showRegisterLink.addEventListener('click', (e) => {
        e.preventDefault();
        loginForm.style.display = 'none';
        registerForm.style.display = 'block';
    });

    showLoginLink.addEventListener('click', (e) => {
        e.preventDefault();
        registerForm.style.display = 'none';
        loginForm.style.display = 'block';
    });

    loginButton.addEventListener('click', () => {
        const phoneNumber = loginUsernameInput.value;
        const password = loginPasswordInput.value;
        socket.emit('login', { phoneNumber, password }, handleAuthResponse);
    });

    registerButton.addEventListener('click', () => {
        const phoneNumber = registerUsernameInput.value;
        const password = registerPasswordInput.value;
        socket.emit('register', { phoneNumber, password }, (response) => {
            alert(response.message);
            if (response.success) {
                loginForm.style.display = 'block';
                registerForm.style.display = 'none';
            }
        });
    });

    function handleAuthSuccess(data) {
        myUserId = data.userId;
        myUsername = data.username;
        localStorage.setItem('userId', data.userId);
        console.log('Auth success:', data.username, data.userId);
        if (data.roomState) { // Reconnected to a room
            currentRoomId = data.roomState.roomId;
            displayGameState(data.roomState, true); // Animate hand on rejoining a game in progress
            switchToView(gameView);
        } else {
            switchToView(lobbyView);
            socket.emit('listRooms', updateRoomList);
        }
    }

    function handleAuthResponse(response) {
        if (response.success) {
            handleAuthSuccess(response);
        } else {
            alert(`Auth failed: ${response.message}`);
            localStorage.removeItem('userId');
            switchToView(authView);
        }
    }
    
    socket.on('connect', () => {
        console.log('Connected to server with ID:', socket.id);
        if (loadingView.classList.contains('view-block')) { // Only update if it's the current view
             loadingView.textContent = '已连接。请登录或尝试重新验证。';
        }
        // If a storedUserId exists, re-authentication is attempted above.
        // If no storedUserId, and not yet authenticated, stay on authView.
        if (!myUserId && !localStorage.getItem('userId')) {
            switchToView(authView);
        }
    });
    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        alert('与服务器断开连接: ' + reason + ". 请刷新页面重试。");
        switchToView(loadingView);
        loadingView.textContent = '已断开连接...';
    });
    socket.on('connect_error', (err) => {
        console.error('Connection error:', err.message);
        switchToView(loadingView);
        loadingView.textContent = `连接错误: ${err.message}.`;
    });


    createRoomButton.addEventListener('click', () => {
        const roomName = roomNameInput.value.trim();
        if (!roomName) { alert('请输入房间名称'); return; }
        socket.emit('createRoom', { roomName, password: null }, (response) => {
            if (response.success) {
                currentRoomId = response.roomId;
                displayGameState(response.roomState); 
                switchToView(gameView);
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
                li.innerHTML = `
                    <span>${room.roomName} (${room.playerCount}/${room.maxPlayers}) - ${room.status}</span>
                    <button data-roomid="${room.roomId}" class="join-room-btn" ${room.status !== 'waiting' || room.playerCount >= room.maxPlayers ? 'disabled' : ''}>加入</button>
                `; // TODO: Password input for passworded rooms
                roomsListUl.appendChild(li);
            });
            document.querySelectorAll('.join-room-btn').forEach(button => {
                button.addEventListener('click', (e) => {
                    const roomIdToJoin = e.target.dataset.roomid;
                    socket.emit('joinRoom', { roomId: roomIdToJoin, password: null }, (response) => {
                        if (response.success) {
                            currentRoomId = response.roomId;
                            displayGameState(response.roomState);
                            switchToView(gameView);
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

    socket.on('gameStarted', (gameState) => {
        console.log('Game started!', gameState);
        currentRoomState = gameState;
        displayGameState(gameState, true); // Animate hand on game start
        switchToView(gameView);
        const myRole = gameState.players.find(p=>p.userId === myUserId)?.role;
        alert("游戏开始！" + (myRole ? `你的身份是: ${myRole}` : ''));
    });

    socket.on('gameStateUpdate', (gameState) => {
        console.log('Game state update:', gameState);
        const oldHand = currentRoomState?.players.find(p => p.userId === myUserId)?.hand;
        currentRoomState = gameState;
        // Only animate hand if it's the first time it's being rendered (or significantly changes, e.g. from undefined to array)
        const myNewHand = gameState.players.find(p => p.userId === myUserId)?.hand;
        const shouldAnimateHand = !oldHand && myNewHand && myNewHand.length > 0;
        displayGameState(gameState, shouldAnimateHand);
    });
    
    socket.on('invalidPlay', (data) => {
        alert(`无效操作: ${data.message}`);
    });

    socket.on('gameOver', (data) => {
        console.log('Game Over:', data);
        currentRoomState = { ...currentRoomState, ...data, gameFinished: true, gameStarted: false };
        displayGameState(currentRoomState); // Show final scores etc.
        
        let gameOverMessage = `游戏结束! 结果: ${data.result}`;
        if (data.reason && data.reason !== '正常结束') {
            gameOverMessage += `\n原因: ${data.reason}`;
        }
        if (data.finalScores) {
            gameOverMessage += "\n最终得分:\n";
            data.finalScores.forEach(ps => {
                const scoreChange = data.scoreChanges ? (data.scoreChanges[ps.id] || 0) : 0;
                gameOverMessage += `${ps.name} (${ps.role}): ${ps.score} (${scoreChange >= 0 ? '+' : ''}${scoreChange})\n`;
            });
        }
        alert(gameOverMessage);

        const existingBtn = document.getElementById('backToLobbyBtn');
        if(existingBtn) existingBtn.remove();

        const backToLobbyBtn = document.createElement('button');
        backToLobbyBtn.textContent = "返回大厅";
        backToLobbyBtn.id = 'backToLobbyBtn';
        backToLobbyBtn.onclick = () => {
            socket.emit('leaveRoom', () => {}); 
            currentRoomId = null;
            currentRoomState = null;
            switchToView(lobbyView);
            socket.emit('listRooms', updateRoomList);
            if(document.getElementById('backToLobbyBtn')) document.getElementById('backToLobbyBtn').remove();
        };
        document.getElementById('game-controls').appendChild(backToLobbyBtn);
    });

    playButton.addEventListener('click', () => {
        if (selectedCardsForPlay.length === 0) { alert('请选择要出的牌'); return; }
        socket.emit('playCard', selectedCardsForPlay, (response) => {
            if (response.success) {
                selectedCardsForPlay = []; 
            } else {
                alert(`出牌失败: ${response.message}`);
            }
        });
    });

    passButton.addEventListener('click', () => {
        socket.emit('passTurn', (response) => {
            if (!response.success) { alert(`操作失败: ${response.message}`); }
        });
    });

    hintButton.addEventListener('click', () => {
        socket.emit('requestHint', currentHintIndexFromServer, (response) => {
            if (response.success && response.hint && response.hint.cards) {
                currentHint = response.hint.cards; 
                currentHintIndexFromServer = response.nextHintIndexToServer !== undefined ? response.nextHintIndexToServer : 0;
                highlightHintedCards(currentHint);
            } else {
                alert(response.message || '没有可用的提示。');
                currentHint = null;
                highlightHintedCards([]);
            }
        });
    });
    
    function cardObjectToKey(card) { return `${card.rank}${card.suit}`; }
    
    function highlightHintedCards(hintedCardsArray) {
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
        if (!state || !myUserId) return;
        currentRoomState = state; 

        const myPlayer = state.players.find(p => p.userId === myUserId);
        
        // Crude opponent mapping. This needs a proper system based on relative slots.
        // Assuming myPlayer.slot is 0 for bottom, 1 for left, 2 for top, 3 for right
        // This is a placeholder and will likely look wrong without more robust slot-to-position logic
        let opponentSlots = [];
        if (myPlayer) {
            const mySlot = myPlayer.slot;
            // Example: if I'm slot 0 (bottom)
            // Slot 1 = right, Slot 2 = top, Slot 3 = left
            // This needs to map actual player slots to fixed visual positions (top, left, right)
            // For simplicity, just iterate other players and assign to fixed spots if available
            const otherPlayers = state.players.filter(p => p.userId !== myUserId);
            
            // This assignment is arbitrary and needs to be based on slot logic relative to myPlayer.slot
            updateOpponentUI(opponentDisplayElements.top, otherPlayers.find(p => p.slot === (mySlot + 2) % 4)); // Example mapping
            updateOpponentUI(opponentDisplayElements.left, otherPlayers.find(p => p.slot === (mySlot + 3) % 4));
            updateOpponentUI(opponentDisplayElements.right, otherPlayers.find(p => p.slot === (mySlot + 1) % 4));
        } else { // Spectator or error
            updateOpponentUI(opponentDisplayElements.top, state.players[1]); // Fallback display
            updateOpponentUI(opponentDisplayElements.left, state.players[2]);
            updateOpponentUI(opponentDisplayElements.right, state.players[3]);
        }
        
        if (myPlayer) {
            updatePlayerHandUI(myPlayer.hand, state.currentPlayerId === myUserId, animateHandOnDisplay);
            document.getElementById('play-button').disabled = state.currentPlayerId !== myUserId || state.gameFinished || !myPlayer.connected;
            document.getElementById('pass-button').disabled = state.currentPlayerId !== myUserId || state.gameFinished || !myPlayer.connected || state.isFirstTurn || !state.lastHandInfo || (state.lastHandInfo && state.lastPlayerWhoPlayedId === myUserId) ;
            document.getElementById('hint-button').disabled = state.currentPlayerId !== myUserId || state.gameFinished || !myPlayer.connected;
        }

        updateCenterPileUI(state.centerPile, state.lastHandInfo);

        document.querySelectorAll('.opponent-area, .my-player-area').forEach(el => el.classList.remove('current-turn'));
        if (state.currentPlayerId && !state.gameFinished) {
            const currentPlayerIsSelf = state.currentPlayerId === myUserId;
            if (currentPlayerIsSelf) {
                // Highlight self area if exists
            } else {
                const currentOpponent = state.players.find(p => p.userId === state.currentPlayerId);
                if (currentOpponent) {
                    // Find which opponentDisplayElement corresponds to currentOpponent.slot and add 'current-turn'
                    // This requires robust slot-to-element mapping.
                    Object.values(opponentDisplayElements).forEach(disp => {
                        if (disp.area && disp.area.dataset.playerId === currentOpponent.userId) { // Assuming we set dataset.playerId
                            disp.area.classList.add('current-turn');
                        }
                    });
                }
            }
        }
        const existingBackToLobbyBtn = document.getElementById('backToLobbyBtn');
        if(state.gameFinished && !existingBackToLobbyBtn){
            // game over alert logic is now in 'gameOver' handler
        } else if (!state.gameFinished && existingBackToLobbyBtn) {
            existingBackToLobbyBtn.remove();
        }
    }
    
    function updateOpponentUI(displayElements, playerData) {
        if (!displayElements || !displayElements.area) return; // Ensure elements exist
    
        if (playerData) {
            displayElements.area.dataset.playerId = playerData.userId; // Store player ID for reference
            if (displayElements.name) displayElements.name.textContent = playerData.username + (playerData.role ? ` (${playerData.role})` : '');
            if (displayElements.count) displayElements.count.textContent = playerData.handCount;
            displayElements.area.classList.toggle('current-turn', currentRoomState?.currentPlayerId === playerData.userId && !currentRoomState?.gameFinished);
            // Add more status like .finished, .connected if needed
        } else {
            if (displayElements.name) displayElements.name.textContent = '...';
            if (displayElements.count) displayElements.count.textContent = '-';
            displayElements.area.classList.remove('current-turn');
            displayElements.area.removeAttribute('data-player-id');
        }
    }

    function updatePlayerHandUI(handCards, isMyTurn, animate = false) {
        playerHandArea.innerHTML = ''; 
        selectedCardsForPlay = []; 
        currentHint = null; 

        if (!handCards || handCards.length === 0) return;

        handCards.forEach((cardData, index) => {
            const cardDiv = createCardElement(cardData);
            cardDiv.classList.add('my-card'); 
            
            if (animate) {
                cardDiv.classList.add('card-in-hand'); // Base for animation
            } else {
                cardDiv.classList.add('card-in-hand', 'dealt'); // Immediately visible
            }
            playerHandArea.appendChild(cardDiv);

            if (animate) {
                setTimeout(() => { cardDiv.classList.add('dealt'); }, index * 80); 
            }
            
            if (isMyTurn) {
                cardDiv.classList.add('selectable');
                cardDiv.addEventListener('click', () => {
                    toggleCardSelection(cardDiv, cardData);
                    if (currentHint) { currentHint = null; highlightHintedCards([]); }
                });
            }
        });
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
    }

    function updateCenterPileUI(centerPileCards, lastHandInfo) {
        discardedCardsArea.innerHTML = '';
        let cardsToDisplay = [];
        if (lastHandInfo && lastHandInfo.cards && lastHandInfo.cards.length > 0) {
            const handTypeDisplay = document.createElement('div');
            handTypeDisplay.className = 'last-hand-type';
            handTypeDisplay.textContent = `打出牌型: ${lastHandInfo.type}`; 
            discardedCardsArea.appendChild(handTypeDisplay);
            cardsToDisplay = lastHandInfo.cards;
        } else if (centerPileCards && centerPileCards.length > 0) { 
             cardsToDisplay = centerPileCards;
        }
        
        cardsToDisplay.forEach(cardData => {
            const cardDiv = createCardElement(cardData);
            cardDiv.classList.add('center-pile-card'); 
            discardedCardsArea.appendChild(cardDiv);
        });
    }

    function createCardElement(cardData) {
        const cardDiv = document.createElement('div');
        cardDiv.className = 'card'; 
        cardDiv.dataset.rank = cardData.rank;
        cardDiv.dataset.suit = cardData.suit;
        // Image naming convention: Suit then Rank, e.g., SA.png, H2.png, DT.png for 10 of Diamonds
        const rankChar = cardData.rank; // T, J, Q, K, A, 2-9
        const suitChar = cardData.suit; // S, H, D, C
        const imageName = `${suitChar}${rankChar}.png`;
        cardDiv.style.backgroundImage = `url('/images/cards/${imageName}')`;
        return cardDiv;
    }

    // Initial setup
    // switchToView(loadingView); // Already called above
});
