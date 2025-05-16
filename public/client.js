// public/client.js
const socket = io({
    reconnectionAttempts: 5,
    reconnectionDelay: 3000
});

// --- State Variables ---
let currentView = 'loading';
let myUserId = null;
let myUsername = null;
let currentRoomId = null;
let currentGameState = null;
let previousGameState = null;
let isReadyForGame = false;
let selectedCards = [];
let currentSortMode = 'rank';
let currentHint = null;
let currentHintCycleIndex = 0;

// --- DOM Elements (Cached for frequent access) ---
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

const playerAreas = {
    0: document.getElementById('playerAreaBottom'),
    1: document.getElementById('playerAreaLeft'),
    2: document.getElementById('playerAreaTop'),
    3: document.getElementById('playerAreaRight')
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

// --- Utility Functions ---
function showView(viewName) { console.log(`[VIEW] Switching from ${currentView} to: ${viewName}`); currentView = viewName; for (const key in views) { if (views[key]) { views[key].classList.add('hidden-view'); views[key].classList.remove('view-block', 'view-flex'); } } const targetView = views[viewName]; if (targetView) { targetView.classList.remove('hidden-view'); if (viewName === 'roomView' || viewName === 'gameOverOverlay') { targetView.classList.add('view-flex'); } else { targetView.classList.add('view-block'); } } else { console.warn(`[VIEW] View element not found: ${viewName}`); } const allowScroll = (viewName === 'loginRegisterView' || viewName === 'lobbyView'); document.documentElement.style.overflow = allowScroll ? '' : 'hidden'; document.body.style.overflow = allowScroll ? '' : 'hidden'; clearMessages(); if (viewName !== 'roomView' && viewName !== 'gameOverOverlay') { selectedCards = []; currentHint = null; currentHintCycleIndex = 0; if (currentView !== 'gameOverOverlay') {currentGameState = null; previousGameState = null;} } }
function displayMessage(element, message, isError = false, isSuccess = false) { if (element) { element.textContent = message; element.classList.remove('error', 'success', 'message'); if (isError) element.classList.add('error'); else if (isSuccess) element.classList.add('success'); else if (element.id !== 'gameStatusDisplay') element.classList.add('message'); } }
function clearMessages() { [authMessage, lobbyMessage].forEach(el => { if (el) { el.textContent = ''; el.classList.remove('error', 'success', 'message'); } }); }
function getSuitSymbol(suit) { switch (suit?.toUpperCase()) { case 'H': return '♥'; case 'D': return '♦'; case 'C': return '♣'; case 'S': return '♠'; default: return '?'; } }
function getSuitClass(suit) { switch (suit?.toUpperCase()) { case 'H': return 'hearts'; case 'D': return 'diamonds'; case 'C': return 'clubs'; case 'S': return 'spades'; default: return ''; } }
const RANK_ORDER_CLIENT = ["4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2", "3"];
const RANK_VALUES_CLIENT = {}; RANK_ORDER_CLIENT.forEach((r, i) => RANK_VALUES_CLIENT[r] = i);
const SUIT_ORDER_CLIENT = ["D", "C", "H", "S"];
const SUIT_VALUES_CLIENT = {}; SUIT_ORDER_CLIENT.forEach((s, i) => SUIT_VALUES_CLIENT[s] = i);
function compareSingleCardsClient(cardA, cardB) { const rankValueA = RANK_VALUES_CLIENT[cardA.rank]; const rankValueB = RANK_VALUES_CLIENT[cardB.rank]; if (rankValueA !== rankValueB) return rankValueA - rankValueB; return SUIT_VALUES_CLIENT[cardA.suit] - SUIT_VALUES_CLIENT[cardB.suit]; }
function compareBySuitThenRank(cardA, cardB) { const suitValueA = SUIT_VALUES_CLIENT[cardA.suit]; const suitValueB = SUIT_VALUES_CLIENT[cardB.suit]; if (suitValueA !== suitValueB) return suitValueA - suitValueB; return RANK_VALUES_CLIENT[cardA.rank] - RANK_VALUES_CLIENT[cardB.rank]; }

// --- Rendering Functions ---
function updateRoomControls(state) { if (!state || !myUserId) return; const myPlayerInState = state.players.find(p => p.userId === myUserId); if (!myPlayerInState) return; const readyButtonInstance = document.getElementById('readyButton'); if (readyButtonInstance) { if (state.status === 'waiting') { readyButtonInstance.classList.remove('hidden-view'); readyButtonInstance.textContent = myPlayerInState.isReady ? '取消' : '准备'; readyButtonInstance.classList.toggle('ready', myPlayerInState.isReady); readyButtonInstance.disabled = false; } else { readyButtonInstance.classList.add('hidden-view'); } } const actionsContainers = document.querySelectorAll('#playerAreaBottom .my-actions-container'); if (actionsContainers.length > 0) { if (state.status === 'playing' && state.currentPlayerId === myUserId && !myPlayerInState.finished) { actionsContainers.forEach(ac => ac.classList.remove('hidden-view')); if(playSelectedCardsButton) playSelectedCardsButton.disabled = selectedCards.length === 0; if(passTurnButton) { let disablePass = (!state.lastHandInfo && !state.isFirstTurn); if (state.isFirstTurn && !state.lastHandInfo) { const iAmD4Holder = myPlayerInState.hand && Array.isArray(myPlayerInState.hand) && myPlayerInState.hand.some(c => c.rank === '4' && c.suit === 'D'); if (iAmD4Holder) disablePass = true; } passTurnButton.disabled = disablePass; } if(hintButton) hintButton.disabled = false; if(sortHandButton) sortHandButton.disabled = false; } else { actionsContainers.forEach(ac => ac.classList.add('hidden-view')); } } }
function renderRoomList(rooms) { if (!roomListEl) { console.error("CLIENT: roomList DOM element (roomListEl) not found!"); return; } roomListEl.innerHTML = ''; if (!Array.isArray(rooms)) { console.error("CLIENT: rooms data is not an array!", rooms); roomListEl.innerHTML = '<p>获取房间列表失败 (数据格式错误)。</p>'; return; } if (rooms.length === 0) { roomListEl.innerHTML = '<p>当前没有房间。</p>'; return; } rooms.forEach(room => { const item = document.createElement('div'); item.classList.add('room-item'); const nameSpan = document.createElement('span'); nameSpan.textContent = `${room.roomName} (${room.playerCount}/${room.maxPlayers})`; item.appendChild(nameSpan); const statusSpan = document.createElement('span'); statusSpan.textContent = `状态: ${room.status}`; statusSpan.classList.add(`status-${room.status}`); item.appendChild(statusSpan); if (room.hasPassword) { const passwordSpan = document.createElement('span'); passwordSpan.textContent = '🔒'; item.appendChild(passwordSpan); } const joinButton = document.createElement('button'); joinButton.textContent = '加入'; joinButton.disabled = room.status !== 'waiting' || room.playerCount >= room.maxPlayers; joinButton.onclick = () => joinRoom(room.roomId, room.hasPassword); item.appendChild(joinButton); roomListEl.appendChild(item); }); }
function updateGameInfoBarDOM(state) { const gameInfoBar = document.getElementById('gameInfoBar'); if (gameInfoBar) { const roomNameIdEl = gameInfoBar.querySelector('.room-name-id'); if (roomNameIdEl) { roomNameIdEl.innerHTML = ` <span class="room-name">${state.roomName || '房间'}</span> <span class="room-id">ID: ${state.roomId || 'N/A'}</span> `; } } }
function updateGameStatusDisplayDOM(state) { const gameStatusDisplay = document.getElementById('gameStatusDisplay'); if (gameStatusDisplay) { let messageText = ''; if (state.status === 'waiting') { const numPlayers = state.players.filter(p => p.connected).length; const maxPlayers = 4; messageText = `等待 ${numPlayers}/${maxPlayers} 位玩家准备...`; } else if (state.status === 'playing') { const currentPlayer = state.players.find(p => p.userId === state.currentPlayerId); messageText = currentPlayer ? (currentPlayer.userId === myUserId ? '轮到你出牌！' : `等待 ${currentPlayer.username} 出牌...`) : '游戏进行中...'; } else if (state.status === 'finished') { messageText = '游戏已结束'; } else { messageText = `状态: ${state.status}`; } if (gameStatusDisplay.textContent !== messageText && !gameStatusDisplay.classList.contains('error') && !gameStatusDisplay.classList.contains('success')) { displayMessage(gameStatusDisplay, messageText); } } }
function renderCenterPileDOM(state) { if (!centerPileArea) { console.error("CLIENT: centerPileArea DOM element not found!"); return; } centerPileArea.innerHTML = ''; if (state.centerPile && Array.isArray(state.centerPile) && state.centerPile.length > 0) { state.centerPile.forEach(cardData => { const cardElement = renderCard(cardData, false, true); centerPileArea.appendChild(cardElement); }); } else { const placeholder = document.createElement('span'); placeholder.textContent = '- 等待出牌 -'; placeholder.style.color = '#aaa'; placeholder.style.fontSize = '0.9em'; centerPileArea.appendChild(placeholder); } if (lastHandTypeDisplay) { if (state.lastHandInfo && state.lastHandInfo.type) { lastHandTypeDisplay.textContent = `类型: ${state.lastHandInfo.type}`; } else if (state.isFirstTurn && !state.lastHandInfo) { lastHandTypeDisplay.textContent = '请先出牌'; } else { lastHandTypeDisplay.textContent = '新回合'; } } const centerInfoEl = document.getElementById('centerInfo'); if(centerInfoEl){ const strayCards = centerInfoEl.querySelectorAll('.card'); if (strayCards.length > 0 && !centerInfoEl.contains(centerPileArea)) { console.warn("CLIENT: Found stray card elements within #centerInfo (but not in #centerPileArea), removing them."); strayCards.forEach(card => card.remove()); } } }

function renderRoomView(state) {
    if (!state || !roomView || !myUserId) { console.error("[DEBUG] RenderRoomView PREVENTED: Invalid params."); return; }
    // console.log(`[DEBUG] renderRoomView START for room ${state.roomId}. MyUser: ${myUserId}. Status: ${state.status}`);

    const myHandContainer = document.getElementById('myHand');
    if (myHandContainer) { myHandContainer.innerHTML = ''; }

    updateGameInfoBarDOM(state);
    updateGameStatusDisplayDOM(state);
    Object.values(playerAreas).forEach(clearPlayerAreaDOM);

    const myPlayer = state.players.find(p => p.userId === myUserId);
    if (!myPlayer) { console.error("[DEBUG] My player data NOT FOUND in game state for renderRoomView!"); return; }
    isReadyForGame = myPlayer.isReady;
    const mySlot = myPlayer.slot;

    state.players.forEach(player => {
        const isMe = player.userId === myUserId;
        let relativeSlot = (player.slot - mySlot + state.players.length) % state.players.length;
        const targetArea = playerAreas[relativeSlot];
        if (targetArea) { renderPlayerArea(targetArea, player, isMe, state, player.slot); }
    });
    renderCenterPileDOM(state);
    updateRoomControls(state);
    if (state.currentPlayerId !== myUserId || state.status !== 'playing') { clearHintsAndSelection(false); }
    // console.log(`[DEBUG] renderRoomView END for room ${state.roomId}.`);
}

function clearPlayerAreaDOM(area) { if (!area) { console.warn("[DEBUG] clearPlayerAreaDOM: Called with null area."); return; } /*console.log(`[DEBUG] clearPlayerAreaDOM for area: ${area.id}`);*/ const avatarEl = area.querySelector('.player-avatar'); const nameEl = area.querySelector('.playerName'); const roleEl = area.querySelector('.playerRole'); const infoEl = area.querySelector('.playerInfo'); const cardsEl = area.querySelector('.playerCards'); const handCountEl = area.querySelector('.hand-count-display'); if (avatarEl) { avatarEl.innerHTML = ''; avatarEl.style.backgroundImage = ''; } if (nameEl) nameEl.textContent = (area.id === 'playerAreaBottom' && myUsername) ? myUsername + ' (你)' : '空位'; if (roleEl) roleEl.textContent = '[?]'; if (infoEl) infoEl.innerHTML = '总分: 0'; if (cardsEl) { cardsEl.innerHTML = '<span style="color:#888; font-style:italic;">- 等待 -</span>'; } else { console.warn(`[DEBUG] .playerCards not found in ${area.id}`); } if (handCountEl) handCountEl.remove(); if (area.id === 'playerAreaBottom') { const actionsContainers = area.querySelectorAll('.my-actions-container'); actionsContainers.forEach(ac => ac.classList.add('hidden-view')); const readyBtn = area.querySelector('#readyButton'); if (readyBtn) readyBtn.classList.add('hidden-view'); } }
function renderPlayerArea(container, playerData, isMe, state, absoluteSlot) { const avatarEl = container.querySelector('.player-avatar'); const nameEl = container.querySelector('.playerName'); const roleEl = container.querySelector('.playerRole'); const infoEl = container.querySelector('.playerInfo'); const cardsEl = container.querySelector('.playerCards'); if (!playerData || !playerData.userId) { clearPlayerAreaDOM(container); return; } if (avatarEl) { avatarEl.innerHTML = ''; avatarEl.style.backgroundImage = `url('${AVATAR_PATHS[absoluteSlot % AVATAR_PATHS.length]}')`; if (state.status === 'playing' && playerData.userId === state.currentPlayerId && !playerData.finished) { const alarmImg = document.createElement('img'); alarmImg.src = ALARM_ICON_SRC; alarmImg.alt = '出牌提示'; alarmImg.classList.add('alarm-icon'); avatarEl.appendChild(alarmImg); avatarEl.style.backgroundImage = 'none'; } } if (nameEl) nameEl.textContent = playerData.username + (isMe ? ' (你)' : ''); if (roleEl) roleEl.textContent = playerData.role ? `[${playerData.role}]` : '[?]'; if (infoEl) { let infoText = `总分: ${playerData.score || 0}`; if (playerData.finished) infoText += ' <span class="finished">[已完成]</span>'; else if (!playerData.connected && state.status !== 'waiting') infoText += ' <span class="disconnected">[已断线]</span>'; else if (state.status === 'waiting' && !isMe) { infoText += playerData.isReady ? ' <span class="ready">[已准备]</span>' : ' <span class="not-ready">[未准备]</span>'; } infoEl.innerHTML = infoText; } if (cardsEl) renderPlayerCards(cardsEl, playerData, isMe, state.status === 'playing' && state.currentPlayerId === myUserId); }
function fanCards(cardContainer, cardElements, areaId) { const numCards = cardElements.length; if (numCards === 0 || areaId === 'playerAreaBottom') { if (areaId === 'playerAreaBottom') { cardElements.forEach((card, i) => { card.style.zIndex = i; card.style.transform = ''; card.style.left = ''; card.style.top = ''; card.style.position = ''; }); } return; } const offsetXPerCard = 1; const offsetYPerCard = 1; const maxVisibleStackedCards = Math.min(numCards, 3); cardElements.forEach((card, i) => { let currentOffsetX = 0; let currentOffsetY = 0; if (i < maxVisibleStackedCards) { currentOffsetX = i * offsetXPerCard; currentOffsetY = i * offsetYPerCard; } else { currentOffsetX = (maxVisibleStackedCards - 1) * offsetXPerCard; currentOffsetY = (maxVisibleStackedCards - 1) * offsetYPerCard; } card.style.transform = `translate(${currentOffsetX}px, ${currentOffsetY}px)`; card.style.zIndex = i; card.style.opacity = '1'; }); }
function getCardImageFilename(cardData) { if (!cardData || typeof cardData.rank !== 'string' || typeof cardData.suit !== 'string') { console.error("Invalid cardData for getCardImageFilename:", cardData); return null; } let rankStr = cardData.rank.toLowerCase(); if (rankStr === 't') rankStr = '10'; else if (rankStr === 'j') rankStr = 'jack'; else if (rankStr === 'q') rankStr = 'queen'; else if (rankStr === 'k') rankStr = 'king'; else if (rankStr === 'a') rankStr = 'ace'; let suitStr = ''; switch (cardData.suit.toUpperCase()) { case 'S': suitStr = 'spades'; break; case 'H': suitStr = 'hearts'; break; case 'D': suitStr = 'diamonds'; break; case 'C': suitStr = 'clubs'; break; default: console.warn("Invalid suit for card image:", cardData.suit); return null; } return `${rankStr}_of_${suitStr}.png`; }
function renderCard(cardData, isHidden, isCenterPileCard = false) { const cardDiv = document.createElement('div'); cardDiv.classList.add('card'); if (isHidden || !cardData) { cardDiv.classList.add('hidden'); } else { cardDiv.classList.add('visible'); const filename = getCardImageFilename(cardData); if (filename) { cardDiv.style.backgroundImage = `url('/images/cards/${filename}')`; cardDiv.dataset.suit = cardData.suit; cardDiv.dataset.rank = cardData.rank; } else { cardDiv.textContent = `${cardData.rank || '?'}${getSuitSymbol(cardData.suit)}`; cardDiv.classList.add(getSuitClass(cardData.suit)); console.error("Failed to generate filename for card:", cardData, "Using text fallback."); } } return cardDiv; }

function renderPlayerCards(containerParam, playerData, isMe, isMyTurnAndPlaying) {
    let targetContainer;
    if (isMe) {
        targetContainer = document.getElementById('myHand');
        if (!targetContainer) { console.error("[DEBUG] renderPlayerCards: #myHand NOT FOUND!"); return; }
        targetContainer.innerHTML = '';
    }  else {
        targetContainer = containerParam;
        if (!targetContainer) { console.error(`[DEBUG] renderPlayerCards for OPPONENT (${playerData.username}): Passed container is null.`); return; }
        targetContainer.innerHTML = '';
    }

    const cardElements = [];
    if (isMe) {
        // playerData here is the specific player's data object from currentGameState
        let sortedHand = [];
        if (playerData && Array.isArray(playerData.hand)) {
            sortedHand = [...playerData.hand];
        } else if (playerData && !playerData.finished) {
            // This case should be rare if data management in gameStateUpdate is correct
            console.warn(`[RenderPlayerCards] My hand is not an array for rendering (playerData.hand was: ${typeof playerData.hand}), but I'm not finished. Rendering as empty.`);
        }
        // No early return if hand is undefined; sortedHand will be [] and handled below.

        if (playerData.finished) {
            targetContainer.innerHTML = '<span style="color:#888; font-style:italic;">已出完</span>';
        } else if (sortedHand.length === 0) {
            targetContainer.innerHTML = '<span style="color:#555; font-style:italic;">- 无手牌 -</span>';
        } else {
            if (currentSortMode === 'rank') sortedHand.sort(compareSingleCardsClient);
            else sortedHand.sort(compareBySuitThenRank);
            sortedHand.forEach((cardData, index) => {
                const cardElement = renderCard(cardData, false, false);
                cardElement.style.zIndex = index;
                const isSelected = selectedCards.some(c => c.rank === cardData.rank && c.suit === cardData.suit);
                const isHinted = currentHint && currentHint.cards.some(c => c.rank === cardData.rank && c.suit === cardData.suit);
                if (isSelected) cardElement.classList.add('selected');
                if (isHinted) cardElement.classList.add('hinted');
                if (isMyTurnAndPlaying) cardElement.onclick = () => toggleCardSelection(cardData, cardElement);
                else cardElement.classList.add('disabled');
                targetContainer.appendChild(cardElement);
            });
        }
    } else { // Opponent's hand
        if (playerData.finished) { targetContainer.innerHTML = '<span style="color:#888; font-style:italic;">已出完</span>'; } else if (playerData.handCount > 0) { for (let i = 0; i < playerData.handCount; i++) { const cardElement = renderCard(null, true, false); targetContainer.appendChild(cardElement); cardElements.push(cardElement); } let handCountEl = targetContainer.closest('.playerArea')?.querySelector('.hand-count-display'); if (!handCountEl) { handCountEl = document.createElement('div'); handCountEl.classList.add('hand-count-display'); const playerAreaEl = targetContainer.closest('.playerArea'); if (playerAreaEl) { playerAreaEl.appendChild(handCountEl); } } if (handCountEl) handCountEl.textContent = `${playerData.handCount} 张`; } else { targetContainer.innerHTML = '<span style="color:#555; font-style:italic;">- 等待 -</span>'; let handCountEl = targetContainer.closest('.playerArea')?.querySelector('.hand-count-display'); if (handCountEl) handCountEl.remove(); } if (cardElements.length > 0) { requestAnimationFrame(() => { fanCards(targetContainer, cardElements, targetContainer.closest('.playerArea')?.id); }); }
    }
}

// --- Event Handlers for UI elements ---
function handleRegister() { const phone = regPhoneInput.value.trim(); const password = regPasswordInput.value; if (!phone || !password) { displayMessage(authMessage, '请输入手机号和密码。', true); return; } if (password.length < 4) { displayMessage(authMessage, '密码至少需要4位。', true); return; } registerButton.disabled = true; socket.emit('register', { phoneNumber: phone, password }, (response) => { registerButton.disabled = false; displayMessage(authMessage, response.message, !response.success, response.success); if (response.success) { regPhoneInput.value = ''; regPasswordInput.value = ''; } }); }
function handleLogin() { const phone = loginPhoneInput.value.trim(); const password = loginPasswordInput.value; if (!phone || !password) { displayMessage(authMessage, '请输入手机号和密码。', true); return; } loginButton.disabled = true; socket.emit('login', { phoneNumber: phone, password }, (response) => { loginButton.disabled = false; displayMessage(authMessage, response.message, !response.success, response.success); if (response.success) { myUserId = response.userId; myUsername = response.username; try { localStorage.setItem('kkUserId', myUserId); localStorage.setItem('kkUsername', myUsername); } catch (e) { console.warn('LocalStorage error while saving user session:', e); } if(lobbyUsername) lobbyUsername.textContent = myUsername; showView('lobbyView'); socket.emit('listRooms', (rooms) => renderRoomList(rooms)); } }); }
function handleLogout() { console.log('Logging out...'); try { localStorage.removeItem('kkUserId'); localStorage.removeItem('kkUsername'); } catch (e) { console.warn('LocalStorage error while removing user session:', e); } myUserId = null; myUsername = null; currentRoomId = null; currentGameState = null; previousGameState = null; isReadyForGame = false; selectedCards = []; currentHint = null; currentHintCycleIndex = 0; if (socket.connected) { socket.disconnect(); } socket.connect(); showView('loginRegisterView'); if(loginPhoneInput) loginPhoneInput.value = ''; if(loginPasswordInput) loginPasswordInput.value = ''; }
function handleGameLeave() { if (!currentRoomId) { console.log("Not in a room to leave."); handleReturnToLobby(); return; } console.log(`Attempting to leave room: ${currentRoomId} from game view.`); const actualLeaveButton = document.getElementById('leaveRoomButton'); if (actualLeaveButton) actualLeaveButton.disabled = true; socket.emit('leaveRoom', (response) => { if (actualLeaveButton) actualLeaveButton.disabled = false; if (response.success) { handleReturnToLobby(); } else { const gameStatusDisp = document.getElementById('gameStatusDisplay'); displayMessage(gameStatusDisp || lobbyMessage, response.message || '离开房间失败。', true); } }); }
function handleCreateRoom() { const roomName = createRoomNameInput.value.trim(); const password = createRoomPasswordInput.value; if (!roomName) { displayMessage(lobbyMessage, '请输入房间名称。', true); return; } createRoomButton.disabled = true; socket.emit('createRoom', { roomName, password: password || null }, (response) => { createRoomButton.disabled = false; if (response.success) { currentRoomId = response.roomId; showView('roomView'); previousGameState = null; currentGameState = response.roomState; renderRoomView(response.roomState); } else { displayMessage(lobbyMessage, response.message, true); } }); }
function joinRoom(roomId, needsPassword) { let passwordToTry = null; if (needsPassword) { passwordToTry = prompt(`房间 "${roomId}" 受密码保护，请输入密码:`, ''); if (passwordToTry === null) return; } displayMessage(lobbyMessage, `正在加入房间 ${roomId}...`, false); socket.emit('joinRoom', { roomId, password: passwordToTry }, (response) => { if (response.success) { currentRoomId = response.roomId; showView('roomView'); previousGameState = null; currentGameState = response.roomState; renderRoomView(response.roomState); displayMessage(lobbyMessage, '', false); } else { displayMessage(lobbyMessage, response.message, true); } }); }
function handleReadyClick() { if (!currentRoomId || !currentGameState) return; const actualReadyButton = document.getElementById('readyButton'); if (!actualReadyButton) {console.error("Ready button not found!"); return;} const desiredReadyState = !isReadyForGame; actualReadyButton.disabled = true; socket.emit('playerReady', desiredReadyState, (response) => { actualReadyButton.disabled = false; if (!response.success) { const gameStatusDisp = document.getElementById('gameStatusDisplay'); displayMessage(gameStatusDisp, response.message || "无法改变准备状态。", true); } }); }
function handleSortHand() { if (currentSortMode === 'rank') currentSortMode = 'suit'; else currentSortMode = 'rank'; if (currentGameState && currentView === 'roomView') { const myPlayer = currentGameState.players.find(p => p.userId === myUserId); if (myPlayer && myPlayer.hand) { const cardsEl = document.getElementById('myHand'); if (cardsEl) renderPlayerCards(cardsEl, myPlayer, true, currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId); } } }
function toggleCardSelection(cardData, cardElement) { if (!cardElement || cardElement.classList.contains('disabled')) return; const index = selectedCards.findIndex(c => c.rank === cardData.rank && c.suit === cardData.suit); if (index > -1) { selectedCards.splice(index, 1); cardElement.classList.remove('selected'); } else { selectedCards.push(cardData); cardElement.classList.add('selected'); } if (playSelectedCardsButton && currentGameState && currentGameState.currentPlayerId === myUserId) { playSelectedCardsButton.disabled = selectedCards.length === 0; } }

function handlePlaySelectedCards() {
    const gameStatusDisp = document.getElementById('gameStatusDisplay');
    if (selectedCards.length === 0) { displayMessage(gameStatusDisp, '请先选择要出的牌。', true); return; }
    if (!currentRoomId || !currentGameState || currentGameState.status !== 'playing' || currentGameState.currentPlayerId !== myUserId) { displayMessage(gameStatusDisp, '现在不是你的回合或状态无效。', true); return; }
    setGameActionButtonsDisabled(true);
    socket.emit('playCard', selectedCards, (response) => {
        if (!response.success) {
            displayMessage(gameStatusDisp, response.message || '出牌失败。', true);
            if (currentGameState && currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId) {
                setGameActionButtonsDisabled(false);
            }
        } else {
            // Player's own action was successful. Manually update client's hand.
            if (currentGameState) {
                const myPlayer = currentGameState.players.find(p => p.userId === myUserId);
                if (myPlayer && Array.isArray(myPlayer.hand)) {
                    const cardsPlayedSet = new Set(selectedCards.map(c => `${c.rank}${c.suit}`));
                    myPlayer.hand = myPlayer.hand.filter(card => !cardsPlayedSet.has(`${card.rank}${card.suit}`));
                    // handCount will be updated by server's gameStateUpdate
                } else if (myPlayer) {
                    console.warn("[PlayCard Success] My player hand was not an array before filtering. This is unexpected.", myPlayer.hand);
                    myPlayer.hand = []; // Fallback
                }
            }
            selectedCards = [];
            clearHintsAndSelection(true);
            // Buttons will be re-enabled by gameStateUpdate if it's still my turn (e.g. if I finished)
            // or if turn moves and comes back. For now, they remain disabled until next state.
        }
    });
}
function handlePassTurn() { const gameStatusDisp = document.getElementById('gameStatusDisplay'); if (!currentRoomId || !currentGameState || currentGameState.status !== 'playing' || currentGameState.currentPlayerId !== myUserId) { displayMessage(gameStatusDisp, '现在不是你的回合或状态无效。', true); return; } if (passTurnButton && passTurnButton.disabled) { displayMessage(gameStatusDisp, '你必须出牌。', true); return; } setGameActionButtonsDisabled(true); selectedCards = []; socket.emit('passTurn', (response) => { if (!response.success) { displayMessage(gameStatusDisp, response.message || 'Pass 失败。', true); if (currentGameState && currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId) { setGameActionButtonsDisabled(false); } } else { clearHintsAndSelection(true); } }); }
function handleHint() { const gameStatusDisp = document.getElementById('gameStatusDisplay'); if (!currentRoomId || !currentGameState || currentGameState.status !== 'playing' || currentGameState.currentPlayerId !== myUserId) { displayMessage(gameStatusDisp, '现在不是你的回合或状态无效。', true); return; } setGameActionButtonsDisabled(true); socket.emit('requestHint', currentHintCycleIndex, (response) => { if (currentGameState && currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId) { setGameActionButtonsDisabled(false); } clearHintsAndSelection(false); if (response.success && response.hint && response.hint.cards) { displayMessage(gameStatusDisp, '找到提示！(再点提示可尝试下一个)', false, true); currentHint = response.hint; currentHintCycleIndex = response.nextHintIndex; highlightHintedCards(currentHint.cards); } else { displayMessage(gameStatusDisp, response.message || '没有可出的牌或无更多提示。', true); currentHint = null; currentHintCycleIndex = 0; } }); }
function setGameActionButtonsDisabled(disabled) { if (playSelectedCardsButton) playSelectedCardsButton.disabled = disabled; if (passTurnButton) passTurnButton.disabled = disabled; if (hintButton) hintButton.disabled = disabled; if (!disabled && currentGameState) { updateRoomControls(currentGameState); } }
function highlightHintedCards(hintedCardsArray) { if (!hintedCardsArray || hintedCardsArray.length === 0) return; const localMyHandArea = document.getElementById('myHand'); if (!localMyHandArea) return; const cardElements = localMyHandArea.querySelectorAll('.card.visible:not(.hidden)'); hintedCardsArray.forEach(hintCard => { for(const elem of cardElements) { if(elem.dataset.rank === hintCard.rank && elem.dataset.suit === hintCard.suit) { elem.classList.add('hinted'); break; } } }); }
function clearHintsAndSelection(resetHintCycleAndSelection = true) { if (resetHintCycleAndSelection) { currentHint = null; currentHintCycleIndex = 0; selectedCards = []; if(playSelectedCardsButton) playSelectedCardsButton.disabled = true; } const localMyHandArea = document.getElementById('myHand'); if (localMyHandArea) { const hintedElements = localMyHandArea.querySelectorAll('.card.hinted'); hintedElements.forEach(el => el.classList.remove('hinted')); if(resetHintCycleAndSelection){ const selectedElements = localMyHandArea.querySelectorAll('.card.selected'); selectedElements.forEach(el => el.classList.remove('selected')); } } }
function handleReturnToLobby() { console.log("Returning to lobby."); currentRoomId = null; currentGameState = null; previousGameState = null; isReadyForGame = false; selectedCards = []; currentHint = null; currentHintCycleIndex = 0; if (gameOverOverlay && !gameOverOverlay.classList.contains('hidden-view')) { gameOverOverlay.classList.add('hidden-view'); gameOverOverlay.classList.remove('view-flex'); } showView('lobbyView'); socket.emit('listRooms', (rooms) => { renderRoomList(rooms); }); }
function showGameOver(scoreResultData) { if (!scoreResultData) { console.warn("showGameOver called with no data. Using last known game state if available."); gameOverTitle.textContent = "游戏结束!"; gameOverReason.textContent = currentGameState?.gameResult?.reason || "无法获取详细结果。"; gameOverScores.innerHTML = ''; const playersToDisplay = currentGameState?.players || []; playersToDisplay.forEach(playerData => { const p = document.createElement('p'); p.textContent = `${playerData.name} (${playerData.role || '?'}) 总分: ${playerData.score}`; gameOverScores.appendChild(p); }); } else { gameOverTitle.textContent = scoreResultData.result || "游戏结束!"; gameOverReason.textContent = scoreResultData.reason || (scoreResultData.result ? '' : "游戏正常结束。"); gameOverScores.innerHTML = ''; const playersToDisplay = scoreResultData.finalScores || currentGameState?.players || []; playersToDisplay.forEach(playerData => { const p = document.createElement('p'); let scoreText = `${playerData.name} (${playerData.role || '?'})`; if (scoreResultData.scoreChanges && scoreResultData.scoreChanges[playerData.id] !== undefined) { const change = scoreResultData.scoreChanges[playerData.id]; const changeDisplay = change > 0 ? `+${change}` : (change < 0 ? `${change}` : '0'); const changeClass = change > 0 ? 'score-plus' : (change < 0 ? 'score-minus' : 'score-zero'); scoreText += ` : <span class="${changeClass}">${changeDisplay}</span>`; } scoreText += ` (总分: ${playerData.score})`; p.innerHTML = scoreText; gameOverScores.appendChild(p); }); } showView('gameOverOverlay'); }

// --- Socket Event Handlers ---
socket.on('connect', () => { console.log('[NET] Connected to server! Socket ID:', socket.id); if (gameOverOverlay && !gameOverOverlay.classList.contains('hidden-view')) { gameOverOverlay.classList.add('hidden-view'); gameOverOverlay.classList.remove('view-flex'); } initClientSession(); });
socket.on('disconnect', (reason) => { console.log('[NET] Disconnected from server:', reason); if (currentView !== 'loginRegisterView' && currentView !== 'loadingView') { showView('loadingView'); displayMessage(loadingView.querySelector('p'), `与服务器断开连接: ${reason}. 正在尝试重连...`, true); } });
socket.on('connect_error', (err) => { console.error('[NET] Connection Error:', err.message); if (currentView !== 'loginRegisterView' && currentView !== 'loadingView') { showView('loadingView'); displayMessage(loadingView.querySelector('p'), `连接错误: ${err.message}. 请检查网络并刷新。`, true); } });
socket.on('roomListUpdate', (rooms) => { if (currentView === 'lobbyView') { renderRoomList(rooms); } });
socket.on('playerReadyUpdate', ({ userId, isReady }) => { console.log(`[EVENT] playerReadyUpdate: User ${userId}, Ready: ${isReady}`); if (currentGameState && currentView === 'roomView') { const player = currentGameState.players.find(p => p.userId === userId); if (player) { player.isReady = isReady; if (userId === myUserId) isReadyForGame = isReady; } renderRoomView(currentGameState); } });
socket.on('playerJoined', (newPlayerInfo) => { console.log(`[EVENT] Player joined: ${newPlayerInfo.username}`); if (currentView === 'roomView' && currentGameState) { previousGameState = JSON.parse(JSON.stringify(currentGameState)); const existingPlayer = currentGameState.players.find(p => p.userId === newPlayerInfo.userId); if (existingPlayer) { Object.assign(existingPlayer, newPlayerInfo, {connected: true});} else { currentGameState.players.push({ ...newPlayerInfo, score:0, hand:undefined, handCount:0, role:null, finished:false, connected:true }); currentGameState.players.sort((a,b) => a.slot - b.slot); } renderRoomView(currentGameState); displayMessage(document.getElementById('gameStatusDisplay'), `${newPlayerInfo.username} 加入了房间。`, false, true); } else if (currentView === 'roomView' && !currentGameState) { socket.emit('requestGameState', (state) => { if(state) { currentGameState = state; renderRoomView(state); } }); } });
socket.on('playerLeft', ({ userId, username, reason }) => { console.log(`[EVENT] Player left: ${username}, Reason: ${reason}`); if (currentGameState && currentView === 'roomView') { previousGameState = JSON.parse(JSON.stringify(currentGameState)); const playerIdx = currentGameState.players.findIndex(p => p.userId === userId); if (playerIdx > -1) { currentGameState.players[playerIdx].connected = false; currentGameState.players[playerIdx].isReady = false; } renderRoomView(currentGameState); displayMessage(document.getElementById('gameStatusDisplay'), `${username} ${reason === 'disconnected' ? '断线了' : '离开了房间'}。`, true); } });
socket.on('playerReconnected', (reconnectedPlayerInfo) => { console.log(`[EVENT] Player reconnected: ${reconnectedPlayerInfo.username}`); if (currentView === 'roomView' && currentGameState) { previousGameState = JSON.parse(JSON.stringify(currentGameState)); const player = currentGameState.players.find(p => p.userId === reconnectedPlayerInfo.userId); if (player) { Object.assign(player, reconnectedPlayerInfo, {connected: true});} else { currentGameState.players.push({ ...reconnectedPlayerInfo, score:0, hand:undefined, handCount:0, role:null, finished:false, connected:true }); currentGameState.players.sort((a,b) => a.slot - b.slot); } renderRoomView(currentGameState); displayMessage(document.getElementById('gameStatusDisplay'), `${reconnectedPlayerInfo.username} 重新连接。`, false, true); } else if (currentView === 'roomView' && !currentGameState) { socket.emit('requestGameState', (state) => { if(state) { currentGameState = state; renderRoomView(state); } }); } });

socket.on('gameStarted', (initialGameState) => {
    console.log(`[EVENT] gameStarted received for room ${initialGameState.roomId}. My current room: ${currentRoomId}`);
    if (currentView !== 'roomView' || currentRoomId !== initialGameState.roomId) {
        console.warn("[DEBUG] gameStarted: Not in the correct view or room. IGNORED.");
        return;
    }
    const myInitialPlayerState = initialGameState.players.find(p => p.userId === myUserId);
    console.log('[DEBUG] gameStarted: Processing event. My hand in initialGameState:', myInitialPlayerState?.hand);

    previousGameState = currentGameState ? JSON.parse(JSON.stringify(currentGameState)) : null;
    currentGameState = initialGameState; // Authoritative state from server, includes my hand.

    const gameStatusDisp = document.getElementById('gameStatusDisplay');
    if (gameStatusDisp) displayMessage(gameStatusDisp, '游戏开始！祝你好运！', false, true);
    selectedCards = [];
    clearHintsAndSelection(true);

    console.log('[DEBUG] gameStarted: Calling full renderRoomView with new initialGameState.');
    renderRoomView(currentGameState);
});

socket.on('gameStateUpdate', (newState) => {
    if (currentView !== 'roomView' || currentRoomId !== newState.roomId) {
        console.warn("[DEBUG] gameStateUpdate: Ignoring, not in room view or room ID mismatch.");
        // Do not update currentGameState if the update is for a different room.
        // This can happen if a client quickly leaves a room and joins another,
        // and an old gameStateUpdate arrives late.
        return;
    }
    if (!currentGameState) {
        console.warn("[DEBUG] gameStateUpdate: currentGameState is null, requesting full state.");
        // This might happen if gameStarted was missed or client joined mid-game without full initial state
        // However, current logic should prevent joining mid-game. Re-authentication handles rejoining.
        // If this happens, it's likely an edge case or bug.
        // For now, we'll accept the newState, but my hand might be missing.
        currentGameState = newState;
        // Try to see if my hand is somehow in this newState (unlikely with current server logic)
        const myPlayer = currentGameState.players.find(p => p.userId === myUserId);
        if (myPlayer && myPlayer.hand === undefined && !myPlayer.finished) {
            myPlayer.hand = []; // Default to empty if missing and not finished
            console.warn("[DEBUG] gameStateUpdate: currentGameState was null, accepted newState. My hand forced to [].")
        }
        renderRoomView(currentGameState);
        return;
    }

    // `currentGameState` here is the client's state *before* this server update.
    // It might have been locally modified by a successful `playCard` callback.
    const myLocallyCorrectHand = currentGameState.players.find(p => p.userId === myUserId)?.hand;

    previousGameState = JSON.parse(JSON.stringify(currentGameState));
    currentGameState = newState; // Overwrite with server's broadcast (which has hand:undefined for me)

    const myPlayerInNewState = currentGameState.players.find(p => p.userId === myUserId);
    if (myPlayerInNewState) {
        if (myPlayerInNewState.hand === undefined) { // True for generic server updates
            if (Array.isArray(myLocallyCorrectHand)) {
                myPlayerInNewState.hand = myLocallyCorrectHand; // Restore my hand array
            } else if (!myPlayerInNewState.finished && myPlayerInNewState.handCount > 0) {
                // This is a problematic state: hand is undefined from server,
                // no local hand to restore, player not finished, but has cards.
                // This indicates a potential earlier data loss or desync.
                console.warn(`[STATE UPDATE CRITICAL] My hand became undefined, no valid local hand to restore, and not finished. Forcing empty array. HandCount: ${myPlayerInNewState.handCount}`);
                myPlayerInNewState.hand = []; // Fallback to prevent crash, but data is inconsistent.
            } else if (myPlayerInNewState.finished || myPlayerInNewState.handCount === 0) {
                // If finished or handCount is 0, ensure hand array is empty.
                myPlayerInNewState.hand = [];
            }
        }
        // If server *did* send a hand (e.g., if server logic changes for gameStateUpdate),
        // myPlayerInNewState.hand would already be populated from `newState` and the above `if` block skipped.
    } else {
        console.warn("[STATE UPDATE] My player data not found in new game state update. This is unusual.");
    }

    // Clear selection if turn moved away from me, or new round started
    if (previousGameState && currentGameState) { // Ensure both states exist for comparison
      if (previousGameState.currentPlayerId === myUserId && currentGameState.currentPlayerId !== myUserId) {
          selectedCards = [];
          clearHintsAndSelection(true);
      }
      if (!currentGameState.lastHandInfo && previousGameState.lastHandInfo && currentGameState.currentPlayerId === myUserId) {
          selectedCards = [];
          clearHintsAndSelection(true);
      }
    }

    renderRoomView(currentGameState);
});

socket.on('invalidPlay', ({ message }) => { const gameStatusDisp = document.getElementById('gameStatusDisplay'); if (gameStatusDisp) displayMessage(gameStatusDisp, `操作无效: ${message}`, true); if (currentGameState && currentGameState.status === 'playing' && currentGameState.currentPlayerId === myUserId) { updateRoomControls(currentGameState); } });
socket.on('gameOver', (results) => {
    // Check if the game over event is for the current room the client is in
    const targetRoomId = results?.roomId || currentGameState?.roomId; // Prefer results.roomId if available
    if (currentView === 'roomView' && currentRoomId === targetRoomId) {
        console.log('Game Over event received:', results);
        if (currentGameState) { // Ensure currentGameState exists
            currentGameState.status = 'finished';
            // Merge results into currentGameState if they exist
            if (results) {
                if(results.finalScores) currentGameState.finalScores = results.finalScores;
                if(results.scoreChanges) currentGameState.scoreChanges = results.scoreChanges;
                if(results.result) currentGameState.gameResultText = results.result;
                // If results object itself is used for gameOverReason and other top-level properties
                if(results.reason) currentGameState.gameOverReason = results.reason;
            }
        }
        // Pass the more complete object to showGameOver
        showGameOver(results || currentGameState);
    } else {
        console.warn("Received gameOver for a room I'm not in/viewing, or results are missing/mismatched roomId. My room:", currentRoomId, "Results RoomId:", results?.roomId, "CurrentGameState RoomId:", currentGameState?.roomId);
    }
});
socket.on('gameStartFailed', ({ message }) => { const gameStatusDisp = document.getElementById('gameStatusDisplay'); if (currentView === 'roomView' && gameStatusDisp) { displayMessage(gameStatusDisp, `游戏开始失败: ${message}`, true); if (currentGameState) { currentGameState.players.forEach(p => p.isReady = false); isReadyForGame = false; renderRoomView(currentGameState); } } });
socket.on('allPlayersResetReady', () => { const gameStatusDisp = document.getElementById('gameStatusDisplay'); if (currentGameState && currentView === 'roomView' && currentGameState.status === 'waiting') { currentGameState.players.forEach(p => p.isReady = false); isReadyForGame = false; renderRoomView(currentGameState); if (gameStatusDisp) displayMessage(gameStatusDisp, '部分玩家状态变更，请重新准备。', true); } });
function initClientSession() { let storedUserId = null; try { storedUserId = localStorage.getItem('kkUserId'); } catch (e) { console.warn('[INIT] Error accessing localStorage:', e); showView('loginRegisterView'); return; } if (storedUserId) { console.log(`[INIT] Found stored user ID: ${storedUserId}. Attempting reauthentication...`); showView('loadingView'); displayMessage(loadingView.querySelector('p'), "正在重新连接...", false); socket.emit('reauthenticate', storedUserId, (response) => { console.log(`[INIT] Reauthenticate response:`, response); if (response.success) { myUserId = response.userId; myUsername = response.username; if (lobbyUsername) lobbyUsername.textContent = myUsername; if (response.roomState) { currentRoomId = response.roomState.roomId; previousGameState = null; currentGameState = response.roomState; console.log(`[INIT] Reauthenticated into room: ${currentRoomId}, Status: ${currentGameState.status}. Player hand length in roomState: ${currentGameState.players.find(p=>p.userId === myUserId)?.hand?.length}`); if (currentGameState.status === 'finished') { if (currentGameState.gameResult || currentGameState.finalScores || currentGameState.gameResultText) { console.log("[INIT] Reconnected to a FINISHED game, showing game over."); showView('roomView'); renderRoomView(currentGameState); showGameOver(currentGameState); } else { console.log("[INIT] Reconnected to a FINISHED game (no specific result). Returning to lobby."); handleReturnToLobby(); } } else { console.log(`[INIT] Reconnected to room, status ${currentGameState.status}. Rendering room view.`); showView('roomView'); renderRoomView(currentGameState); } } else { console.log(`[INIT] Reauthenticated, no current room state. Going to lobby.`); showView('lobbyView'); socket.emit('listRooms', (rooms) => { renderRoomList(rooms); }); } } else { console.warn(`[INIT] Reauthentication failed: ${response.message}`); try { localStorage.removeItem('kkUserId'); localStorage.removeItem('kkUsername'); } catch (e) {} displayMessage(authMessage, response.message || "重新认证失败，请重新登录。", true); showView('loginRegisterView'); } }); } else { console.log('[INIT] No stored user ID found. Showing login/register.'); showView('loginRegisterView'); } }
function setupEventListeners() { if(registerButton) registerButton.addEventListener('click', handleRegister); if(loginButton) loginButton.addEventListener('click', handleLogin); const lobbyLogoutBtnInstance = document.getElementById('logoutButton'); if(lobbyLogoutBtnInstance) lobbyLogoutBtnInstance.addEventListener('click', handleLogout); if(createRoomButton) createRoomButton.addEventListener('click', handleCreateRoom); if (roomView) { roomView.addEventListener('click', function(event) { const buttonElement = event.target.closest('button'); if (!buttonElement) return; const buttonId = buttonElement.id; if (currentView !== 'roomView' && buttonId !== 'backToLobbyButton' && buttonId !== 'leaveRoomButton') { if (currentView === 'gameOverOverlay' && buttonId === 'backToLobbyButton') { } else if (currentView === 'roomView' && buttonId === 'leaveRoomButton') { } else { console.warn(`Button click for ${buttonId} ignored, current view is ${currentView}`); return; } } switch (buttonId) { case 'readyButton': handleReadyClick(); break; case 'leaveRoomButton': handleGameLeave(); break; case 'sortHandButton': handleSortHand(); break; case 'playSelectedCardsButton': handlePlaySelectedCards(); break; case 'passTurnButton': handlePassTurn(); break; case 'hintButton': handleHint(); break; case 'backToLobbyButton': handleReturnToLobby(); break; } }); } regPasswordInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !registerButton.disabled) handleRegister(); }); loginPasswordInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !loginButton.disabled) handleLogin(); }); createRoomNameInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !createRoomButton.disabled) handleCreateRoom(); }); createRoomPasswordInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter' && !createRoomButton.disabled) handleCreateRoom(); }); }
document.addEventListener('DOMContentLoaded', () => { console.log("DOM Loaded. Setting up client..."); document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden'; setupEventListeners(); if (socket.connected) { console.log("[INIT] Socket already connected on DOMContentLoaded."); initClientSession(); } else { console.log("[INIT] Socket not connected on DOMContentLoaded. Waiting for 'connect' event."); showView('loadingView'); } console.log('Client setup complete.'); });
