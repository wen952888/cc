// client.js
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed. Client v1.0.35');
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

    function switchToView(targetViewId) { /* ... (保持不变) ... */ }
    function showAuthError(message) { /* ... (保持不变) ... */ }
    function clearAuthError() { /* ... (保持不变) ... */ }
    function handleAuthSuccess(data) { /* ... (保持不变) ... */ }
    function handleAuthResponse(response) { /* ... (保持不变) ... */ }
    function updateRoomList(rooms) { /* ... (保持不变) ... */ }
    function showTemporaryMessage(message, duration = 2500) { /* ... (保持不变) ... */ }
    function handleLeaveRoomAndReturnToLobby() { /* ... (保持不变) ... */ }
    function updateOpponentUIElement(areaEl, pData, cTurnPId, isGFinished, rStatus) { /* ... (保持不变) ... */ }
    function updatePlayerReadyStatusUI(pUserId, isReady) { /* ... (保持不变) ... */ }
    function updateCenterPileUI(cPileCards, lHInfo) { /* ... (保持不变) ... */ }
    function createCardElement(cardData) { /* ... (保持不变, 但确保dataset.rank和dataset.suit被正确设置) ... */
        const cardDiv = document.createElement('div'); cardDiv.className = 'card'; if(!cardData || !cardData.rank || !cardData.suit) { console.error("[GFX] Invalid cardData for createCardElement:", cardData); cardDiv.textContent = "ERR"; return cardDiv;} cardDiv.dataset.rank = cardData.rank; cardDiv.dataset.suit = cardData.suit; const rankPart = rankToImageNamePart[cardData.rank]; const suitPart = suitToImageNamePart[cardData.suit]; let imageName; if (rankPart && suitPart) { imageName = `${rankPart}_of_${suitPart}${CARD_IMAGE_EXTENSION}`; } else { console.warn(`[GFX] Failed to map card data: suit=${cardData.suit}, rank=${cardData.rank}. Using back.`); imageName = CARD_BACK_IMAGE; cardDiv.textContent = `${cardData.suit}${cardData.rank}`; } const imagePath = `/images/cards/${imageName}`; try { cardDiv.style.backgroundImage = `url('${imagePath}')`; } catch (e) { console.error(`[GFX] Error setting image for ${imagePath}:`, e); cardDiv.textContent = `${cardData.suit}${cardData.rank}`; } return cardDiv;
    }
    function cardObjectToKey(card) { if (!card || typeof card.rank === 'undefined' || typeof card.suit === 'undefined') { return null; } return `${card.rank}${card.suit}`; }
    async function handleVoicePress(evt){ /* ... (保持不变) ... */ }
    function handleVoiceRelease(evt){ /* ... (保持不变) ... */ }
    function findSpeakingPlayerArea(sUID){ /* ... (保持不变) ... */ }


    // --- Socket Event Listeners (保持不变) ---
    // socket.on('connect', ...);
    // socket.on('disconnect', ...);
    // socket.on('connect_error', ...);
    // socket.on('roomListUpdate', ...);
    // socket.on('gameStarted', ...);
    // socket.on('gameStateUpdate', ...);
    // socket.on('playerJoined', ...);
    // socket.on('playerLeft', ...);
    // socket.on('playerReadyUpdate', ...);
    // socket.on('allPlayersResetReady', ...);
    // socket.on('invalidPlay', ...);
    // socket.on('gameOver', ...);
    // socket.on('gameStartFailed', ...);
    // socket.on('playerStartedSpeaking', ...);
    // socket.on('playerStoppedSpeaking', ...);
    // socket.on('receiveVoiceMessage', ...);


    // --- Auth Element Event Listeners (保持不变) ---
    // if (showRegisterLink) ...
    // if (showLoginLink) ...
    // if (loginButton) ...
    // if (registerButton) ...

    // --- Lobby Element Event Listeners (保持不变) ---
    // if (createRoomButton) ...
    // if (refreshRoomListButton) ...
    // if (logoutButtonLobby) ...

    // --- Game Element Event Listeners ---
    if (readyButton) { readyButton.addEventListener('click', () => { /* ... (保持不变) ... */ }); }
    if (aiToggleButton) { aiToggleButton.addEventListener('click', () => { /* ... (保持不变) ... */ }); }
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', handleLeaveRoomAndReturnToLobby);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', handleLeaveRoomAndReturnToLobby);

    if (playButton) {
        playButton.addEventListener('click', () => {
            if (selectedCardsForPlay.length === 0) {
                alert('请选择要出的牌');
                return;
            }
            // 增加日志，查看点击出牌时的状态
            console.log("[CLIENT] Play button clicked. Selected cards:", selectedCardsForPlay.map(c => cardObjectToKey(c)).join(','));
            console.log("[CLIENT] Current room state for play button check:", currentRoomState); // 打印当前房间状态

            // 检查是否轮到当前玩家出牌
            const myPlayerInState = currentRoomState && currentRoomState.players ? currentRoomState.players.find(p => p.userId === myUserId) : null;
            if (!myPlayerInState || myPlayerInState.userId !== currentRoomState.currentPlayerId || isAi托管激活 || myPlayerInState.finished) {
                alert('现在不能出牌（非当前回合、AI托管或已出完）。');
                console.warn(`[CLIENT] Play attempt rejected. My turn: ${myPlayerInState && myPlayerInState.userId === currentRoomState.currentPlayerId}, AI: ${isAi托管激活}, Finished: ${myPlayerInState && myPlayerInState.finished}`);
                return;
            }

            socket.emit('playCard', selectedCardsForPlay, (res) => {
                if (res && res.success) {
                    selectedCardsForPlay = []; // 清空选择
                    currentHint = null;
                    currentHintIndexFromServer = 0;
                    // UI 更新将由 gameStateUpdate 处理
                } else {
                    alert(`出牌失败: ${res ? res.message : '未知错误'}`);
                }
            });
        });
    }

    if (passButton) { passButton.addEventListener('click', () => { console.log("[CLIENT] Passing turn."); clearSelectionAndHighlights(); socket.emit('passTurn', (res) => { if (res && !res.success) alert(`操作失败: ${res.message}`); }); }); }

    if (hintButton) {
        hintButton.addEventListener('click', () => {
            console.log("[CLIENT] Requesting hint.");
            clearSelectionAndHighlights();

            socket.emit('requestHint', currentHintIndexFromServer, (res) => {
                if (res.success && res.hint && res.hint.cards && res.hint.cards.length > 0) {
                    currentHint = res.hint.cards;
                    currentHintIndexFromServer = res.nextHintIndex || 0;
                    
                    selectedCardsForPlay = [...currentHint]; // 自动选择提示的牌
                    highlightHintedCards(currentHint, true); // 高亮并标记为selected

                    console.log("[CLIENT] Hint received and auto-selected cards:", selectedCardsForPlay.map(c=>cardObjectToKey(c)).join(','));
                    // 点击提示后，因为 selectedCardsForPlay 更新了，需要重新评估出牌按钮状态
                    updatePlayButtonState();
                } else {
                    alert(res.message || '没有可用的提示。');
                    currentHint = null;
                    currentHintIndexFromServer = 0;
                    highlightHintedCards([]);
                    updatePlayButtonState(); // 没有提示，也更新出牌按钮（可能变为禁用）
                }
            });
        });
    }

    // --- Core UI Update and Interaction Logic ---

    function displayGameState(state, animateHandOnDisplay = false) {
        // ... (大部分保持不变, 确保 myInfoInBar 和 opponent UI 的 current-turn 类正确切换) ...
        if (!state) { console.warn("[DISPLAY] displayGameState called with null state."); if(myUserId)switchToView('lobby-view');else switchToView('auth-view'); return; }
        currentRoomState = state; // **非常重要：确保 currentRoomState 在这里被更新**
        const myPlayer = state.players ? state.players.find(p => p.userId === myUserId) : null;

        // ... (infoBar 更新) ...
        if (infoBarRoomName) infoBarRoomName.textContent = state.roomName || '未知房间';
        // ... (其他 infoBar 字段)

        // ... (myInfoInBar 更新) ...
        if (myInfoInBar && myPlayer) {
            myInfoInBar.classList.toggle('current-turn', state.status === 'playing' && state.currentPlayerId === myPlayer.userId && !state.gameFinished);
             // ... (其他 myInfoInBar 内容更新)
        } else if (myInfoInBar) {
            myInfoInBar.classList.remove('current-turn');
        }


        // ... (opponentSlotMap 和 updateOpponentUIElement 调用) ...
        const opponentSlotMap = {}; /* ... (您的 opponentSlotMap 逻辑) ... */
        if (myPlayer && state.players && state.players.length > 0) { const mySlot = myPlayer.slot; const numPlayers = state.players.filter(p=>p.connected).length > 1 ? state.players.filter(p=>p.connected).length : Math.max(2, state.players.length); const actualPlayers = state.players.filter(p => p.id !== myPlayer.id).sort((a,b) => (a.slot - mySlot + numPlayers) % numPlayers - (b.slot - mySlot + numPlayers) % numPlayers ); if (numPlayers === 2) { opponentSlotMap['top'] = actualPlayers[0]; } else if (numPlayers === 3) { opponentSlotMap['right'] = actualPlayers[0]; opponentSlotMap['left'] = actualPlayers[1]; } else if (numPlayers >= 4) { opponentSlotMap['right'] = actualPlayers[0]; opponentSlotMap['top'] = actualPlayers[1]; opponentSlotMap['left'] = actualPlayers[2]; } }
        else if (!myPlayer && state.players && state.players.length > 0) { const sortedPlayers = [...state.players].sort((a,b)=>a.slot-b.slot); if(sortedPlayers[0]) opponentSlotMap['self_substitute_UI_at_bottom'] = sortedPlayers[0]; if(sortedPlayers[1]) opponentSlotMap['right'] = sortedPlayers[1]; if(sortedPlayers[2]) opponentSlotMap['top'] = sortedPlayers[2]; if(sortedPlayers[3]) opponentSlotMap['left'] = sortedPlayers[3]; }
        ['top', 'left', 'right'].forEach(pK => updateOpponentUIElement(document.getElementById(`player-${pK}`), opponentSlotMap[pK], state.currentPlayerId, state.gameFinished, state.status));


        isAi托管激活 = myPlayer ? !!myPlayer.isAiControlled : false;
        if (aiToggleButton) { /* ... (aiToggleButton 更新) ... */ }

        if (myPlayer) {
            updatePlayerHandUI(myPlayer.hand || [], state.status === 'playing' && state.currentPlayerId === myPlayer.userId && myPlayer.connected && !myPlayer.finished && !isAi托管激活, animateHandOnDisplay);
            // 更新按钮状态
            const isWaiting = state.status === 'waiting';
            const isPlaying = state.status === 'playing';
            // const canPlayerActManually = isPlaying && myPlayer.connected && !myPlayer.finished && !isAi托管激活; // 这个变量在下面 updatePlayButtonState 中使用

            if(readyButton) { /* ... (readyButton 更新) ... */ }
            const showGameplayButtons = isPlaying && myPlayer.connected && !myPlayer.finished;
            [hintButton, passButton, playButton, micButton, aiToggleButton].forEach(btn => { if(btn) btn.style.display = showGameplayButtons || (btn === readyButton && isWaiting) ? 'inline-block' : 'none'; });
            
            updatePlayButtonState(); // 调用统一的函数来更新出牌按钮状态

            if (passButton) passButton.disabled = !(isPlaying && myPlayer.connected && !myPlayer.finished && !isAi托管激活 && state.currentPlayerId === myPlayer.userId && !state.isFirstTurn && state.lastHandInfo && (!state.lastPlayerWhoPlayedId || state.lastPlayerWhoPlayedId !== myPlayer.userId));
            if (hintButton) hintButton.disabled = !(isPlaying && myPlayer.connected && !myPlayer.finished && !isAi托管激活 && state.currentPlayerId === myPlayer.userId);
            if (micButton) micButton.disabled = state.gameFinished || !myPlayer.connected;
            if (aiToggleButton) aiToggleButton.disabled = state.gameFinished || !myPlayer.connected || (state.status !== 'playing' && state.status !== 'waiting');

        } else { /* ... (玩家不存在时的UI清理) ... */ }
        // ... (gameOverOverlay 更新) ...
    }

    function updatePlayerHandUI(hCards, isMyTurnAndCanAct, animate = false) {
        if (!playerHandArea) return;
        playerHandArea.innerHTML = '';
        if (!hCards || hCards.length === 0) {
            updatePlayButtonState(); // 没有手牌，也更新出牌按钮状态（应为禁用）
            return;
        }

        hCards.forEach((cardData, idx) => {
            const cardDiv = createCardElement(cardData); // 确保这里 cardData.rank 和 suit 有效
            cardDiv.classList.add('my-card');
            if (animate) { /* ... (动画逻辑) ... */ }
            else { cardDiv.classList.add('card-in-hand', 'dealt'); }

            const cardKey = cardObjectToKey(cardData);
            if (selectedCardsForPlay.some(sc => cardObjectToKey(sc) === cardKey)) {
                cardDiv.classList.add('selected');
            }
            // 提示高亮现在由 highlightHintedCards 单独处理，或在选中时也应用提示（如果逻辑如此）
            // if (currentHint && currentHint.some(hc => cardObjectToKey(hc) === cardKey)) {
            //     cardDiv.classList.add('hinted');
            // }


            playerHandArea.appendChild(cardDiv);

            if (isMyTurnAndCanAct) {
                cardDiv.classList.add('selectable');
                cardDiv.addEventListener('click', () => {
                    console.log(`[CLIENT] Card clicked: ${cardObjectToKey(cardData)}`); // **增加点击日志**
                    toggleCardSelection(cardDiv, cardData);
                    if (currentHint) {
                        const clickedKey = cardObjectToKey(cardData);
                        const isPartOfHint = currentHint.some(hc => cardObjectToKey(hc) === clickedKey);
                        const currentSelectionMatchesHint = selectedCardsForPlay.length === currentHint.length &&
                                                        selectedCardsForPlay.every(sc => currentHint.some(hc => cardObjectToKey(hc) === cardObjectToKey(sc)));
                        if (!isPartOfHint || !currentSelectionMatchesHint) {
                            highlightHintedCards([], false); // 清除视觉提示
                            currentHint = null;
                            currentHintIndexFromServer = 0;
                        }
                    }
                });
            }
        });
        // 渲染完手牌后，如果 currentHint 存在，确保提示高亮正确
        if (currentHint) {
            highlightHintedCards(currentHint, selectedCardsForPlay.length > 0 && selectedCardsForPlay.every(sc => currentHint.some(hc => cardObjectToKey(hc) === cardObjectToKey(sc))));
        }
        updatePlayButtonState(); // 手牌渲染/更新后，也更新出牌按钮状态
    }

    function toggleCardSelection(cardDiv, cardData) {
        const cardKey = cardObjectToKey(cardData);
        const indexInSelection = selectedCardsForPlay.findIndex(c => cardObjectToKey(c) === cardKey);

        if (indexInSelection > -1) {
            selectedCardsForPlay.splice(indexInSelection, 1);
            cardDiv.classList.remove('selected');
            console.log(`[CLIENT] Card unselected: ${cardKey}. Remaining selection: ${selectedCardsForPlay.map(c=>cardObjectToKey(c)).join(',')}`);
        } else {
            selectedCardsForPlay.push(cardData);
            cardDiv.classList.add('selected');
            console.log(`[CLIENT] Card selected: ${cardKey}. Current selection: ${selectedCardsForPlay.map(c=>cardObjectToKey(c)).join(',')}`);
        }
        // **非常重要**: 每次选择变化后，都调用 updatePlayButtonState
        updatePlayButtonState();
    }

    // 统一更新出牌按钮状态的函数
    function updatePlayButtonState() {
        if (!playButton || !currentRoomState) return; // 元素或状态不存在则不操作

        const myPlayer = currentRoomState.players ? currentRoomState.players.find(p => p.userId === myUserId) : null;
        let BedingungenErfuellt = false; // 默认按钮禁用

        if (myPlayer && currentRoomState.status === 'playing' &&
            myPlayer.userId === currentRoomState.currentPlayerId &&
            myPlayer.connected && !myPlayer.finished && !isAi托管激活 &&
            selectedCardsForPlay.length > 0) {
            BedingungenErfuellt = true;
        }
        
        playButton.disabled = !BedingungenErfuellt;
        // console.log(`[CLIENT] Play button state updated. Disabled: ${playButton.disabled}. Conditions met: ${BedingungenErfuellt}`);
    }

    function clearSelectionAndHighlights() {
        if (!playerHandArea) return;
        playerHandArea.querySelectorAll('.my-card.selected').forEach(c => c.classList.remove('selected'));
        playerHandArea.querySelectorAll('.my-card.hinted').forEach(c => c.classList.remove('hinted'));
        selectedCardsForPlay = [];
        currentHint = null;
        // currentHintIndexFromServer = 0; // 通常在请求新提示或出牌后重置
        updatePlayButtonState(); // 清除选择后，更新出牌按钮（应为禁用）
        console.log("[CLIENT] Cleared card selections and highlights.");
    }

    function highlightHintedCards(hintedCardsArray, alsoSelectThem = false) {
        if (!playerHandArea) return;
        
        const hintedCardKeys = new Set((hintedCardsArray || []).map(cardObjectToKey).filter(k => k !== null));

        playerHandArea.querySelectorAll('.my-card').forEach(cardEl => {
            const cardElKey = cardObjectToKey(cardEl.dataset);

            // 应用/移除 hinted 类
            if (hintedCardKeys.has(cardElKey)) {
                cardEl.classList.add('hinted');
            } else {
                cardEl.classList.remove('hinted');
            }

            // 如果 alsoSelectThem 为 true，则根据 hintedCardsArray 更新 selected 类
            if (alsoSelectThem) {
                if (hintedCardKeys.has(cardElKey)) {
                    cardEl.classList.add('selected');
                } else {
                    cardEl.classList.remove('selected'); // 如果是“也选择它们”，则不在提示中的牌应该被取消选中
                }
            }
        });

        // 如果 alsoSelectThem 为 true，selectedCardsForPlay 数组已在 hintButton 回调中被更新
        // 这里只需要确保出牌按钮的状态与新的 selectedCardsForPlay 同步
        if (alsoSelectThem) {
            updatePlayButtonState();
        }
    }

    // ... (socket event listeners for auth, lobby, game state updates)
    // 这些事件处理器在收到服务器消息后会调用 displayGameState 或其他UI更新函数，
    // displayGameState 会调用 updatePlayerHandUI 和 updatePlayButtonState，
    // 从而确保UI与服务器状态同步。
    // 例如:
    socket.on('connect', () => { console.log('[SOCKET] Connected to server with ID:', socket.id); const lsUserId = localStorage.getItem('userId'); if (!myUserId && lsUserId && !initialReauthAttempted) { console.log("[SOCKET] Connect event: Attempting reauthenticate on fresh connect with stored ID."); initialReauthAttempted = true; socket.emit('reauthenticate', lsUserId, handleAuthResponse); } else if (myUserId) { console.log("[SOCKET] Socket reconnected, user was already logged in. Requesting sync data."); if (currentRoomId) { socket.emit('requestGameState', (state) => { if (state) { console.log("[SOCKET] Reconnected in room, received game state:", state); currentRoomState = state; displayGameState(state); } else { console.warn("[SOCKET] Reconnected in room, but failed to get game state. Returning to lobby."); currentRoomId = null; currentRoomState = null; switchToView('lobby-view'); socket.emit('listRooms', updateRoomList); } }); } else { console.log("[SOCKET] Reconnected in lobby, fetching room list."); switchToView('lobby-view'); socket.emit('listRooms', updateRoomList); } } else if (!initialReauthAttempted) { console.log("[SOCKET] Connect event: No active login or stored ID. Displaying auth view (initialReauthAttempted false)."); switchToView('auth-view'); initialReauthAttempted = true; } else { console.log("[SOCKET] Connect event: No active login, initial reauth already attempted/failed. Staying in auth view or current view if not loading."); if (loadingView.style.display !== 'none' && authView.style.display === 'none') { switchToView('auth-view');}} });
    socket.on('disconnect', (reason) => { console.log('[SOCKET] Disconnected from server:', reason); if (reason !== 'io client disconnect') { alert('与服务器断开连接: ' + reason + ". 请刷新页面或检查网络。"); } switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent='已断开连接...'; initialReauthAttempted = false; /* Allow reauth on next connect */ });
    socket.on('connect_error', (err) => { console.error('[SOCKET] Connection error:', err.message, err); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent=`连接错误: ${err.message}. 正在尝试重连...`; });
    socket.on('roomListUpdate', (rooms) => { console.log("[EVENT] roomListUpdate received:", rooms); updateRoomList(rooms); });
    socket.on('gameStarted', (gameState) => {  console.log('[EVENT] gameStarted received:', gameState); currentRoomState = gameState; displayGameState(gameState, true); switchToView('game-view'); const mp=gameState.players.find(p=>p.userId===myUserId); console.log("[CLIENT] Game started!" + (mp && mp.role ? ` Your role: ${mp.role}` : '')); });
    socket.on('gameStateUpdate', (gameState) => {  console.log('[EVENT] gameStateUpdate received:', gameState); currentRoomState = gameState; displayGameState(gameState, false); }); // 这是关键的同步点
    socket.on('playerJoined', (playerInfo) => {  console.log('[EVENT] playerJoined:', playerInfo); if (currentRoomState && currentRoomState.players) { const existingPlayer = currentRoomState.players.find(p => p.userId === playerInfo.userId); if (!existingPlayer) { currentRoomState.players.push(playerInfo); } else { Object.assign(existingPlayer, playerInfo); } displayGameState(currentRoomState); } });
    socket.on('playerLeft', ({userId, username}) => {  console.log(`[EVENT] playerLeft: User ${username} (ID: ${userId})`); if (currentRoomState && currentRoomState.players) { currentRoomState.players = currentRoomState.players.filter(p => p.userId !== userId); displayGameState(currentRoomState); } });
    socket.on('playerReadyUpdate', ({ userId, isReady }) => { console.log(`[EVENT] playerReadyUpdate: User ${userId} is ${isReady}`); if (currentRoomState && currentRoomState.players) { const player = currentRoomState.players.find(p => p.userId === userId); if (player) { player.isReady = isReady; updatePlayerReadyStatusUI(player.userId, isReady); if (userId === myUserId && readyButton) { readyButton.textContent = isReady ? "取消" : "准备"; readyButton.classList.toggle('cancel-ready', isReady); } } else { console.warn(`[EVENT] playerReadyUpdate: Player ${userId} not found.`); } } });
    socket.on('allPlayersResetReady', () => { console.log('[EVENT] allPlayersResetReady received.'); if (currentRoomState && currentRoomState.players) { currentRoomState.players.forEach(p => { p.isReady = false; updatePlayerReadyStatusUI(p.userId, false); }); if (myUserId && readyButton) { readyButton.textContent = "准备"; readyButton.classList.remove('cancel-ready'); } } });
    socket.on('invalidPlay', (data) => { console.warn('[EVENT] invalidPlay', data); alert(`无效操作: ${data.message}`); });
    socket.on('gameOver', (data) => { console.log('[EVENT] gameOver received:', data); currentRoomState = { ...(currentRoomState || {}), ...data, gameFinished: true, gameStarted: false, status: 'finished', currentPlayerId: null }; displayGameState(currentRoomState); });
    socket.on('gameStartFailed', (data) => { console.error('[EVENT] gameStartFailed received:', data); alert(`游戏开始失败: ${data.message}`); if (currentRoomState) currentRoomState.status = 'waiting'; /* Reset status */ displayGameState(currentRoomState);});
    socket.on('playerStartedSpeaking',({userId,username})=>{console.log(`[VOICE] ${username}(${userId}) started speaking`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.add('speaking');}});
    socket.on('playerStoppedSpeaking',({userId})=>{console.log(`[VOICE] Player ${userId} stopped speaking`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.remove('speaking');}});
    socket.on('receiveVoiceMessage',(data)=>{if(!data||!data.audioBlob){console.error("[VOICE] Received invalid voice message data from server:", data); return;}console.log('[VOICE] Voice message received from:',data.userId,"Type:",data.audioBlob.type,"Size:",data.audioBlob.size);const{userId,audioBlob}=data;if(!(audioBlob instanceof Blob)||audioBlob.size===0){console.error("[VOICE] Invalid audio Blob received:",audioBlob);return;}try{const aUrl=URL.createObjectURL(audioBlob);const aud=new Audio(aUrl);aud.play().catch(e=>console.error('[VOICE] Audio playback error:',e));aud.onended=()=>URL.revokeObjectURL(aUrl);aud.onerror=(e)=>{console.error(`[VOICE] Error playing audio from ${userId}:`,e);URL.revokeObjectURL(aUrl);};}catch(e){console.error("[VOICE] Error creating Object URL or playing audio:", e)}});

    if (showRegisterLink) showRegisterLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (loginForm) loginForm.style.display = 'none'; if (registerForm) registerForm.style.display = 'block'; });
    if (showLoginLink) showLoginLink.addEventListener('click', (e) => { e.preventDefault(); clearAuthError(); if (registerForm) registerForm.style.display = 'none'; if (loginForm) loginForm.style.display = 'block'; });
    if (loginButton) loginButton.addEventListener('click', () => { clearAuthError(); const phoneNumber = loginUsernameInput.value; const password = loginPasswordInput.value; if (!phoneNumber || !password) { showAuthError("手机号和密码不能为空。"); return; } console.log(`[AUTH] Attempting login for: ${phoneNumber}`); socket.emit('login', { phoneNumber, password }, handleAuthResponse); });
    if (registerButton) registerButton.addEventListener('click', () => { clearAuthError(); const phoneNumber = registerUsernameInput.value; const password = registerPasswordInput.value; if (!phoneNumber || password.length < 4) { showAuthError("手机号不能为空，密码至少4位。"); return; } console.log(`[AUTH] Attempting registration for: ${phoneNumber}`); socket.emit('register', { phoneNumber, password }, (response) => { alert(response.message); if (response.success) { if (loginForm) loginForm.style.display = 'block'; if (registerForm) registerForm.style.display = 'none'; loginUsernameInput.value = phoneNumber; loginPasswordInput.value = ""; loginPasswordInput.focus(); } else showAuthError(response.message); }); });
    if (createRoomButton) { createRoomButton.addEventListener('click', () => { const roomName = roomNameInput.value.trim(); const password = roomPasswordInput.value; if (!roomName) { alert('请输入房间名称'); return; } console.log(`[CLIENT] Attempting to create room: "${roomName}", password: "${password ? '******' : '无'}"`); socket.emit('createRoom', { roomName, password: password || null }, (response) => { console.log('[CLIENT] Create room response from server:', response); if (response && response.success) { currentRoomId = response.roomId; currentRoomState = response.roomState; displayGameState(response.roomState); switchToView('game-view'); console.log(`[CLIENT] Room "${roomName}" created successfully! ID: ${response.roomId}`); } else { alert(`创建房间失败: ${response ? response.message : '未知错误。'}`); } }); }); }
    if (refreshRoomListButton) refreshRoomListButton.addEventListener('click', () => { if(socket.connected) { console.log("[CLIENT] Refreshing room list..."); socket.emit('listRooms', updateRoomList); } else console.warn("Socket not connected for refresh room list."); });
    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => { socket.disconnect(); localStorage.removeItem('userId'); localStorage.removeItem('username'); myUserId=null;myUsername=null;currentRoomId=null;currentRoomState=null; if(loginUsernameInput) loginUsernameInput.value=''; if(loginPasswordInput) loginPasswordInput.value=''; if(registerUsernameInput) registerUsernameInput.value=''; if(registerPasswordInput) registerPasswordInput.value=''; switchToView('auth-view'); initialReauthAttempted=false; });

}); // END DOMContentLoaded
