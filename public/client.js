// client.js
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed. Client v1.0.28'); // 版本号更新
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
    const infoBarRoomName = document.getElementById('infoBarRoomName'); // Added for consistency
    const infoBarRoomId = document.getElementById('infoBarRoomId');   // Added for consistency
    const infoBarCurrentTurn = document.getElementById('infoBarCurrentTurn'); // Added

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
                    view.style.display = 'flex';
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
             if (data.roomState) currentRoomState = data.roomState;
            console.log(`Auth success (state potentially consistent) for user: ${data.username} (ID: ${data.userId})`);
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
            console.log("Connect event: Re-emitting reauthenticate"); initialReauthAttempted = true;
            socket.emit('reauthenticate', lsUserId, (response) => {
                if (response.success) handleAuthSuccess(response);
                else {
                    localStorage.removeItem('userId'); localStorage.removeItem('username');
                    if (authView.style.display === 'none' && gameView.style.display === 'none' && lobbyView.style.display === 'none') switchToView('auth-view');
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
        initialReauthAttempted = true;
    });
    socket.on('disconnect', (reason) => { console.log('Disconnected from server:', reason); alert('与服务器断开连接: ' + reason + ". 请刷新页面重试。"); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent='已断开连接...'; initialReauthAttempted = false; });
    socket.on('connect_error', (err) => { console.error('Connection error:', err.message); switchToView('loadingView'); const p=loadingView.querySelector('p'); if(p)p.textContent=`连接错误: ${err.message}.`; });

    if (createRoomButton) {
        createRoomButton.addEventListener('click', () => {
            const roomName = roomNameInput.value.trim();
            const password = roomPasswordInput.value;

            if (!roomName) {
                alert('请输入房间名称');
                return;
            }
            console.log(`[CLIENT] Attempting to create room: "${roomName}", password: "${password || '无'}"`);

            socket.emit('createRoom', { roomName, password: password || null }, (response) => {
                console.log('[CLIENT] Create room response from server:', response);
                if (response && response.success) {
                    currentRoomId = response.roomId;
                    // roomState is directly passed and should be used
                    displayGameState(response.roomState);
                    switchToView('game-view');
                    alert(`房间 "${roomName}" 创建成功! ID: ${response.roomId}`);
                } else {
                    alert(`创建房间失败: ${response ? response.message : '服务器未响应或发生未知错误。'}`);
                }
            });
        });
    }

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
                        if (passwordToJoin === null) return;
                    }
                    console.log(`[CLIENT] Attempting to join room: ${roomIdToJoin}, password: ${passwordToJoin ? "******" : "无"}`);
                    socket.emit('joinRoom', { roomId: roomIdToJoin, password: passwordToJoin }, (response) => {
                        console.log('[CLIENT] Join room response:', response);
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
    if (refreshRoomListButton) refreshRoomListButton.addEventListener('click', () => socket.emit('listRooms', updateRoomList) );
    if (logoutButtonLobby) logoutButtonLobby.addEventListener('click', () => { localStorage.removeItem('userId'); localStorage.removeItem('username'); myUserId = null; myUsername = null; currentRoomId = null; currentRoomState = null; if(loginForm) loginForm.reset(); if(registerForm) registerForm.reset(); switchToView('auth-view'); initialReauthAttempted = false; });

    if (readyButton) {
        readyButton.addEventListener('click', () => {
            if (!currentRoomState || !myUserId) return;
            const myPlayer = currentRoomState.players.find(p => p.userId === myUserId);
            if (!myPlayer || currentRoomState.status !== 'waiting') return;
            const newReadyState = !myPlayer.isReady;
            console.log(`[CLIENT] Sending playerReady: ${newReadyState}`);
            socket.emit('playerReady', newReadyState, (response) => {
                console.log('[CLIENT] playerReady callback response:', response);
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
                updatePlayerReadyStatusUI(player.userId, isReady);
                if (userId === myUserId && readyButton) {
                    readyButton.textContent = isReady ? "取消" : "准备";
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
    
    function handleLeaveRoomAndReturnToLobby() {
        console.log("[CLIENT] Attempting to leave room.");
        socket.emit('leaveRoom', (response) => {
            console.log('[CLIENT] Leave room response:', response);
            currentRoomId = null; currentRoomState = null; selectedCardsForPlay = []; currentHint = null;
            switchToView('lobby-view'); socket.emit('listRooms', updateRoomList);
            if (gameOverOverlay) { gameOverOverlay.classList.add('hidden-view'); gameOverOverlay.style.display = 'none';}
        });
    }
    if (leaveRoomButton) leaveRoomButton.addEventListener('click', handleLeaveRoomAndReturnToLobby);
    if (backToLobbyBtnOverlay) backToLobbyBtnOverlay.addEventListener('click', handleLeaveRoomAndReturnToLobby);

    if (playButton) playButton.addEventListener('click', () => { if (selectedCardsForPlay.length === 0) { alert('请选择要出的牌'); return; } console.log("[CLIENT] Playing cards:", selectedCardsForPlay); socket.emit('playCard', selectedCardsForPlay, (res) => { if (res && res.success) selectedCardsForPlay = []; else alert(`出牌失败: ${res ? res.message : '未知错误'}`); }); });
    if (passButton) passButton.addEventListener('click', () => { console.log("[CLIENT] Passing turn."); socket.emit('passTurn', (res) => { if (res && !res.success) alert(`操作失败: ${res.message}`); }); });
    if (hintButton) hintButton.addEventListener('click', () => { console.log("[CLIENT] Requesting hint."); socket.emit('requestHint', currentHintIndexFromServer, (res) => { if (res.success && res.hint && res.hint.cards) { currentHint = res.hint.cards; currentHintIndexFromServer = res.nextHintIndex || 0; highlightHintedCards(currentHint); } else { alert(res.message || '没有可用的提示。'); currentHint = null; currentHintIndexFromServer = 0; highlightHintedCards([]); } }); });

    function cardObjectToKey(card) { return `${card.rank}${card.suit}`; }
    function highlightHintedCards(hintedCardsArray) { if (!playerHandArea) return; playerHandArea.querySelectorAll('.my-card.hinted').forEach(c => c.classList.remove('hinted')); if (hintedCardsArray && hintedCardsArray.length > 0) { const hintedKeys = new Set(hintedCardsArray.map(cardObjectToKey)); playerHandArea.querySelectorAll('.my-card').forEach(cardEl => { if (hintedKeys.has(`${cardEl.dataset.rank}${cardEl.dataset.suit}`)) cardEl.classList.add('hinted'); }); } }

    function displayGameState(state, animateHandOnDisplay = false) {
        if (!state) { console.warn("displayGameState: null state"); if(myUserId)switchToView('lobby-view');else switchToView('auth-view'); return; }
        console.log("[CLIENT] Displaying Game State:", JSON.parse(JSON.stringify(state))); // Deep copy for logging
        currentRoomState = state;
        const myPlayer = state.players ? state.players.find(p => p.userId === myUserId) : null;

        if (infoBarRoomName) infoBarRoomName.textContent = state.roomName || '未知';
        if (infoBarRoomId) infoBarRoomId.textContent = state.roomId || '----';
        if (infoBarRoomStatus) infoBarRoomStatus.textContent = state.status === 'waiting' ? '等待中' : (state.status === 'playing' ? '游戏中' : (state.gameFinished ? '已结束' : state.status));
        if(infoBarCurrentTurn) { const cP = state.players.find(p => p.userId === state.currentPlayerId); infoBarCurrentTurn.textContent = cP ? cP.username : (state.gameFinished ? '游戏结束' : 'N/A'); }

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
            myInfoInBar.classList.toggle('current-turn', state.status === 'playing' && state.currentPlayerId === myPlayer.userId && !state.gameFinished);
            myInfoInBar.classList.toggle('player-finished', !!myPlayer.finished);
            myInfoInBar.classList.toggle('player-disconnected', !myPlayer.connected);
        }

        const opponentSlotMap = {};
        if (myPlayer && state.players.length === 4) { const mySlot = myPlayer.slot; const relS = { top: (mySlot + 2) % 4, left: (mySlot + 3) % 4, right: (mySlot + 1) % 4 }; for (const pK in relS) opponentSlotMap[pK] = state.players.find(p => p.slot === relS[pK] && p.userId !== myUserId);
        } else { const oP = state.players.filter(p => p.userId !== myUserId); if (oP[0]) opponentSlotMap['top'] = oP[0]; if (oP[1]) opponentSlotMap['left'] = oP[1]; if (oP[2]) opponentSlotMap['right'] = oP[2]; }
        ['top', 'left', 'right'].forEach(pK => updateOpponentUIElement(document.getElementById(`player-${pK}`), opponentSlotMap[pK], state.currentPlayerId, state.gameFinished, state.status));

        if (myPlayer) {
            updatePlayerHandUI(myPlayer.hand, state.status === 'playing' && state.currentPlayerId === myUserId && myPlayer.connected && !myPlayer.finished, animateHandOnDisplay);
            const isWaiting = state.status === 'waiting'; const isPlaying = state.status === 'playing';
            if(readyButton) { readyButton.style.display = isWaiting && !state.gameFinished ? 'inline-block' : 'none'; readyButton.disabled = state.gameFinished || (state.players.length < 1 && isWaiting); readyButton.textContent = myPlayer.isReady ? "取消" : "准备"; readyButton.classList.toggle('cancel-ready', myPlayer.isReady); }
            [hintButton, passButton, playButton].forEach(btn => { if(btn) btn.style.display = isPlaying ? 'inline-block' : 'none'; });
            if (playButton) playButton.disabled = !(isPlaying && state.currentPlayerId === myPlayer.userId && myPlayer.connected && !myPlayer.finished);
            if (passButton) passButton.disabled = !(isPlaying && state.currentPlayerId === myPlayer.userId && myPlayer.connected && !myPlayer.finished && !state.isFirstTurn && state.lastHandInfo && (!state.lastPlayerWhoPlayedId || state.lastPlayerWhoPlayedId !== myUserId) ); // Corrected pass logic slightly
            if (hintButton) hintButton.disabled = !(isPlaying && state.currentPlayerId === myPlayer.userId && myPlayer.connected && !myPlayer.finished);
            if (micButton) micButton.disabled = state.gameFinished || !myPlayer.connected;
        } else { updatePlayerHandUI([], false, false); [readyButton, hintButton, passButton, playButton, micButton].forEach(btn => { if(btn) {btn.style.display = 'none'; btn.disabled = true;} }); }

        updateCenterPileUI(state.centerPile, state.lastHandInfo);
        if (gameOverOverlay) {
            const showOverlay = state.gameFinished;
            gameOverOverlay.style.display = showOverlay ? 'flex' : 'none';
            gameOverOverlay.classList.toggle('hidden-view', !showOverlay);
            if(showOverlay) {
                if(gameOverTitle) gameOverTitle.textContent = `游戏结束 - ${state.gameResultText || state.result || "结果未定"}`;
                if(gameOverReasonText) gameOverReasonText.textContent = state.gameOverReason || state.reason || "";
                if(gameOverScoresDiv && state.finalScores) { gameOverScoresDiv.innerHTML = ''; state.finalScores.forEach(ps => { const p = document.createElement('p'); const sc = state.scoreChanges ? (state.scoreChanges[ps.id] || 0) : 0; let cCls='score-zero'; if(sc>0)cCls='score-plus';else if(sc<0)cCls='score-minus'; p.innerHTML = `${ps.name}(${ps.role||'?'})${ps.score}<span class="${cCls}">(${sc>=0?'+':''}${sc})</span>`; gameOverScoresDiv.appendChild(p); }); }
            }
        }
    }
    function updateOpponentUIElement(areaEl, pData, cTurnPId, isGFinished, rStatus) {
        if (!areaEl) return; const nE=areaEl.querySelector('.playerName'), rE=areaEl.querySelector('.playerRole'), cE=areaEl.querySelector('.playerInfo .card-count'), readyE=areaEl.querySelector('.player-ready-status');
        if (pData) {
            areaEl.dataset.playerId = pData.userId; if(nE)nE.textContent=pData.username; if(rE)rE.textContent=pData.role?`(${pData.role})`:''; if(cE)cE.textContent=pData.handCount!==undefined?pData.handCount:'?';
            if(readyE){readyE.textContent=pData.isReady?"✓ 已准备":"✗ 未准备"; readyE.className=`player-ready-status ${pData.isReady?'ready':'not-ready'}`; readyE.style.display=rStatus==='waiting'?'inline-block':'none';}
            areaEl.classList.toggle('current-turn', rStatus==='playing' && cTurnPId===pData.userId && !isGFinished); areaEl.classList.toggle('player-finished',!!pData.finished); areaEl.classList.toggle('player-disconnected',!pData.connected); areaEl.style.opacity=pData.connected?'1':'0.5';
        } else { if(nE)nE.textContent='等待玩家...';if(rE)rE.textContent='';if(cE)cE.textContent='?';if(readyE)readyE.style.display='none'; areaEl.classList.remove('current-turn','player-finished','player-disconnected'); areaEl.removeAttribute('data-player-id');areaEl.style.opacity='0.7'; }
    }
    function updatePlayerReadyStatusUI(pUserId, isReady) { let tA; if (pUserId===myUserId)tA=document.getElementById('my-info-in-bar'); else tA=document.querySelector(`.opponent-area[data-player-id="${pUserId}"]`); if(tA){const rSE=tA.querySelector('.player-ready-status');if(rSE){rSE.textContent=isReady?"✓ 已准备":"✗ 未准备";rSE.className=`player-ready-status ${isReady?'ready':'not-ready'}`;rSE.style.display=currentRoomState&¤tRoomState.status==='waiting'?'inline-block':'none';}}}
    function updatePlayerHandUI(hCards, isMTurn, anim=false) { if(!playerHandArea)return;playerHandArea.innerHTML='';if(!hCards||hCards.length===0)return;hCards.forEach((cD,idx)=>{const cDiv=createCardElement(cD);cDiv.classList.add('my-card');if(anim){cDiv.classList.add('card-in-hand');void cDiv.offsetWidth;setTimeout(()=>cDiv.classList.add('dealt'),idx*70+50);}else cDiv.classList.add('card-in-hand','dealt');if(selectedCardsForPlay.some(sC=>cardObjectToKey(sC)===cardObjectToKey(cD)))cDiv.classList.add('selected');playerHandArea.appendChild(cDiv);if(isMTurn){cDiv.classList.add('selectable');cDiv.addEventListener('click',()=>{toggleCardSelection(cDiv,cD);if(currentHint){currentHint=null;currentHintIndexFromServer=0;highlightHintedCards([]);}});}});if(currentHint&¤tHint.length>0)highlightHintedCards(currentHint);}
    function toggleCardSelection(cDiv,cD){const cK=cardObjectToKey(cD);const idx=selectedCardsForPlay.findIndex(c=>cardObjectToKey(c)===cK);if(idx>-1){selectedCardsForPlay.splice(idx,1);cDiv.classList.remove('selected');}else{selectedCardsForPlay.push(cD);cDiv.classList.add('selected');}console.log("Selected:",selectedCardsForPlay.map(c=>c.rank+c.suit));}
    function updateCenterPileUI(cPileCards,lHInfo) { if(!discardedCardsArea)return;const lHTDisp=document.getElementById('lastHandType');discardedCardsArea.innerHTML='';let csToDisp=[];let hTMsg="等待出牌";if(lHInfo&&lHInfo.cards&&lHInfo.cards.length>0){csToDisp=lHInfo.cards;hTMsg=`类型: ${lHInfo.type||'未知'}`;}else if(cPileCards&&cPileCards.length>0&&(!lHInfo||lHInfo.cards.length===0)){csToDisp=cPileCards;hTMsg="当前出牌";}if(lHTDisp)lHTDisp.textContent=hTMsg;if(csToDisp.length>0)csToDisp.forEach(cD=>{const cDiv=createCardElement(cD);cDiv.classList.add('center-pile-card');discardedCardsArea.appendChild(cDiv);});}
    function createCardElement(cD){const cDiv=document.createElement('div');cDiv.className='card';cDiv.dataset.rank=cD.rank;cDiv.dataset.suit=cD.suit;const imgN=`${cD.suit}${cD.rank}.png`;try{cDiv.style.backgroundImage=`url('/images/cards/${imgN}')`;}catch(e){console.error("Err img:",e,imgN);cDiv.textContent=`${cD.suit}${cD.rank}`;}return cDiv;}
    if(micButton){micButton.addEventListener('mousedown',handleVoicePress);micButton.addEventListener('mouseup',handleVoiceRelease);micButton.addEventListener('mouseleave',handleVoiceRelease);micButton.addEventListener('touchstart',handleVoicePress,{passive:false});micButton.addEventListener('touchend',handleVoiceRelease);micButton.addEventListener('touchcancel',handleVoiceRelease);}
    async function handleVoicePress(evt){evt.preventDefault();if(isRecording||!currentRoomId||(currentRoomState&¤tRoomState.gameFinished))return;console.log('Mic pressed');if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){alert("浏览器不支持麦克风访问(getUserMedia不可用)。请更新浏览器或使用HTTPS/localhost。");return;}isRecording=true;audioChunks=[];if(micButton)micButton.classList.add('recording');if(socket)socket.emit('playerStartSpeaking');try{const strm=await navigator.mediaDevices.getUserMedia({audio:true});const mTs=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4'];let selMT='';for(const mT of mTs){if(MediaRecorder.isTypeSupported(mT)){selMT=mT;break;}}console.log("MIME:",selMT||'default');mediaRecorder=selMT?new MediaRecorder(strm,{mimeType:selMT}):new MediaRecorder(strm);mediaRecorder.ondataavailable=e=>{if(e.data.size>0)audioChunks.push(e.data);};mediaRecorder.onstop=()=>{console.log('Recorder stopped');if(audioChunks.length>0&¤tRoomId&&socket){const bMT=selMT||(audioChunks[0]&&audioChunks[0].type)||'application/octet-stream';const aB=new Blob(audioChunks,{type:bMT});console.log(`Sending blob type ${aB.type}, size ${aB.size}`);socket.emit('sendVoiceMessage',{roomId:currentRoomId,audioBlob:aB});}else console.log("No chunks/room/socket");audioChunks=[];if(strm)strm.getTracks().forEach(t=>t.stop());};mediaRecorder.start();console.log('Recorder started');}catch(err){console.error('Mic err:',err);alert(`麦克风错误: ${err.name} - ${err.message}\n请检查权限和HTTPS。`);isRecording=false;if(micButton)micButton.classList.remove('recording');if(socket)socket.emit('playerStopSpeaking');if(mediaRecorder&&mediaRecorder.stream)mediaRecorder.stream.getTracks().forEach(t=>t.stop());else if(err.stream)err.stream.getTracks().forEach(t=>t.stop());}}
    function handleVoiceRelease(evt){evt.preventDefault();if(!isRecording)return;console.log('Mic released');isRecording=false;if(micButton)micButton.classList.remove('recording');if(socket)socket.emit('playerStopSpeaking');if(mediaRecorder&&mediaRecorder.state==='recording')mediaRecorder.stop();else if(mediaRecorder&&mediaRecorder.stream)mediaRecorder.stream.getTracks().forEach(t=>t.stop());}
    function findSpeakingPlayerArea(sUID){if(sUID===myUserId)return document.getElementById('my-info-in-bar');return document.querySelector(`.opponent-area[data-player-id="${sUID}"]`);}
    socket.on('playerStartedSpeaking',({userId,username})=>{console.log(`${username}(${userId}) started speaking`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.add('speaking');}});
    socket.on('playerStoppedSpeaking',({userId})=>{console.log(`${userId} stopped speaking`);const pA=findSpeakingPlayerArea(userId);if(pA){const ind=pA.querySelector('.voice-indicator');if(ind)ind.classList.remove('speaking');}});
    socket.on('receiveVoiceMessage',(data)=>{console.log('Voice from:',data.userId,"type:",data.audioBlob.type,"size:",data.audioBlob.size);const{userId,audioBlob}=data;if(!(audioBlob instanceof Blob)||audioBlob.size===0){console.error("Invalid blob:",audioBlob);return;}const aUrl=URL.createObjectURL(audioBlob);const aud=new Audio(aUrl);aud.play().catch(e=>console.error('Playback err:',e));aud.onended=()=>URL.revokeObjectURL(aUrl);aud.onerror=(e)=>{console.error(`Audio err ${userId}:`,e);URL.revokeObjectURL(aUrl);};});
});
