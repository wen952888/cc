const crypto = require('crypto');

// --- Constants for Rules ---
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

// --- Helper Functions ---
function compareSingleCards(cardA, cardB) {
    const rankValueA = RANK_VALUES[cardA.rank];
    const rankValueB = RANK_VALUES[cardB.rank];
    if (rankValueA !== rankValueB) return rankValueA - rankValueB;
    return SUIT_VALUES[cardA.suit] - SUIT_VALUES[cardB.suit];
}

function compareHands(handInfoA, handInfoB) {
    // Assumes A and B are valid handInfos from getHandInfo
    const rankA = HAND_TYPE_RANKING[handInfoA.type];
    const rankB = HAND_TYPE_RANKING[handInfoB.type];

    // Higher rank type wins (no bombs, so strict comparison)
    if (rankA !== rankB) return rankA - rankB;

    // Same type comparison
    switch (handInfoA.type) {
        case HAND_TYPES.STRAIGHT_FLUSH:
            if (handInfoA.primaryRankValue !== handInfoB.primaryRankValue) {
                return handInfoA.primaryRankValue - handInfoB.primaryRankValue;
            }
            return handInfoA.suitValue - handInfoB.suitValue;
        case HAND_TYPES.FULL_HOUSE: // Fallthrough
        case HAND_TYPES.STRAIGHT:
            return handInfoA.primaryRankValue - handInfoB.primaryRankValue;
        case HAND_TYPES.FLUSH:
            for (let i = 0; i < handInfoA.cards.length; i++) {
                const compareResult = compareSingleCards(handInfoA.cards[i], handInfoB.cards[i]);
                if (compareResult !== 0) return compareResult;
            }
            return 0;
        case HAND_TYPES.THREE_OF_A_KIND: // Fallthrough
        case HAND_TYPES.PAIR: // Fallthrough
        case HAND_TYPES.SINGLE:
            return compareSingleCards(handInfoA.representativeCard, handInfoB.representativeCard);
        default: return 0;
    }
}


class Game {
    constructor(roomId, maxPlayers = 4) {
        this.roomId = roomId;
        this.maxPlayers = maxPlayers;
        this.players = []; // { id, name, slot, hand:[], score:0, connected: true, finished: false, role: null }
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
    }

    addPlayer(userId, username, slot) {
        if (this.players.length >= this.maxPlayers || this.players.some(p => p.id === userId)) return false;
        this.players.push({
            id: userId, name: username, slot: slot, hand: [], score: 0,
            connected: true, finished: false, role: null
        });
        this.players.sort((a, b) => a.slot - b.slot); // Keep players sorted by slot
        return true;
    }

    removePlayer(userId) { this.markPlayerConnected(userId, false); }

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

        if (playerStartInfo.length !== this.maxPlayers) return { success: false, message: `需要 ${this.maxPlayers} 玩家。` };

        this.players = playerStartInfo.map(info => ({
            id: info.id, name: info.name, slot: info.slot, hand: [], score: this.players.find(p=>p.id === info.id)?.score || 0,
            connected: true, finished: false, role: null
        })).sort((a, b) => a.slot - b.slot);

        console.log(`[GAME ${this.roomId}] Starting game with players:`, this.players.map(p => p.name));
        this.createDeck(); this.shuffleDeck(); this.dealCards(13);
        this.gameStarted = true; this.firstTurn = true;

        let s3PlayerId = null, saPlayerId = null;
        this.players.forEach(p => {
            if (p.hand.some(c => c.suit === 'S' && c.rank === '3')) s3PlayerId = p.id;
            if (p.hand.some(c => c.suit === 'S' && c.rank === 'A')) saPlayerId = p.id;
        });
        if (!s3PlayerId || !saPlayerId) return { success: false, message: "发牌错误，无法确定身份！" };

        if (s3PlayerId === saPlayerId) {
            this.gameMode = 'double_landlord';
            this.playerRoles[s3PlayerId] = 'DD';
            this.players.forEach(p => { p.role = (p.id === s3PlayerId) ? 'DD' : 'F'; this.playerRoles[p.id] = p.role; });
        } else {
            this.gameMode = 'standard';
            this.playerRoles[s3PlayerId] = 'D'; this.playerRoles[saPlayerId] = 'D';
            this.players.forEach(p => { p.role = (p.id === s3PlayerId || p.id === saPlayerId) ? 'D' : 'F'; this.playerRoles[p.id] = p.role; });
        }
        console.log(`[GAME ${this.roomId}] Game Mode: ${this.gameMode}. Roles assigned.`);

        let startingPlayerIndex = -1;
        for (let i = 0; i < this.players.length; i++) {
            if (this.players[i].hand.some(card => card.suit === 'D' && card.rank === '4')) {
                startingPlayerIndex = i; break;
            }
        }
        if (startingPlayerIndex === -1) return { success: false, message: "发牌错误，未找到方块4！" };
        this.currentPlayerIndex = startingPlayerIndex;
        this.lastPlayerWhoPlayed = null;

        console.log(`[GAME ${this.roomId}] Player ${this.players[this.currentPlayerIndex].name} starts (has D4).`);
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

        this.centerPile = cards;
        this.lastValidHandInfo = validationResult.handInfo;
        this.lastPlayerWhoPlayed = playerId;
        this.consecutivePasses = 0;
        if (this.firstTurn) this.firstTurn = false;
        console.log(`[GAME ${this.roomId}] Player ${player.name} played ${this.lastValidHandInfo.type}.`);
        this.possibleHints = []; this.currentHintIndexInternal = 0;

        let gameOver = false;
        let scoreResult = null;
        if (player.hand.length === 0) {
            this.finishOrder.push(playerId);
            player.finished = true;
            if (!this.winnerId) this.winnerId = playerId;
            console.log(`[GAME ${this.roomId}] Player ${player.name} finished ${this.finishOrder.length}.`);

            const instantResult = this.checkInstantGameOver();
            if (instantResult.isOver) {
                gameOver = true;
                scoreResult = this.calculateScoresBasedOnResult(instantResult.resultDescription);
                this.gameFinished = true; this.gameStarted = false;
                console.log(`[GAME ${this.roomId}] Game result determined early: ${instantResult.resultDescription}`);
            } else if (this.finishOrder.length === this.players.length -1) {
                 const lastPlayer = this.players.find(p => !p.finished);
                 if(lastPlayer) this.finishOrder.push(lastPlayer.id);
                 gameOver = true;
                 const finalInstantResult = this.checkInstantGameOver();
                 if (finalInstantResult.isOver) {
                    scoreResult = this.calculateScoresBasedOnResult(finalInstantResult.resultDescription);
                 } else {
                    console.warn(`[GAME ${this.roomId}] All but one finished, but checkInstantGameOver did not yield a result. Calculating generic scores.`);
                    scoreResult = this.calculateScores();
                 }
                 this.gameFinished = true; this.gameStarted = false;
                 console.log(`[GAME ${this.roomId}] All players finished (last one remaining).`);
            }
        }

        if (gameOver) {
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
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== this.currentPlayerIndex) return { success: false, message: "现在不是你的回合。" };
        const player = this.players[playerIndex];
        if (!player.connected) return { success: false, message: "你已断线。" };
        if (player.finished) return { success: false, message: "你已完成出牌。" };
        if (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) {
            return { success: false, message: "你必须出牌。" };
        }

        console.log(`[GAME ${this.roomId}] Player ${player.name} passed.`);
        this.consecutivePasses++;
        this.possibleHints = []; this.currentHintIndexInternal = 0;

        const activePlayersCount = this.players.filter(p => !p.finished && p.connected).length;
        if (this.consecutivePasses >= activePlayersCount - 1 && this.lastPlayerWhoPlayed) {
            console.log(`[GAME ${this.roomId}] All other active players passed. Resetting turn state.`);
            const lastPlayerWhoPlayedId = this.lastPlayerWhoPlayed;
            this.resetTurnState();

            const lastActualPlayerIndex = this.players.findIndex(p => p.id === lastPlayerWhoPlayedId);
            const lastActualPlayer = this.players[lastActualPlayerIndex];

            if (lastActualPlayer && !lastActualPlayer.finished && lastActualPlayer.connected) {
                this.currentPlayerIndex = lastActualPlayerIndex;
                this.lastPlayerWhoPlayed = null;
                console.log(`[GAME ${this.roomId}] New round starting with player: ${this.players[this.currentPlayerIndex]?.name}`);
            } else {
                 this.currentPlayerIndex = lastActualPlayerIndex;
                 this.nextTurn(true);
                 this.lastPlayerWhoPlayed = null;
                 console.log(`[GAME ${this.roomId}] Last player to play is unavailable. Finding next available player for new round.`);
            }
        } else {
            this.nextTurn();
        }
        return { success: true };
    }

    resetTurnState() {
        this.centerPile = [];
        this.lastValidHandInfo = null;
        this.consecutivePasses = 0;
        console.log(`[GAME ${this.roomId}] Turn state reset (pile cleared).`);
    }

    nextTurn(forceAdvance = false) {
         if (this.gameFinished && !forceAdvance) return;
         if (this.players.length === 0) return;

         let currentIdx = this.currentPlayerIndex;
         if(currentIdx === -1 && this.players.length > 0) {
             currentIdx = 0;
         }

         let nextIndex = currentIdx;
         let loopDetection = 0;
         const maxLoops = this.players.length * 2;

         const numPlayers = this.players.length;
         if (numPlayers === 0) {
            this.currentPlayerIndex = -1;
            return;
         }

         do {
              // MODIFICATION FOR REVERSE (COUNTER-CLOCKWISE) ORDER
              nextIndex = (nextIndex - 1 + numPlayers) % numPlayers;
              // END MODIFICATION

              loopDetection++;
              if (loopDetection > maxLoops) {
                   console.error(`[GAME ${this.roomId}] Infinite loop detected in nextTurn! Current player: ${this.players[currentIdx]?.name}, Next attempted: ${this.players[nextIndex]?.name}. All players:`, this.players.map(p => ({name:p.name, finished:p.finished, connected:p.connected })));
                   this.currentPlayerIndex = -1;
                   this.endGame("Turn Advancement Error");
                   return;
              }
         } while (
              !this.players[nextIndex] || this.players[nextIndex].finished || !this.players[nextIndex].connected
         );

         this.currentPlayerIndex = nextIndex;
         console.log(`[GAME ${this.roomId}] Turn advanced to player: ${this.players[this.currentPlayerIndex]?.name} (New order: Counter-Clockwise)`);
         this.possibleHints = [];
         this.currentHintIndexInternal = 0;
    }

    findHint(playerId, currentHintIndex = 0) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== this.currentPlayerIndex) return { success: false, message: "现在不是你的回合。" };
        const player = this.players[playerIndex];
        if (!player || !player.connected || player.finished) return { success: false, message: "无效状态。" };

        if (this.possibleHints.length > 0 && this.possibleHints[0].forPlayerId === playerId) {
             const nextIdx = (currentHintIndex + 1) % this.possibleHints.length;
             return { success: true, hint: this.possibleHints[nextIdx], nextHintIndex: nextIdx };
        }

        this.possibleHints = [];
        const hand = player.hand;

        for (const card of hand) {
            const validation = this.checkValidPlay([card], hand, this.lastValidHandInfo, this.firstTurn);
            if (validation.valid) this.possibleHints.push({ cards: [card], forPlayerId: playerId });
        }

        const ranksInHand = {};
        hand.forEach(c => ranksInHand[c.rank] = (ranksInHand[c.rank] || 0) + 1);
        for (const rank in ranksInHand) {
            if (ranksInHand[rank] >= 2) {
                const pairCards = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 2);
                const validation = this.checkValidPlay(pairCards, hand, this.lastValidHandInfo, this.firstTurn);
                if (validation.valid) this.possibleHints.push({ cards: pairCards, forPlayerId: playerId });
            }
        }
         for (const rank in ranksInHand) {
             if (ranksInHand[rank] >= 3) {
                 const threeCards = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 3);
                 const validation = this.checkValidPlay(threeCards, hand, this.lastValidHandInfo, this.firstTurn);
                 if (validation.valid) this.possibleHints.push({ cards: threeCards, forPlayerId: playerId });
             }
         }

        this.possibleHints.sort((a, b) => {
             const infoA = this.getHandInfo(a.cards);
             const infoB = this.getHandInfo(b.cards);
             return compareHands(infoA, infoB);
        });


        if (this.possibleHints.length > 0) {
             this.currentHintIndexInternal = 0;
             return { success: true, hint: this.possibleHints[0], nextHintIndex: 0 };
        } else {
             return { success: false, message: "没有可出的牌。" };
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
        if (n === 5) {
            const uniqueRankValuesSorted = [...new Set(rankValues)].sort((a, b) => a - b);
            if (uniqueRankValuesSorted.length === 5) {
                if (uniqueRankValuesSorted[4] - uniqueRankValuesSorted[0] === 4) {
                    isStraight = true;
                    straightPrimaryRankValue = uniqueRankValuesSorted[4];
                }
            }
        }
        const rankCounts = {}; ranks.forEach(rank => { rankCounts[rank] = (rankCounts[rank] || 0) + 1; });
        const counts = Object.values(rankCounts).sort((a, b) => b - a);
        const distinctRanks = Object.keys(rankCounts);

        if (n === 5 && isStraight && isFlush) {
            return { isValid: true, type: HAND_TYPES.STRAIGHT_FLUSH, cards: sortedCards, primaryRankValue: straightPrimaryRankValue, suitValue: SUIT_VALUES[sortedCards[0].suit] };
        }
        if (n === 5 && counts[0] === 3 && counts[1] === 2) {
            const threeRank = distinctRanks.find(rank => rankCounts[rank] === 3);
            return { isValid: true, type: HAND_TYPES.FULL_HOUSE, cards: sortedCards, primaryRankValue: RANK_VALUES[threeRank] };
        }
        if (n === 5 && isFlush) {
            return { isValid: true, type: HAND_TYPES.FLUSH, cards: sortedCards };
        }
        if (n === 5 && isStraight) {
            return { isValid: true, type: HAND_TYPES.STRAIGHT, cards: sortedCards, primaryRankValue: straightPrimaryRankValue };
        }
        if (n === 3 && counts[0] === 3) {
            const threeRank = distinctRanks.find(rank => rankCounts[rank] === 3);
            return { isValid: true, type: HAND_TYPES.THREE_OF_A_KIND, cards: sortedCards, representativeCard: sortedCards[0], primaryRankValue: RANK_VALUES[threeRank] };
        }
        if (n === 2 && counts[0] === 2) {
            const pairRank = distinctRanks.find(rank => rankCounts[rank] === 2);
            return { isValid: true, type: HAND_TYPES.PAIR, cards: sortedCards, representativeCard: sortedCards[0], primaryRankValue: RANK_VALUES[pairRank] };
        }
        if (n === 1) {
            return { isValid: true, type: HAND_TYPES.SINGLE, cards: sortedCards, representativeCard: sortedCards[0], primaryRankValue: RANK_VALUES[ranks[0]] };
        }
        if (counts[0] === 4 && n === 4) {
            return { isValid: false, message: "不允许出四条炸弹。" };
        }
        if (n === 5 && counts[0] === 4) {
             return { isValid: false, message: "不允许四条带单张 (非标准牌型)。" };
        }
        return { isValid: false, message: "无法识别的牌型或不允许的出牌组合。" };
     }

    checkValidPlay(cardsToPlay, currentHand, centerPileInfo, isFirstTurn) {
         const newHandInfo = this.getHandInfo(cardsToPlay);
         if (!newHandInfo.isValid) return { valid: false, message: newHandInfo.message || "无效的牌型。" };
         if (isFirstTurn) {
             const hasD4 = cardsToPlay.some(c => c.suit === 'D' && c.rank === '4');
             if (!hasD4) return { valid: false, message: "第一回合必须包含方块4。" };
             return { valid: true, handInfo: newHandInfo };
         } else {
             if (!centerPileInfo) return { valid: true, handInfo: newHandInfo };
             if (newHandInfo.type !== centerPileInfo.type) return { valid: false, message: `必须出与上家相同类型的牌 (${centerPileInfo.type})。` };
             if (newHandInfo.cards.length !== centerPileInfo.cards.length) return { valid: false, message: `必须出与上家相同数量的牌 (${centerPileInfo.cards.length}张)。`};
             const comparison = compareHands(newHandInfo, centerPileInfo);
             if (comparison > 0) return { valid: true, handInfo: newHandInfo };
             else return { valid: false, message: `出的 ${newHandInfo.type} 必须大于上家的。` };
         }
     }

    checkInstantGameOver() {
        const nFinished = this.finishOrder.length;
        if (this.gameMode === 'standard' && nFinished < 2) return { isOver: false };
        if (this.gameMode === 'double_landlord' && nFinished < 1) return { isOver: false };

        const finishRoles = this.finishOrder.map(playerId => this.playerRoles[playerId]);
        let resultDescription = null; let isOver = false;

        if (this.gameMode === 'standard') {
            const rolesStr = finishRoles.join('');
            if (nFinished >= 2) {
                if (finishRoles[0] === 'D' && finishRoles[1] === 'D') { resultDescription = "地主大胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'F') { resultDescription = "农民大胜"; isOver = true; }
            }
            if (!isOver && nFinished >= 3) {
                if (finishRoles[0] === 'D' && finishRoles[1] === 'F' && finishRoles[2] === 'D') { resultDescription = "地主胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'D' && finishRoles[2] === 'F') { resultDescription = "农民胜"; isOver = true; }
                else if ( (finishRoles[0] === 'D' && finishRoles[1] === 'F' && finishRoles[2] === 'F') ||
                          (finishRoles[0] === 'F' && finishRoles[1] === 'D' && finishRoles[2] === 'D') )
                          { resultDescription = "打平"; isOver = true; }
            }
            if (!isOver && nFinished === 4) {
                if (rolesStr === 'DFDF') { resultDescription = "地主胜"; isOver = true; }
                else if (rolesStr === 'FDFD') { resultDescription = "农民胜"; isOver = true; }
                else if (rolesStr === 'DFFD' || rolesStr === 'FDDF') { resultDescription = "打平"; isOver = true; }
            }
        } else { // Double Landlord
            if (nFinished === 0) return { isOver: false };
            if (finishRoles[0] === 'DD') { resultDescription = "双地主大胜"; isOver = true; }
            else if (nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'F') { resultDescription = "农民大胜"; isOver = true; }
            else if (nFinished >= 2 && finishRoles[0] === 'F' && finishRoles[1] === 'DD') { resultDescription = "双地主胜"; isOver = true; }
            else if (nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'DD') { resultDescription = "农民胜"; isOver = true; }
        }
        return { isOver, resultDescription };
     }

    calculateScoresBasedOnResult(resultDescription) {
         const scoreChanges = {}; let landlordScoreChange = 0; let farmerScoreChange = 0; let ddScoreChange = 0;
         console.log(`[SCORE] Calculating scores based on result: ${resultDescription}`);
         if (!resultDescription) {
             console.warn(`[SCORE] No resultDescription provided. Scores cannot be calculated.`);
             return { result: "未知结果 (计算错误)", scoreChanges: {}, finalScores: this.players.map(p => ({ id: p.id, name: p.name, score: p.score, role: this.playerRoles[p.id] })) };
         }

         if (this.gameMode === 'standard') {
             switch (resultDescription) {
                 case "打平": landlordScoreChange = 0; farmerScoreChange = 0; break;
                 case "地主胜": landlordScoreChange = 1; farmerScoreChange = -1; break;
                 case "农民胜": landlordScoreChange = -1; farmerScoreChange = 1; break;
                 case "地主大胜": landlordScoreChange = 2; farmerScoreChange = -2; break;
                 case "农民大胜": landlordScoreChange = -2; farmerScoreChange = 2; break;
                 default: console.warn(`[SCORE] Unknown standard result: ${resultDescription}`);
             }
             this.players.forEach(p => { scoreChanges[p.id] = (this.playerRoles[p.id] === 'D') ? landlordScoreChange : farmerScoreChange; });
         } else {
             switch (resultDescription) {
                 case "双地主大胜": ddScoreChange = 6; farmerScoreChange = -2; break;
                 case "双地主胜": ddScoreChange = 3; farmerScoreChange = -1; break;
                 case "农民胜": ddScoreChange = -3; farmerScoreChange = 1; break;
                 case "农民大胜": ddScoreChange = -6; farmerScoreChange = 2; break;
                 default: console.warn(`[SCORE] Unknown double landlord result: ${resultDescription}`);
             }
              this.players.forEach(p => { scoreChanges[p.id] = (this.playerRoles[p.id] === 'DD') ? ddScoreChange : farmerScoreChange; });
         }
         console.log(`[SCORE] Result: ${resultDescription}`);
         this.players.forEach(p => {
             const change = scoreChanges[p.id] || 0;
             p.score += change;
             console.log(`[SCORE] Player ${p.name} (${this.playerRoles[p.id]}): ${change >= 0 ? '+' : ''}${change} -> New Total Score: ${p.score}`);
         });
          return {
              result: resultDescription,
              scoreChanges: scoreChanges,
              finalScores: this.players.map(p => ({ id: p.id, name: p.name, score: p.score, role: this.playerRoles[p.id] }))
          };
      }

    calculateScores() {
        console.warn(`[SCORE] Using fallback calculateScores(). This usually means an incomplete game or unhandled end condition.`);
        const instantResult = this.checkInstantGameOver();
        if (instantResult.isOver && instantResult.resultDescription) {
            return this.calculateScoresBasedOnResult(instantResult.resultDescription);
        }
        return this.calculateScoresBasedOnResult("打平");
    }

    endGame(reason = "Game finished") {
          if (this.gameFinished) return null;
          this.gameFinished = true; this.gameStarted = false;
          console.log(`[GAME ${this.roomId}] Game ended. Reason: ${reason}`);
          if (this.finishOrder.length < this.players.length) {
               const finishedIds = new Set(this.finishOrder);
               const remainingPlayers = this.players.filter(p => !finishedIds.has(p.id));
               remainingPlayers.sort((a,b) => a.hand.length - b.hand.length);
               remainingPlayers.forEach(p => this.finishOrder.push(p.id));
          }
          const scoreResult = this.calculateScores();
          return scoreResult;
     }

    createDeck() {
        const suits = ["H", "D", "C", "S"];
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
         let playerIdx = 0;
         const totalCardsToDeal = cardsPerPlayer * this.players.length;
         if (totalCardsToDeal > this.deck.length) {
             console.error(`[DEAL ERROR] Not enough cards in deck (${this.deck.length}) to deal ${totalCardsToDeal} cards.`);
             return;
         }
         for (let i = 0; i < totalCardsToDeal; i++) {
             const player = this.players[playerIdx % this.players.length];
             if (player) {
                player.hand.push(this.deck.pop());
             }
             playerIdx++;
         }
         this.players.forEach(player => this.sortHand(player.hand));
     }
    sortHand(hand) { hand.sort(compareSingleCards); }

    getStateForPlayer(requestingPlayerId) {
        return {
            players: this.players.map(p => ({
                id: p.id, name: p.name, slot: p.slot, score: p.score,
                role: this.playerRoles[p.id] || p.role,
                finished: p.finished,
                connected: p.connected,
                hand: p.id === requestingPlayerId ? p.hand : undefined,
                handCount: p.hand.length,
            })),
            centerPile: [...this.centerPile],
            lastHandInfo: this.lastValidHandInfo ? { type: this.lastValidHandInfo.type, cards: this.lastValidHandInfo.cards } : null,
            currentPlayerId: this.gameFinished ? null : (this.currentPlayerIndex >=0 && this.players[this.currentPlayerIndex] ? this.players[this.currentPlayerIndex].id : null),
            isFirstTurn: this.firstTurn,
            gameStarted: this.gameStarted,
            gameFinished: this.gameFinished,
            winnerId: this.winnerId,
            gameMode: this.gameMode,
            finishOrder: [...this.finishOrder],
            lastPlayerWhoPlayedId: this.lastPlayerWhoPlayed
        };
    }
}

module.exports = { Game };
