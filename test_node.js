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

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
