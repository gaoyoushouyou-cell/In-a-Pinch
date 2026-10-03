// Node上でengine.js/ai.jsの移植が正しいか簡易検証するスクリプト(ブラウザには同梱しない)
const H = require("./engine.js");
const AI = require("./ai.js");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok -", name); }
  else { fail++; console.log("FAIL -", name, detail || ""); }
}

// ---- 1. 壁挟み: 辺での単騎捕獲 ----
(function () {
  const cfg = H.makeConfig({ rows: 7, cols: 7, moveRange: 3, stockPerPlayer: 5, wallSandwich: true });
  const e = new H.GameEngine(cfg);
  e.pieces.set(100, { id: 100, player: "B", position: [3, 0] });
  e.board.set("3,0", 100);
  e.pieces.set(101, { id: 101, player: "A", position: [3, 2] });
  e.board.set("3,2", 101);
  e._nextPieceId = 102;
  e.currentPlayer = "A";
  const result = e.movePiece("A", 101, [3, 1]);
  check("wall edge capture happened", result.newlySandwiched.includes(100), result.newlySandwiched);
  check("captured piece obligated for B", e.obligated.B.includes(100));
})();

// ---- 2. 接触制限: 上限超過の配置は禁止 ----
(function () {
  const cfg = H.makeConfig({ rows: 7, cols: 7, moveRange: 1, stockPerPlayer: 10, wallSandwich: false, contactLimit: 3 });
  const e = new H.GameEngine(cfg);
  [[2, 2], [2, 3]].forEach((pos, i) => { e.pieces.set(200 + i, { id: 200 + i, player: "A", position: pos }); e.board.set(pos.join(","), 200 + i); });
  e._nextPieceId = 300;
  e.currentPlayer = "A";
  let placements = e.legalPlacements("A");
  check("group size 3 legal", placements.some((p) => p[0] === 2 && p[1] === 4));
  e.placePiece("A", [2, 4]);
  placements = e.legalPlacements("A");
  check("group size 4 illegal", !placements.some((p) => p[0] === 2 && p[1] === 5));
  check("disconnected placement still legal", placements.some((p) => p[0] === 5 && p[1] === 5));
})();

// ---- 3. clone() の独立性 ----
(function () {
  const cfg = H.makeConfig({ rows: 6, cols: 6, moveRange: 2, stockPerPlayer: 6, wallSandwich: true, contactLimit: 4 });
  const e = new H.GameEngine(cfg);
  e.placePiece("A", [2, 2]);
  e.placePiece("B", [3, 3]);
  const clone = e.clone();
  clone.board.delete("2,2");
  check("clone mutation does not affect original", e.board.has("2,2"));
})();

// ---- 4. AI: 各レベルが合法手を返す ----
(function () {
  const cfg = H.makeConfig({ rows: 6, cols: 6, moveRange: 2, stockPerPlayer: 6, wallSandwich: true, contactLimit: 4 });
  const e = new H.GameEngine(cfg);
  const rng = { s: 12345 };
  function rand() { rng.s = (rng.s * 1103515245 + 12345) & 0x7fffffff; return rng.s / 0x7fffffff; }
  for (let i = 0; i < 10 && !e.isOver(); i++) {
    const player = e.currentPlayer;
    const actions = AI.generateActions(e, player);
    if (!actions.length) break;
    const a = actions[Math.floor(rand() * actions.length)];
    AI.applyAction(e, player, a);
  }
  if (!e.isOver()) {
    for (let lvl = 1; lvl <= 7; lvl++) {
      const ai = new AI.MinimaxAI(e.currentPlayer, lvl, 1);
      const t0 = Date.now();
      const budget = ai.level.timeBudget;
      if (budget) ai.level = Object.assign({}, ai.level, { timeBudget: Math.min(budget, 700) });
      const action = ai.chooseAction(e.clone());
      const elapsed = Date.now() - t0;
      const legal = AI.generateActions(e, e.currentPlayer);
      const ok = action && legal.some((a) => AI.actionEquals(a, action));
      check(`level ${lvl} (${ai.level.name}) returns legal action (${elapsed}ms)`, ok, action);
    }
  }
})();

// ---- 5. TemplateSpecialistAI: テンプレート設定で合法手・時間内 ----
(function () {
  const cfg = H.makeConfig({ rows: 7, cols: 7, moveRange: 3, stockPerPlayer: 15, wallSandwich: true, contactLimit: 3 });
  let e = new H.GameEngine(cfg);
  const aiA = new AI.TemplateSpecialistAI("A", 1, 800);
  const aiB = new AI.TemplateSpecialistAI("B", 2, 800);
  let plies = 0, worst = 0, ok = true;
  try {
    while (!e.isOver() && plies < 30) {
      const cur = e.currentPlayer;
      const ai = cur === "A" ? aiA : aiB;
      const t0 = Date.now();
      const action = ai.chooseAction(e.clone());
      worst = Math.max(worst, Date.now() - t0);
      if (!action) break;
      AI.applyAction(e, cur, action);
      plies++;
    }
  } catch (err) { ok = false; console.log(err); }
  check(`specialist self-play: ${plies} plies no exception`, ok);
  check(`specialist move time within budget+margin (worst ${worst}ms)`, worst < 2500, worst);
})();

// ---- 6. 引き分け(千日手)判定が発火する ----
(function () {
  const cfg = H.makeConfig({ rows: 5, cols: 5, moveRange: 1, stockPerPlayer: 2, wallSandwich: false, contactLimit: null, repetitionLimit: 3 });
  const e = new H.GameEngine(cfg);
  e.placePiece("A", [0, 0]);
  e.placePiece("B", [4, 4]);
  e.placePiece("A", [0, 1]);
  e.placePiece("B", [4, 3]);
  let draw = false;
  for (let i = 0; i < 20 && !e.isOver(); i++) {
    const cur = e.currentPlayer;
    const piece = Array.from(e.pieces.values()).find((p) => p.player === cur);
    const moves = e.legalMoves(piece.id);
    if (!moves.length) break;
    // 常に同じ2マスを往復させることでわざと同一局面を作る
    const dest = moves[0];
    const r = e.movePiece(cur, piece.id, dest);
    if (r.draw) draw = true;
  }
  check("repetition triggers draw eventually", draw || e.isDraw);
})();

// ---- 7. 外周スライド: 最外周の駒は外周に沿う方向だけ移動範囲の上限なし ----
(function () {
  const keys = (moves) => moves.map((p) => p.join(",")).sort();
  const put = (e, id, player, pos) => {
    e.pieces.set(id, { id, player, position: pos });
    e.board.set(pos.join(","), id);
    e._nextPieceId = Math.max(e._nextPieceId, id + 1);
  };
  const cfg = (moveRange, contactLimit) => H.makeConfig({ rows: 7, cols: 7, moveRange, stockPerPlayer: 10, wallSandwich: true, contactLimit });

  let e = new H.GameEngine(cfg(1, null));
  put(e, 1, "A", [0, 1]);
  check("top-row piece slides to both ends, inward only 1 step",
    JSON.stringify(keys(e.legalMoves(1))) === JSON.stringify(["0,0", "0,2", "0,3", "0,4", "0,5", "0,6", "1,1"]), keys(e.legalMoves(1)));

  e = new H.GameEngine(cfg(1, null));
  put(e, 1, "A", [3, 6]);
  put(e, 2, "B", [5, 6]);
  let m = keys(e.legalMoves(1));
  check("slide stops before a blocking piece", m.includes("4,6") && !m.includes("5,6") && !m.includes("6,6"), m);
  check("slide reaches the corner but does not turn", m.includes("0,6") && !m.includes("0,5"), m);
  check("inward move keeps moveRange", m.includes("3,5") && !m.includes("3,4"), m);

  e = new H.GameEngine(cfg(2, null));
  put(e, 1, "A", [1, 3]);
  check("second-row piece keeps moveRange",
    JSON.stringify(keys(e.legalMoves(1))) === JSON.stringify(["0,3", "1,1", "1,2", "1,4", "1,5", "2,3", "3,3"]), keys(e.legalMoves(1)));

  e = new H.GameEngine(cfg(1, 2));
  put(e, 1, "A", [0, 0]);
  put(e, 2, "A", [1, 4]);
  put(e, 3, "A", [2, 4]);
  m = keys(e.legalMoves(1));
  check("edge slide still respects contact limit", !m.includes("0,4") && m.includes("0,5") && m.includes("0,6"), m);
})();

// ---- 8. 学習型AI: 高速エンジン FastState が GameEngine と一致する ----
(function () {
  let s = 2026;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const actKey = (a) => (a[0] === "place" ? "p" + a[1].join(",") : "m" + a[1] + ":" + a[2].join(","));
  let bad = 0, positions = 0;
  for (let g = 0; g < 120 && !bad; g++) {
    const cfg = H.makeConfig({
      rows: pick([4, 5, 6, 7, 8]), cols: pick([4, 5, 6, 7, 8]), moveRange: pick([1, 2, 3]),
      stockPerPlayer: pick([null, 3, 5, 8, 12]), wallSandwich: rand() < 0.8, contactLimit: pick([null, 3, 4, 5, 6]),
    });
    const e = new H.GameEngine(cfg);
    const st = new AI.FastState(e);
    for (let ply = 0; ply < 250 && !e.isOver(); ply++) {
      positions++;
      const ref = new Set(AI.generateActions(e, e.currentPlayer).map(actKey));
      const codes = st.generate(st.side);
      const got = codes.map((c) => actKey(st.toAction(c)));
      if (got.length !== ref.size || !got.every((k) => ref.has(k)) || new Set(got).size !== got.length) {
        bad++; console.log("   gen mismatch", g, ply); break;
      }
      if ((st.features() === null) !== (ref.size === 0)) { bad++; console.log("   features/loss", g, ply); break; }
      const code = pick(codes);
      AI.applyAction(e, e.currentPlayer, st.toAction(code));
      st.make(code);
      const loss = !st.hasAction(st.side);
      let draw = false;
      if (!loss) {
        const k = st.key();
        const c = (st.rep.get(k) || 0) + 1;
        st.rep.set(k, c);
        draw = c >= st.replimit;
      }
      if (loss !== (e.winner != null) || draw !== e.isDraw) { bad++; console.log("   result mismatch", g, ply); break; }
      const so = (arr) => arr.slice().sort((a, b) => a - b).join(",");
      if (so(st.obl[1]) !== so(e.obligated.A) || so(st.obl[2]) !== so(e.obligated.B)) {
        bad++; console.log("   obligated mismatch", g, ply); break;
      }
      if (st._hashOfStateKey(e._stateKey()) !== st.key()) { bad++; console.log("   hash mismatch", g, ply); break; }
    }
  }
  check(`FastState parity with GameEngine (${positions} positions)`, bad === 0);
})();

// ---- 9. 学習型AI: 合法手・持ち時間・生成窓口 ----
(function () {
  const cfg = H.makeConfig({ rows: 7, cols: 7, moveRange: 3, stockPerPlayer: 15, wallSandwich: true, contactLimit: 3 });
  const e = new H.GameEngine(cfg);
  const aiA = AI.makeAI("A", 7, true, 1, 500);
  const aiB = AI.makeAI("B", 7, true, 2, 500);
  let plies = 0, worst = 0, ok = true;
  while (!e.isOver() && plies < 40) {
    const cur = e.currentPlayer;
    const ai = cur === "A" ? aiA : aiB;
    const t0 = Date.now();
    const action = ai.chooseAction(e.clone());
    worst = Math.max(worst, Date.now() - t0);
    const legal = AI.generateActions(e, cur);
    if (!action || !legal.some((a) => AI.actionEquals(a, action))) { ok = false; break; }
    AI.applyAction(e, cur, action);
    plies++;
  }
  check(`learned AI (奥義) self-play: ${plies} plies all legal`, ok);
  check(`learned AI move time within budget+margin (worst ${worst}ms)`, worst < 1200, worst);
  check("makeAI: specialist -> LearnedSearchAI", AI.makeAI("A", 7, true, 1) instanceof AI.LearnedSearchAI);
  check("makeAI: levels 6/7 -> LearnedSearchAI with original budgets",
    [6, 7].every((l) => { const a = AI.makeAI("A", l, false, 1); return a instanceof AI.LearnedSearchAI && a.level.timeBudget === AI.LEVELS[l].timeBudget; }));
  check("makeAI: levels 1-5 stay MinimaxAI",
    [1, 2, 3, 4, 5].every((l) => { const a = AI.makeAI("A", l, false, 1); return a.constructor === AI.MinimaxAI; }));
  // 達人 = 最強と同じ探索(MinimaxAI・深さ5)で思考時間だけ2秒。選択肢では上級と最強の間
  const tatsu = AI.makeAI("A", 8, false, 1), saikyo = AI.LEVELS[5];
  check("makeAI: 達人(8) is 最強 with a 2s budget",
    tatsu.constructor === AI.MinimaxAI && tatsu.level.name === "達人" && tatsu.level.timeBudget === 2000
    && ["maxDepth", "blunderRate", "useTT", "ttSize"].every((k) => tatsu.level[k] === saikyo[k]));
  check("LEVEL_ORDER lists every level once, 達人 between 上級 and 最強",
    AI.LEVEL_ORDER.slice().sort().join() === Object.keys(AI.LEVELS).sort().join()
    && AI.LEVEL_ORDER.indexOf(8) === AI.LEVEL_ORDER.indexOf(4) + 1 && AI.LEVEL_ORDER.indexOf(5) === AI.LEVEL_ORDER.indexOf(8) + 1);
  {
    const e = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 1, wallSandwich: true, contactLimit: 3 }));
    const t0 = Date.now();
    const act = AI.makeAI("A", 8, false, 1).chooseAction(e);
    const ms = Date.now() - t0;
    check(`達人 returns a legal move within ~2s (${ms}ms)`,
      !!act && AI.generateActions(e, "A").some((a) => AI.actionEquals(a, act)) && ms < 2600, ms);
  }
})();

// ---- 9b. 学習型AI: 局所パターン評価 ----
// 盤を回転・反転しても評価(特徴量の線形和 + 局所パターン)が変わらないこと、
// 奥義の重みに 55 クラス分のパターンの重みが入っていることを確かめる(究極・神は据え置き)。
(function () {
  check("pattern classes: 55 classes", new Set(Array.from(AI.PAT_CLASS)).size === AI.PAT_N && AI.PAT_N === 55);
  const W = AI.LEARNED_WEIGHTS_TEMPLATE;
  check("奥義の重みに局所パターン(pat_s / pat_o 各55)が入っている",
    Array.isArray(W.pat_s) && W.pat_s.length === AI.PAT_N && Array.isArray(W.pat_o) && W.pat_o.length === AI.PAT_N);
  check("究極・神の重みは局所パターンなし(据え置き)", !AI.LEARNED_WEIGHTS_GENERIC.pat_s);
  check("パターンの重みがあるときだけ表を作る",
    AI.makeAI("A", 7, true, 1)._patTabs !== null && AI.makeAI("A", 7, false, 1)._patTabs === null);
  const syms = [
    (r, c, n) => [c, r], (r, c, n) => [n - 1 - r, c], (r, c, n) => [r, n - 1 - c],
    (r, c, n) => [n - 1 - c, n - 1 - r], (r, c, n) => [n - 1 - r, n - 1 - c],
  ];
  let bad = 0, n = 0;
  const w = AI.LEARNED_WEIGHTS_TEMPLATE;
  // 壁なしの盤(盤外の番兵が 4)でもパターンの表引きが対称になることを確かめる
  for (const cfgOpts of [{ rows: 7, cols: 7, moveRange: 3, stockPerPlayer: 15, wallSandwich: true, contactLimit: 3 },
    { rows: 6, cols: 6, moveRange: 2, wallSandwich: false, contactLimit: null }]) {
    for (let g = 0; g < 8; g++) {
      const e = new H.GameEngine(H.makeConfig(cfgOpts));
      let s = 31 + g; const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      for (let ply = 0; ply < 50 && !e.isOver(); ply++) {
        const l = AI.generateActions(e, e.currentPlayer);
        AI.applyAction(e, e.currentPlayer, l[Math.floor(rand() * l.length)]);
        if (e.isOver()) break;
        const ai = new AI.LearnedSearchAI(e.currentPlayer, "t", null, w, 1);
        const v0 = ai._evaluate(new AI.FastState(e), 0, 1);
        for (const f of syms) {
          const e2 = new H.GameEngine(e.config);
          for (const [id, p] of e.pieces) {
            const pos = f(p.position[0], p.position[1], e.config.rows);
            e2.pieces.set(id, { id, player: p.player, position: pos }); e2.board.set(pos.join(","), id);
          }
          e2._nextPieceId = e._nextPieceId; e2.stock = Object.assign({}, e.stock);
          e2.currentPlayer = e.currentPlayer; e2.obligated = { A: e.obligated.A.slice(), B: e.obligated.B.slice() };
          const v1 = ai._evaluate(new AI.FastState(e2), 0, 1);
          n++;
          if (Math.abs(v0 - v1) > 1e-6) { bad++; if (bad < 3) console.log("   asym", g, ply, v0, v1); }
        }
      }
    }
  }
  check(`learned eval (with patterns) is symmetric under board rotations/reflections (${n} checks)`, bad === 0);
})();

// ---- 10. 学習型AI: 千日手の入口(一度現れた局面へ戻る手)を避ける ----
(function () {
  // 左右対称の局面で (3,2) と (3,4) は同じ評価。(3,2) へ動いた後の局面だけを
  // 「すでに1度出現した」ことにしておくと、学習型AIは (3,2) へは戻らないはず。
  let ok = true;
  for (let seed = 1; seed <= 6 && ok; seed++) {
    const e = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 1, stockPerPlayer: 0, wallSandwich: true, contactLimit: null }));
    e.pieces.set(1, { id: 1, player: "A", position: [3, 3] }); e.board.set("3,3", 1);
    e.pieces.set(2, { id: 2, player: "B", position: [6, 3] }); e.board.set("6,3", 2);
    e._nextPieceId = 3;
    const seen = e.clone();
    seen.movePiece("A", 1, [3, 2]);
    e._stateHistory.set(seen._stateKey(), 1);
    const ai = AI.makeAI("A", 7, false, seed);
    ai.level = Object.assign({}, ai.level, { timeBudget: 300 });
    const a = ai.chooseAction(e);
    if (a && a[0] === "move" && a[2][0] === 3 && a[2][1] === 2) ok = false;
  }
  check("learned AI avoids stepping back into an already-seen position", ok);
})();

// ---- 10b. 詰み探索(MinimaxAI): 読みの深さ以内の詰みを確実に指す(Python 版 9l と同じ局面) ----
(function () {
  const put = (e, id, player, r, c) => { e.pieces.set(id, { id, player, position: [r, c] }); e.board.set(r + "," + c, id); e._nextPieceId = Math.max(e._nextPieceId, id + 1); };
  const same = (a, b) => !!a && AI.actionEquals(a, b);
  // (1) 挟む1手詰め
  let e = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 1, stockPerPlayer: 0, wallSandwich: true, contactLimit: null }));
  put(e, 1, "B", 0, 0); put(e, 2, "A", 1, 0); put(e, 3, "A", 0, 2); put(e, 4, "B", 4, 4);
  check("mate search finds a sandwiching mate in 1", same(AI.findForcedWin(e, 1), ["move", 3, [0, 1]]));
  // (2) 挟まない1手詰め: 義務を背負った B の (3,3) の最後の逃げ道 (3,4) をふさぐ
  e = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 1, stockPerPlayer: 0, wallSandwich: true, contactLimit: null }));
  put(e, 1, "B", 3, 3); put(e, 2, "A", 2, 3); put(e, 3, "A", 4, 3); put(e, 4, "B", 3, 2); put(e, 5, "A", 3, 5); put(e, 6, "B", 6, 6);
  e.obligated.B = [1];
  check("mate search finds a blocking (non-sandwich) mate in 1", same(AI.findForcedWin(e, 1), ["move", 5, [3, 4]]));
  check("上級 MinimaxAI plays a mate within its depth", same(new AI.MinimaxAI("A", 4, 0).chooseAction(e), ["move", 5, [3, 4]]));
  check("mate search leaves the position unchanged", e.pieces.get(5).position[1] === 5 && e.obligated.B.length === 1);
  // (3) 実戦に出た3手詰め(B4→C4)。1手詰めはない
  e = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 3, wallSandwich: true, contactLimit: 3 }));
  e.stock.A = 15; e.stock.B = 15;
  for (const [fr, to] of [["", "E5"], ["", "D6"], ["", "C3"], ["", "B3"], ["", "D4"], ["", "E3"], ["", "D2"], ["", "C2"], ["D2", "D3"], ["", "B4"], ["D3", "D2"]]) {
    const cur = e.currentPlayer;
    AI.applyAction(e, cur, AI.generateActions(e, cur).find((a) => { const l = AI.actionLabels(e, a); return l[0] === fr && l[1] === to; }));
  }
  check("mate search: no mate in 1 here", AI.findForcedWin(e, 1) === null);
  const w3 = AI.findForcedWin(e, 3);
  check("mate search finds the mate in 3 (B4-C4)", !!w3 && AI.actionLabels(e, w3).join("-") === "B4-C4", w3);
  // GameEngine だけで確かめる: どう受けても次の1手で勝てる
  let sound = !!w3;
  if (w3) {
    const c = e.clone(); AI.applyAction(c, "B", w3);
    for (const reply of AI.generateActions(c, c.currentPlayer)) {
      const d = c.clone(); AI.applyAction(d, d.currentPlayer, reply);
      if (d.isOver()) { if (d.winner !== "B") sound = false; continue; }
      if (!AI.generateActions(d, "B").some((a) => { const x = d.clone(); AI.applyAction(x, "B", a); return x.winner === "B"; })) sound = false;
    }
  }
  check("the mate in 3 is sound when replayed on GameEngine", sound);
  check("mate plies per level stay within each level's depth",
    [1, 2, 3, 4, 8, 5].map((k) => AI.LEVELS[k].matePlies).join() === "0,1,1,3,5,5");
})();

// ---- 10c. 静止探索(MinimaxAI): 末端で義務を背負った側は逃げ方まで読んでから評価(Python 版 9m と同じ) ----
(function () {
  const put = (e, id, player, r, c) => { e.pieces.set(id, { id, player, position: [r, c] }); e.board.set(r + "," + c, id); e._nextPieceId = Math.max(e._nextPieceId, id + 1); };
  const e = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 1, stockPerPlayer: 0, wallSandwich: true, contactLimit: null }));
  put(e, 1, "B", 3, 3); put(e, 2, "A", 2, 3); put(e, 3, "A", 4, 3); put(e, 4, "B", 6, 6);
  e.obligated.B = [1];
  e.currentPlayer = "B";
  const ai = new AI.MinimaxAI("A", 4, 0);
  const expected = AI.generateActions(e, "B").map((a) => { const c = e.clone(); AI.applyAction(c, "B", a); return ai._evaluate(c); });
  const got = ai._minimax(e, 0, -Infinity, Infinity, 0);
  check("quiescence: leaf value = min over the obligated piece's escapes", Math.abs(got - Math.min(...expected)) < 1e-9, [got, expected]);
  const flat = new AI.MinimaxAI("A", 4, 0);
  flat.level = Object.assign({}, flat.level, { quiesce: 0 });
  check("quiescence off: leaf is evaluated as is", Math.abs(flat._minimax(e, 0, -Infinity, Infinity, 0) - flat._evaluate(e)) < 1e-9);
  check("quiescence only for 初級 and 上級 (odd depth, finishes within the budget)",
    [1, 2, 3, 4, 8, 5].map((k) => AI.LEVELS[k].quiesce || 0).join() === "0,2,0,2,0,0");
})();

// ---- 11. 詰めピンチ: ソルバーを GameEngine だけで書いた素朴な参照実装と突き合わせる ----
// tsume.js は FastState(指す→戻す)と置換表で速く読むが、ここでは clone() と
// engine.winner だけを使う独立した実装で同じ「最短手数」になることを確かめる。
const T = require("./tsume.js");
const TD = require("./tsume-data.js");

function refDistance(engine, solver, maxPlies, quiet) {
  // 返り値: 最短手数(maxPlies 以内に詰まなければ null)。path は同一局面への戻り検出用
  function or(e, d, q, path) {
    const key = e._stateKey();
    if (path.has(key)) return false;
    path.add(key);
    let ok = false;
    for (const a of AI.generateActions(e, e.currentPlayer)) {
      const c = e.clone();
      const res = AI.applyAction(c, e.currentPlayer, a);
      const cap = res.newlySandwiched.length > 0;
      if (!cap && q === 0) continue;
      if (c.winner === solver) { ok = true; break; }
      if (c.isOver() || d < 3) continue;
      if (and(c, d - 1, cap ? q : q - 1, path)) { ok = true; break; }
    }
    path.delete(key);
    return ok;
  }
  function and(e, d, q, path) {
    const key = e._stateKey();
    if (path.has(key)) return false;
    path.add(key);
    let ok = true;
    for (const a of AI.generateActions(e, e.currentPlayer)) {
      const c = e.clone();
      AI.applyAction(c, e.currentPlayer, a);
      if (c.isOver() || !or(c, d - 1, q, path)) { ok = false; break; }
    }
    path.delete(key);
    return ok;
  }
  for (let d = 1; d <= maxPlies; d += 2) if (or(engine, d, quiet, new Set())) return d;
  return null;
}

(function () {
  // 学習型AIの速い自己対戦から局面を集め、1〜5手の範囲で参照実装と一致するか
  const rng = T.mulberry32(20260927);
  let compared = 0, mates = 0, mismatch = null;
  for (let g = 0; g < 6 && !mismatch; g++) {
    const e = new H.GameEngine(H.makeConfig({ rows: 5, cols: 5, moveRange: 3, contactLimit: 3, wallSandwich: true, stockPerPlayer: 8 }));
    const ais = { A: new AI.LearnedSearchAI("A", "t", 15, AI.LEARNED_WEIGHTS_GENERIC, g * 2 + 1),
      B: new AI.LearnedSearchAI("B", "t", 15, AI.LEARNED_WEIGHTS_GENERIC, g * 2 + 2) };
    for (let ply = 0; ply < 70 && !e.isOver() && !mismatch; ply++) {
      const p = e.currentPlayer;
      const acts = AI.generateActions(e, p);
      AI.applyAction(e, p, ply < 3 || rng() < 0.15 ? acts[Math.floor(rng() * acts.length)] : ais[p].chooseAction(e));
      if (e.isOver() || ply < 8) continue;
      for (const quiet of [0, 1]) {
        const maxPlies = quiet ? 3 : 5;
        const fast = new T.TsumeSolver(e, e.currentPlayer, { quiet }).distance(maxPlies);
        const fresh = e.clone();
        fresh._stateHistory = new Map(); // 実戦の千日手カウントは両実装とも見ない
        const ref = refDistance(fresh, e.currentPlayer, maxPlies, quiet);
        compared++;
        if (fast != null) mates++;
        if (fast !== ref) mismatch = { ply, quiet, fast, ref, pos: T.positionFromEngine(e) };
      }
    }
  }
  check(`tsume solver matches the clone-based reference (${compared} cases, ${mates} mates)`, !mismatch && mates > 0,
    JSON.stringify(mismatch));
})();

// ---- 12. 詰めピンチ: 問題データの品質(全問を独立に再検証) ----
(function () {
  const bad = [];
  const keys = new Set();
  for (const pz of TD.PUZZLES) {
    const why = [];
    const e = T.engineFromPosition(pz.position);
    const solver = pz.position.currentPlayer;
    if (e.isOver()) why.push("already over");
    if (!T.isNatural(e)) why.push("unnatural");
    const key = T.canonicalKey(pz.position);
    if (keys.has(key)) why.push("duplicate");
    keys.add(key);
    // 最短手数と唯一解
    const info = T.analyze(e, solver, pz.par, { quiet: pz.quiet });
    if (!info || info.par !== pz.par) why.push(`par ${info && info.par} != ${pz.par}`);
    else if (pz.par >= 3 && !info.unique) why.push("not unique");
    if (pz.quiet && T.analyze(e, solver, pz.par, { quiet: 0 })) why.push("solvable without quiet move");
    if (!pz.quiet && info && info.rootChecks < 2) why.push("only one check at root");
    // 主手順を素のエンジンで並べ直す: 攻めは挟む手(静かな手は quiet 回まで)、最後は攻め方の勝ち
    const r = e.clone();
    let quietUsed = 0;
    if (pz.line.length !== pz.par) why.push("line length");
    for (const label of pz.line) {
      const mover = r.currentPlayer;
      const action = T.actionFromLabel(r, label);
      if (!action) { why.push(`bad label ${label}`); break; }
      let res;
      try { res = AI.applyAction(r, mover, action); } catch (err) { why.push(`illegal ${label}`); break; }
      if (mover === solver && !res.newlySandwiched.length) quietUsed++;
    }
    if (quietUsed > pz.quiet) why.push("too many quiet moves");
    if (r.winner !== solver) why.push("line does not mate");
    if (why.length) bad.push(`${pz.id}: ${why.join(", ")}`);
  }
  check(`all ${TD.PUZZLES.length} puzzles re-verified (par, uniqueness, legal mating line)`, bad.length === 0, bad.join(" / "));
  const cats = new Set(TD.CATEGORIES.map((c) => c.key));
  check("every puzzle belongs to a known category", TD.PUZZLES.every((p) => cats.has(p.category)));
})();

// ---- 13. 詰めピンチ: 対局画面と同じ手順(ヒント→最長抵抗の受け)で必ず詰み、悪手には逃れを返す ----
(function () {
  let ok = true, detail = "";
  for (const pz of TD.PUZZLES.filter((p, i) => i % 5 === 0)) {
    const e = T.engineFromPosition(pz.position);
    const solver = pz.position.currentPlayer;
    let plies = 0, quietLeft = pz.quiet;
    while (!e.isOver() && plies < pz.par + 2) {
      if (e.currentPlayer === solver) {
        const h = T.hintFor(e, solver, quietLeft, pz.par - plies);
        if (!h) { ok = false; detail = `${pz.id}: no hint at ply ${plies}`; break; }
        if (h.quiet) quietLeft--;
        AI.applyAction(e, solver, h.move);
      } else {
        const d = T.defendFor(e, solver, quietLeft, pz.par - plies);
        if (!d || !d.proven) { ok = false; detail = `${pz.id}: defender escaped at ply ${plies}`; break; }
        AI.applyAction(e, e.currentPlayer, d.move);
      }
      plies++;
    }
    if (ok && (e.winner !== solver || plies !== pz.par)) { ok = false; detail = `${pz.id}: mated in ${plies}, par ${pz.par}`; }
    if (!ok) break;
  }
  check("hint + longest-resistance defence mates exactly in par", ok, detail);

  // 3手以上の問題で、初手に「詰まない挟む手」を指すと受け方は逃れの手を返す
  let tested = 0, escaped = 0;
  for (const pz of TD.PUZZLES.filter((p) => p.par >= 3 && !p.quiet)) {
    const e = T.engineFromPosition(pz.position);
    const solver = pz.position.currentPlayer;
    const s = new T.TsumeSolver(e, solver, {});
    const wrong = s.rankChecks(pz.par + 2).find((x) => x.plies == null); // 最短+2手まではクリア扱いなので、それでも詰まない手
    if (!wrong) continue;
    AI.applyAction(e, solver, s.toAction(wrong.code));
    if (e.isOver()) continue;
    tested++;
    const d = T.defendFor(e, solver, 0, pz.par + 2 - 1);
    if (d && !d.proven) escaped++;
  }
  check(`wrong first move lets the defender escape (${escaped}/${tested})`, tested > 0 && escaped === tested);
})();

// ---- 14. 詰めピンチ: 局面データは移動義務まで往復で保たれる ----
(function () {
  const e = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 3, wallSandwich: true, contactLimit: 3 }));
  e.pieces.set(4, { id: 4, player: "B", position: [3, 0] }); e.board.set("3,0", 4);
  e.pieces.set(9, { id: 9, player: "A", position: [3, 2] }); e.board.set("3,2", 9);
  e._nextPieceId = 10;
  e.movePiece("A", 9, [3, 1]); // 壁挟み → B の駒に移動義務
  const back = T.engineFromPosition(T.positionFromEngine(e));
  check("position round-trip keeps obligations", back.obligated.B.length === 1
    && back.pieces.get(back.obligated.B[0]).position.join() === "3,0" && back.currentPlayer === "B");
})();

// ---- 15. 形勢表示: 読み切り・終局・通常局面の値(Python版 test_engine 9h と同じ局面) ----
(function () {
  // B の駒(0,0)は角。A が (0,2)→(0,1) と動けば (0,0) は逃げ場がなくなり A の勝ち(1手で決着)
  const e = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 1, stockPerPlayer: 10, wallSandwich: true, contactLimit: null }));
  [[1, "B", [0, 0]], [2, "A", [1, 0]], [3, "A", [0, 2]], [4, "B", [4, 4]]].forEach(([id, player, pos]) => {
    e.pieces.set(id, { id, player, position: pos }); e.board.set(pos.join(","), id);
  });
  e._nextPieceId = 5;
  e.currentPlayer = "A";
  e.stock.A = 0; e.stock.B = 0;
  const r = AI.evaluatePosition(e, false, 300);
  check("eval: A's forced win is read out (mate A in 1)", r && r.mate === "A" && r.matePlies === 1 && r.winA > 0.999, JSON.stringify(r));
  check("eval: reading does not change the position", e.currentPlayer === "A" && e.board.size === 4
    && e.pieces.get(3).position.join() === "0,2" && !e.winner);
  AI.applyAction(e, "A", ["move", 3, [0, 1]]);
  const fin = AI.evaluatePosition(e, false, 300);
  check("eval: finished game reports the winner at 100%", e.winner === "A" && fin.final && fin.winA === 1 && fin.mate === "A", JSON.stringify(fin));

  const e0 = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 3, wallSandwich: true, contactLimit: 3 }));
  e0.stock.A = 15; e0.stock.B = 15;
  const r0 = AI.evaluatePosition(e0, true, 200);
  check("eval: opening position is a sane win rate with depth >= 1", r0 && !r0.final && r0.winA > 0.2 && r0.winA < 0.8 && r0.depth >= 1, JSON.stringify(r0));
  check("eval: win rate = sigmoid(score/100)", Math.abs(AI.winRateFromScore(100) - 1 / (1 + Math.exp(-1))) < 1e-12 && AI.winRateFromScore(0) === 0.5);
})();

// ---- 16. 感想戦: 解析と悪手判定(Python版 test_engine 9j と同じ基準) ----
(function () {
  const e = new H.GameEngine(H.makeConfig({ rows: 7, cols: 7, moveRange: 1, stockPerPlayer: 10, wallSandwich: true, contactLimit: null }));
  [[1, "B", [0, 0]], [2, "A", [1, 0]], [3, "A", [0, 2]], [4, "B", [4, 4]]].forEach(([id, player, pos]) => {
    e.pieces.set(id, { id, player, position: pos }); e.board.set(pos.join(","), id);
  });
  e._nextPieceId = 5;
  e.currentPlayer = "A";
  e.stock.A = 0; e.stock.B = 0;
  const r = AI.analyzePosition(e, false, 300);
  check("analyze: best move label and legal move count", r && r.best && r.best[0] === "C1" && r.best[1] === "B1"
    && r.nActs === AI.generateActions(e, "A").length && r.nActs > 1, JSON.stringify(r));

  const pos = (winA, best, nActs) => ({ winA, best: best || null, nActs: nActs == null ? 5 : nActs });
  let j = AI.judgeMove(pos(0.70, ["C3", "C4"]), pos(0.35), "A", ["D4", "D5"]);
  check("judge: 70% -> 35% for A is 大悪手 (??)", j.label === "大悪手" && j.mark === "??" && Math.abs(j.loss - 0.35) < 1e-9);
  j = AI.judgeMove(pos(0.70), pos(0.52), "A", ["", "D4"]);
  check("judge: an 18% drop is 悪手 (?)", j.label === "悪手" && j.mark === "?");
  j = AI.judgeMove(pos(0.40), pos(0.50), "B", ["", "D4"]);
  check("judge: B's drop 60% -> 50% is 疑問手 (?!)", j.label === "疑問手" && Math.abs(j.before - 0.6) < 1e-9);
  j = AI.judgeMove(pos(0.70, ["D4", "D5"]), pos(0.40), "A", ["D4", "D5"]);
  check("judge: the AI's best move costs nothing", j.isBest && j.loss === 0 && j.label === null);
  j = AI.judgeMove(pos(0.70, null, 1), pos(0.40), "A", ["D4", "D5"]);
  check("judge: a forced move costs nothing", j.forced && j.loss === 0 && j.label === null);
  check("judge thresholds match Python (30% / 15% / 8%)",
    AI.MOVE_JUDGE_LEVELS.map((l) => `${l.min}${l.label}${l.mark}`).join() === "0.3大悪手??,0.15悪手?,0.08疑問手?!");
})();

// ---- 17. チュートリアル: 全レッスンの模範手順で課題を達成でき、✕のマスは本当に置けない ----
// (Python版 test_engine 9k と同じ確認。画面と同じ tutorial.js の判定を使う)
(function () {
  const C = require("./content.js");
  const TU = require("./tutorial.js");
  const lessons = C.TUTORIAL_LESSONS;
  check("tutorial: 12 lessons, last one is the finale", lessons.length === 12 && lessons[11].finale && !lessons[11].board);
  lessons.forEach((L, li) => {
    if (!L.board) return;
    const name = `tutorial ${li + 1}「${L.title}」`;
    check(`${name}: board rows match size`, L.board.rows.length === L.board.size && L.board.rows.every((r) => r.length === L.board.size));
    const e = TU.buildEngine(L.board);
    let ok = true, why = "";
    L.steps.forEach((step, si) => {
      if (!ok) return;
      if (step.pre) { const a = TU.resolveAction(e, "B", step.pre); TU.playAs(e, "B", a); }
      const sol = step.solution;
      if (step.goal === "select") {
        const p = e.pieceAt(H.posFromLabel(sol[1]));
        if (!p || p.player !== "A" || !e.legalMoves(p.id).length) { ok = false; why = `step${si + 1} select`; }
        return;
      }
      if (step.goal === "tryBad") {
        const legal = new Set(e.legalPlacements("A").map(H.posKey));
        for (const lb of step.marks) {
          const pos = H.posFromLabel(lb);
          if (legal.has(H.posKey(pos)) || e.pieceAt(pos) || !TU.placementBlockReason(e, "A", pos)) { ok = false; why = `mark ${lb} is placeable`; }
        }
        return;
      }
      if (step.goal === "escape") {
        // 連鎖するマス(C2)へ入ると義務が続き、模範手(C4)なら義務が消える
        const trap = e.clone();
        const pid = trap.obligated.A[0];
        const res = TU.playAs(trap, "A", { kind: "move", pieceId: pid, from: null, to: [1, 2] });
        if (TU.judgeStep(step, trap, { kind: "move", to: [1, 2] }, res) !== "chain") { ok = false; why = "escape trap is not a chain"; }
      }
      const act = TU.resolveAction(e, "A", sol);
      const legal = act.kind === "place"
        ? e.legalPlacements("A").some((p) => p[0] === act.to[0] && p[1] === act.to[1])
        : act.pieceId != null && e.obligated.A.every((id) => id === act.pieceId) && e.legalMoves(act.pieceId).some((p) => p[0] === act.to[0] && p[1] === act.to[1]);
      if (!legal) { ok = false; why = `step${si + 1} solution illegal ${sol}`; return; }
      // 1手で届かない「reach」は、前のステップの模範手から続けて届く
      const res = TU.playAs(e, "A", act);
      const v = TU.judgeStep(step, e, act, res);
      if (v !== "success") { ok = false; why = `step${si + 1} verdict ${v}`; return; }
      if (step.reply && !e.isOver()) {
        const r = TU.resolveAction(e, "B", step.reply);
        const legalR = r.kind === "place" ? r.to != null
          : r.pieceId != null && e.legalMoves(r.pieceId).some((p) => p[0] === r.to[0] && p[1] === r.to[1]);
        if (!legalR) { ok = false; why = `step${si + 1} reply illegal`; return; }
        TU.playAs(e, "B", r);
      } else {
        TU.passBack(e);
      }
      if (e.winner === "B") { ok = false; why = `step${si + 1} you lost`; }
    });
    check(`${name}: model solution clears every step`, ok, why);
  });

  // 「win」のレッスンは模範手以外では勝てない(簡単すぎ・別解なしを確認)
  lessons.forEach((L, li) => {
    const step = L.steps[0];
    if (step.goal !== "win") return;
    const e = TU.buildEngine(L.board);
    const wins = AI.generateActions(e, "A").filter((a) => {
      const c = e.clone(); AI.applyAction(c, "A", a); return c.winner === "A";
    });
    check(`tutorial ${li + 1}: exactly one winning move`, wins.length === 1, wins.length);
  });

  // 指せない理由の文言
  const e = TU.buildEngine(lessons[7].board);
  check("tutorial reason: self-sandwich placement", /C3とE3の間/.test(TU.placementBlockReason(e, "A", H.posFromLabel("D3"))));
  check("tutorial reason: placing to sandwich", /D5をC5と挟む/.test(TU.placementBlockReason(e, "A", H.posFromLabel("E5"))));
  const e2 = TU.buildEngine(lessons[10].board);
  check("tutorial reason: contact limit", /4個になり、接触制限\(3個まで\)/.test(TU.placementBlockReason(e2, "A", H.posFromLabel("E4"))));
  const e3 = TU.buildEngine(lessons[2].board);
  const mover = e3.pieceAt(H.posFromLabel("D4"));
  check("tutorial reason: diagonal / blocked / too far", /斜め/.test(TU.moveBlockReason(e3, mover, [2, 2]))
    && /途中のD6/.test(TU.moveBlockReason(e3, mover, [6, 3])) && /移動範囲の2マス/.test(TU.moveBlockReason(e3, mover, [3, 6])));
  const e4 = TU.buildEngine(lessons[8].board);
  e4.stock.A = 3;
  check("tutorial reason: placing next to an edge piece sandwiches it with the wall",
    /相手のC1を盤の端と挟む/.test(TU.placementBlockReason(e4, "A", H.posFromLabel("C2")) || ""));
  check("tutorial reason: no stock", /持ち駒が残っていない/.test(TU.placementBlockReason(TU.buildEngine(lessons[8].board), "A", [3, 3])));
})();

// ---- 18. レート: 計算式(rating.js) ----
(function () {
  const RT = require("./rating.js");
  const keys = Object.keys(RT.LEVELS).sort();
  check("rating: every AI level (and 奥義) has a rating", keys.join() === AI.LEVEL_ORDER.map(String).concat(["S"]).sort().join());
  const L = RT.LEVELS;
  check("rating: weaker levels rate lower (ランダム < 初級 < 中級 < 上級 < 最強 < 究極)",
    L[1] < L[2] && L[2] < L[3] && L[3] < L[4] && L[4] < L[5] && L[5] < L[6], JSON.stringify(L));
  check("rating: ランダム is the anchor at 0", L[1] === 0);
  check("rating: result performance is ±400 around the opponent",
    RT.resultPerformance(1200, "win") === 1600 && RT.resultPerformance(1200, "loss") === 800 && RT.resultPerformance(1200, "draw") === 1200);
  const q1 = RT.qualityPerformance(0.01), q5 = RT.qualityPerformance(0.05), q20 = RT.qualityPerformance(0.2);
  check("rating: smaller average loss means higher quality performance", q1 > q5 && q5 > q20, [q1, q5, q20].join());
  const lv = Object.values(L);
  check("rating: quality performance stays within the level range ±200",
    RT.qualityPerformance(0) <= Math.max(...lv) + 200 && RT.qualityPerformance(5) >= Math.min(...lv) - 200);
  const first = RT.rate([], "3", "win", 0.05);
  check("rating: the first game's rating is its performance (provisional)",
    first.before === null && first.after === first.perf && first.provisional && first.perf === Math.round((first.resultPerf + first.qualityPerf) / 2));
  const five = [1100, 1200, 1000, 1300, 1150].map((v) => ({ perf: v, after: 1150 }));
  const sixth = RT.rate(five, "4", "loss", 0.08);
  check("rating: after the provisional games the rating moves 20% toward the performance",
    sixth.before === 1150 && Math.abs(sixth.after - (1150 + 0.2 * (sixth.perf - 1150))) <= 1 && !sixth.provisional);
  const third = RT.rate(five.slice(0, 2), "4", "draw", 0.08);
  check("rating: during the provisional games the rating is the mean performance",
    Math.abs(third.after - (1100 + 1200 + third.perf) / 3) <= 1);
  check("rating: nearest level", RT.nearestLevel(L[4] + 1)[0] === "4");
})();

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
