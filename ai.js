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
    // 『最強』と同じ探索で、思考時間だけを2秒にした段階(後から追加したので id は 8。
    // 既存の id 1〜7 は対戦記録やテストが参照しているため振り直さない)。
    8: { id: 8, name: "達人", maxDepth: 5, timeBudget: 2000, blunderRate: 0, useTT: false, ttSize: 0 },
  };
  // 画面の選択肢に並べる順(弱い順)。達人は上級と最強の間に入る。
  const LEVEL_ORDER = [1, 2, 3, 4, 8, 5, 6, 7];

  const SPECIALIST_AI_NAME = "奥義";
  const SPECIALIST_AI_DESC = "このテンプレートの自己対戦から、評価関数と駒のまわりの形(局所パターン)の"
    + "点数を学習した最上位AI。高速探索で深く読む(1手最大30秒)";

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

  // ---- 学習型探索AI(究極・神・奥義)----------------------------------------
  // In_a_Pinch_app_5.py「2.6 学習型探索AI」の移植。設計の詳細はそちらのコメント参照。
  //   (1) 高速探索エンジン FastState: 1次元配列の盤 + 指す/戻す(make/unmake)+ Zobrist ハッシュ
  //   (2) negamax + alpha-beta + PVS + 置換表 + キラー手/ヒストリー + LMR。候補手の機械的な
  //       切り捨ては行わず、反復深化の途中打ち切り分も活用する
  //   (3) 評価関数 = 特徴量の線形和。重みは自己対戦の勝敗からロジスティック回帰で学習したもの
  //       (Python 版の LEARNED_WEIGHTS_* と同じ値)
  // 盤外のマスは添字 N(番兵)で表す。

  const CELL_WALL = 3; // 壁挟みあり: 盤外は両者にとって挟みの端
  const CELL_OFF = 4;  // 壁挟みなし: 盤外はただの行き止まり

  function hash32(x) {
    let z = (x + 0x9E3779B9) | 0;
    z = Math.imul(z ^ (z >>> 16), 0x85EBCA6B);
    z = Math.imul(z ^ (z >>> 13), 0xC2B2AE35);
    return (z ^ (z >>> 16)) >>> 0;
  }

  const GEOMETRY_CACHE = new Map();

  function geometryOf(config) {
    const key = [config.rows, config.cols, config.moveRange, !!config.wallSandwich, config.contactLimit].join("/");
    let g = GEOMETRY_CACHE.get(key);
    if (!g) {
      g = buildGeometry(config.rows, config.cols, config.moveRange, !!config.wallSandwich,
        config.contactLimit == null ? null : config.contactLimit);
      GEOMETRY_CACHE.set(key, g);
    }
    return g;
  }

  function buildGeometry(rows, cols, moveRange, wall, limit) {
    const N = rows * cols;
    const idx = (r, c) => (r >= 0 && r < rows && c >= 0 && c < cols ? r * cols + c : N);
    const nbr = [], nbr2 = [], rays = [], wexp = [], centr = [];
    const cr = (rows - 1) / 2, cc = (cols - 1) / 2;
    const span = Math.max(1, cr + cc);
    for (let i = 0; i < N; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      nbr.push(DIRECTIONS.map(([dr, dc]) => idx(r + dr, c + dc)));
      nbr2.push(DIRECTIONS.map(([dr, dc]) => idx(r + 2 * dr, c + 2 * dc)));
      const perDir = [];
      for (const [dr, dc] of DIRECTIONS) {
        let steps;
        if (dr === 0 && (r === 0 || r === rows - 1)) steps = cols;
        else if (dc === 0 && (c === 0 || c === cols - 1)) steps = rows;
        else steps = moveRange;
        const ray = [];
        for (let k = 1; k <= steps; k++) {
          const j = idx(r + dr * k, c + dc * k);
          if (j === N) break;
          ray.push(j);
        }
        perDir.push(ray);
      }
      rays.push(perDir);
      let e = 0;
      if (wall) {
        if ((nbr[i][0] === N) !== (nbr[i][1] === N)) e++;
        if ((nbr[i][2] === N) !== (nbr[i][3] === N)) e++;
      }
      wexp.push(e);
      centr.push(1 - (Math.abs(r - cr) + Math.abs(c - cc)) / span);
    }
    const zLo = [null, [], []], zHi = [null, [], []];
    for (let i = 0; i < N; i++) {
      zLo[1].push(hash32(0x1000 + i)); zHi[1].push(hash32(0x51000 + i) & 0x1FFFFF);
      zLo[2].push(hash32(0x8000 + i)); zHi[2].push(hash32(0x58000 + i) & 0x1FFFFF);
    }
    return {
      rows, cols, N, limit, sentinel: wall ? CELL_WALL : CELL_OFF,
      nbr, nbr2, rays, wexp, centr, zLo, zHi,
      sideLo: hash32(0x7777), sideHi: hash32(0x57777) & 0x1FFFFF,
    };
  }

  // 移動義務(駒ID単位)の乱数。義務は重複しうる多重集合なので加算で合成する。
  function oblLo(p, pid) { return hash32(0x51ED0000 + pid * 2 + p); }
  function oblHi(p, pid) { return hash32(0x3ED00000 + pid * 2 + p) & 0x1FFFFF; }

  class FastState {
    constructor(engine) {
      const g = this.g = geometryOf(engine.config);
      const N = g.N, cols = g.cols;
      this.owner = new Int8Array(N + 1);
      this.owner[N] = g.sentinel;
      this.pidat = new Int32Array(N + 1);
      this.pos = new Map();
      this.plist = [null, [], []];
      let lo = 0, hi = 0;
      const ids = Array.from(engine.pieces.keys()).sort((a, b) => a - b);
      for (const pid of ids) {
        const piece = engine.pieces.get(pid);
        const p = piece.player === "A" ? 1 : 2;
        const i = piece.position[0] * cols + piece.position[1];
        this.owner[i] = p; this.pidat[i] = pid; this.pos.set(pid, i);
        this.plist[p].push(pid);
        lo ^= g.zLo[p][i]; hi ^= g.zHi[p][i];
      }
      this.side = engine.currentPlayer === "A" ? 1 : 2;
      if (this.side === 2) { lo ^= g.sideLo; hi ^= g.sideHi; }
      this.stock = [0, engine.stock.A, engine.stock.B];
      this.obl = [null, engine.obligated.A.slice(), engine.obligated.B.slice()];
      let olo = 0, ohi = 0;
      for (const p of [1, 2]) {
        for (const pid of this.obl[p]) { olo = (olo + oblLo(p, pid)) >>> 0; ohi = (ohi + oblHi(p, pid)) & 0x1FFFFF; }
      }
      this.hbLo = lo >>> 0; this.hbHi = hi; this.hoLo = olo; this.hoHi = ohi;
      this.nextPid = engine._nextPieceId;
      this.replimit = engine.config.repetitionLimit;
      this.rep = new Map();
      for (const [k, cnt] of engine._stateHistory) {
        const h = this._hashOfStateKey(k);
        this.rep.set(h, (this.rep.get(h) || 0) + cnt);
      }
      this.undo = [];
    }

    _hashOfStateKey(key) {
      const g = this.g;
      const [boardPart, cur, oa, ob] = key.split("#");
      let lo = 0, hi = 0;
      if (boardPart) {
        for (const ent of boardPart.split("|")) {
          const [rc, pv] = ent.split(":");
          const [r, c] = rc.split(",").map(Number);
          const p = pv === "A" ? 1 : 2;
          lo ^= g.zLo[p][r * g.cols + c]; hi ^= g.zHi[p][r * g.cols + c];
        }
      }
      if (cur === "B") { lo ^= g.sideLo; hi ^= g.sideHi; }
      let olo = 0, ohi = 0;
      [[1, oa], [2, ob]].forEach(([p, s]) => {
        if (!s) return;
        for (const x of s.split(",")) {
          const pid = Number(x);
          olo = (olo + oblLo(p, pid)) >>> 0; ohi = (ohi + oblHi(p, pid)) & 0x1FFFFF;
        }
      });
      return (hi ^ ohi) * 4294967296 + ((lo ^ olo) >>> 0);
    }

    key() {
      return (this.hbHi ^ this.hoHi) * 4294967296 + ((this.hbLo ^ this.hoLo) >>> 0);
    }

    // 連結グループ(接触制限)。gid: マス→グループ番号、adj: p の駒に接するマスの印
    groups(p) {
      const g = this.g, owner = this.owner, nbr = g.nbr;
      const gid = new Int32Array(g.N + 1).fill(-1);
      const adj = new Uint8Array(g.N + 1);
      const sizes = [];
      for (const pid of this.plist[p]) {
        const s = this.pos.get(pid);
        const nb = nbr[s];
        adj[nb[0]] = 1; adj[nb[1]] = 1; adj[nb[2]] = 1; adj[nb[3]] = 1;
        if (gid[s] >= 0) continue;
        const k = sizes.length;
        gid[s] = k;
        const stack = [s];
        let n = 1;
        while (stack.length) {
          const cur = stack.pop();
          for (const x of nbr[cur]) {
            if (owner[x] === p && gid[x] < 0) { gid[x] = k; n++; stack.push(x); }
          }
        }
        sizes.push(n);
      }
      return { gid, sizes, adj };
    }

    _boundedGroup(t, p, exclude, limit) {
      const owner = this.owner, nbr = this.g.nbr;
      const seen = new Set([t]);
      const stack = [t];
      while (stack.length) {
        const cur = stack.pop();
        for (const x of nbr[cur]) {
          if (owner[x] === p && x !== exclude && !seen.has(x)) {
            seen.add(x);
            if (seen.size > limit) return seen.size;
            stack.push(x);
          }
        }
      }
      return seen.size;
    }

    pieceMoves(s, p, G) {
      const owner = this.owner, g = this.g, limit = g.limit;
      const res = [];
      const rays = g.rays[s];
      if (limit == null) {
        for (let d = 0; d < 4; d++) {
          const ray = rays[d];
          for (let k = 0; k < ray.length; k++) {
            const t = ray[k];
            if (owner[t]) break;
            res.push(t);
          }
        }
        return res;
      }
      const { gid, sizes, adj } = G;
      const nbr = g.nbr;
      const gs = gid[s], gsSize = sizes[gs];
      for (let d = 0; d < 4; d++) {
        const ray = rays[d];
        for (let k = 0; k < ray.length; k++) {
          const t = ray[k];
          if (owner[t]) break;
          if (!adj[t]) { res.push(t); continue; }
          let tot = 1, exact = false;
          const seen = [];
          for (const x of nbr[t]) {
            if (x !== s && owner[x] === p) {
              const q = gid[x];
              if (seen.includes(q)) continue;
              if (q === gs) {
                if (gsSize >= 3) { exact = true; break; } // 抜けると分断されうるので厳密に数える
                tot += gsSize - 1;
              } else {
                tot += sizes[q];
              }
              seen.push(q);
            }
          }
          if (exact) {
            if (this._boundedGroup(t, p, s, limit) <= limit) res.push(t);
          } else if (tot <= limit) {
            res.push(t);
          }
        }
      }
      return res;
    }

    placements(p, G, firstOnly) {
      const g = this.g, owner = this.owner, nbr = g.nbr, nbr2 = g.nbr2;
      const q = 3 - p, W = CELL_WALL, limit = g.limit;
      const res = [];
      for (let t = 0; t < g.N; t++) {
        if (owner[t]) continue;
        const nb = nbr[t];
        const o0 = owner[nb[0]], o1 = owner[nb[1]], o2 = owner[nb[2]], o3 = owner[nb[3]];
        // (b) 置いたマスがすでに「相手の駒/壁」に挟まれている
        if ((o0 === q || o0 === W) && (o1 === q || o1 === W) && !(o0 === W && o1 === W)) continue;
        if ((o2 === q || o2 === W) && (o3 === q || o3 === W) && !(o2 === W && o3 === W)) continue;
        // (a) 置いた駒で相手を挟んでしまう
        const f = nbr2[t];
        let bad = false;
        const os = [o0, o1, o2, o3];
        for (let d = 0; d < 4; d++) {
          if (os[d] === q) {
            const x = owner[f[d]];
            if (x === p || x === W) { bad = true; break; }
          }
        }
        if (bad) continue;
        if (limit != null && G.adj[t]) {
          let tot = 1;
          const seen = [];
          for (let d = 0; d < 4; d++) {
            if (os[d] === p) {
              const k = G.gid[nb[d]];
              if (!seen.includes(k)) { seen.push(k); tot += G.sizes[k]; }
            }
          }
          if (tot > limit) continue;
        }
        res.push(t);
        if (firstOnly) return res;
      }
      return res;
    }

    // 合法手を整数コードで返す。配置 = 着地点 t、移動 = (元のマス+1)*N + t
    generate(p) {
      const N = this.g.N;
      const G = this.g.limit != null ? this.groups(p) : null;
      const acts = [];
      const obl = this.obl[p];
      if (obl.length) {
        for (const pid of new Set(obl)) {
          const s = this.pos.get(pid), base = (s + 1) * N;
          for (const t of this.pieceMoves(s, p, G)) acts.push(base + t);
        }
        return acts;
      }
      if (this.stock[p] > 0) for (const t of this.placements(p, G, false)) acts.push(t);
      for (const pid of this.plist[p]) {
        const s = this.pos.get(pid), base = (s + 1) * N;
        for (const t of this.pieceMoves(s, p, G)) acts.push(base + t);
      }
      return acts;
    }

    hasAction(p) {
      const G = this.g.limit != null ? this.groups(p) : null;
      const obl = this.obl[p];
      const pieces = obl.length ? obl : this.plist[p];
      for (const pid of pieces) if (this.pieceMoves(this.pos.get(pid), p, G).length) return true;
      if (obl.length || this.stock[p] <= 0) return false;
      return this.placements(p, G, true).length > 0;
    }

    make(code) {
      const g = this.g, N = g.N, owner = this.owner, p = this.side, q = 3 - p;
      if (code < N) {
        this.undo.push([code, null, null, this.hbLo, this.hbHi, this.hoLo, this.hoHi]);
        const pid = this.nextPid++;
        owner[code] = p; this.pidat[code] = pid; this.pos.set(pid, code);
        this.plist[p].push(pid);
        this.stock[p]--;
        this.hbLo = (this.hbLo ^ g.zLo[p][code] ^ g.sideLo) >>> 0;
        this.hbHi ^= g.zHi[p][code] ^ g.sideHi;
        this.side = q;
        return;
      }
      const obl = this.obl;
      this.undo.push([code, obl[1].slice(), obl[2].slice(), this.hbLo, this.hbHi, this.hoLo, this.hoHi]);
      const s = Math.floor(code / N) - 1, t = code % N;
      const pidat = this.pidat;
      const pid = pidat[s];
      owner[s] = 0; pidat[s] = 0;
      owner[t] = p; pidat[t] = pid; this.pos.set(pid, t);
      this.hbLo = (this.hbLo ^ g.zLo[p][s] ^ g.zLo[p][t] ^ g.sideLo) >>> 0;
      this.hbHi ^= g.zHi[p][s] ^ g.zHi[p][t] ^ g.sideHi;
      let olo = this.hoLo, ohi = this.hoHi;
      const mine = obl[p];
      const at = mine.indexOf(pid);
      if (at >= 0) {
        mine.splice(at, 1);
        olo = (olo - oblLo(p, pid)) >>> 0; ohi = (ohi - oblHi(p, pid)) & 0x1FFFFF;
      }
      const W = CELL_WALL, nb = g.nbr[t], nb2 = g.nbr2[t];
      for (let d = 0; d < 4; d++) {
        const m = nb[d];
        if (owner[m] === q) {
          const f = owner[nb2[d]];
          if (f === p || f === W) {
            const vid = pidat[m];
            obl[q].push(vid);
            olo = (olo + oblLo(q, vid)) >>> 0; ohi = (ohi + oblHi(q, vid)) & 0x1FFFFF;
          }
        }
      }
      let a = owner[nb[0]], b = owner[nb[1]];
      let selfs = (a === q || a === W) && (b === q || b === W) && !(a === W && b === W);
      if (!selfs) {
        a = owner[nb[2]]; b = owner[nb[3]];
        selfs = (a === q || a === W) && (b === q || b === W) && !(a === W && b === W);
      }
      if (selfs) {
        mine.push(pid);
        olo = (olo + oblLo(p, pid)) >>> 0; ohi = (ohi + oblHi(p, pid)) & 0x1FFFFF;
      }
      this.hoLo = olo; this.hoHi = ohi;
      this.side = q;
    }

    unmake() {
      const [code, o1, o2, bl, bh, ol, oh] = this.undo.pop();
      const N = this.g.N, p = 3 - this.side;
      this.side = p;
      this.hbLo = bl; this.hbHi = bh; this.hoLo = ol; this.hoHi = oh;
      const owner = this.owner, pidat = this.pidat;
      if (code < N) {
        const pid = pidat[code];
        owner[code] = 0; pidat[code] = 0;
        this.pos.delete(pid);
        this.plist[p].pop();
        this.stock[p]++;
        this.nextPid--;
        return;
      }
      this.obl[1] = o1; this.obl[2] = o2;
      const s = Math.floor(code / N) - 1, t = code % N;
      const pid = pidat[t];
      owner[t] = 0; pidat[t] = 0;
      owner[s] = p; pidat[s] = pid; this.pos.set(pid, s);
    }

    // その手で相手の駒を挟む(=相手に移動義務を負わせる)か。配置では挟めない。
    isCapture(code) {
      const g = this.g, N = g.N;
      if (code < N) return false;
      const s = Math.floor(code / N) - 1, t = code % N;
      const owner = this.owner, p = this.side, q = 3 - p;
      const nb = g.nbr[t], nb2 = g.nbr2[t];
      for (let d = 0; d < 4; d++) {
        if (owner[nb[d]] === q) {
          const far = nb2[d];
          if (far !== s && (owner[far] === p || owner[far] === CELL_WALL)) return true;
        }
      }
      return false;
    }

    toAction(code) {
      const N = this.g.N, cols = this.g.cols;
      if (code < N) return ["place", [Math.floor(code / cols), code % cols]];
      const s = Math.floor(code / N) - 1, t = code % N;
      return ["move", this.pidat[s], [Math.floor(t / cols), t % cols]];
    }

    // 手番側から見た特徴量(順序は LEARNED_FEATURES)。手番側に合法手がなければ null(=負け)
    features() {
      const g = this.g, owner = this.owner, nbr = g.nbr, limit = g.limit, W = CELL_WALL;
      const s = this.side;
      const info = [null, null, null];
      for (const p of [s, 3 - s]) {
        let G = null, cluster = 0;
        if (limit != null) {
          G = this.groups(p);
          for (const n of G.sizes) cluster += n * n;
          cluster /= limit * limit;
        }
        const obl = this.obl[p];
        let mob = 0, nmov = 0, wall = 0, trapped = 0, danger = 0, cen = 0;
        const reach = new Uint8Array(g.N + 1);
        const nm = new Int32Array(g.N + 1); // マス → そこにいる駒の移動先の数(逃げ場の数)
        for (const pid of this.plist[p]) {
          const c = this.pos.get(pid);
          const ms = this.pieceMoves(c, p, G);
          nm[c] = ms.length;
          if (ms.length) {
            nmov += ms.length;
            for (const t of ms) reach[t] = 1;
            if (!obl.length) mob++;
          }
          wall += g.wexp[c];
          cen += g.centr[c];
          const nb = nbr[c];
          const blocked = (owner[nb[0]] !== 0) + (owner[nb[1]] !== 0) + (owner[nb[2]] !== 0) + (owner[nb[3]] !== 0);
          if (blocked >= 3) trapped += blocked === 4 ? 3 : 1;
        }
        for (const pid of obl) {
          const k = nm[this.pos.get(pid)];
          if (k) mob++;
          if (k < 4) danger += 4 - k;
        }
        if (p === s && mob === 0) {
          if (obl.length || this.stock[p] <= 0 || !this.placements(p, G, true).length) return null;
        }
        info[p] = { mob, nmov, obl: obl.length, danger, wall, cluster, trapped, cen, reach, nm };
      }
      // 挟みの圧力: 半挟み・次の1手で挟める形・そのうち逃げ場の少ない駒への脅威
      for (const p of [s, 3 - s]) {
        const q = 3 - p;
        const reach = info[p].reach, nmq = info[q].nm;
        let half = 0, threat = 0, weak = 0;
        for (const vid of this.plist[q]) {
          const m = this.pos.get(vid);
          const nb = nbr[m];
          for (let d = 0; d < 4; d++) {
            const x = owner[nb[d]];
            if (x === p || x === W) {
              const far = nb[d ^ 1];
              if (owner[far] === 0) {
                half++;
                if (reach[far]) {
                  threat++;
                  const kv = nmq[m];
                  if (kv < 3) weak += 3 - kv;
                }
              }
            }
          }
        }
        Object.assign(info[p], { half, threat, weak });
      }
      const S = info[s], O = info[3 - s];
      const stockTotal = this.stock[1] + this.stock[2];
      const placed = this.plist[1].length + this.plist[2].length;
      const ph = stockTotal ? stockTotal / (stockTotal + placed) : 0; // 1=序盤(配置期) → 0=終盤
      const center = S.cen - O.cen;
      const stock = this.stock[s] - this.stock[3 - s];
      return [S.mob - O.mob, S.nmov - O.nmov, S.obl, O.obl, S.danger, O.danger,
        S.wall - O.wall, S.cluster - O.cluster, stock, S.half - O.half, S.trapped - O.trapped, center,
        S.threat, O.threat, S.weak, O.weak,
        ph * (S.mob - O.mob), ph * stock, ph * center, ph * S.threat, ph * O.threat, ph,
        1];
    }
  }

  const LEARNED_FEATURES = [
    "mob_pieces", "mob_moves", "obl_stm", "obl_opp", "danger_stm", "danger_opp",
    "wall", "cluster", "stock", "half", "trapped", "center", "threat_stm", "threat_opp",
    "weak_stm", "weak_opp", "ph_mob", "ph_stock", "ph_center", "ph_threat_stm", "ph_threat_opp", "ph_tempo",
    "tempo",
  ];

  // ---- 局所パターン(Python 版 _PAT_CLASS と同じ) ----
  // 駒の上下左右4マスの状態(0 空き / 1 自分の駒 / 2 相手の駒 / 3 盤外)を、盤の対称変換
  // (上下反転・左右反転・縦横の入れ替え = 8通り)で同一視した 55 クラスに分ける。
  // 状態のコード = Σ 状態[d] << (2d)(d は DIRECTIONS の順: 上, 下, 左, 右)。
  // クラス番号は「コード 0..255 を順に見て、初めて現れた代表形の順」。
  const PAT_N = 55;
  const PAT_CLASS = (() => {
    const perms = [];
    for (const swapAxes of [false, true]) {
      for (const f1 of [false, true]) {
        for (const f2 of [false, true]) {
          let p = [0, 1, 2, 3];
          if (f1) p = [p[1], p[0], p[2], p[3]];
          if (f2) p = [p[0], p[1], p[3], p[2]];
          if (swapAxes) p = [p[2], p[3], p[0], p[1]];
          perms.push(p);
        }
      }
    }
    const cls = new Int16Array(256), canon = new Map();
    for (let code = 0; code < 256; code++) {
      const s = [code & 3, (code >> 2) & 3, (code >> 4) & 3, (code >> 6) & 3];
      let best = 1e9;
      for (const p of perms) best = Math.min(best, s[p[0]] | (s[p[1]] << 2) | (s[p[2]] << 4) | (s[p[3]] << 6));
      if (!canon.has(best)) canon.set(best, canon.size);
      cls[code] = canon.get(best);
    }
    return cls;
  })();

  // パターンの重み(weights.pat_s = 手番側の駒, weights.pat_o = 相手の駒, 各 55 個)から、
  // 「駒の持ち主 p・手番側の駒か」ごとに、隣4マスの owner 値(0..4)の組 → 重み の表を作る。
  // 表の添字 = owner[上]*125 + owner[下]*25 + owner[左]*5 + owner[右](盤外は番兵 3/4)。
  function buildPatternTables(weights) {
    if (!weights.pat_s || !weights.pat_o) return null;
    const tabs = [null, [null, null], [null, null]];
    for (const p of [1, 2]) {
      for (const [k, w] of [[0, weights.pat_s], [1, weights.pat_o]]) {
        const t = new Float64Array(625);
        for (let i = 0; i < 625; i++) {
          const os = [Math.floor(i / 125), Math.floor(i / 25) % 5, Math.floor(i / 5) % 5, i % 5];
          let code = 0;
          for (let d = 0; d < 4; d++) {
            const o = os[d];
            code |= (o === 0 ? 0 : o === p ? 1 : o === 3 - p ? 2 : 3) << (2 * d);
          }
          t[i] = w[PAT_CLASS[code]] || 0;
        }
        tabs[p][k] = t;
      }
    }
    return tabs;
  }

  // 局所パターンの評価値(手番側視点)
  function patternValue(st, tabs) {
    const s = st.side, owner = st.owner, nbr = st.g.nbr, pos = st.pos;
    let v = 0;
    for (let p = 1; p <= 2; p++) {
      const t = tabs[p][p === s ? 0 : 1];
      for (const pid of st.plist[p]) {
        const nb = nbr[pos.get(pid)];
        v += t[owner[nb[0]] * 125 + owner[nb[1]] * 25 + owner[nb[2]] * 5 + owner[nb[3]]];
      }
    }
    return v;
  }

  // Python 版 In_a_Pinch_app_5.py の LEARNED_WEIGHTS_GENERIC / LEARNED_WEIGHTS_TEMPLATE と同じ値
  // (評価値の単位: 100 = 勝率のロジット 1)。奥義(TEMPLATE)だけ局所パターンの重み pat_s / pat_o を持つ
  // (2026-09-29 追加。究極・神では効果が確認できず据え置き)
  const LEARNED_WEIGHTS_GENERIC = {
    mob_pieces: 4.689, mob_moves: -0.731, obl_stm: -5.562, obl_opp: 26.285,
    danger_stm: -38.368, danger_opp: 24.342, wall: -6.555, cluster: -31.865,
    stock: -7.482, half: 2.116, trapped: 0.116, center: 0.053,
    threat_stm: 21.881, threat_opp: -6.457, weak_stm: 16.466, weak_opp: -10.876,
    ph_mob: 5.283, ph_stock: -32.97, ph_center: -13.884, ph_threat_stm: 7.692,
    ph_threat_opp: -15.995, ph_tempo: 21.046, tempo: 2.88,
  };
  const LEARNED_WEIGHTS_TEMPLATE = {
    mob_pieces: 3.77, mob_moves: -0.441, obl_stm: -3.138, obl_opp: 4.101,
    danger_stm: 0.838, danger_opp: -0.533, wall: -20.2, cluster: 26.384,
    stock: -3.908, half: -8.462, trapped: 4.625, center: -35.381,
    threat_stm: 24.145, threat_opp: -7.476, weak_stm: 10.851, weak_opp: -9.456,
    ph_mob: 3.245, ph_stock: -66.143, ph_center: -10.786, ph_threat_stm: 7.657,
    ph_threat_opp: -20.75, ph_tempo: 176.921, tempo: -133.035,
    pat_s: [
      19.66, 10.51, 45.02, 7.7, -11.47, 47.19, 10.9, -27.13, -51.19, 0.0,
      -12.58, 39.69, 3.11, 0.0, 12.92, -17.45, -77.13, -65.35, 0.0, 56.94,
      52.88, 19.14, 63.85, 90.65, -61.27, -122.55, 0.0, -14.06, -18.24, 90.97,
      -3.56, -25.47, -91.76, 0.0, 0.0, 0.0, 0.0, 0.45, 3.88, 0.0,
      47.33, 70.73, 28.94, -16.19, 0.0, -14.0, 0.25, -14.36, 0.0, -6.63,
      -4.47, 0.0, -13.29, 0.0, 0.0,
    ],
    pat_o: [
      -12.26, -1.82, -38.37, 2.31, 26.83, -37.72, -1.74, 18.34, 54.58, 0.0,
      23.13, -32.05, 10.14, 0.0, -3.75, 28.71, 10.37, -9.81, 0.0, -51.69,
      -41.47, -16.06, -54.98, -80.74, 43.43, 56.32, 0.0, 26.18, 26.57, -55.16,
      9.16, 27.89, 71.82, 0.0, 0.0, 0.0, 0.0, 5.43, 0.28, 0.0,
      -36.4, -59.26, -13.53, 37.98, 0.0, 18.76, -17.32, -20.51, 0.0, 6.28,
      4.83, 0.0, 17.31, 0.0, 0.0,
    ],
  };

  const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
  const MATE_BOUND = WIN_SCORE - 10000;

  class LearnedSearchAI {
    constructor(player, name, timeBudget, weights, seed, opts) {
      opts = opts || {};
      this.player = player;
      this.level = {
        id: "learned", name, maxDepth: opts.maxDepth || 64, timeBudget,
        blunderRate: 0, useTT: true, ttSize: opts.ttSize || 400000,
      };
      this.weights = LEARNED_FEATURES.map((f) => weights[f] || 0);
      this._patTabs = buildPatternTables(weights); // 局所パターンの重み(なければ null)
      this.rng = new RNG(seed == null ? Date.now() & 0xffffffff : seed);
      // 千日手を避ける設計(Python 版と同じ既定値): 引き分けを自分にとってロジット1の損と数え、
      // すでに1度現れた局面へ戻る手を読みの中で引き分け扱いにする。長引いたら徐々に許容する
      this.contempt = opts.contempt == null ? 100 : opts.contempt;
      // 千日手対策: 読みの中で何回目の出現から引き分けとみなすか(null ならルールどおり)。
      // 2 にすると、すでに1度現れた局面へ戻る手をその時点で引き分けと評価して避ける
      this.repDrawAt = opts.repDrawAt === undefined ? 2 : opts.repDrawAt;
      this._repAt = 3;
      // 千日手を避け続けると終わらなくなりうるので、[開始, 終了] 手を超えて長引いたら
      // contempt を 0 まで徐々に下げ、最後は引き分けを受け入れる
      this.contemptTaper = opts.contemptTaper === undefined ? [120, 240] : opts.contemptTaper;
      this._contemptNow = this.contempt;
      this.lmr = opts.lmr !== false;
      this.nodeLimit = null;
      this.tt = new Map();
      this.nodesVisited = 0;
      this.lastDepth = 0;
      this.lastScore = 0;
    }

    chooseAction(engine) {
      if (engine.isOver()) return null;
      const legal = generateActions(engine, this.player);
      if (!legal.length) return null;
      if (legal.length === 1) return legal[0];
      const budget = this.level.timeBudget;
      this._deadline = budget == null ? null : Date.now() + budget;
      const st = this._st = new FastState(engine);
      this._me = st.side;
      this._repAt = this.repDrawAt == null ? st.replimit : Math.min(st.replimit, this.repDrawAt);
      this._contemptNow = this.contempt;
      if (this.contemptTaper) {
        const [t0, t1] = this.contemptTaper;
        let plies = 0; // これまでの手数(各手のあとに1回ずつ局面が記録される)
        for (const c of engine._stateHistory.values()) plies += c;
        if (plies > t0) this._contemptNow = this.contempt * Math.max(0, (t1 - plies) / (t1 - t0));
      }
      const N = st.g.N;
      this.nodesVisited = 0;
      if (this.tt.size > this.level.ttSize) this.tt.clear();
      this._killers = [];
      for (let i = 0; i < 130; i++) this._killers.push([-1, -1]);
      this._hist = [null, new Float64Array((N + 1) * N), new Float64Array((N + 1) * N)];

      const root = st.generate(st.side);
      for (let i = root.length - 1; i > 0; i--) { // 同点の手の選び方に揺らぎを持たせる
        const j = Math.floor(this.rng.next() * (i + 1));
        [root[i], root[j]] = [root[j], root[i]];
      }
      let bestCode = root[0], bestScore = -Infinity;
      for (let depth = 1; depth <= this.level.maxDepth; depth++) {
        this._iterBest = null;
        let res;
        try {
          res = this._searchRoot(root, depth);
        } catch (e) {
          if (!(e instanceof SearchTimeout)) throw e;
          // 打ち切られた局面を根まで巻き戻す(千日手の計数も作り直す)
          while (st.undo.length) st.unmake();
          st.rep = new FastState(engine).rep;
          if (this._iterBest != null) bestCode = this._iterBest;
          break;
        }
        [bestCode, bestScore] = res;
        this.lastDepth = depth;
        root.splice(root.indexOf(bestCode), 1);
        root.unshift(bestCode);
        if (Math.abs(bestScore) >= MATE_BOUND) break;
        if (this._deadline != null && Date.now() >= this._deadline) break;
      }
      this.lastScore = bestScore;
      const action = st.toAction(bestCode);
      if (!legal.some((a) => actionEquals(a, action))) return this.rng.choice(legal);
      return action;
    }

    _searchRoot(root, depth) {
      const st = this._st;
      let alpha = -Infinity;
      const beta = Infinity;
      let bestCode = root[0], best = -Infinity;
      for (let i = 0; i < root.length; i++) {
        const code = root[i];
        st.make(code);
        let score;
        if (i === 0) {
          score = -this._node(depth - 1, -beta, -alpha, 1);
        } else {
          score = -this._node(depth - 1, -alpha - 1, -alpha, 1);
          if (score > alpha) score = -this._node(depth - 1, -beta, -alpha, 1);
        }
        st.unmake();
        if (score > best) { best = score; bestCode = code; }
        if (score > alpha) { alpha = score; this._iterBest = code; }
      }
      return [bestCode, best];
    }

    _drawValue(side) {
      return side === this._me ? -this._contemptNow : this._contemptNow;
    }

    _evaluate(st, ply, cnt) {
      const x = st.features();
      if (x === null) return ply - WIN_SCORE;
      if (cnt >= this._repAt) return this._drawValue(st.side);
      const w = this.weights;
      let v = 0;
      for (let i = 0; i < w.length; i++) v += w[i] * x[i];
      if (this._patTabs) v += patternValue(st, this._patTabs);
      return v;
    }

    _node(depth, alpha, beta, ply) {
      this.nodesVisited++;
      if ((this.nodesVisited & 1023) === 0) {
        if (this._deadline != null && Date.now() > this._deadline) throw new SearchTimeout();
        if (this.nodeLimit != null && this.nodesVisited >= this.nodeLimit) throw new SearchTimeout();
      }
      const st = this._st;
      const key = st.key();
      const cnt = (st.rep.get(key) || 0) + 1;
      if (depth <= 0 || ply >= 120) return this._evaluate(st, ply, cnt);
      const side = st.side;
      const acts = st.generate(side);
      if (!acts.length) return ply - WIN_SCORE;
      if (cnt >= this._repAt) return this._drawValue(side);

      let ttMove = -1;
      const ent = this.tt.get(key);
      if (ent) {
        const [edepth, eflag] = ent;
        let ev = ent[2];
        ttMove = ent[3];
        if (edepth >= depth) {
          if (ev > MATE_BOUND) ev -= ply; else if (ev < -MATE_BOUND) ev += ply;
          if (eflag === TT_EXACT) return ev;
          if (eflag === TT_LOWER) { if (ev >= beta) return ev; } else if (ev <= alpha) return ev;
        }
      }

      // 手の並べ替え: 置換表の最善手 > 挟む手 > キラー手 > ヒストリー
      const killers = this._killers[ply];
      const hist = this._hist[side];
      const CAP = 2 ** 32, KILL = 2 ** 31, TTM = 2 ** 40;
      const scored = acts.map((code) => {
        let sc;
        if (code === ttMove) sc = TTM;
        else {
          sc = hist[code];
          if (st.isCapture(code)) sc += CAP;
          else if (code === killers[0] || code === killers[1]) sc += KILL;
        }
        return [sc, code];
      });
      scored.sort((a, b) => b[0] - a[0]);

      const forced = st.obl[side].length > 0;
      st.rep.set(key, cnt);
      const alpha0 = alpha;
      let best = -Infinity, bestCode = -1;
      for (let i = 0; i < scored.length; i++) {
        const [sc, code] = scored[i];
        st.make(code);
        let score;
        if (i === 0) {
          score = -this._node(depth - 1, -beta, -alpha, ply + 1);
        } else {
          let r = 0;
          if (this.lmr && depth >= 3 && i >= 3 && !forced && sc < KILL) r = (i >= 10 && depth >= 5) ? 2 : 1;
          score = -this._node(depth - 1 - r, -alpha - 1, -alpha, ply + 1);
          if (r && score > alpha) score = -this._node(depth - 1, -alpha - 1, -alpha, ply + 1);
          if (alpha < score && score < beta) score = -this._node(depth - 1, -beta, -alpha, ply + 1);
        }
        st.unmake();
        if (score > best) {
          best = score; bestCode = code;
          if (score > alpha) {
            alpha = score;
            if (alpha >= beta) {
              if (sc < CAP) {
                if (killers[0] !== code) { killers[1] = killers[0]; killers[0] = code; }
                hist[code] += depth * depth;
              }
              break;
            }
          }
        }
      }
      if (cnt === 1) st.rep.delete(key); else st.rep.set(key, cnt - 1);

      const flag = best <= alpha0 ? TT_UPPER : (best >= beta ? TT_LOWER : TT_EXACT);
      let sv = best;
      if (sv > MATE_BOUND) sv += ply; else if (sv < -MATE_BOUND) sv -= ply;
      if (this.tt.size >= this.level.ttSize) this.tt.clear(); // メモリ上限。1手の途中でも超えたら作り直す
      this.tt.set(key, [depth, flag, sv, bestCode]);
      return best;
    }
  }

  // 学習型AIを使うレベル。1〜5・8(達人)は難易度の段階として従来の MinimaxAI のまま。
  const LEARNED_LEVEL_IDS = [6, 7];

  // 画面・Worker から使う AI の生成窓口。奥義 = テンプレート学習版、究極・神 = 汎用学習版。
  function makeAI(player, level, specialist, seed, timeBudget) {
    if (specialist) {
      return new LearnedSearchAI(player, SPECIALIST_AI_NAME, timeBudget == null ? 29000 : timeBudget,
        LEARNED_WEIGHTS_TEMPLATE, seed);
    }
    if (LEARNED_LEVEL_IDS.includes(level)) {
      const lv = LEVELS[level];
      return new LearnedSearchAI(player, lv.name, lv.timeBudget, LEARNED_WEIGHTS_GENERIC, seed);
    }
    return new MinimaxAI(player, level, seed);
  }

  const AI = {
    LEVELS, LEVEL_ORDER, SPECIALIST_AI_NAME, SPECIALIST_AI_DESC,
    generateActions, applyAction, actionEquals,
    MinimaxAI, TemplateSpecialistAI, TranspositionTable, SearchTimeout,
    FastState, LearnedSearchAI, LEARNED_FEATURES, LEARNED_WEIGHTS_GENERIC, LEARNED_WEIGHTS_TEMPLATE,
    PAT_N, PAT_CLASS, buildPatternTables, patternValue,
    LEARNED_LEVEL_IDS, makeAI,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = AI;
  } else {
    global.HasamiAI = AI;
  }
})(typeof self !== "undefined" ? self : this);
