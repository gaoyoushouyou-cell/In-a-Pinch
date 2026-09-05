/*!
 * ai-worker.js — AIの思考をメイン画面から切り離して行う Web Worker。
 *
 * レベル『神』や特化AI「奥義」は1手に最大30秒かけて読むことがあるため、
 * メインスレッドで実行すると画面が固まってしまう。そこでこの Worker の中で
 * 探索を行い、結果だけを postMessage で画面側に返す。
 *
 * postMessage は構造化複製(structured clone)アルゴリズムを使うため、
 * Map や配列はそのまま送受信できる(JSON化は不要)。
 */
importScripts("engine.js", "ai.js");

self.onmessage = function (e) {
  const { reqId, config, state, player, level, specialist, seed, timeBudget } = e.data;
  try {
    const engine = rebuildEngine(config, state);
    const ai = specialist
      ? new self.HasamiAI.TemplateSpecialistAI(player, seed, timeBudget)
      : new self.HasamiAI.MinimaxAI(player, level, seed);
    const t0 = Date.now();
    const action = ai.chooseAction(engine);
    const elapsed = Date.now() - t0;
    postMessage({ reqId, ok: true, action, elapsed, nodes: ai.nodesVisited });
  } catch (err) {
    postMessage({ reqId, ok: false, error: String((err && err.message) || err) });
  }
};

function rebuildEngine(config, state) {
  const engine = Object.create(self.Hasami.GameEngine.prototype);
  engine.config = config;
  engine.board = new Map(state.board);
  engine.pieces = new Map(state.pieces.map((p) => [p.id, { id: p.id, player: p.player, position: p.position.slice() }]));
  engine._nextPieceId = state.nextPieceId;
  engine.stock = Object.assign({}, state.stock);
  engine.currentPlayer = state.currentPlayer;
  engine.obligated = { A: state.obligated.A.slice(), B: state.obligated.B.slice() };
  engine.winner = state.winner;
  engine.isDraw = state.isDraw;
  engine._stateHistory = new Map(state.stateHistory);
  return engine;
}
