/*!
 * ai.js — 探索AI(minimax + alpha-beta、時間制限つき反復深化)
 *
 * In_a_Pinch_app_5.py の MinimaxAI / TemplateSpecialistAI をそのまま移植。
 * レベル1〜7(ランダム〜神)に加え、テンプレート特化AI「奥義」を実装する。
 * engine.js のあとに読み込むこと(クラシックスクリプト / importScripts 用)。
 *
 * 置換表の最大件数だけは、ブラウザ(特にモバイル)のメモリ事情に合わせて
 * Python版より小さく調整している(挙動・強さの設計思想は変えていない。
 * 上限に達したら丸ごとクリアする簡易対策も同じ)。
 */
(function (global) {
  "use strict";

  const H = global.Hasami || (typeof require !== "undefined" ? require("./engine.js") : null);
  const { DIRECTIONS, AXIS_PAIRS, otherPlayer } = H;

  const WIN_SCORE = 100000;
  const DRAW_SCORE = -50;
  const MAX_ACTIONS_PER_NODE = 20;

  // name, maxDepth, timeBudget(ms) / null, blunderRate, useTT, ttSize
  const LEVELS = {
    1: { id: 1, name: "ランダム", maxDepth: 0, timeBudget: null, blunderRate: 0, useTT: false, ttSize: 0 },
    2: { id: 2, name: "初級", maxDepth: 1, timeBudget: null, blunderRate: 0.35, useTT: false, ttSize: 0 },
    3: { id: 3, name: "中級", maxDepth: 2, timeBudget: 1000, blunderRate: 0.08, useTT: false, ttSize: 0 },
    4: { id: 4, name: "上級", maxDepth: 3, timeBudget: 2000, blunderRate: 0, useTT: false, ttSize: 0 },
    5: { id: 5, name: "最強", maxDepth: 5, timeBudget: 3500, blunderRate: 0, useTT: false, ttSize: 0 },
    6: { id: 6, name: "究極", maxDepth: 8, timeBudget: 15000, blunderRate: 0, useTT: true, ttSize: 150000 },
    7: { id: 7, name: "神", maxDepth: 12, timeBudget: 30000, blunderRate: 0, useTT: true, ttSize: 250000 },
  };

  const SPECIALIST_AI_NAME = "奥義";
  const SPECIALIST_AI_DESC = "このテンプレート専用に評価関数を調整した最上位AI。"
    + "汎用最上位『神』と互角以上・『最強』以下には明確に勝ち越し(1手最大30秒)";

  const TTFlag = { EXACT: 0, LOWER: 1, UPPER: 2 };

  class TranspositionTable {
    constructor(maxEntries) {
      this.maxEntries = maxEntries;
      this.table = new Map();
    }
    lookup(key, depth, alpha, beta) {
      const entry = this.table.get(key);
      if (!entry) return [null, null];
      const [storedDepth, value, flag, bestAction] = entry;
      if (storedDepth >= depth) {
        if (flag === TTFlag.EXACT) return [value, bestAction];
        if (flag === TTFlag.LOWER && value >= beta) return [value, bestAction];
        if (flag === TTFlag.UPPER && value <= alpha) return [value, bestAction];
      }
      return [null, bestAction];
    }
    store(key, depth, value, flag, bestAction) {
      if (this.table.size >= this.maxEntries) this.table.clear();
      this.table.set(key, [depth, value, flag, bestAction]);
    }
  }

  // Action: ["place", [r,c]] または ["move", pieceId, [r,c]]
  function generateActions(engine, player) {
    const actions = [];
    if (engine.obligated[player].length) {
      for (const pid of engine.obligated[player]) {
        for (const dest of engine.legalMoves(pid)) actions.push(["move", pid, dest]);
      }
    } else {
      for (const pos of engine.legalPlacements(player)) actions.push(["place", pos]);
      for (const pid of engine.movablePieces(player)) {
        for (const dest of engine.legalMoves(pid)) actions.push(["move", pid, dest]);
      }
    }
    return actions;
  }

  function applyAction(engine, player, action) {
    if (action[0] === "place") return engine.placePiece(player, action[1]);
    return engine.movePiece(player, action[1], action[2]);
  }

  function actionTarget(action) {
    return action[0] === "place" ? action[1] : action[2];
  }

  function actionEquals(a, b) {
    if (!a || !b || a[0] !== b[0]) return false;
    if (a[0] === "place") return a[1][0] === b[1][0] && a[1][1] === b[1][1];
    return a[1] === b[1] && a[2][0] === b[2][0] && a[2][1] === b[2][1];
  }

  function quickScore(engine, player, action) {
    const [r, c] = actionTarget(action);
    const opponent = otherPlayer(player);
    let score = 0;
    for (const [dr, dc] of DIRECTIONS) {
      const mid = [r + dr, c + dc];
      const midPiece = engine.inBounds(mid) ? engine.pieceAt(mid) : null;
      if (midPiece && midPiece.player === opponent) {
        const far = [r + 2 * dr, c + 2 * dc];
        if (engine._flank(far, player)) score += 50;
      }
    }
    const cx = (engine.config.rows - 1) / 2;
    const cy = (engine.config.cols - 1) / 2;
    score -= (Math.abs(r - cx) + Math.abs(c - cy)) * 0.1;
    return score;
  }

  function orderedActions(engine, player, actions, cap, pvAction) {
    const scored = actions.slice().sort((a, b) => quickScore(engine, player, b) - quickScore(engine, player, a));
    let out = scored;
    if (pvAction && actions.some((a) => actionEquals(a, pvAction))) {
      out = [pvAction, ...scored.filter((a) => !actionEquals(a, pvAction))];
    }
    if (out.length > cap) out = out.slice(0, cap);
    return out;
  }

  class SearchTimeout extends Error {}

  class RNG {
    // 決定的な擬似乱数(mulberry32)。同じ seed なら同じ手順を再現できる。
    constructor(seed) {
      this.state = (seed >>> 0) || 1;
    }
    next() {
      let t = (this.state += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    choice(arr) {
      return arr[Math.floor(this.next() * arr.length)];
    }
  }

  class MinimaxAI {
    constructor(player, level, seed) {
      this.player = player;
      this.level = LEVELS[level];
      this.rng = new RNG(seed == null ? Date.now() & 0xffffffff : seed);
      this.nodesVisited = 0;
      this._deadline = null;
      this.tt = this.level.useTT ? new TranspositionTable(this.level.ttSize) : null;
      // 強制手(移動義務のある駒しか動かせない)延長探索のフック。既定は無効
      // (自己対戦で上位レベル相手に逆効果だったため、現状どのAIも使わない)。
      this.forcedExtension = false;
    }

    chooseAction(engine) {
      const actions = generateActions(engine, this.player);
      if (!actions.length) return null;
      if (this.level.maxDepth === 0) return this.rng.choice(actions);
      if (this.level.blunderRate > 0 && this.rng.next() < this.level.blunderRate) {
        return this.rng.choice(actions);
      }

      this.nodesVisited = 0;
      let bestAction = null;

      if (this.level.timeBudget == null) {
        [bestAction] = this._searchRoot(engine, actions, this.level.maxDepth, null);
        return bestAction;
      }

      const overallDeadline = Date.now() + this.level.timeBudget;
      let depth = 1;
      let pvAction = null;
      while (depth <= this.level.maxDepth) {
        this._deadline = overallDeadline;
        try {
          const [action] = this._searchRoot(engine, actions, depth, pvAction);
          bestAction = action;
          if (this.level.useTT) pvAction = action;
        } catch (e) {
          if (e instanceof SearchTimeout) break;
          throw e;
        }
        if (Date.now() >= overallDeadline) break;
        depth += 1;
      }
      return bestAction;
    }

    _actionCap(engine) {
      if (!this.level.useTT) return MAX_ACTIONS_PER_NODE;
      const area = engine.config.rows * engine.config.cols;
      return Math.max(MAX_ACTIONS_PER_NODE, Math.min(48, MAX_ACTIONS_PER_NODE + Math.floor(area / 6)));
    }

    _searchRoot(engine, actions, depth, pvAction) {
      let bestScore = -Infinity;
      let bestActions = [];
      const cap = this._actionCap(engine);
      const ordered = orderedActions(engine, this.player, actions, cap, pvAction);
      for (const action of ordered) {
        const child = engine.clone();
        applyAction(child, this.player, action);
        const score = this._minimax(child, depth - 1, -Infinity, Infinity, 6);
        if (score > bestScore) {
          bestScore = score;
          bestActions = [action];
        } else if (score === bestScore) {
          bestActions.push(action);
        }
      }
      return [this.rng.choice(bestActions), bestScore];
    }

    _minimax(engine, depth, alpha, beta, ext) {
      this.nodesVisited += 1;
      if (this._deadline != null && this.nodesVisited % 200 === 0 && Date.now() > this._deadline) {
        throw new SearchTimeout();
      }
      const opponent = otherPlayer(this.player);

      if (engine.winner === this.player) return WIN_SCORE + depth;
      if (engine.winner === opponent) return -WIN_SCORE - depth;
      if (engine.isDraw) return DRAW_SCORE;
      if (depth <= 0) return this._evaluate(engine);

      let ttKey = null;
      let pvAction = null;
      if (this.tt) {
        ttKey = engine._stateKey();
        const [cached, pv] = this.tt.lookup(ttKey, depth, alpha, beta);
        pvAction = pv;
        if (cached != null) return cached;
      }

      const current = engine.currentPlayer;
      let actions = generateActions(engine, current);
      if (!actions.length) return this._evaluate(engine);
      const cap = this._actionCap(engine);
      actions = orderedActions(engine, current, actions, cap, pvAction);

      const originalAlpha = alpha;
      const originalBeta = beta;
      let bestActionHere = null;
      const maximizing = current === this.player;
      let value;
      if (maximizing) {
        value = -Infinity;
        for (const action of actions) {
          const child = engine.clone();
          applyAction(child, current, action);
          const [nd, ne] = this._childSearchDepth(child, depth, ext);
          const score = this._minimax(child, nd, alpha, beta, ne);
          if (score > value) { value = score; bestActionHere = action; }
          alpha = Math.max(alpha, value);
          if (alpha >= beta) break;
        }
      } else {
        value = Infinity;
        for (const action of actions) {
          const child = engine.clone();
          applyAction(child, current, action);
          const [nd, ne] = this._childSearchDepth(child, depth, ext);
          const score = this._minimax(child, nd, alpha, beta, ne);
          if (score < value) { value = score; bestActionHere = action; }
          beta = Math.min(beta, value);
          if (alpha >= beta) break;
        }
      }

      if (this.tt && ttKey != null) {
        let flag;
        if (value <= originalAlpha) flag = TTFlag.UPPER;
        else if (value >= originalBeta) flag = TTFlag.LOWER;
        else flag = TTFlag.EXACT;
        this.tt.store(ttKey, depth, value, flag, bestActionHere);
      }
      return value;
    }

    _childSearchDepth(child, depth, ext) {
      if (this.forcedExtension && ext > 0 && depth <= 3
        && child.winner == null && !child.isDraw
        && child.obligated[child.currentPlayer].length) {
        return [depth, ext - 1];
      }
      return [depth - 1, ext];
    }

    _wallExposure(engine, pos) {
      if (!engine.config.wallSandwich) return 0;
      let exposure = 0;
      for (const [[dr1, dc1], [dr2, dc2]] of AXIS_PAIRS) {
        const n1Wall = !engine.inBounds([pos[0] + dr1, pos[1] + dc1]);
        const n2Wall = !engine.inBounds([pos[0] + dr2, pos[1] + dc2]);
        if (n1Wall !== n2Wall) exposure += 1;
      }
      return exposure;
    }

    _clusterPressure(engine, player) {
      const limit = engine.config.contactLimit;
      if (limit == null) return 0;
      const visited = new Set();
      let pressure = 0;
      for (const piece of engine.pieces.values()) {
        const key = piece.position[0] + "," + piece.position[1];
        if (piece.player !== player || visited.has(key)) continue;
        const group = new Set([key]);
        const stack = [piece.position];
        while (stack.length) {
          const cur = stack.pop();
          for (const [dr, dc] of DIRECTIONS) {
            const nxt = [cur[0] + dr, cur[1] + dc];
            const nk = nxt[0] + "," + nxt[1];
            if (group.has(nk) || !engine.inBounds(nxt)) continue;
            const np = engine.pieceAt(nxt);
            if (np && np.player === player) { group.add(nk); stack.push(nxt); }
          }
        }
        for (const k of group) visited.add(k);
        pressure += (group.size / limit) ** 2;
      }
      return pressure;
    }

    _evaluate(engine) {
      const opponent = otherPlayer(this.player);
      const myMobility = engine.movablePieces(this.player).length;
      const oppMobility = engine.movablePieces(opponent).length;
      const myObligated = engine.obligated[this.player].length;
      const oppObligated = engine.obligated[opponent].length;
      const myStock = engine.stock[this.player];
      const oppStock = engine.stock[opponent];
      let myPieces = 0, oppPieces = 0;
      let myWall = 0, oppWall = 0;
      for (const p of engine.pieces.values()) {
        if (p.player === this.player) { myPieces++; myWall += this._wallExposure(engine, p.position); }
        else { oppPieces++; oppWall += this._wallExposure(engine, p.position); }
      }
      const myCluster = this._clusterPressure(engine, this.player);
      const oppCluster = this._clusterPressure(engine, opponent);

      let score = 0;
      score += (myMobility - oppMobility) * 3;
      score += (oppObligated - myObligated) * 25;
      score += (oppWall - myWall) * 4;
      score += (oppCluster - myCluster) * 6;
      score += (myStock - oppStock) * 1;
      score += (myPieces - oppPieces) * 0.5;
      return score;
    }
  }

  // ---- テンプレート特化AI「奥義」------------------------------------------
  // 「盤7x7・持ち駒15・接触制限3・移動範囲3・壁挟みあり」専用。詳細な設計意図は
  // In_a_Pinch_app_5.py の同名クラスのコメント、およびタイトル画面の「戦術レポート」参照。

  const SPECIALIST_WEIGHTS = { obl_danger: 4.0 };

  class TemplateSpecialistAI extends MinimaxAI {
    constructor(player, seed, timeBudget) {
      super(player, 7, seed); // level=7 のオブジェクトを土台にしてから上書きする
      this.level = {
        id: "specialist", name: SPECIALIST_AI_NAME, maxDepth: 10,
        timeBudget: timeBudget == null ? 29000 : timeBudget,
        blunderRate: 0, useTT: true, ttSize: 300000,
      };
      this.tt = new TranspositionTable(this.level.ttSize);
      this.forcedExtension = false;
      this.weights = Object.assign({}, SPECIALIST_WEIGHTS);
    }

    _evaluate(engine) {
      let score = super._evaluate(engine);
      const me = this.player;
      const opp = otherPlayer(me);
      const myObl = engine.obligated[me];
      const oppObl = engine.obligated[opp];
      if (myObl.length || oppObl.length) {
        const pressure = (obl) => {
          let s = 0;
          for (const pid of obl) s += Math.max(0, 4 - engine.legalMoves(pid).length);
          return s;
        };
        score += (pressure(oppObl) - pressure(myObl)) * this.weights.obl_danger;
      }
      return score;
    }
  }

  // ---- 詰めピンチ用の厳密な強制勝ち証明(AND/OR探索) --------------------
  // ヒューリスティックな評価に頼らず、実際の勝敗判定(engine.winner)だけを
  // 根拠にする。solver 側の手番は「どれか1つで勝ちを証明できればよい」(OR)、
  // 相手側の手番は「合法手すべてに対して勝ちを証明できなければならない」(AND)。
  // maxDepth 手先までで証明できない場合は forced:false を返す
  // (「強制勝ちではない」ではなく「この深さでは証明できなかった」という意味)。
  function proveForcedWin(engine, solver, maxDepth, cache) {
    cache = cache || new Map();
    const stateKey = engine._stateKey() + "|" + maxDepth;
    if (cache.has(stateKey)) return cache.get(stateKey);
    if (engine.winner === solver) { const r = { forced: true, plies: 0 }; cache.set(stateKey, r); return r; }
    const opponent = engine.winner ? null : (solver === "A" ? "B" : "A");
    if (engine.winner === opponent || engine.isDraw) { const r = { forced: false, plies: null }; cache.set(stateKey, r); return r; }
    if (maxDepth <= 0) { const r = { forced: false, plies: null }; cache.set(stateKey, r); return r; }
    const current = engine.currentPlayer;
    const actions = generateActions(engine, current);
    if (!actions.length) { const r = { forced: false, plies: null }; cache.set(stateKey, r); return r; }
    if (current === solver) {
      let best = null;
      for (const action of actions) {
        const child = engine.clone();
        applyAction(child, current, action);
        const r = proveForcedWin(child, solver, maxDepth - 1, cache);
        if (r.forced && (best === null || r.plies + 1 < best.plies)) {
          best = { forced: true, plies: r.plies + 1, move: action };
          if (best.plies <= 1) break;
        }
      }
      const r = best || { forced: false, plies: null };
      cache.set(stateKey, r);
      return r;
    }
    let worst = 0;
    for (const action of actions) {
      const child = engine.clone();
      applyAction(child, current, action);
      const r = proveForcedWin(child, solver, maxDepth - 1, cache);
      if (!r.forced) { const out = { forced: false, plies: null }; cache.set(stateKey, out); return out; }
      if (r.plies > worst) worst = r.plies;
    }
    const r = { forced: true, plies: worst + 1 };
    cache.set(stateKey, r);
    return r;
  }

  // 詰めピンチのヒント用: 現在の局面で solver がすぐ指すべき最善手を1つ返す
  // (maxDepth 以内に証明できる中で最短の勝ち筋)。証明できなければ null。
  function solveTsumePinchHint(engine, solver, maxDepth) {
    const cache = new Map();
    const actions = generateActions(engine, solver);
    let best = null;
    for (const action of actions) {
      const child = engine.clone();
      applyAction(child, solver, action);
      const r = proveForcedWin(child, solver, maxDepth - 1, cache);
      if (r.forced && (best === null || r.plies + 1 < best.plies)) {
        best = { move: action, plies: r.plies + 1 };
      }
    }
    return best;
  }

  const AI = {
    LEVELS, SPECIALIST_AI_NAME, SPECIALIST_AI_DESC,
    generateActions, applyAction, actionEquals,
    MinimaxAI, TemplateSpecialistAI, TranspositionTable, SearchTimeout,
    proveForcedWin, solveTsumePinchHint,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = AI;
  } else {
    global.HasamiAI = AI;
  }
})(typeof self !== "undefined" ? self : this);
