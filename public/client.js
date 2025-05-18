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
    // 在 style.css 中，我看到您也用了 roomView，这里假设 gameView 就是主要的房间/游戏界面
    // 如果 roomView 是一个独立的准备界面，那么切换逻辑需要更细致
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
    // const authErrorElement = document.getElementById('authError'); // 之前您HTML里没有，所以注释掉

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

    // Opponent area elements (您HTML里还没有这些ID，先注释掉，否则会是null)
    /*
    const opponentDisplayElements = {
        top: { name: document.getElementById('player-top-name'), count: document.getElementById('player2-card-count'), area: document.getElementById('player-top') },
        left: { name: document.getElementById('player-left-name'), count: document.getElementById('player3-card-count'), area: document.getElementById('player-left') },
        right: { name: document.getElementById('player-right-name'), count: document.getElementById('player4-card-count'), area: document.getElementById('player-right') }
    };
    */

    function switchToView(targetViewId) {
        console.log(`Switching to view: ${targetViewId}`);
        allViews.forEach(view => {
            if (view) { // 确保元素存在
                if (view.id === targetViewId) {
                    view.classList.remove('hidden-view');
                    // 根据需要设置为 'block' 或 'flex'，这里统一用 block，具体样式由CSS控制
                    view.style.display = 'block'; // 或者您在CSS中定义的 .view-block / .view-flex
                } else {
                    view.classList.add('hidden-view');
                    view.style.display = 'none';
                }
            }
        });
    }

    switchToView('loadingView'); // 初始显示加载中

    const storedUserId = localStorage.getItem('userId');
    if (storedUserId) {
        console.log(`Found stored user ID: ${storedUserId}, attempting reauthentication.`);
        socket.emit('reauthenticate', storedUserId, (response) => {
            console.log('Reauthenticate response:', response);
            if (response.success) {
                handleAuthSuccess(response); // 这个函数会处理视图切换
            } else {
                console.log('Reauthentication failed:', response.message);
                localStorage.removeItem('userId');
                localStorage.removeItem('username'); // 如果也存了用户名
                switchToView('auth-view');
            }
        });
    } else {
        console.log('No stored user ID found.');
        switchToView('auth-view');
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
            alert(response.message); // 使用 alert 提示用户
            if (response.success) {
                loginForm.style.display = 'block';
                registerForm.style.display = 'none';
                // 可以考虑自动填充登录表单
                loginUsernameInput.value = phoneNumber;
                loginPasswordInput.value = ""; // 清空密码或让用户重新输入
                loginPasswordInput.focus();
            }
        });
    });

    function handleAuthSuccess(data) {
        myUserId = data.userId;
        myUsername = data.username;
        localStorage.setItem('userId', data.userId);
        // localStorage.setItem('username', data.username); // 可以选择性存储用户名
        console.log(`Auth success for user: ${myUsername} (ID: ${myUserId})`);

        if (data.roomState) {
            currentRoomId = data.roomState.roomId;
            console.log(`User was in room ${currentRoomId}, displaying game state.`);
            displayGameState(data.roomState, true);
            switchToView('game-view'); // <--- 关键：切换到游戏视图
        } else {
            console.log('User not in a room, switching to lobby.');
            switchToView('lobby-view');
            socket.emit('listRooms', updateRoomList); // 获取房间列表
        }
    }

    function handleAuthResponse(response) {
        console.log('Login/Auth response received:', response);
        if (response.success) {
            handleAuthSuccess(response);
        } else {
            alert(`认证失败: ${response.message}`); // 使用 alert 提示用户
            localStorage.removeItem('userId');
            // localStorage.removeItem('username');
            switchToView('auth-view'); // 保持在认证视图
        }
    }

    socket.on('connect', () => {
        console.log('Connected to server with ID:', socket.id);
        // 如果是 loadingView 状态，说明是初次加载或断线重连的开始
        if (document.getElementById('loadingView').style.display !== 'none') {
            if (storedUserId && !myUserId) { // 有存储ID但尚未通过 reauth 成功
                // 等待 reauthenticate 的结果
                console.log("Connected, waiting for reauthentication result...");
            } else if (!myUserId) { // 没有存储ID，也没有登录
                switchToView('auth-view');
            }
            // 如果 myUserId 已经存在 (例如 reauthenticate 已经成功)，则 handleAuthSuccess 已经处理了视图
        }
    });

    socket.on('disconnect', (reason) => {
        console.log('Disconnected from server:', reason);
        alert('与服务器断开连接: ' + reason + ". 请刷新页面重试。");
        switchToView('loadingView');
        const loadingViewP = loadingView.querySelector('p');
        if (loadingViewP) loadingViewP.textContent = '已断开连接...';
        myUserId = null; // 清理状态
        myUsername = null;
        currentRoomId = null;
    });

    socket.on('connect_error', (err) => {
        console.error('Connection error:', err.message);
        switchToView('loadingView');
        const loadingViewP = loadingView.querySelector('p');
        if (loadingViewP) loadingViewP.textContent = `连接错误: ${err.message}.`;
    });


    createRoomButton.addEventListener('click', () => {
        const roomName = roomNameInput.value.trim();
        if (!roomName) { alert('请输入房间名称'); return; }
        socket.emit('createRoom', { roomName, password: null /* 暂不支持密码 */ }, (response) => {
            if (response.success) {
                currentRoomId = response.roomId;
                console.log(`Room created: ${roomName} (${currentRoomId}), initial state:`, response.roomState);
                displayGameState(response.roomState);
                switchToView('game-view'); // 创建房间后切换到游戏/房间视图
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
                `;
                roomsListUl.appendChild(li);
            });
            document.querySelectorAll('.join-room-btn').forEach(button => {
                button.addEventListener('click', (e) => {
                    const roomIdToJoin = e.target.dataset.roomid;
                    // TODO: 如果房间有密码，这里需要弹出密码输入框
                    socket.emit('joinRoom', { roomId: roomIdToJoin, password: null }, (response) => {
                        if (response.success) {
                            currentRoomId = response.roomId;
                            console.log(`Joined room ${roomIdToJoin}, state:`, response.roomState);
                            displayGameState(response.roomState);
                            switchToView('game-view'); // 加入房间后切换视图
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
        console.log('Game started event received!', gameState);
        currentRoomState = gameState;
        displayGameState(gameState, true); // Animate hand on game start
        switchToView('game-view'); // 确保在游戏开始时切换到游戏视图
        const myRole = gameState.players.find(p=>p.userId === myUserId)?.role;
        alert("游戏开始！" + (myRole ? `你的身份是: ${myRole}` : ''));
    });

    socket.on('gameStateUpdate', (gameState) => {
        console.log('Game state update event received:', gameState);
        const oldHand = currentRoomState?.players.find(p => p.userId === myUserId)?.hand;
        currentRoomState = gameState;
        const myNewHand = gameState.players.find(p => p.userId === myUserId)?.hand;
        const shouldAnimateHand = !oldHand && myNewHand && myNewHand.length > 0;
        displayGameState(gameState, shouldAnimateHand);
        // 不需要在这里切换视图，因为理论上应该已经在游戏视图了
    });

    socket.on('invalidPlay', (data) => {
        alert(`无效操作: ${data.message}`);
    });

    socket.on('gameOver', (data) => {
        console.log('Game Over event received:', data);
        // 合并游戏结束信息到当前状态，确保 gameFinished 等标志被设置
        currentRoomState = {
            ...(currentRoomState || {}), // 保留现有房间信息
            ...data,                    // 应用游戏结束的特定信息 (scores, resultText etc.)
            gameFinished: true,
            gameStarted: false, // 游戏已不再进行
            currentPlayerId: null // 没有当前玩家了
         };
        displayGameState(currentRoomState); // 更新UI以显示最终分数等

        let gameOverMessage = `游戏结束! 结果: ${data.result || '未定'}`;
        if (data.reason && data.reason !== '游戏结束' && data.reason !== '正常结束') { // 避免重复显示“游戏结束”
            gameOverMessage += `\n原因: ${data.reason}`;
        }
        if (data.finalScores) {
            gameOverMessage += "\n最终得分:\n";
            data.finalScores.forEach(ps => {
                const scoreChange = data.scoreChanges ? (data.scoreChanges[ps.id] || 0) : 0;
                gameOverMessage += `${ps.name} (${ps.role || '无角色'}): ${ps.score} (${scoreChange >= 0 ? '+' : ''}${scoreChange})\n`;
            });
        }
        alert(gameOverMessage);

        const gameControlsDiv = document.getElementById('game-controls');
        if (gameControlsDiv) {
            const existingBtn = document.getElementById('backToLobbyBtn');
            if(existingBtn) existingBtn.remove();

            const backToLobbyBtn = document.createElement('button');
            backToLobbyBtn.textContent = "返回大厅";
            backToLobbyBtn.id = 'backToLobbyBtn';
            backToLobbyBtn.onclick = () => {
                socket.emit('leaveRoom', (response) => {
                    console.log('Leave room response:', response);
                    // 无论成功与否，都尝试清理客户端状态并切换视图
                    currentRoomId = null;
                    currentRoomState = null;
                    selectedCardsForPlay = [];
                    currentHint = null;
                    switchToView('lobby-view');
                    socket.emit('listRooms', updateRoomList); // 刷新大厅列表
                    const btnToRemove = document.getElementById('backToLobbyBtn');
                    if (btnToRemove) btnToRemove.remove();
                });
            };
            gameControlsDiv.appendChild(backToLobbyBtn);
        } else {
            console.error("game-controls div not found for game over button.");
        }
    });


    playButton.addEventListener('click', () => {
        if (selectedCardsForPlay.length === 0) { alert('请选择要出的牌'); return; }
        socket.emit('playCard', selectedCardsForPlay, (response) => {
            if (response && response.success) { // 检查 response 是否存在
                selectedCardsForPlay = [];
                // UI 会通过 gameStateUpdate 更新
            } else {
                alert(`出牌失败: ${response ? response.message : '未知错误'}`);
            }
        });
    });

    passButton.addEventListener('click', () => {
        socket.emit('passTurn', (response) => {
            if (response && !response.success) { // 检查 response 是否存在
                alert(`操作失败: ${response.message}`);
            }
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
                highlightHintedCards([]); // 清除高亮
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
            // 可能需要切换到大厅或错误页面
            if (!myUserId) switchToView('auth-view'); // 如果连用户ID都没了，返回登录
            else switchToView('lobby-view');
            return;
        }
        currentRoomState = state; // 更新全局的房间状态

        const myPlayer = state.players ? state.players.find(p => p.userId === myUserId) : null;

        // 更新对手信息 (需要您在HTML中为对手区域添加正确的ID)
        // 这个对手映射逻辑需要根据您的游戏设计（固定位置还是相对位置）来完善
        const opponentSlotsMapping = { // 这是一个示例，您需要根据实际情况调整
            // 'player-top': (myPlayerSlot + 2) % 4,
            // 'player-left': (myPlayerSlot + 3) % 4, // 或 (myPlayerSlot - 1 + 4) % 4
            // 'player-right': (myPlayerSlot + 1) % 4,
        };
        if (myPlayer && state.players) {
            const mySlot = myPlayer.slot;
            state.players.forEach(p => {
                if (p.userId === myUserId) {
                    // 更新自己的信息区域 (如果除了手牌还有其他显示)
                    // document.getElementById('my-player-name').textContent = p.username + (p.role ? `(${p.role})` : '');
                    // ...
                } else {
                    // 根据 p.slot 和 mySlot 的关系，找到它对应的 opponentDisplayElement
                    // 例如：
                    // let positionKey;
                    // if (p.slot === (mySlot + 1) % 4) positionKey = 'right';
                    // else if (p.slot === (mySlot + 2) % 4) positionKey = 'top';
                    // else if (p.slot === (mySlot + 3) % 4) positionKey = 'left';
                    // if (positionKey && opponentDisplayElements[positionKey]) {
                    //    updateOpponentUI(opponentDisplayElements[positionKey], p, state.currentPlayerId, state.gameFinished);
                    // }
                }
            });
        }
        // 简化的对手更新，假设HTML有 player-top, player-left, player-right 的 name 和 count 元素
        // 您需要完善这里的逻辑以正确映射玩家到对应的UI元素
        const otherPlayers = state.players ? state.players.filter(p => p.userId !== myUserId) : [];
        const playerTopEl = document.getElementById('player-top'); // 整个区域
        const playerLeftEl = document.getElementById('player-left');
        const playerRightEl = document.getElementById('player-right');

        updateOpponentUIElement(playerTopEl, otherPlayers[0], state.currentPlayerId, state.gameFinished); // 示例：取第一个其他玩家放顶部
        updateOpponentUIElement(playerLeftEl, otherPlayers[1], state.currentPlayerId, state.gameFinished);
        updateOpponentUIElement(playerRightEl, otherPlayers[2], state.currentPlayerId, state.gameFinished);


        if (myPlayer) {
            updatePlayerHandUI(myPlayer.hand, state.currentPlayerId === myUserId && !state.gameFinished, animateHandOnDisplay);
            playButton.disabled = state.currentPlayerId !== myUserId || state.gameFinished || !myPlayer.connected;
            passButton.disabled = state.currentPlayerId !== myUserId || state.gameFinished || !myPlayer.connected || state.isFirstTurn || !state.lastHandInfo || (state.lastHandInfo && state.lastPlayerWhoPlayedId === myUserId);
            hintButton.disabled = state.currentPlayerId !== myUserId || state.gameFinished || !myPlayer.connected;
        } else { // 我不是玩家（例如刚加入房间，游戏已开始但我是旁观，或出错）
            updatePlayerHandUI([], false, false); // 清空手牌
            playButton.disabled = true;
            passButton.disabled = true;
            hintButton.disabled = true;
        }

        updateCenterPileUI(state.centerPile, state.lastHandInfo);

        // 更新当前回合玩家高亮
        document.querySelectorAll('.opponent-area, .my-player-area').forEach(el => {
            if(el) el.classList.remove('current-turn');
        });
        if (state.currentPlayerId && !state.gameFinished) {
            const currentPlayerIsSelf = state.currentPlayerId === myUserId;
            if (currentPlayerIsSelf) {
                // Highlight self area, e.g., by adding a class to #player-hand or a dedicated self-info area
                // document.getElementById('my-player-area-id').classList.add('current-turn');
            } else {
                // 查找哪个 opponent-area 对应 currentPlayerId
                const opponentAreas = [playerTopEl, playerLeftEl, playerRightEl];
                opponentAreas.forEach(area => {
                    if (area && area.dataset.playerId === state.currentPlayerId) {
                        area.classList.add('current-turn');
                    }
                });
            }
        }

        // 处理游戏结束后的返回大厅按钮
        const gameControlsDiv = document.getElementById('game-controls');
        if (gameControlsDiv) {
            const existingBackBtn = document.getElementById('backToLobbyBtn');
            if (state.gameFinished && !existingBackBtn) {
                // 创建按钮的逻辑已移至 'gameOver' 事件处理器中
            } else if (!state.gameFinished && existingBackBtn) {
                existingBackBtn.remove();
            }
        }
    }

    // 辅助函数来更新单个对手的UI元素
    function updateOpponentUIElement(areaElement, playerData, currentTurnPlayerId, isGameFinished) {
        if (!areaElement) return;

        const nameElement = areaElement.querySelector('.player-name'); // 假设内部有 .player-name
        const countElement = areaElement.querySelector('.player-card-count span'); // 假设内部有 .player-card-count span

        if (playerData) {
            areaElement.dataset.playerId = playerData.userId; // 用于高亮当前玩家等
            if (nameElement) nameElement.textContent = playerData.username + (playerData.role ? ` (${playerData.role})` : '');
            if (countElement) countElement.textContent = playerData.handCount;
            areaElement.classList.toggle('current-turn', currentTurnPlayerId === playerData.userId && !isGameFinished);
            // TODO: 显示 finished, disconnected 状态
        } else {
            if (nameElement) nameElement.textContent = '等待玩家';
            if (countElement) countElement.textContent = '-';
            areaElement.classList.remove('current-turn');
            areaElement.removeAttribute('data-player-id');
        }
    }


    function updatePlayerHandUI(handCards, isMyTurn, animate = false) {
        if (!playerHandArea) return;
        playerHandArea.innerHTML = '';
        selectedCardsForPlay = []; // 清空已选中的牌
        // currentHint = null; // 不在这里清空hint，除非有明确逻辑

        if (!handCards || handCards.length === 0) {
            // console.log("No hand cards to display or player not in game.");
            return;
        }

        handCards.forEach((cardData, index) => {
            const cardDiv = createCardElement(cardData);
            cardDiv.classList.add('my-card');

            if (animate) {
                cardDiv.classList.add('card-in-hand'); // Base for animation
                // Trigger reflow to ensure animation plays
                void cardDiv.offsetWidth;
                setTimeout(() => {
                    cardDiv.classList.add('dealt');
                 }, index * 70 + 50); // Stagger animation, add slight initial delay
            } else {
                cardDiv.classList.add('card-in-hand', 'dealt'); // Immediately visible, no animation
            }
            playerHandArea.appendChild(cardDiv);

            if (isMyTurn) { // 只有轮到我并且游戏没结束才能选牌
                cardDiv.classList.add('selectable');
                cardDiv.addEventListener('click', () => {
                    toggleCardSelection(cardDiv, cardData);
                    // 如果用户点击了牌，通常意味着他们放弃了当前的提示
                    if (currentHint) {
                        currentHint = null;
                        currentHintIndexFromServer = 0; // 重置提示索引
                        highlightHintedCards([]); // 清除提示高亮
                    }
                });
            }
        });
        // 如果 currentHint 仍然有效，在手牌重绘后重新高亮
        if (currentHint && currentHint.length > 0) {
            highlightHintedCards(currentHint);
        }
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
        discardedCardsArea.innerHTML = ''; // 清空弃牌区

        let cardsToDisplay = [];
        let handTypeMessage = "";

        if (lastHandInfoData && lastHandInfoData.cards && lastHandInfoData.cards.length > 0) {
            // 如果有 lastHandInfo (通常是上一手有效出牌)，则显示它
            cardsToDisplay = lastHandInfoData.cards;
            handTypeMessage = `类型: ${lastHandInfoData.type || '未知'}`;
            if (lastHandInfoData.representativeCard) {
                 // handTypeMessage += `, 代表牌: ${lastHandInfoData.representativeCard.rank}${lastHandInfoData.representativeCard.suit}`;
            }
        } else if (centerPileCards && centerPileCards.length > 0) {
            // 否则，如果中心牌堆有牌 (例如，在回合重置后，前一个玩家刚打出，但尚未成为 lastValidHandInfo)
            // 这种情况比较少见，因为 lastValidHandInfo 通常会被更新
            cardsToDisplay = centerPileCards;
            handTypeMessage = "当前牌堆";
        } else {
            handTypeMessage = "等待出牌";
        }

        const handTypeDisplay = document.createElement('div');
        handTypeDisplay.className = 'last-hand-type'; // 可以用这个类来设定文字样式
        handTypeDisplay.textContent = handTypeMessage;
        discardedCardsArea.appendChild(handTypeDisplay);

        if (cardsToDisplay.length > 0) {
            cardsToDisplay.forEach(cardData => {
                const cardDiv = createCardElement(cardData);
                cardDiv.classList.add('center-pile-card'); // 用于区分中间牌堆的牌
                discardedCardsArea.appendChild(cardDiv);
            });
        }
    }

    function createCardElement(cardData) {
        const cardDiv = document.createElement('div');
        cardDiv.className = 'card';
        cardDiv.dataset.rank = cardData.rank;
        cardDiv.dataset.suit = cardData.suit;
        const rankChar = cardData.rank;
        const suitChar = cardData.suit;
        const imageName = `${suitChar}${rankChar}.png`; // 例如 S2.png, HK.png
        try {
            cardDiv.style.backgroundImage = `url('/images/cards/${imageName}')`;
        } catch (e) {
            console.error("Error setting card background image:", e, imageName);
            cardDiv.textContent = `${suitChar}${rankChar}`; // Fallback text
        }
        return cardDiv;
    }

});
