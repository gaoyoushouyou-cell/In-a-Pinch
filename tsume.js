/*!
 * tsume.js — 「詰めピンチ」専用ソルバー(ブラウザ・Web Worker・Node 共通)
 *
 * ルール(詰将棋の「攻め方は毎手王手」に相当):
 *   攻め方(解く側)は毎手かならず相手の駒を挟む手(=相手に移動義務を負わせる手)を指す。
 *   受け方は挟まれた駒を動かすしかないので、受けの手は少数に絞られる。
 *   受け方が「義務のある駒をどれも動かせない」状態になれば攻め方の勝ち(詰み)。
 *   攻め方が挟む手を指せなくなる/受けに挟み返されて動けなくなる/同一局面に
 *   戻る場合は「詰まない」と数える(千日手は本来3回目で成立するが、ここでは
 *   2回目の出現で失敗扱いにするので、証明された詰みは実戦でも必ず詰む)。
 *
 * 攻め方は配置では挟めず(配置で挟む手は禁じ手)、受け方は義務駒しか動かせない。
 * したがって詰めピンチの手順は全手が「移動」で、持ち駒の数は結果に影響しない。
 *
 * 拡張「詰めろ問題」(quiet = q): 攻め方は挟まない手(静かな手)を q 回まで指してよい。
 * 挟まない手のあとは受け方が自由に指せる(配置も可)ので読みは一気に広くなるが、
 * 詰将棋でいう「必至」に近い、一手の味わいのある問題が作れる。
 *
 * 探索: ai.js の FastState(指す→戻す方式の高速盤面)上で、手数を1,3,5…と
 * 延ばす反復深化の AND/OR 探索を行う。置換表には局面ごとに
 *   win  = 「win 手以内に詰む」と証明できた最小の手数
 *   fail = 「fail 手以内では詰まない」と確かめた最大の手数
 * を持つ(静かな手の残り回数ごとに別の表)。同一局面への戻りが絡んだ
 * 「詰まない」は経路依存なので置換表に残さない。
 */
(function (global) {
  "use strict";

  const H = global.Hasami || (typeof require !== "undefined" ? require("./engine.js") : null);
  const AI = global.HasamiAI || (typeof require !== "undefined" ? require("./ai.js") : null);
  const { FastState } = AI;

  const FAIL = 0, WIN = 1, FAIL_CYCLE = 2;

  class NodeLimit extends Error {}

  class TsumeSolver {
    // engine: GameEngine(攻め方・受け方どちらの手番でもよい)
    // solverPlayer: "A" / "B"(攻め方)
    // opts: { quiet: 静かな手の回数, nodeLimit, history: 実戦の既出局面も「戻り」とみなす }
    constructor(engine, solverPlayer, opts) {
      opts = opts || {};
      this.st = new FastState(engine);
      this.solver = solverPlayer === "A" ? 1 : 2;
      this.quiet = opts.quiet || 0;
      this.tts = [];
      for (let q = 0; q <= this.quiet; q++) this.tts.push(new Map());
      this.path = new Set();
      if (opts.history) {
        for (const h of this.st.rep.keys()) this.path.add(h);
        this.path.delete(this.st.key());
      }
      this.nodes = 0;
      this.nodeLimit = opts.nodeLimit || Infinity;
    }

    // ---- 手の生成 -----------------------------------------------------------
    // 攻め方の手。each: { code, replies, quiet }(replies = 受けの手の数、0 なら即詰み)
    // withQuiet=false なら挟む手だけ。挟む手を先に、それぞれ受けの少ない順に並べる。
    checks(withQuiet) {
      const st = this.st, p = st.side;
      const caps = [], quiets = [];
      for (const code of st.generate(p)) {
        const cap = st.isCapture(code);
        if (!cap && !withQuiet) continue;
        st.make(code);
        const replies = st.generate(st.side).length;
        st.unmake();
        (cap ? caps : quiets).push({ code, replies, quiet: !cap });
      }
      caps.sort((a, b) => a.replies - b.replies);
      quiets.sort((a, b) => a.replies - b.replies);
      return caps.concat(quiets);
    }

    // 受け方の手。挟み返す手(攻め方に義務を負わせる手)を先に読むと反証が早い。
    defenses() {
      const st = this.st;
      const caps = [], rest = [];
      for (const code of st.generate(st.side)) (st.isCapture(code) ? caps : rest).push(code);
      return caps.concat(rest);
    }

    // ---- AND/OR 探索 ------------------------------------------------------
    _probe(key, d, q) {
      const e = this.tts[q].get(key);
      if (!e) return -1;
      if (e.win <= d) return WIN;
      if (e.fail >= d) return FAIL;
      return -1;
    }
    _store(key, d, q, r) {
      const tt = this.tts[q];
      let e = tt.get(key);
      if (!e) { e = { win: Infinity, fail: -1 }; tt.set(key, e); }
      if (r === WIN) { if (d < e.win) e.win = d; } else if (r === FAIL) { if (d > e.fail) e.fail = d; }
    }

    // 攻め方の手番: d 手以内(d は奇数)に詰ませられるか(q = 残りの静かな手の回数)
    _or(d, q) {
      if (++this.nodes > this.nodeLimit) throw new NodeLimit();
      const st = this.st;
      const key = st.key();
      const hit = this._probe(key, d, q);
      if (hit >= 0) return hit;
      if (this.path.has(key)) return FAIL_CYCLE;
      const moves = this.checks(q > 0);
      if (!moves.length) { this._store(key, Infinity, q, FAIL); return FAIL; }
      if (moves.some((m) => m.replies === 0)) { this._store(key, 1, q, WIN); return WIN; }
      if (d < 3) { this._store(key, d, q, FAIL); return FAIL; }
      this.path.add(key);
      let result = FAIL;
      for (const { code, quiet } of moves) {
        st.make(code);
        const r = this._and(d - 1, quiet ? q - 1 : q);
        st.unmake();
        if (r === WIN) { result = WIN; break; }
        if (r === FAIL_CYCLE) result = FAIL_CYCLE;
      }
      this.path.delete(key);
      if (result !== FAIL_CYCLE) this._store(key, d, q, result);
      return result;
    }

    // 受け方の手番: どう受けても d 手以内(d は偶数、受けの手を含む)に詰むか
    _and(d, q) {
      if (++this.nodes > this.nodeLimit) throw new NodeLimit();
      const st = this.st;
      const key = st.key();
      const hit = this._probe(key, d, q);
      if (hit >= 0) return hit;
      if (this.path.has(key)) return FAIL_CYCLE;
      const moves = this.defenses();
      if (!moves.length) { this._store(key, 0, q, WIN); return WIN; }
      this.path.add(key);
      let result = WIN;
      for (const code of moves) {
        st.make(code);
        // 挟み返されて攻め方の義務駒がどれも動けない → 攻め方の負け
        const r = st.hasAction(st.side) ? this._or(d - 1, q) : FAIL;
        st.unmake();
        if (r !== WIN) { result = r; break; }
      }
      this.path.delete(key);
      if (result !== FAIL_CYCLE) this._store(key, d, q, result);
      return result;
    }

    // 現局面(どちらの手番でも)から詰みまでの最短手数。maxPlies 以内で証明できなければ null。
    // q = 残りの静かな手の回数(省略時はソルバー作成時の quiet)。
    distance(maxPlies, q) {
      if (q == null) q = this.quiet;
      const st = this.st;
      if (st.side === this.solver) {
        for (let d = 1; d <= maxPlies; d += 2) if (this._or(d, q) === WIN) return d;
        return null;
      }
      if (!st.generate(st.side).length) return 0;
      for (let d = 2; d <= maxPlies; d += 2) if (this._and(d, q) === WIN) return d;
      return null;
    }

    // 1手指した後の局面の手数(子の手数 + 1)。証明できなければ null。
    _childDistance(code, maxPlies, q) {
      const st = this.st;
      st.make(code);
      let r;
      if (st.side !== this.solver) {
        r = st.generate(st.side).length ? this.distance(maxPlies - 1, q) : 0;
      } else {
        r = st.hasAction(st.side) ? this.distance(maxPlies - 1, q) : null;
      }
      st.unmake();
      return r == null ? null : r + 1;
    }

    // 攻め方の手番: 各候補手の詰み手数(詰まない手は plies:null)。q>0 なら静かな手も含む。
    rankChecks(maxPlies, q) {
      if (q == null) q = this.quiet;
      return this.checks(q > 0).map(({ code, quiet }) =>
        ({ code, quiet, plies: this._childDistance(code, maxPlies, quiet ? q - 1 : q) }));
    }

    // 受け方の手番: 各受けの詰み手数(null = maxPlies 以内では詰まない=逃れ)
    rankDefenses(maxPlies, q) {
      if (q == null) q = this.quiet;
      return this.defenses().map((code) => ({ code, plies: this._childDistance(code, maxPlies, q) }));
    }

    toAction(code) { return this.st.toAction(code); }

    // "C3-C5"(移動)/ "*D4"(配置)
    labelOf(code) {
      const N = this.st.g.N, cols = this.st.g.cols;
      const t = code % N, to = H.posLabel([Math.floor(t / cols), t % cols]);
      if (code < N) return "*" + to;
      const s = Math.floor(code / N) - 1;
      return H.posLabel([Math.floor(s / cols), s % cols]) + "-" + to;
    }
  }

  // ---- 問題データ <-> エンジン --------------------------------------------
  // position: { rows, cols, moveRange, contactLimit, wallSandwich, stockA, stockB,
  //             currentPlayer, pieces: [[player, r, c, 義務の重複数(省略可)], ...] }
  function engineFromPosition(position) {
    const config = H.makeConfig({
      rows: position.rows, cols: position.cols, moveRange: position.moveRange,
      wallSandwich: position.wallSandwich, contactLimit: position.contactLimit,
    });
    const engine = new H.GameEngine(config);
    engine.stock.A = position.stockA;
    engine.stock.B = position.stockB;
    let nextId = 1;
    for (const [player, r, c, obl] of position.pieces) {
      const id = nextId++;
      engine.pieces.set(id, { id, player, position: [r, c] });
      engine.board.set(r + "," + c, id);
      for (let k = 0; k < (obl || 0); k++) engine.obligated[player].push(id);
    }
    engine._nextPieceId = nextId;
    engine.currentPlayer = position.currentPlayer;
    return engine;
  }

  function positionFromEngine(engine) {
    const ids = Array.from(engine.pieces.keys()).sort((a, b) => a - b);
    return {
      rows: engine.config.rows, cols: engine.config.cols, moveRange: engine.config.moveRange,
      contactLimit: engine.config.contactLimit, wallSandwich: engine.config.wallSandwich,
      stockA: engine.stock.A, stockB: engine.stock.B, currentPlayer: engine.currentPlayer,
      pieces: ids.map((id) => {
        const p = engine.pieces.get(id);
        const obl = engine.obligated[p.player].filter((x) => x === id).length;
        return obl ? [p.player, p.position[0], p.position[1], obl] : [p.player, p.position[0], p.position[1]];
      }),
    };
  }

  // 局面の中で「挟む手」だけを列挙(UI で指せる手を絞るのに使う)。
  // 戻り値: Map(pieceId -> [[r,c], ...])
  function checkMovesOf(engine, player) {
    const out = new Map();
    if (engine.isOver() || engine.currentPlayer !== player) return out;
    const st = new FastState(engine);
    const N = st.g.N, cols = st.g.cols;
    for (const code of st.generate(st.side)) {
      if (code < N || !st.isCapture(code)) continue;
      const s = Math.floor(code / N) - 1, t = code % N;
      const pid = st.pidat[s];
      if (!out.has(pid)) out.set(pid, []);
      out.get(pid).push([Math.floor(t / cols), t % cols]);
    }
    return out;
  }

  // 手のラベル("C3-C5" / "*D4")をエンジンの action に直す
  function actionFromLabel(engine, label) {
    if (label[0] === "*") return ["place", H.posFromLabel(label.slice(1))];
    const [from, to] = label.split("-");
    const piece = engine.pieceAt(H.posFromLabel(from));
    return piece ? ["move", piece.id, H.posFromLabel(to)] : null;
  }

  // ---- 問題の解析(発掘ツール・テスト用) ------------------------------------
  // 最短手数・主手順(攻めは最短、受けは最長抵抗)・各攻め手の正解数を求める。
  // 戻り値 null = maxPlies 以内に詰みを証明できない。
  function analyze(engine, solverPlayer, maxPlies, opts) {
    const solver = new TsumeSolver(engine, solverPlayer, opts);
    let par;
    try { par = solver.distance(maxPlies); } catch (e) { if (e instanceof NodeLimit) return null; throw e; }
    if (par == null) return null;
    const proofNodes = solver.nodes;
    const st = solver.st;
    const line = [], alternatives = [], widths = [];
    let rootChecks = 0, q = solver.quiet, quietUsed = 0;
    try {
      let remaining = par, depth = 0;
      while (remaining > 0) {
        if (st.side === solver.solver) {
          const ranked = solver.rankChecks(remaining, q);
          if (depth === 0) rootChecks = ranked.filter((x) => !x.quiet).length;
          const winning = ranked.filter((x) => x.plies != null && x.plies <= remaining);
          alternatives.push(winning.length);
          widths.push(ranked.length);
          winning.sort((a, b) => a.plies - b.plies);
          line.push(winning[0].code);
          remaining = winning[0].plies - 1;
          if (winning[0].quiet) { q--; quietUsed++; }
          st.make(winning[0].code);
        } else {
          const ranked = solver.rankDefenses(remaining, q);
          widths.push(ranked.length);
          ranked.sort((a, b) => b.plies - a.plies);
          line.push(ranked[0].code);
          remaining = ranked[0].plies - 1;
          st.make(ranked[0].code);
        }
        depth++;
      }
    } catch (e) {
      if (e instanceof NodeLimit) return null;
      throw e;
    }
    const labels = [];
    for (let i = line.length - 1; i >= 0; i--) { st.unmake(); labels.unshift(solver.labelOf(line[i])); }
    // 最終手(詰ませる手)以外の攻め手がすべて唯一なら「唯一解」
    const unique = alternatives.slice(0, -1).every((n) => n === 1);
    // widths: 主手順の各局面での候補手の数(攻め=指せる手の数、受け=受けの数)。難易度の目安
    return { par, line: labels, alternatives, widths, unique, rootChecks, quietUsed, proofNodes, nodes: solver.nodes };
  }

  // ---- 対局画面から呼ぶ入口(Web Worker とメインスレッドの両方で使う) ---------
  const PLAY_NODE_LIMIT = 4000000;

  // 攻め方(あなた)の手番: maxPlies 以内に詰む最短の手。見つからなければ null。
  function hintFor(engine, solverPlayer, quietLeft, maxPlies) {
    const s = new TsumeSolver(engine, solverPlayer, { quiet: quietLeft, history: true, nodeLimit: PLAY_NODE_LIMIT });
    let ranked;
    try { ranked = s.rankChecks(maxPlies); } catch (e) { if (e instanceof NodeLimit) return null; throw e; }
    const winning = ranked.filter((x) => x.plies != null).sort((a, b) => a.plies - b.plies || a.quiet - b.quiet);
    if (!winning.length) return null;
    return { move: s.toAction(winning[0].code), label: s.labelOf(winning[0].code), plies: winning[0].plies, quiet: winning[0].quiet };
  }

  // 受け方(AI)の手番: 詰みが続いていれば最も長く粘る受け(最長抵抗)を返す。
  // maxPlies 以内に詰まない受け(逃れ)があれば proven:false でその手を返す。
  function defendFor(engine, solverPlayer, quietLeft, maxPlies) {
    const s = new TsumeSolver(engine, solverPlayer, { quiet: quietLeft, history: true, nodeLimit: PLAY_NODE_LIMIT });
    const codes = s.defenses();
    if (!codes.length) return null;
    let ranked;
    try { ranked = s.rankDefenses(maxPlies); } catch (e) {
      if (!(e instanceof NodeLimit)) throw e;
      ranked = codes.map((code) => ({ code, plies: null }));
    }
    const escape = ranked.find((x) => x.plies == null);
    if (escape) return { proven: false, move: s.toAction(escape.code), label: s.labelOf(escape.code) };
    ranked.sort((a, b) => b.plies - a.plies);
    return { proven: true, move: s.toAction(ranked[0].code), label: s.labelOf(ranked[0].code), plies: ranked[0].plies };
  }

  // ---- 作問の品質管理 -------------------------------------------------------
  // 実戦で起こりうる局面か: 挟まれている形の駒は、必ず移動義務を負っているはず
  // (挟む手を指すと挟まれた側に義務が付き、次の手番で動かすまで残るため)。
  // 不要駒を取り除いた結果、義務のない駒が挟まれた形になる局面は不自然なので採らない。
  function isNatural(engine) {
    for (const piece of engine.pieces.values()) {
      const opp = H.otherPlayer(piece.player);
      const [r, c] = piece.position;
      for (const [[dr1, dc1], [dr2, dc2]] of H.AXIS_PAIRS) {
        const f1 = engine._flank([r + dr1, c + dc1], opp);
        const f2 = engine._flank([r + dr2, c + dc2], opp);
        if (f1 && f2 && !(f1 === "wall" && f2 === "wall") && !engine.obligated[piece.player].includes(piece.id)) return false;
      }
    }
    return true;
  }

  function removePiece(engine, pid) {
    const e = engine.clone();
    const piece = e.pieces.get(pid);
    e.board.delete(H.posKey(piece.position));
    e.pieces.delete(pid);
    e.obligated[piece.player] = e.obligated[piece.player].filter((x) => x !== pid);
    return e;
  }

  // 不要駒の除去(詰将棋でいう「不要駒なし」の仕上げ)。手数・唯一解・静かな手の回数が
  // 変わらない限り、主手順から遠い駒から順に取り除いていく。ただし初手の「挟む手」の
  // 候補が減りすぎると正解が見え見えになるので、元の候補数(最大3)は残す。
  function minimize(engine, solverPlayer, info, opts) {
    opts = opts || {};
    const quiet = opts.quiet || 0;
    const nodeLimit = opts.nodeLimit || 200000;
    let cur = engine, best = info;
    const lineCells = new Set();
    for (const lb of info.line) for (const part of lb.replace("*", "").split("-")) lineCells.add(part);
    const distToLine = (pos) => {
      let d = Infinity;
      for (const lb of lineCells) {
        const [r, c] = H.posFromLabel(lb);
        d = Math.min(d, Math.abs(r - pos[0]) + Math.abs(c - pos[1]));
      }
      return d;
    };
    const order = Array.from(cur.pieces.values())
      .sort((a, b) => distToLine(b.position) - distToLine(a.position) || a.id - b.id)
      .map((p) => p.id);
    for (const pid of order) {
      const trial = removePiece(cur, pid);
      const players = new Set(Array.from(trial.pieces.values()).map((p) => p.player));
      if (players.size < 2 || !isNatural(trial)) continue;
      const r = analyze(trial, solverPlayer, best.par, { quiet, nodeLimit });
      if (!r || r.par !== best.par || r.unique !== best.unique || r.quietUsed !== best.quietUsed) continue;
      if (r.rootChecks < Math.min(info.rootChecks, 3)) continue;
      if (quiet && analyze(trial, solverPlayer, best.par, { quiet: 0, nodeLimit })) continue;
      cur = trial; best = r;
    }
    return { engine: cur, info: best };
  }

  // 正方形の盤は8通りの対称形を同じ問題とみなす(重複排除用の正規化キー)
  function canonicalKey(position) {
    const n = position.rows, sq = position.rows === position.cols;
    const maps = sq ? [
      (r, c) => [r, c], (r, c) => [c, n - 1 - r], (r, c) => [n - 1 - r, n - 1 - c], (r, c) => [n - 1 - c, r],
      (r, c) => [r, n - 1 - c], (r, c) => [n - 1 - r, c], (r, c) => [c, r], (r, c) => [n - 1 - c, n - 1 - r],
    ] : [(r, c) => [r, c]];
    const head = [position.rows, position.cols, position.moveRange, position.contactLimit, !!position.wallSandwich,
      position.currentPlayer].join("/");
    let best = null;
    for (const f of maps) {
      const s = position.pieces.map(([p, r, c, o]) => { const [a, b] = f(r, c); return `${p}${a},${b}${o ? "!" + o : ""}`; })
        .sort().join(" ");
      if (best === null || s < best) best = s;
    }
    return head + "|" + best;
  }

  // 主手順から問題の「テーマ」を読み取る(問題一覧のタグ・ヒントに使う)
  function themeTags(engine, solverPlayer, line) {
    const e = engine.clone();
    const tags = new Set();
    for (const label of line) {
      const mover = e.currentPlayer;
      const action = actionFromLabel(e, label);
      const from = action[0] === "move" ? e.pieces.get(action[1]).position.slice() : null;
      const res = AI.applyAction(e, mover, action);
      if (mover === solverPlayer) {
        if (!res.newlySandwiched.length) tags.add("詰めろ");
        if (res.newlySandwiched.length >= 2) tags.add("両挟み");
        if (res.selfSandwiched) tags.add("自ら挟まれる");
        if (from) {
          const to = action[2];
          if (Math.abs(to[0] - from[0]) + Math.abs(to[1] - from[1]) > e.config.moveRange) tags.add("外周スライド");
          for (const pid of res.newlySandwiched) {
            const p = e.pieces.get(pid).position;
            const far = [2 * p[0] - to[0], 2 * p[1] - to[1]];
            if (!e.inBounds(far)) tags.add("壁挟み");
          }
        }
      } else if (res.newlySandwiched.length) {
        tags.add("挟み返し");
      }
    }
    const loser = H.otherPlayer(solverPlayer);
    if (e.winner === solverPlayer && new Set(e.obligated[loser]).size >= 2) tags.add("二重義務");
    return Array.from(tags);
  }

  // ---- 自己対戦からの自動作問(ブラウザの「新作を作る」と発掘ツールの共通部品) -----
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 局面を問題にできるか調べ、できれば問題データを返す(できなければ null)。
  // want: { minPar, maxPar, quiet, nodeLimit, minimize }
  function puzzleFromEngine(engine, want, meta) {
    const solverPlayer = engine.currentPlayer;
    const quiet = want.quiet || 0;
    const nodeLimit = want.nodeLimit || 50000;
    if (engine.isOver()) return null;
    let info = analyze(engine, solverPlayer, want.maxPar, { quiet, nodeLimit });
    if (!info || info.par < want.minPar) return null;
    if (quiet && !info.quietUsed) return null; // 挟む手だけで詰むなら詰めろ問題ではない
    if (quiet && analyze(engine, solverPlayer, info.par, { quiet: 0, nodeLimit })) return null;
    if (info.par >= 3 && !info.unique) return null;
    if (info.par === 1 && info.rootChecks < 2) return null; // 挟む手が1つしかない1手詰めは簡単すぎる
    let e = engine;
    if (want.minimize !== false) ({ engine: e, info } = minimize(engine, solverPlayer, info, { quiet, nodeLimit }));
    const position = positionFromEngine(e);
    return Object.assign({
      par: info.par, quiet, position, line: info.line, rootChecks: info.rootChecks, widths: info.widths,
      tags: themeTags(e, solverPlayer, info.line), proofNodes: info.proofNodes,
      removed: engine.pieces.size - e.pieces.size,
    }, meta || {});
  }

  // 学習型AI同士の速い自己対戦を指しながら、条件に合う詰めピンチが現れるまで探す。
  // opts: { config, stock, minPar, maxPar, quiet, seed, deadline(ms時刻), aiMs, onProgress }
  function generatePuzzle(opts) {
    const rng = mulberry32(opts.seed || 1);
    const deadline = opts.deadline || (Date.now() + 20000);
    let games = 0;
    while (Date.now() < deadline) {
      games++;
      const cfg = H.makeConfig(Object.assign({}, opts.config, { stockPerPlayer: opts.stock }));
      const e = new H.GameEngine(cfg);
      const ais = {
        A: new AI.LearnedSearchAI("A", "gen", opts.aiMs || 25, AI.LEARNED_WEIGHTS_GENERIC, Math.floor(rng() * 1e9)),
        B: new AI.LearnedSearchAI("B", "gen", opts.aiMs || 25, AI.LEARNED_WEIGHTS_GENERIC, Math.floor(rng() * 1e9)),
      };
      const opening = 2 + Math.floor(rng() * 6);
      for (let ply = 0; ply < 160 && !e.isOver() && Date.now() < deadline; ply++) {
        const p = e.currentPlayer;
        let action;
        if (ply < opening) {
          const acts = AI.generateActions(e, p);
          action = acts[Math.floor(rng() * acts.length)];
        } else {
          action = ais[p].chooseAction(e);
        }
        AI.applyAction(e, p, action);
        if (e.isOver() || ply < 6) continue;
        const pz = puzzleFromEngine(e, opts, { source: { kind: "generated", game: games, ply: ply + 1 } });
        if (pz) return pz;
      }
      if (opts.onProgress) opts.onProgress(games);
    }
    return null;
  }

  const Tsume = {
    TsumeSolver, NodeLimit, engineFromPosition, positionFromEngine, checkMovesOf, actionFromLabel, analyze,
    hintFor, defendFor, isNatural, minimize, canonicalKey, themeTags, puzzleFromEngine, generatePuzzle, mulberry32,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Tsume;
  else global.HasamiTsume = Tsume;
})(typeof self !== "undefined" ? self : this);
