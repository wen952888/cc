// game.js
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
            // For flush, compare cards from highest to lowest
            // Assuming cards in handInfo.cards are already sorted highest to lowest by getHandInfo
            for (let i = 0; i < handInfoA.cards.length; i++) {
                // Note: getHandInfo sorts cards for flush from highest to lowest.
                // compareSingleCards sorts lowest to highest. So if we want to compare
                // highest card first, we might need to adjust or ensure getHandInfo provides them in that order.
                // For now, assuming getHandInfo for flush provides cards sorted appropriately for comparison.
                const compareResult = compareSingleCards(handInfoA.cards[i], handInfoB.cards[i]);
                if (compareResult !== 0) return compareResult;
            }
            return 0; // All cards are identical
        case HAND_TYPES.THREE_OF_A_KIND: // Fallthrough
        case HAND_TYPES.PAIR: // Fallthrough
        case HAND_TYPES.SINGLE:
            // For single, pair, three_of_a_kind, comparison is based on the representative card (usually highest or the one forming the set)
            return compareSingleCards(handInfoA.representativeCard, handInfoB.representativeCard);
        default: return 0; // Should not happen for valid types
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
        this.currentPlayerIndex = -1; // Index in the this.players array
        this.firstTurn = true;
        this.gameStarted = false;
        this.gameFinished = false;
        this.winnerId = null;
        this.playerRoles = {}; // Stores role by playerId { playerId: role }
        this.finishOrder = []; // Array of playerIds in the order they finished
        this.gameMode = null; // e.g., 'standard', 'double_landlord'
        this.consecutivePasses = 0;
        this.lastPlayerWhoPlayed = null; // playerId of the last player who played cards
        this.possibleHints = []; // Stores an array of hint objects {cards: [...]}
        this.currentHintIndexInternal = 0; // For cycling through hints server-side
    }

    addPlayer(userId, username, slot) {
        if (this.players.length >= this.maxPlayers || this.players.some(p => p.id === userId)) {
            // If player already exists, update their info but don't re-add if they are already there with same ID
            const existingPlayer = this.players.find(p => p.id === userId);
            if (existingPlayer) {
                existingPlayer.name = username; // Update name if changed
                existingPlayer.connected = true; // Mark as connected
                console.log(`[GAME ${this.roomId}] Player ${username} (ID: ${userId}) already in game, updated info.`);
                return true; // Indicate success as player is in
            }
            return false; // Room full or other issue
        }
        this.players.push({
            id: userId,
            name: username,
            slot: slot,
            hand: [],
            score: 0,
            connected: true,
            finished: false,
            role: null,
            isAiControlled: false // Initialize AI control state
        });
        this.players.sort((a, b) => a.slot - b.slot); // Keep players sorted by slot, important for turn order
        console.log(`[GAME ${this.roomId}] Player ${username} added to game at slot ${slot}. Total players: ${this.players.length}`);
        return true;
    }

    removePlayer(userId) {
        // This method might be called if a player fully leaves, not just disconnects
        // For disconnects, markPlayerConnected is usually preferred.
        this.players = this.players.filter(p => p.id !== userId);
        console.log(`[GAME ${this.roomId}] Player ${userId} removed from game. Total players: ${this.players.length}`);
        // If current player was removed, may need to advance turn or handle appropriately
        if (this.currentPlayerIndex !== -1 && this.players[this.currentPlayerIndex]?.id === userId) {
            // This logic is complex, as nextTurn assumes player is just skipped.
            // If player is fully removed mid-game, might need game reset or specific rule.
            // For now, just log. `nextTurn` should handle skipping if player is gone from array.
            console.warn(`[GAME ${this.roomId}] Current player ${userId} was removed. Turn state might need re-evaluation.`);
        }
    }

    markPlayerConnected(userId, isConnected) {
        const player = this.players.find(p => p.id === userId);
        if (player) {
            player.connected = !!isConnected; // Ensure boolean
            console.log(`[GAME ${this.roomId}] Player ${player.name} connection status set to ${player.connected}`);
            if (!isConnected && this.currentPlayerIndex !== -1 && this.players[this.currentPlayerIndex].id === userId && this.gameStarted && !this.gameFinished) {
                // If current player disconnects, game might need to advance turn or AI take over
                console.log(`[GAME ${this.roomId}] Current player ${player.name} disconnected. AI: ${player.isAiControlled}`);
                if (!player.isAiControlled) {
                    // If not AI controlled, consider auto-passing or specific rule for disconnected current player
                    // For now, nextTurn() will skip them if called.
                }
            }
        }
    }

    startGame(playerStartInfo) { // playerStartInfo: [{id, name, slot, score}, ...] sorted by slot
        this.deck = [];
        this.centerPile = [];
        this.lastValidHandInfo = null;
        this.currentPlayerIndex = -1;
        this.firstTurn = true;
        this.gameStarted = false; // Will be set to true if successful
        this.gameFinished = false;
        this.winnerId = null;
        this.playerRoles = {};
        this.finishOrder = [];
        this.gameMode = null;
        this.consecutivePasses = 0;
        this.lastPlayerWhoPlayed = null;
        this.possibleHints = [];
        this.currentHintIndexInternal = 0;

        if (!playerStartInfo || playerStartInfo.length !== this.maxPlayers) {
            return { success: false, message: `需要 ${this.maxPlayers} 位玩家才能开始游戏。当前 ${playerStartInfo ? playerStartInfo.length : 0} 位。` };
        }

        // Re-initialize players based on playerStartInfo, preserving scores if available
        this.players = playerStartInfo.map(info => {
            const existingPlayer = this.players.find(p => p.id === info.id); // To get previous AI state
            return {
                id: info.id,
                name: info.name,
                slot: info.slot, // slot from room manager should be reliable
                hand: [],
                score: info.score || 0, // Use score from room if available
                connected: true, // Assume connected at start
                finished: false,
                role: null,
                isAiControlled: existingPlayer ? existingPlayer.isAiControlled : false // Preserve AI state
            };
        }).sort((a, b) => a.slot - b.slot); // Ensure sorted by slot

        console.log(`[GAME ${this.roomId}] Starting game with players:`, this.players.map(p => `${p.name}(Slot:${p.slot})`));
        this.createDeck();
        this.shuffleDeck();
        this.dealCards(13); // Standard 13 cards per player

        this.gameStarted = true;
        this.firstTurn = true;

        let s3PlayerId = null, saPlayerId = null;
        this.players.forEach(p => {
            if (p.hand.some(c => c.suit === 'S' && c.rank === '3')) s3PlayerId = p.id;
            if (p.hand.some(c => c.suit === 'S' && c.rank === 'A')) saPlayerId = p.id;
        });

        if (!s3PlayerId || !saPlayerId) {
            // This should be rare if deck and dealing is correct
            console.error(`[GAME ${this.roomId}] CRITICAL: S3 or SA not found after dealing. Cards might not be standard.`);
            this.gameStarted = false; // Abort start
            return { success: false, message: "发牌错误，无法确定关键身份牌（黑桃3或黑桃A）。" };
        }

        if (s3PlayerId === saPlayerId) {
            this.gameMode = 'double_landlord';
            this.playerRoles[s3PlayerId] = 'DD'; // Double Landlord
            this.players.forEach(p => { p.role = (p.id === s3PlayerId) ? 'DD' : 'F'; this.playerRoles[p.id] = p.role; });
        } else {
            this.gameMode = 'standard';
            this.playerRoles[s3PlayerId] = 'D'; // Landlord
            this.playerRoles[saPlayerId] = 'D'; // Landlord
            this.players.forEach(p => { p.role = (p.id === s3PlayerId || p.id === saPlayerId) ? 'D' : 'F'; this.playerRoles[p.id] = p.role; });
        }
        console.log(`[GAME ${this.roomId}] Game Mode: ${this.gameMode}. Roles assigned:`, JSON.stringify(this.playerRoles));

        let startingPlayerIndex = -1;
        // Players array is sorted by slot. Find the player with Diamond 4.
        for (let i = 0; i < this.players.length; i++) {
            if (this.players[i].hand.some(card => card.suit === 'D' && card.rank === '4')) {
                startingPlayerIndex = i; // This is the index in the sorted this.players array
                break;
            }
        }

        if (startingPlayerIndex === -1) {
            console.error(`[GAME ${this.roomId}] CRITICAL: Diamond 4 not found after dealing.`);
            this.gameStarted = false; // Abort start
            return { success: false, message: "发牌错误，未找到先手牌（方块4）。" };
        }
        this.currentPlayerIndex = startingPlayerIndex;
        this.lastPlayerWhoPlayed = null; // No one has played yet

        console.log(`[GAME ${this.roomId}] Player ${this.players[this.currentPlayerIndex].name} (Slot: ${this.players[this.currentPlayerIndex].slot}, Index: ${this.currentPlayerIndex}) starts (has Diamond 4).`);
        return { success: true };
    }

    playCard(playerId, cards) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayerIndex) {
            return { success: false, message: "现在不是您的回合或您不是当前玩家。" };
        }
        
        const player = this.players[playerIndex];
        if (!player.connected) return { success: false, message: "您已断线，无法出牌。" };
        if (player.finished) return { success: false, message: "您已完成出牌，无法再次出牌。" };

        if (!Array.isArray(cards) || cards.length === 0) {
            return { success: false, message: "请选择要出的牌。" };
        }

        const handSet = new Set(player.hand.map(c => `${c.rank}${c.suit}`));
        const cardsValidInHand = cards.every(card => handSet.has(`${card.rank}${card.suit}`));
        if (!cardsValidInHand) return { success: false, message: "选择的牌不在您的手中或牌数据无效。" };

        const validationResult = this.checkValidPlay(cards, player.hand, this.lastValidHandInfo, this.firstTurn);
        if (!validationResult.valid) return { success: false, message: validationResult.message };

        const cardsToRemoveSet = new Set(cards.map(c => `${c.rank}${c.suit}`));
        player.hand = player.hand.filter(card => !cardsToRemoveSet.has(`${card.rank}${card.suit}`));

        this.centerPile = [...cards]; // Store a copy
        this.lastValidHandInfo = validationResult.handInfo;
        this.lastPlayerWhoPlayed = playerId;
        this.consecutivePasses = 0;
        if (this.firstTurn) this.firstTurn = false;
        
        console.log(`[GAME ${this.roomId}] Player ${player.name} played ${this.lastValidHandInfo.type}: ${cards.map(c=>c.rank+c.suit).join(',')}. Hand left: ${player.hand.length}`);
        this.possibleHints = []; this.currentHintIndexInternal = 0;

        let gameOver = false;
        let scoreResult = null;
        if (player.hand.length === 0) {
            this.finishOrder.push(playerId);
            player.finished = true;
            if (!this.winnerId) this.winnerId = playerId; // First player to finish is the nominal winner
            console.log(`[GAME ${this.roomId}] Player ${player.name} finished. Finish order: ${this.finishOrder.join(', ')}.`);

            const instantResult = this.checkInstantGameOver();
            if (instantResult.isOver) {
                gameOver = true;
                scoreResult = this.calculateScoresBasedOnResult(instantResult.resultDescription);
                this.gameFinished = true; this.gameStarted = false;
                console.log(`[GAME ${this.roomId}] Game result determined early by finish order: ${instantResult.resultDescription}`);
            } else if (this.finishOrder.length >= this.players.length - 1) { // All but one (or all) finished
                 const remainingPlayers = this.players.filter(p => !p.finished);
                 if (remainingPlayers.length === 1) {
                    this.finishOrder.push(remainingPlayers[0].id); // Add the last player
                    remainingPlayers[0].finished = true; // Mark them as finished too
                 }
                 gameOver = true;
                 // Recalculate instant game over now that all are "finished"
                 const finalInstantResult = this.checkInstantGameOver();
                 if (finalInstantResult.isOver) {
                    scoreResult = this.calculateScoresBasedOnResult(finalInstantResult.resultDescription);
                 } else {
                    // Fallback if instant game over doesn't cover this specific full finish order
                    console.warn(`[GAME ${this.roomId}] All players finished, but checkInstantGameOver did not yield a specific result. Using generic score calculation.`);
                    scoreResult = this.calculateScores(); // This might default to "打平" or similar
                 }
                 this.gameFinished = true; this.gameStarted = false;
                 console.log(`[GAME ${this.roomId}] All players have finished their hands. Final finish order: ${this.finishOrder.join(', ')}.`);
            }
        }

        if (gameOver) {
            // Ensure scoreResult is not null
            if (!scoreResult) scoreResult = this.calculateScores(); // Fallback if somehow missed
            return { success: true, gameOver: true, scoreResult: scoreResult, handInfo: this.lastValidHandInfo };
        } else if (player.finished) { // Player finished but game not over yet
            this.nextTurn(true); // Force advance because current player is done
            return { success: true, playerFinished: true, handInfo: this.lastValidHandInfo };
        } else {
            this.nextTurn();
            return { success: true, handInfo: this.lastValidHandInfo };
        }
    }

    handlePass(playerId) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayerIndex) {
            return { success: false, message: "现在不是您的回合。" };
        }

        const player = this.players[playerIndex];
        if (!player.connected) return { success: false, message: "您已断线，无法操作。" };
        if (player.finished) return { success: false, message: "您已完成出牌，无需“过”。" };
        
        if (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) {
            // Cannot pass if you are the one to start a new round (no last hand or you played the last hand that others passed on)
            return { success: false, message: "您是本轮首个出牌者或上一个出牌者，必须出牌。" };
        }

        console.log(`[GAME ${this.roomId}] Player ${player.name} passed.`);
        this.consecutivePasses++;
        this.possibleHints = []; this.currentHintIndexInternal = 0; // Reset hints on pass

        const activePlayersCount = this.players.filter(p => p.connected && !p.finished).length;
        // If all OTHER active players pass, the turn goes back to the last player who played, and they start a new round
        if (this.lastPlayerWhoPlayed && this.consecutivePasses >= activePlayersCount - 1) {
            console.log(`[GAME ${this.roomId}] All other active players passed. New round starts with player ${this.players.find(p => p.id === this.lastPlayerWhoPlayed)?.name}.`);
            this.resetTurnState(); // Clears center pile, last hand info

            const lastActualPlayerIndex = this.players.findIndex(p => p.id === this.lastPlayerWhoPlayed);
            const lastActualPlayer = this.players[lastActualPlayerIndex];

            if (lastActualPlayer && !lastActualPlayer.finished && lastActualPlayer.connected) {
                this.currentPlayerIndex = lastActualPlayerIndex;
                // this.lastPlayerWhoPlayed = null; // Critical: Reset this so they can't pass immediately
            } else {
                 // If the last player who played is now finished or disconnected, find the next available player from their spot
                 console.warn(`[GAME ${this.roomId}] Last player to play (${this.lastPlayerWhoPlayed}) is no longer active. Finding next for new round.`);
                 this.currentPlayerIndex = lastActualPlayerIndex; // Start search from their position
                 this.nextTurn(true); // Force advance to find next active player
            }
            this.lastPlayerWhoPlayed = null; // Reset for the new round starter
        } else {
            this.nextTurn();
        }
        return { success: true };
    }

    resetTurnState() {
        this.centerPile = [];
        this.lastValidHandInfo = null;
        this.consecutivePasses = 0; // Reset passes when a new round effectively starts
        console.log(`[GAME ${this.roomId}] Turn state reset (pile cleared, last hand info cleared, passes reset).`);
    }

    nextTurn(forceAdvance = false) {
         if (this.gameFinished && !forceAdvance) return;
         if (this.players.length === 0) {
             this.currentPlayerIndex = -1;
             return;
         }

         let currentIdx = this.currentPlayerIndex;
         if (currentIdx === -1 || !this.players[currentIdx]) { // Initial turn or invalid current index
             let foundStartIndex = -1;
             for(let i=0; i < this.players.length; i++) {
                 if (this.players[i] && !this.players[i].finished && this.players[i].connected) {
                     foundStartIndex = i;
                     break;
                 }
             }
             if (foundStartIndex !== -1) {
                 currentIdx = foundStartIndex;
                 // If it's truly the first turn of the game (this.firstTurn is true),
                 // this.currentPlayerIndex would have been set by startGame.
                 // This block is more for recovery if currentPlayerIndex somehow becomes invalid.
             } else {
                 console.warn(`[GAME ${this.roomId}] nextTurn: No active players found to advance turn. Game might be over or stuck.`);
                 this.currentPlayerIndex = -1;
                 // Consider ending the game if no one can play
                 // if (this.gameStarted && !this.gameFinished) this.endGame("No active players remaining for turn.");
                 return;
             }
         }

         const numPlayers = this.players.length;
         if (numPlayers === 0) { // Should be caught by earlier check, but defensive
            this.currentPlayerIndex = -1;
            return;
         }
         
         let nextIndex = currentIdx;
         let loopDetection = 0;
         const maxLoops = numPlayers * 2 + 1; // Allow each player to be checked twice plus one

         do {
              // CORE CHANGE FOR COUNTER-CLOCKWISE: (current - 1 + total) % total
              nextIndex = (nextIndex - 1 + numPlayers) % numPlayers;

              loopDetection++;
              if (loopDetection > maxLoops) {
                   console.error(`[GAME ${this.roomId}] Infinite loop detected in nextTurn! Halting turn advancement. Current player index: ${currentIdx}, Last attempted next index: ${nextIndex}. Players:`, this.players.map(p => ({n:p.name, f:p.finished, c:p.connected })));
                   this.currentPlayerIndex = -1;
                   if (this.gameStarted && !this.gameFinished) this.endGame("Turn Advancement Error - Infinite Loop");
                   return;
              }
         } while (
              !this.players[nextIndex] || // Player object must exist
              this.players[nextIndex].finished || // Skip finished players
              !this.players[nextIndex].connected  // Skip disconnected players
         );

         this.currentPlayerIndex = nextIndex;
         const nextPlayer = this.players[this.currentPlayerIndex];
         console.log(`[GAME ${this.roomId}] Turn advanced to player: ${nextPlayer?.name} (Slot: ${nextPlayer?.slot}, Index: ${this.currentPlayerIndex}). Order: Counter-Clockwise.`);
         
         this.possibleHints = []; // Reset hints for the new player's turn
         this.currentHintIndexInternal = 0;
    }

    findHint(playerId, currentHintIndex = 0) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayerIndex) {
            return { success: false, message: "现在不是您的回合。" };
        }
        const player = this.players[playerIndex];
        if (!player || !player.connected || player.finished) return { success: false, message: "无效的玩家状态，无法获取提示。" };

        // If hints for this player and this specific lastValidHandInfo are already computed, cycle through them
        if (this.possibleHints.length > 0 && this.possibleHints[0].forPlayerId === playerId) {
             const nextIdx = (currentHintIndex + 1) % this.possibleHints.length;
             this.currentHintIndexInternal = nextIdx; // Update server-side index
             return { success: true, hint: this.possibleHints[nextIdx], nextHintIndex: nextIdx };
        }

        // Compute new hints
        this.possibleHints = [];
        const hand = player.hand;
        const handToConsider = [...hand]; // Work with a copy

        // Generate all possible single cards
        for (const card of handToConsider) {
            const validation = this.checkValidPlay([card], handToConsider, this.lastValidHandInfo, this.firstTurn);
            if (validation.valid) this.possibleHints.push({ cards: [card], forPlayerId: playerId, handInfo: validation.handInfo });
        }

        // Generate all possible pairs
        const ranksInHand = {};
        handToConsider.forEach(c => ranksInHand[c.rank] = (ranksInHand[c.rank] || 0) + 1);
        for (const rank in ranksInHand) {
            if (ranksInHand[rank] >= 2) {
                const pairCards = handToConsider.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 2);
                const validation = this.checkValidPlay(pairCards, handToConsider, this.lastValidHandInfo, this.firstTurn);
                if (validation.valid) this.possibleHints.push({ cards: pairCards, forPlayerId: playerId, handInfo: validation.handInfo });
            }
        }
        // Generate all possible three of a kind
         for (const rank in ranksInHand) {
             if (ranksInHand[rank] >= 3) {
                 const threeCards = handToConsider.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 3);
                 const validation = this.checkValidPlay(threeCards, handToConsider, this.lastValidHandInfo, this.firstTurn);
                 if (validation.valid) this.possibleHints.push({ cards: threeCards, forPlayerId: playerId, handInfo: validation.handInfo });
             }
         }
        // TODO: Add logic for finding straights, flushes, full houses, straight flushes if needed for hints

        // Sort hints: generally, prefer to play lower value hands if multiple options of the same type, or just any valid hand.
        // This sort will prefer smaller valid hands.
        this.possibleHints.sort((a, b) => {
             // If a.handInfo or b.handInfo is not present, it's an issue with hint generation.
             if (!a.handInfo || !b.handInfo) return 0;
             return compareHands(a.handInfo, b.handInfo);
        });

        if (this.possibleHints.length > 0) {
             this.currentHintIndexInternal = 0; // Start with the first hint
             return { success: true, hint: this.possibleHints[0], nextHintIndex: 0 };
        } else {
             // If no valid play, and it's not first turn / new round (mustPlay is false), then pass is the only option.
             // The client-side logic should enable pass button if no hint and pass is allowed.
             return { success: false, message: "没有可出的牌（或当前提示未找到）。" };
        }
    }

    getHandInfo(cards) {
        if (!Array.isArray(cards) || cards.length === 0) return { isValid: false, message: "无效的牌组输入" };
        
        const n = cards.length;
        // Sort cards by rank (desc) then suit (desc) for consistent processing and representation
        // compareSingleCards sorts ascending, so we use (b,a) for descending effect in some cases.
        // For representativeCard and primaryRankValue, highest rank is usually key.
        // Flushes are sorted high-to-low for comparison.
        const sortedCards = [...cards].sort((a,b) => compareSingleCards(b,a)); // Highest card first for general rep

        const suits = new Set(sortedCards.map(c => c.suit));
        const ranks = sortedCards.map(c => c.rank);
        const rankValues = sortedCards.map(c => RANK_VALUES[c.rank]); // Values of original cards

        const isFlush = suits.size === 1;
        
        let isStraight = false;
        let straightPrimaryRankValue = -1; // Highest rank in the straight

        if (n === 5) {
            // For straight, we need unique ranks sorted ascendingly to check continuity
            const uniqueRankValuesSortedAsc = [...new Set(ranks.map(r => RANK_VALUES[r]))].sort((a, b) => a - b);
            if (uniqueRankValuesSortedAsc.length === 5) {
                // Standard straight: 4,5,6,7,8 -> 8-4=4
                if (uniqueRankValuesSortedAsc[4] - uniqueRankValuesSortedAsc[0] === 4) {
                    isStraight = true;
                    straightPrimaryRankValue = uniqueRankValuesSortedAsc[4]; // Highest rank value in straight
                }
                // Special case for A-2-3-4-5 straight (A is low)
                // Ranks: A,2,3,4,5 -> Values might be 12,0,1,2,3 (if A=12, 2=0, 3=1 ...)
                // Need to check if ranks are {A,2,3,4,5} specifically if A can be low in straight
                // Our RANK_ORDER is 4...K,A,2,3. A=10, 2=11, 3=12. 4=0.
                // So A,2,3,4,5 (ranks) -> 10,11,12,0,1 (values) -- this is not continuous with current values
                // If A-5 straight: A,2,3,4,5. Sorted values: 0(4),1(5),10(A),11(2),12(3).
                // If 3-A straight: 3,K,A,2 (not 5 cards)
                // This game's RANK_ORDER makes A,2,3 high. So 2,3,4,5,6 is lowest straight. T,J,Q,K,A is highest.
                // K,A,2,3,4 is not a straight with this ordering. A,2,3,4,5 is not.
            }
        }

        const rankCounts = {};
        ranks.forEach(rank => { rankCounts[rank] = (rankCounts[rank] || 0) + 1; });
        const counts = Object.values(rankCounts).sort((a, b) => b - a); // Counts of ranks, e.g., [3,2] for full house
        const distinctRanks = Object.keys(rankCounts); // Ranks present, e.g., ['K', '7']

        // Determine hand type based on priority (e.g., Straight Flush > Full House)
        if (n === 5 && isStraight && isFlush) {
            // Cards for flush/straight flush should be sorted high-to-low
            const sfSortedCards = [...cards].sort((a,b) => compareSingleCards(b,a));
            return { isValid: true, type: HAND_TYPES.STRAIGHT_FLUSH, cards: sfSortedCards, primaryRankValue: straightPrimaryRankValue, suitValue: SUIT_VALUES[sfSortedCards[0].suit], representativeCard: sfSortedCards[0] };
        }
        if (n === 5 && counts[0] === 3 && counts.length >=2 && counts[1] === 2) { // counts.length check for safety
            const threeRank = distinctRanks.find(rank => rankCounts[rank] === 3);
            const fhSortedCards = [...cards].sort((a,b) => { // Sort by count, then rank for consistent rep
                const countDiff = rankCounts[b.rank] - rankCounts[a.rank];
                if (countDiff !== 0) return countDiff;
                return compareSingleCards(b,a);
            });
            return { isValid: true, type: HAND_TYPES.FULL_HOUSE, cards: fhSortedCards, primaryRankValue: RANK_VALUES[threeRank], representativeCard: fhSortedCards[0] };
        }
        if (n === 5 && isFlush) {
            const flushSortedCards = [...cards].sort((a,b) => compareSingleCards(b,a)); // Standard high-to-low sort
            return { isValid: true, type: HAND_TYPES.FLUSH, cards: flushSortedCards, representativeCard: flushSortedCards[0], primaryRankValue: RANK_VALUES[flushSortedCards[0].rank] };
        }
        if (n === 5 && isStraight) {
            // For straight, representative is highest card. Sort cards by rank.
            const straightSortedCards = [...cards].sort((a,b) => compareSingleCards(b,a));
            return { isValid: true, type: HAND_TYPES.STRAIGHT, cards: straightSortedCards, primaryRankValue: straightPrimaryRankValue, representativeCard: straightSortedCards[0] };
        }
        if (n === 3 && counts[0] === 3) {
            const threeRank = distinctRanks.find(rank => rankCounts[rank] === 3);
            // For three of a kind, representative is one of the three. Sort by suit for consistency.
            const threeSortedCards = [...cards].sort(compareSingleCards); // Standard sort is fine
            return { isValid: true, type: HAND_TYPES.THREE_OF_A_KIND, cards: threeSortedCards, representativeCard: threeSortedCards[2], primaryRankValue: RANK_VALUES[threeRank] }; // Highest of the three by suit
        }
        if (n === 2 && counts[0] === 2) {
            const pairRank = distinctRanks.find(rank => rankCounts[rank] === 2);
             const pairSortedCards = [...cards].sort(compareSingleCards);
            return { isValid: true, type: HAND_TYPES.PAIR, cards: pairSortedCards, representativeCard: pairSortedCards[1], primaryRankValue: RANK_VALUES[pairRank] }; // Highest of the pair by suit
        }
        if (n === 1) {
            return { isValid: true, type: HAND_TYPES.SINGLE, cards: [...cards], representativeCard: cards[0], primaryRankValue: RANK_VALUES[cards[0].rank] };
        }
        
        // Specific rules for invalid combinations (like 4 of a kind if not a bomb)
        if (counts[0] === 4 && (n === 4 || n === 5) ) { // Check for four of a kind
             // In many 'Da Lao Er' variants, 4 of a kind is a bomb and has special rules.
             // Current logic says "不允许出四条炸弹". If this means it's not a valid play AT ALL, this is fine.
             // If it IS a bomb and should beat other hands, this needs a major rework.
             // Assuming for now it's simply not allowed as a standard play.
             if (n === 4) return { isValid: false, message: "不允许出四条（当前规则）。" };
             if (n === 5) return { isValid: false, message: "不允许四条带单张（非标准牌型）。" };
        }

        return { isValid: false, message: "无法识别的牌型或牌数量不符合任何有效牌型。" };
     }

    checkValidPlay(cardsToPlay, currentHand, centerPileInfo, isFirstTurn) {
         const newHandInfo = this.getHandInfo(cardsToPlay);
         if (!newHandInfo.isValid) return { valid: false, message: newHandInfo.message || "无效的牌型。" };

         if (isFirstTurn) {
             const hasD4 = cardsToPlay.some(c => c.suit === 'D' && c.rank === '4');
             if (!hasD4) return { valid: false, message: "第一回合出牌必须包含方块4。" };
             // Any valid hand type containing D4 is okay for the first turn
             return { valid: true, handInfo: newHandInfo };
         } else {
             // Not the first turn
             if (!centerPileInfo) { // No cards on the pile, this player starts a new round
                 return { valid: true, handInfo: newHandInfo };
             }
             // There are cards on the pile, must beat them
             if (newHandInfo.type !== centerPileInfo.type) {
                 // TODO: Implement bomb logic here if applicable
                 // e.g., if newHandInfo.type is BOMB and centerPileInfo.type is not BOMB, newHand is valid
                 // if both are BOMB, compare bomb ranks.
                 return { valid: false, message: `必须出与上家相同类型的牌 (${centerPileInfo.type})，或者更高级的牌型（如炸弹，当前未实现）。` };
             }
             if (newHandInfo.cards.length !== centerPileInfo.cards.length) {
                // This check might be too strict if different hand types can have different lengths (e.g. a 5-card straight vs a single bomb card)
                // However, for comparing same types (pair vs pair, straight vs straight), length must match.
                return { valid: false, message: `相同牌型下，出牌数量必须与上家一致 (${centerPileInfo.cards.length}张)。`};
             }

             const comparison = compareHands(newHandInfo, centerPileInfo);
             if (comparison > 0) { // newHand is greater than centerPileHand
                 return { valid: true, handInfo: newHandInfo };
             } else {
                 return { valid: false, message: `您打出的 ${newHandInfo.type} 必须大于上家打出的牌。` };
             }
         }
     }

    checkInstantGameOver() {
        const nFinished = this.finishOrder.length;
        if (this.gameMode === 'standard' && nFinished < 2 && this.players.length > 2) return { isOver: false }; // Need at least 2 finishers for standard unless only 2 players total
        if (this.gameMode === 'double_landlord' && nFinished < 1) return { isOver: false };

        const finishRoles = this.finishOrder.map(playerId => this.playerRoles[playerId]);
        let resultDescription = null; let isOver = false;

        if (this.gameMode === 'standard') {
            const rolesStr = finishRoles.join(''); // e.g., "DD", "FF", "DFD"
            if (nFinished >= 2) {
                if (finishRoles[0] === 'D' && finishRoles[1] === 'D') { resultDescription = "地主大胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'F' && (this.players.filter(p=>p.role==='F').length >=2) ) { resultDescription = "农民大胜"; isOver = true; }
            }
            if (!isOver && nFinished >= 3) {
                // DFD (地主胜), FDF (农民胜)
                if (rolesStr.startsWith('DFD')) { resultDescription = "地主胜"; isOver = true; }
                else if (rolesStr.startsWith('FDF')) { resultDescription = "农民胜"; isOver = true; }
                // DFF (打平 if 3rd F is the last F), FDD (打平 if 3rd D is the last D)
                else if (rolesStr.startsWith('DFF') && this.finishOrder.length === this.players.length && this.players.find(p=>p.id === this.finishOrder[2]).role === 'F') {
                     resultDescription = "打平"; isOver = true;
                } else if (rolesStr.startsWith('FDD') && this.finishOrder.length === this.players.length && this.players.find(p=>p.id === this.finishOrder[2]).role === 'D') {
                     resultDescription = "打平"; isOver = true;
                }
            }
             // Full game completion for 4 players (standard)
            if (!isOver && nFinished === 4) {
                if (rolesStr === 'DFDF' || rolesStr === 'DDF F') { resultDescription = "地主胜"; isOver = true; } // Simplified, assuming DDFF (if D are 1,2) is D win
                else if (rolesStr === 'FDFD' || rolesStr === 'FFD D') { resultDescription = "农民胜"; isOver = true; }
                else if (rolesStr === 'DFFD' || rolesStr === 'FDDF') { resultDescription = "打平"; isOver = true; }
                // More specific 4 player logic might be needed if exact order matters beyond first 2-3.
            }
        } else if (this.gameMode === 'double_landlord') {
            if (nFinished === 0) return { isOver: false };
            if (finishRoles[0] === 'DD') { resultDescription = "双地主大胜"; isOver = true; }
            else if (nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'F') { resultDescription = "农民大胜"; isOver = true; }
            // Less common/clear rules for DD勝/农民勝 for double landlord, often depends on house rules
            else if (nFinished >= 2 && finishRoles[0] === 'F' && finishRoles[1] === 'DD') { resultDescription = "双地主胜"; isOver = true; } // DD is 2nd
            else if (nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'DD') { resultDescription = "农民胜"; isOver = true; } // DD is 3rd
        }

        // If no specific rule matched but all players finished, it might be a draw or based on last player holding cards etc.
        if (!isOver && this.finishOrder.length === this.players.length) {
            console.log(`[GAME ${this.roomId}] All players finished, but no specific instant win condition met. Declaring based on last player or default.`);
            // This part needs clear game rules. For now, might default to a draw or specific calculation.
            // resultDescription = "打平 (无特定速胜)"; isOver = true;
        }
        return { isOver, resultDescription };
     }

    calculateScoresBasedOnResult(resultDescription) {
         const scoreChanges = {}; let landlordScoreChange = 0; let farmerScoreChange = 0; let ddScoreChange = 0;
         console.log(`[SCORE ${this.roomId}] Calculating scores based on result: "${resultDescription}"`);
         if (!resultDescription) {
             console.warn(`[SCORE ${this.roomId}] No resultDescription provided. Defaulting to a draw (0 score change).`);
             resultDescription = "打平 (计分错误)"; // Assign a default to avoid errors
         }

         if (this.gameMode === 'standard') {
             switch (resultDescription) {
                 case "打平": landlordScoreChange = 0; farmerScoreChange = 0; break;
                 case "地主胜": landlordScoreChange = 1; farmerScoreChange = -1; break;
                 case "农民胜": landlordScoreChange = -1; farmerScoreChange = 1; break;
                 case "地主大胜": landlordScoreChange = 2; farmerScoreChange = -2; break;
                 case "农民大胜": landlordScoreChange = -2; farmerScoreChange = 2; break;
                 default:
                     console.warn(`[SCORE ${this.roomId}] Unknown standard result: "${resultDescription}". Assigning 0 score change.`);
                     landlordScoreChange = 0; farmerScoreChange = 0;
             }
             this.players.forEach(p => { scoreChanges[p.id] = (this.playerRoles[p.id] === 'D') ? landlordScoreChange : farmerScoreChange; });
         } else if (this.gameMode === 'double_landlord') { // Double Landlord
             switch (resultDescription) {
                 case "双地主大胜": ddScoreChange = 6; farmerScoreChange = -2; break; // DD gets +6, each F gets -2
                 case "双地主胜":   ddScoreChange = 3; farmerScoreChange = -1; break;
                 case "农民胜":     ddScoreChange = -3; farmerScoreChange = 1; break;
                 case "农民大胜":   ddScoreChange = -6; farmerScoreChange = 2; break;
                 default:
                     console.warn(`[SCORE ${this.roomId}] Unknown double landlord result: "${resultDescription}". Assigning 0 score change.`);
                     ddScoreChange = 0; farmerScoreChange = 0;
             }
              this.players.forEach(p => { scoreChanges[p.id] = (this.playerRoles[p.id] === 'DD') ? ddScoreChange : farmerScoreChange; });
         } else {
            console.error(`[SCORE ${this.roomId}] Unknown game mode for scoring: ${this.gameMode}`);
         }

         this.players.forEach(p => {
             const change = scoreChanges[p.id] || 0;
             p.score += change;
             console.log(`[SCORE ${this.roomId}] Player ${p.name} (${this.playerRoles[p.id] || p.role || 'N/A'}): ${change >= 0 ? '+' : ''}${change} -> New Total Score: ${p.score}`);
         });

          return {
              result: resultDescription,
              scoreChanges: scoreChanges,
              finalScores: this.players.map(p => ({
                  id: p.id, name: p.name,
                  score: p.score,
                  role: this.playerRoles[p.id] || p.role || 'N/A'
                }))
          };
      }

    calculateScores() {
        // This is a fallback if a game ends without a specific 'resultDescription' from checkInstantGameOver
        console.warn(`[SCORE ${this.roomId}] Using fallback calculateScores(). This usually means an incomplete game or unhandled end condition.`);
        const instantResult = this.checkInstantGameOver(); // Try one last time
        if (instantResult.isOver && instantResult.resultDescription) {
            return this.calculateScoresBasedOnResult(instantResult.resultDescription);
        }
        // Default to a "打平" or a more specific rule if all players finished but no instant win.
        return this.calculateScoresBasedOnResult("打平 (游戏结束)");
    }

    endGame(reason = "Game finished by server") {
          if (this.gameFinished) { // Prevent multiple calls
            console.log(`[GAME ${this.roomId}] endGame called but game already finished. Reason: ${reason}`);
            // Return existing score result if available, or calculate if somehow missed
            const finalPlayerStates = this.players.map(p => ({ id: p.id, name: p.name, score: p.score, role: this.playerRoles[p.id] || p.role }));
            return { result: this.gameResultText || "已结束", scoreChanges: this.lastScoreChanges || {}, finalScores: finalPlayerStates };
          }

          this.gameFinished = true;
          this.gameStarted = false; // Game is no longer actively being played
          this.gameResultText = reason; // Store the reason
          console.log(`[GAME ${this.roomId}] Game ended. Reason: ${reason}`);

          // Ensure all players are in finishOrder if not already
          if (this.finishOrder.length < this.players.length) {
               const finishedIds = new Set(this.finishOrder);
               const remainingPlayers = this.players.filter(p => !finishedIds.has(p.id));
               // Add remaining players to finish order, perhaps sorted by hand size (fewest cards first) or by slot
               remainingPlayers.sort((a,b) => a.hand.length - b.hand.length || a.slot - b.slot);
               remainingPlayers.forEach(p => {
                    if (!finishedIds.has(p.id)) {
                        this.finishOrder.push(p.id);
                        p.finished = true; // Mark them as finished
                    }
                });
          }
          const scoreResult = this.calculateScores(); // Calculate final scores
          this.lastScoreChanges = scoreResult.scoreChanges; // Store for later retrieval if needed
          this.gameResultText = scoreResult.result || reason; // Update reason with more specific result from scoring

          console.log(`[GAME ${this.roomId}] Final score calculation result: ${this.gameResultText}`);
          return scoreResult;
     }

    createDeck() {
        const suits = ["H", "D", "C", "S"]; // Hearts, Diamonds, Clubs, Spades
        const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"]; // Standard ranks
        this.deck = [];
        for (const suit of suits) {
            for (const rank of ranks) {
                // Use your RANK_ORDER for consistency if card creation depends on it,
                // but for a standard deck, A-K is fine.
                // The actual value/power is determined by RANK_VALUES.
                this.deck.push({ suit, rank });
            }
        }
        // Example: RANK_ORDER is ["4", "5", ..., "A", "2", "3"]
        // If you want deck creation to follow your game's specific rank order for some reason:
        /*
        this.deck = [];
        const gameRanks = ["4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2", "3"];
        for (const suit of suits) {
            for (const rank of gameRanks) {
                this.deck.push({ suit, rank });
            }
        }
        */
     }

    shuffleDeck() {
         // Fisher-Yates shuffle algorithm
         for (let i = this.deck.length - 1; i > 0; i--) {
            const j = crypto.randomInt(i + 1); // Secure random integer from crypto module
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]]; // Swap
        }
        console.log(`[GAME ${this.roomId}] Deck shuffled. Total cards: ${this.deck.length}`);
     }

    dealCards(cardsPerPlayer) {
         if (this.players.length === 0) {
             console.error(`[DEAL ERROR ${this.roomId}] No players to deal cards to.`);
             return;
         }
         const totalCardsToDeal = cardsPerPlayer * this.players.length;
         if (totalCardsToDeal > this.deck.length) {
             console.error(`[DEAL ERROR ${this.roomId}] Not enough cards in deck (${this.deck.length}) to deal ${totalCardsToDeal} cards for ${this.players.length} players.`);
             return; // Or handle this by re-shuffling discard pile if game rules allow
         }

         for (let i = 0; i < this.players.length; i++) {
            this.players[i].hand = []; // Clear previous hand
         }

         for (let i = 0; i < totalCardsToDeal; i++) {
             const player = this.players[i % this.players.length]; // Deal one card at a time to each player
             const cardToDeal = this.deck.pop();
             if (cardToDeal) {
                player.hand.push(cardToDeal);
             } else {
                console.error(`[DEAL ERROR ${this.roomId}] Deck ran out unexpectedly while dealing.`);
                break; // Stop dealing if deck is empty
             }
         }
         this.players.forEach(player => {
            this.sortHand(player.hand);
            // console.log(`[DEAL ${this.roomId}] Player ${player.name} (Slot ${player.slot}) hand: ${player.hand.map(c=>c.rank+c.suit).join(',')}`);
         });
         console.log(`[GAME ${this.roomId}] Cards dealt. Remaining in deck: ${this.deck.length}`);
     }

    sortHand(hand) {
        // Sorts hand: primarily by rank (as per RANK_VALUES), then by suit (as per SUIT_VALUES)
        // This uses the globally defined compareSingleCards function
        hand.sort(compareSingleCards);
    }

    getStateForPlayer(requestingPlayerId) {
        // console.log(`[GAME ${this.roomId}] getStateForPlayer called for ${requestingPlayerId || 'observer'}`);
        const isObserver = !this.players.some(p => p.id === requestingPlayerId);

        return {
            // Room specific info (can also be part of a higher-level roomState object)
            // roomId: this.roomId,
            // gameMode: this.gameMode,

            // Player information
            players: this.players.map(p => ({
                id: p.id,
                name: p.name,
                slot: p.slot,
                score: p.score,
                role: this.playerRoles[p.id] || p.role, // Ensure role is from the authoritative playerRoles
                finished: p.finished,
                connected: p.connected,
                hand: (p.id === requestingPlayerId && !isObserver) ? p.hand : undefined, // Only send hand to the owner
                handCount: p.hand.length,
                isAiControlled: p.isAiControlled,
                // isCurrentPlayer: this.gameStarted && !this.gameFinished && this.currentPlayerIndex !== -1 && this.players[this.currentPlayerIndex]?.id === p.id
            })),

            // Game state specific information
            centerPile: [...this.centerPile], // Current cards on the table
            lastHandInfo: this.lastValidHandInfo ? { type: this.lastValidHandInfo.type, cards: [...this.lastValidHandInfo.cards] } : null,
            currentPlayerId: (this.gameStarted && !this.gameFinished && this.currentPlayerIndex !== -1 && this.players[this.currentPlayerIndex]) ? this.players[this.currentPlayerIndex].id : null,
            isFirstTurn: this.firstTurn,
            gameStarted: this.gameStarted,
            gameFinished: this.gameFinished,
            winnerId: this.winnerId, // Could be the first to finish, or derived from score result
            finishOrder: [...this.finishOrder],
            lastPlayerWhoPlayedId: this.lastPlayerWhoPlayed,

            // Game result information (if finished)
            gameResultText: this.gameFinished ? this.gameResultText : null,
            finalScores: this.gameFinished ? this.players.map(p => ({ id:p.id, name:p.name, score:p.score, role: this.playerRoles[p.id] || p.role })) : null,
            scoreChanges: this.gameFinished ? this.lastScoreChanges : null,
            //gameOverReason: this.gameFinished ? this.gameResultText : null // Redundant with gameResultText
        };
    }
}

module.exports = { Game, HAND_TYPES, RANK_VALUES, SUIT_VALUES, compareSingleCards }; // Export helpers if needed elsewhere
