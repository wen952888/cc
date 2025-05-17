// public/client.js
const socket = io({
    reconnectionAttempts: 5,
    reconnectionDelay: 3000
});

// --- 状态变量 ---
let currentView = 'loading';
let myUserId = null;
let myUsername = null;
let currentRoomId = null;
let currentGameState = null;
let previousGameState = null; // 用于检测特定变化
let isReadyForGame = false;
let selectedCards = [];
let currentSortMode = 'rank'; // 'rank' 或 'suit'
let currentHint = null; // { cards: [...], type: '...' }
let currentHintCycleIndex = 0;

// --- DOM 元素 (缓存以便频繁访问) ---
const loadingView = document.getElementById('loadingView');
const loginRegisterView = document.getElementById('loginRegisterView');
const lobbyView = document.getElementById('lobbyView');
const roomView = document.getElementById('roomView');
const gameOverOverlay = document.getElementById('gameOverOverlay');
const views = { loadingView, loginRegisterView, lobbyView, roomView, gameOverOverlay };

const regPhoneInput = document.getElementById('regPhone');
const regPasswordInput = document.getElementById('regPassword');
const registerButton = document.getElementById('registerButton');
const loginPhoneInput = document.getElementById('loginPhone');
const loginPasswordInput = document.getElementById('loginPassword');
const loginButton = document.getElementById('loginButton');
const authMessage = document.getElementById('authMessage');

const logoutButton = document.getElementById('logoutButton');
const lobbyUsername = document.getElementById('lobbyUsername');
const createRoomNameInput = document.getElementById('createRoomName');
const createRoomPasswordInput = document.getElementById('createRoomPassword');
const createRoomButton = document.getElementById('createRoomButton');
const roomListEl = document.getElementById('roomList');
const lobbyMessage = document.getElementById('lobbyMessage');

const centerPileArea = document.getElementById('centerPileArea');
const lastHandTypeDisplay = document.getElementById('lastHandTypeDisplay');
const playSelectedCardsButton = document.getElementById('playSelectedCardsButton');
const passTurnButton = document.getElementById('passTurnButton');
const hintButton = document.getElementById('hintButton');
const sortHandButton = document.getElementById('sortHandButton');
const gameStatusDisplay = document.getElementById('gameStatusDisplay');

const playerAreas = { // 映射相对位置到DOM元素
    0: document.getElementById('playerAreaBottom'), // 自己
    1: document.getElementById('playerAreaLeft'),   // 自己左边的对手 (逆时针顺序的下一个玩家)
    2: document.getElementById('playerAreaTop'),    // 对面的对手 (伙伴或第二个对手)
    3: document.getElementById('playerAreaRight')   // 自己右边的对手 (逆时针顺序的上一个玩家)
};

const gameOverTitle = document.getElementById('gameOverTitle');
const gameOverReason = document.getElementById('gameOverReason');
const gameOverScores = document.getElementById('gameOverScores');
const backToLobbyButton = document.getElementById('backToLobbyButton');

const ALARM_ICON_SRC = '/images/alarm-icon.svg';
const AVATAR_PATHS = [
    '/images/avatar-slot-0.png',
    '/images/avatar-slot-1.png',
    '/images/avatar-slot-2.png',
    '/images/avatar-slot-3.png',
];

// --- 工具函数 ---
function showView(viewName) {
    console.log(`[VIEW] 视图切换: 从 ${currentView} 到 ${viewName}`);
    currentView = viewName;
    for (const key in views) {
        if (views[key]) {
            views[key].classList.add('hidden-view');
            views[key].classList.remove('view-block', 'view-flex');
        }
    }
    const targetView = views[viewName];
    if (targetView) {
        targetView.classList.remove('hidden-view');
        if (viewName === 'roomView' || viewName === 'gameOverOverlay') {
            targetView.classList.add('view-flex');
        } else {
            targetView.classList.add('view-block');
        }
    } else {
        console.warn(`[VIEW] 视图元素未找到: ${viewName}`);
    }
    const allowScroll = (viewName === 'loginRegisterView' || viewName === 'lobbyView');
    document.documentElement.style.overflow = allowScroll ? '' : 'hidden';
    document.body.style.overflow = allowScroll ? '' : 'hidden';

    clearMessages();
    if (viewName !== 'roomView' && viewName !== 'gameOverOverlay') {
        selectedCards = [];
        currentHint = null;
        currentHintCycleIndex = 0;
        if (currentView !== 'gameOverOverlay') {
            currentGameState = null;
            previousGameState = null;
        }
    }
}
function displayMessage(element, message, isError = false, isSuccess = false) { if (element) { element.textContent = message; element.classList.remove('error', 'success', 'message'); if (isError) element.classList.add('error'); else if (isSuccess) element.classList.add('success'); else if (element.id !== 'gameStatusDisplay' && message.trim() !== '') element.classList.add('message'); } }
function clearMessages() { [authMessage, lobbyMessage].forEach(el => { if (el) { el.textContent = ''; el.classList.remove('error', 'success', 'message'); } }); }
const RANK_ORDER_CLIENT = ["4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2", "3"];
const RANK_VALUES_CLIENT = {}; RANK_ORDER_CLIENT.forEach((r, i) => RANK_VALUES_CLIENT[r] = i);
const SUIT_ORDER_CLIENT = ["D", "C", "H", "S"];
const SUIT_VALUES_CLIENT = {}; SUIT_ORDER_CLIENT.forEach((s, i) => SUIT_VALUES_CLIENT[s] = i);
function compareSingleCardsClient(cardA, cardB) { const rankValueA = RANK_VALUES_CLIENT[cardA.rank]; const rankValueB = RANK_VALUES_CLIENT[cardB.rank]; if (rankValueA !== rankValueB) return rankValueA - rankValueB; return SUIT_VALUES_CLIENT[cardA.suit] - SUIT_VALUES_CLIENT[cardB.suit]; }
function compareBySuitThenRank(cardA, cardB) { const suitValueA = SUIT_VALUES_CLIENT[cardA.suit]; const suitValueB = SUIT_VALUES_CLIENT[cardB.suit]; if (suitValueA !== suitValueB) return suitValueA - suitValueB; return RANK_VALUES_CLIENT[cardA.rank] - RANK_VALUES_CLIENT[cardB.rank]; }

// --- 渲染函数 ---
function updateRoomControls(state) {
    if (!state || !myUserId) return;
    const myPlayerInState = state.players.find(p => p.userId === myUserId);
    if (!myPlayerInState) return;

    const readyButtonInstance = document.getElementById('readyButton');
    if (readyButtonInstance) {
        if (state.status === 'waiting') {
            readyButtonInstance.classList.remove('hidden-view');
            readyButtonInstance.textContent = myPlayerInState.isReady ? '取消准备' : '准备';
            readyButtonInstance.classList.toggle('ready', myPlayerInState.isReady);
            readyButtonInstance.disabled = false;
        } else {
            readyButtonInstance.classList.add('hidden-view');
        }
    }

    const actionsContainers = document.querySelectorAll('#playerAreaBottom .my-actions-container');
    if (actionsContainers.length > 0) {
        const isMyTurnAndCanPlay = state.status === 'playing' && state.currentPlayerId === myUserId && !myPlayerInState.finished;
        actionsContainers.forEach(ac => ac.classList.toggle('hidden-view', !isMyTurnAndCanPlay));

        if (isMyTurnAndCanPlay) {
            if(playSelectedCardsButton) playSelectedCardsButton.disabled = selectedCards.length === 0;
            if(passTurnButton) {
                let disablePass = false;
                if (state.isFirstTurn && myPlayerInState.hand && myPlayerInState.hand.some(c=>c.rank==='4'&&c.suit==='D')) {
                    disablePass = true; 
                } else if ((!state.lastHandInfo || (state.lastHandInfo && state.lastPlayerWhoPlayedId === myUserId)) && state.currentPlayerId === myUserId) {
                    if(!(state.isFirstTurn && myPlayerInState.hand && myPlayerInState.hand.some(c=>c.rank==='4'&&c.suit==='D'))) { 
                        disablePass = true;
                    }
                }
                passTurnButton.disabled = disablePass;
            }
            if(hintButton) hintButton.disabled = false;
            if(sortHandButton) sortHandButton.disabled = false;
        }
    }
}
function renderRoomList(rooms) { if (!roomListEl) { console.error("CLIENT: roomList DOM 元素 (roomListEl) 未找到!"); return; } roomListEl.innerHTML = ''; if (!Array.isArray(rooms)) { console.error("CLIENT: rooms 数据不是数组!", rooms); roomListEl.innerHTML = '<p>获取房间列表失败 (数据格式错误)。</p>'; return; } if (rooms.length === 0) { roomListEl.innerHTML = '<p>当前没有房间。</p>'; return; } rooms.forEach(room => { const item = document.createElement('div'); item.classList.add('room-item'); const nameSpan = document.createElement('span'); nameSpan.textContent = `${room.roomName} (${room.playerCount}/${room.maxPlayers})`; item.appendChild(nameSpan); const statusSpan = document.createElement('span'); statusSpan.textContent = `状态: ${room.status === 'waiting' ? '等待中' : (room.status === 'playing' ? '游戏中' : '已结束')}`; statusSpan.classList.add(`status-${room.status}`); item.appendChild(statusSpan); if (room.hasPassword) { const passwordSpan = document.createElement('span'); passwordSpan.textContent = '🔒'; item.appendChild(passwordSpan); } const joinButton = document.createElement('button'); joinButton.textContent = '加入'; joinButton.disabled = room.status !== 'waiting' || room.playerCount >= room.maxPlayers; joinButton.onclick = () => joinRoom(room.roomId, room.hasPassword); item.appendChild(joinButton); roomListEl.appendChild(item); }); }
function updateGameInfoBarDOM(state) { const gameInfoBar = document.getElementById('gameInfoBar'); if (gameInfoBar) { const roomNameIdEl = gameInfoBar.querySelector('.room-name-id'); if (roomNameIdEl) { roomNameIdEl.innerHTML = ` <span class="room-name">${state.roomName || '房间'}</span> <span class="room-id">ID: ${state.roomId || 'N/A'}</span> `; } } }
function updateGameStatusDisplayDOM(state) { if (gameStatusDisplay) { let messageText = ''; if (state.status === 'waiting') { const numPlayers = state.players.filter(p => p.connected).length; const maxPlayers = 4; messageText = `等待 ${numPlayers}/${maxPlayers} 位玩家准备...`; } else if (state.status === 'playing') { const currentPlayer = state.players.find(p => p.userId === state.currentPlayerId); messageText = currentPlayer ? (currentPlayer.userId === myUserId ? '轮到你出牌！' : `等待 ${currentPlayer.username} 出牌...`) : '游戏进行中...'; } else if (state.status === 'finished') { messageText = state.gameResultText || '游戏已结束'; } else { messageText = `状态: ${state.status}`; } if (gameStatusDisplay.textContent !== messageText && !gameStatusDisplay.classList.contains('error') && !gameStatusDisplay.classList.contains('success')) { displayMessage(gameStatusDisplay, messageText); } } }
function renderCenterPileDOM(state) { if (!centerPileArea) { console.error("CLIENT: centerPileArea DOM 元素未找到!"); return; } centerPileArea.innerHTML = ''; if (state.centerPile && Array.isArray(state.centerPile) && state.centerPile.length > 0) { state.centerPile.forEach(cardData => { const cardElement = renderCard(cardData, false, true); centerPileArea.appendChild(cardElement); }); } else { const placeholder = document.createElement('span'); placeholder.textContent = '- 等待出牌 -'; placeholder.style.color = '#aaa'; placeholder.style.fontSize = '0.9em'; centerPileArea.appendChild(placeholder); } if (lastHandTypeDisplay) { if (state.lastHandInfo && state.lastHandInfo.type) { let typeText = state.lastHandInfo.type; if (state.lastHandInfo.cards && state.lastHandInfo.cards.length > 0 && (typeText === 'single' || typeText === 'pair' || typeText === 'three_of_a_kind')) { if (state.lastHandInfo.representativeCard) { typeText += ` (${state.lastHandInfo.representativeCard.rank}${state.lastHandInfo.representativeCard.suit})`; } else { typeText += ` (${state.lastHandInfo.cards[0].rank}${state.lastHandInfo.cards[0].suit})`; } } lastHandTypeDisplay.textContent = `类型: ${typeText}`; } else if (state.isFirstTurn && !state.lastHandInfo && state.currentPlayerId === myUserId) { lastHandTypeDisplay.textContent = '请先出牌 (含方块4)'; } else { lastHandTypeDisplay.textContent = '新回合'; } } }

function renderRoomView(state) {
    if (!state || !roomView || !myUserId) { console.error("[DEBUG] RenderRoomView 中断: 无效参数。", {stateExists: !!state, roomViewExists: !!roomView, myUserIdExists: !!myUserId}); return; }
    previousGameState = currentGameState ? JSON.parse(JSON.stringify(currentGameState)) : null;
    currentGameState = state;

    const myHandContainer = document.getElementById('myHand');
    if (myHandContainer) { myHandContainer.innerHTML = ''; }
    updateGameInfoBarDOM(state);
    updateGameStatusDisplayDOM(state);
    Object.values(playerAreas).forEach(clearPlayerAreaDOM);

    const myPlayer = state.players.find(p => p.userId === myUserId);
    if (!myPlayer) { console.error("[DEBUG] 我的玩家数据在游戏状态中未找到!", state.players); handleReturnToLobby(); return; }
    isReadyForGame = myPlayer.isReady;
    const myAbsoluteSlot = myPlayer.slot;

    state.players.forEach(player => {
        const isMe = player.userId === myUserId;
        let relativeSlot = (player.slot - myAbsoluteSlot + state.players.length) % state.players.length;
        const targetArea = playerAreas[relativeSlot];

        if (targetArea) {
            renderPlayerArea(targetArea, player, isMe, state, player.slot);
        } else {
            console.warn(`[DEBUG] 相对位置 ${relativeSlot} (玩家: ${player.username}, 位置: ${player.slot}) 没有对应的区域`);
        }
    });
    renderCenterPileDOM(state);
    updateRoomControls(state);
    if (state.status === 'playing' && (state.currentPlayerId !== myUserId || myPlayer.finished)) {
      clearHintsAndSelection(true);
    } else if (state.status !== 'playing'){
        clearHintsAndSelection(true);
    }
}

function clearPlayerAreaDOM(area) { if (!area) { return; } const avatarEl = area.querySelector('.player-avatar'); const nameEl = area.querySelector('.playerName'); const roleEl = area.querySelector('.playerRole'); const infoEl = area.querySelector('.playerInfo'); const cardsEl = area.querySelector('.playerCards'); const handCountEl = area.querySelector('.hand-count-display'); if (avatarEl) { avatarEl.innerHTML = ''; avatarEl.style.backgroundImage = ''; avatarEl.classList.remove('current-turn');} if (nameEl) nameEl.textContent = (area.id === 'playerAreaBottom' && myUsername) ? myUsername + ' (你)' : '空位'; if (roleEl) roleEl.textContent = '[?]'; if (infoEl) infoEl.innerHTML = '总分: 0'; if (cardsEl) { cardsEl.innerHTML = '<span style="color:#888; font-style:italic;">- 等待 -</span>'; } if (handCountEl) handCountEl.remove(); if (area.id === 'playerAreaBottom') { const actionsContainers = area.querySelectorAll('.my-actions-container'); actionsContainers.forEach(ac => ac.classList.add('hidden-view')); const readyBtn = area.querySelector('#readyButton'); if (readyBtn) readyBtn.classList.add('hidden-view'); } }
function renderPlayerArea(container, playerData, isMe, state, absoluteSlot) { const avatarEl = container.querySelector('.player-avatar'); const nameEl = container.querySelector('.playerName'); const roleEl = container.querySelector('.playerRole'); const infoEl = container.querySelector('.playerInfo'); const cardsEl = container.querySelector('.playerCards'); if (!playerData || !playerData.userId) { clearPlayerAreaDOM(container); return; } if (avatarEl) { avatarEl.innerHTML = ''; avatarEl.style.backgroundImage = `url('${AVATAR_PATHS[absoluteSlot % AVATAR_PATHS.length]}')`; avatarEl.classList.remove('current-turn'); if (state.status === 'playing' && playerData.userId === state.currentPlayerId && !playerData.finished) { avatarEl.classList.add('current-turn'); const alarmImg = document.createElement('img'); alarmImg.src = ALARM_ICON_SRC; alarmImg.alt = '出牌提示'; alarmImg.classList.add('alarm-icon'); avatarEl.appendChild(alarmImg); avatarEl.style.backgroundImage = 'none'; } } if (nameEl) nameEl.textContent = playerData.username + (isMe ? ' (你)' : ''); if (roleEl) roleEl.textContent = playerData.role ? `[${playerData.role}]` : '[?]'; if (infoEl) { let infoText = `总分: ${playerData.score || 0}`; if (state.status === 'waiting' && !isMe) { infoText += playerData.isReady ? ' <span class="ready">[已准备]</span>' : ' <span class="not-ready">[未准备]</span>'; } else if (playerData.finished) { infoText += ' <span class="finished">[已完成]</span>'; } else if (!playerData.connected && state.status !== 'waiting') { infoText += ' <span class="disconnected">[已断线]</span>'; } infoEl.innerHTML = infoText; } if (cardsEl) renderPlayerCards(cardsEl, playerData, isMe, state.status === 'playing' && state.currentPlayerId === myUserId && !playerData.finished); }
function fanCards(cardContainer, cardElements, areaId) { const numCards = cardElements.length; if (numCards === 0 || areaId === 'playerAreaBottom') { if (areaId === 'playerAreaBottom') { cardElements.forEach((card, i) => { card.style.zIndex = i; card.style.transform = ''; card.style.left = ''; card.style.top = ''; card.style.position = ''; }); } return; } const offsetXPerCard = 1; const offsetYPerCard = 1; const maxVisibleStackedCards = Math.min(numCards, 5); cardElements.forEach((card, i) => { let currentOffsetX = 0; let currentOffsetY = 0; if (i < maxVisibleStackedCards) { currentOffsetX = i * offsetXPerCard; currentOffsetY = i * offsetYPerCard; } else { currentOffsetX = (maxVisibleStackedCards - 1) * offsetXPerCard; currentOffsetY = (maxVisibleStackedCards - 1) * offsetYPerCard; } card.style.transform = `translate(${currentOffsetX}px, ${currentOffsetY}px)`; card.style.zIndex = i; card.style.opacity = (i < maxVisibleStackedCards) ? '1' : '0'; }); }
function getCardImageFilename(cardData) { if (!cardData || typeof cardData.rank !== 'string' || typeof cardData.suit !== 'string') { console.error("获取卡牌图片文件名时数据无效:", cardData); return null; } let rankStr = cardData.rank.toLowerCase(); if (rankStr === 't') rankStr = '10'; else if (rankStr === 'j') rankStr = 'jack'; else if (rankStr === 'q') rankStr = 'queen'; else if (rankStr === 'k') rankStr = 'king'; else if (rankStr === 'a') rankStr = 'ace'; let suitStr = ''; switch (cardData.suit.toUpperCase()) { case 'S': suitStr = 'spades'; break; case 'H': suitStr = 'hearts'; break; case 'D': suitStr = 'diamonds'; break; case 'C': suitStr = 'clubs'; break; default: console.warn("卡牌图片花色无效:", cardData.suit); return null; } return `${rankStr}_of_${suitStr}.png`; }
function renderCard(cardData, isHidden, isCenterPileCard = false) { const cardDiv = document.createElement('div'); cardDiv.classList.add('card'); if (isHidden || !cardData) { cardDiv.classList.add('hidden'); } else { cardDiv.classList.add('visible'); const filename = getCardImageFilename(cardData); if (filename) { cardDiv.style.backgroundImage = `url('/images/cards/${filename}')`; cardDiv.dataset.suit = cardData.suit; cardDiv.dataset.rank = cardData.rank; } else { cardDiv.textContent = `${cardData.rank}${cardData.suit}`; cardDiv.style.textAlign = 'center'; cardDiv.style.lineHeight = '140px'; console.error("生成卡牌图片文件名失败:", cardData, "使用文本备用。"); } } return cardDiv; }

function renderPlayerCards(containerParam, playerData, isMe, isMyTurnAndCanPlay) {
    let targetContainer;
    if (isMe) {
        targetContainer = document.getElementById('myHand');
        if (!targetContainer) { console.error("[DEBUG] renderPlayerCards: #myHand 未找到!"); return; }
    }  else {
        targetContainer = containerParam;
        if (!targetContainer) { console.error(`[DEBUG] renderPlayerCards 对手 (${playerData.username}): 传入的容器为null。`); return; }
    }
    // **确保在渲染前彻底清空目标容器**
    targetContainer.innerHTML = '';

    const cardElements = [];
    if (isMe) {
        let handToRender = [];
        if (playerData && Array.isArray(playerData.hand)) {
            handToRender = [...playerData.hand];
        } else if (playerData && playerData.hand === undefined && playerData.handCount > 0 && !playerData.finished) {
            // 手牌数组缺失，但手牌数量大于0，这是一个不一致的状态，可能在等待完整状态
            console.warn(`[renderPlayerCards] 渲染自己手牌: hand 数组缺失, 但 handCount 是 ${playerData.handCount}.`);
            targetContainer.innerHTML = `<span style="color:#cc0000; font-style:italic;">手牌同步中 (${playerData.handCount} 张)...</span>`;
            return; // 停止进一步渲染，等待状态同步
        } else if (playerData && !playerData.finished) {
             console.warn(`[RenderPlayerCards] 我的手牌不是数组 (用户: ${playerData.username}, 完成状态: ${playerData.finished}). 渲染为空.`);
        }


        if (playerData.finished) { targetContainer.innerHTML = '<span style="color:#888; font-style:italic;">已出完</span>'; }
        else if (handToRender.length === 0 && currentGameState && currentGameState.status === 'playing') { targetContainer.innerHTML = '<span style="color:#555; font-style:italic;">- 无手牌 -</span>'; }
        else if (handToRender.length === 0) { targetContainer.innerHTML = '<span style="color:#555; font-style:italic;">- 等待发牌 -</span>'; }
        else {
            if (currentSortMode === 'rank') handToRender.sort(compareSingleCardsClient);
            else handToRender.sort(compareBySuitThenRank);
            handToRender.forEach((cardData, index) => {
                const cardElement = renderCard(cardData, false, false);
                cardElement.style.zIndex = index;
                const isSelected = selectedCards.some(c => c.rank === cardData.rank && c.suit === cardData.suit);
                const isHinted = currentHint && currentHint.cards.some(c => c.rank === cardData.rank && c.suit === cardData.suit);
                if (isSelected) cardElement.classList.add('selected');
                if (isHinted && !isSelected) cardElement.classList.add('hinted');

                if (isMyTurnAndCanPlay) {
                    cardElement.onclick = () => toggleCardSelection(cardData, cardElement);
                } else {
                    cardElement.classList.add('disabled');
                }
                targetContainer.appendChild(cardElement);
            });
        }
    } else { // 对手手牌
        if (playerData.finished) { targetContainer.innerHTML = '<span style="color:#888; font-style:italic;">已出完</span>'; }
        else if (playerData.handCount > 0) {
            for (let i = 0; i < playerData.handCount; i++) {
                const cardElement = renderCard(null, true, false);
                targetContainer.appendChild(cardElement);
                cardElements.push(cardElement);
            }
            let handCountEl = targetContainer.closest('.playerArea')?.querySelector('.hand-count-display');
            if (!handCountEl) { handCountEl = document.createElement('div'); handCountEl.classList.add('hand-count-display'); const playerAreaEl = targetContainer.closest('.playerArea'); if (playerAreaEl) { playerAreaEl.appendChild(handCountEl); } }
            if (handCountEl) handCountEl.textContent = `${playerData.handCount} 张`;
        } else { targetContainer.innerHTML = '<span style="color:#555; font-style:italic;">- 等待 -</span>'; let handCountEl = targetContainer.closest('.playerArea')?.querySelector('.hand-count-display'); if (handCountEl) handCountEl.remove(); }
        if (cardElements.length > 0) { requestAnimationFrame(() => { fanCards(targetContainer, cardElements, targetContainer.closest('.playerArea')?.id); }); }
    }
}

// --- UI事件处理器 ---
function handleRegister() { const phone = regPhoneInput.value.trim(); const password = regPasswordInput.value; if (!phone || !password) { displayMessage(authMessage, '请输入手机号和密码。', true); return; } if (password.length < 4) { displayMessage(authMessage, '密码至少需要4位。', true); return; } registerButton.disabled = true; socket.emit('register', { phoneNumber: phone, password }, (response) => { registerButton.disabled = false; displayMessage(authMessage, response.message, !response.success, response.success); if (response.success) { regPhoneInput.value = ''; regPasswordInput.value = ''; } }); }
function handleLogin() { const phone = loginPhoneInput.value.trim(); const password = loginPasswordInput.value; if (!phone || !password) { displayMessage(authMessage, '请输入手机号和密码。', true); return; } loginButton.disabled = true; socket.emit('login', { phoneNumber: phone, password }, (response) => { loginButton.disabled = false; displayMessage(authMessage, response.message, !response.success, response.success); if (response.success) { myUserId = response.userId; myUsername = response.username; try { localStorage.setItem('kkUserId', myUserId); localStorage.setItem('kkUsername', myUsername); } catch (e) { console.warn('LocalStorage 保存用户会话时出错:', e); } if(lobbyUsername) lobbyUsername.textContent = myUsername; showView('lobbyView'); } }); }
function handleLogout() { console.log('正在登出...'); try { localStorage.removeItem('kkUserId'); localStorage.removeItem('kkUsername'); } catch (e) { console.warn('LocalStorage 移除用户会话时出错:', e); } myUserId = null; myUsername = null; currentRoomId = null; currentGameState = null; previousGameState = null; isReadyForGame = false; selectedCards = []; currentHint = null; currentHintCycleIndex = 0; if (socket.connected) { socket.disconnect(); } socket.connect(); showView('loginRegisterView'); if(loginPhoneInput) loginPhoneInput.value = ''; if(loginPasswordInput) loginPasswordInput.value = ''; }
function handleGameLeave() { if (!currentRoomId) { handleReturnToLobby(); return; } const actualLeaveButton = document.getElementById('leaveRoomButton'); if (actualLeaveButton) actualLeaveButton.disabled = true; socket.emit('leaveRoom', (response) => { if (actualLeaveButton) actualLeaveButton.disabled = false; if (response.success) { handleReturnToLobby(); } else { displayMessage(gameStatusDisplay || lobbyMessage, response.message || '离开房间失败。', true); } }); }
function handleCreateRoom() { const roomName = createRoomNameInput.value.trim(); const password = createRoomPasswordInput.value; if (!roomName) { displayMessage(lobbyMessage, '请输入房间名称。', true); return; } createRoomButton.disabled = true; socket.emit('createRoom', { roomName, password: password || null }, (response) => { createRoomButton.disabled = false; if (response.success) { currentRoomId = response.roomId; showView('roomView'); currentGameState = response.roomState; renderRoomView(response.roomState); } else { displayMessage(lobbyMessage, response.message, true); } }); }
function joinRoom(roomId, needsPassword) { let passwordToTry = null; if (needsPassword) { passwordToTry = prompt(`房间 "${roomId}" 受密码保护，请输入密码:`, ''); if (passwordToTry === null) return; } displayMessage(lobbyMessage, `正在加入房间 ${roomId}...`); socket.emit('joinRoom', { roomId, password: passwordToTry }, (response) => { if (response.success) { currentRoomId = response.roomId; showView('roomView'); currentGameState = response.roomState; renderRoomView(response.roomState); displayMessage(lobbyMessage, ''); } else { displayMessage(lobbyMessage, response.message, true); } }); }
function handleReadyClick() { if (!currentRoomId || !currentGameState) return; const actualReadyButton = document.getElementById('readyButton'); if (!actualReadyButton) {console.error("准备按钮未找到!"); return;} const desiredReadyState = !isReadyForGame; actualReadyButton.disabled = true; socket.emit('playerReady', desiredReadyState, (response) => { actualReadyButton.disabled = false; if (!response.success) { displayMessage(gameStatusDisplay, response.message || "无法改变准备状态。", true); } else { isReadyForGame = desiredReadyState; } }); }
function handleSortHand() { if (currentSortMode === 'rank') currentSortMode = 'suit'; else currentSortMode = 'rank'; if (currentGameState && currentView === 'roomView') { const myPlayer = currentGameState.players.find(p => p.userId === myUserId); if (myPlayer && myPlayer.hand) { const cardsEl = document.getElementById('myHand'); if (cardsEl) renderPlayerCards(cardsEl, myPlayer, true, currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId && !myPlayer.finished); } } }

function toggleCardSelection(cardData, cardElement) {
    if (!cardElement || cardElement.classList.contains('disabled')) return;

    const index = selectedCards.findIndex(c => c.rank === cardData.rank && c.suit === cardData.suit);
    if (index > -1) {
        selectedCards.splice(index, 1);
        cardElement.classList.remove('selected');
    } else {
        selectedCards.push(cardData);
        cardElement.classList.add('selected');
    }
    if (cardElement.classList.contains('hinted') && cardElement.classList.contains('selected')) {
        cardElement.classList.remove('hinted');
    } else if (currentHint && currentHint.cards.some(c => c.rank === cardData.rank && c.suit === cardData.suit) && !cardElement.classList.contains('selected')) {
        cardElement.classList.add('hinted');
    }

    if (playSelectedCardsButton && currentGameState && currentGameState.currentPlayerId === myUserId) {
        playSelectedCardsButton.disabled = selectedCards.length === 0;
    }
}

function handlePlaySelectedCards() {
    if (selectedCards.length === 0) { displayMessage(gameStatusDisplay, '请先选择要出的牌。', true); return; }
    if (!currentRoomId || !currentGameState || currentGameState.status !== 'playing' || currentGameState.currentPlayerId !== myUserId) { displayMessage(gameStatusDisplay, '现在不是你的回合或状态无效。', true); return; }
    setGameActionButtonsDisabled(true);
    socket.emit('playCard', selectedCards, (response) => {
        if (!response.success) {
            displayMessage(gameStatusDisplay, response.message || '出牌失败。', true);
            if (currentGameState && currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId) {
                setGameActionButtonsDisabled(false);
                updateRoomControls(currentGameState);
            }
        } else {
            // 出牌成功后，立即在本地更新手牌状态（移除已打出的牌）
            // 服务器的 gameStateUpdate 会稍后到达并同步最终状态，但本地更新可以提供更快的反馈
            if (currentGameState) {
                const myPlayer = currentGameState.players.find(p => p.userId === myUserId);
                if (myPlayer && Array.isArray(myPlayer.hand)) {
                    const cardsPlayedSet = new Set(selectedCards.map(c => `${c.rank}${c.suit}`));
                    myPlayer.hand = myPlayer.hand.filter(card => !cardsPlayedSet.has(`${card.rank}${card.suit}`));
                    // 注意：handCount 将由服务器的 gameStateUpdate 更新
                }
            }
            selectedCards = []; // 清空选择
            clearHintsAndSelection(true); // 清除提示和视觉选择
            // 等待服务器的 gameStateUpdate 来重新渲染并决定按钮状态
        }
    });
}
function handlePassTurn() { if (!currentRoomId || !currentGameState || currentGameState.status !== 'playing' || currentGameState.currentPlayerId !== myUserId) { displayMessage(gameStatusDisplay, '现在不是你的回合或状态无效。', true); return; } if (passTurnButton && passTurnButton.disabled) { displayMessage(gameStatusDisplay, '你必须出牌。', true); return; } setGameActionButtonsDisabled(true); selectedCards = []; socket.emit('passTurn', (response) => { if (!response.success) { displayMessage(gameStatusDisplay, response.message || 'Pass 失败。', true); if (currentGameState && currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId) { setGameActionButtonsDisabled(false); updateRoomControls(currentGameState); } } else { clearHintsAndSelection(true); } }); }
function handleHint() { if (!currentRoomId || !currentGameState || currentGameState.status !== 'playing' || currentGameState.currentPlayerId !== myUserId) { displayMessage(gameStatusDisplay, '现在不是你的回合或状态无效。', true); return; } setGameActionButtonsDisabled(true); socket.emit('requestHint', currentHintCycleIndex, (response) => { if (currentGameState && currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId) { setGameActionButtonsDisabled(false); updateRoomControls(currentGameState); } clearHintsAndSelection(false); if (response.success && response.hint && response.hint.cards) { displayMessage(gameStatusDisplay, '找到提示！(再点提示可尝试下一个)', false, true); currentHint = response.hint; currentHintCycleIndex = response.nextHintIndex; highlightHintedCards(currentHint.cards); } else { displayMessage(gameStatusDisplay, response.message || '没有可出的牌或无更多提示。', true); currentHint = null; currentHintCycleIndex = 0; } }); }
function setGameActionButtonsDisabled(disabled) { if (playSelectedCardsButton) playSelectedCardsButton.disabled = disabled; if (passTurnButton) passTurnButton.disabled = disabled; if (hintButton) hintButton.disabled = disabled; if (!disabled && currentGameState) { updateRoomControls(currentGameState); } }
function highlightHintedCards(hintedCardsArray) { if (!hintedCardsArray || hintedCardsArray.length === 0) return; const localMyHandArea = document.getElementById('myHand'); if (!localMyHandArea) return; const cardElements = localMyHandArea.querySelectorAll('.card.visible:not(.hidden)'); hintedCardsArray.forEach(hintCard => { for(const elem of cardElements) { if(elem.dataset.rank === hintCard.rank && elem.dataset.suit === hintCard.suit && !elem.classList.contains('selected')) { elem.classList.add('hinted'); break; } } }); }
function clearHintsAndSelection(resetSelectionAndCycle = true) { if (resetSelectionAndCycle) { currentHint = null; currentHintCycleIndex = 0; selectedCards = []; if(playSelectedCardsButton) playSelectedCardsButton.disabled = true; } const localMyHandArea = document.getElementById('myHand'); if (localMyHandArea) { const cardElements = localMyHandArea.querySelectorAll('.card'); cardElements.forEach(el => { el.classList.remove('hinted'); if (resetSelectionAndCycle) { el.classList.remove('selected'); } }); } }
function handleReturnToLobby() { console.log("返回大厅。"); currentRoomId = null; currentGameState = null; previousGameState = null; isReadyForGame = false; selectedCards = []; currentHint = null; currentHintCycleIndex = 0; if (gameOverOverlay && !gameOverOverlay.classList.contains('hidden-view')) { gameOverOverlay.classList.add('hidden-view'); gameOverOverlay.classList.remove('view-flex'); } showView('lobbyView'); socket.emit('listRooms', (rooms) => { renderRoomList(rooms); }); }
function showGameOver(resultData) {
    if (!resultData) { console.warn("showGameOver 被调用但无数据, 如有则使用 currentGameState。"); resultData = currentGameState || {}; }

    gameOverTitle.textContent = resultData.result || resultData.gameResultText || "游戏结束!";
    gameOverReason.textContent = resultData.reason || resultData.gameOverReason || (resultData.result ? '' : "游戏正常结束。");
    gameOverScores.innerHTML = '';

    const playersToDisplay = resultData.finalScores || currentGameState?.players || [];
    if (playersToDisplay.length > 0) {
        playersToDisplay.forEach(playerData => {
            const p = document.createElement('p');
            let scoreText = `${playerData.name} (${playerData.role || '?'})`;
            if (resultData.scoreChanges && resultData.scoreChanges[playerData.id] !== undefined) {
                const change = resultData.scoreChanges[playerData.id];
                const changeDisplay = change > 0 ? `+${change}` : (change < 0 ? `${change}` : '0');
                const changeClass = change > 0 ? 'score-plus' : (change < 0 ? 'score-minus' : 'score-zero');
                scoreText += ` : <span class="${changeClass}">${changeDisplay}</span>`;
            }
            scoreText += ` (总分: ${playerData.score})`;
            p.innerHTML = scoreText;
            gameOverScores.appendChild(p);
        });
    } else {
        gameOverScores.innerHTML = '<p>无法加载得分详情。</p>';
    }
    showView('gameOverOverlay');
}

// --- Socket 事件处理器 ---
socket.on('connect', () => { console.log('[NET] 已连接到服务器! Socket ID:', socket.id); if (gameOverOverlay && !gameOverOverlay.classList.contains('hidden-view')) { gameOverOverlay.classList.add('hidden-view'); gameOverOverlay.classList.remove('view-flex'); } initClientSession(); });
socket.on('disconnect', (reason) => { console.log('[NET] 与服务器断开连接:', reason); if (currentView !== 'loginRegisterView' && currentView !== 'loadingView') { showView('loadingView'); displayMessage(loadingView.querySelector('p'), `与服务器断开连接: ${reason}. 正在尝试重连...`, true); } });
socket.on('connect_error', (err) => { console.error('[NET] 连接错误:', err.message); if (currentView !== 'loginRegisterView' && currentView !== 'loadingView') { showView('loadingView'); displayMessage(loadingView.querySelector('p'), `连接错误: ${err.message}. 请检查网络并刷新。`, true); } });
socket.on('roomListUpdate', (rooms) => { if (currentView === 'lobbyView') { renderRoomList(rooms); } });
socket.on('playerReadyUpdate', ({ userId, isReady }) => { if (currentGameState && currentView === 'roomView') { const player = currentGameState.players.find(p => p.userId === userId); if (player) { player.isReady = isReady; if (userId === myUserId) isReadyForGame = isReady; } renderRoomView(currentGameState); } });
socket.on('playerJoined', (newPlayerInfo) => { if (currentView === 'roomView' && currentGameState) { const existingPlayer = currentGameState.players.find(p => p.userId === newPlayerInfo.userId); if (existingPlayer) { Object.assign(existingPlayer, newPlayerInfo, {connected: true});} else { currentGameState.players.push({ ...newPlayerInfo, score:0, hand:undefined, handCount:0, role:null, finished:false, connected:true }); currentGameState.players.sort((a,b) => a.slot - b.slot); } renderRoomView(currentGameState); displayMessage(gameStatusDisplay, `${newPlayerInfo.username} 加入了房间。`, false, true); } else if (currentView === 'roomView' && !currentGameState) { socket.emit('requestGameState', (state) => { if(state) { currentGameState = state; renderRoomView(state); } }); } });
socket.on('playerLeft', ({ userId, username, reason }) => { if (currentGameState && currentView === 'roomView') { const playerIdx = currentGameState.players.findIndex(p => p.userId === userId); if (playerIdx > -1) { currentGameState.players[playerIdx].connected = false; currentGameState.players[playerIdx].isReady = false; } renderRoomView(currentGameState); displayMessage(gameStatusDisplay, `${username} ${reason === 'disconnected' ? '断线了' : '离开了房间'}。`, true); } });
socket.on('playerReconnected', (reconnectedPlayerInfo) => { if (currentView === 'roomView' && currentGameState) { const player = currentGameState.players.find(p => p.userId === reconnectedPlayerInfo.userId); if (player) { Object.assign(player, reconnectedPlayerInfo, {connected: true});} else { currentGameState.players.push({ ...reconnectedPlayerInfo, score:0, hand:undefined, handCount:0, role:null, finished:false, connected:true }); currentGameState.players.sort((a,b) => a.slot - b.slot); } renderRoomView(currentGameState); displayMessage(gameStatusDisplay, `${reconnectedPlayerInfo.username} 重新连接。`, false, true); } else if (currentView === 'roomView' && !currentGameState) { socket.emit('requestGameState', (state) => { if(state) { currentGameState = state; renderRoomView(state); } }); } });

socket.on('gameStarted', (initialGameState) => {
    if (currentView !== 'roomView' || currentRoomId !== initialGameState.roomId) { return; }
    currentGameState = initialGameState;
    if (gameStatusDisplay) displayMessage(gameStatusDisplay, '游戏开始！祝你好运！', false, true);
    selectedCards = [];
    clearHintsAndSelection(true);
    renderRoomView(currentGameState);
});

socket.on('gameStateUpdate', (newState) => {
    if (currentView !== 'roomView' || !currentRoomId || currentRoomId !== newState.roomId) { return; }

    const myOldPlayerState = currentGameState ? currentGameState.players.find(p => p.userId === myUserId) : null;
    const myOldHand = myOldPlayerState?.hand;

    previousGameState = currentGameState ? JSON.parse(JSON.stringify(currentGameState)) : null;
    currentGameState = newState;

    const myNewPlayerState = currentGameState.players.find(p => p.userId === myUserId);

    if (myNewPlayerState) {
        // 如果服务器发送了手牌数据 (通常在游戏开始或完整状态请求后)，则直接使用
        if (Array.isArray(myNewPlayerState.hand)) {
            // 服务器提供了手牌，这是最权威的
        } else if (myNewPlayerState.finished || myNewPlayerState.handCount === 0) {
            // 如果玩家已结束或手牌数为0，手牌应为空数组
            myNewPlayerState.hand = [];
        } else if (myOldHand && myOldPlayerState && myOldPlayerState.handCount !== myNewPlayerState.handCount) {
            // 我的手牌数量改变了 (很可能是我出牌了)，但服务器没有发送新的手牌数组
            // 此时，我们依赖于 handlePlaySelectedCards 中对本地 currentGameState.myPlayer.hand 的即时更新
            // 如果 newState 中的 hand 为 undefined，我们尝试保留之前本地更新过的手牌
            if (myNewPlayerState.hand === undefined && myOldHand && myNewPlayerState.handCount > 0) {
                console.log("[gameStateUpdate] 手牌数量已变，服务器未发送手牌。尝试保留本地修改的手牌。");
                myNewPlayerState.hand = myOldHand;
            } else if (myNewPlayerState.hand === undefined && myNewPlayerState.handCount > 0) {
                // 如果没有旧的本地手牌信息，这是一个不一致的状态，请求完整状态
                console.warn("[gameStateUpdate] 手牌数量 > 0，但本地无旧手牌且服务器未发送手牌。请求完整状态。");
                socket.emit('requestGameState', (fullState) => { if(fullState) { currentGameState = fullState; renderRoomView(currentGameState); }});
                return; // 避免使用可能不一致的数据渲染
            }
        } else if (myNewPlayerState.hand === undefined && Array.isArray(myOldHand) && !myNewPlayerState.finished) {
            // 手牌数量未变，服务器未发送手牌，保留本地手牌 (例如，其他玩家操作)
            myNewPlayerState.hand = myOldHand;
        }
    }

    if (previousGameState && currentGameState) { 
      const myTurnChangedToNotMyTurn = previousGameState.currentPlayerId === myUserId && currentGameState.currentPlayerId !== myUserId;
      const newRoundStartedForMe = !currentGameState.lastHandInfo && previousGameState.lastHandInfo && currentGameState.currentPlayerId === myUserId;
      const iPlayedLastAndNowNewRound = previousGameState.lastPlayerWhoPlayedId === myUserId && !currentGameState.lastHandInfo && currentGameState.currentPlayerId === myUserId;

      if (myTurnChangedToNotMyTurn || newRoundStartedForMe || iPlayedLastAndNowNewRound) {
          selectedCards = [];
          clearHintsAndSelection(true);
      }
    }
    renderRoomView(currentGameState);
});

socket.on('invalidPlay', ({ message }) => { if (gameStatusDisplay) displayMessage(gameStatusDisplay, `操作无效: ${message}`, true); if (currentGameState && currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId) { setGameActionButtonsDisabled(false); updateRoomControls(currentGameState); } });
socket.on('gameOver', (results) => { const targetRoomId = results?.roomId || currentGameState?.roomId; if (currentView === 'roomView' && currentRoomId === targetRoomId) { if (currentGameState) { currentGameState.status = 'finished'; if (results) { if(results.finalScores) currentGameState.finalScores = results.finalScores; if(results.scoreChanges) currentGameState.scoreChanges = results.scoreChanges; if(results.result) currentGameState.gameResultText = results.result; if(results.reason) currentGameState.gameOverReason = results.reason; } } showGameOver(results || currentGameState); } else { console.warn("收到 gameOver 事件，但房间不匹配。我的房间:", currentRoomId, "结果房间ID:", results?.roomId); } });
socket.on('gameStartFailed', ({ message }) => { if (currentView === 'roomView' && gameStatusDisplay) { displayMessage(gameStatusDisplay, `游戏开始失败: ${message}`, true); if (currentGameState) { currentGameState.players.forEach(p => p.isReady = false); isReadyForGame = false; renderRoomView(currentGameState); } } });
socket.on('allPlayersResetReady', () => { if (currentGameState && currentView === 'roomView' && currentGameState.status === 'waiting') { currentGameState.players.forEach(p => p.isReady = false); isReadyForGame = false; renderRoomView(currentGameState); if (gameStatusDisplay) displayMessage(gameStatusDisplay, '部分玩家状态变更，请重新准备。', true); } });

function initClientSession() {
    let storedUserId = null;
    try { storedUserId = localStorage.getItem('kkUserId'); }
    catch (e) { console.warn('[INIT] 访问 localStorage 出错:', e); showView('loginRegisterView'); return; }

    if (storedUserId) {
        showView('loadingView');
        displayMessage(loadingView.querySelector('p'), "正在重新连接...", false);
        socket.emit('reauthenticate', storedUserId, (response) => {
            if (response.success) {
                myUserId = response.userId;
                myUsername = response.username;
                if (lobbyUsername) lobbyUsername.textContent = myUsername;

                if (response.roomState) {
                    currentRoomId = response.roomState.roomId;
                    currentGameState = response.roomState;
                    if (currentGameState.status === 'finished') {
                        showView('roomView');
                        renderRoomView(currentGameState);
                        showGameOver(currentGameState);
                    } else {
                        showView('roomView');
                        renderRoomView(currentGameState);
                    }
                } else {
                    showView('lobbyView');
                }
            } else {
                console.warn(`[INIT] 重新认证失败: ${response.message}`);
                try { localStorage.removeItem('kkUserId'); localStorage.removeItem('kkUsername'); } catch (e) {}
                displayMessage(authMessage, response.message || "重新认证失败，请重新登录。", true);
                showView('loginRegisterView');
            }
        });
    } else {
        showView('loginRegisterView');
    }
}

function setupEventListeners() {
    if(registerButton) registerButton.addEventListener('click', handleRegister);
    if(loginButton) loginButton.addEventListener('click', handleLogin);
    const lobbyLogoutBtnInstance = document.getElementById('logoutButton');
    if(lobbyLogoutBtnInstance) lobbyLogoutBtnInstance.addEventListener('click', handleLogout);
    if(createRoomButton) createRoomButton.addEventListener('click', handleCreateRoom);

    if (roomView) {
        roomView.addEventListener('click', function(event) {
            const buttonElement = event.target.closest('button');
            if (!buttonElement) return;
            const buttonId = buttonElement.id;
            if (currentView !== 'roomView' && currentView !== 'gameOverOverlay') return;
            if (currentView === 'gameOverOverlay' && buttonId !== 'backToLobbyButton') return;

            switch (buttonId) {
                case 'readyButton': handleReadyClick(); break;
                case 'leaveRoomButton': handleGameLeave(); break;
                case 'sortHandButton': handleSortHand(); break;
                case 'playSelectedCardsButton': handlePlaySelectedCards(); break;
                case 'passTurnButton': handlePassTurn(); break;
                case 'hintButton': handleHint(); break;
                case 'backToLobbyButton': handleReturnToLobby(); break;
            }
        });
    }
    regPasswordInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && registerButton && !registerButton.disabled) handleRegister(); });
    loginPasswordInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && loginButton && !loginButton.disabled) handleLogin(); });
    createRoomNameInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && createRoomButton && !createRoomButton.disabled) handleCreateRoom(); });
    createRoomPasswordInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && createRoomButton && !createRoomButton.disabled) handleCreateRoom(); });
}

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM 已加载。正在设置客户端...");
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    setupEventListeners();
    if (socket.connected) {
        initClientSession();
    } else {
        showView('loadingView');
    }
    console.log('客户端设置完成。');
});
