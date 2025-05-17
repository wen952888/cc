// game.js
const crypto = require('crypto');

const RANK_ORDER = ["4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2", "3"];
const RANK_VALUES = {};
RANK_ORDER.forEach((rank, index) => { RANK_VALUES[rank] = index; });

const SUIT_ORDER = ["D", "C", "H", "S"]; 
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

function compareSingleCards(cardA, cardB) {
    const rankValueA = RANK_VALUES[cardA.rank];
    const rankValueB = RANK_VALUES[cardB.rank];
    if (rankValueA !== rankValueB) return rankValueA - rankValueB;
    return SUIT_VALUES[cardA.suit] - SUIT_VALUES[cardB.suit];
}

function compareHands(handInfoA, handInfoB) {
    const rankA = HAND_TYPE_RANKING[handInfoA.type];
    const rankB = HAND_TYPE_RANKING[handInfoB.type];

    if (rankA !== rankB) return rankA - rankB;

    switch (handInfoA.type) {
        case HAND_TYPES.STRAIGHT_FLUSH:
        case HAND_TYPES.FULL_HOUSE:
        case HAND_TYPES.STRAIGHT:
            if (handInfoA.primaryRankValue !== handInfoB.primaryRankValue) {
                 return handInfoA.primaryRankValue - handInfoB.primaryRankValue;
            }
            return compareSingleCards(handInfoA.representativeCard, handInfoB.representativeCard);
        case HAND_TYPES.FLUSH:
            for (let i = 0; i < handInfoA.cards.length; i++) {
                const compareResult = compareSingleCards(handInfoA.cards[i], handInfoB.cards[i]);
                if (compareResult !== 0) return compareResult;
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
        this.roomId = roomId;
        this.maxPlayers = maxPlayers;
        this.players = []; 
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
        this.currentHintIndexInternal = 0;
        this.gameResultText = "";
        this.gameOverReason = "";
        this.finalScores = null;
        this.scoreChanges = null;
    }

    addPlayer(userId, username, slot) {
        if (this.players.some(p => p.id === userId)) { 
            const player = this.players.find(p => p.id === userId);
            player.name = username; 
            player.slot = slot;    
            player.connected = true;
            player.finished = false; 
            console.log(`[GAME ${this.roomId}] Player ${username} re-added/updated for new round.`);
            return true;
        }
        if (this.players.length >= this.maxPlayers) return false;

        this.players.push({
            id: userId, name: username, slot: slot, hand: [], score: 0,
            connected: true, finished: false, role: null
        });
        this.players.sort((a, b) => a.slot - b.slot);
        return true;
    }

    removePlayer(userId) {
        this.markPlayerConnected(userId, false);
    }

    markPlayerConnected(userId, isConnected) {
        const player = this.players.find(p => p.id === userId);
        if (player) {
            player.connected = !!isConnected;
            console.log(`[GAME ${this.roomId}] Player ${player.name} connection status set to ${player.connected}`);
        }
    }

    startGame(playerStartInfo) {
        this.deck = []; this.centerPile = []; this.lastValidHandInfo = null; this.currentPlayerIndex = -1;
        this.firstTurn = true; this.gameStarted = false; this.gameFinished = false; this.winnerId = null;
        this.playerRoles = {}; this.finishOrder = []; this.gameMode = null; this.consecutivePasses = 0; this.lastPlayerWhoPlayed = null;
        this.possibleHints = []; this.currentHintIndexInternal = 0;
        this.gameResultText = ""; this.gameOverReason = ""; this.finalScores = null; this.scoreChanges = null;

        if (playerStartInfo.length !== this.maxPlayers) return { success: false, message: `需要 ${this.maxPlayers} 玩家。` };

        const previousScores = {};
        this.players.forEach(p => { previousScores[p.id] = p.score; }); 

        this.players = playerStartInfo.map(info => ({
            id: info.id, name: info.name, slot: info.slot, hand: [],
            score: previousScores[info.id] || 0,
            connected: true, finished: false, role: null
        })).sort((a, b) => a.slot - b.slot);

        console.log(`[GAME ${this.roomId}] Starting game with players:`, this.players.map(p => ({name:p.name, score: p.score})));
        this.createDeck(); this.shuffleDeck(); this.dealCards(13);
        this.gameStarted = true; this.firstTurn = true;

        let s3PlayerId = null, saPlayerId = null;
        this.players.forEach(p => {
            if (p.hand.some(c => c.suit === 'S' && c.rank === '3')) s3PlayerId = p.id;
            if (p.hand.some(c => c.suit === 'S' && c.rank === 'A')) saPlayerId = p.id;
        });

        if (!s3PlayerId || !saPlayerId) {
            console.error(`[GAME ${this.roomId}] Role assignment error: S3 or SA not found.`);
            return { success: false, message: "发牌错误，无法确定身份！(S3/SA缺失)" };
        }

        if (s3PlayerId === saPlayerId) {
            this.gameMode = 'double_landlord';
            this.playerRoles[s3PlayerId] = 'DD';
        } else {
            this.gameMode = 'standard';
            this.playerRoles[s3PlayerId] = 'D'; this.playerRoles[saPlayerId] = 'D';
        }
        this.players.forEach(p => {
            if (this.playerRoles[p.id]) {
                p.role = this.playerRoles[p.id];
            } else {
                p.role = 'F';
                this.playerRoles[p.id] = 'F';
            }
        });
        console.log(`[GAME ${this.roomId}] Game Mode: ${this.gameMode}. Roles assigned:`, this.playerRoles);

        let startingPlayerIndex = -1;
        for (let i = 0; i < this.players.length; i++) {
            if (this.players[i].hand.some(card => card.suit === 'D' && card.rank === '4')) {
                startingPlayerIndex = i; break;
            }
        }
        if (startingPlayerIndex === -1) {
            console.error(`[GAME ${this.roomId}] Starting player error: D4 not found.`);
            return { success: false, message: "发牌错误，未找到方块4！" };
        }
        this.currentPlayerIndex = startingPlayerIndex;
        this.lastPlayerWhoPlayed = null;

        console.log(`[GAME ${this.roomId}] Player ${this.players[this.currentPlayerIndex].name} (Slot ${this.players[this.currentPlayerIndex].slot}) starts (has D4).`);
        return { success: true };
    }

    playCard(playerId, cards) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== this.currentPlayerIndex) return { success: false, message: "现在不是你的回合。" };
        const player = this.players[playerIndex];
        if (!player.connected) return { success: false, message: "你已断线。" };
        if (player.finished) return { success: false, message: "你已完成出牌。" };

        const handSet = new Set(player.hand.map(c => `${c.rank}${c.suit}`));
        const cardsValidInHand = cards.every(card => handSet.has(`${card.rank}${card.suit}`));
        if (!cardsValidInHand) return { success: false, message: "选择的牌不在您的手中。" };

        const validationResult = this.checkValidPlay(cards, player.hand, this.lastValidHandInfo, this.firstTurn);
        if (!validationResult.valid) return { success: false, message: validationResult.message };

        const cardsToRemoveSet = new Set(cards.map(c => `${c.rank}${c.suit}`));
        player.hand = player.hand.filter(card => !cardsToRemoveSet.has(`${card.rank}${card.suit}`));
        this.sortHand(player.hand);

        this.centerPile = cards;
        this.lastValidHandInfo = validationResult.handInfo;
        this.lastPlayerWhoPlayed = playerId;
        this.consecutivePasses = 0;
        if (this.firstTurn) this.firstTurn = false;
        console.log(`[GAME ${this.roomId}] Player ${player.name} played ${this.lastValidHandInfo.type}. Cards left: ${player.hand.length}`);
        this.possibleHints = []; this.currentHintIndexInternal = 0;

        let gameOver = false;
        let scoreResultToReturn = null;
        if (player.hand.length === 0) {
            this.finishOrder.push(playerId);
            player.finished = true;
            if (!this.winnerId) this.winnerId = playerId;
            console.log(`[GAME ${this.roomId}] Player ${player.name} finished. Order: ${this.finishOrder.map(id => this.players.find(p=>p.id===id)?.name).join(', ')}.`);

            const instantResult = this.checkInstantGameOver();
            if (instantResult.isOver) {
                gameOver = true;
                const remainingUnfinished = this.players.filter(p => !this.finishOrder.includes(p.id));
                remainingUnfinished.sort((a,b) => a.hand.length - b.hand.length || a.slot - b.slot)
                                 .forEach(p => {
                                     if(!this.finishOrder.includes(p.id)) this.finishOrder.push(p.id);
                                     p.finished = true; 
                                 });
                scoreResultToReturn = this.calculateScoresBasedOnResult(instantResult.resultDescription);
                this.gameFinished = true; this.gameStarted = false;
                console.log(`[GAME ${this.roomId}] Game result determined early: ${instantResult.resultDescription}`);
            } else if (this.finishOrder.length === this.players.length -1) {
                 const lastPlayer = this.players.find(p => !p.finished && !this.finishOrder.includes(p.id)); 
                 if(lastPlayer) {
                    if(!this.finishOrder.includes(lastPlayer.id)) this.finishOrder.push(lastPlayer.id);
                    lastPlayer.finished = true;
                 }
                 gameOver = true;
                 const finalOutcome = this.checkInstantGameOver(); 
                 scoreResultToReturn = this.calculateScoresBasedOnResult(finalOutcome.resultDescription || "打平");
                 this.gameFinished = true; this.gameStarted = false;
                 console.log(`[GAME ${this.roomId}] All players finished. Final outcome: ${scoreResultToReturn.result}`);
            }
        }

        if (gameOver) {
            return { success: true, gameOver: true, scoreResult: scoreResultToReturn, handInfo: this.lastValidHandInfo };
        } else if (player.finished) {
            this.nextTurn(true);
            return { success: true, playerFinished: true, handInfo: this.lastValidHandInfo };
        } else {
            this.nextTurn();
            return { success: true, handInfo: this.lastValidHandInfo };
        }
    }

    handlePass(playerId) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== this.currentPlayerIndex) return { success: false, message: "现在不是你的回合。" };
        const player = this.players[playerIndex];
        if (!player.connected) return { success: false, message: "你已断线。" };
        if (player.finished) return { success: false, message: "你已完成出牌。" };

        if (this.firstTurn && this.players[this.currentPlayerIndex].hand.some(card => card.suit === 'D' && card.rank === '4')) {
            return { success: false, message: "第一回合必须出牌 (方块4)。" };
        }
        if (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) {
            return { success: false, message: "你必须出牌。" };
        }

        console.log(`[GAME ${this.roomId}] Player ${player.name} passed.`);
        this.consecutivePasses++;
        this.possibleHints = []; this.currentHintIndexInternal = 0;

        const activePlayers = this.players.filter(p => !p.finished && p.connected);
        const activePlayersCount = activePlayers.length;

        if (activePlayersCount <=1 && this.gameStarted && !this.gameFinished) { 
             console.warn(`[GAME ${this.roomId}] Pass resulted in ${activePlayersCount} active players. Game should already be over or ending.`);
             if (!this.gameFinished) {
                 this.endGame("玩家不足或全部过牌");
             }
             return { success: true }; 
        }
        
        if (this.consecutivePasses >= activePlayersCount - 1 && this.lastPlayerWhoPlayed && activePlayersCount > 1) {
            console.log(`[GAME ${this.roomId}] All other active players passed. New round for ${this.players.find(p=>p.id === this.lastPlayerWhoPlayed)?.name}.`);
            const lastPlayerWhoActuallyPlayedId = this.lastPlayerWhoPlayed;
            this.resetTurnState();

            const lastActualPlayerIndex = this.players.findIndex(p => p.id === lastPlayerWhoActuallyPlayedId);
            const lastActualPlayer = this.players[lastActualPlayerIndex];

            if (lastActualPlayer && !lastActualPlayer.finished && lastActualPlayer.connected) {
                this.currentPlayerIndex = lastActualPlayerIndex;
                this.lastPlayerWhoPlayed = null; 
                this.consecutivePasses = 0;
                console.log(`[GAME ${this.roomId}] New round starting with player: ${this.players[this.currentPlayerIndex]?.name}`);
            } else {
                 this.currentPlayerIndex = lastActualPlayerIndex >= 0 ? lastActualPlayerIndex : 0;
                 this.nextTurn(true); 
                 this.lastPlayerWhoPlayed = null;
                 this.consecutivePasses = 0;
                 console.log(`[GAME ${this.roomId}] Last player to play is unavailable. Finding next for new round: ${this.players[this.currentPlayerIndex]?.name}`);
            }
        } else {
            this.nextTurn();
        }
        return { success: true };
    }

    resetTurnState() {
        this.centerPile = [];
        this.lastValidHandInfo = null;
        console.log(`[GAME ${this.roomId}] Turn state reset (pile cleared for new round).`);
    }

    nextTurn(forceAdvanceDueToPlayerAction = false) {
         if (this.gameFinished && !forceAdvanceDueToPlayerAction) return;
         if (this.players.length === 0) return;

         let currentIdx = this.currentPlayerIndex;
         if(currentIdx === -1 && this.players.length > 0) {
             currentIdx = this.players.findIndex(p => p.hand.some(card => card.suit === 'D' && card.rank === '4'));
             if (currentIdx === -1) currentIdx = 0;
         }

         let nextIndex = currentIdx;
         let loopDetection = 0;
         const maxLoops = this.players.length * 3; 
         const numPlayers = this.players.length;
         if (numPlayers === 0) { this.currentPlayerIndex = -1; return; }

         const activePlayers = this.players.filter(p => p.connected && !p.finished);
         if (activePlayers.length <= 1 && this.gameStarted && !this.gameFinished) {
            if (activePlayers.length === 1 && this.finishOrder.length === this.players.length -1 ) {
                if (!this.finishOrder.includes(activePlayers[0].id)) {
                    this.finishOrder.push(activePlayers[0].id);
                    activePlayers[0].finished = true;
                }
                console.log(`[GAME ${this.roomId}] NextTurn detected last player ${activePlayers[0].name}. Calculating final scores.`);
                this.calculateScores(); 
                this.currentPlayerIndex = -1;
                return;
            } else if (activePlayers.length < 2) {
                 console.log(`[GAME ${this.roomId}] NextTurn detected insufficient active players (${activePlayers.length}). Ending game prematurely.`);
                 this.endGame("玩家不足");
                 this.currentPlayerIndex = -1;
                 return;
            }
         }
         if (this.gameFinished) { 
             this.currentPlayerIndex = -1;
             return;
         }

         do {
              nextIndex = (nextIndex - 1 + numPlayers) % numPlayers; 
              loopDetection++;
              if (loopDetection > maxLoops) {
                   console.error(`[GAME ${this.roomId}] Infinite loop in nextTurn! Ending game.`);
                   this.endGame("回合推进错误");
                   this.currentPlayerIndex = -1;
                   return;
              }
         } while (
              !this.players[nextIndex] ||
              this.players[nextIndex].finished ||
              !this.players[nextIndex].connected
         );

         this.currentPlayerIndex = nextIndex;
         console.log(`[GAME ${this.roomId}] Turn advanced to player: ${this.players[this.currentPlayerIndex]?.name} (Slot: ${this.players[this.currentPlayerIndex]?.slot})`);
         this.possibleHints = [];
         this.currentHintIndexInternal = 0;
    }

    findHint(playerId, currentHintCycleIndex = 0) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== this.currentPlayerIndex) return { success: false, message: "现在不是你的回合。" };
        const player = this.players[playerIndex];
        if (!player || !player.connected || player.finished) return { success: false, message: "无效状态。" };

        if (this.possibleHints.length > 0 && this.possibleHints[0].forPlayerId === playerId && this.possibleHints.length > 1) { 
             const nextIdx = (this.currentHintIndexInternal + 1) % this.possibleHints.length;
             this.currentHintIndexInternal = nextIdx;
             return { success: true, hint: this.possibleHints[nextIdx], nextHintIndex: nextIdx };
        }

        this.possibleHints = [];
        const hand = [...player.hand];
        this.sortHand(hand);

        const mustPlay = (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) || (this.firstTurn && player.hand.some(c=>c.rank==='4' && c.suit==='D'));

        for (const card of hand) {
            const validation = this.checkValidPlay([card], hand, this.lastValidHandInfo, this.firstTurn);
            if (validation.valid) this.possibleHints.push({ cards: [card], forPlayerId: playerId, type: HAND_TYPES.SINGLE });
        }
        const ranksInHand = {}; hand.forEach(c => ranksInHand[c.rank] = (ranksInHand[c.rank] || 0) + 1);
        for (const rank in ranksInHand) {
            if (ranksInHand[rank] >= 2) {
                const pairCards = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 2);
                const validation = this.checkValidPlay(pairCards, hand, this.lastValidHandInfo, this.firstTurn);
                if (validation.valid) this.possibleHints.push({ cards: pairCards, forPlayerId: playerId, type: HAND_TYPES.PAIR });
            }
        }
         for (const rank in ranksInHand) {
             if (ranksInHand[rank] >= 3) {
                 const threeCards = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 3);
                 const validation = this.checkValidPlay(threeCards, hand, this.lastValidHandInfo, this.firstTurn);
                 if (validation.valid) this.possibleHints.push({ cards: threeCards, forPlayerId: playerId, type: HAND_TYPES.THREE_OF_A_KIND });
             }
         }
        // TODO: Add more complex hint generation (Straights, Flushes, Full Houses, Straight Flushes)

        this.possibleHints.sort((a, b) => {
             const infoA = this.getHandInfo(a.cards);
             const infoB = this.getHandInfo(b.cards);
             if (!infoA.isValid || !infoB.isValid) return 0;
             if (HAND_TYPE_RANKING[infoA.type] !== HAND_TYPE_RANKING[infoB.type]) {
                 return HAND_TYPE_RANKING[infoB.type] - HAND_TYPE_RANKING[infoA.type];
             }
             return compareHands(infoA, infoB);
        });

        if (this.possibleHints.length > 0) {
             this.currentHintIndexInternal = 0;
             return { success: true, hint: this.possibleHints[0], nextHintIndex: 0 };
        } else {
             return { success: false, message: mustPlay ? "没有符合规则的可出牌组合。" : "没有可打出的牌（可以过牌）。" };
        }
    }

    getHandInfo(cards) {
        if (!Array.isArray(cards) || cards.length === 0) return { isValid: false, message: "无效输入" };
        const n = cards.length;
        const sortedCards = [...cards].sort((a, b) => compareSingleCards(b, a)); 

        const suits = new Set(sortedCards.map(c => c.suit));
        const ranks = sortedCards.map(c => c.rank);
        const rankValues = sortedCards.map(c => RANK_VALUES[c.rank]);

        const isFlush = suits.size === 1;
        let isStraight = false;
        let straightPrimaryRankValue = -1;
        let straightRepresentativeCard = null;

        if (n === 5) {
            const uniqueNumericRanksSorted = [...new Set(rankValues)].sort((a, b) => a - b);
            if (uniqueNumericRanksSorted.length === 5) {
                let consecutive = true;
                for (let i = 0; i < 4; i++) {
                    if (uniqueNumericRanksSorted[i+1] - uniqueNumericRanksSorted[i] !== 1) {
                        consecutive = false; break;
                    }
                }
                if (consecutive) {
                    isStraight = true;
                    straightPrimaryRankValue = uniqueNumericRanksSorted[4]; 
                    straightRepresentativeCard = sortedCards[0]; 
                }
            }
        }

        const rankCounts = {}; ranks.forEach(rank => { rankCounts[rank] = (rankCounts[rank] || 0) + 1; });
        const counts = Object.values(rankCounts).sort((a, b) => b - a);
        const distinctRanks = Object.keys(rankCounts);

        if (n === 5 && isStraight && isFlush) {
            return { isValid: true, type: HAND_TYPES.STRAIGHT_FLUSH, cards: sortedCards, primaryRankValue: straightPrimaryRankValue, representativeCard: straightRepresentativeCard, suitValue: SUIT_VALUES[sortedCards[0].suit] };
        }
        if (n === 5 && counts[0] === 3 && counts[1] === 2) {
            const threeRank = distinctRanks.find(rank => rankCounts[rank] === 3);
            return { isValid: true, type: HAND_TYPES.FULL_HOUSE, cards: sortedCards, primaryRankValue: RANK_VALUES[threeRank], representativeCard: sortedCards.find(c => c.rank === threeRank && SUIT_VALUES[c.suit] === Math.max(...sortedCards.filter(sc=>sc.rank===threeRank).map(sc=>SUIT_VALUES[sc.suit]))) };
        }
        if (n === 5 && isFlush) {
            return { isValid: true, type: HAND_TYPES.FLUSH, cards: sortedCards, representativeCard: sortedCards[0] };
        }
        if (n === 5 && isStraight) {
            return { isValid: true, type: HAND_TYPES.STRAIGHT, cards: sortedCards, primaryRankValue: straightPrimaryRankValue, representativeCard: straightRepresentativeCard };
        }
        if (n === 3 && counts[0] === 3) {
            const threeRank = distinctRanks.find(rank => rankCounts[rank] === 3);
            return { isValid: true, type: HAND_TYPES.THREE_OF_A_KIND, cards: sortedCards, representativeCard: sortedCards.find(c=> c.rank === threeRank && SUIT_VALUES[c.suit] === Math.max(...sortedCards.filter(sc => sc.rank === threeRank).map(sc => SUIT_VALUES[sc.suit]))), primaryRankValue: RANK_VALUES[threeRank] };
        }
        if (n === 2 && counts[0] === 2) {
            const pairRank = distinctRanks.find(rank => rankCounts[rank] === 2);
            return { isValid: true, type: HAND_TYPES.PAIR, cards: sortedCards, representativeCard: sortedCards[0], primaryRankValue: RANK_VALUES[pairRank] };
        }
        if (n === 1) {
            return { isValid: true, type: HAND_TYPES.SINGLE, cards: sortedCards, representativeCard: sortedCards[0], primaryRankValue: RANK_VALUES[ranks[0]] };
        }

        if (counts[0] === 4 && (n === 4 || n === 5)) {
            return { isValid: false, message: "此游戏规则不允许四条 (炸弹)。" };
        }
        return { isValid: false, message: "无法识别的牌型或不允许的出牌组合。" };
     }

     checkValidPlay(cardsToPlay, currentHand, centerPileInfo, isFirstTurnFlag) {
         const newHandInfo = this.getHandInfo(cardsToPlay);
         if (!newHandInfo.isValid) return { valid: false, message: newHandInfo.message || "无效的牌型。" };

         if (isFirstTurnFlag) {
             const hasD4 = cardsToPlay.some(c => c.suit === 'D' && c.rank === '4');
             if (!hasD4) return { valid: false, message: "第一回合必须包含方块4。" };
             return { valid: true, handInfo: newHandInfo };
         } else {
             if (!centerPileInfo) {
                 return { valid: true, handInfo: newHandInfo };
             }
             if (newHandInfo.type !== centerPileInfo.type) {
                 return { valid: false, message: `必须出与上家相同类型的牌 (${centerPileInfo.type})。` };
             }
             if (newHandInfo.cards.length !== centerPileInfo.cards.length) {
                 return { valid: false, message: `必须出与上家相同数量的牌 (${centerPileInfo.cards.length}张)。`};
             }
             const comparison = compareHands(newHandInfo, centerPileInfo);
             if (comparison > 0) {
                 return { valid: true, handInfo: newHandInfo };
             } else {
                 return { valid: false, message: `出的 ${newHandInfo.type} 必须大于上家的。` };
             }
         }
     }

    checkInstantGameOver() {
        const nFinished = this.finishOrder.length;
        if (this.gameMode === 'standard' && nFinished < 2 && this.finishOrder.length < this.players.length) return { isOver: false };
        if (this.gameMode === 'double_landlord' && nFinished < 1 && this.finishOrder.length < this.players.length) return { isOver: false };

        const finishRoles = this.finishOrder.map(playerId => this.playerRoles[playerId]);
        let resultDescription = null; let isOver = false;

        if (this.gameMode === 'standard') { 
            if (nFinished >= 2) {
                if (finishRoles[0] === 'D' && finishRoles[1] === 'D') { resultDescription = "地主大胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'F') { resultDescription = "农民大胜"; isOver = true; }
            }
            if (!isOver && nFinished >= 3) {
                if (finishRoles[0] === 'D' && finishRoles[1] === 'F' && finishRoles[2] === 'D') { resultDescription = "地主胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'D' && finishRoles[2] === 'F') { resultDescription = "农民胜"; isOver = true; }
            }
            if (!isOver && nFinished === 4) {
                const rolesStr = finishRoles.join('');
                if (rolesStr === 'DFFD' || rolesStr === 'FDDF') { resultDescription = "打平"; isOver = true; }
            }
             if(!isOver && nFinished === 3 && this.players.length === 4) {
                const lastPlayerId = this.players.find(p => !this.finishOrder.includes(p.id))?.id;
                if (lastPlayerId) {
                    const lastPlayerRole = this.playerRoles[lastPlayerId];
                    const currentOrder = finishRoles.join('');
                    if (currentOrder === 'DFF' && lastPlayerRole === 'D') { resultDescription = "打平"; isOver = true; }
                    if (currentOrder === 'FDD' && lastPlayerRole === 'F') { resultDescription = "打平"; isOver = true; }
                }
            }
        } else { 
            if (finishRoles[0] === 'DD') { resultDescription = "双地主大胜"; isOver = true; }
            else if (nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'F') {
                resultDescription = "农民大胜"; isOver = true;
            }
            else if (!isOver && nFinished >= 2 && finishRoles[0] === 'F' && finishRoles[1] === 'DD') {
                resultDescription = "双地主胜"; isOver = true;
            }
            else if (!isOver && nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'DD') {
                resultDescription = "农民胜"; isOver = true;
            }
        }
        if (isOver && resultDescription) this.gameResultText = resultDescription;
        return { isOver, resultDescription };
     }

    calculateScoresBasedOnResult(resultDescription) {
         const currentScoreChanges = {};
         let landlordScoreChange = 0;
         let farmerScoreChange = 0;
         let ddScoreChange = 0;
         console.log(`[SCORE] Calculating scores based on result: ${resultDescription}`);

         if (!resultDescription && this.finishOrder.length === this.players.length) { 
            resultDescription = "打平"; 
         } else if (!resultDescription) {
            console.warn(`[SCORE] No resultDescription provided. Defaulting to '结果未定'.`);
            resultDescription = "结果未定";
         }
         this.gameResultText = resultDescription;

         if (this.gameMode === 'standard') {
             switch (resultDescription) {
                 case "打平": landlordScoreChange = 0; farmerScoreChange = 0; break;
                 case "地主胜": landlordScoreChange = 1; farmerScoreChange = -1; break;
                 case "农民胜": landlordScoreChange = -1; farmerScoreChange = 1; break;
                 case "地主大胜": landlordScoreChange = 2; farmerScoreChange = -2; break;
                 case "农民大胜": landlordScoreChange = -2; farmerScoreChange = 2; break;
                 default: console.warn(`[SCORE] Unknown standard result: ${resultDescription}. No score change.`); break;
             }
             this.players.forEach(p => { currentScoreChanges[p.id] = (this.playerRoles[p.id] === 'D') ? landlordScoreChange : farmerScoreChange; });
         } else { 
             switch (resultDescription) {
                 case "双地主大胜": ddScoreChange = 6; farmerScoreChange = -2; break;
                 case "双地主胜": ddScoreChange = 3; farmerScoreChange = -1; break;
                 case "农民胜": ddScoreChange = -3; farmerScoreChange = 1; break;
                 case "农民大胜": ddScoreChange = -6; farmerScoreChange = 2; break;
                 default: console.warn(`[SCORE] Unknown double landlord result: ${resultDescription}. No score change.`); break;
             }
              this.players.forEach(p => { currentScoreChanges[p.id] = (this.playerRoles[p.id] === 'DD') ? ddScoreChange : farmerScoreChange; });
         }

         console.log(`[SCORE] Result: ${resultDescription}`);
         const currentFinalScores = this.players.map(p => {
             const change = currentScoreChanges[p.id] || 0;
             p.score += change;
             console.log(`[SCORE] Player ${p.name} (${p.role}): ${change >= 0 ? '+' : ''}${change} -> New Total Score: ${p.score}`);
             return { id: p.id, name: p.name, score: p.score, role: p.role };
         });
         this.scoreChanges = currentScoreChanges;
         this.finalScores = currentFinalScores;

          return {
              result: resultDescription,
              scoreChanges: currentScoreChanges,
              finalScores: currentFinalScores,
              roomId: this.roomId
          };
      }

    calculateScores() {
        if (this.finishOrder.length < this.players.length) {
            const finishedIds = new Set(this.finishOrder);
            const remainingPlayers = this.players.filter(p => !finishedIds.has(p.id));
            remainingPlayers.sort((a,b) => {
                if(a.connected !== b.connected) return a.connected ? -1 : 1;
                return a.hand.length - b.hand.length || a.slot - b.slot;
            })
                            .forEach(p => { if(!this.finishOrder.includes(p.id)) this.finishOrder.push(p.id); });
        }

        const instantResult = this.checkInstantGameOver();
        if (instantResult.isOver && instantResult.resultDescription) {
            return this.calculateScoresBasedOnResult(instantResult.resultDescription);
        }
        return this.calculateScoresBasedOnResult("打平"); 
    }

    endGame(reason = "游戏结束") {
          if (this.gameFinished) {
            return { result: this.gameResultText, scoreChanges: this.scoreChanges, finalScores: this.finalScores, reason: this.gameOverReason, roomId: this.roomId };
          }
          this.gameFinished = true; this.gameStarted = false;
          this.gameOverReason = reason;
          console.log(`[GAME ${this.roomId}] Game ended. Reason: ${reason}`);

          if (this.finishOrder.length < this.players.length) {
               const finishedIds = new Set(this.finishOrder);
               const remainingPlayers = this.players.filter(p => !finishedIds.has(p.id)); 
               remainingPlayers.sort((a,b) => {
                    if (a.connected !== b.connected) return a.connected ? -1 : 1; 
                    if (a.hand.length !== b.hand.length) return a.hand.length - b.hand.length;
                    return a.slot - b.slot;
               });
               remainingPlayers.forEach(p => { if(!this.finishOrder.includes(p.id)) this.finishOrder.push(p.id); });
          }

          const scoreResult = this.calculateScores();
          this.gameResultText = scoreResult.result;
          this.finalScores = scoreResult.finalScores;
          this.scoreChanges = scoreResult.scoreChanges;

          return { ...scoreResult, reason: reason, roomId: this.roomId }; 
     }

    createDeck() {
        const suits = ["D", "C", "H", "S"];
        const ranks = ["4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2", "3"];
        this.deck = [];
        for (const suit of suits) { for (const rank of ranks) { this.deck.push({ suit, rank }); } }
     }
    shuffleDeck() {
         for (let i = this.deck.length - 1; i > 0; i--) {
            const j = crypto.randomInt(i + 1);
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
     }
    dealCards(cardsPerPlayer) {
         let playerDealOrder = [...this.players].sort((a,b) => a.slot - b.slot);
         const totalCardsToDeal = cardsPerPlayer * playerDealOrder.length;

         if (totalCardsToDeal > this.deck.length) {
             console.error(`[DEAL ERROR] Not enough cards (${this.deck.length}) for ${totalCardsToDeal} cards.`);
             this.endGame("发牌错误：牌数不足"); return;
         }
         for (let i = 0; i < cardsPerPlayer; i++) {
             for (const player of playerDealOrder) {
                 if (this.deck.length > 0) { player.hand.push(this.deck.pop()); }
                 else { console.error(`[DEAL ERROR] Ran out of cards.`); this.endGame("发牌错误：中途缺牌"); return; }
             }
         }
         this.players.forEach(player => this.sortHand(player.hand));
     }
    sortHand(hand) { hand.sort(compareSingleCards); }

    getStateForPlayer(requestingPlayerId) {
        return {
            players: this.players.map(p => ({
                id: p.id, name: p.name, slot: p.slot, score: p.score,
                role: p.role, 
                finished: p.finished,
                connected: p.connected,
                hand: p.id === requestingPlayerId ? p.hand : undefined,
                handCount: p.hand.length,
            })),
            centerPile: [...this.centerPile],
            lastHandInfo: this.lastValidHandInfo ? { type: this.lastValidHandInfo.type, cards: this.lastValidHandInfo.cards, representativeCard: this.lastValidHandInfo.representativeCard } : null,
            currentPlayerId: this.gameFinished ? null : (this.currentPlayerIndex >=0 && this.players[this.currentPlayerIndex] ? this.players[this.currentPlayerIndex].id : null),
            isFirstTurn: this.firstTurn,
            gameStarted: this.gameStarted,
            gameFinished: this.gameFinished,
            winnerId: this.winnerId,
            gameMode: this.gameMode,
            finishOrder: [...this.finishOrder],
            lastPlayerWhoPlayedId: this.lastPlayerWhoPlayed,
            gameResultText: this.gameResultText,
            gameOverReason: this.gameOverReason,
            finalScores: this.finalScores,
            scoreChanges: this.scoreChanges
        };
    }
}

module.exports = { Game };
