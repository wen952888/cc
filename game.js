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
            // For flush, compare cards one by one from highest to lowest
            // The cards in handInfo.cards are already sorted highest to lowest by getHandInfo
            for (let i = 0; i < handInfoA.cards.length; i++) {
                const compareResult = compareSingleCards(handInfoA.cards[i], handInfoB.cards[i]);
                if (compareResult !== 0) return compareResult;
            }
            return 0; // Should not happen if ranks were different before, but for safety
        case HAND_TYPES.THREE_OF_A_KIND: // Fallthrough
        case HAND_TYPES.PAIR: // Fallthrough
        case HAND_TYPES.SINGLE:
            // Compare the representative card (highest card in pair/triple, or the single card)
            return compareSingleCards(handInfoA.representativeCard, handInfoB.representativeCard);
        default: return 0; // Should not happen
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
        this.playerRoles = {}; // Stores role by playerId {playerId: 'D'/'F'/'DD'}
        this.finishOrder = []; // Array of playerIds in the order they finished
        this.gameMode = null; // 'standard' or 'double_landlord'
        this.consecutivePasses = 0;
        this.lastPlayerWhoPlayed = null; // Player ID of the last player to make a valid non-pass play
        this.possibleHints = []; // Stores array of {cards: [...]} for current player
        this.currentHintIndexInternal = 0; // Internal state for cycling hints
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

    removePlayer(userId) { // Called when a player leaves or disconnects during a game
        this.markPlayerConnected(userId, false);
    }

    markPlayerConnected(userId, isConnected) {
        const player = this.players.find(p => p.id === userId);
        if (player) {
            player.connected = !!isConnected; // Ensure boolean
            console.log(`[GAME ${this.roomId}] Player ${player.name} connection status set to ${player.connected}`);
        }
    }

    // playerStartInfo: [{id, name, slot}, ...]
    startGame(playerStartInfo) {
        // Reset game state for a new game
        this.deck = []; this.centerPile = []; this.lastValidHandInfo = null; this.currentPlayerIndex = -1;
        this.firstTurn = true; this.gameStarted = false; this.gameFinished = false; this.winnerId = null;
        this.playerRoles = {}; this.finishOrder = []; this.gameMode = null; this.consecutivePasses = 0; this.lastPlayerWhoPlayed = null;
        this.possibleHints = []; this.currentHintIndexInternal = 0;

        if (playerStartInfo.length !== this.maxPlayers) return { success: false, message: `需要 ${this.maxPlayers} 玩家。` };

        // Initialize players for the game, preserving scores from previous rounds if player exists
        this.players = playerStartInfo.map(info => ({
            id: info.id, name: info.name, slot: info.slot, hand: [],
            score: this.players.find(p=>p.id === info.id)?.score || 0, // Preserve score or default to 0
            connected: true, finished: false, role: null
        })).sort((a, b) => a.slot - b.slot);

        console.log(`[GAME ${this.roomId}] Starting game with players:`, this.players.map(p => p.name));
        this.createDeck(); this.shuffleDeck(); this.dealCards(13); // Standard 13 cards per player for 4 players
        this.gameStarted = true; this.firstTurn = true;

        // Assign roles (Landlord 'D', Farmer 'F', Double Landlord 'DD')
        // Find S3 and SA holders
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

        // Determine starting player (holder of Diamond 4)
        let startingPlayerIndex = -1;
        for (let i = 0; i < this.players.length; i++) {
            if (this.players[i].hand.some(card => card.suit === 'D' && card.rank === '4')) {
                startingPlayerIndex = i; break;
            }
        }
        if (startingPlayerIndex === -1) return { success: false, message: "发牌错误，未找到方块4！" };
        this.currentPlayerIndex = startingPlayerIndex;
        this.lastPlayerWhoPlayed = null; // No one has played yet

        console.log(`[GAME ${this.roomId}] Player ${this.players[this.currentPlayerIndex].name} starts (has D4).`);
        return { success: true };
    }

    playCard(playerId, cards) { // cards: [{rank, suit}, ...]
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== this.currentPlayerIndex) return { success: false, message: "现在不是你的回合。" };
        const player = this.players[playerIndex];
        if (!player.connected) return { success: false, message: "你已断线。" };
        if (player.finished) return { success: false, message: "你已完成出牌。" };

        // Validate cards are in player's hand
        const handSet = new Set(player.hand.map(c => `${c.rank}${c.suit}`));
        const cardsValidInHand = cards.every(card => handSet.has(`${card.rank}${card.suit}`));
        if (!cardsValidInHand) return { success: false, message: "选择的牌不在您的手中。" };

        const validationResult = this.checkValidPlay(cards, player.hand, this.lastValidHandInfo, this.firstTurn);
        if (!validationResult.valid) return { success: false, message: validationResult.message };

        // Remove cards from player's hand
        const cardsToRemoveSet = new Set(cards.map(c => `${c.rank}${c.suit}`));
        player.hand = player.hand.filter(card => !cardsToRemoveSet.has(`${card.rank}${card.suit}`));

        this.centerPile = cards;
        this.lastValidHandInfo = validationResult.handInfo;
        this.lastPlayerWhoPlayed = playerId; // Record who played this valid hand
        this.consecutivePasses = 0; // Reset passes
        if (this.firstTurn) this.firstTurn = false;
        console.log(`[GAME ${this.roomId}] Player ${player.name} played ${this.lastValidHandInfo.type}.`);
        this.possibleHints = []; this.currentHintIndexInternal = 0; // Clear hints after a play

        let gameOver = false;
        let scoreResult = null;
        if (player.hand.length === 0) {
            this.finishOrder.push(playerId);
            player.finished = true;
            if (!this.winnerId) this.winnerId = playerId; // First to finish is a potential winner indicator
            console.log(`[GAME ${this.roomId}] Player ${player.name} finished ${this.finishOrder.length}.`);

            // Check for instant game over conditions (e.g., both landlords finish first)
            const instantResult = this.checkInstantGameOver();
            if (instantResult.isOver) {
                gameOver = true;
                scoreResult = this.calculateScoresBasedOnResult(instantResult.resultDescription);
                this.gameFinished = true; this.gameStarted = false;
                console.log(`[GAME ${this.roomId}] Game result determined early: ${instantResult.resultDescription}`);
            } else if (this.finishOrder.length === this.players.length -1) { // All but one player finished
                 const lastPlayer = this.players.find(p => !p.finished);
                 if(lastPlayer) this.finishOrder.push(lastPlayer.id); // Add the last player to finishOrder
                 gameOver = true;
                 // Re-check instant game over now that all are ordered
                 const finalInstantResult = this.checkInstantGameOver();
                 if (finalInstantResult.isOver) {
                    scoreResult = this.calculateScoresBasedOnResult(finalInstantResult.resultDescription);
                 } else {
                    // This case should ideally be covered by checkInstantGameOver with 4 finishers.
                    // If not, it's a fallback.
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
            // Player finished but game not over yet, move to next player
            this.nextTurn(true); // forceAdvance = true because current player is finished
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

        // Player cannot pass if they are starting a new round (no lastValidHandInfo)
        // or if they were the last one to play cards (lastPlayerWhoPlayed === playerId)
        if (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) {
            return { success: false, message: "你必须出牌。" };
        }

        console.log(`[GAME ${this.roomId}] Player ${player.name} passed.`);
        this.consecutivePasses++;
        this.possibleHints = []; this.currentHintIndexInternal = 0; // Clear hints on pass

        // Check if all other active (not finished, connected) players have passed
        const activePlayersCount = this.players.filter(p => !p.finished && p.connected).length;
        if (this.consecutivePasses >= activePlayersCount - 1 && this.lastPlayerWhoPlayed) {
            // The player who last played cards starts a new round
            console.log(`[GAME ${this.roomId}] All other active players passed. Resetting turn state.`);
            const lastPlayerWhoPlayedId = this.lastPlayerWhoPlayed; // Store before reset
            this.resetTurnState(); // Clears center pile, lastValidHandInfo, consecutivePasses

            // Set current player to the one who last played successfully
            const lastActualPlayerIndex = this.players.findIndex(p => p.id === lastPlayerWhoPlayedId);
            const lastActualPlayer = this.players[lastActualPlayerIndex];

            if (lastActualPlayer && !lastActualPlayer.finished && lastActualPlayer.connected) {
                this.currentPlayerIndex = lastActualPlayerIndex;
                this.lastPlayerWhoPlayed = null; // New round, so this player must play
                console.log(`[GAME ${this.roomId}] New round starting with player: ${this.players[this.currentPlayerIndex]?.name}`);
            } else {
                // If the last player to play is now finished or disconnected,
                // find the next available player from their position.
                 this.currentPlayerIndex = lastActualPlayerIndex; // Start search from here
                 this.nextTurn(true); // Force advance to find next valid player for new round
                 this.lastPlayerWhoPlayed = null; // New round for whoever's turn it is
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
        // this.consecutivePasses = 0; // Already reset by playCard or handled by pass logic
        console.log(`[GAME ${this.roomId}] Turn state reset (pile cleared).`);
    }

    nextTurn(forceAdvance = false) { // forceAdvance is true if current player just finished or disconnected
         if (this.gameFinished && !forceAdvance) return; // No next turn if game is truly over
         if (this.players.length === 0) return; // Should not happen

         let currentIdx = this.currentPlayerIndex;
         if(currentIdx === -1 && this.players.length > 0) { // e.g. game just started
             currentIdx = 0; // Or wherever the D4 holder was
         }

         let nextIndex = currentIdx;
         let loopDetection = 0;
         const maxLoops = this.players.length * 2; // Generous loop break

         const numPlayers = this.players.length;
         if (numPlayers === 0) { // Safety check
            this.currentPlayerIndex = -1;
            return;
         }

         do {
              // MODIFICATION FOR REVERSE (COUNTER-CLOCKWISE) ORDER
              nextIndex = (nextIndex - 1 + numPlayers) % numPlayers;
              // END MODIFICATION

              loopDetection++;
              if (loopDetection > maxLoops) { // Safety break for infinite loops
                   console.error(`[GAME ${this.roomId}] Infinite loop detected in nextTurn! Current player: ${this.players[currentIdx]?.name}, Next attempted: ${this.players[nextIndex]?.name}. All players:`, this.players.map(p => ({name:p.name, finished:p.finished, connected:p.connected })));
                   this.currentPlayerIndex = -1; // Stop the game or mark as error
                   this.endGame("Turn Advancement Error"); // End game due to error
                   return;
              }
         } while (
              !this.players[nextIndex] || // Player object might not exist if array is modified (shouldn't be)
              this.players[nextIndex].finished ||
              !this.players[nextIndex].connected
         );

         this.currentPlayerIndex = nextIndex;
         console.log(`[GAME ${this.roomId}] Turn advanced to player: ${this.players[this.currentPlayerIndex]?.name} (New order: Counter-Clockwise)`);
         // Reset hints for the new player's turn
         this.possibleHints = [];
         this.currentHintIndexInternal = 0;
    }


    // --- Hint Logic ---
    findHint(playerId, currentHintIndex = 0) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== this.currentPlayerIndex) return { success: false, message: "现在不是你的回合。" };
        const player = this.players[playerIndex];
        if (!player || !player.connected || player.finished) return { success: false, message: "无效状态。" };

        // If hints for this player were already generated and we are cycling
        if (this.possibleHints.length > 0 && this.possibleHints[0].forPlayerId === playerId) {
             const nextIdx = (currentHintIndex + 1) % this.possibleHints.length;
             return { success: true, hint: this.possibleHints[nextIdx], nextHintIndex: nextIdx };
        }

        // Generate new hints
        this.possibleHints = [];
        const hand = player.hand;

        // 1. Singles
        for (const card of hand) {
            const validation = this.checkValidPlay([card], hand, this.lastValidHandInfo, this.firstTurn);
            if (validation.valid) this.possibleHints.push({ cards: [card], forPlayerId: playerId });
        }

        // 2. Pairs
        const ranksInHand = {};
        hand.forEach(c => ranksInHand[c.rank] = (ranksInHand[c.rank] || 0) + 1);
        for (const rank in ranksInHand) {
            if (ranksInHand[rank] >= 2) {
                const pairCards = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 2);
                const validation = this.checkValidPlay(pairCards, hand, this.lastValidHandInfo, this.firstTurn);
                if (validation.valid) this.possibleHints.push({ cards: pairCards, forPlayerId: playerId });
            }
        }
        // 3. Three of a kind
         for (const rank in ranksInHand) {
             if (ranksInHand[rank] >= 3) {
                 const threeCards = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 3);
                 const validation = this.checkValidPlay(threeCards, hand, this.lastValidHandInfo, this.firstTurn);
                 if (validation.valid) this.possibleHints.push({ cards: threeCards, forPlayerId: playerId });
             }
         }
        // TODO: Add logic for Straights, Flushes, Full Houses, Straight Flushes if time permits
        // This requires more complex combination generation. For now, focusing on simpler plays.

        // Sort hints by some preference (e.g., by hand type rank, then by card value)
        this.possibleHints.sort((a, b) => {
             const infoA = this.getHandInfo(a.cards);
             const infoB = this.getHandInfo(b.cards);
             return compareHands(infoA, infoB); // Smallest valid play first
        });


        if (this.possibleHints.length > 0) {
             this.currentHintIndexInternal = 0; // Reset cycle index for new hints
             return { success: true, hint: this.possibleHints[0], nextHintIndex: 0 };
        } else {
             return { success: false, message: "没有可出的牌。" };
        }
    }


    // --- Card Validation Logic ---
    getHandInfo(cards) { // cards: [{rank, suit}, ...]
        if (!Array.isArray(cards) || cards.length === 0) return { isValid: false, message: "无效输入" };
        const n = cards.length;
        // Sort cards: highest rank first, then highest suit (for consistent representation)
        const sortedCards = [...cards].sort((a, b) => compareSingleCards(b, a)); // Sort descending for flush comparison

        const suits = new Set(sortedCards.map(c => c.suit));
        const ranks = sortedCards.map(c => c.rank);
        const rankValues = sortedCards.map(c => RANK_VALUES[c.rank]);

        const isFlush = suits.size === 1;
        let isStraight = false;
        let straightPrimaryRankValue = -1; // Highest rank in the straight

        if (n === 5) {
            const uniqueRankValuesSorted = [...new Set(rankValues)].sort((a, b) => a - b); // Ascending for straight check
            if (uniqueRankValuesSorted.length === 5) {
                // Standard straight: A2345, 23456, ..., TJQKA (where A is high)
                if (uniqueRankValuesSorted[4] - uniqueRankValuesSorted[0] === 4) {
                    isStraight = true;
                    straightPrimaryRankValue = uniqueRankValuesSorted[4]; // Highest card's rank value
                }
                // Note: KK rules usually don't have A2345 as lowest straight, but 34567 is lowest.
                // And 23456, ... TJQKA, then A2345 as highest.
                // The provided RANK_ORDER ("4"..."3") handles this naturally if comparing ranks.
                // For this game, 3 is highest rank. 2 is second highest. A is third.
                // Smallest straight is 45678. Largest straight is TJQKA (if using standard poker straight definition for this part)
                // Let's assume standard poker straight definition *for this check only*, then game rules compare ranks.
                // The problem description implies a different straight rule based on rank order.
                // Let's stick to the ranks in sequence based on RANK_ORDER.
                // This part needs clarification for KK specific straight rules.
                // For now, standard consecutive rank check.
            }
        }

        const rankCounts = {}; ranks.forEach(rank => { rankCounts[rank] = (rankCounts[rank] || 0) + 1; });
        const counts = Object.values(rankCounts).sort((a, b) => b - a); // Descending counts [3,2] for full house
        const distinctRanks = Object.keys(rankCounts);

        // Check from strongest to weakest hand type allowed
        if (n === 5 && isStraight && isFlush) {
            return { isValid: true, type: HAND_TYPES.STRAIGHT_FLUSH, cards: sortedCards, primaryRankValue: straightPrimaryRankValue, suitValue: SUIT_VALUES[sortedCards[0].suit] };
        }
        if (n === 5 && counts[0] === 3 && counts[1] === 2) { // Full House
            const threeRank = distinctRanks.find(rank => rankCounts[rank] === 3);
            return { isValid: true, type: HAND_TYPES.FULL_HOUSE, cards: sortedCards, primaryRankValue: RANK_VALUES[threeRank] };
        }
        if (n === 5 && isFlush) { // Flush
            return { isValid: true, type: HAND_TYPES.FLUSH, cards: sortedCards }; // sortedCards are highest to lowest
        }
        if (n === 5 && isStraight) { // Straight
            return { isValid: true, type: HAND_TYPES.STRAIGHT, cards: sortedCards, primaryRankValue: straightPrimaryRankValue };
        }
        // KK does not have 4-of-a-kind as a standard play, nor 4-of-a-kind + kicker (Bomb)
        // It does have 3-of-a-kind, Pair, Single.
        if (n === 3 && counts[0] === 3) { // Three of a kind
            const threeRank = distinctRanks.find(rank => rankCounts[rank] === 3);
            return { isValid: true, type: HAND_TYPES.THREE_OF_A_KIND, cards: sortedCards, representativeCard: sortedCards[0], primaryRankValue: RANK_VALUES[threeRank] };
        }
        if (n === 2 && counts[0] === 2) { // Pair
            const pairRank = distinctRanks.find(rank => rankCounts[rank] === 2);
            // Representative card for pair is the higher suit of the two if ranks are same
            return { isValid: true, type: HAND_TYPES.PAIR, cards: sortedCards, representativeCard: sortedCards[0], primaryRankValue: RANK_VALUES[pairRank] };
        }
        if (n === 1) { // Single
            return { isValid: true, type: HAND_TYPES.SINGLE, cards: sortedCards, representativeCard: sortedCards[0], primaryRankValue: RANK_VALUES[ranks[0]] };
        }

        // Explicitly disallow unhandled combinations that might resemble valid poker hands not in KK
        if (counts[0] === 4 && n === 4) { // Four of a kind (Bomb) - not allowed as standard play
            return { isValid: false, message: "不允许出四条炸弹。" };
        }
        if (n === 5 && counts[0] === 4) { // Four of a kind + kicker - not allowed
             return { isValid: false, message: "不允许四条带单张 (非标准牌型)。" };
        }

        return { isValid: false, message: "无法识别的牌型或不允许的出牌组合。" };
     }

     checkValidPlay(cardsToPlay, currentHand, centerPileInfo, isFirstTurn) {
         const newHandInfo = this.getHandInfo(cardsToPlay);
         if (!newHandInfo.isValid) return { valid: false, message: newHandInfo.message || "无效的牌型。" };

         if (isFirstTurn) {
             // First turn must include Diamond 4
             const hasD4 = cardsToPlay.some(c => c.suit === 'D' && c.rank === '4');
             if (!hasD4) return { valid: false, message: "第一回合必须包含方块4。" };
             // Any valid hand type containing D4 is okay for first play
             return { valid: true, handInfo: newHandInfo };
         } else {
             if (!centerPileInfo) { // Starting a new round of play (all others passed or first play after D4)
                 return { valid: true, handInfo: newHandInfo };
             }
             // Must play same type and same number of cards as current center pile
             if (newHandInfo.type !== centerPileInfo.type) {
                 return { valid: false, message: `必须出与上家相同类型的牌 (${centerPileInfo.type})。` };
             }
             if (newHandInfo.cards.length !== centerPileInfo.cards.length) {
                 // This check is somewhat redundant if types are same and types imply card count (e.g. single, pair, straight)
                 // But good for safety.
                 return { valid: false, message: `必须出与上家相同数量的牌 (${centerPileInfo.cards.length}张)。`};
             }

             // New hand must be higher rank than center pile hand
             const comparison = compareHands(newHandInfo, centerPileInfo);
             if (comparison > 0) {
                 return { valid: true, handInfo: newHandInfo };
             } else {
                 return { valid: false, message: `出的 ${newHandInfo.type} 必须大于上家的。` };
             }
         }
     }

    // --- Game End and Scoring Logic ---
    checkInstantGameOver() {
        const nFinished = this.finishOrder.length;
        if (this.gameMode === 'standard' && nFinished < 2) return { isOver: false }; // Need at least 2 finishers for potential standard mode instant win
        if (this.gameMode === 'double_landlord' && nFinished < 1) return { isOver: false }; // Need at least 1 finisher for DD mode

        const finishRoles = this.finishOrder.map(playerId => this.playerRoles[playerId]);
        let resultDescription = null; let isOver = false;

        if (this.gameMode === 'standard') { // D, D, F, F
            const rolesStr = finishRoles.join(''); // e.g., "DDFF", "DFDF"
            if (nFinished >= 2) {
                if (finishRoles[0] === 'D' && finishRoles[1] === 'D') { resultDescription = "地主大胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'F') { resultDescription = "农民大胜"; isOver = true; }
            }
            // If not a "big win", check other conditions when more players finish
            if (!isOver && nFinished >= 3) {
                if (finishRoles[0] === 'D' && finishRoles[1] === 'F' && finishRoles[2] === 'D') { resultDescription = "地主胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'D' && finishRoles[2] === 'F') { resultDescription = "农民胜"; isOver = true; }
                // Tie conditions for 3 finishers (e.g., DFF or FDD implies the 4th player's role makes it a tie)
                else if ( (finishRoles[0] === 'D' && finishRoles[1] === 'F' && finishRoles[2] === 'F') || // DFF(D)
                          (finishRoles[0] === 'F' && finishRoles[1] === 'D' && finishRoles[2] === 'D') )  // FDD(F)
                          { resultDescription = "打平"; isOver = true; }
            }
            // All 4 finished (explicit tie check if not covered above)
            if (!isOver && nFinished === 4) {
                // Order of finish for D and F determines win/loss if not a "big win"
                // D F D F -> Landlords win (1st and 3rd are D)
                // F D F D -> Farmers win (1st and 3rd are F)
                // D F F D -> Tie (1st D, 4th D vs 2nd F, 3rd F)
                // F D D F -> Tie (1st F, 4th F vs 2nd D, 3rd D)
                if (rolesStr === 'DFDF') { resultDescription = "地主胜"; isOver = true; }
                else if (rolesStr === 'FDFD') { resultDescription = "农民胜"; isOver = true; }
                else if (rolesStr === 'DFFD' || rolesStr === 'FDDF') { resultDescription = "打平"; isOver = true; }
                // Other 4-finish scenarios like DDFF (Landlord Big Win) or FFDD (Farmer Big Win) already handled by nFinished >= 2
            }
        } else { // Double Landlord: DD, F, F, F
            if (nFinished === 0) return { isOver: false }; // Should be caught by initial check

            if (finishRoles[0] === 'DD') { resultDescription = "双地主大胜"; isOver = true; }
            // Farmers need all 3 to finish before DD for "Farmer Big Win"
            else if (nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'F') { resultDescription = "农民大胜"; isOver = true; }
            // If DD finishes 2nd (F DD ...) -> DD wins
            else if (nFinished >= 2 && finishRoles[0] === 'F' && finishRoles[1] === 'DD') { resultDescription = "双地主胜"; isOver = true; }
            // If DD finishes 3rd (F F DD ...) -> Farmers win (more specific than just DD not first)
            else if (nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'DD') { resultDescription = "农民胜"; isOver = true; }
            // If DD finishes 4th (F F F DD) -> Farmer Big Win (already handled)
        }
        return { isOver, resultDescription };
     }

    calculateScoresBasedOnResult(resultDescription) {
         const scoreChanges = {}; // { playerId: change }
         let landlordScoreChange = 0;
         let farmerScoreChange = 0;
         let ddScoreChange = 0; // Double Landlord
         console.log(`[SCORE] Calculating scores based on result: ${resultDescription}`);

         if (!resultDescription) {
             console.warn(`[SCORE] No resultDescription provided. Scores cannot be calculated.`);
             // Default to a tie or no score change if result is unknown
             return { result: "未知结果 (计算错误)", scoreChanges: {}, finalScores: this.players.map(p => ({ id: p.id, name: p.name, score: p.score, role: this.playerRoles[p.id] })) };
         }

         if (this.gameMode === 'standard') {
             switch (resultDescription) {
                 case "打平": landlordScoreChange = 0; farmerScoreChange = 0; break;
                 case "地主胜": landlordScoreChange = 1; farmerScoreChange = -1; break;
                 case "农民胜": landlordScoreChange = -1; farmerScoreChange = 1; break;
                 case "地主大胜": landlordScoreChange = 2; farmerScoreChange = -2; break; // Landlords get +2 each, farmers -2 each
                 case "农民大胜": landlordScoreChange = -2; farmerScoreChange = 2; break; // Farmers get +2 each, landlords -2 each
                 default: console.warn(`[SCORE] Unknown standard result: ${resultDescription}`);
             }
             this.players.forEach(p => { scoreChanges[p.id] = (this.playerRoles[p.id] === 'D') ? landlordScoreChange : farmerScoreChange; });
         } else { // Double Landlord
             switch (resultDescription) {
                 case "双地主大胜": ddScoreChange = 6; farmerScoreChange = -2; break; // DD gets +6, each F gets -2
                 case "双地主胜": ddScoreChange = 3; farmerScoreChange = -1; break;   // DD gets +3, each F gets -1
                 case "农民胜": ddScoreChange = -3; farmerScoreChange = 1; break;    // DD gets -3, each F gets +1
                 case "农民大胜": ddScoreChange = -6; farmerScoreChange = 2; break;  // DD gets -6, each F gets +2
                 default: console.warn(`[SCORE] Unknown double landlord result: ${resultDescription}`);
             }
              this.players.forEach(p => { scoreChanges[p.id] = (this.playerRoles[p.id] === 'DD') ? ddScoreChange : farmerScoreChange; });
         }

         console.log(`[SCORE] Result: ${resultDescription}`);
         this.players.forEach(p => {
             const change = scoreChanges[p.id] || 0; // Default to 0 if somehow not set
             p.score += change;
             console.log(`[SCORE] Player ${p.name} (${this.playerRoles[p.id]}): ${change >= 0 ? '+' : ''}${change} -> New Total Score: ${p.score}`);
         });

          return {
              result: resultDescription,
              scoreChanges: scoreChanges,
              finalScores: this.players.map(p => ({ id: p.id, name: p.name, score: p.score, role: this.playerRoles[p.id] }))
          };
      }

    calculateScores() { // Fallback / generic score calculation if specific result isn't determined by early exit
        console.warn(`[SCORE] Using fallback calculateScores(). This usually means an incomplete game or unhandled end condition.`);
        // Try to use checkInstantGameOver one last time with full finishOrder
        const instantResult = this.checkInstantGameOver();
        if (instantResult.isOver && instantResult.resultDescription) {
            return this.calculateScoresBasedOnResult(instantResult.resultDescription);
        }
        // If still no specific result, assume a "Tie" as the most neutral outcome
        return this.calculateScoresBasedOnResult("打平");
    }

    endGame(reason = "Game finished") { // Called by roomManager if game needs to end prematurely
          if (this.gameFinished) return null; // Already ended
          this.gameFinished = true; this.gameStarted = false;
          console.log(`[GAME ${this.roomId}] Game ended. Reason: ${reason}`);

          // If game ends before all players naturally finish, fill finishOrder based on remaining cards
          if (this.finishOrder.length < this.players.length) {
               const finishedIds = new Set(this.finishOrder);
               const remainingPlayers = this.players.filter(p => !finishedIds.has(p.id));
               // Sort remaining players: fewer cards first, then by original slot as tie-breaker
               remainingPlayers.sort((a,b) => {
                    if (a.hand.length !== b.hand.length) return a.hand.length - b.hand.length;
                    return a.slot - b.slot;
               });
               remainingPlayers.forEach(p => this.finishOrder.push(p.id));
          }

          const scoreResult = this.calculateScores(); // Will use checkInstantGameOver with full order
          return scoreResult;
     }


    // --- Deck and Card Utilities ---
    createDeck() {
        const suits = ["H", "D", "C", "S"]; // Hearts, Diamonds, Clubs, Spades
        // Ranks for KK: 4 is lowest, 3 is highest. Order for deck creation doesn't matter as much as RANK_VALUES for logic
        const ranks = ["4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2", "3"];
        this.deck = [];
        for (const suit of suits) { for (const rank of ranks) { this.deck.push({ suit, rank }); } }
     }
    shuffleDeck() { // Fisher-Yates shuffle
         for (let i = this.deck.length - 1; i > 0; i--) {
            const j = crypto.randomInt(i + 1); // Secure random integer
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
     }
    dealCards(cardsPerPlayer) { // Deals cards one by one, more like real life
         let playerIdx = 0;
         const totalCardsToDeal = cardsPerPlayer * this.players.length;
         if (totalCardsToDeal > this.deck.length) {
             console.error(`[DEAL ERROR] Not enough cards in deck (${this.deck.length}) to deal ${totalCardsToDeal} cards.`);
             return; // Or throw error
         }
         for (let i = 0; i < totalCardsToDeal; i++) {
             const player = this.players[playerIdx % this.players.length];
             if (player) { // Should always be true
                player.hand.push(this.deck.pop());
             }
             playerIdx++;
         }
         // Sort each player's hand after dealing
         this.players.forEach(player => this.sortHand(player.hand));
     }
    sortHand(hand) { hand.sort(compareSingleCards); } // Default sort by rank then suit

    // --- Game State for Client ---
    getStateForPlayer(requestingPlayerId) {
        return {
            // Room-level info should be handled by roomManager's getRoomStateForPlayer
            players: this.players.map(p => ({
                id: p.id, name: p.name, slot: p.slot, score: p.score,
                role: this.playerRoles[p.id] || p.role, // Use playerRoles if set, else fallback
                finished: p.finished,
                connected: p.connected,
                // Only send hand details to the requesting player
                hand: p.id === requestingPlayerId ? p.hand : undefined,
                handCount: p.hand.length, // handCount is always public
            })),
            centerPile: [...this.centerPile], // Send a copy
            lastHandInfo: this.lastValidHandInfo ? { type: this.lastValidHandInfo.type, cards: this.lastValidHandInfo.cards } : null,
            currentPlayerId: this.gameFinished ? null : (this.currentPlayerIndex >=0 && this.players[this.currentPlayerIndex] ? this.players[this.currentPlayerIndex].id : null),
            isFirstTurn: this.firstTurn,
            gameStarted: this.gameStarted,
            gameFinished: this.gameFinished,
            winnerId: this.winnerId, // Could be derived from finishOrder and roles too
            gameMode: this.gameMode,
            finishOrder: [...this.finishOrder], // Send a copy
            lastPlayerWhoPlayedId: this.lastPlayerWhoPlayed
        };
    }
}

module.exports = { Game };
