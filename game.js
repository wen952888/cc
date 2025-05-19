// game.js
const crypto = require('crypto');

// --- 定量定义 ---
// 牌点顺序 (从4到3，3最大)
const RANK_ORDER = ["4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A", "2", "3"];
const RANK_VALUES = {};
RANK_ORDER.forEach((rank, index) => { RANK_VALUES[rank] = index; });

// 花色顺序 (方块 < 梅花 < 红桃 < 黑桃)
const SUIT_ORDER = ["D", "C", "H", "S"]; 
const SUIT_VALUES = {};
SUIT_ORDER.forEach((suit, index) => { SUIT_VALUES[suit] = index; });

// 牌型定义
const HAND_TYPES = {
    SINGLE: 'single',           // 单张
    PAIR: 'pair',               // 对子
    THREE_OF_A_KIND: 'three_of_a_kind', // 三条
    STRAIGHT: 'straight',       // 顺子
    FLUSH: 'flush',             // 同花
    FULL_HOUSE: 'full_house',   // 葫芦 (三带二)
    STRAIGHT_FLUSH: 'straight_flush' // 同花顺
    // 未来可能加入: FOUR_OF_A_KIND_BOMB: 'four_of_a_kind_bomb' // 四条炸弹
};

// 牌型大小排序 (数值越大，牌型越大)
const HAND_TYPE_RANKING = {
    [HAND_TYPES.SINGLE]: 1,
    [HAND_TYPES.PAIR]: 2,
    [HAND_TYPES.THREE_OF_A_KIND]: 3,
    [HAND_TYPES.STRAIGHT]: 4,
    [HAND_TYPES.FLUSH]: 5,
    [HAND_TYPES.FULL_HOUSE]: 6,
    [HAND_TYPES.STRAIGHT_FLUSH]: 7
};

// --- 辅助函数 ---
// 比较单张牌的大小 (先比点数，再比花色)
function compareSingleCards(cardA, cardB) {
    const rankValueA = RANK_VALUES[cardA.rank];
    const rankValueB = RANK_VALUES[cardB.rank];
    if (rankValueA !== rankValueB) return rankValueA - rankValueB;
    return SUIT_VALUES[cardA.suit] - SUIT_VALUES[cardB.suit];
}

// 比较两手牌的大小
function compareHands(handInfoA, handInfoB) {
    const typeRankA = HAND_TYPE_RANKING[handInfoA.type];
    const typeRankB = HAND_TYPE_RANKING[handInfoB.type];

    // 不同牌型，直接比牌型等级
    if (typeRankA !== typeRankB) return typeRankA - typeRankB;

    // 相同牌型，根据具体牌型规则比较
    switch (handInfoA.type) {
        case HAND_TYPES.STRAIGHT_FLUSH: // 同花顺
        case HAND_TYPES.FULL_HOUSE:     // 葫芦
        case HAND_TYPES.STRAIGHT:       // 顺子
            // 这些牌型主要比较其"主牌点" (顺子/同花顺的最高牌，葫芦中的三条的点数)
            if (handInfoA.primaryRankValue !== handInfoB.primaryRankValue) {
                 return handInfoA.primaryRankValue - handInfoB.primaryRankValue;
            }
            // 如果主牌点相同 (例如，都是K三条的葫芦，或都是A结尾的顺子)，则比较代表牌 (通常是最大那张牌，包含花色)
            return compareSingleCards(handInfoA.representativeCard, handInfoB.representativeCard);
        
        case HAND_TYPES.FLUSH: // 同花
            // 同花按顺序比较每一张牌，从大到小
            // getHandInfo 应确保 handInfo.cards 是按 compareSingleCards 降序排列的
            for (let i = 0; i < handInfoA.cards.length; i++) {
                const compareResult = compareSingleCards(handInfoA.cards[i], handInfoB.cards[i]);
                if (compareResult !== 0) return compareResult;
            }
            return 0; // 所有牌都一样 (理论上不可能在不同玩家打出完全相同的同花)

        case HAND_TYPES.THREE_OF_A_KIND: // 三条
        case HAND_TYPES.PAIR:            // 对子
        case HAND_TYPES.SINGLE:          // 单张
            // 这些牌型直接比较其代表牌 (单张本身，对子/三条中最大的那张)
            return compareSingleCards(handInfoA.representativeCard, handInfoB.representativeCard);
        
        default: return 0; // 未知或不应比较的牌型
    }
}

class Game {
    constructor(roomId, maxPlayers = 4) {
        this.roomId = roomId;
        this.maxPlayers = maxPlayers;
        this.players = []; // 存储玩家对象 { id, name, slot, hand, score, connected, finished, role, isAiControlled }
        this.deck = [];
        this.centerPile = []; // 当前桌面上打出的牌
        this.lastValidHandInfo = null; // 上一手有效牌的信息
        this.currentPlayerIndex = -1; // 当前轮到出牌的玩家在 this.players 数组中的索引
        this.firstTurn = true; // 是否是本局游戏的第一轮出牌
        this.gameStarted = false;
        this.gameFinished = false;
        this.winnerId = null; // 第一个出完牌的玩家ID (名义上的赢家，最终结果看角色)
        this.playerRoles = {}; // { playerId: role (D, F, DD) }
        this.finishOrder = []; // 玩家出完牌的顺序 [playerId, playerId, ...]
        this.gameMode = null; // 'standard' 或 'double_landlord'
        this.consecutivePasses = 0; // 当前连续Pass的次数
        this.lastPlayerWhoPlayed = null; // 上一个成功出牌的玩家ID
        
        // 提示功能相关
        this.possibleHints = []; // 为当前玩家缓存的可能提示 [{ cards, type, forPlayerId }, ...]
        this.currentHintIndexInternal = 0; // 服务器端记录的当前提示索引，用于循环

        // 游戏结果相关
        this.gameResultText = ""; // 例如 "地主大胜"
        this.gameOverReason = ""; // 游戏结束的原因 (例如 "有玩家离开")
        this.finalScores = null;  // { playerId: score }
        this.scoreChanges = null; // { playerId: change }
    }

    addPlayer(userId, username, slot) {
        const existingPlayer = this.players.find(p => p.id === userId);
        if (existingPlayer) { 
            // 如果玩家已存在 (例如断线重连后，或者开始新一局游戏时重新加入)
            existingPlayer.name = username; 
            existingPlayer.slot = slot; // 更新slot以防万一座位有变动 (虽然通常固定)    
            existingPlayer.connected = true;
            existingPlayer.finished = false; // 重置完成状态
            existingPlayer.hand = []; // 清空手牌
            existingPlayer.role = null; // 重置角色
            // isAiControlled 状态通常由 roomManager 控制，这里不重置
            console.log(`[GAME ${this.roomId}] Player ${username} (ID: ${userId}) re-added/updated for new round.`);
            return true;
        }
        if (this.players.length >= this.maxPlayers) {
            console.warn(`[GAME ${this.roomId}] Cannot add player ${username}. Game instance full (${this.players.length}/${this.maxPlayers}).`);
            return false;
        }

        this.players.push({
            id: userId, name: username, slot: slot, hand: [], score: 0, // 初始分数
            connected: true, finished: false, role: null, isAiControlled: false // 默认非AI
        });
        this.players.sort((a, b) => a.slot - b.slot); // 确保玩家按座位排序
        console.log(`[GAME ${this.roomId}] Player ${username} added to game instance. Total: ${this.players.length}`);
        return true;
    }

    removePlayer(userId) { // 仅标记为断开，实际移除由 roomManager 处理
        this.markPlayerConnected(userId, false);
    }

    markPlayerConnected(userId, isConnected) {
        const player = this.players.find(p => p.id === userId);
        if (player) {
            player.connected = !!isConnected;
            console.log(`[GAME ${this.roomId}] Player ${player.name} connection status in game: ${player.connected}`);
            // 如果是当前玩家断开，nextTurn 会处理跳过或AI接管（如果实现）
        }
    }
    
    setPlayerAI(userId, isAiControlled) {
        const player = this.players.find(p => p.id === userId);
        if (player) {
            player.isAiControlled = !!isAiControlled;
            console.log(`[GAME ${this.roomId}] Player ${player.name} AI control in game set to: ${player.isAiControlled}`);
        }
    }


    startGame(playerStartInfo) { // playerStartInfo: [{id, name, slot, score, isAiControlled (from roomManager)}, ...]
        // 重置游戏状态变量
        this.deck = []; this.centerPile = []; this.lastValidHandInfo = null; this.currentPlayerIndex = -1;
        this.firstTurn = true; this.gameStarted = false; this.gameFinished = false; this.winnerId = null;
        this.playerRoles = {}; this.finishOrder = []; this.gameMode = null; this.consecutivePasses = 0; this.lastPlayerWhoPlayed = null;
        this.possibleHints = []; this.currentHintIndexInternal = 0;
        this.gameResultText = ""; this.gameOverReason = ""; this.finalScores = null; this.scoreChanges = null;

        if (!playerStartInfo || playerStartInfo.length !== this.maxPlayers) {
            return { success: false, message: `需要 ${this.maxPlayers} 位玩家。当前: ${playerStartInfo ? playerStartInfo.length : 0}。` };
        }

        // 从 roomManager 获取玩家的累计分数，并初始化本局游戏玩家列表
        this.players = playerStartInfo.map(info => ({
            id: info.id, name: info.name, slot: info.slot, hand: [],
            score: info.score || 0, // 继承之前的分数
            connected: true, // 游戏开始时，认为玩家是连接的 (roomManager应确保)
            finished: false, role: null,
            isAiControlled: !!info.isAiControlled // 从 roomManager 同步 AI 状态
        })).sort((a, b) => a.slot - b.slot);

        console.log(`[GAME ${this.roomId}] Starting game with players:`, this.players.map(p => ({name:p.name, score: p.score, ai:p.isAiControlled })));
        this.createDeck(); this.shuffleDeck(); this.dealCards(13); // 每人13张牌
        this.gameStarted = true; this.firstTurn = true;

        // --- 确定角色 ---
        let s3PlayerId = null, saPlayerId = null; // 黑桃3和黑桃A的持有者ID
        this.players.forEach(p => {
            if (p.hand.some(c => c.suit === 'S' && c.rank === '3')) s3PlayerId = p.id;
            if (p.hand.some(c => c.suit === 'S' && c.rank === 'A')) saPlayerId = p.id;
        });

        if (!s3PlayerId || !saPlayerId) {
            console.error(`[GAME ${this.roomId}] 角色分配错误: 未找到黑桃3或黑桃A的持有者。`);
            this.gameStarted = false; // 游戏无法开始
            return { success: false, message: "发牌错误，关键身份牌缺失！" };
        }

        if (s3PlayerId === saPlayerId) { // 同一个人拿到黑桃3和黑桃A -> 双地主模式
            this.gameMode = 'double_landlord';
            this.playerRoles[s3PlayerId] = 'DD'; // Double Landlord
        } else { // 不同人 -> 标准模式，两人为地主
            this.gameMode = 'standard';
            this.playerRoles[s3PlayerId] = 'D'; // Landlord
            this.playerRoles[saPlayerId] = 'D'; // Landlord
        }
        // 为其他玩家分配角色 (农民 'F')
        this.players.forEach(p => {
            if (this.playerRoles[p.id]) { // 如果已分配角色 (地主或双地主)
                p.role = this.playerRoles[p.id];
            } else { // 否则为农民
                p.role = 'F';
                this.playerRoles[p.id] = 'F';
            }
        });
        console.log(`[GAME ${this.roomId}] 游戏模式: ${this.gameMode}. 角色分配:`, this.playerRoles);

        // --- 确定先手玩家 (持有方块4) ---
        let startingPlayerIndex = -1;
        for (let i = 0; i < this.players.length; i++) {
            if (this.players[i].hand.some(card => card.suit === 'D' && card.rank === '4')) {
                startingPlayerIndex = i; break;
            }
        }
        if (startingPlayerIndex === -1) {
            console.error(`[GAME ${this.roomId}] 先手玩家确定错误: 未找到方块4的持有者。`);
            this.gameStarted = false; // 游戏无法开始
            return { success: false, message: "发牌错误，先手牌(方块4)缺失！" };
        }
        this.currentPlayerIndex = startingPlayerIndex;
        this.lastPlayerWhoPlayed = null; // 新游戏开始，没有人出过牌

        console.log(`[GAME ${this.roomId}] 玩家 ${this.players[this.currentPlayerIndex].name} (座位 ${this.players[this.currentPlayerIndex].slot}) 持有方块4，开始出牌。`);
        return { success: true };
    }

    playCard(playerId, cards) {
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayerIndex) {
            return { success: false, message: "现在不是您的回合或您不是当前玩家。" };
        }
        
        const player = this.players[playerIndex];
        if (!player.connected && !player.isAiControlled) return { success: false, message: "您已断线，无法出牌。" };
        if (player.finished) return { success: false, message: "您已完成出牌，无法再次出牌。" };
        if (!Array.isArray(cards) || cards.length === 0) return { success: false, message: "请选择要出的牌。" };

        const handSet = new Set(player.hand.map(c => `${c.rank}${c.suit}`));
        if (!cards.every(card => handSet.has(`${card.rank}${card.suit}`))) {
            return { success: false, message: "选择的牌不在您的手中或牌数据无效。" };
        }

        const validationResult = this.checkValidPlay(cards, player.hand, this.lastValidHandInfo, this.firstTurn);
        if (!validationResult.valid) return { success: false, message: validationResult.message };

        // 从手中移除打出的牌
        const cardsToRemoveSet = new Set(cards.map(c => `${c.rank}${c.suit}`));
        player.hand = player.hand.filter(card => !cardsToRemoveSet.has(`${card.rank}${card.suit}`));
        this.sortHand(player.hand); // 重新排序剩余手牌

        // 更新桌面状态
        this.centerPile = [...cards]; // 存储副本
        this.lastValidHandInfo = validationResult.handInfo;
        this.lastPlayerWhoPlayed = playerId;
        this.consecutivePasses = 0;
        if (this.firstTurn) this.firstTurn = false;
        
        console.log(`[GAME ${this.roomId}] 玩家 ${player.name} 打出 ${this.lastValidHandInfo.type}: ${cards.map(c=>c.rank+c.suit).join(',')}. 剩余手牌: ${player.hand.length}`);
        this.possibleHints = []; this.currentHintIndexInternal = 0; // 重置提示

        // --- 检查游戏是否结束 ---
        let gameOver = false;
        let scoreResultToReturn = null;
        if (player.hand.length === 0) { // 当前玩家出完了牌
            this.finishOrder.push(playerId);
            player.finished = true;
            if (!this.winnerId) this.winnerId = playerId; // 第一个出完牌的
            console.log(`[GAME ${this.roomId}] 玩家 ${player.name} 出完牌. 完成顺序: ${this.finishOrder.map(id => this.players.find(p=>p.id===id)?.name).join(', ')}.`);

            const instantResult = this.checkInstantGameOver(); // 检查是否满足速胜/速败条件
            if (instantResult.isOver) {
                gameOver = true;
                // 将所有未完成的玩家按规则加入完成顺序 (例如按剩余牌数)
                const remainingUnfinished = this.players.filter(p => !this.finishOrder.includes(p.id));
                remainingUnfinished.sort((a,b) => a.hand.length - b.hand.length || a.slot - b.slot)
                                 .forEach(p => {
                                     if(!this.finishOrder.includes(p.id)) this.finishOrder.push(p.id);
                                     p.finished = true; 
                                 });
                scoreResultToReturn = this.calculateScoresBasedOnResult(instantResult.resultDescription);
                this.gameFinished = true; this.gameStarted = false;
                console.log(`[GAME ${this.roomId}] 游戏因速胜/速败条件结束: ${instantResult.resultDescription}`);
            } else if (this.finishOrder.length === this.players.length -1) { // 只剩一个玩家没出完
                 const lastPlayer = this.players.find(p => !p.finished && !this.finishOrder.includes(p.id)); 
                 if(lastPlayer) { // 将最后一个玩家加入完成列表
                    if(!this.finishOrder.includes(lastPlayer.id)) this.finishOrder.push(lastPlayer.id);
                    lastPlayer.finished = true;
                 }
                 gameOver = true;
                 const finalOutcome = this.checkInstantGameOver(); // 此时所有人都已 "完成"，再次检查最终结果
                 scoreResultToReturn = this.calculateScoresBasedOnResult(finalOutcome.resultDescription || "打平 (所有玩家完成)"); // 如果没有特定结果，则打平
                 this.gameFinished = true; this.gameStarted = false;
                 console.log(`[GAME ${this.roomId}] 所有玩家均出完牌. 最终结果: ${scoreResultToReturn.result}`);
            }
        }

        if (gameOver) {
            return { success: true, gameOver: true, scoreResult: scoreResultToReturn, handInfo: this.lastValidHandInfo };
        } else if (player.finished) { // 玩家出完，但游戏未结束 (例如，还需等待其他人)
            this.nextTurn(true); // 强制轮转到下一家
            return { success: true, playerFinished: true, handInfo: this.lastValidHandInfo };
        } else { // 正常出牌，游戏继续
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
        if (!player.connected && !player.isAiControlled) return { success: false, message: "您已断线，无法操作。" };
        if (player.finished) return { success: false, message: "您已完成出牌，无需“过”。" };
        
        // 规则：首轮有方块4的不能Pass；新一轮开始者不能Pass；上一个出牌者再次轮到自己时不能Pass（除非所有人都Pass了）
        if (this.firstTurn && player.hand.some(card => card.suit === 'D' && card.rank === '4')) {
            return { success: false, message: "首轮持有方块4，必须出牌。" };
        }
        if (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) {
            return { success: false, message: "您是本轮首个出牌者或上一个出牌者，必须出牌。" };
        }

        console.log(`[GAME ${this.roomId}] 玩家 ${player.name} 选择 Pass.`);
        this.consecutivePasses++;
        this.possibleHints = []; this.currentHintIndexInternal = 0; // 重置提示

        const activePlayersStillInGame = this.players.filter(p => !p.finished && (p.connected || p.isAiControlled));
        const activePlayersCount = activePlayersStillInGame.length;

        if (activePlayersCount <= 1 && this.gameStarted && !this.gameFinished) { 
             console.warn(`[GAME ${this.roomId}] Pass 后只剩 ${activePlayersCount} 个活跃玩家. 游戏应已结束或即将结束.`);
             if (!this.gameFinished) {
                 this.endGame("活跃玩家不足或全部过牌导致游戏结束");
             }
             return { success: true }; // Pass 成功，但游戏也结束了
        }
        
        // 如果除了上一个出牌者之外的所有其他活跃玩家都Pass了，则轮回到上一个出牌者开始新一轮
        if (this.lastPlayerWhoPlayed && this.consecutivePasses >= activePlayersCount - 1 && activePlayersCount > 1) {
            console.log(`[GAME ${this.roomId}] 所有其他活跃玩家均 Pass. 新一轮将由 ${this.players.find(p=>p.id === this.lastPlayerWhoPlayed)?.name} 开始.`);
            const lastPlayerWhoActuallyPlayedId = this.lastPlayerWhoPlayed; // 保存ID，因为resetTurnState会清除它
            this.resetTurnState(); // 清空桌面，准备新一轮

            const lastActualPlayerIndex = this.players.findIndex(p => p.id === lastPlayerWhoActuallyPlayedId);
            const lastActualPlayer = this.players[lastActualPlayerIndex];

            if (lastActualPlayer && !lastActualPlayer.finished && (lastActualPlayer.connected || lastActualPlayer.isAiControlled)) {
                this.currentPlayerIndex = lastActualPlayerIndex;
                this.lastPlayerWhoPlayed = null; // 新一轮开始，所以他不能立即Pass
                this.consecutivePasses = 0;      // 重置连续Pass计数
                console.log(`[GAME ${this.roomId}] 新一轮开始，玩家: ${this.players[this.currentPlayerIndex]?.name}`);
            } else {
                 // 如果上一个出牌者也断线或完成了，则从他的位置开始找下一个能出牌的
                 this.currentPlayerIndex = lastActualPlayerIndex >= 0 ? lastActualPlayerIndex : 0; // 从他的位置开始
                 this.nextTurn(true); // 强制寻找下一个有效玩家
                 this.lastPlayerWhoPlayed = null; // 新找到的玩家开始新一轮
                 this.consecutivePasses = 0;
                 console.log(`[GAME ${this.roomId}] 上个出牌者 ${lastPlayerWhoActuallyPlayedId} 不可用. 寻找下一个玩家开始新一轮: ${this.players[this.currentPlayerIndex]?.name}`);
            }
        } else { // 否则，正常轮到下一个玩家
            this.nextTurn();
        }
        return { success: true };
    }

    resetTurnState() { // 当新一轮开始时调用
        this.centerPile = [];
        this.lastValidHandInfo = null;
        // this.consecutivePasses = 0; // Pass计数在 handlePass 中根据情况重置
        console.log(`[GAME ${this.roomId}] 桌面已清空，新一轮开始.`);
    }

    nextTurn(forceAdvanceDueToPlayerAction = false) { // forceAdvance 通常在玩家出完牌或断线时使用
         if (this.gameFinished && !forceAdvanceDueToPlayerAction) return; // 如果游戏已结束，且不是因为玩家行为强制推进，则不操作
         
         const numPlayers = this.players.length;
         if (numPlayers === 0) { this.currentPlayerIndex = -1; return; }

         // 检查是否只剩一个活跃玩家，如果是，则游戏结束
         const activePlayers = this.players.filter(p => (p.connected || p.isAiControlled) && !p.finished);
         if (activePlayers.length <= 1 && this.gameStarted && !this.gameFinished) {
            if (activePlayers.length === 1 && this.finishOrder.length === numPlayers - 1 ) {
                // 确保最后一个玩家被正确加入完成顺序
                if (!this.finishOrder.includes(activePlayers[0].id)) {
                    this.finishOrder.push(activePlayers[0].id);
                    activePlayers[0].finished = true;
                }
                console.log(`[GAME ${this.roomId}] NextTurn 检测到最后一个活跃玩家 ${activePlayers[0].name}. 计算最终得分.`);
                this.endGame("所有其他玩家均出完牌"); // 或者使用更具体的原因
                this.currentPlayerIndex = -1; // 没有下一个玩家了
                return;
            } else if (activePlayers.length < 2 && numPlayers > 1) { // 如果玩家数少于2（对于多人游戏）
                 console.log(`[GAME ${this.roomId}] NextTurn 检测到活跃玩家不足 (${activePlayers.length}). 提前结束游戏.`);
                 this.endGame("活跃玩家不足");
                 this.currentPlayerIndex = -1;
                 return;
            }
         }
         if (this.gameFinished) { // 再次检查，因为endGame可能在上面被调用
             this.currentPlayerIndex = -1;
             return;
         }

         let currentIdx = this.currentPlayerIndex;
         // 处理游戏开始时的第一次 تعیین回合 (如果 currentPlayerIndex 未被 startGame 设置)
         if(currentIdx === -1 && this.players.length > 0) {
             // 理论上 startGame 应该已经设置了 currentPlayerIndex 为持 D4 的玩家
             // 这里作为一种保险，如果未设置，则从0号玩家开始逆时针找第一个可行动的
             currentIdx = 0; // 从0号开始，然后逆时针推进，这样第一个被检查的会是最后一个玩家
             console.warn(`[GAME ${this.roomId}] nextTurn: currentPlayerIndex was -1. Attempting to find first valid player.`);
         }

         let nextIndex = currentIdx;
         let loopDetection = 0;
         const maxLoops = numPlayers * 3; // 增加循环检测的容错

         do {
              nextIndex = (nextIndex - 1 + numPlayers) % numPlayers; // 逆时针轮转
              loopDetection++;
              if (loopDetection > maxLoops) { // 防止无限循环
                   console.error(`[GAME ${this.roomId}] 检测到 NextTurn 中的潜在无限循环! 强制结束游戏.`);
                   this.endGame("回合推进错误导致游戏中断");
                   this.currentPlayerIndex = -1; // 设为无效状态
                   return;
              }
         } while ( // 持续寻找下一个玩家，直到找到一个：
              !this.players[nextIndex] ||                               // 玩家对象存在
              this.players[nextIndex].finished ||                       // 未出完牌
              (!this.players[nextIndex].connected && !this.players[nextIndex].isAiControlled) // 已连接或AI控制
         );

         this.currentPlayerIndex = nextIndex;
         const nextPlayer = this.players[this.currentPlayerIndex];
         console.log(`[GAME ${this.roomId}] 回合轮到玩家: ${nextPlayer?.name} (座位: ${nextPlayer?.slot})`);
         
         // 新回合开始，重置提示
         this.possibleHints = [];
         this.currentHintIndexInternal = 0;
    }

    findHint(playerId, clientProvidedHintIndex = 0) { // clientProvidedHintIndex 是客户端期望的下一个提示的索引
        if (!this.gameStarted || this.gameFinished) return { success: false, message: "游戏未开始或已结束。" };
        
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1 || playerIndex !== this.currentPlayerIndex) {
            return { success: false, message: "现在不是您的回合。" };
        }
        const player = this.players[playerIndex];
        if (!player || (!player.connected && !player.isAiControlled) || player.finished) {
            return { success: false, message: "无效的玩家状态，无法获取提示。" };
        }

        // 如果已有缓存提示，并且客户端请求的是下一个（或从头开始）
        if (this.possibleHints.length > 0 && this.possibleHints[0].forPlayerId === playerId) {
            // clientProvidedHintIndex 是客户端基于上一次服务器返回的 nextHintIndex 发来的
            // this.currentHintIndexInternal 是服务器端记录的当前应该给哪个提示 (通常是 clientProvidedHintIndex)
            this.currentHintIndexInternal = clientProvidedHintIndex % this.possibleHints.length;
            const hintToSend = this.possibleHints[this.currentHintIndexInternal];
            const nextIndexForClient = (this.currentHintIndexInternal + 1) % this.possibleHints.length;
            return { success: true, hint: hintToSend, nextHintIndex: nextIndexForClient };
        }

        // 重新计算提示
        this.possibleHints = [];
        const hand = [...player.hand]; // 使用副本进行操作
        this.sortHand(hand); // 确保手牌有序

        // 检查是否必须出牌 (新一轮开始，或首轮有D4)
        const mustPlay = (!this.lastValidHandInfo || this.lastPlayerWhoPlayed === playerId) || 
                         (this.firstTurn && player.hand.some(c=>c.rank==='4' && c.suit==='D'));

        // 生成单张提示
        for (const card of hand) {
            const validation = this.checkValidPlay([card], hand, this.lastValidHandInfo, this.firstTurn);
            if (validation.valid) {
                this.possibleHints.push({ cards: [card], type: HAND_TYPES.SINGLE, forPlayerId: playerId, handInfo: validation.handInfo });
            }
        }
        // 生成对子提示
        const ranksInHand = {}; 
        hand.forEach(c => ranksInHand[c.rank] = (ranksInHand[c.rank] || 0) + 1);
        for (const rank in ranksInHand) {
            if (ranksInHand[rank] >= 2) {
                const pairCards = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 2);
                const validation = this.checkValidPlay(pairCards, hand, this.lastValidHandInfo, this.firstTurn);
                if (validation.valid) {
                    this.possibleHints.push({ cards: pairCards, type: HAND_TYPES.PAIR, forPlayerId: playerId, handInfo: validation.handInfo });
                }
            }
        }
        // 生成三条提示
         for (const rank in ranksInHand) {
             if (ranksInHand[rank] >= 3) {
                 const threeCards = hand.filter(c => c.rank === rank).sort(compareSingleCards).slice(0, 3);
                 const validation = this.checkValidPlay(threeCards, hand, this.lastValidHandInfo, this.firstTurn);
                 if (validation.valid) {
                     this.possibleHints.push({ cards: threeCards, type: HAND_TYPES.THREE_OF_A_KIND, forPlayerId: playerId, handInfo: validation.handInfo });
                 }
             }
         }
        // TODO: 为更复杂的牌型 (顺子, 同花, 葫芦, 同花顺) 生成提示

        // 排序提示 (例如，优先出小牌，或优先出能打过的最小牌)
        // 当前排序：牌型等级低的优先，同牌型则按 compareHands (小的优先)
        this.possibleHints.sort((a, b) => {
             if (!a.handInfo || !b.handInfo) return 0; // 无效提示数据
             const typeRankDiff = HAND_TYPE_RANKING[a.handInfo.type] - HAND_TYPE_RANKING[b.handInfo.type];
             if (typeRankDiff !== 0) return typeRankDiff; // 不同牌型，按牌型等级
             return compareHands(a.handInfo, b.handInfo); // 同牌型，按牌力
        });

        if (this.possibleHints.length > 0) {
             this.currentHintIndexInternal = 0; // 从第一个提示开始
             const hintToSend = this.possibleHints[0];
             const nextIndexForClient = this.possibleHints.length > 1 ? 1 : 0; // 如果只有一个提示，下一个还是0
             return { success: true, hint: hintToSend, nextHintIndex: nextIndexForClient };
        } else {
             // 如果没有可出的牌
             return { success: false, message: mustPlay ? "没有符合规则的可出牌组合。" : "没有可打出的牌（可以过牌）。" };
        }
    }

    getHandInfo(cards) { // cards 数组
        if (!Array.isArray(cards) || cards.length === 0) return { isValid: false, message: "无效的牌组输入" };
        
        const n = cards.length;
        // 为了比较和代表性，我们通常需要一个排序版本
        // 对于比较 flush，需要高到低排序。对于其他，通常是按 RANK_VALUES, SUIT_VALUES 升序
        const sortedCardsForCompare = [...cards].sort((a, b) => compareSingleCards(b, a)); // 高到低，用于 Flush 比较
        const sortedCardsStandard = [...cards].sort(compareSingleCards); // 低到高，用于一般表示

        const suits = new Set(sortedCardsStandard.map(c => c.suit));
        const ranks = sortedCardsStandard.map(c => c.rank);
        const rankValues = sortedCardsStandard.map(c => RANK_VALUES[c.rank]); // 牌的数值

        const isFlush = suits.size === 1;
        
        let isStraight = false;
        let straightPrimaryRankValue = -1; // 顺子中最大牌的 RANK_VALUE
        let straightRepresentativeCard = null; // 顺子中最大的那张牌 (带花色)

        if (n === 5) {
            const uniqueNumericRanksSortedAsc = [...new Set(rankValues)].sort((a, b) => a - b);
            if (uniqueNumericRanksSortedAsc.length === 5) { // 必须是5张不同点数的牌
                let consecutive = true;
                for (let i = 0; i < 4; i++) {
                    if (uniqueNumericRanksSortedAsc[i+1] - uniqueNumericRanksSortedAsc[i] !== 1) {
                        consecutive = false; break;
                    }
                }
                // A2345 (A作为1) 这种特殊顺子不在此游戏规则中，因为3是最大的牌。
                // 最小顺子是 45678，最大顺子是 TJQKA (按 RANK_ORDER)。
                if (consecutive) {
                    isStraight = true;
                    straightPrimaryRankValue = uniqueNumericRanksSortedAsc[4]; // 顺子中最大牌的点数值
                    // 代表牌是顺子中最大的那张牌 (基于 compareSingleCards 排序后的最后一张)
                    straightRepresentativeCard = sortedCardsStandard[n-1]; 
                }
            }
        }

        const rankCounts = {}; 
        ranks.forEach(rank => { rankCounts[rank] = (rankCounts[rank] || 0) + 1; });
        const counts = Object.values(rankCounts).sort((a, b) => b - a); // 牌点出现次数的降序数组，例如 [3,2] for full house
        const distinctRanksSortedByValue = Object.keys(rankCounts).sort((rA, rB) => RANK_VALUES[rA] - RANK_VALUES[rB]);


        // --- 判断牌型，按优先级从高到低 ---
        if (n === 5 && isStraight && isFlush) {
            return { isValid: true, type: HAND_TYPES.STRAIGHT_FLUSH, cards: sortedCardsForCompare, 
                     primaryRankValue: straightPrimaryRankValue, 
                     representativeCard: straightRepresentativeCard, // 最大牌
                     suitValue: SUIT_VALUES[straightRepresentativeCard.suit] // 最大牌的花色值
                    };
        }
        // 四条炸弹 (如果允许) - 当前规则不允许
        // if (counts[0] === 4 && (n === 4 || (n === 5 && ALLOW_BOMB_WITH_KICKER))) { ... }


        if (n === 5 && counts[0] === 3 && counts.length >=2 && counts[1] === 2) { // 葫芦 (三带二)
            const threeRank = distinctRanksSortedByValue.find(rank => rankCounts[rank] === 3);
            // 葫芦的代表牌是三条中最大的那张 (按花色)
            const threeOfAKindCards = sortedCardsStandard.filter(c => c.rank === threeRank);
            const representativeCardForFullHouse = threeOfAKindCards[threeOfAKindCards.length - 1];
            return { isValid: true, type: HAND_TYPES.FULL_HOUSE, cards: sortedCardsStandard, 
                     primaryRankValue: RANK_VALUES[threeRank], // 三条的点数值
                     representativeCard: representativeCardForFullHouse 
                    };
        }
        if (n === 5 && isFlush) { // 同花 (非顺)
            return { isValid: true, type: HAND_TYPES.FLUSH, cards: sortedCardsForCompare, // 使用高到低排序的牌用于比较
                     primaryRankValue: RANK_VALUES[sortedCardsForCompare[0].rank], // 最高牌的点数
                     representativeCard: sortedCardsForCompare[0] // 最高牌
                    };
        }
        if (n === 5 && isStraight) { // 顺子 (非同花)
            return { isValid: true, type: HAND_TYPES.STRAIGHT, cards: sortedCardsStandard, 
                     primaryRankValue: straightPrimaryRankValue, // 最高牌的点数
                     representativeCard: straightRepresentativeCard // 最高牌
                    };
        }
        if (n === 3 && counts[0] === 3) { // 三条
            const threeRank = distinctRanksSortedByValue.find(rank => rankCounts[rank] === 3);
            return { isValid: true, type: HAND_TYPES.THREE_OF_A_KIND, cards: sortedCardsStandard, 
                     representativeCard: sortedCardsStandard[2], // 三张中最大的 (按花色)
                     primaryRankValue: RANK_VALUES[threeRank] // 点数值
                    };
        }
        if (n === 2 && counts[0] === 2) { // 对子
            const pairRank = distinctRanksSortedByValue.find(rank => rankCounts[rank] === 2);
            return { isValid: true, type: HAND_TYPES.PAIR, cards: sortedCardsStandard, 
                     representativeCard: sortedCardsStandard[1], // 两张中最大的 (按花色)
                     primaryRankValue: RANK_VALUES[pairRank] // 点数值
                    };
        }
        if (n === 1) { // 单张
            return { isValid: true, type: HAND_TYPES.SINGLE, cards: sortedCardsStandard, 
                     representativeCard: sortedCardsStandard[0], 
                     primaryRankValue: RANK_VALUES[sortedCardsStandard[0].rank] 
                    };
        }
        
        // 当前规则不允许四条作为普通牌型打出
        if (counts[0] === 4 && (n === 4 || n === 5) ) {
             if (n === 4) return { isValid: false, message: "不允许出四条（当前规则）。" };
             if (n === 5) return { isValid: false, message: "不允许四条带单张（非标准牌型）。" };
        }

        return { isValid: false, message: "无法识别的牌型或牌的数量不符合任何有效牌型。" };
     }

     checkValidPlay(cardsToPlay, currentHand, lastPlayedHandInfo, isFirstTurnFlag) {
         const newHandInfo = this.getHandInfo(cardsToPlay);
         if (!newHandInfo.isValid) return { valid: false, message: newHandInfo.message || "无效的牌型。" };

         if (isFirstTurnFlag) { // 第一轮出牌
             const hasD4 = cardsToPlay.some(c => c.suit === 'D' && c.rank === '4');
             if (!hasD4) return { valid: false, message: "第一回合出牌必须包含方块4。" };
             // 任何包含方块4的有效牌型都可以
             return { valid: true, handInfo: newHandInfo };
         } else { // 非第一轮
             if (!lastPlayedHandInfo) { // 如果桌上没牌 (新一轮开始)
                 // 任何有效牌型都可以出
                 return { valid: true, handInfo: newHandInfo };
             }
             // 桌上有牌，必须打出更大且同类型的牌
             if (newHandInfo.type !== lastPlayedHandInfo.type) {
                 // 未来如果加入炸弹，这里需要判断是否是炸弹压普通牌型
                 return { valid: false, message: `必须出与上家相同类型的牌 (${lastPlayedHandInfo.type})。` };
             }
             // 牌型相同，牌的数量也必须相同
             if (newHandInfo.cards.length !== lastPlayedHandInfo.cards.length) {
                return { valid: false, message: `相同牌型下，出牌数量必须与上家一致 (${lastPlayedHandInfo.cards.length}张)。`};
             }

             // 比较两手牌
             const comparison = compareHands(newHandInfo, lastPlayedHandInfo);
             if (comparison > 0) { // newHandInfo 比 lastPlayedHandInfo 大
                 return { valid: true, handInfo: newHandInfo };
             } else {
                 return { valid: false, message: `您打出的 ${newHandInfo.type} 必须大于上家打出的牌。` };
             }
         }
     }

    checkInstantGameOver() {
        const nFinished = this.finishOrder.length;
        const totalPlayers = this.players.length;

        // 针对两人局的特殊判断
        if (totalPlayers <= 2) {
            if (nFinished >= 1) { // 只要有一个人出完牌
                const winner = this.players.find(p => p.id === this.finishOrder[0]);
                if (!winner) return {isOver: false}; 
                
                if (this.gameMode === 'standard') { // 2人标准模式，一个是D一个是F
                    return {isOver: true, resultDescription: winner.role === 'D' ? "地主胜" : "农民胜"};
                } else if (this.gameMode === 'double_landlord') { // 2人理论上不会是DD模式，但以防万一
                    return {isOver: true, resultDescription: winner.role === 'DD' ? "双地主大胜" : "农民胜"};
                }
            }
            return {isOver: false}; // 两人局，还没人出完
        }

        // 3人及以上游戏的判断
        if (this.gameMode === 'standard' && nFinished < 2 && this.finishOrder.length < totalPlayers) return { isOver: false }; // 标准模式至少需要2人完成，除非所有人都完成了
        if (this.gameMode === 'double_landlord' && nFinished < 1 && this.finishOrder.length < totalPlayers) return { isOver: false }; // 双地主模式，地主先出完即大胜

        const finishRoles = this.finishOrder.map(playerId => this.playerRoles[playerId]);
        let resultDescription = null; let isOver = false;

        if (this.gameMode === 'standard') { 
            if (nFinished >= 2) { // 至少有2人出完
                if (finishRoles[0] === 'D' && finishRoles[1] === 'D') { resultDescription = "地主大胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'F') { resultDescription = "农民大胜"; isOver = true; }
            }
            if (!isOver && nFinished >= 3) { // 至少有3人出完
                if (finishRoles[0] === 'D' && finishRoles[1] === 'F' && finishRoles[2] === 'D') { resultDescription = "地主胜"; isOver = true; }
                else if (finishRoles[0] === 'F' && finishRoles[1] === 'D' && finishRoles[2] === 'F') { resultDescription = "农民胜"; isOver = true; }
            }
            // 四人局且所有人都出完牌后的特殊平局判断
            if (!isOver && nFinished === 4 && totalPlayers === 4) {
                const rolesStr = finishRoles.join('');
                if (rolesStr === 'DFFD' || rolesStr === 'FDDF') { resultDescription = "打平"; isOver = true; }
                // 如果不是这些平局，且前三名没有决定胜负，则根据最后一个出完的是谁来判断
                else if (finishRoles[0] === 'D' && finishRoles[3] === 'F') resultDescription = "地主胜"; isOver = true;
                else if (finishRoles[0] === 'F' && finishRoles[3] === 'D') resultDescription = "农民胜"; isOver = true;

            }
            // 3人局（或4人局第3个出完时），如果前2名非同伙，且第3名和第1名是同伙
             if(!isOver && nFinished === 3 ) {
                if( (finishRoles[0] === 'D' && finishRoles[2] === 'D' && finishRoles[1] === 'F') ||
                    (finishRoles[0] === 'F' && finishRoles[2] === 'F' && finishRoles[1] === 'D') ) {
                     resultDescription = finishRoles[0] === 'D' ? "地主胜" : "农民胜"; isOver = true;
                }
                 // 4人局，3人出完，最后一个人的角色决定是否平局
                if (totalPlayers === 4) {
                    const lastPlayerId = this.players.find(p => !this.finishOrder.includes(p.id))?.id;
                    if (lastPlayerId) {
                        const lastPlayerRole = this.playerRoles[lastPlayerId];
                        const currentOrderRoles = finishRoles.join('');
                        if (currentOrderRoles === 'DFF' && lastPlayerRole === 'D') { resultDescription = "打平"; isOver = true; }
                        else if (currentOrderRoles === 'FDD' && lastPlayerRole === 'F') { resultDescription = "打平"; isOver = true; }
                    }
                }
            }

        } else { // 双地主模式 ('double_landlord')
            if (finishRoles[0] === 'DD') { resultDescription = "双地主大胜"; isOver = true; }
            else if (nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'F') {
                resultDescription = "农民大胜"; isOver = true; // 三个农民先于双地主出完
            }
            // 次级胜负 (例如，一个农民先出完，然后双地主出完)
            else if (!isOver && nFinished >= 2 && finishRoles[0] === 'F' && finishRoles[1] === 'DD') {
                resultDescription = "双地主胜"; isOver = true;
            }
            // (例如，两个农民先出完，然后双地主出完)
            else if (!isOver && nFinished >= 3 && finishRoles[0] === 'F' && finishRoles[1] === 'F' && finishRoles[2] === 'DD') {
                resultDescription = "农民胜"; isOver = true;
            }
        }
        // 如果所有人都出完了，但没有触发以上特定胜负条件，则判定为打平
        if (!isOver && this.finishOrder.length === totalPlayers && !resultDescription) { 
            resultDescription = "打平 (所有玩家完成)"; isOver = true;
        }

        if (isOver && resultDescription) this.gameResultText = resultDescription; // 保存结果描述
        return { isOver, resultDescription };
     }

    calculateScoresBasedOnResult(resultDescriptionInput) {
         const currentScoreChanges = {}; // 本局分数变化
         let landlordScoreChange = 0;
         let farmerScoreChange = 0;
         let ddScoreChange = 0;
         
         let resultDescription = resultDescriptionInput;
         console.log(`[SCORE CALC ${this.roomId}] 开始计分，结果描述: "${resultDescription}"`);

         if (!resultDescription && this.finishOrder.length === this.players.length) { 
            resultDescription = "打平 (所有玩家完成)"; // 如果所有人都出完了但没有具体结果，则打平
         } else if (!resultDescription) {
            console.warn(`[SCORE CALC ${this.roomId}] 未提供结果描述. 默认为 '结果未定'.`);
            resultDescription = "结果未定"; // 避免后续 switch 出错
         }
         this.gameResultText = resultDescription; // 更新游戏最终结果文本

         if (this.gameMode === 'standard') {
             switch (resultDescription) {
                 case "打平": case "打平 (所有玩家完成)": landlordScoreChange = 0; farmerScoreChange = 0; break;
                 case "地主胜": landlordScoreChange = 1; farmerScoreChange = -1; break;
                 case "农民胜": landlordScoreChange = -1; farmerScoreChange = 1; break;
                 case "地主大胜": landlordScoreChange = 2; farmerScoreChange = -2; break;
                 case "农民大胜": landlordScoreChange = -2; farmerScoreChange = 2; break;
                 default: 
                    console.warn(`[SCORE CALC ${this.roomId}] 标准模式下未知结果: "${resultDescription}". 本局无分数变化.`);
                    landlordScoreChange = 0; farmerScoreChange = 0;
                    this.gameResultText = `打平 (原因: ${resultDescription} 未定义)`; // 修正结果文本
                    break;
             }
             this.players.forEach(p => { 
                currentScoreChanges[p.id] = (this.playerRoles[p.id] === 'D') ? landlordScoreChange : farmerScoreChange; 
            });
         } else if (this.gameMode === 'double_landlord') { 
             switch (resultDescription) {
                 case "打平": case "打平 (所有玩家完成)": ddScoreChange = 0; farmerScoreChange = 0; break;
                 case "双地主大胜": ddScoreChange = 6; farmerScoreChange = -2; break; // DD得6分，每个农民扣2分
                 case "双地主胜": ddScoreChange = 3; farmerScoreChange = -1; break;   // DD得3分，每个农民扣1分
                 case "农民胜": ddScoreChange = -3; farmerScoreChange = 1; break;    // DD扣3分，每个农民得1分
                 case "农民大胜": ddScoreChange = -6; farmerScoreChange = 2; break;  // DD扣6分，每个农民得2分
                 default: 
                    console.warn(`[SCORE CALC ${this.roomId}] 双地主模式下未知结果: "${resultDescription}". 本局无分数变化.`);
                    ddScoreChange = 0; farmerScoreChange = 0;
                    this.gameResultText = `打平 (原因: ${resultDescription} 未定义)`;
                    break;
             }
              this.players.forEach(p => { 
                currentScoreChanges[p.id] = (this.playerRoles[p.id] === 'DD') ? ddScoreChange : farmerScoreChange; 
            });
         } else {
            console.error(`[SCORE CALC ${this.roomId}] 未知的游戏模式: ${this.gameMode}. 无法计分.`);
            this.players.forEach(p => { currentScoreChanges[p.id] = 0; });
            this.gameResultText = "错误 (未知游戏模式)";
         }

         console.log(`[SCORE CALC ${this.roomId}] 最终游戏结果: ${this.gameResultText}`);
         // 更新玩家总分
         const currentFinalScoresData = this.players.map(p => {
             const change = currentScoreChanges[p.id] || 0;
             p.score += change; // 更新玩家对象中的累计分数
             console.log(`[SCORE CALC ${this.roomId}] 玩家 ${p.name} (${p.role}): ${change >= 0 ? '+' : ''}${change} -> 新总分: ${p.score}`);
             return { id: p.id, name: p.name, score: p.score, role: p.role };
         });
         
         this.scoreChanges = currentScoreChanges; // 保存本局分数变化
         this.finalScores = currentFinalScoresData; // 保存本局结束后的最终分数状态

          return {
              result: this.gameResultText,
              scoreChanges: this.scoreChanges,
              finalScores: this.finalScores,
              roomId: this.roomId // 方便 roomManager 知道是哪个房间的结果
          };
      }

    calculateScores() { // 在游戏结束时调用，以确保分数被计算
        // 确保所有玩家都在完成顺序中，以应对中途结束等情况
        if (this.finishOrder.length < this.players.length) {
            const finishedIds = new Set(this.finishOrder);
            const remainingPlayers = this.players.filter(p => !finishedIds.has(p.id));
            // 按特定规则（如剩余牌数少者靠前，断线者靠后）排序剩余玩家
            remainingPlayers.sort((a,b) => {
                if(a.connected !== b.connected) return a.connected ? -1 : 1; // 连接的优先
                return a.hand.length - b.hand.length || a.slot - b.slot; // 牌少的优先，然后按座位
            })
            .forEach(p => { if(!this.finishOrder.includes(p.id)) this.finishOrder.push(p.id); });
        }

        const instantResult = this.checkInstantGameOver(); // 尝试获取明确的胜负结果
        if (instantResult.isOver && instantResult.resultDescription) {
            return this.calculateScoresBasedOnResult(instantResult.resultDescription);
        }
        // 如果没有明确的速胜/速败，且游戏结束了（可能是因为endGame被调用），则默认为打平
        return this.calculateScoresBasedOnResult("打平 (游戏结束)"); 
    }

    endGame(reason = "游戏正常结束") { // reason 可以是 "有玩家离开", "服务器关闭" 等
          if (this.gameFinished) { // 防止重复调用
            // 返回已有的最终结果
            return { result: this.gameResultText, scoreChanges: this.scoreChanges, finalScores: this.finalScores, reason: this.gameOverReason, roomId: this.roomId };
          }
          this.gameFinished = true; 
          this.gameStarted = false; // 游戏不再进行中
          this.gameOverReason = reason; // 记录游戏结束的原因
          console.log(`[GAME ${this.roomId}] 游戏实例结束. 原因: ${reason}`);

          // 确保所有玩家都在完成顺序中 (应对中途结束等情况)
          if (this.finishOrder.length < this.players.length) {
               const finishedIds = new Set(this.finishOrder);
               const remainingPlayers = this.players.filter(p => !finishedIds.has(p.id)); 
               remainingPlayers.sort((a,b) => { // 例如，断线或牌多的排后面
                    if (a.connected !== b.connected) return a.connected ? -1 : 1; // 连接的优先
                    if (a.hand.length !== b.hand.length) return a.hand.length - b.hand.length; // 牌少的优先
                    return a.slot - b.slot; // 按座位
               });
               remainingPlayers.forEach(p => { if(!this.finishOrder.includes(p.id)) this.finishOrder.push(p.id); });
          }

          // 计算并保存最终分数
          const scoreResult = this.calculateScores(); // calculateScores 会调用 checkInstantGameOver 和 calculateScoresBasedOnResult
          this.gameResultText = scoreResult.result;  // 从计分结果中获取最终的游戏结果描述
          this.finalScores = scoreResult.finalScores;
          this.scoreChanges = scoreResult.scoreChanges;

          return { ...scoreResult, reason: this.gameOverReason, roomId: this.roomId }; 
     }

    createDeck() {
        // 使用 RANK_ORDER 和 SUIT_ORDER 来创建牌组，以确保与定义的常量一致
        this.deck = [];
        for (const suit of SUIT_ORDER) { 
            for (const rank of RANK_ORDER) { 
                this.deck.push({ suit, rank }); 
            } 
        }
        // 标准52张牌，如果您的RANK_ORDER定义了不同数量的牌，这里会反映出来
        // 例如，如果包含大小王，需要在RANK_ORDER中定义并在这里特殊处理。当前没有。
     }

    shuffleDeck() { // Fisher-Yates shuffle
         for (let i = this.deck.length - 1; i > 0; i--) {
            const j = crypto.randomInt(i + 1); // Node.js crypto.randomInt for better randomness
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]]; // Swap
        }
        // console.log(`[GAME ${this.roomId}] Deck shuffled. Total cards: ${this.deck.length}`);
     }

    dealCards(cardsPerPlayer) {
         // 玩家已按座位排序 (this.players.sort((a,b) => a.slot - b.slot);)
         // 发牌时按玩家座位顺序轮流发牌
         let playerDealOrder = [...this.players].sort((a,b) => a.slot - b.slot); // 确保按座位顺序
         const totalCardsToDeal = cardsPerPlayer * playerDealOrder.length;

         if (totalCardsToDeal > this.deck.length) {
             console.error(`[DEAL ERROR ${this.roomId}] 牌数不足 (${this.deck.length}) 无法发出 ${totalCardsToDeal} 张牌.`);
             this.endGame("发牌错误：牌数不足"); // 游戏无法进行
             return;
         }

         // 清空每个玩家的当前手牌
         for (const player of playerDealOrder) {
             player.hand = [];
         }

         // 轮流发牌
         for (let i = 0; i < cardsPerPlayer; i++) { // 第 i 轮发牌
             for (const player of playerDealOrder) { // 给每个玩家发一张
                 if (this.deck.length > 0) {
                     player.hand.push(this.deck.pop());
                 } else {
                     // 这不应该发生，因为前面已经检查过总牌数
                     console.error(`[DEAL ERROR ${this.roomId}] 发牌中途牌堆为空，这不符合预期！`);
                     this.endGame("发牌错误：中途缺牌");
                     return;
                 }
             }
         }
         // 为每个玩家的手牌排序
         this.players.forEach(player => this.sortHand(player.hand));
         // console.log(`[GAME ${this.roomId}] Cards dealt. Remaining in deck: ${this.deck.length}`);
     }

    sortHand(hand) { // 默认按 compareSingleCards 排序 (点数优先，花色次之)
        hand.sort(compareSingleCards);
    }

    getStateForPlayer(requestingPlayerId) {
        const isObserver = !this.players.some(p => p.id === requestingPlayerId);

        return {
            // 房间信息 (如果需要，但通常由 roomManager 的 getRoomStateForPlayer 包含)
            // roomId: this.roomId,
            // gameMode: this.gameMode,

            // 玩家列表及状态
            players: this.players.map(p => ({
                id: p.id, name: p.name, slot: p.slot, score: p.score,
                role: p.role, // 角色在游戏开始时已设置到 player 对象上
                finished: p.finished,
                connected: p.connected,
                isAiControlled: p.isAiControlled, // AI状态
                hand: (p.id === requestingPlayerId && !isObserver) ? p.hand : undefined, // 只给请求者自己的手牌
                handCount: p.hand.length,
            })),

            // 游戏桌面状态
            centerPile: [...this.centerPile], // 当前打出的牌
            lastHandInfo: this.lastValidHandInfo ? { 
                type: this.lastValidHandInfo.type, 
                cards: [...this.lastValidHandInfo.cards], // 确保是副本
                representativeCard: this.lastValidHandInfo.representativeCard ? {...this.lastValidHandInfo.representativeCard} : null
            } : null, // 上一手牌的信息

            // 回合及游戏进程信息
            currentPlayerId: this.gameFinished ? null : (this.currentPlayerIndex >=0 && this.players[this.currentPlayerIndex] ? this.players[this.currentPlayerIndex].id : null),
            isFirstTurn: this.firstTurn,
            gameStarted: this.gameStarted,
            gameFinished: this.gameFinished,
            winnerId: this.winnerId, // 第一个出完牌的玩家
            finishOrder: [...this.finishOrder], // 玩家完成顺序
            lastPlayerWhoPlayedId: this.lastPlayerWhoPlayed, // 上一个出牌的玩家

            // 游戏结果信息 (游戏结束后才有意义)
            gameResultText: this.gameResultText,     // 例如 "地主大胜"
            gameOverReason: this.gameOverReason,   // 例如 "有玩家离开"
            finalScores: this.finalScores ? this.finalScores.map(s => ({...s})) : null, // 各玩家最终分数
            scoreChanges: this.scoreChanges ? {...this.scoreChanges} : null // 各玩家本局分数变化
        };
    }
}

module.exports = { Game }; // 只导出 Game 类，常量可以在 Game 类内部访问或作为静态属性
