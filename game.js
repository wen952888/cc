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
    // BOMB: 'bomb' // Future: For 4-of-a-kind or higher straight flushes
};

const HAND_TYPE_RANKING = {
    [HAND_TYPES.SINGLE]: 1, [HAND_TYPES.PAIR]: 2, [HAND_TYPES.THREE_OF_A_KIND]: 3,
    [HAND_TYPES.STRAIGHT]: 4, [HAND_TYPES.FLUSH]: 5, [HAND_TYPES.FULL_HOUSE]: 6,
    [HAND_TYPES.STRAIGHT_FLUSH]: 7
    // [HAND_TYPES.BOMB]: 8 // Future
};

// --- Helper Functions ---
function compareSingleCards(cardA, cardB) {
    const rankValueA = RANK_VALUES[cardA.rank];
    const rankValueB = RANK_VALUES[cardB.rank];
    if (rankValueA !== rankValueB) return rankValueA - rankValueB;
    return SUIT_VALUES[cardA.suit] - SUIT_VALUES[cardB.suit];
}

function compareHands(handInfoA, handInfoB) {
    // Assumes A and B are valid handInfos from getHandInfo
    const typeRankA = HAND_TYPE_RANKING[handInfoA.type];
    const typeRankB = HAND_TYPE_RANKING[handInfoB.type];

    if (typeRankA !== typeRankB) return typeRankA - typeRankB;

    // Same type comparison
    switch (handInfoA.type) {
        case HAND_TYPES.STRAIGHT_FLUSH:
            // primaryRankValue is the highest card's rank value in the straight part.
            if (handInfoA.primaryRankValue !== handInfoB.primaryRankValue) {
                return handInfoA.primaryRankValue - handInfoB.primaryRankValue;
            }
            // If ranks are same (e.g. 2-3-4-5-6 vs 2-3-4-5-6 of different suits),
            // compare by suit of the representative (highest) card.
            return SUIT_VALUES[handInfoA.representativeCard.suit] - SUIT_VALUES[handInfoB.representativeCard.suit];

        case HAND_TYPES.FULL_HOUSE:
        case HAND_TYPES.STRAIGHT:
            // Compare by the rank of the three-of-a-kind in full house, or highest card in straight.
            return handInfoA.primaryRankValue - handInfoB.primaryRankValue;

        case HAND_TYPES.FLUSH:
            // For flush, compare cards from highest to lowest.
            // handInfo.cards for flush is already sorted highest to lowest by getHandInfo.
            for (let i = 0; i < handInfoA.cards.length; i++) {
                // We need to compare rank first, then suit if ranks are identical
                const rankValA = RANK_VALUES[handInfoA.cards[i].rank];
                const rankValB = RANK_VALUES[handInfoB.cards[i].rank];
                if (rankValA !== rankValB) return rankValA - rankValB;
                
                const suitValA = SUIT_VALUES[handInfoA.cards[i].suit];
                const suitValB = SUIT_VALUES[handInfoB.cards[i].suit];
                if (suitValA !== suitValB) return suitValA - suitValB;
            }
            return 0; // All cards are identical (should be rare or impossible if different players)

        case HAND_TYPES.THREE_OF_A_KIND:
        case HAND_TYPES.PAIR:
        case HAND_TYPES.SINGLE:
            // Comparison is based on the representative card (highest card of the set/single).
            return compareSingleCards(handInfoA.representativeCard, handInfoB.representativeCard);

        default: return 0;
    }
}


class Game {
    constructor(roomId, maxPlayers = 4) {
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
        this.possibleHints = [];
        this.currentHintIndexInternal = 0; // Server's idea of which hint was last given
        this.gameResultText = null;
        this.lastScoreChanges = {};
    }

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

    removePlayer(userId) { // More for complete removal, not just disconnect
        const playerIndex = this.players.findIndex(p => p.id === userId);
        if (playerIndex !== -1) {
            const removedPlayerName = this.players[playerIndex].name;
            this.players.splice(playerIndex, 1);
            console.log(`[GAME ${this.roomId}] Player ${removedPlayerName} (ID: ${userId}) fully removed from game instance.`);
            // Further logic if game is in progress and player is removed (e.g., re-evaluate turns)
            if (this.gameStarted && !this.gameFinished) {
                if (this.players.length < this.maxPlayers && this.status !== 'finished') { // Or some other minimum number
                    // Potentially end the game or mark it as aborted
                    console.warn(`[GAME ${this.roomId}] Player removed mid-game. Game might need to be ended if not enough players.`);
                    // this.endGame("Player removed, not enough players to continue.");
                }
                 // If current player was removed, nextTurn should handle it.
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
                // Game might auto-pass or AI might take over if that's a feature.
                // nextTurn() will skip them if they remain disconnected and not AI.
            }
        }
    }

    setPlayerAI(userId, isAiControlled) {
        const player = this.players.find(p => p.id === userId);
        if (player) {
            player.isAiControlled = !!isAiControlled;
            console.log(`[GAME ${this.roomId}] Player ${player.name} AI control set to: ${player.isAiControlled}`);
            // If it becomes AI's turn and player was disconnected, AI might play.
        }
    }

    startGame(playerStartInfo) {
        this.deck = []; this.centerPile = []; this.lastValidHandInfo = null;
        this.currentPlayerIndex = -1; this.firstTurn = true; this.gameStarted = false;
        this.gameFinished = false; this.winnerId = null; this.playerRoles = {};
        this.finishOrder = []; this.gameMode = null; this.consecutivePasses = 0;
        this.lastPlayerWhoPlayed = null; this.possibleHints = []; this.currentHintIndexInternal = 0;
        this.gameResultText = null; this.lastScoreChanges = {};

        if (!playerStartInfo || playerStartInfo.length !== this.maxPlayers) {
            return { success: false, message: `需要 ${this.maxPlayers} 位玩家。当前 ${playerStartInfo ? playerStartInfo.length : 0} 位。` };
        }

        this.players = playerStartInfo.map(info => ({
            id: info.id, name: info.name, slot: info.slot, hand: [],
            score: info.score || 0, connected: true, // Assume connected when game starts
            finished: false, role: null, isAiControlled: !!info.isAiControlled
        })).sort((a, b) => a.slot - b.slot);

        console.log(`[GAME ${this.roomId}] Starting game with players:`, this.players.map(p => `${p.name}(Slot:${p.slot}, AI:${p.isAiControlled})`));
        this.createDeck(); this.shuffleDeck(); this.dealCards(13);

        this.gameStarted = true; this.firstTurn = true;

        let s3PlayerId = null, saPlayerId = null;
        this.players.forEach(p => {
            if (p.hand.some(c => c.suit === 'S' && c.rank === '3')) s3PlayerId = p.id;
            if (p.hand.some(c => c.suit === 'S' && c.rank === 'A')) saPlayerId = p.id;
        });

        if (!s3PlayerId || !saPlayerId) {
            console.error(`[GAME ${this.roomId}] CRITICAL: S3 or SA not found. Aborting start.`);
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
        console.log(`[GAME ${this.roomId}] Mode: ${this.gameMode}. Roles:`, JSON.stringify(this.playerRoles));

        let startingPlayerIndex = -1;
        for (let i = 0; i < this.players.length; i++) {
            if (this.players[i].hand.some(card => card.suit === 'D' && card.rank === '4')) {
                startingPlayerIndex = i; break;
            }
        }

        if (startingPlayerIndex === -1) {
            console.error(`[GAME ${this.roomId}] CRITICAL: Diamond 4 not found. Aborting start.`);
            this.gameStarted = false;
            return { success: false, message: "发牌错误，未找到方块4先手牌。" };
        }
        this.currentPlayerIndex = startingPlayerIndex;
        this.lastPlayerWhoPlayed = null;

        console.log(`[GAME ${this.roomId}] Player ${this.players[this.currentPlayerIndex].name} starts (has Diamond 4).`);
        return { success: true };
    }

    playCard(playerId, cards) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayerIndex) {
            return { success: false, message: "非当前玩家或回合错误。" };
        }
        
        const player = this.players[playerIndex];
        if (!player.connected && !player.isAiControlled) return { success: false, message: "您已断线。" };
        if (player.finished) return { success: false, message: "您已出完牌。" };
        if (!Array.isArray(cards) || cards.length === 0) return { success: false, message: "未选择牌。" };

        const handSet = new Set(player.hand.map(c => `${c.rank}${c.suit}`));
        if (!cards.every(card => handSet.has(`${card.rank}${card.suit}`))) {
            return { success: false, message: "选择的牌不在手中。" };
        }

        const validationResult = this.checkValidPlay(cards, player.hand, this.lastValidHandInfo, this.firstTurn);
        if (!validationResult.valid) return { success: false, message: validationResult.message };

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
                 const finalInstantResult = this.checkInstantGameOver();
                 scoreResult = this.calculateScoresBasedOnResult(finalInstantResult.isOver ? finalInstantResult.resultDescription : "打平 (所有玩家完成)");
                 this.gameFinished = true; this.gameStarted = false;
                 console.log(`[GAME ${this.roomId}] All players finished. Result: ${scoreResult.result}`);
            }
        }

        if (gameOver) {
            this.lastScoreChanges = scoreResult.scoreChanges;
            return { success: true, gameOver: true, scoreResult: scoreResult, handInfo: this.lastValidHandInfo };
        } else if (player.finished) {
            this.nextTurn(true); // Force advance if current player finished
            return { success: true, playerFinished: true, handInfo: this.lastValidHandInfo };
        } else {
            this.nextTurn();
            return { success: true, handInfo: this.lastValidHandInfo };
        }
    }

    handlePass(playerId) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayerIndex) return { success: false, message: "非当前玩家或回合错误。" };
        const player = this.players[playerIndex];
        if (!player.connected && !player.isAiControlled) return { success: false, message: "您已断线。" };
        if (player.finished) return { success: false, message: "您已出完牌。" };
        if (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) return { success: false, message: "本轮首出或上个出牌者，必须出牌。" };

        console.log(`[GAME ${this.roomId}] ${player.name} passed.`);
        this.consecutivePasses++; this.possibleHints = []; this.currentHintIndexInternal = 0;

        const activePlayersNotFinished = this.players.filter(p => (p.connected || p.isAiControlled) && !p.finished).length;
        if (this.lastPlayerWhoPlayed && activePlayersNotFinished > 1 && this.consecutivePasses >= activePlayersNotFinished - 1) {
            console.log(`[GAME ${this.roomId}] All others passed. New round for ${this.players.find(p => p.id === this.lastPlayerWhoPlayed)?.name}.`);
            this.resetTurnState();
            const lastPlayerIdx = this.players.findIndex(p => p.id === this.lastPlayerWhoPlayed);
            const lastPlayerObj = this.players[lastPlayerIdx];
            if (lastPlayerObj && (!lastPlayerObj.finished && (lastPlayerObj.connected || lastPlayerObj.isAiControlled))) {
                this.currentPlayerIndex = lastPlayerIdx;
            } else {
                 this.currentPlayerIndex = lastPlayerIdx; this.nextTurn(true);
            }
            this.lastPlayerWhoPlayed = null; // New round starter cannot pass immediately
        } else if (activePlayersNotFinished <= 1 && this.lastPlayerWhoPlayed) {
             console.log(`[GAME ${this.roomId}] Only one active player. New round for ${this.players.find(p => p.id === this.lastPlayerWhoPlayed)?.name}.`);
             this.resetTurnState();
             this.currentPlayerIndex = this.players.findIndex(p => p.id === this.lastPlayerWhoPlayed);
             this.lastPlayerWhoPlayed = null;
        } else {
            this.nextTurn();
        }
        return { success: true };
    }

    resetTurnState() {
        this.centerPile = []; this.lastValidHandInfo = null; this.consecutivePasses = 0;
        console.log(`[GAME ${this.roomId}] Turn state reset.`);
    }

    nextTurn(forceAdvanceDueToFinish = false) {
         if (this.gameFinished && !forceAdvanceDueToFinish) return;
         const numPlayers = this.players.length;
         if (numPlayers === 0) { this.currentPlayerIndex = -1; return; }

         let currentIdx = this.currentPlayerIndex;
         if (currentIdx === -1 || !this.players[currentIdx]) {
             let foundStartIdx = -1;
             for(let i=0; i < numPlayers; i++) {
                 if (this.players[i] && (!this.players[i].finished && (this.players[i].connected || this.players[i].isAiControlled))) {
                     foundStartIdx = i; break;
                 }
             }
             if (foundStartIdx !== -1) currentIdx = foundStartIdx -1; // So first advance lands on them
             else {
                 console.warn(`[GAME ${this.roomId}] nextTurn: No active players for turn init.`);
                 this.currentPlayerIndex = -1;
                 if (this.gameStarted && !this.gameFinished && this.players.every(p => p.finished || (!p.connected && !p.isAiControlled))) {
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
         } while ( !this.players[nextIdx] || this.players[nextIdx].finished || (!this.players[nextIdx].connected && !this.players[nextIdx].isAiControlled) );

         this.currentPlayerIndex = nextIdx;
         const nextPlayer = this.players[this.currentPlayerIndex];
         console.log(`[GAME ${this.roomId}] Turn: ${nextPlayer?.name} (Slot:${nextPlayer?.slot}, Idx:${this.currentPlayerIndex}).`);
         this.possibleHints = []; this.currentHintIndexInternal = 0;
    }

    findHint(playerId, clientHintIndex = 0) { // clientHintIndex is what client thinks is next
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIdx = this.players.findIndex(p => p.id === playerId);
        if (playerIdx === -1 || playerIdx !== this.currentPlayerIndex) return { success: false, message: "非当前回合。" };
        const player = this.players[playerIdx];
        if (!player || (!player.connected && !player.isAiControlled) || player.finished) return { success: false, message: "无效玩家状态。" };

        // If server has already computed hints for this turn and state, and client is asking for next
        if (this.possibleHints.length > 0 && this.possibleHints[0].forPlayerId === playerId) {
             // Server's internal index might be ahead if client spams hint button
             // We use clientHintIndex to determine if we should serve from cache or re-evaluate or cycle
             let actualHintIdxToShow = clientHintIndex % this.possibleHints.length;
             this.currentHintIndexInternal = actualHintIdxToShow; // Align server index
             const nextServerIdx = (actualHintIdxToShow + 1) % this.possibleHints.length;
             return { success: true, hint: this.possibleHints[actualHintIdxToShow].cards, nextHintIndex: nextServerIdx };
        }

        // Compute new hints
        this.possibleHints = []; const hand = player.hand;
        for (const card of hand) { // Singles
            const val = this.checkValidPlay([card], hand, this.lastValidHandInfo, this.firstTurn);
            if (val.valid) this.possibleHints.push({ cards: [card], forPlayerId: playerId, handInfo: val.handInfo });
        }
        const ranksInHand = {}; hand.forEach(c => ranksInHand[c.rank] = (ranksInHand[c.rank] || 0) + 1);
        for (const rank in ranksInHand) { // Pairs
            if (ranksInHand[rank] >= 2) {
                const pair = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 2);
                const val = this.checkValidPlay(pair, hand, this.lastValidHandInfo, this.firstTurn);
                if (val.valid) this.possibleHints.push({ cards: pair, forPlayerId: playerId, handInfo: val.handInfo });
            }
            if (ranksInHand[rank] >= 3) { // Threes
                const three = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 3);
                const val = this.checkValidPlay(three, hand, this.lastValidHandInfo, this.firstTurn);
                if (val.valid) this.possibleHints.push({ cards: three, forPlayerId: playerId, handInfo: val.handInfo });
            }
        }
        // TODO: Straights, Flushes, Full Houses, Straight Flushes for hints

        this.possibleHints.sort((a, b) => compareHands(a.handInfo, b.handInfo)); // Sort weaker to stronger

        if (this.possibleHints.length > 0) {
             this.currentHintIndexInternal = 0;
             return { success: true, hint: this.possibleHints[0].cards, nextHintIndex: (this.possibleHints.length > 1 ? 1 : 0) };
        }
        return { success: false, message: "没有可出的牌。", nextHintIndex: 0 };
    }

    getHandInfo(cards) {
        if (!Array.isArray(cards) || cards.length === 0) return { isValid: false, message: "无效输入" };
        const n = cards.length;
        const sortedCards = [...cards].sort(compareSingleCards); // Ascending by rank, then suit

        const suits = new Set(sortedCards.map(c => c.suit));
        const ranks = sortedCards.map(c => c.rank);
        const rankValues = sortedCards.map(c => RANK_VALUES[c.rank]);
        const isFlush = suits.size === 1;
        let isStraight = false, straightPrimaryRankValue = -1, straightRepCard = null;

        if (n === 5) {
            const uniqueRankValsSortedAsc = [...new Set(rankValues)].sort((a, b) => a - b);
            if (uniqueRankValsSortedAsc.length === 5 && uniqueRankValsSortedAsc[4] - uniqueRankValsSortedAsc[0] === 4) {
                isStraight = true;
                straightPrimaryRankValue = uniqueRankValsSortedAsc[4]; // Highest rank value
                straightRepCard = sortedCards[n-1]; // Highest card (already sorted)
            }
            // A-2-3-4-5 (A low) straight logic:
            // Ranks A,2,3,4,5 -> Values according to RANK_ORDER: A=10, 2=11, 3=12, 4=0, 5=1
            // Sorted unique values: 0,1,10,11,12. This is NOT a "normal" straight.
            // Game rules state T J Q K A is highest straight. 2 3 4 5 6 is lowest. A 2 3 4 5 is not a straight.
        }

        const rankCounts = {}; ranks.forEach(r => { rankCounts[r] = (rankCounts[r] || 0) + 1; });
        const counts = Object.values(rankCounts).sort((a, b) => b - a);
        const distinctRanksByVal = Object.keys(rankCounts).sort((rA, rB) => RANK_VALUES[rA] - RANK_VALUES[rB]);

        if (n === 5 && isStraight && isFlush) {
            const compareSorted = [...sortedCards].sort((a,b)=>compareSingleCards(b,a)); // High-to-low for compareHands
            return { isValid: true, type: HAND_TYPES.STRAIGHT_FLUSH, cards: compareSorted, primaryRankValue: straightPrimaryRankValue, suitValue: SUIT_VALUES[straightRepCard.suit], representativeCard: straightRepCard };
        }
        if (n === 5 && counts[0] === 3 && counts.length >=2 && counts[1] === 2) {
            const threeRank = distinctRanksByVal.find(r => rankCounts[r] === 3);
            const repCard = sortedCards.filter(c => c.rank === threeRank).sort(compareSingleCards)[2]; // Highest of the three
            return { isValid: true, type: HAND_TYPES.FULL_HOUSE, cards: sortedCards, primaryRankValue: RANK_VALUES[threeRank], representativeCard: repCard };
        }
        if (n === 5 && isFlush) {
            const compareSorted = [...sortedCards].sort((a,b)=>compareSingleCards(b,a)); // High-to-low
            return { isValid: true, type: HAND_TYPES.FLUSH, cards: compareSorted, representativeCard: sortedCards[n-1], primaryRankValue: RANK_VALUES[sortedCards[n-1].rank] };
        }
        if (n === 5 && isStraight) {
            return { isValid: true, type: HAND_TYPES.STRAIGHT, cards: sortedCards, primaryRankValue: straightPrimaryRankValue, representativeCard: straightRepCard };
        }
        if (n === 3 && counts[0] === 3) {
            const threeRank = distinctRanksByVal.find(r => rankCounts[r] === 3);
            return { isValid: true, type: HAND_TYPES.THREE_OF_A_KIND, cards: sortedCards, representativeCard: sortedCards[2], primaryRankValue: RANK_VALUES[threeRank] };
        }
        if (n === 2 && counts[0] === 2) {
            const pairRank = distinctRanksByVal.find(r => rankCounts[r] === 2);
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
         const newHandInfo = this.getHandInfo(cardsToPlay);
         if (!newHandInfo.isValid) return { valid: false, message: newHandInfo.message };
         if (isFirstTurn) {
             if (!cardsToPlay.some(c => c.suit === 'D' && c.rank === '4')) return { valid: false, message: "首回合必须包含方块4。" };
             return { valid: true, handInfo: newHandInfo };
         }
         if (!lastPlayedHandInfo) return { valid: true, handInfo: newHandInfo }; // New round
         if (newHandInfo.type !== lastPlayedHandInfo.type) return { valid: false, message: `必须出同类型牌 (${lastPlayedHandInfo.type})。` };
         if (newHandInfo.cards.length !== lastPlayedHandInfo.cards.length) return { valid: false, message: `牌数量必须一致 (${lastPlayedHandInfo.cards.length}张)。`};
         if (compareHands(newHandInfo, lastPlayedHandInfo) > 0) return { valid: true, handInfo: newHandInfo };
         return { valid: false, message: `打出的 ${newHandInfo.type} 必须大于上家。` };
     }

    checkInstantGameOver() {
        const nFinished = this.finishOrder.length;
        const totalPlayers = this.players.length;
        if (!this.gameStarted && !this.gameFinished && nFinished === 0) return {isOver: false}; // Not started or nothing happened

        // For 2-player games
        if (totalPlayers <= 2) {
            if (nFinished >= 1) {
                const winner = this.players.find(p => p.id === this.finishOrder[0]);
                if (!winner) return {isOver: false}; // Should not happen
                if (this.gameMode === 'standard') {
                    return {isOver: true, resultDescription: winner.role === 'D' ? "地主胜" : "农民胜"};
                } else if (this.gameMode === 'double_landlord') {
                    return {isOver: true, resultDescription: winner.role === 'DD' ? "双地主大胜" : "农民胜"};
                }
            }
            return {isOver: false};
        }

        // For >2 players
        if (this.gameMode === 'standard' && nFinished < 2) return { isOver: false };
        if (this.gameMode === 'double_landlord' && nFinished < 1) return { isOver: false };

        const finishRoles = this.finishOrder.map(playerId => this.playerRoles[playerId]);
        let result = null, isOver = false;

        if (this.gameMode === 'standard') {
            if (nFinished >= 2) {
                if (finishRoles[0] === 'D' && finishRoles[1] === 'D') { result = "地主大胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'F') { result = "农民大胜"; isOver = true; }
            }
            if (!isOver && nFinished >= 3) {
                const top3 = finishRoles.slice(0,3).join('');
                if (top3.startsWith('DFD')) { result = "地主胜"; isOver = true; }
                else if (top3.startsWith('FDF')) { result = "农民胜"; isOver = true; }
            }
            if (!isOver && nFinished === totalPlayers) { // All finished
                const allRolesStr = finishRoles.join('');
                if (allRolesStr === 'DFFD' || allRolesStr === 'FDDF') { result = "打平"; isOver = true; }
                else if (finishRoles[0] === 'D' && finishRoles[totalPlayers-1] === 'F') { result = "地主胜"; isOver = true; } // Landlord 1st, Farmer last
                else if (finishRoles[0] === 'F' && finishRoles[totalPlayers-1] === 'D') { result = "农民胜"; isOver = true; } // Farmer 1st, Landlord last
                // Other specific full game outcomes for 4p if needed (e.g. DFDF -> D wins, FDFD -> F wins)
                else if (allRolesStr === 'DFDF') { result = "地主胜"; isOver = true; }
                else if (allRolesStr === 'FDFD') { result = "农民胜"; isOver = true; }
            }
        } else if (this.gameMode === 'double_landlord') {
            if (nFinished >= 1 && finishRoles[0] === 'DD') { result = "双地主大胜"; isOver = true; }
            else if (nFinished >= 3 && finishRoles.slice(0,3).join('') === 'FFF') { result = "农民大胜"; isOver = true; }
            else if (nFinished === totalPlayers) { // All finished
                const ddPlayer = this.players.find(p => p.role === 'DD');
                const ddFinishPos = this.finishOrder.indexOf(ddPlayer.id); // 0-indexed
                if (finishRoles[0] === 'F' && ddFinishPos === 1) { result = "双地主胜"; isOver = true; } // F DD ...
                else if (finishRoles[0] === 'F' && ddFinishPos >= 2) { result = "农民胜"; isOver = true; } // F F DD or F F F DD
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
                 case "打平 (房间长时间无活动或空置，已被服务器清理。)":
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
                 case "打平 (房间长时间无活动或空置，已被服务器清理。)":
                    ddScoreChange = 0; farmerScoreChange = 0; break;
                 default: ddScoreChange = 0; farmerScoreChange = 0; this.gameResultText = `打平 (${currentDesc} 未知)`;
             }
              this.players.forEach(p => { scoreChanges[p.id] = (this.playerRoles[p.id] === 'DD') ? ddScoreChange : farmerScoreChange; });
         } else { this.players.forEach(p => { scoreChanges[p.id] = 0; }); this.gameResultText = "打平 (游戏模式错误)"; }

         this.players.forEach(p => { const chg = scoreChanges[p.id] || 0; p.score += chg; console.log(`[SCORE ${this.roomId}] ${p.name} (${this.playerRoles[p.id]}): ${chg>=0?'+':''}${chg} -> Total: ${p.score}`); });
         this.lastScoreChanges = scoreChanges;
          return { result: this.gameResultText, scoreChanges, finalScores: this.players.map(p => ({ id: p.id, name: p.name, score: p.score, role: this.playerRoles[p.id] })) };
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
          if (reason.includes("pruned by server") || reason.toLowerCase().includes("error")) {
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
         if (this.players.length === 0 || num * this.players.length > this.deck.length) { console.error(`[DEAL ${this.roomId}] Deal error.`); return; }
         this.players.forEach(p => p.hand = []);
         for (let i=0; i<num*this.players.length; i++) { const c = this.deck.pop(); if(c) this.players[i%this.players.length].hand.push(c); else break; }
         this.players.forEach(p => this.sortHand(p.hand));
         console.log(`[GAME ${this.roomId}] Dealt. Deck: ${this.deck.length}`);
     }
    sortHand(hand) { hand.sort(compareSingleCards); }

    getStateForPlayer(requestingPlayerId) {
        const isObserver = !this.players.some(p => p.id === requestingPlayerId);
        return {
            players: this.players.map(p => ({
                id: p.id, name: p.name, slot: p.slot, score: p.score,
                role: this.playerRoles[p.id] || p.role, finished: p.finished,
                connected: p.connected, isAiControlled: p.isAiControlled,
                hand: (p.id === requestingPlayerId && !isObserver) ? p.hand : undefined,
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
        };
    }
}

module.exports = { Game, HAND_TYPES, RANK_VALUES, SUIT_VALUES, compareSingleCards, RANK_ORDER, SUIT_ORDER };
