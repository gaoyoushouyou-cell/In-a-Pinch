/*!
 * ai-worker.js — AIの思考をメイン画面から切り離して行う Web Worker。
 *
 * レベル『神』や特化AI「奥義」は1手に最大30秒かけて読むことがあるため、
 * メインスレッドで実行すると画面が固まってしまう。そこでこの Worker の中で
 * 探索を行い、結果だけを postMessage で画面側に返す。
 *
 * 詰めピンチ(kind: "tsume")の受け・ヒント・新作の自動生成もここで行う。
 *
 * postMessage は構造化複製(structured clone)アルゴリズムを使うため、
 * Map や配列はそのまま送受信できる(JSON化は不要)。
 */
importScripts("engine.js?v=3", "ai.js?v=10", "tsume.js?v=1");

self.onmessage = function (e) {
  if (e.data.kind === "tsume") { handleTsume(e.data); return; }
  if (e.data.kind === "eval" || e.data.kind === "analyze") { handleEval(e.data); return; }
  if (e.data.kind === "study") { handleStudy(e.data); return; }
  if (e.data.kind === "score") { handleScore(e.data); return; }
  const { reqId, config, state, player, level, specialist, seed, timeBudget } = e.data;
  try {
    const engine = rebuildEngine(config, state);
    // 奥義・究極・神は学習型探索AI、初級〜最強は従来の MinimaxAI(ai.js の makeAI 参照)
    const ai = self.HasamiAI.makeAI(player, level, specialist, seed, timeBudget);
    const t0 = Date.now();
    const action = ai.chooseAction(engine);
    const elapsed = Date.now() - t0;
    postMessage({ reqId, ok: true, action, elapsed, nodes: ai.nodesVisited });
  } catch (err) {
    postMessage({ reqId, ok: false, error: String((err && err.message) || err) });
  }
};

function handleTsume(d) {
  const T = self.HasamiTsume;
  try {
    let result;
    if (d.op === "generate") {
      result = T.generatePuzzle(Object.assign({}, d.opts, {
        deadline: Date.now() + d.opts.timeLimit,
        onProgress: (games) => postMessage({ reqId: d.reqId, progress: games }),
      }));
    } else {
      const engine = rebuildEngine(d.config, d.state);
      result = d.op === "hint"
        ? T.hintFor(engine, d.solver, d.quietLeft, d.maxPlies)
        : T.defendFor(engine, d.solver, d.quietLeft, d.maxPlies);
    }
    postMessage({ reqId: d.reqId, ok: true, result });
  } catch (err) {
    postMessage({ reqId: d.reqId, ok: false, error: String((err && err.message) || err) });
  }
}

// 対局中の形勢表示(kind: "eval")と感想戦の解析(kind: "analyze")。対局用の Worker とは
// 別の Worker で動かす(app.js の requestEval)
function handleEval(d) {
  try {
    const engine = rebuildEngine(d.config, d.state);
    const A = self.HasamiAI;
    const result = d.kind === "analyze"
      ? A.analyzePosition(engine, d.template, d.timeBudget)
      : A.evaluatePosition(engine, d.template, d.timeBudget);
    postMessage({ reqId: d.reqId, ok: true, result });
  } catch (err) {
    postMessage({ reqId: d.reqId, ok: false, error: String((err && err.message) || err) });
  }
}

// 感想戦の検討(kind: "study")。op "deep" = 1局面をじっくり読む、"mateTree" = 詰み手順の樹形図。
// 感想戦の解析とは別の Worker で動かす(app.js の requestStudy)
function handleStudy(d) {
  try {
    const engine = rebuildEngine(d.config, d.state);
    const A = self.HasamiAI;
    const result = d.op === "deep"
      ? A.deepAnalyze(engine, d.template, d.timeBudget)
      : A.buildMateTree(engine, d.winner, d.plies, d.path);
    postMessage({ reqId: d.reqId, ok: true, result });
  } catch (err) {
    postMessage({ reqId: d.reqId, ok: false, error: String((err && err.message) || err) });
  }
}

// 感想戦の採点(kind: "score")。op "all" = 局面の指せる手をすべて読んで並べる(途中経過を progress で送る)、
// "rescore" = 1手だけを読み直す。採点専用の Worker で動かす(app.js の requestScore)
function handleScore(d) {
  try {
    const engine = rebuildEngine(d.config, d.state);
    const A = self.HasamiAI;
    const result = d.op === "rescore"
      ? A.rescoreMove(engine, d.template, d.label, d.deepBudget)
      : A.scoreAllMoves(engine, d.template, {
        focus: d.focus,
        onProgress: (stage, done, total) => postMessage({ reqId: d.reqId, progress: { stage, done, total } }),
      });
    postMessage({ reqId: d.reqId, ok: true, result });
  } catch (err) {
    postMessage({ reqId: d.reqId, ok: false, error: String((err && err.message) || err) });
  }
}

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
