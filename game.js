// game.js
const crypto = require('crypto');

// --- Constants for Rules ---
const RANK_ORDER = ["4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2", "3"];
const RANK_VALUES = {};
RANK_ORDER.forEach((rank, index) => { RANK_VALUES[rank] = index; });

const SUIT_ORDER = ["D", "C", "H", "S"]; // Diamond, Club, Heart, Spade (方块, 梅花, 红桃, 黑桃)
const SUIT_VALUES = {};
SUIT_ORDER.forEach((suit, index) => { SUIT_VALUES[suit] = index; });

const HAND_TYPES = {
    SINGLE: 'single', PAIR: 'pair', THREE_OF_A_KIND: 'three_of_a_kind',
    STRAIGHT: 'straight', FLUSH: 'flush', FULL_HOUSE: 'full_house',
    STRAIGHT_FLUSH: 'straight_flush'
};

const HAND_TYPE_RANKING = {
    [HAND_TYPES.SINGLE]: 1, [HAND_TYPES.PAIR]: 2, [HAND_TYPES.THREE_OF_A_KIND]: 3,
    [HAND_TYPES.STRAIGHT]: 4, [HAND_TYPES.FLUSH]: 5, [HAND_TYPES.FULL_HOUSE]: 6,
    [HAND_TYPES.STRAIGHT_FLUSH]: 7
};

// --- Helper Functions ---
function compareSingleCards(cardA, cardB) {
    const rankValueA = RANK_VALUES[cardA.rank];
    const rankValueB = RANK_VALUES[cardB.rank];
    if (rankValueA !== rankValueB) return rankValueA - rankValueB;
    return SUIT_VALUES[cardA.suit] - SUIT_VALUES[cardB.suit];
}

function compareHands(handInfoA, handInfoB) {
    // ... (保持不变)
    const typeRankA = HAND_TYPE_RANKING[handInfoA.type];
    const typeRankB = HAND_TYPE_RANKING[handInfoB.type];

    if (typeRankA !== typeRankB) return typeRankA - typeRankB;

    switch (handInfoA.type) {
        case HAND_TYPES.STRAIGHT_FLUSH:
            if (handInfoA.primaryRankValue !== handInfoB.primaryRankValue) {
                return handInfoA.primaryRankValue - handInfoB.primaryRankValue;
            }
            return SUIT_VALUES[handInfoA.representativeCard.suit] - SUIT_VALUES[handInfoB.representativeCard.suit];
        case HAND_TYPES.FULL_HOUSE:
        case HAND_TYPES.STRAIGHT:
            return handInfoA.primaryRankValue - handInfoB.primaryRankValue;
        case HAND_TYPES.FLUSH:
            for (let i = 0; i < handInfoA.cards.length; i++) {
                const rankValA = RANK_VALUES[handInfoA.cards[i].rank];
                const rankValB = RANK_VALUES[handInfoB.cards[i].rank];
                if (rankValA !== rankValB) return rankValA - rankValB;
                const suitValA = SUIT_VALUES[handInfoA.cards[i].suit];
                const suitValB = SUIT_VALUES[handInfoB.cards[i].suit];
                if (suitValA !== suitValB) return suitValA - suitValB;
            }
            return 0;
        case HAND_TYPES.THREE_OF_A_KIND:
        case HAND_TYPES.PAIR:
        case HAND_TYPES.SINGLE:
            return compareSingleCards(handInfoA.representativeCard, handInfoB.representativeCard);
        default: return 0;
    }
}


class Game {
    constructor(roomId, maxPlayers = 4) {
        // ... (大部分构造函数属性保持不变)
        this.roomId = roomId;
        this.maxPlayers = maxPlayers;
        this.players = []; // { id, name, slot, hand:[], score:0, connected: true, finished: false, role: null, isAiControlled: false }
        this.deck = [];
        this.centerPile = [];
        this.lastValidHandInfo = null;
        this.currentPlayerIndex = -1;
        this.firstTurn = true;
        this.gameStarted = false;
        this.gameFinished = false;
        this.winnerId = null;
        this.playerRoles = {};
        this.finishOrder = [];
        this.gameMode = null;
        this.consecutivePasses = 0;
        this.lastPlayerWhoPlayed = null;
        this.possibleHints = []; // 注意：这个现在也可能被AI用来找牌
        this.currentHintIndexInternal = 0;
        this.gameResultText = null;
        this.lastScoreChanges = {};
        this.aiPlayDelay = 1500; // AI出牌延迟，毫秒
    }

    // ... (addPlayer, removePlayer, markPlayerConnected 保持不变)
    addPlayer(userId, username, slot) {
        const existingPlayer = this.players.find(p => p.id === userId);
        if (existingPlayer) {
            existingPlayer.name = username;
            existingPlayer.connected = true;
            console.log(`[GAME ${this.roomId}] Player ${username} (ID: ${userId}) re-joined/updated in game instance.`);
            return true;
        }
        if (this.players.length >= this.maxPlayers) {
            console.warn(`[GAME ${this.roomId}] Cannot add player ${username}. Room full for game instance.`);
            return false;
        }
        this.players.push({
            id: userId, name: username, slot: slot, hand: [], score: 0,
            connected: true, finished: false, role: null, isAiControlled: false
        });
        this.players.sort((a, b) => a.slot - b.slot);
        console.log(`[GAME ${this.roomId}] Player ${username} added to game instance at slot ${slot}. Total: ${this.players.length}`);
        return true;
    }

    removePlayer(userId) {
        const playerIndex = this.players.findIndex(p => p.id === userId);
        if (playerIndex !== -1) {
            const removedPlayerName = this.players[playerIndex].name;
            this.players.splice(playerIndex, 1);
            console.log(`[GAME ${this.roomId}] Player ${removedPlayerName} (ID: ${userId}) fully removed from game instance.`);
            if (this.gameStarted && !this.gameFinished) {
                if (this.players.length < 2 && this.status !== 'finished') { // 通常至少需要2人
                    console.warn(`[GAME ${this.roomId}] Player removed mid-game. Game might need to be ended if not enough players.`);
                     this.endGame("玩家离开，人数不足");
                }
            }
        }
    }

    markPlayerConnected(userId, isConnected, isAiControlled = undefined) {
        const player = this.players.find(p => p.id === userId);
        if (player) {
            player.connected = !!isConnected;
            if (isAiControlled !== undefined) {
                player.isAiControlled = !!isAiControlled;
            }
            console.log(`[GAME ${this.roomId}] Player ${player.name} game status: connected=${player.connected}, AI=${player.isAiControlled}`);
            if (!isConnected && !player.isAiControlled && this.gameStarted && !this.gameFinished && this.players[this.currentPlayerIndex]?.id === userId) {
                console.log(`[GAME ${this.roomId}] Current human player ${player.name} disconnected.`);
                // nextTurn() 会跳过他们
            }
        }
    }


    setPlayerAI(userId, isAiControlled) {
        const player = this.players.find(p => p.id === userId);
        if (player) {
            player.isAiControlled = !!isAiControlled;
            console.log(`[GAME ${this.roomId}] Player ${player.name} AI control set to: ${player.isAiControlled}`);
            // 如果轮到该AI玩家，并且游戏正在进行，则应触发AI行动
            // 这个触发逻辑最好放在 roomManager 中，在收到 gameStateUpdate 后检查当前玩家是否是AI
        }
    }

    // ... (startGame 保持不变)
    startGame(playerStartInfo) {
        this.deck = []; this.centerPile = []; this.lastValidHandInfo = null;
        this.currentPlayerIndex = -1; this.firstTurn = true; this.gameStarted = false;
        this.gameFinished = false; this.winnerId = null; this.playerRoles = {};
        this.finishOrder = []; this.gameMode = null; this.consecutivePasses = 0;
        this.lastPlayerWhoPlayed = null; this.possibleHints = []; this.currentHintIndexInternal = 0;
        this.gameResultText = null; this.lastScoreChanges = {};

        if (!playerStartInfo || playerStartInfo.length < 2 || playerStartInfo.length > this.maxPlayers) { // 至少需要2人
            return { success: false, message: `需要 ${this.maxPlayers} 位玩家 (至少2位)。当前 ${playerStartInfo ? playerStartInfo.length : 0} 位。` };
        }

        this.players = playerStartInfo.map(info => ({
            id: info.id, name: info.name, slot: info.slot, hand: [],
            score: info.score || 0, connected: true,
            finished: false, role: null, isAiControlled: !!info.isAiControlled
        })).sort((a, b) => a.slot - b.slot);

        console.log(`[GAME ${this.roomId}] Starting game with players:`, this.players.map(p => `${p.name}(Slot:${p.slot}, AI:${p.isAiControlled})`));
        this.createDeck(); this.shuffleDeck(); this.dealCards(13);

        this.gameStarted = true; this.firstTurn = true;

        // "KK" specific role assignment
        if (this.maxPlayers === 4) { // 假设KK规则主要用于4人
            let s3PlayerId = null, saPlayerId = null;
            this.players.forEach(p => {
                if (p.hand.some(c => c.suit === 'S' && c.rank === '3')) s3PlayerId = p.id;
                if (p.hand.some(c => c.suit === 'S' && c.rank === 'A')) saPlayerId = p.id;
            });

            if (!s3PlayerId || !saPlayerId) {
                console.error(`[GAME ${this.roomId}] CRITICAL: S3 or SA not found for 4-player KK mode. Aborting start.`);
                this.gameStarted = false;
                return { success: false, message: "发牌错误，未找到黑桃3或黑桃A。" };
            }

            if (s3PlayerId === saPlayerId) {
                this.gameMode = 'double_landlord';
                this.players.forEach(p => { p.role = (p.id === s3PlayerId) ? 'DD' : 'F'; this.playerRoles[p.id] = p.role; });
            } else {
                this.gameMode = 'standard';
                this.players.forEach(p => { p.role = (p.id === s3PlayerId || p.id === saPlayerId) ? 'D' : 'F'; this.playerRoles[p.id] = p.role; });
            }
            console.log(`[GAME ${this.roomId}] KK Mode: ${this.gameMode}. Roles:`, JSON.stringify(this.playerRoles));
        } else {
            this.gameMode = 'generic'; // 或其他非KK模式的名称
            this.players.forEach(p => { p.role = 'P'; this.playerRoles[p.id] = p.role; }); // 普通玩家
            console.log(`[GAME ${this.roomId}] Generic Mode. Roles assigned as 'P'.`);
        }


        let startingPlayerIndex = -1;
        for (let i = 0; i < this.players.length; i++) {
            if (this.players[i].hand.some(card => card.suit === 'D' && card.rank === '4')) {
                startingPlayerIndex = i; break;
            }
        }

        if (startingPlayerIndex === -1) {
            // Fallback: if D4 not found (e.g. <4 players or unusual deal), first player in sorted list starts.
            // This might happen if deck isn't full 52 cards for fewer players.
            // For a robust game, ensure D4 is always dealt or have a clear rule.
            // Forcing D4 to be dealt to someone or picking first active player if D4 truly missing.
            console.warn(`[GAME ${this.roomId}] Diamond 4 not found. Defaulting to first player.`);
            startingPlayerIndex = 0; // Or find first active player
        }
        this.currentPlayerIndex = startingPlayerIndex;
        this.lastPlayerWhoPlayed = null;

        console.log(`[GAME ${this.roomId}] Player ${this.players[this.currentPlayerIndex].name} starts.`);
        return { success: true };
    }

    playCard(playerId, cards) {
        // ... (前部分校验保持不变)
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };

        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayerIndex) {
            return { success: false, message: "非当前玩家或回合错误。" };
        }

        const player = this.players[playerIndex];
        // AI也需要满足connected为true (在服务器内部AI总是"connected")
        // if (!player.connected && !player.isAiControlled) return { success: false, message: "您已断线。" };
        if (player.finished) return { success: false, message: "您已出完牌。" };
        if (!Array.isArray(cards) || cards.length === 0) return { success: false, message: "未选择牌。" };

        const handSet = new Set(player.hand.map(c => `${c.rank}${c.suit}`));
        if (!cards.every(card => handSet.has(`${card.rank}${card.suit}`))) {
            return { success: false, message: "选择的牌不在手中。" };
        }

        const validationResult = this.checkValidPlay(cards, player.hand, this.lastValidHandInfo, this.firstTurn);
        if (!validationResult.valid) return { success: false, message: validationResult.message };

        // ... (后续逻辑保持不变)
        const cardsToRemoveSet = new Set(cards.map(c => `${c.rank}${c.suit}`));
        player.hand = player.hand.filter(card => !cardsToRemoveSet.has(`${card.rank}${card.suit}`));

        this.centerPile = [...cards]; this.lastValidHandInfo = validationResult.handInfo;
        this.lastPlayerWhoPlayed = playerId; this.consecutivePasses = 0;
        if (this.firstTurn) this.firstTurn = false;

        console.log(`[GAME ${this.roomId}] ${player.name} played ${this.lastValidHandInfo.type}: ${cards.map(c=>c.rank+c.suit).join(',')}. Left: ${player.hand.length}`);
        this.possibleHints = []; this.currentHintIndexInternal = 0;

        let gameOver = false; let scoreResult = null;
        if (player.hand.length === 0) {
            this.finishOrder.push(playerId); player.finished = true;
            if (!this.winnerId) this.winnerId = playerId;
            console.log(`[GAME ${this.roomId}] ${player.name} finished. Order: ${this.finishOrder.join(', ')}.`);

            const instantResult = this.checkInstantGameOver();
            if (instantResult.isOver) {
                gameOver = true; scoreResult = this.calculateScoresBasedOnResult(instantResult.resultDescription);
                this.gameFinished = true; this.gameStarted = false;
                console.log(`[GAME ${this.roomId}] Game ended early: ${instantResult.resultDescription}`);
            } else if (this.finishOrder.length >= this.players.length - 1) {
                 const remaining = this.players.filter(p => !p.finished);
                 if (remaining.length === 1) { this.finishOrder.push(remaining[0].id); remaining[0].finished = true; }
                 gameOver = true;
                 const finalInstantResult = this.checkInstantGameOver(); // Re-check after last player finishes
                 scoreResult = this.calculateScoresBasedOnResult(finalInstantResult.isOver ? finalInstantResult.resultDescription : "打平 (所有玩家完成)");
                 this.gameFinished = true; this.gameStarted = false;
                 console.log(`[GAME ${this.roomId}] All players finished. Result: ${scoreResult.result}`);
            }
        }

        if (gameOver) {
            this.lastScoreChanges = scoreResult.scoreChanges;
            return { success: true, gameOver: true, scoreResult: scoreResult, handInfo: this.lastValidHandInfo };
        } else if (player.finished) {
            this.nextTurn(true);
            return { success: true, playerFinished: true, handInfo: this.lastValidHandInfo };
        } else {
            this.nextTurn();
            return { success: true, handInfo: this.lastValidHandInfo };
        }
    }

    handlePass(playerId) {
        // ... (校验保持不变)
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayerIndex) return { success: false, message: "非当前玩家或回合错误。" };
        const player = this.players[playerIndex];
        // if (!player.connected && !player.isAiControlled) return { success: false, message: "您已断线。" };
        if (player.finished) return { success: false, message: "您已出完牌。" };
        if (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) return { success: false, message: "本轮首出或上个出牌者，必须出牌。" };


        console.log(`[GAME ${this.roomId}] ${player.name} passed.`);
        this.consecutivePasses++; this.possibleHints = []; this.currentHintIndexInternal = 0;

        // 考虑AI玩家也算活跃玩家
        const activePlayersNotFinished = this.players.filter(p => !p.finished).length;

        if (this.lastPlayerWhoPlayed && activePlayersNotFinished > 1 && this.consecutivePasses >= activePlayersNotFinished - 1) {
            console.log(`[GAME ${this.roomId}] All others passed. New round for ${this.players.find(p => p.id === this.lastPlayerWhoPlayed)?.name}.`);
            this.resetTurnState();
            const lastPlayerIdx = this.players.findIndex(p => p.id === this.lastPlayerWhoPlayed);
            const lastPlayerObj = this.players[lastPlayerIdx];
            if (lastPlayerObj && !lastPlayerObj.finished) { // AI或人类玩家都可以开始新一轮
                this.currentPlayerIndex = lastPlayerIdx;
            } else { // 如果最后出牌的人也恰好完成了，则从他之后开始
                 this.currentPlayerIndex = lastPlayerIdx; this.nextTurn(true);
            }
            this.lastPlayerWhoPlayed = null;
        } else if (activePlayersNotFinished <= 1 && this.lastPlayerWhoPlayed) {
             console.log(`[GAME ${this.roomId}] Only one active player potentially. New round for ${this.players.find(p => p.id === this.lastPlayerWhoPlayed)?.name}.`);
             this.resetTurnState();
             this.currentPlayerIndex = this.players.findIndex(p => p.id === this.lastPlayerWhoPlayed);
             this.lastPlayerWhoPlayed = null;
        } else {
            this.nextTurn();
        }
        return { success: true };
    }

    resetTurnState() {
        // ... (保持不变)
        this.centerPile = []; this.lastValidHandInfo = null; this.consecutivePasses = 0;
        console.log(`[GAME ${this.roomId}] Turn state reset.`);
    }

    nextTurn(forceAdvanceDueToFinish = false) {
        // ... (大部分逻辑保持不变，确保AI也被视为可轮转的玩家)
         if (this.gameFinished && !forceAdvanceDueToFinish) return;
         const numPlayers = this.players.length;
         if (numPlayers === 0) { this.currentPlayerIndex = -1; return; }

         let currentIdx = this.currentPlayerIndex;
         if (currentIdx === -1 || !this.players[currentIdx]) {
             let foundStartIdx = -1;
             // AI 也算 active
             for(let i=0; i < numPlayers; i++) {
                 if (this.players[i] && !this.players[i].finished) {
                     foundStartIdx = i; break;
                 }
             }
             if (foundStartIdx !== -1) currentIdx = foundStartIdx -1;
             else {
                 console.warn(`[GAME ${this.roomId}] nextTurn: No active players for turn init.`);
                 this.currentPlayerIndex = -1;
                 if (this.gameStarted && !this.gameFinished && this.players.every(p => p.finished || (!p.connected && !p.isAiControlled))) { // 注意这里可能需要调整，AI算不算强制结束的条件
                     this.endGame("No active players remaining for turn.");
                 }
                 return;
             }
         }

         let nextIdx = currentIdx; let loopDetection = 0; const maxLoops = numPlayers * 2 + 2;
         do {
              nextIdx = (nextIdx - 1 + numPlayers) % numPlayers; // Counter-clockwise
              loopDetection++;
              if (loopDetection > maxLoops) {
                   console.error(`[GAME ${this.roomId}] Infinite loop in nextTurn! Halting. Idx:${currentIdx}`, this.players.map(p=>({n:p.name,f:p.finished,c:p.connected,ai:p.isAiControlled})));
                   this.currentPlayerIndex = -1;
                   if (this.gameStarted && !this.gameFinished) this.endGame("Turn Advancement Error");
                   return;
              }
         } while ( !this.players[nextIdx] || this.players[nextIdx].finished ); // AI玩家总是"connected"

         this.currentPlayerIndex = nextIdx;
         const nextPlayer = this.players[this.currentPlayerIndex];
         console.log(`[GAME ${this.roomId}] Turn: ${nextPlayer?.name} (Slot:${nextPlayer?.slot}, Idx:${this.currentPlayerIndex}, AI: ${nextPlayer?.isAiControlled}).`);
         this.possibleHints = []; this.currentHintIndexInternal = 0;
    }

    findHint(playerId, clientHintIndex = 0, forAI = false) { // 新增 forAI 参数
        // ... (校验保持不变)
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIdx = this.players.findIndex(p => p.id === playerId);

        // AI 调用时，playerIdx 可能不是 currentPlayerIndex，但 player 必须存在
        if (!forAI && (playerIdx === -1 || playerIdx !== this.currentPlayerIndex)) {
            return { success: false, message: "非当前回合。" };
        }
        if (playerIdx === -1) return { success: false, message: "找不到玩家。" };

        const player = this.players[playerIdx];
        if (!player || player.finished) return { success: false, message: "无效玩家状态。" };
        // AI不需要检查 connected
        if (!forAI && !player.connected && !player.isAiControlled) return {success: false, message: "玩家断线"};


        // 如果是给人类玩家的提示，并且已有缓存且是同一个人请求，可以复用
        if (!forAI && this.possibleHints.length > 0 && this.possibleHints[0].forPlayerId === playerId) {
             let actualHintIdxToShow = clientHintIndex % this.possibleHints.length;
             this.currentHintIndexInternal = actualHintIdxToShow;
             const nextServerIdx = (actualHintIdxToShow + 1) % this.possibleHints.length;
             return { success: true, hint: this.possibleHints[actualHintIdxToShow].cards, handInfo: this.possibleHints[actualHintIdxToShow].handInfo, nextHintIndex: nextServerIdx };
        }

        // (重新)计算可能的出牌
        let availablePlays = [];
        const hand = player.hand;

        // 1. 单张
        for (const card of hand) {
            const val = this.checkValidPlay([card], hand, this.lastValidHandInfo, this.firstTurn);
            if (val.valid) availablePlays.push({ cards: [card], handInfo: val.handInfo });
        }
        // 2. 对子
        const ranksInHand = {}; hand.forEach(c => ranksInHand[c.rank] = (ranksInHand[c.rank] || 0) + 1);
        for (const rank in ranksInHand) {
            if (ranksInHand[rank] >= 2) {
                const pair = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 2);
                const val = this.checkValidPlay(pair, hand, this.lastValidHandInfo, this.firstTurn);
                if (val.valid) availablePlays.push({ cards: pair, handInfo: val.handInfo });
            }
        // 3. 三条 (不带牌，因为KK规则里没有三带一/二)
            if (ranksInHand[rank] >= 3) {
                const three = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 3);
                const val = this.checkValidPlay(three, hand, this.lastValidHandInfo, this.firstTurn);
                if (val.valid) availablePlays.push({ cards: three, handInfo: val.handInfo });
            }
        }

        // 4. 顺子 (5张) - 简化版：穷举所有5张牌组合，检查是否为顺子
        if (hand.length >= 5) {
            const fiveCardCombinations = this.generateCombinations(hand, 5);
            for (const combo of fiveCardCombinations) {
                const val = this.checkValidPlay(combo, hand, this.lastValidHandInfo, this.firstTurn);
                if (val.valid && val.handInfo.type === HAND_TYPES.STRAIGHT) {
                    availablePlays.push({ cards: combo, handInfo: val.handInfo });
                }
            }
        }
        // 5. 同花 (5张) - 简化版
        if (hand.length >= 5) {
            // 查找手牌中数量 >=5 的花色
            const suitCounts = {}; SUIT_ORDER.forEach(s => suitCounts[s] = []);
            hand.forEach(c => suitCounts[c.suit].push(c));
            for (const suit in suitCounts) {
                if (suitCounts[suit].length >= 5) {
                    const flushCardsFromSuit = suitCounts[suit];
                    const fiveCardCombinationsOfSuit = this.generateCombinations(flushCardsFromSuit, 5);
                    for (const combo of fiveCardCombinationsOfSuit) {
                         const val = this.checkValidPlay(combo, hand, this.lastValidHandInfo, this.firstTurn);
                         if (val.valid && val.handInfo.type === HAND_TYPES.FLUSH) {
                             availablePlays.push({ cards: combo, handInfo: val.handInfo });
                         }
                    }
                }
            }
        }
        // 6. 葫芦 (3带2) - 简化版
        if (hand.length >= 5) {
            const threeOfAKinds = [];
            const pairs = [];
            for (const rank in ranksInHand) {
                if (ranksInHand[rank] >= 3) {
                    threeOfAKinds.push(hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 3));
                }
                if (ranksInHand[rank] >= 2) {
                    pairs.push(hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 2));
                }
            }
            for (const three of threeOfAKinds) {
                for (const pair of pairs) {
                    if (three[0].rank === pair[0].rank) continue; // 三条和对子不能是相同点数
                    const fullHouseCombo = [...three, ...pair].sort(compareSingleCards);
                    const val = this.checkValidPlay(fullHouseCombo, hand, this.lastValidHandInfo, this.firstTurn);
                    if (val.valid && val.handInfo.type === HAND_TYPES.FULL_HOUSE) {
                        availablePlays.push({ cards: fullHouseCombo, handInfo: val.handInfo });
                    }
                }
            }
        }
        // 7. 同花顺 - 简化版 (在找到的顺子和同花中检查)
        // 可以在生成顺子和同花后，再检查它们是否同时满足同花顺条件。
        // 或者在生成5张牌组合时，直接检查是否为同花顺。
        if (hand.length >= 5) {
            const fiveCardCombinations = this.generateCombinations(hand, 5); // Re-use if not done above
            for (const combo of fiveCardCombinations) {
                const val = this.checkValidPlay(combo, hand, this.lastValidHandInfo, this.firstTurn);
                if (val.valid && val.handInfo.type === HAND_TYPES.STRAIGHT_FLUSH) {
                    availablePlays.push({ cards: combo, handInfo: val.handInfo });
                }
            }
        }
        
        // 去重可能的重复组合（例如，不同花色的对子但handInfo一样）
        const uniquePlaysMap = new Map();
        availablePlays.forEach(play => {
            // 创建一个基于牌型和代表牌的唯一键，以避免因花色不同但牌力相同的低级牌型被重复多次
            // 对于高级牌型，它们的比较逻辑本身就复杂，排序即可
            const key = `${play.handInfo.type}-${play.cards.map(c => c.rank + c.suit).sort().join('')}`;
            if (!uniquePlaysMap.has(key)) {
                uniquePlaysMap.set(key, play);
            }
        });
        availablePlays = Array.from(uniquePlaysMap.values());


        // 按牌力从小到大排序
        availablePlays.sort((a, b) => compareHands(a.handInfo, b.handInfo));

        if (forAI) { // 如果是为AI找牌，直接返回所有可出牌
            return availablePlays; // 返回数组 [{cards, handInfo}, ...]
        }

        this.possibleHints = availablePlays.map(play => ({ ...play, forPlayerId: playerId })); // 缓存给人类玩家

        if (this.possibleHints.length > 0) {
             this.currentHintIndexInternal = clientHintIndex % this.possibleHints.length; // Use client's idea of index
             const hintToShow = this.possibleHints[this.currentHintIndexInternal];
             const nextServerIdx = (this.currentHintIndexInternal + 1) % this.possibleHints.length;
             return { success: true, hint: hintToShow.cards, handInfo: hintToShow.handInfo, nextHintIndex: nextServerIdx };
        }
        return { success: false, message: "没有可出的牌。", nextHintIndex: 0 };
    }

    // 辅助函数：生成组合 (用于查找5张牌牌型)
    generateCombinations(arr, k) {
        if (k < 0 || k > arr.length) return [];
        if (k === 0) return [[]];
        if (k === arr.length) return [[...arr]];
        if (k === 1) return arr.map(item => [item]);

        const combs = [];
        const head = arr[0];
        const tail = arr.slice(1);

        // Combinations that include the head
        const combsWithHead = this.generateCombinations(tail, k - 1);
        combsWithHead.forEach(subComb => {
            combs.push([head, ...subComb]);
        });

        // Combinations that don't include the head
        const combsWithoutHead = this.generateCombinations(tail, k);
        combs.push(...combsWithoutHead);

        return combs;
    }


    // AI 决策逻辑
    decideAiPlay(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (!player || !player.isAiControlled || player.finished) {
            return { action: 'pass' }; // 不应该发生，但作为保险
        }

        // 1. 获取所有合法出牌
        const availablePlays = this.findHint(playerId, 0, true); // forAI = true

        if (availablePlays.length === 0) {
            // 如果没有牌可以出，且不是必须出牌（即不是新一轮的开始者），则过牌
            if (this.lastValidHandInfo && this.lastPlayerWhoPlayed !== playerId) {
                console.log(`[AI ${player.name}] No valid plays to beat last hand. Passing.`);
                return { action: 'pass' };
            } else if (!this.lastValidHandInfo) {
                // AI是新一轮的开始者，但findHint没找到任何牌（理论上不可能，除非一手烂牌且规则限制）
                // 这种情况非常罕见，按理说单张总能出。如果发生，可能需要更复杂的逻辑，或者视为游戏bug。
                // 为简单起见，如果它必须出牌但找不到，这暗示一个问题，但我们还是让它尝试出最小的单张。
                // 但 findHint 应该已经包含了单张。所以 length === 0 意味着真的没法出。
                // 这种情况在“必须包含方块4”的首轮可能发生，如果AI没有方块4且是它出。
                // 但正常情况下，首轮有方块4的玩家先出。
                console.warn(`[AI ${player.name}] Must play (new round) but findHint found no plays. This is unusual.`);
                // 也许是因为首轮必须出方块4，而AI没有。
                // 这种情况下AI应该过牌（如果规则允许其他人补上含方块4的牌）或者游戏逻辑有误
                // 假设首轮必须出牌，且AI有方块4但findHint没找到（例如findHint的bug），这里我们先让它pass
                // 但如果它是当前轮次第一个出牌（this.lastValidHandInfo为null），按规则是不能pass的。
                // 这是一个需要根据游戏具体规则细化的点。
                // 对于大老二，如果轮到你出，且场上没牌，你必须出。
                // 所以如果availablePlays为空，说明findHint实现可能有遗漏。
                // 假设findHint总是能找到至少一个单张（除非手牌空了，但player.finished会处理）
                if (this.firstTurn && !player.hand.some(c => c.rank === '4' && c.suit === 'D')) {
                    console.log(`[AI ${player.name}] First turn, doesn't have D4. Passing (if allowed by others).`);
                    // 实际上，如果首轮必须包含方块4，而当前AI没有，它不能主动出牌。
                    // 此时它的行为应该是“pass”，等待有方块4的玩家出牌。
                    // 但如果它就是被指定为第一个出牌的（例如，它自己有方块4但findhint没找到），那它就卡住了。
                    // 我们假设轮到它出，且它没有方块4（在首轮），它应该pass。
                    // 但如果它有方块4，findhint应该能找到。
                    // 此处简化：如果首轮轮到它，但它没有可打的牌（含方块4），它就pass。
                    // 这需要`handlePass`能处理首轮pass的情况（通常不允许）。
                    // 因此，更合理的做法是：如果首轮轮到AI，它必须出含方块4的牌。
                    // 如果它没有方块4，则findHint根本找不到合法牌。
                    // 如果它有方块4，findHint应该能找到。
                    // 所以，如果availablePlays为空，意味着它真的无法出牌。
                    // 这时它应该pass（如果不是轮空后它必须出牌的情况）。
                    if (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) { // AI是新一轮开始者
                        // 这种情况不应该发生，因为总能出单张，除非首轮方块4限制
                        // 除非 findHint 的 checkValidPlay 对于首轮需要方块4的处理不当
                        console.error(`[AI ${player.name}] CRITICAL: Must play, but no available plays found by AI. Hand:`, player.hand.map(c=>c.rank+c.suit));
                        // 紧急情况：随便出一张最小的牌，忽略方块4规则 (非常不推荐，但避免卡死)
                        // this.sortHand(player.hand);
                        // const emergencyPlay = this.getHandInfo([player.hand[0]]);
                        // if (emergencyPlay.isValid) return { action: 'play', cards: [player.hand[0]], handInfo: emergencyPlay };
                        // 否则只能pass，但这可能违反规则
                        return {action: 'pass'}; // 可能导致错误，但比崩溃好
                    }
                    return { action: 'pass' };
                }
                 // 如果不是首轮，且 AI 是新一轮开始者，availablePlays 不应为空
            }
        }
        
        // AI出牌策略:
        // 1. 如果是自己开始新一轮 (lastValidHandInfo is null, or lastPlayerWhoPlayed is self)
        //    或者上家是自己打的然后所有人都pass了
        if (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) {
            // 简单策略：打出手中能打出的最小的牌型（通常是单张或对子）
            // availablePlays 已经按牌力从小到大排序
            const playToMake = availablePlays[0];
            console.log(`[AI ${player.name}] Starting new round, playing smallest valid hand: ${playToMake.handInfo.type} - ${playToMake.cards.map(c=>c.rank+c.suit).join(',')}`);
            return { action: 'play', cards: playToMake.cards, handInfo: playToMake.handInfo };
        } else {
            // 2. 尝试打过上家的牌
            // availablePlays 已经按牌力从小到大排序，并且只包含能打过上家的牌
            // AI选择能打过上家的最小的一手牌
            if (availablePlays.length > 0) {
                const playToMake = availablePlays[0]; // 第一个是最小的能压过对方的牌
                console.log(`[AI ${player.name}] Beating previous hand with: ${playToMake.handInfo.type} - ${playToMake.cards.map(c=>c.rank+c.suit).join(',')}`);
                return { action: 'play', cards: playToMake.cards, handInfo: playToMake.handInfo };
            } else {
                // 没有能打过上家的牌，则过牌
                console.log(`[AI ${player.name}] Cannot beat previous hand. Passing.`);
                return { action: 'pass' };
            }
        }
    }

    // ... (getHandInfo, checkValidPlay 保持不变)
    // 注意：getHandInfo 中的顺子逻辑仍然需要修复才能让AI正确识别和打出顺子
    getHandInfo(cards) {
        if (!Array.isArray(cards) || cards.length === 0) return { isValid: false, message: "无效输入" };
        const n = cards.length;
        const sortedCards = [...cards].sort(compareSingleCards);

        const suits = new Set(sortedCards.map(c => c.suit));
        const ranks = sortedCards.map(c => c.rank);
        const rankValues = sortedCards.map(c => RANK_VALUES[c.rank]); // 0-12
        const isFlush = suits.size === 1;
        let isStraight = false, straightPrimaryRankValue = -1, straightRepCard = null;

        // --- IMPORTANT: STRAIGHT LOGIC NEEDS TO BE CORRECT FOR "KK" or BIG TWO RULES ---
        // The current RANK_VALUES based arithmetic (uniqueRankValsSortedAsc[4] - uniqueRankValsSortedAsc[0] === 4)
        // is likely incorrect for your game's specific rank order (e.g., 2-3-4-5-6 being a valid low straight).
        // This needs a dedicated fix. For now, AI relying on this might make mistakes with straights.
        // Placeholder for corrected straight logic:
        if (n === 5) {
            // Example of how one might check for 2-3-4-5-6 (lowest straight)
            const has2 = ranks.includes("2"); const has3 = ranks.includes("3");
            const has4 = ranks.includes("4"); const has5 = ranks.includes("5"); const has6 = ranks.includes("6");
            if (has2 && has3 && has4 && has5 && has6 && new Set(ranks).size === 5) {
                isStraight = true;
                // For 2-3-4-5-6, the representative card is 6, primary rank value is RANK_VALUES['6']
                straightPrimaryRankValue = RANK_VALUES['6'];
                straightRepCard = sortedCards.find(c => c.rank === '6') || sortedCards[n-1]; // Find the 6
            } else {
                // Check for "normal" straights (excluding A-2-3-4-5 as per your comment)
                // This part still needs to use RANK_ORDER correctly, not just RANK_VALUES arithmetic.
                // A robust way is to check if the ranks are consecutive in RANK_ORDER.
                let consecutive = true;
                const cardRankIndices = sortedCards.map(c => RANK_ORDER.indexOf(c.rank));
                for (let i = 0; i < cardRankIndices.length - 1; i++) {
                    if (cardRankIndices[i+1] - cardRankIndices[i] !== 1) {
                        consecutive = false;
                        break;
                    }
                }
                // Handle A-K-Q-J-T (A is high)
                if (!consecutive && ranks.includes('A') && ranks.includes('K') && ranks.includes('Q') && ranks.includes('J') && ranks.includes('T') && new Set(ranks).size === 5) {
                     // Ranks are T, J, Q, K, A. Sorted RANK_ORDER indices: 6,7,8,9,10
                     // This should be caught by the consecutive check if RANK_VALUES were aligned or if using RANK_ORDER indices.
                     // Let's assume for now the consecutive check works for T-A
                     const tIndex = RANK_ORDER.indexOf('T');
                     const aIndex = RANK_ORDER.indexOf('A');
                     let isTtoA = true;
                     const tToAIndices = sortedCards.map(c => RANK_ORDER.indexOf(c.rank)).sort((a,b)=>a-b);
                     if (tToAIndices[0] === RANK_ORDER.indexOf('T') &&
                         tToAIndices[1] === RANK_ORDER.indexOf('J') &&
                         tToAIndices[2] === RANK_ORDER.indexOf('Q') &&
                         tToAIndices[3] === RANK_ORDER.indexOf('K') &&
                         tToAIndices[4] === RANK_ORDER.indexOf('A')) {
                            isStraight = true;
                            straightPrimaryRankValue = RANK_VALUES['A']; // 'A' is highest in T-A straight
                            straightRepCard = sortedCards.find(c => c.rank === 'A') || sortedCards[n-1];
                     } else {
                         // General consecutive check (excluding A-2-3-4-5 which is not allowed)
                        let allUniqueRanks = [...new Set(ranks)];
                        if(allUniqueRanks.length === 5) {
                            let rankOrderIndices = allUniqueRanks.map(r => RANK_ORDER.indexOf(r)).sort((a,b) => a-b);
                            let isNormalStraight = true;
                            for(let i=0; i < rankOrderIndices.length - 1; i++) {
                                if (rankOrderIndices[i+1] - rankOrderIndices[i] !== 1) {
                                    isNormalStraight = false;
                                    break;
                                }
                            }
                            // Ensure it's not the A-2-3-4-5 sequence if that's disallowed
                            const isA2345 = ranks.includes('A') && ranks.includes('2') && ranks.includes('3') && ranks.includes('4') && ranks.includes('5');
                            if (isNormalStraight && !isA2345) { // Assuming A2345 is not a straight
                                isStraight = true;
                                straightPrimaryRankValue = RANK_VALUES[sortedCards[n-1].rank]; // Highest card's rank value
                                straightRepCard = sortedCards[n-1];
                            }
                        }
                     }
                } else if (consecutive) { // If the simple consecutive check already passed for non T-A straights
                    isStraight = true;
                    straightPrimaryRankValue = RANK_VALUES[sortedCards[n-1].rank];
                    straightRepCard = sortedCards[n-1];
                }
            }
        }
        // --- END OF STRAIGHT LOGIC (NEEDS THOROUGH TESTING AND REFINEMENT) ---

        const rankCounts = {}; ranks.forEach(r => { rankCounts[r] = (rankCounts[r] || 0) + 1; });
        const counts = Object.values(rankCounts).sort((a, b) => b - a);
        const distinctRanksByVal = Object.keys(rankCounts).sort((rA, rB) => RANK_VALUES[rA] - RANK_VALUES[rB]);

        if (n === 5 && isStraight && isFlush) {
            const compareSorted = [...sortedCards].sort((a,b)=>compareSingleCards(b,a));
            return { isValid: true, type: HAND_TYPES.STRAIGHT_FLUSH, cards: compareSorted, primaryRankValue: straightPrimaryRankValue, suitValue: SUIT_VALUES[straightRepCard.suit], representativeCard: straightRepCard };
        }
        if (n === 5 && counts[0] === 3 && counts.length >=2 && counts[1] === 2) {
            const threeRank = Object.keys(rankCounts).find(r => rankCounts[r] === 3);
            const repCard = sortedCards.filter(c => c.rank === threeRank).sort(compareSingleCards)[2];
            return { isValid: true, type: HAND_TYPES.FULL_HOUSE, cards: sortedCards, primaryRankValue: RANK_VALUES[threeRank], representativeCard: repCard };
        }
        if (n === 5 && isFlush) {
            const compareSorted = [...sortedCards].sort((a,b)=>compareSingleCards(b,a));
            return { isValid: true, type: HAND_TYPES.FLUSH, cards: compareSorted, representativeCard: sortedCards[n-1], primaryRankValue: RANK_VALUES[sortedCards[n-1].rank] };
        }
        if (n === 5 && isStraight) {
            return { isValid: true, type: HAND_TYPES.STRAIGHT, cards: sortedCards, primaryRankValue: straightPrimaryRankValue, representativeCard: straightRepCard };
        }
        if (n === 3 && counts[0] === 3) {
            const threeRank = Object.keys(rankCounts).find(r => rankCounts[r] === 3);
            return { isValid: true, type: HAND_TYPES.THREE_OF_A_KIND, cards: sortedCards, representativeCard: sortedCards[2], primaryRankValue: RANK_VALUES[threeRank] };
        }
        if (n === 2 && counts[0] === 2) {
            const pairRank = Object.keys(rankCounts).find(r => rankCounts[r] === 2);
            return { isValid: true, type: HAND_TYPES.PAIR, cards: sortedCards, representativeCard: sortedCards[1], primaryRankValue: RANK_VALUES[pairRank] };
        }
        if (n === 1) {
            return { isValid: true, type: HAND_TYPES.SINGLE, cards: sortedCards, representativeCard: sortedCards[0], primaryRankValue: RANK_VALUES[sortedCards[0].rank] };
        }
        if (counts[0] === 4 && (n === 4 || n === 5)) {
             if (n === 4) return { isValid: false, message: "不允许四条炸弹 (当前规则)。" };
             if (n === 5) return { isValid: false, message: "不允许四带一 (非标准牌型)。" };
        }
        return { isValid: false, message: "无法识别的牌型。" };
     }

    checkValidPlay(cardsToPlay, currentHand, lastPlayedHandInfo, isFirstTurn) {
        // ... (保持不变)
         const newHandInfo = this.getHandInfo(cardsToPlay);
         if (!newHandInfo.isValid) return { valid: false, message: newHandInfo.message };
         if (isFirstTurn) {
             if (!cardsToPlay.some(c => c.suit === 'D' && c.rank === '4')) return { valid: false, message: "首回合必须包含方块4。" };
             return { valid: true, handInfo: newHandInfo };
         }
         if (!lastPlayedHandInfo) return { valid: true, handInfo: newHandInfo };
         if (newHandInfo.type !== lastPlayedHandInfo.type) return { valid: false, message: `必须出同类型牌 (${lastPlayedHandInfo.type})。` };
         if (newHandInfo.cards.length !== lastPlayedHandInfo.cards.length) return { valid: false, message: `牌数量必须一致 (${lastPlayedHandInfo.cards.length}张)。`};
         if (compareHands(newHandInfo, lastPlayedHandInfo) > 0) return { valid: true, handInfo: newHandInfo };
         return { valid: false, message: `打出的 ${newHandInfo.type} 必须大于上家。` };
     }


    // ... (checkInstantGameOver, calculateScoresBasedOnResult, calculateScores, endGame, createDeck, shuffleDeck, dealCards, sortHand 保持不变)
    checkInstantGameOver() {
        const nFinished = this.finishOrder.length;
        const totalPlayers = this.players.length;
        if (totalPlayers < 2) return {isOver: false}; // Not enough players to determine outcome

        if (!this.gameStarted && !this.gameFinished && nFinished === 0) return {isOver: false};

        // For 2-player games (or if only 2 remain effectively)
        if (totalPlayers <= 2) { // This part needs to align with KK specific rules for 2p
            if (nFinished >= 1) {
                const winner = this.players.find(p => p.id === this.finishOrder[0]);
                if (!winner) return {isOver: false};
                if (this.gameMode === 'standard' || this.gameMode === 'generic') { // Generic mode wins
                    return {isOver: true, resultDescription: `${winner.name} 胜`};
                } else if (this.gameMode === 'double_landlord') { // KK specific
                    return {isOver: true, resultDescription: winner.role === 'DD' ? "双地主大胜" : "农民胜"};
                }
            }
            return {isOver: false};
        }

        // For >2 players (KK specific logic)
        if (this.gameMode === 'standard' && nFinished < 2) return { isOver: false };
        if (this.gameMode === 'double_landlord' && nFinished < 1) return { isOver: false };

        const finishRoles = this.finishOrder.map(playerId => this.playerRoles[playerId]);
        let result = null, isOver = false;

        if (this.gameMode === 'standard') { // KK 4-player standard
            if (nFinished >= 2) {
                if (finishRoles[0] === 'D' && finishRoles[1] === 'D') { result = "地主大胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'F') { result = "农民大胜"; isOver = true; }
            }
            if (!isOver && nFinished >= 3) { // For 4 players, 3 finished means game over
                 isOver = true; // Game is over
                 const D_count_top3 = finishRoles.slice(0,3).filter(r => r === 'D').length;
                 const F_count_top3 = finishRoles.slice(0,3).filter(r => r === 'F').length;

                 if (finishRoles[0] === 'D') { // 地主先出完
                    if (D_count_top3 === 2) result = "地主大胜"; // D D F _
                    else result = "地主胜";     // D F F _, D F D _
                 } else { // 农民先出完
                    if (F_count_top3 === 3) result = "农民大胜"; // F F F D
                    else if (F_count_top3 === 2 && finishRoles[2] === 'D') result = "农民胜"; // F F D _
                    else result = "农民胜"; // F D F _, F D D _ (地主末游)
                 }
            }
            // if (!isOver && nFinished === totalPlayers) { // All 4 finished, redundant if nFinished >=3 already decides for 4p
            //     // This logic might be too complex or covered by nFinished >=3 for 4 players
            // }
        } else if (this.gameMode === 'double_landlord') { // KK 4-player double landlord
            if (nFinished >= 1 && finishRoles[0] === 'DD') { result = "双地主大胜"; isOver = true; }
            else if (nFinished >= 3 && finishRoles.slice(0,3).join('') === 'FFF') { result = "农民大胜"; isOver = true; }
            else if (nFinished === totalPlayers) { // All 4 finished
                const ddPlayer = this.players.find(p => p.role === 'DD');
                const ddFinishPos = this.finishOrder.indexOf(ddPlayer.id); // 0-indexed
                if (ddFinishPos === 1) { result = "双地主胜"; isOver = true; } // F DD F F
                else if (ddFinishPos >= 2) { result = "农民胜"; isOver = true; } // F F DD F or F F F DD
            }
        } else if (this.gameMode === 'generic') {
            if (nFinished >= totalPlayers -1) { // For generic games, last one loses or game ends
                isOver = true;
                result = `${this.players.find(p => p.id === this.finishOrder[0])?.name} 胜`;
            }
        }

        if (!isOver && nFinished === totalPlayers && !result) { result = "打平 (所有玩家完成)"; isOver = true; }
        return { isOver, resultDescription: result };
     }
    calculateScoresBasedOnResult(resultDescription) {
         const scoreChanges = {}; let landlordScoreChange = 0; let farmerScoreChange = 0; let ddScoreChange = 0;
         let currentDesc = resultDescription;
         if (!currentDesc) currentDesc = "打平 (计分错误)";
         this.gameResultText = currentDesc;
         console.log(`[SCORE ${this.roomId}] Result: "${currentDesc}"`);

         if (this.gameMode === 'standard') {
             switch (currentDesc) {
                 case "打平": case "打平 (所有玩家完成)": case "打平 (计分错误)": case "打平 (游戏非正常结束)": case "打平 (Turn Advancement Error)": case "打平 (Player removed, not enough players to continue.)":
                 case "打平 (房间长时间无活动或空置，已被服务器清理。)": case "打平 (玩家离开，人数不足)":
                    landlordScoreChange = 0; farmerScoreChange = 0; break;
                 case "地主胜": landlordScoreChange = 1; farmerScoreChange = -1; break;
                 case "农民胜": landlordScoreChange = -1; farmerScoreChange = 1; break;
                 case "地主大胜": landlordScoreChange = 2; farmerScoreChange = -2; break;
                 case "农民大胜": landlordScoreChange = -2; farmerScoreChange = 2; break;
                 default: landlordScoreChange = 0; farmerScoreChange = 0; this.gameResultText = `打平 (${currentDesc} 未知)`;
             }
             this.players.forEach(p => { scoreChanges[p.id] = (this.playerRoles[p.id] === 'D') ? landlordScoreChange : farmerScoreChange; });
         } else if (this.gameMode === 'double_landlord') {
             switch (currentDesc) {
                 case "双地主大胜": ddScoreChange = 6; farmerScoreChange = -2; break;
                 case "双地主胜":   ddScoreChange = 3; farmerScoreChange = -1; break;
                 case "农民胜":     ddScoreChange = -3; farmerScoreChange = 1; break;
                 case "农民大胜":   ddScoreChange = -6; farmerScoreChange = 2; break;
                 case "打平": case "打平 (所有玩家完成)": case "打平 (计分错误)": case "打平 (游戏非正常结束)": case "打平 (Turn Advancement Error)": case "打平 (Player removed, not enough players to continue.)":
                 case "打平 (房间长时间无活动或空置，已被服务器清理。)": case "打平 (玩家离开，人数不足)":
                    ddScoreChange = 0; farmerScoreChange = 0; break;
                 default: ddScoreChange = 0; farmerScoreChange = 0; this.gameResultText = `打平 (${currentDesc} 未知)`;
             }
              this.players.forEach(p => { scoreChanges[p.id] = (this.playerRoles[p.id] === 'DD') ? ddScoreChange : farmerScoreChange; });
         } else if (this.gameMode === 'generic') { // Generic mode scoring: winner +1, others 0 or loser -1
             this.players.forEach(p => {
                 if (this.finishOrder[0] === p.id && currentDesc.includes(p.name || '胜')) { // Winner
                     scoreChanges[p.id] = 1 * (this.players.length -1) ;
                 } else if (!p.finished && this.finishOrder.length === this.players.length -1) { // Last one remaining
                     scoreChanges[p.id] = -1;
                 } else if (p.finished && this.finishOrder[0] !== p.id) {
                     scoreChanges[p.id] = -1; // Non-winners who finished
                 }
                  else {
                     scoreChanges[p.id] = 0; // Default / draw
                 }
             });
             if (currentDesc.startsWith("打平")) this.players.forEach(p => scoreChanges[p.id] = 0);
         }
         else { this.players.forEach(p => { scoreChanges[p.id] = 0; }); this.gameResultText = "打平 (游戏模式错误)"; }

         this.players.forEach(p => { const chg = scoreChanges[p.id] || 0; p.score += chg; console.log(`[SCORE ${this.roomId}] ${p.name} (${this.playerRoles[p.id]}): ${chg>=0?'+':''}${chg} -> Total: ${p.score}`); });
         this.lastScoreChanges = scoreChanges;
          return { result: this.gameResultText, scoreChanges, finalScores: this.players.map(p => ({ id: p.id, name: p.name, score: p.score, role: this.playerRoles[p.id] || p.role })) };
      }
    calculateScores() { // Fallback
        const instant = this.checkInstantGameOver();
        return this.calculateScoresBasedOnResult(instant.isOver && instant.resultDescription ? instant.resultDescription : "打平 (游戏非正常结束)");
    }

    endGame(reason = "Game ended by server") {
          if (this.gameFinished) return { result: this.gameResultText || "已结束", scoreChanges: this.lastScoreChanges || {}, finalScores: this.players.map(p => ({id:p.id,name:p.name,score:p.score,role:this.playerRoles[p.id]})) };
          this.gameFinished = true; this.gameStarted = false; this.gameResultText = reason;
          console.log(`[GAME ${this.roomId}] Ended. Reason: ${reason}`);

          if (this.finishOrder.length < this.players.length) {
               const finIds = new Set(this.finishOrder);
               this.players.filter(p => !finIds.has(p.id)).sort((a,b) => a.hand.length - b.hand.length || a.slot - b.slot)
                           .forEach(p => { if (!finIds.has(p.id)) { this.finishOrder.push(p.id); p.finished = true; }});
          }
          let scoreRes;
          if (reason.includes("清理") || reason.toLowerCase().includes("error") || reason.includes("人数不足")) {
              scoreRes = this.calculateScoresBasedOnResult(`打平 (${reason})`);
          } else {
              scoreRes = this.calculateScores();
          }
          this.lastScoreChanges = scoreRes.scoreChanges; this.gameResultText = scoreRes.result || reason;
          console.log(`[GAME ${this.roomId}] Final score: ${this.gameResultText}`);
          return scoreRes;
     }
    createDeck() {
        const s = ["H", "D", "C", "S"], r = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
        this.deck = []; r.forEach(rk => s.forEach(st => this.deck.push({ suit: st, rank: rk })));
     }
    shuffleDeck() { for (let i=this.deck.length-1; i>0; i--) { const j=crypto.randomInt(i+1); [this.deck[i],this.deck[j]]=[this.deck[j],this.deck[i]]; } console.log(`[GAME ${this.roomId}] Deck shuffled: ${this.deck.length} cards.`); }
    dealCards(num) {
         if (this.players.length === 0 || num * this.players.length > this.deck.length) { console.error(`[DEAL ${this.roomId}] Deal error. Players: ${this.players.length}, Cards needed: ${num * this.players.length}, Deck: ${this.deck.length}`); return; }
         this.players.forEach(p => p.hand = []);
         for (let i=0; i<num*this.players.length; i++) { const c = this.deck.pop(); if(c) this.players[i%this.players.length].hand.push(c); else break; }
         this.players.forEach(p => this.sortHand(p.hand));
         console.log(`[GAME ${this.roomId}] Dealt. Deck: ${this.deck.length}`);
     }
    sortHand(hand) { hand.sort(compareSingleCards); }


    getStateForPlayer(requestingPlayerId) {
        // ... (保持不变)
        const isObserver = !this.players.some(p => p.id === requestingPlayerId);
        return {
            players: this.players.map(p => ({
                id: p.id, name: p.name, slot: p.slot, score: p.score,
                role: this.playerRoles[p.id] || p.role, finished: p.finished,
                connected: p.connected, isAiControlled: p.isAiControlled,
                hand: (p.id === requestingPlayerId && !isObserver && this.gameStarted && !p.finished) ? p.hand : undefined, // Only show hand if game started and player not finished
                handCount: p.hand.length,
            })),
            centerPile: [...this.centerPile],
            lastHandInfo: this.lastValidHandInfo ? { type: this.lastValidHandInfo.type, cards: [...this.lastValidHandInfo.cards] } : null,
            currentPlayerId: (this.gameStarted && !this.gameFinished && this.currentPlayerIndex !== -1 && this.players[this.currentPlayerIndex]) ? this.players[this.currentPlayerIndex].id : null,
            isFirstTurn: this.firstTurn, gameStarted: this.gameStarted, gameFinished: this.gameFinished,
            winnerId: this.winnerId, finishOrder: [...this.finishOrder], lastPlayerWhoPlayedId: this.lastPlayerWhoPlayed,
            gameResultText: this.gameFinished ? this.gameResultText : null,
            finalScores: this.gameFinished ? this.players.map(p_1 => ({ id:p_1.id, name:p_1.name, score:p_1.score, role: this.playerRoles[p_1.id] || p_1.role })) : null,
            scoreChanges: this.gameFinished ? this.lastScoreChanges : null,
            gameMode: this.gameMode,
            aiPlayDelay: this.aiPlayDelay // AI 出牌延迟也发给客户端，虽然客户端不直接用
        };
    }
}

module.exports = { Game, HAND_TYPES, RANK_VALUES, SUIT_VALUES, compareSingleCards, RANK_ORDER, SUIT_ORDER, compareHands }; // Export compareHands for AI
