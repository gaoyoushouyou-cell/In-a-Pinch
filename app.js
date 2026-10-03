/*!
 * app.js — 画面遷移・盤面描画・操作ロジック(In_a_Pinch_app_5.py の GUI 部分の移植)
 */
(function () {
  "use strict";

  const H = window.Hasami;
  const AI = window.HasamiAI;
  const C = window.HasamiContent;
  const { GameEngine, otherPlayer, posLabel, posFromLabel, defaultStockForSize, makeConfig } = H;

  const root = document.getElementById("screen-root");
  const navbar = document.getElementById("navbar");

  // ============================================================ 永続化
  const LS_HISTORY = "hasami:history:v1";

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]"); } catch (e) { return []; }
  }
  function saveHistoryList(arr) {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(arr.slice(-200))); } catch (e) { /* 保存できなくても致命的ではない */ }
  }

  // メニュー画面の設定。対戦画面などから戻ったときや、次に開いたときも前回の設定を復元する
  // (保存できない環境でも、このページを開いている間は menuSettingsCache に残る)。
  const LS_MENU = "hasami:menu:v1";
  let menuSettingsCache = null;
  function loadMenuSettings() {
    if (menuSettingsCache) return menuSettingsCache;
    try { menuSettingsCache = JSON.parse(localStorage.getItem(LS_MENU) || "null"); } catch (e) { menuSettingsCache = null; }
    return menuSettingsCache;
  }
  function saveMenuSettings(s) {
    menuSettingsCache = s;
    try { localStorage.setItem(LS_MENU, JSON.stringify(s)); } catch (e) { /* 同上 */ }
  }

  // 感想戦の表示設定(盤に最善手の矢印を出すか など)
  const LS_REVIEW = "hasami:review:v1";
  function loadReviewPrefs() {
    try { return JSON.parse(localStorage.getItem(LS_REVIEW) || "{}") || {}; } catch (e) { return {}; }
  }
  function saveReviewPref(key, value) {
    try {
      const prefs = loadReviewPrefs();
      prefs[key] = value;
      localStorage.setItem(LS_REVIEW, JSON.stringify(prefs));
    } catch (e) { /* 保存できなくても致命的ではない */ }
  }

  // ============================================================ 手番・持ち時間の選択肢
  const SIDE_CHOICES = [
    { id: "A", label: "先手" },
    { id: "B", label: "後手" },
    { id: "random", label: "ランダム" },
  ];

  // 持ち時間のプリセット(秒)。main = 持ち時間、byo = 秒読み(持ち時間が尽きたら1手ごとにこの秒数)、
  // inc = 1手指すごとに持ち時間へ加算(フィッシャー)。将棋ウォーズの切れ負け・10秒将棋、
  // 道場・大会でおなじみの「持ち時間+秒読み」、ネット対局で使われるフィッシャー方式にならった。
  const TIME_PRESETS = [
    { id: "none", label: "なし(時間制限なし)", spec: null },
    { id: "byo60", label: "1分将棋(1手60秒の秒読み)", spec: { main: 0, byo: 60, inc: 0 } },
    { id: "byo30", label: "30秒将棋(1手30秒の秒読み)", spec: { main: 0, byo: 30, inc: 0 } },
    { id: "byo10", label: "10秒将棋(1手10秒・将棋ウォーズ風)", spec: { main: 0, byo: 10, inc: 0 } },
    { id: "sd3", label: "3分切れ負け(将棋ウォーズ風)", spec: { main: 180, byo: 0, inc: 0 } },
    { id: "sd10", label: "10分切れ負け(将棋ウォーズ風)", spec: { main: 600, byo: 0, inc: 0 } },
    { id: "m10b30", label: "持ち時間10分+秒読み30秒", spec: { main: 600, byo: 30, inc: 0 } },
    { id: "m15b60", label: "持ち時間15分+秒読み60秒", spec: { main: 900, byo: 60, inc: 0 } },
    { id: "f5i5", label: "5分+1手ごとに5秒加算(フィッシャー)", spec: { main: 300, byo: 0, inc: 5 } },
    { id: "custom", label: "カスタム(自分で組み合わせる)", spec: null },
  ];
  const TIME_MAIN_CHOICES = [0, 1, 3, 5, 10, 15, 20, 30, 60]; // 分
  const TIME_BYO_CHOICES = [0, 10, 20, 30, 60];              // 秒
  const TIME_INC_CHOICES = [0, 1, 2, 3, 5, 10, 30];          // 秒

  function timeControlLabel(t) {
    if (!t) return "持ち時間なし";
    if (!t.main && !t.inc) return t.byo === 60 ? "1分将棋" : `${t.byo}秒将棋`;
    let s = t.main % 60 ? `持ち時間${t.main}秒` : `持ち時間${t.main / 60}分`;
    if (t.byo) s += `+秒読み${t.byo}秒`;
    if (t.inc) s += `+1手${t.inc}秒加算`;
    if (!t.byo && !t.inc) s += "切れ負け";
    return s;
  }

  // ============================================================ Web Worker(AI思考)
  const Worker_ = window.Worker;
  let worker = null;
  let workerOk = true;
  let reqSeq = 1;
  let pendingReqId = null;
  let onWorkerResult = null; // (payload) => void

  function initWorker() {
    if (!Worker_) { workerOk = false; return; }
    try {
      worker = new Worker_("ai-worker.js?v=8");
      worker.onmessage = (e) => {
        if (e.data.reqId !== pendingReqId || e.data.progress != null) return; // 破棄済み(リスタート等)の応答
        if (onWorkerResult) onWorkerResult(e.data);
      };
      worker.onerror = () => { workerOk = false; };
    } catch (e) {
      workerOk = false;
    }
  }
  initWorker();

  function engineSnapshot(engine) {
    return {
      board: new Map(engine.board),
      pieces: Array.from(engine.pieces.values()).map((p) => ({ id: p.id, player: p.player, position: p.position.slice() })),
      nextPieceId: engine._nextPieceId,
      stock: { A: engine.stock.A, B: engine.stock.B },
      currentPlayer: engine.currentPlayer,
      obligated: { A: engine.obligated.A.slice(), B: engine.obligated.B.slice() },
      winner: engine.winner,
      isDraw: engine.isDraw,
      stateHistory: new Map(engine._stateHistory),
    };
  }

  function rebuildEngineFromState(config, state) {
    const engine = Object.create(GameEngine.prototype);
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

  function requestAIMove(engine, player, opts, callback) {
    const reqId = reqSeq++;
    pendingReqId = reqId;
    onWorkerResult = (data) => {
      onWorkerResult = null;
      callback(data.ok ? data.action : null, data);
    };
    const payload = {
      reqId, player,
      config: engine.config,
      state: engineSnapshot(engine),
      level: opts.specialist ? null : opts.level,
      specialist: !!opts.specialist,
      seed: Math.floor(Math.random() * 0xffffffff),
      timeBudget: opts.specialist ? 29000 : undefined,
    };
    if (worker && workerOk) {
      worker.postMessage(payload);
    } else {
      // Worker が使えない環境(file:// を直接開いた等)へのフォールバック。
      // メインスレッドで動くため長考中は画面が固まるが、動作はする。
      setTimeout(() => {
        try {
          const ai = AI.makeAI(player, opts.level, opts.specialist, payload.seed, payload.timeBudget);
          const rebuilt = rebuildEngineFromState(payload.config, payload.state);
          const action = ai.chooseAction(rebuilt);
          if (pendingReqId === reqId && onWorkerResult) { const cb = onWorkerResult; onWorkerResult = null; cb({ ok: true, action, reqId }); }
        } catch (err) {
          if (pendingReqId === reqId && onWorkerResult) { const cb = onWorkerResult; onWorkerResult = null; cb({ ok: false, error: String(err), reqId }); }
        }
      }, 20);
    }
  }

  // 詰めピンチの受け(op:"defend")・ヒント(op:"hint")を Worker で計算する
  function requestTsume(op, engine, solver, quietLeft, maxPlies, callback) {
    const reqId = reqSeq++;
    pendingReqId = reqId;
    onWorkerResult = (data) => {
      onWorkerResult = null;
      callback(data.ok ? data.result : null, data);
    };
    const payload = { kind: "tsume", op, reqId, config: engine.config, state: engineSnapshot(engine), solver, quietLeft, maxPlies };
    if (worker && workerOk) {
      worker.postMessage(payload);
    } else {
      setTimeout(() => {
        let data;
        try {
          const rebuilt = rebuildEngineFromState(payload.config, payload.state);
          const T = window.HasamiTsume;
          const result = op === "hint" ? T.hintFor(rebuilt, solver, quietLeft, maxPlies) : T.defendFor(rebuilt, solver, quietLeft, maxPlies);
          data = { ok: true, result, reqId };
        } catch (err) {
          data = { ok: false, error: String(err), reqId };
        }
        if (pendingReqId === reqId && onWorkerResult) { const cb = onWorkerResult; onWorkerResult = null; cb(data); }
      }, 20);
    }
  }

  // ============================================================ 形勢表示の読み(専用 Worker)
  // 対局用の Worker(pendingReqId は1件だけ)とは別の Worker で読むので、AIの手や詰めピンチの
  // 要求と取り違えない。受け取るのは最後に頼んだ局面の結果だけ(古い結果は捨てる)。
  let evalWorker = null;
  let evalWorkerOk = true;
  let evalReq = null; // { reqId, engine, template, callback }

  function ensureEvalWorker() {
    if (evalWorker || !evalWorkerOk) return;
    if (!Worker_) { evalWorkerOk = false; return; }
    try {
      evalWorker = new Worker_("ai-worker.js?v=8");
      evalWorker.onmessage = (e) => {
        if (!evalReq || e.data.reqId !== evalReq.reqId) return;
        const cb = evalReq.callback;
        evalReq = null;
        cb(e.data.ok ? e.data.result : null);
      };
      evalWorker.onerror = () => {
        evalWorkerOk = false;
        evalWorker = null;
        if (evalReq) runEvalOnMainThread(evalReq);
      };
    } catch (e) {
      evalWorkerOk = false;
    }
  }

  // Worker が使えない環境(file:// を直接開いた等)では、メインスレッドで短めに読む(その間だけ画面が止まる)
  function runEvalOnMainThread(req) {
    setTimeout(() => {
      let result = null;
      try {
        result = req.kind === "analyze" ? AI.analyzePosition(req.engine, req.template, 250) : AI.evaluatePosition(req.engine, req.template, 250);
      } catch (e) { result = null; }
      if (evalReq === req) { evalReq = null; req.callback(result); }
    }, 30);
  }

  // kind: "eval"(形勢表示: evaluatePosition)/ "analyze"(感想戦の解析: analyzePosition)
  function requestEval(engine, template, callback, kind) {
    const req = { reqId: reqSeq++, engine: engine.clone(), template, callback, kind: kind || "eval" };
    evalReq = req;
    ensureEvalWorker();
    if (evalWorker && evalWorkerOk) {
      evalWorker.postMessage({
        kind: req.kind, reqId: req.reqId, config: engine.config, state: engineSnapshot(engine),
        template, timeBudget: AI.EVAL_TIME_BUDGET,
      });
    } else {
      runEvalOnMainThread(req);
    }
  }

  function cancelEval() { evalReq = null; }

  // ============================================================ 感想戦の検討(専用 Worker)
  // 「じっくり読む」(op: "deep")と詰み手順の樹形図(op: "mateTree")。感想戦の解析(evalWorker)と
  // 並行して動かすので別の Worker にする。新しい要求が来たら読みかけの Worker は止めて作り直す。
  let studyWorker = null;
  let studyWorkerOk = true;
  let studyReq = null; // { reqId, callback }。callback(result, cancelled)

  function requestStudy(op, engine, extra, callback) {
    cancelStudy();
    const req = { reqId: reqSeq++, callback };
    studyReq = req;
    const payload = Object.assign({ kind: "study", op, reqId: req.reqId, config: engine.config, state: engineSnapshot(engine) }, extra);
    if (!studyWorker && studyWorkerOk && Worker_) {
      try {
        studyWorker = new Worker_("ai-worker.js?v=8");
        studyWorker.onmessage = (e) => {
          if (!studyReq || e.data.reqId !== studyReq.reqId) return;
          const cb = studyReq.callback;
          studyReq = null;
          cb(e.data.ok ? e.data.result : null);
        };
        studyWorker.onerror = () => {
          studyWorkerOk = false;
          studyWorker = null;
          if (studyReq) { const cb = studyReq.callback; studyReq = null; cb(null); }
        };
      } catch (e) {
        studyWorkerOk = false;
      }
    }
    if (studyWorker) { studyWorker.postMessage(payload); return; }
    // Worker が使えない環境では、メインスレッドで短めに読む
    setTimeout(() => {
      let result = null;
      try {
        const eng = rebuildEngineFromState(payload.config, payload.state);
        result = op === "deep"
          ? AI.deepAnalyze(eng, extra.template, 1000)
          : AI.buildMateTree(eng, extra.winner, extra.plies, extra.path, { timeLimit: 3000 });
      } catch (e) { result = null; }
      if (studyReq === req) { studyReq = null; callback(result); }
    }, 30);
  }

  // 読みかけの要求を取り消す(呼び出し側の後片づけのため callback(null, true) を呼ぶ)
  function cancelStudy() {
    const old = studyReq;
    if (!old) return;
    studyReq = null;
    if (studyWorker) { studyWorker.terminate(); studyWorker = null; }
    old.callback(null, true);
  }

  // ============================================================ 汎用ヘルパー
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else if (k.startsWith("on") && typeof attrs[k] === "function") node.addEventListener(k.slice(2), attrs[k]);
        else if (k === "style") Object.assign(node.style, attrs[k]);
        else node.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach((c) => { if (c != null) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }

  function clearNode(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // 盤面(座標ラベル+マス目)一式を組み立てる。ゲーム画面・感想戦画面の両方から
  // 使う共通部品にすることで、レイアウトのズレ(スマホで座標ラベルが盤に
  // 隠れる不具合の原因だった)が二重管理にならないようにしている。
  // .board-shell はCSS Grid で「ラベル用の段・列」と「盤面」を分けているため、
  // 画面幅がどれだけ狭くても盤がラベルの上に重なることはない。
  function buildBoardShell(size, opts) {
    opts = opts || {};
    const boardFrame = el("div", { class: "board-frame" });
    const shell = el("div", { class: "board-shell" });
    const railTop = el("div", { class: "rail-top" });
    const railLeft = el("div", { class: "rail-left" });
    for (let c = 0; c < size; c++) railTop.appendChild(el("span", { text: String.fromCharCode(65 + c) }));
    for (let r = 0; r < size; r++) railLeft.appendChild(el("span", { text: String(r + 1) }));
    const board = el("div", { class: "board" });
    const grid = el("div", { class: "grid" });
    grid.style.gridTemplateColumns = `repeat(${size},1fr)`;
    grid.style.gridTemplateRows = `repeat(${size},1fr)`;
    const cellNodes = [];
    for (let r = 0; r < size; r++) {
      cellNodes.push([]);
      for (let c = 0; c < size; c++) {
        const cell = el("div", { class: "cell" });
        cell.dataset.r = r; cell.dataset.c = c;
        if (opts.onCellClick) cell.addEventListener("click", () => opts.onCellClick(r, c));
        grid.appendChild(cell);
        cellNodes[r].push(cell);
      }
    }
    const piecesLayer = el("div", { class: "layer pieces" });
    board.appendChild(grid);
    board.appendChild(piecesLayer);
    let fxLayer = null;
    if (opts.fx) {
      fxLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      fxLayer.setAttribute("class", "fx-svg layer");
      fxLayer.setAttribute("viewBox", "0 0 100 100");
      fxLayer.setAttribute("preserveAspectRatio", "none");
      board.appendChild(fxLayer);
    }
    shell.appendChild(railTop);
    shell.appendChild(railLeft);
    shell.appendChild(board);
    boardFrame.appendChild(shell);
    return { boardFrame, board, grid, cellNodes, piecesLayer, fxLayer };
  }

  function confirmModal(message, okLabel, cancelLabel) {
    return new Promise((resolve) => {
      const veil = el("div", { class: "veil" });
      const modal = el("div", { class: "modal" }, [
        el("p", { text: message }),
        el("div", { class: "modal-actions" }, [
          el("button", { class: "btn", text: cancelLabel || "キャンセル", onclick: () => { veil.remove(); resolve(false); } }),
          el("button", { class: "btn btn-danger", text: okLabel || "OK", onclick: () => { veil.remove(); resolve(true); } }),
        ]),
      ]);
      veil.appendChild(modal);
      document.body.appendChild(veil);
    });
  }

  function toast(message) {
    const t = el("div", {
      text: message,
      style: {
        position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)",
        background: "var(--surface-raised)", color: "var(--text-primary)", border: "1px solid rgba(201,162,39,.4)",
        borderRadius: "8px", padding: "10px 16px", fontSize: "12.5px", zIndex: 60, boxShadow: "0 10px 30px rgba(0,0,0,.5)",
      },
    });
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .4s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 400); }, 1800);
  }

  // ============================================================ アプリ状態
  const App = {
    screen: "menu",
    match: null, // 進行中の対局(下で定義する Match オブジェクト)
  };

  function goto(screen, payload) {
    if (App.match && App.match.mode === "tsume") stopTsumeReplay(App.match);
    if (App.match && App.screen === "game" && screen !== "game" && App.match.mode !== "tsume") {
      // 対局中にメニュー等へ抜けようとした場合は確認する
      const engine = App.match.engine;
      if (engine && !engine.isOver() && !App.match.aiThinking) {
        confirmModal("対戦中です。移動すると今の対戦は失われます。よろしいですか?").then((ok) => {
          if (ok) { App.match = null; App.screen = screen; render(payload); }
        });
        return;
      }
    }
    App.screen = screen;
    render(payload);
  }

  navbar.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-nav]");
    if (btn) goto(btn.dataset.nav);
    if (e.target.closest("#nav-title")) goto("menu");
  });

  function render(payload) {
    clearNode(root);
    App.onlineRefreshLink = null; // 前の画面の手番リンク更新フックは無効化する
    cancelStudy(); // 感想戦の検討(じっくり読む・詰み手順)の読みかけは画面を作り直したら捨てる
    const renderers = {
      menu: renderMenu, game: renderGame, tutorial: renderTutorial, strategy: renderStrategy,
      report: renderReport, history: renderHistory, review: renderReview, online: renderOnline,
      tsume: renderTsumeMenu, rating: renderRating,
    };
    (renderers[App.screen] || renderMenu)(root, payload);
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }

  // ============================================================ メニュー画面
  function renderMenu(root) {
    const screen = el("div", { class: "screen" });

    const masthead = el("div", { class: "masthead" }, [
      el("div", { class: "kanji", text: "挟" }),
      el("h1", { text: "挟みゲーム" }),
      el("div", { class: "sub", text: "IN A PINCH" }),
      el("div", { class: "tag", text: "駒を配置・移動して相手の駒を挟み、動けなくしたら勝ち" }),
    ]);
    screen.appendChild(masthead);

    // ---- ルールテンプレート ----
    const tplCard = el("div", { class: "card" });
    tplCard.appendChild(el("div", { class: "card-title", text: "ルールテンプレート" }));
    const tplRow = el("div", { class: "field-control" });
    const tplSelect = el("select", { class: "field-select" }, [
      el("option", { value: "custom", text: C.TEMPLATE_MENU_CUSTOM }),
      el("option", { value: "template", text: C.TEMPLATE_LABEL }),
    ]);
    tplRow.appendChild(tplSelect);
    tplCard.appendChild(tplRow);
    tplCard.appendChild(el("div", {
      class: "field-hint", style: { marginTop: "8px" },
      text: `「特化テンプレート」を選ぶと 盤面7×7・持ち駒15・接触制限3・移動範囲3 に固定され、この設定に特化して調整した最上位AI『${AI.SPECIALIST_AI_NAME}』を相手に選べます(1手最大30秒)。`,
    }));
    screen.appendChild(tplCard);

    // ---- 対戦モード & 設定 ----
    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "card-title", text: "対戦モード" }));

    const modeWrap = el("div", {});
    const modes = [
      ["pvai", "AI戦(自分 対 AI)"],
      ["pvp", "対人戦(2人で同じ画面を交互に操作)"],
      ["ai_vs_ai", "AI同士の対戦(観戦)"],
    ];
    const modeInputs = {};
    modes.forEach(([val, label]) => {
      const row = el("label", { class: "radio-row" });
      const input = el("input", { type: "radio", name: "mode", value: val });
      if (val === "pvai") input.checked = true;
      modeInputs[val] = input;
      row.appendChild(input);
      row.appendChild(document.createTextNode(label));
      modeWrap.appendChild(row);
      input.addEventListener("change", onModeChange);
    });
    card.appendChild(modeWrap);
    card.appendChild(el("hr", { class: "hr" }));

    // 盤面サイズ / 移動範囲
    const sizeRow = el("div", { class: "field-row" });
    sizeRow.appendChild(el("div", { class: "field-label", text: "盤面サイズ" }));
    const sizeSelect = el("select", { class: "field-select" });
    C.BOARD_SIZE_CHOICES.forEach((n) => sizeSelect.appendChild(el("option", { value: n, text: `${n} x ${n}` })));
    sizeSelect.value = "7";
    sizeRow.appendChild(el("div", { class: "field-control" }, [sizeSelect]));
    card.appendChild(sizeRow);

    const rangeRow = el("div", { class: "field-row" });
    rangeRow.appendChild(el("div", { class: "field-label", text: "移動範囲" }));
    const rangeSeg = buildSeg(["1マス", "2マス", "3マス"], "1マス");
    rangeRow.appendChild(el("div", { class: "field-control" }, [rangeSeg.el]));
    card.appendChild(rangeRow);

    const contactRow = el("div", { class: "field-row" });
    contactRow.appendChild(el("div", { class: "field-label", text: "接触制限", }));
    const contactSeg = buildSeg(C.CONTACT_LIMIT_CHOICES.map(String), String(C.DEFAULT_CONTACT_LIMIT));
    contactRow.appendChild(el("div", { class: "field-control" }, [contactSeg.el]));
    card.appendChild(contactRow);
    card.appendChild(el("div", { class: "field-hint", text: "自分の駒はこの個数を超えて上下左右に連結できない(角・辺は壁も挟みに加担する)" }));

    // AIの強さ
    const levelRow = el("div", { class: "field-row" });
    const levelLabel = el("div", { class: "field-label", text: "AIの強さ" });
    levelRow.appendChild(levelLabel);
    const levelSelect = buildLevelSelect();
    levelRow.appendChild(el("div", { class: "field-control" }, [levelSelect]));
    card.appendChild(levelRow);
    // AI戦のときだけ: いまのレートと、近い強さのAI
    const ratingHint = el("div", { class: "field-hint rating-hint" });
    const myRating = currentRating();
    if (myRating != null) {
      const near = RT.nearestLevel(myRating);
      ratingHint.textContent = `あなたのレート ${myRating}(近い強さのAI: ${ratingLevelName(near[0])})。形勢表示なし・待ったなしのAI戦でレートが動きます。`;
    } else {
      ratingHint.textContent = "AI戦(形勢表示なし・待ったなし)を指すと、結果と指し手の質からレートが付きます。";
    }
    card.appendChild(ratingHint);

    const levelRowB = el("div", { class: "field-row", style: { display: "none" } });
    levelRowB.appendChild(el("div", { class: "field-label", text: "後手AIの強さ" }));
    const levelSelectB = buildLevelSelect();
    levelRowB.appendChild(el("div", { class: "field-control" }, [levelSelectB]));
    card.appendChild(levelRowB);

    // AI戦のときだけ: あなたが先手・後手のどちらを持つか(ランダムは対局開始ごとに抽選)
    const sideRow = el("div", { class: "field-row" });
    sideRow.appendChild(el("div", { class: "field-label", text: "あなたの手番" }));
    const sideSeg = buildSeg(SIDE_CHOICES.map((s) => s.label), SIDE_CHOICES[0].label);
    sideRow.appendChild(el("div", { class: "field-control" }, [sideSeg.el]));
    card.appendChild(sideRow);

    // 対人戦のときだけ: 持ち時間(将棋の切れ負け・秒読み・フィッシャーにならう)
    const timeRow = el("div", { class: "field-row", style: { display: "none" } });
    timeRow.appendChild(el("div", { class: "field-label", text: "持ち時間" }));
    const timeSelect = el("select", { class: "field-select" });
    TIME_PRESETS.forEach((p) => timeSelect.appendChild(el("option", { value: p.id, text: p.label })));
    timeRow.appendChild(el("div", { class: "field-control" }, [timeSelect]));
    card.appendChild(timeRow);
    const timeCustom = el("div", { class: "time-custom", style: { display: "none" } });
    const tcMain = buildNumSelect(TIME_MAIN_CHOICES, (v) => (v ? `${v}分` : "なし"), 10);
    const tcByo = buildNumSelect(TIME_BYO_CHOICES, (v) => (v ? `${v}秒` : "なし"), 30);
    const tcInc = buildNumSelect(TIME_INC_CHOICES, (v) => (v ? `${v}秒` : "なし"), 0);
    [["持ち時間", tcMain], ["秒読み", tcByo], ["1手ごとの加算", tcInc]].forEach(([label, sel]) => {
      timeCustom.appendChild(el("label", { class: "time-custom-item" }, [el("span", { text: label }), sel]));
    });
    card.appendChild(timeCustom);
    const tcSound = el("input", { type: "checkbox" });
    tcSound.checked = true;
    const timeExtra = el("div", { style: { display: "none" } }, [
      el("label", { class: "check-row" }, [tcSound, document.createTextNode("残りわずかになったら秒読みの音を鳴らす")]),
      el("div", {
        class: "field-hint",
        text: "持ち時間を使い切ると秒読み(1手ごとにその秒数以内)に入り、秒読みも尽きると時間切れ負けです。"
          + "秒読みなしは持ち時間が尽きた時点で負け(切れ負け)、加算ありは指すたびに持ち時間が増えます(フィッシャー)。"
          + "持ち時間ありの対局では「待った」はできません。",
      }),
    ]);
    card.appendChild(timeExtra);
    const timeHint = timeExtra.lastChild;

    // 形勢表示(対局中に優勢・劣勢の%を出す)。持ち時間ありの対人戦は真剣勝負なので既定はオフ、
    // それ以外は既定でオン。2つの既定は別々に覚えておき、モード・持ち時間に応じて切り替える
    const evalPrefs = { casual: true, clock: false };
    const evalCheck = el("input", { type: "checkbox" });
    const evalHint = el("div", { class: "field-hint" });
    card.appendChild(el("div", { class: "eval-option" }, [
      el("label", { class: "check-row" }, [evalCheck, document.createTextNode("対局中に形勢(優勢・劣勢の%)を表示する")]),
      evalHint,
    ]));
    function evalContext() { return currentMode() === "pvp" && timeSelect.value !== "none" ? "clock" : "casual"; }
    function syncEvalOption() {
      const ctx = evalContext();
      evalCheck.checked = evalPrefs[ctx];
      evalHint.textContent = (ctx === "clock" ? "持ち時間ありの対人戦では既定でオフです(オンにもできます)。" : "")
        + "形勢は学習型AIが読んだ「強いAI同士で続けた場合の勝率」の目安です。"
        + "表示した対局は、棋譜・対戦履歴に「形勢表示あり」と記録され、レートなどの集計では区別されます。";
    }
    evalCheck.addEventListener("change", () => { evalPrefs[evalContext()] = evalCheck.checked; });

    card.appendChild(el("hr", { class: "hr" }));
    card.appendChild(el("div", { class: "field-hint", text: "持ち駒(AIの強さとは独立に自由に設定できます)" }));

    const defaultStock = defaultStockForSize(7);
    const stockRow = el("div", { class: "field-row" });
    stockRow.appendChild(el("div", { class: "field-label", text: "先手 / 後手" }));
    const stockA = el("input", { class: "stock-input", type: "number", min: "1", value: String(defaultStock) });
    const stockB = el("input", { class: "stock-input", type: "number", min: "1", value: String(defaultStock) });
    stockRow.appendChild(el("div", { class: "field-control" }, [stockA, stockB]));
    card.appendChild(stockRow);
    const stockHint = el("div", { class: "field-hint", text: `目安: ${defaultStock}(盤面サイズから自動計算)` });
    card.appendChild(stockHint);
    const errorText = el("div", { class: "error-text" });
    card.appendChild(errorText);

    const startBtn = el("button", { class: "btn btn-primary", text: "対戦開始", style: { marginTop: "16px" } });
    card.appendChild(startBtn);
    screen.appendChild(card);
    root.appendChild(screen);

    function buildSeg(labels, initial) {
      const wrap = el("div", { class: "seg", role: "radiogroup" });
      const buttons = labels.map((label) => {
        const b = el("button", { type: "button", text: label, "aria-checked": label === initial ? "true" : "false" });
        b.addEventListener("click", () => {
          buttons.forEach((x) => x.setAttribute("aria-checked", x === b ? "true" : "false"));
        });
        wrap.appendChild(b);
        return b;
      });
      return {
        el: wrap,
        get value() { return buttons.find((b) => b.getAttribute("aria-checked") === "true").textContent; },
        set(label) { buttons.forEach((x) => x.setAttribute("aria-checked", x.textContent === label ? "true" : "false")); },
        setDisabled(v) { buttons.forEach((b) => { b.disabled = v; }); },
      };
    }

    function buildLevelSelect() {
      const sel = el("select", { class: "field-select" });
      AI.LEVEL_ORDER.forEach((i) => sel.appendChild(el("option", { value: String(i), text: AI.LEVELS[i].name })));
      sel.value = "3";
      return sel;
    }

    function buildNumSelect(values, labelOf, initial) {
      const sel = el("select", { class: "field-select" });
      values.forEach((v) => sel.appendChild(el("option", { value: String(v), text: labelOf(v) })));
      sel.value = String(initial);
      return sel;
    }

    function currentMode() { return modeInputs.pvai.checked ? "pvai" : modeInputs.pvp.checked ? "pvp" : "ai_vs_ai"; }

    function onTimeChange() {
      const show = currentMode() === "pvp";
      const custom = timeSelect.value === "custom";
      timeRow.style.display = show ? "" : "none";
      timeCustom.style.display = show && custom ? "" : "none";
      timeExtra.style.display = show && timeSelect.value !== "none" ? "" : "none";
      timeHint.style.display = timeSelect.value !== "none" ? "" : "none";
      syncEvalOption();
    }

    function selectedTimeControl() {
      if (timeSelect.value === "custom") {
        const t = { main: parseInt(tcMain.value, 10) * 60, byo: parseInt(tcByo.value, 10), inc: parseInt(tcInc.value, 10) };
        return t.main || t.byo ? t : undefined; // 持ち時間も秒読みも無いと1手目で負けてしまう
      }
      const preset = TIME_PRESETS.find((p) => p.id === timeSelect.value);
      return preset && preset.spec ? Object.assign({}, preset.spec) : null;
    }

    // ---- 設定の保存・復元(対戦画面などから戻っても前回の設定のまま) ----
    function collectSettings() {
      return {
        template: tplSelect.value, mode: currentMode(),
        size: sizeSelect.value, range: rangeSeg.value, contact: contactSeg.value,
        level: levelSelect.value, levelB: levelSelectB.value, side: sideSeg.value,
        stockA: stockA.value, stockB: stockB.value,
        time: timeSelect.value, tcMain: tcMain.value, tcByo: tcByo.value, tcInc: tcInc.value, tcSound: tcSound.checked,
        evalCasual: evalPrefs.casual, evalClock: evalPrefs.clock,
      };
    }
    function hasOption(sel, value) { return Array.from(sel.options).some((o) => o.value === String(value)); }
    function applySettings(s) {
      if (!s) return;
      if (hasOption(tplSelect, s.template)) tplSelect.value = s.template;
      if (modeInputs[s.mode]) modeInputs[s.mode].checked = true;
      applyTemplateLock(isTemplateSelected());
      onModeChange();
      if (!isTemplateSelected()) {
        if (hasOption(sizeSelect, s.size)) sizeSelect.value = s.size;
        if (s.range) rangeSeg.set(s.range);
        if (s.contact) contactSeg.set(s.contact);
        if (s.stockA != null) stockA.value = s.stockA;
        if (s.stockB != null) stockB.value = s.stockB;
        onSizeChange();
      }
      if (hasOption(levelSelect, s.level)) levelSelect.value = s.level;
      if (hasOption(levelSelectB, s.levelB)) levelSelectB.value = s.levelB;
      if (s.side) sideSeg.set(s.side);
      if (hasOption(timeSelect, s.time)) timeSelect.value = s.time;
      if (hasOption(tcMain, s.tcMain)) tcMain.value = s.tcMain;
      if (hasOption(tcByo, s.tcByo)) tcByo.value = s.tcByo;
      if (hasOption(tcInc, s.tcInc)) tcInc.value = s.tcInc;
      if (typeof s.tcSound === "boolean") tcSound.checked = s.tcSound;
      if (typeof s.evalCasual === "boolean") evalPrefs.casual = s.evalCasual;
      if (typeof s.evalClock === "boolean") evalPrefs.clock = s.evalClock;
      onTimeChange();
    }
    // クリック・入力のたびに保存する(セグメントボタンはクリック処理の後で値が変わるので次のタイミングで読む)
    const persist = () => setTimeout(() => saveMenuSettings(collectSettings()), 0);
    ["change", "input", "click"].forEach((ev) => screen.addEventListener(ev, persist));

    function setSpecialistOption(enabled) {
      const existing = levelSelect.querySelector('option[value="specialist"]');
      [levelSelect, levelSelectB].forEach((sel) => {
        let opt = sel.querySelector('option[value="specialist"]');
        if (enabled && !opt) sel.appendChild(el("option", { value: "specialist", text: AI.SPECIALIST_AI_NAME }));
        if (!enabled && opt) opt.remove();
      });
      if (enabled) {
        levelSelect.value = "specialist";
        if (modeInputs.ai_vs_ai.checked) levelSelectB.value = "specialist";
      } else {
        if (levelSelect.value === "specialist") levelSelect.value = "5";
        if (levelSelectB.value === "specialist") levelSelectB.value = "5";
      }
    }

    function isTemplateSelected() { return tplSelect.value === "template"; }

    function applyTemplateLock(locked) {
      errorText.textContent = "";
      if (locked) {
        sizeSelect.value = String(C.TEMPLATE_SPEC.rows);
        rangeSeg.set(C.TEMPLATE_SPEC.moveRange + "マス");
        contactSeg.set(String(C.TEMPLATE_SPEC.contactLimit));
        stockA.value = String(C.TEMPLATE_SPEC.stock);
        stockB.value = String(C.TEMPLATE_SPEC.stock);
        sizeSelect.disabled = true;
        rangeSeg.setDisabled(true);
        contactSeg.setDisabled(true);
        stockA.disabled = true;
        stockB.disabled = true;
        stockHint.textContent = `テンプレート固定: 先手・後手とも持ち駒${C.TEMPLATE_SPEC.stock}`;
        setSpecialistOption(true);
      } else {
        sizeSelect.disabled = false;
        rangeSeg.setDisabled(false);
        contactSeg.setDisabled(false);
        stockA.disabled = false;
        stockB.disabled = false;
        setSpecialistOption(false);
        onSizeChange();
      }
    }

    function onSizeChange() {
      if (isTemplateSelected()) return;
      const size = parseInt(sizeSelect.value, 10);
      stockHint.textContent = `目安: ${defaultStockForSize(size)}(盤面サイズから自動計算)`;
    }

    function onModeChange() {
      const mode = currentMode();
      sideRow.style.display = mode === "pvai" ? "" : "none";
      onTimeChange();
      ratingHint.style.display = mode === "pvai" ? "" : "none";
      if (mode === "pvai") {
        levelLabel.textContent = "AIの強さ";
        levelRow.style.display = "";
        levelRowB.style.display = "none";
      } else if (mode === "ai_vs_ai") {
        levelLabel.textContent = "先手AIの強さ";
        levelRow.style.display = "";
        levelRowB.style.display = "";
      } else {
        levelRow.style.display = "none";
        levelRowB.style.display = "none";
      }
      if (isTemplateSelected()) setSpecialistOption(true);
    }

    tplSelect.addEventListener("change", () => applyTemplateLock(isTemplateSelected()));
    sizeSelect.addEventListener("change", onSizeChange);
    timeSelect.addEventListener("change", onTimeChange);

    onModeChange();
    applySettings(loadMenuSettings());

    startBtn.addEventListener("click", () => {
      errorText.textContent = "";
      const mode = currentMode();
      const template = isTemplateSelected();
      const size = parseInt(sizeSelect.value, 10);
      const moveRange = parseInt(rangeSeg.value, 10);
      const contactLimit = parseInt(contactSeg.value, 10);
      const specA = levelSelect.value === "specialist";
      const specB = mode === "ai_vs_ai" && levelSelectB.value === "specialist";
      const aiLevel = specA ? 7 : parseInt(levelSelect.value, 10);
      const aiLevelB = mode === "ai_vs_ai" ? (specB ? 7 : parseInt(levelSelectB.value, 10)) : null;

      if ((specA || specB) && !template) {
        errorText.textContent = `『${AI.SPECIALIST_AI_NAME}』はルールテンプレート選択時のみ使えます。`;
        return;
      }
      const dStock = defaultStockForSize(size);
      const sa = parseStock(stockA.value, dStock, "先手(1P)の持ち駒");
      if (sa == null) return;
      const sb = parseStock(stockB.value, dStock, "後手(2P/AI)の持ち駒");
      if (sb == null) return;
      const timeControl = mode === "pvp" ? selectedTimeControl() : null;
      if (timeControl === undefined) {
        errorText.textContent = "持ち時間か秒読みのどちらかは設定してください(両方なしだと1手目で時間切れになります)。";
        return;
      }

      saveMenuSettings(collectSettings());
      startNewMatch({
        mode, boardSize: size, moveRange, contactLimit,
        aiLevel, aiLevelB, aiSpecialist: specA, aiSpecialistB: specB,
        stockA: sa, stockB: sb,
        ruleTemplate: template ? C.TEMPLATE_ID : null,
        side: mode === "pvai" ? SIDE_CHOICES.find((s) => s.label === sideSeg.value).id : "A",
        timeControl, clockSound: tcSound.checked, evalDisplay: evalCheck.checked,
      });

      function parseStock(text, def, label) {
        text = String(text).trim();
        if (!text) return def;
        const v = parseInt(text, 10);
        if (!Number.isFinite(v)) { errorText.textContent = `${label}は整数で入力してください。`; return null; }
        if (v <= 0) { errorText.textContent = `${label}は1以上にしてください。`; return null; }
        return v;
      }
    });
  }

  // ============================================================ 対局の開始・進行
  function startNewMatch(opts) {
    const config = makeConfig({
      rows: opts.boardSize, cols: opts.boardSize, moveRange: opts.moveRange,
      wallSandwich: true, contactLimit: opts.contactLimit,
    });
    const engine = new GameEngine(config);
    engine.stock.A = opts.stockA;
    engine.stock.B = opts.stockB;
    const side = opts.side || "A";
    const humanPlayer = side === "random" ? (Math.random() < 0.5 ? "A" : "B") : side;
    const timeControl = opts.mode === "pvp" && opts.timeControl ? opts.timeControl : null;

    App.match = {
      mode: opts.mode,
      boardSize: opts.boardSize, moveRange: opts.moveRange, contactLimit: opts.contactLimit,
      aiLevel: opts.aiLevel, aiLevelB: opts.aiLevelB,
      aiSpecialist: !!opts.aiSpecialist, aiSpecialistB: !!opts.aiSpecialistB,
      stockA: opts.stockA, stockB: opts.stockB,
      ruleTemplate: opts.ruleTemplate,
      engine,
      humanPlayer,
      sideChoice: side,
      timeControl, clockSound: opts.clockSound !== false,
      clock: timeControl ? createClock(timeControl) : null,
      selected: null,
      lastAction: null,
      logMessages: side === "random" && opts.mode === "pvai"
        ? [`ランダムで手番を決めました: あなたは${humanPlayer === "A" ? "先手" : "後手"}です`] : [],
      kifuRecords: [],
      historyStack: [],
      aiThinking: false,
      aiVsAiPaused: false,
      kifuSaved: false,
      pieceNodes: new Map(),
      startedAt: Date.now(),
      // オンライン(手番リンク)関連
      onlineActions: [],
      // 形勢表示(対局中の優勢・劣勢の%)
      evalDisplay: !!opts.evalDisplay,
      evalView: null,
    };
    App.screen = "game";
    render();
    if (side === "random" && opts.mode === "pvai") toast(`ランダムの結果、あなたは${humanPlayer === "A" ? "先手" : "後手"}です`);
    startClockTicker();
    proceedTurn();
  }

  // ============================================================ 形勢表示
  // 局面が変わるたび(着手・待った・対局開始・時間切れ)に読み直す。読むのは専用の Worker だが、
  // 相手AIの思考中は読まない(Python版では読みが同じCPUを取り合ってAIが弱くなるため。両版で揃える)。
  function evalUsesTemplate(m) {
    const cfg = m.engine.config;
    return m.ruleTemplate === C.TEMPLATE_ID
      || C.configMatchesTemplate(cfg.rows, cfg.cols, cfg.moveRange, cfg.contactLimit, cfg.wallSandwich, m.stockA, m.stockB);
  }

  // then: 読み終えたら呼ぶ(AI同士の対戦で、形勢を読んでから次のAIに考えさせるため)
  function refreshEval(then) {
    const m = App.match;
    if (!m || !m.evalDisplay) { if (then) then(); return; }
    const prev = m.evalView && m.evalView.result;
    if (m.engine.isOver()) {
      cancelEval();
      m.evalView = { status: "ready", result: AI.evaluatePosition(m.engine, false) };
      drawEvalMeter();
      if (then) then();
      return;
    }
    if (m.aiThinking) {
      cancelEval();
      m.evalView = { status: "paused", result: prev };
      drawEvalMeter();
      return;
    }
    m.evalView = { status: "thinking", result: prev };
    drawEvalMeter();
    requestEval(m.engine, evalUsesTemplate(m), (result) => {
      if (App.match !== m) return;
      m.evalView = { status: result ? "ready" : "failed", result: result || prev };
      drawEvalMeter();
      if (then) then();
    });
  }

  // 次の手番へ進める: 相手AIの思考を始め、形勢を読み直す。AI同士の対戦で形勢表示ありなら、
  // 形勢を読み終えてから次のAIに考えさせる(AIの読みと形勢の読みを同時に走らせない)
  function proceedTurn() {
    const m = App.match;
    if (m.mode === "ai_vs_ai" && m.evalDisplay && !m.aiVsAiPaused && !m.engine.isOver()) {
      refreshEval(() => { if (App.match === m && !m.aiVsAiPaused) maybeTriggerAI(); });
      return;
    }
    maybeTriggerAI();
    refreshEval();
  }

  // ---- 詰めピンチ ---------------------------------------------------
  // 問題は tsume-data.js(tsume_lab.js が実戦の棋譜と AI 自己対戦から発掘し、
  // tsume.js のソルバーで手数・唯一解を証明したもの)。受け方の AI は同じソルバーで
  // 「最も長く粘る受け」を返し、あなたの手で詰みが消えたら逃れの手を指して失敗を知らせる。
  const T = window.HasamiTsume;
  const TD = window.HasamiTsumeData;
  const LS_TSUME = "hasami:tsume:v2";
  const LS_TSUME_MINE = "hasami:tsume:mine:v1";
  const TSUME_SLACK = 2; // 最短より2手長い詰みまではクリアと認める(星は2つ)

  function loadTsumeProgress() { try { return JSON.parse(localStorage.getItem(LS_TSUME) || "{}"); } catch (e) { return {}; } }
  function saveTsumeProgress(p) { try { localStorage.setItem(LS_TSUME, JSON.stringify(p)); } catch (e) { /* 保存できなくても遊べる */ } }
  function loadMyPuzzles() { try { return JSON.parse(localStorage.getItem(LS_TSUME_MINE) || "[]"); } catch (e) { return []; } }
  function saveMyPuzzles(list) { try { localStorage.setItem(LS_TSUME_MINE, JSON.stringify(list.slice(-20))); } catch (e) { /* 同上 */ } }

  function markTsume(puzzle, patch) {
    const prog = loadTsumeProgress();
    const cur = prog[puzzle.id] || {};
    if (patch.stars) cur.stars = Math.max(cur.stars || 0, patch.stars);
    if (patch.viewed) cur.viewed = true;
    prog[puzzle.id] = cur;
    saveTsumeProgress(prog);
  }

  function tsumeKindText(puzzle) { return puzzle.quiet ? `詰めろ・${puzzle.par}手` : `${puzzle.par}手詰め`; }
  function tsumeTitle(puzzle) { return (puzzle.no ? `No.${puzzle.no} ` : "新作 ") + tsumeKindText(puzzle); }
  function tsumeRuleText(p) {
    return `${p.rows}×${p.cols}・移動${p.moveRange}・接触${p.contactLimit == null ? "なし" : p.contactLimit}`;
  }
  function tsumeSourceText(puzzle) {
    const s = puzzle.source || {};
    if (s.kind === "kifu") return `実戦 ${s.file.replace(/^kifu_|\.csv$/g, "")} ${s.ply + 1}手目の局面`;
    if (s.kind === "self") return "AI自己対戦から作問";
    return "自動生成";
  }
  function starText(n) { return "★".repeat(n || 0) + "☆".repeat(3 - (n || 0)); }

  function startTsumePuzzle(puzzle) {
    const engine = T.engineFromPosition(puzzle.position);
    App.match = {
      mode: "tsume",
      puzzle,
      boardSize: puzzle.position.rows, moveRange: puzzle.position.moveRange,
      contactLimit: puzzle.position.contactLimit,
      stockA: puzzle.position.stockA, stockB: puzzle.position.stockB,
      ruleTemplate: null,
      engine,
      humanPlayer: puzzle.position.currentPlayer, // 出題局面の手番側を持つ(先手の問題も後手の問題もある)
      selected: null,
      lastAction: null,
      logMessages: [],
      kifuRecords: [],
      historyStack: [],
      aiThinking: false,
      aiVsAiPaused: false,
      kifuSaved: false,
      pieceNodes: new Map(),
      startedAt: Date.now(),
      tsumeHintUsed: false,
      tsumeUndoUsed: false,
      tsumeFailed: null,   // 失敗の説明文(詰みを逃した)
      tsumeReplay: null,   // 解答の再生中 { step, timer, done }
      tsumeHint: null,     // { engine, stage(1=駒 / 2=行き先), move, plies }
      tsumeStars: 0,
    };
    App.screen = "game";
    render();
  }

  // 何手進んだか・あなたが挟まない手を何回使ったか(待ったに追従するよう棋譜から数える)
  function tsumeCounts(m) {
    const mine = m.kifuRecords.filter((r) => r.mover === m.humanPlayer);
    return { plies: m.kifuRecords.length, quietUsed: mine.filter((r) => !r.sandwiched.length).length };
  }
  function tsumeQuietLeft(m) { return Math.max(0, (m.puzzle.quiet || 0) - tsumeCounts(m).quietUsed); }
  function tsumeBudget(m) { return m.puzzle.par + TSUME_SLACK - tsumeCounts(m).plies; }

  // あなたの手番で指せる手。挟む手だけに絞る(詰めろ問題で挟まない手が残っていれば null = 制限なし)
  function tsumeAllowedMoves(m) {
    if (tsumeQuietLeft(m) > 0) return null;
    return T.checkMovesOf(m.engine, m.humanPlayer);
  }

  function startTsumeDefense() {
    const m = App.match;
    const defender = otherPlayer(m.humanPlayer);
    m.aiThinking = true;
    m.busyText = "相手が受けを考えています";
    m.selected = null;
    updateGameUI();
    const targetEngine = m.engine;
    requestTsume("defend", m.engine, m.humanPlayer, tsumeQuietLeft(m), tsumeBudget(m), (res) => {
      if (App.match !== m || m.engine !== targetEngine) return; // やり直し・解答再生で破棄された
      m.aiThinking = false;
      m.busyText = null;
      if (!res) { updateGameUI(); toast("受けの計算に失敗しました。「やり直す」を押してください。"); return; }
      pushHistory(defender);
      const fromPos = res.move[0] === "move" ? m.engine.pieces.get(res.move[1]).position.slice() : null;
      applyLocalAction(defender, res.move, fromPos);
      m.lastAction = res.move[0] === "move" ? { from: fromPos, to: res.move[2] } : { from: null, to: res.move[1] };
      if (!res.proven && !m.engine.isOver()) {
        m.tsumeFailed = tsumeBudget(m) <= 1
          ? `手数切れです。最短${m.puzzle.par}手の問題なので、${m.puzzle.par + TSUME_SLACK}手以内に詰ませましょう。`
          : `詰みを逃しました。相手は ${res.label.replace("-", "→")} と受けて逃れました。`;
      }
      afterPlayerAction();
    });
  }

  function requestTsumeHint() {
    const m = App.match;
    if (!m || m.mode !== "tsume" || m.engine.isOver() || m.tsumeFailed || m.tsumeReplay || m.aiThinking) return;
    if (m.engine.currentPlayer !== m.humanPlayer) return;
    if (activeTsumeHint(m)) {
      m.tsumeHint.stage = 2;
      updateGameUI();
      return;
    }
    m.aiThinking = true;
    m.busyText = "ヒントを探しています";
    updateGameUI();
    const targetEngine = m.engine;
    requestTsume("hint", m.engine, m.humanPlayer, tsumeQuietLeft(m), tsumeBudget(m), (res) => {
      if (App.match !== m || m.engine !== targetEngine) return;
      m.aiThinking = false;
      m.busyText = null;
      if (!res) {
        updateGameUI();
        toast("この局面からは手数内の詰みが見つかりません。「待った」で戻ってみましょう。");
        return;
      }
      m.tsumeHintUsed = true;
      m.tsumeHint = { engine: m.engine, at: m.kifuRecords.length, stage: 1, move: res.move, plies: res.plies };
      updateGameUI();
    });
  }

  // ヒントは出した局面でだけ有効(エンジンは指すたびに書き換わるので手数も合わせて見る)
  function activeTsumeHint(m) {
    const h = m.tsumeHint;
    return h && h.engine === m.engine && h.at === m.kifuRecords.length ? h : null;
  }

  function tsumeHintText(m) {
    const h = activeTsumeHint(m);
    if (!h) return "";
    if (h.move[0] === "place") {
      return h.stage === 1 ? "ヒント1: 駒を配置する手です(もう一度押すと場所)"
        : `ヒント2: ${posLabel(h.move[1])} に配置(あと${h.plies}手で詰み)`;
    }
    const from = m.engine.pieces.get(h.move[1]).position;
    return h.stage === 1 ? `ヒント1: ${posLabel(from)} の駒を動かします(もう一度押すと行き先)`
      : `ヒント2: ${posLabel(from)} → ${posLabel(h.move[2])}(あと${h.plies}手で詰み)`;
  }

  // 解答(主手順)を最初から自動で並べる
  function startTsumeReplay() {
    const m = App.match;
    if (!m || m.mode !== "tsume") return;
    stopTsumeReplay(m);
    pendingReqId = null; // 計算中の受け・ヒントの結果は捨てる
    m.aiThinking = false;
    m.busyText = null;
    m.engine = T.engineFromPosition(m.puzzle.position);
    m.logMessages = [];
    m.kifuRecords = [];
    m.historyStack = [];
    m.selected = null;
    m.lastAction = null;
    m.tsumeFailed = null;
    m.tsumeHint = null;
    m.tsumeReplay = { step: 0, timer: null, done: false };
    markTsume(m.puzzle, { viewed: true });
    updateGameUI();
    scheduleTsumeReplayStep(m);
  }

  function scheduleTsumeReplayStep(m) {
    const rp = m.tsumeReplay;
    rp.timer = setTimeout(() => {
      if (App.match !== m || m.tsumeReplay !== rp) return;
      const action = T.actionFromLabel(m.engine, m.puzzle.line[rp.step]);
      const mover = m.engine.currentPlayer;
      const fromPos = action[0] === "move" ? m.engine.pieces.get(action[1]).position.slice() : null;
      applyLocalAction(mover, action, fromPos);
      m.lastAction = action[0] === "move" ? { from: fromPos, to: action[2] } : { from: null, to: action[1] };
      rp.step++;
      if (rp.step >= m.puzzle.line.length) { rp.done = true; rp.timer = null; } else scheduleTsumeReplayStep(m);
      updateGameUI();
    }, rp.step === 0 ? 600 : 1100);
  }

  function stopTsumeReplay(m) {
    if (m && m.tsumeReplay && m.tsumeReplay.timer) { clearTimeout(m.tsumeReplay.timer); m.tsumeReplay.timer = null; }
  }

  function tsumeListFor(puzzle) {
    if (!puzzle.no) return loadMyPuzzles();
    return TD.PUZZLES;
  }
  // 今の問題の次にある、まだ星3つでない問題(なければ単に次の問題)
  function nextTsumePuzzle(puzzle) {
    const list = tsumeListFor(puzzle);
    const i = list.findIndex((p) => p.id === puzzle.id);
    const prog = loadTsumeProgress();
    for (let k = 1; k <= list.length; k++) {
      const p = list[(i + k) % list.length];
      if ((prog[p.id] || {}).stars !== 3) return p;
    }
    return list[(i + 1) % list.length];
  }

  // 対局画面の上に出す、問題のルールと進み具合
  function updateTsumePanel() {
    const m = App.match, dom = App.gameDom;
    if (!dom.tsumePanel) return;
    const pz = m.puzzle;
    const c = tsumeCounts(m);
    clearNode(dom.tsumePanel);
    const rule = pz.quiet
      ? `${tsumeKindText(pz)}:毎手、相手の駒を挟む(挟まない手は あと${tsumeQuietLeft(m)}回まで)`
      : `${tsumeKindText(pz)}:毎手、相手の駒を挟んで、義務の駒を動けなくしよう`;
    dom.tsumePanel.appendChild(el("div", { class: "tsume-rule", text: rule }));
    const finished = m.engine.isOver() || m.tsumeFailed || (m.tsumeReplay && m.tsumeReplay.done);
    const meta = [`${tsumeRuleText(pz.position)}`, `${c.plies}手指した / 最短${pz.par}手`, tsumeSourceText(pz)];
    if (finished && pz.tags && pz.tags.length) meta.push("テーマ: " + pz.tags.join("・"));
    dom.tsumePanel.appendChild(el("div", { class: "tsume-meta", text: meta.join(" · ") }));
    const hint = tsumeHintText(m);
    if (hint) dom.tsumePanel.appendChild(el("div", { class: "tsume-hint", text: hint }));
  }

  // ---- 詰めピンチの問題一覧 ----
  const TSUME_GEN_BOARDS = [
    { key: "t7", label: "7×7 標準", config: { rows: 7, cols: 7, moveRange: 3, contactLimit: 3, wallSandwich: true }, stock: 15 },
    { key: "s5", label: "5×5", config: { rows: 5, cols: 5, moveRange: 3, contactLimit: 3, wallSandwich: true }, stock: 8 },
    { key: "r1", label: "7×7・移動1", config: { rows: 7, cols: 7, moveRange: 1, contactLimit: 4, wallSandwich: true }, stock: 13 },
    { key: "b9", label: "9×9", config: { rows: 9, cols: 9, moveRange: 3, contactLimit: 3, wallSandwich: true }, stock: 21 },
  ];
  const TSUME_GEN_LENGTHS = [
    { key: "3", label: "3手", minPar: 3, maxPar: 3, quiet: 0 },
    { key: "5", label: "5手", minPar: 5, maxPar: 5, quiet: 0 },
    { key: "7", label: "7手", minPar: 7, maxPar: 7, quiet: 0 },
    { key: "9", label: "9手以上", minPar: 9, maxPar: 15, quiet: 0 },
    { key: "q", label: "詰めろ", minPar: 3, maxPar: 7, quiet: 1 },
  ];
  let tsumeGenWorker = null;

  function renderTsumeMenu(root) {
    const screen = el("div", { class: "screen" });
    screen.appendChild(el("h1", { class: "card-title", text: "詰めピンチ", style: { fontSize: "24px" } }));
    screen.appendChild(el("div", {
      class: "field-hint", style: { textAlign: "center", maxWidth: "580px" },
      text: "「正しく指せば必ず勝てる」と証明済みの局面から、相手を詰ませる問題集です。"
        + "詰将棋の王手と同じく、あなたは毎手かならず相手の駒を挟みます(=移動義務を負わせる)。"
        + "相手が義務のある駒をどれも動かせなくなれば詰み。相手は最も長く粘る受けを返してきます。",
    }));

    const prog = loadTsumeProgress();
    const all = TD.PUZZLES;
    const cleared = all.filter((p) => (prog[p.id] || {}).stars).length;
    const perfect = all.filter((p) => (prog[p.id] || {}).stars === 3).length;
    screen.appendChild(el("div", { class: "tsume-progress", text: `クリア ${cleared} / ${all.length} 問 ・ ★3つ ${perfect} 問` }));

    const tabs = TD.CATEGORIES.map((c) => ({ key: c.key, label: c.title })).concat([{ key: "gen", label: "新作を作る" }]);
    if (!App.tsumeTab) {
      const firstOpen = TD.CATEGORIES.find((c) => all.some((p) => p.category === c.key && !(prog[p.id] || {}).stars));
      App.tsumeTab = firstOpen ? firstOpen.key : TD.CATEGORIES[0].key;
    }
    const tabRow = el("div", { class: "tsume-tabs", role: "tablist" });
    tabs.forEach((t) => {
      const count = t.key === "gen" ? null : all.filter((p) => p.category === t.key);
      const done = count ? count.filter((p) => (prog[p.id] || {}).stars).length : 0;
      tabRow.appendChild(el("button", {
        class: "tsume-tab", role: "tab", "aria-selected": String(App.tsumeTab === t.key),
        onclick: () => { App.tsumeTab = t.key; render(); },
      }, [el("span", { text: t.label }), count ? el("span", { class: "tsume-tab-count", text: `${done}/${count.length}` }) : null]));
    });
    screen.appendChild(tabRow);

    const card = el("div", { class: "card", style: { width: "min(580px,100%)" } });
    if (App.tsumeTab === "gen") {
      renderTsumeGenerator(card);
    } else {
      const cat = TD.CATEGORIES.find((c) => c.key === App.tsumeTab);
      card.appendChild(el("div", { class: "tsume-cat-head", text: `${cat.title}(${cat.sub})` }));
      all.filter((p) => p.category === App.tsumeTab).forEach((p) => card.appendChild(tsumeRow(p, prog)));
    }
    screen.appendChild(card);
    root.appendChild(screen);
  }

  function tsumeRow(p, prog) {
    const st = prog[p.id] || {};
    const row = el("div", { class: "history-row" });
    const subParts = [tsumeRuleText(p.position), tsumeSourceText(p)];
    // テーマはネタバレになるので、クリアするか解答を見るまで伏せる
    if ((st.stars || st.viewed) && p.tags && p.tags.length) subParts.push("テーマ: " + p.tags.join("・"));
    row.appendChild(el("div", { class: "history-text" }, [
      el("div", { class: "history-head" }, [
        el("span", { text: tsumeTitle(p) }),
        el("span", { class: `tsume-stars${st.stars ? " is-on" : ""}`, text: starText(st.stars) }),
        st.viewed && !st.stars ? el("span", { class: "tsume-viewed", text: "解答を見た" }) : null,
      ]),
      el("div", { class: "history-sub", text: subParts.join(" · ") }),
    ]));
    row.appendChild(el("button", {
      class: st.stars ? "btn btn-compact" : "btn btn-primary", text: st.stars ? "再挑戦" : "挑戦する",
      style: { width: "auto", fontSize: "14px", padding: "10px 18px" }, onclick: () => startTsumePuzzle(p),
    }));
    return row;
  }

  function renderTsumeGenerator(card) {
    card.appendChild(el("div", { class: "tsume-cat-head", text: "新作を作る(その場で自動作問)" }));
    card.appendChild(el("div", {
      class: "field-hint",
      text: "学習型AI同士の速い対局を裏で指し進め、条件に合う詰み局面が現れたら、"
        + "唯一解を確かめて不要な駒を取り除き、1問に仕上げます。数秒〜1分ほどかかります。",
    }));
    if (!App.tsumeGen) App.tsumeGen = { board: "t7", length: "5" };
    const g = App.tsumeGen;
    const segOf = (items, key) => {
      const wrap = el("div", { class: "seg", role: "radiogroup" });
      items.forEach((it) => wrap.appendChild(el("button", {
        role: "radio", "aria-checked": String(g[key] === it.key), text: it.label,
        onclick: () => { g[key] = it.key; render(); },
      })));
      return wrap;
    };
    card.appendChild(el("div", { class: "field-row" }, [el("span", { class: "field-label", text: "盤" }), segOf(TSUME_GEN_BOARDS, "board")]));
    card.appendChild(el("div", { class: "field-row" }, [el("span", { class: "field-label", text: "手数" }), segOf(TSUME_GEN_LENGTHS, "length")]));
    const status = el("div", { class: "field-hint tsume-gen-status" });
    const btn = el("button", { class: "btn btn-primary", text: "作問する", style: { width: "auto" } });
    btn.addEventListener("click", () => generateTsume(status, btn));
    card.appendChild(el("div", { class: "tsume-gen-actions" }, [btn, status]));

    const mine = loadMyPuzzles();
    if (mine.length) {
      card.appendChild(el("div", { class: "tsume-cat-head", text: "作った問題(新しい順・最大20問)", style: { marginTop: "18px" } }));
      const prog = loadTsumeProgress();
      mine.slice().reverse().forEach((p) => card.appendChild(tsumeRow(p, prog)));
    }
  }

  function generateTsume(status, btn) {
    if (!Worker_) { toast("この環境では自動作問を使えません(Web Workerが必要です)"); return; }
    if (tsumeGenWorker) { tsumeGenWorker.terminate(); tsumeGenWorker = null; }
    const board = TSUME_GEN_BOARDS.find((b) => b.key === App.tsumeGen.board);
    const len = TSUME_GEN_LENGTHS.find((l) => l.key === App.tsumeGen.length);
    let w;
    try { w = new Worker_("ai-worker.js?v=8"); } catch (e) { toast("自動作問を開始できませんでした(ローカルサーバー経由で開いてください)"); return; }
    tsumeGenWorker = w;
    btn.disabled = true;
    status.textContent = "作問中…(AI同士の対局から詰み局面を探しています)";
    const done = () => { w.terminate(); if (tsumeGenWorker === w) tsumeGenWorker = null; btn.disabled = false; };
    w.onmessage = (e) => {
      if (e.data.progress != null) { status.textContent = `作問中…(${e.data.progress}局目を調べ終えました)`; return; }
      done();
      if (!e.data.ok || !e.data.result) {
        status.textContent = "時間内に条件に合う問題が見つかりませんでした。もう一度お試しください。";
        return;
      }
      const pz = Object.assign(e.data.result, { id: `my-${Date.now()}`, category: "gen" });
      const list = loadMyPuzzles();
      list.push(pz);
      saveMyPuzzles(list);
      if (App.screen === "tsume") startTsumePuzzle(pz);
    };
    w.onerror = () => { done(); status.textContent = "自動作問に失敗しました(ローカルサーバー経由で開くと動きます)"; };
    w.postMessage({
      kind: "tsume", op: "generate", reqId: 1,
      opts: {
        config: board.config, stock: board.stock, minPar: len.minPar, maxPar: len.maxPar, quiet: len.quiet,
        seed: Math.floor(Math.random() * 0xffffffff), timeLimit: 60000, nodeLimit: 60000,
      },
    });
  }

  function pushHistory(mover) {
    const m = App.match;
    m.historyStack.push({
      engine: m.engine.clone(), mover, logLen: m.logMessages.length, kifuLen: m.kifuRecords.length,
      onlineLen: m.onlineActions ? m.onlineActions.length : 0,
    });
    if (m.historyStack.length > 60) m.historyStack.shift();
  }

  function aiStrengthName(level, specialist) { return specialist ? AI.SPECIALIST_AI_NAME : AI.LEVELS[level].name; }

  function playerDisplayName(player) {
    const m = App.match;
    if (m.mode === "pvai" || m.mode === "tsume") return player === m.humanPlayer ? "あなた" : "AI";
    if (m.mode === "online") return player === "A" ? "先手" : "後手";
    if (m.mode === "ai_vs_ai") return player === "A" ? "先手AI" : "後手AI";
    return player === "A" ? "プレイヤー1" : "プレイヤー2";
  }
  function pieceLabelFor(player) {
    const m = App.match;
    if (m.mode === "pvai" || m.mode === "tsume") return player === m.humanPlayer ? "You" : "AI";
    if (m.mode === "online") return player === "A" ? "1" : "2";
    if (m.mode === "ai_vs_ai") return player;
    return player === "A" ? "1" : "2";
  }
  function modeLabelText() {
    const m = App.match;
    if (m.mode === "pvai") {
      const resumed = m.resumedFrom ? `・感想戦の${m.resumedFrom.ply}手目から再開` : "";
      return `AI戦 - ${aiStrengthName(m.aiLevel, m.aiSpecialist)}(あなたは${m.humanPlayer === "A" ? "先手" : "後手"}${resumed})`;
    }
    if (m.mode === "tsume") return `詰めピンチ ${tsumeTitle(m.puzzle)}`;
    if (m.mode === "pvp") return m.timeControl ? `対人戦(同画面) - ${timeControlLabel(m.timeControl)}` : "対人戦(同画面)";
    if (m.mode === "online") return "オンライン対戦(手番リンク)";
    if (m.mode === "ai_vs_ai") return `AI同士の対戦 - 先手:${aiStrengthName(m.aiLevel, m.aiSpecialist)} / 後手:${aiStrengthName(m.aiLevelB, m.aiSpecialistB)}`;
    return m.mode;
  }

  function logAction(player, action, result, fromPos) {
    const m = App.match;
    const name = playerDisplayName(player);
    let msg, kifuAction, kifuFrom, kifuTo;
    if (action[0] === "place") {
      const pos = action[1];
      msg = `${name}が${posLabel(pos)}に配置`;
      kifuAction = "配置"; kifuFrom = ""; kifuTo = posLabel(pos);
    } else {
      const dest = action[2];
      msg = `${name}が${posLabel(dest)}へ移動`;
      kifuAction = "移動"; kifuFrom = fromPos ? posLabel(fromPos) : ""; kifuTo = posLabel(dest);
    }
    let sandwichedLabels = [];
    if (result.newlySandwiched.length) {
      sandwichedLabels = result.newlySandwiched.filter((pid) => m.engine.pieces.has(pid)).map((pid) => posLabel(m.engine.pieces.get(pid).position));
      if (sandwichedLabels.length) msg += "(" + sandwichedLabels.join(",") + "を挟んだ)";
    }
    if (result.selfSandwiched) msg += "(自分の駒が挟まれた)";
    if (result.draw) msg += "(千日手成立)";
    m.logMessages.push(msg);
    m.kifuRecords.push({
      turn: m.kifuRecords.length + 1, player: name, mover: player, action: kifuAction,
      from: kifuFrom, to: kifuTo, sandwiched: sandwichedLabels, selfSandwiched: result.selfSandwiched,
    });
    return { sandwichedLabels };
  }

  function applyLocalAction(player, action, fromPos) {
    const m = App.match;
    const result = AI.applyAction(m.engine, player, action);
    const extra = logAction(player, action, result, fromPos);
    if (m.clock) {
      clockCommit(m.clock, player);
      if (m.engine.isOver()) stopClock(m.clock);
    }
    if (m.mode === "online" && m.onlineActions) {
      m.onlineActions.push(action[0] === "place"
        ? { kind: "place", to: action[1] }
        : { kind: "move", from: fromPos, to: action[2] });
      if (App.onlineRefreshLink) App.onlineRefreshLink();
    }
    return { result, extra };
  }

  function aiOptsFor(player) {
    const m = App.match;
    if (m.mode === "pvai") return { level: m.aiLevel, specialist: m.aiSpecialist };
    return player === "A" ? { level: m.aiLevel, specialist: m.aiSpecialist } : { level: m.aiLevelB, specialist: m.aiSpecialistB };
  }

  function maybeTriggerAI() {
    const m = App.match;
    if (!m || m.engine.isOver()) return;
    const current = m.engine.currentPlayer;
    if (m.mode === "tsume") {
      if (current !== m.humanPlayer && !m.tsumeFailed && !m.tsumeReplay) startTsumeDefense();
      return;
    }
    if (m.mode === "pvai" && current === otherPlayer(m.humanPlayer)) {
      startAIMove(current);
    } else if (m.mode === "ai_vs_ai" && !m.aiVsAiPaused) {
      startAIMove(current);
    }
  }

  function startAIMove(player) {
    const m = App.match;
    m.aiThinking = true;
    m.selected = null;
    if (m.evalDisplay) refreshEval(); // AIの思考中は形勢を読まない(読みかけは捨てる)
    updateGameUI();
    const targetEngine = m.engine;
    requestAIMove(m.engine, player, aiOptsFor(player), (action) => {
      if (App.match !== m || m.engine !== targetEngine) return; // 対局がリセットされていた
      m.aiThinking = false;
      if (action) {
        pushHistory(player);
        let fromPos = null;
        if (action[0] === "move") fromPos = m.engine.pieces.get(action[1]).position.slice();
        applyLocalAction(player, action, fromPos);
        m.lastAction = action[0] === "move" ? { from: fromPos, to: action[2] } : { from: null, to: action[1] };
      }
      afterPlayerAction();
    });
  }

  function afterPlayerAction() {
    recordIfFinished();
    updateGameUI();
    proceedTurn();
  }

  // ============================================================ 対局時計(対人戦の持ち時間)
  // 将棋の対局時計と同じく、手番側の時間だけが減る。持ち時間(main)を使い切ると秒読み(byo)に
  // 入り、1手ごとに byo 秒以内に指せば秒読みは元に戻る。秒読みなしなら持ち時間切れで負け、
  // inc>0 なら指すたびに持ち時間へ inc 秒を足す(フィッシャー)。時間は ms で持つ。
  function createClock(spec) {
    return {
      spec,
      main: { A: spec.main * 1000, B: spec.main * 1000 },
      side: "A",
      turnStart: performance.now(),
      paused: false, pausedElapsed: 0, stopped: false,
      flagged: null,
      lastBeep: null,
    };
  }

  function clockElapsed(ck) {
    if (ck.stopped || ck.paused) return ck.pausedElapsed;
    return performance.now() - ck.turnStart;
  }

  // 表示用の残り時間。byo は秒読みの残り(秒読みなしなら null)、inByo は秒読みに入っているか
  function clockView(ck, p) {
    const byoMs = ck.spec.byo * 1000;
    const elapsed = p === ck.side ? clockElapsed(ck) : 0;
    const main = Math.max(0, ck.main[p] - elapsed);
    const over = Math.max(0, elapsed - ck.main[p]);
    const byo = byoMs ? Math.max(0, byoMs - over) : null;
    const inByo = byoMs > 0 && main <= 0;
    const out = byo == null ? main <= 0 : byo <= 0;
    // 今カウントダウンしている残り(秒読み中は秒読み、それ以外は持ち時間)
    const counting = inByo ? byo : main;
    return { main, byo, inByo, out, counting };
  }

  // 手を指し終えた側の時計を止めて、相手の時計を動かす
  function clockCommit(ck, mover) {
    if (ck.stopped || ck.flagged) return;
    const v = clockView(ck, mover);
    ck.main[mover] = v.main + ck.spec.inc * 1000;
    ck.side = otherPlayer(mover);
    ck.turnStart = performance.now();
    ck.pausedElapsed = 0;
    ck.lastBeep = null;
  }

  function stopClock(ck) {
    if (!ck || ck.stopped) return;
    ck.pausedElapsed = clockElapsed(ck);
    ck.stopped = true;
  }

  function toggleClockPause() {
    const m = App.match;
    const ck = m && m.clock;
    if (!ck || ck.stopped) return;
    if (ck.paused) {
      ck.turnStart = performance.now() - ck.pausedElapsed;
      ck.paused = false;
    } else {
      ck.pausedElapsed = clockElapsed(ck);
      ck.paused = true;
      m.selected = null;
    }
    updateGameUI();
  }

  let clockTimer = null;
  function startClockTicker() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    const m = App.match;
    if (!m || !m.clock) return;
    clockTimer = setInterval(() => {
      if (App.match !== m || m.clock.stopped) { clearInterval(clockTimer); clockTimer = null; drawClocks(); return; }
      clockTick(m);
    }, 100);
  }

  // 時間切れの判定と秒読み音。盤面の操作より前にも呼んで、切れた後の着手を受け付けないようにする
  function clockTick(m) {
    const ck = m.clock;
    if (!ck || ck.stopped || ck.paused) return;
    if (m.engine.isOver()) { stopClock(ck); drawClocks(); return; }
    const v = clockView(ck, ck.side);
    if (v.out) { onClockFlag(m, ck.side); return; }
    if (m.clockSound && App.screen === "game") {
      const sec = Math.ceil(v.counting / 1000);
      if (sec <= clockLowSeconds(ck, v) && sec >= 1 && sec !== ck.lastBeep) {
        ck.lastBeep = sec;
        beep(sec <= 3 ? 1046 : 784, sec <= 5 ? 0.12 : 0.06);
      }
    }
    drawClocks();
  }

  // 残りがこの秒数を切ったら秒読みの音と赤い表示で知らせる
  // (残り10秒から。10秒将棋のように短い秒読みでは毎手鳴りっぱなしにならないよう半分から)
  function clockLowSeconds(ck, v) {
    return v.inByo ? Math.min(10, Math.floor(ck.spec.byo / 2)) : 10;
  }

  function onClockFlag(m, loser) {
    const ck = m.clock;
    ck.flagged = loser;
    stopClock(ck);
    m.engine.winner = otherPlayer(loser);
    m.timeoutLoser = loser;
    m.selected = null;
    m.logMessages.push(`${playerDisplayName(loser)}の時間切れ`);
    if (m.clockSound) beep(523, 0.6);
    recordIfFinished();
    updateGameUI();
    refreshEval();
  }

  let audioCtx = null;
  function beep(freq, seconds) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = audioCtx || new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = audioCtx.currentTime;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + seconds + 0.02);
    } catch (e) { /* 音が出せない環境でも時計は動く */ }
  }

  function formatClock(ms) {
    const total = Math.ceil(ms / 1000);
    const mm = Math.floor(total / 60), ss = total % 60;
    return `${mm}:${String(ss).padStart(2, "0")}`;
  }

  function drawClocks() {
    const m = App.match, dom = App.gameDom;
    if (!m || !m.clock || !dom || !dom.clocks) return;
    const ck = m.clock;
    for (const p of ["A", "B"]) {
      const node = dom.clocks[p];
      const v = clockView(ck, p);
      const active = ck.side === p && !ck.stopped && !m.engine.isOver();
      node.root.classList.toggle("is-active", active);
      node.root.classList.toggle("is-paused", active && ck.paused);
      node.root.classList.toggle("is-low", active && v.counting <= clockLowSeconds(ck, v) * 1000);
      node.root.classList.toggle("is-out", ck.flagged === p);
      node.name.textContent = playerDisplayName(p);
      if (ck.flagged === p) {
        node.time.textContent = "時間切れ";
        node.sub.textContent = "";
      } else if (v.inByo) {
        node.time.textContent = `${Math.ceil(v.byo / 1000)}秒`;
        node.sub.textContent = `秒読み(1手${ck.spec.byo}秒)`;
      } else {
        node.time.textContent = formatClock(v.main);
        const parts = [];
        if (ck.spec.byo) parts.push(`秒読み${ck.spec.byo}秒`);
        if (ck.spec.inc) parts.push(`1手+${ck.spec.inc}秒`);
        if (!ck.spec.byo && !ck.spec.inc) parts.push("切れ負け");
        node.sub.textContent = parts.join(" / ");
      }
    }
  }

  function recordIfFinished() {
    const m = App.match;
    if (m.mode === "tsume") { // 詰めピンチの挑戦は対戦履歴ではなく問題ごとの星として残す
      if (m.engine.winner === m.humanPlayer && !m.tsumeReplay && !m.tsumeStars) {
        const c = tsumeCounts(m);
        m.tsumeStars = c.plies <= m.puzzle.par && !m.tsumeHintUsed && !m.tsumeUndoUsed ? 3 : 2;
        markTsume(m.puzzle, { stars: m.tsumeStars });
      }
      return;
    }
    if ((m.engine.winner || m.engine.isDraw) && !m.kifuSaved) {
      m.kifuSaved = true;
      const record = buildMatchRecord(m);
      const list = loadHistory();
      list.push(record);
      saveHistoryList(list);
      m.finishedRecord = record;
      if (record.ratingPending) processPendingRatings(); // 裏で指し手を解析してレートを更新する
    }
  }

  function resultText() {
    const m = App.match;
    if (m.engine.winner && m.timeoutLoser) return `${playerDisplayName(m.engine.winner)}の勝ち(${playerDisplayName(m.timeoutLoser)}の時間切れ)`;
    if (m.engine.winner) return `${playerDisplayName(m.engine.winner)}の勝ち`;
    if (m.engine.isDraw) return "引き分け(千日手)";
    return "不明(対局途中)";
  }

  function buildMatchRecord(m) {
    const ratingInfo = ratingInfoFor(m);
    return {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toLocaleString("ja-JP"),
      mode: m.mode,
      modeLabel: modeLabelText(),
      rows: m.engine.config.rows, cols: m.engine.config.cols,
      moveRange: m.engine.config.moveRange, contactLimit: m.engine.config.contactLimit,
      wallSandwich: m.engine.config.wallSandwich,
      stockA: m.stockA, stockB: m.stockB,
      playerALabel: playerDisplayName("A"), playerBLabel: playerDisplayName("B"),
      resultText: resultText(),
      evalDisplay: !!m.evalDisplay, // 形勢表示ありの対局(レートなどの集計で区別する)
      resumedFrom: m.resumedFrom || null, // 感想戦の途中から再開した対局(元の記録の id と再開した手数)
      undoUsed: !!m.undoUsed,
      ratingInfo: ratingInfo, // AI戦のレート計算に使う情報(対象外ならその理由)
      ratingPending: !!(ratingInfo && ratingInfo.eligible), // レート計算待ち(processPendingRatings が片づける)
      moves: m.kifuRecords.map((r) => Object.assign({}, r)),
    };
  }

  // ============================================================ 対局画面
  function renderGame(root) {
    const m = App.match;
    if (!m) { goto("menu"); return; }
    const screen = el("div", { class: "screen" });

    const topBar = el("div", { class: "top-bar" });
    topBar.appendChild(m.mode === "tsume"
      ? el("button", { class: "btn btn-compact", text: "← 問題一覧", onclick: () => goto("tsume") })
      : el("button", { class: "btn btn-compact", text: "← メニューに戻る", onclick: () => goto("menu") }));
    const modeText = el("span", { class: "mode-text" });
    topBar.appendChild(modeText);
    topBar.appendChild(el("div", { class: "grow" }));
    const stepBtn = el("button", { class: "btn btn-compact", text: "1手進める", onclick: onStepOnce });
    const pauseBtn = el("button", { class: "btn btn-compact", text: "一時停止", onclick: onTogglePause });
    const undoBtn = el("button", { class: "btn btn-compact", text: "待った(1手戻す)", onclick: onUndo });
    const restartBtn = el("button", { class: "btn btn-compact", text: m.mode === "tsume" ? "やり直す" : "新しく対戦", onclick: onRestart });
    const clockBtn = m.clock ? el("button", { class: "btn btn-compact", text: "時計を止める", onclick: toggleClockPause }) : null;
    if (m.mode === "ai_vs_ai") { topBar.appendChild(pauseBtn); topBar.appendChild(stepBtn); }
    else if (clockBtn) topBar.appendChild(clockBtn); // 持ち時間ありの対局は待ったなし
    else topBar.appendChild(undoBtn);
    let hintBtn = null;
    if (m.mode === "tsume") {
      hintBtn = el("button", { class: "btn btn-compact", text: "ヒント", onclick: requestTsumeHint });
      topBar.appendChild(hintBtn);
      topBar.appendChild(el("button", { class: "btn btn-compact", text: "解答を見る", onclick: startTsumeReplay }));
    }
    topBar.appendChild(restartBtn);
    screen.appendChild(topBar);

    const bannerHost = el("div", { class: "banner-host", style: { width: "min(560px,100%)" } });
    screen.appendChild(bannerHost);
    const tsumePanel = m.mode === "tsume" ? el("div", { class: "tsume-panel" }) : null;
    if (tsumePanel) screen.appendChild(tsumePanel);

    const turnRow = el("div", { class: "turn-row" });
    const turnText = el("div", { class: "turn-text" });
    turnRow.appendChild(turnText);
    screen.appendChild(turnRow);
    const obligationText = el("div", { class: "obligation-text" });
    screen.appendChild(obligationText);

    // ---- 対局時計(持ち時間ありの対人戦のみ) ----
    let clocks = null;
    if (m.clock) {
      const clockBar = el("div", { class: "clock-bar" });
      clocks = {};
      for (const p of ["A", "B"]) {
        const name = el("span", { class: "clock-name" });
        const time = el("span", { class: "clock-time" });
        const sub = el("span", { class: "clock-sub" });
        const node = el("div", { class: `clock clock-${p.toLowerCase()}` }, [
          el("div", { class: "clock-head" }, [el("span", { class: "clock-role", text: p === "A" ? "先手" : "後手" }), name]),
          time, sub,
        ]);
        clockBar.appendChild(node);
        clocks[p] = { root: node, name, time, sub };
      }
      screen.appendChild(clockBar);
    }

    // ---- 形勢表示(設定でオンにした対局のみ) ----
    let evalMeter = null;
    if (m.evalDisplay) {
      const nameA = el("span", { class: "eval-name" }), pctA = el("b", { class: "eval-pct" });
      const nameB = el("span", { class: "eval-name" }), pctB = el("b", { class: "eval-pct" });
      const fill = el("div", { class: "eval-fill" });
      const note = el("span", { class: "eval-note" });
      const meterRoot = el("div", {
        class: "eval-meter", title: "学習型AIが読んだ「強いAI同士がこの局面から続けた場合の勝率」の目安です(人間どうしの実際の勝率ではありません)",
      }, [
        el("div", { class: "eval-head" }, [el("span", { class: "eval-title", text: "形勢(目安)" }), note]),
        el("div", { class: "eval-row" }, [
          el("span", { class: "eval-side eval-side-a" }, [nameA, pctA]),
          el("div", { class: "eval-bar", role: "img" }, [fill, el("div", { class: "eval-mid" })]),
          el("span", { class: "eval-side eval-side-b" }, [pctB, nameB]),
        ]),
      ]);
      screen.appendChild(meterRoot);
      evalMeter = { root: meterRoot, nameA, pctA, nameB, pctB, fill, note, bar: meterRoot.querySelector(".eval-bar") };
    }

    // ---- 盤面 ----
    const boardWrap = el("div", { class: "board-wrap" });
    const size = m.engine.config.rows;
    const { boardFrame, board, grid, cellNodes, piecesLayer, fxLayer } =
      buildBoardShell(size, { onCellClick, fx: true });
    boardWrap.appendChild(boardFrame);

    const legend = el("div", { class: "legend-row" });
    const legA = el("span", {}, [el("span", { class: "legend-dot", style: { background: C.PLAYER_COLORS.A.legend } }), document.createTextNode(playerDisplayName("A"))]);
    const legB = el("span", {}, [el("span", { class: "legend-dot", style: { background: C.PLAYER_COLORS.B.legend } }), document.createTextNode(playerDisplayName("B"))]);
    legend.appendChild(legA); legend.appendChild(legB);
    legend.appendChild(el("span", { style: { color: "var(--warning)" }, text: "┅ 直前の手" }));
    boardWrap.appendChild(legend);
    screen.appendChild(boardWrap);

    // ---- ステータスカード ----
    const statusGrid = el("div", { class: "status-grid" });
    const sideA = buildSideCard("A");
    const sideB = buildSideCard("B");
    statusGrid.appendChild(sideA.node);
    statusGrid.appendChild(sideB.node);
    screen.appendChild(statusGrid);

    // ---- 対戦ログ ----
    const logPanel = el("div", { class: "log-panel" });
    logPanel.appendChild(el("div", { class: "log-head" }, [el("span", { text: "対戦ログ" })]));
    const logList = el("ul", { class: "log-list" });
    logPanel.appendChild(logList);
    screen.appendChild(logPanel);

    root.appendChild(screen);

    function buildSideCard(player) {
      const node = el("div", { class: `side-card side-${player.toLowerCase()}` });
      node.appendChild(el("div", { class: "side-role", text: player === "A" ? "先手" : "後手" }));
      const name = el("div", { class: `side-name ${player.toLowerCase()}` });
      node.appendChild(name);
      const turn = el("div", { class: "side-turn", text: "手番" });
      node.appendChild(turn);
      const stockRow = el("div", { class: "stock-row" }, [el("span", { text: "持ち駒" }), el("span", { class: "stock-count" })]);
      node.appendChild(stockRow);
      const dots = el("div", { class: "stock-dots" });
      node.appendChild(dots);
      const alert = el("div", { class: "side-alert" });
      node.appendChild(alert);
      return { node, name, turn, stockCount: stockRow.querySelector(".stock-count"), dots, alert };
    }

    // ---- 保存しておいて updateGameUI から参照する ----
    App.gameDom = {
      modeText, turnText, obligationText, bannerHost, undoBtn, restartBtn, stepBtn, pauseBtn, hintBtn, tsumePanel,
      clockBtn, clocks, evalMeter,
      board, grid, cellNodes, piecesLayer, fxLayer, size, sideA, sideB, logList,
    };
    m.pieceNodes = new Map();
    updateGameUI();
  }

  // 人間が今選べる駒・行き先・配置先(詰めピンチでは「挟む手」だけに絞る)
  function humanMoveRules(m) {
    const engine = m.engine, player = engine.currentPlayer;
    const allowed = m.mode === "tsume" ? tsumeAllowedMoves(m) : null;
    const obl = new Set(engine.obligated[player]);
    return {
      allowed,
      canSelect: (piece) => piece.player === player && (allowed ? allowed.has(piece.id) : (!obl.size || obl.has(piece.id))),
      dests: (piece) => (allowed ? (allowed.get(piece.id) || []) : engine.legalMoves(piece.id)),
      placements: () => (allowed || obl.size ? [] : engine.legalPlacements(player)),
    };
  }

  function onCellClick(r, c) {
    const m = App.match;
    if (m && m.clock) clockTick(m); // 時間切れ後の着手は受け付けない
    if (!m || m.engine.isOver() || m.aiThinking) return;
    if (m.clock && m.clock.paused) { toast("時計が止まっています。「時計を再開」を押してください"); return; }
    const engine = m.engine;
    const player = engine.currentPlayer;
    if ((m.mode === "pvai" || m.mode === "tsume") && player === otherPlayer(m.humanPlayer)) return;
    if (m.mode === "tsume" && (m.tsumeFailed || m.tsumeReplay)) return;
    if (m.mode === "ai_vs_ai") return;

    const piece = engine.pieceAt([r, c]);
    const rules = humanMoveRules(m);
    const trySelect = () => {
      if (rules.canSelect(piece)) { m.selected = [r, c]; updateGameUI(); return; }
      if (rules.allowed && (!engine.obligated[player].length || engine.obligated[player].includes(piece.id))) {
        toast("この駒では相手を挟めません(詰めピンチでは毎手、相手の駒を挟みます)");
      }
    };

    if (m.selected) {
      const [sr, sc] = m.selected;
      if (sr === r && sc === c) {
        if (engine.obligated[player].length !== 1) m.selected = null;
        updateGameUI();
        return;
      }
      const selPiece = engine.pieceAt(m.selected);
      if (selPiece && rules.dests(selPiece).some((p) => p[0] === r && p[1] === c)) {
        pushHistory(player);
        const action = ["move", selPiece.id, [r, c]];
        applyLocalAction(player, action, [sr, sc]);
        m.lastAction = { from: [sr, sc], to: [r, c] };
        m.selected = null;
        afterPlayerAction();
        return;
      }
      if (piece && piece.player === player) trySelect();
      return;
    }

    if (piece && piece.player === player) { trySelect(); return; }

    if (!piece) {
      if (rules.placements().some((p) => p[0] === r && p[1] === c)) {
        pushHistory(player);
        const action = ["place", [r, c]];
        applyLocalAction(player, action, null);
        m.lastAction = { from: null, to: [r, c] };
        afterPlayerAction();
      } else if (rules.allowed && !engine.obligated[player].length) {
        toast("詰めピンチでは配置できません(配置では相手を挟めないため)");
      }
    }
  }

  // 「待った」で戻る先(historyStack の添字)。AI戦はあなたの手番の局面まで戻す
  // (あなたが後手でAIの初手しか無いときなど、戻れる局面が無ければ null)
  function undoTargetIndex(m) {
    if (m.mode !== "pvai") return m.historyStack.length ? m.historyStack.length - 1 : null;
    for (let i = m.historyStack.length - 1; i >= 0; i--) if (m.historyStack[i].mover === m.humanPlayer) return i;
    return null;
  }

  function onUndo() {
    const m = App.match;
    if (m.aiThinking || !m.historyStack.length || m.clock) return;
    if (m.mode === "tsume" && m.tsumeReplay) return;
    let snap = null;
    if (m.mode === "tsume") {
      // あなたの手番まで戻す(失敗した手・詰ませた手の直前に戻れる)
      do { snap = m.historyStack.pop(); } while (m.historyStack.length && snap.engine.currentPlayer !== m.humanPlayer);
      m.tsumeUndoUsed = true;
      m.tsumeFailed = null;
      m.tsumeHint = null;
    } else {
      const target = undoTargetIndex(m);
      if (target == null) return;
      while (m.historyStack.length > target) snap = m.historyStack.pop();
      m.undoUsed = true; // 待ったを使った対局はレートの対象外
    }
    m.engine = snap.engine;
    m.logMessages.length = snap.logLen;
    m.kifuRecords.length = snap.kifuLen;
    if (m.onlineActions) m.onlineActions.length = snap.onlineLen;
    m.selected = null;
    m.lastAction = null;
    updateGameUI();
    refreshEval();
    if (App.onlineRefreshLink) App.onlineRefreshLink();
  }

  function onRestart() {
    const m = App.match;
    // 「新しく対戦」は Python 版と同様、確認なしで即座に新しい対局へ切り替える。
    if (m.mode === "online") { App.match = null; App.screen = "online"; render(); return; }
    if (m.mode === "tsume") { startTsumePuzzle(m.puzzle); return; }
    startNewMatch({
      mode: m.mode, boardSize: m.boardSize, moveRange: m.moveRange, contactLimit: m.contactLimit,
      aiLevel: m.aiLevel, aiLevelB: m.aiLevelB, aiSpecialist: m.aiSpecialist, aiSpecialistB: m.aiSpecialistB,
      stockA: m.stockA, stockB: m.stockB, ruleTemplate: m.ruleTemplate,
      side: m.sideChoice || m.humanPlayer, timeControl: m.timeControl, clockSound: m.clockSound,
      evalDisplay: m.evalDisplay,
    });
  }

  function onStepOnce() {
    const m = App.match;
    if (m.mode !== "ai_vs_ai" || m.engine.isOver() || m.aiThinking) return;
    startAIMove(m.engine.currentPlayer);
  }
  function onTogglePause() {
    const m = App.match;
    if (m.mode !== "ai_vs_ai") return;
    m.aiVsAiPaused = !m.aiVsAiPaused;
    updateGameUI();
    if (!m.aiVsAiPaused && !m.engine.isOver() && !m.aiThinking) startAIMove(m.engine.currentPlayer);
  }

  let thinkTimer = null;
  function currentActorIsHuman() {
    const m = App.match;
    if (!m || m.engine.isOver() || m.aiThinking) return false;
    if (m.mode === "ai_vs_ai") return false;
    if ((m.mode === "pvai" || m.mode === "tsume") && m.engine.currentPlayer === otherPlayer(m.humanPlayer)) return false;
    if (m.mode === "tsume" && (m.tsumeFailed || m.tsumeReplay)) return false;
    if (m.clock && m.clock.paused) return false;
    return true;
  }

  function updateGameUI() {
    const m = App.match;
    const dom = App.gameDom;
    if (!m || !dom) return;
    const engine = m.engine;

    dom.modeText.textContent = modeLabelText() + (m.ruleTemplate ? " / 特化テンプレート" : "") + ` / 接触制限 ${engine.config.contactLimit}`
      + (m.evalDisplay ? " / 形勢表示あり" : "");
    dom.restartBtn.disabled = false;
    dom.undoBtn.disabled = m.aiThinking || !m.historyStack.length || !!m.tsumeReplay || !!m.clock
      || (m.mode !== "tsume" && undoTargetIndex(m) == null);
    if (dom.clockBtn) {
      dom.clockBtn.disabled = engine.isOver();
      dom.clockBtn.textContent = m.clock.paused ? "時計を再開" : "時計を止める";
    }
    if (dom.hintBtn) {
      dom.hintBtn.disabled = m.aiThinking || engine.isOver() || !!m.tsumeFailed || !!m.tsumeReplay;
      const h = activeTsumeHint(m);
      dom.hintBtn.textContent = h && h.stage === 1 ? "ヒント2" : "ヒント";
    }
    if (m.mode === "ai_vs_ai") {
      dom.pauseBtn.textContent = m.aiVsAiPaused ? "再開" : "一時停止";
      dom.stepBtn.disabled = !(m.aiVsAiPaused && !engine.isOver());
    }

    drawBoard();
    drawStatus();
    drawClocks();
    drawEvalMeter();
    drawLog();
    drawBanner();
    if (m.mode === "tsume") updateTsumePanel();

    if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
    if (m.aiThinking) {
      let dots = 0;
      const tick = () => {
        dom.turnText.textContent = `${m.busyText || "AIが考えています"}${".".repeat((dots % 3) + 1)}`;
        dots++;
      };
      tick();
      thinkTimer = setInterval(tick, 400);
    } else if (m.mode === "tsume" && m.tsumeReplay && !engine.isOver()) {
      dom.turnText.textContent = `解答を再生しています(${m.tsumeReplay.step} / ${m.puzzle.line.length}手)`;
    } else if (m.mode === "tsume" && m.tsumeFailed) {
      dom.turnText.textContent = "";
    } else if (m.clock && m.clock.paused && !engine.isOver()) {
      dom.turnText.textContent = "時計を止めています";
    } else if (!engine.isOver()) {
      dom.turnText.textContent = `${playerDisplayName(engine.currentPlayer)}の番です`;
    } else {
      dom.turnText.textContent = "";
    }

    const oblTexts = [];
    for (const p of ["A", "B"]) {
      if (engine.obligated[p].length) {
        // 同じ駒が2方向から挟まれると義務が重なる(2回動かすまで消えない)ので「×2」と表示する
        const counts = new Map();
        for (const pid of engine.obligated[p]) counts.set(pid, (counts.get(pid) || 0) + 1);
        const labels = Array.from(counts, ([pid, n]) => posLabel(engine.pieces.get(pid).position) + (n > 1 ? `×${n}` : "")).join(", ");
        oblTexts.push(`${playerDisplayName(p)}: ${labels}`);
      }
    }
    dom.obligationText.textContent = oblTexts.length ? "移動義務: " + oblTexts.join(" / ") : "";
  }

  function drawBoard() {
    const m = App.match, dom = App.gameDom;
    const engine = m.engine;
    const size = dom.size;
    const player = engine.currentPlayer;
    const humanTurn = currentActorIsHuman();

    const destSet = new Set();
    const ownSelectable = new Set();
    const placementSet = new Set();
    if (humanTurn) {
      const rules = humanMoveRules(m);
      if (m.selected) {
        const selPiece = engine.pieceAt(m.selected);
        if (selPiece) rules.dests(selPiece).forEach((p) => destSet.add(H.posKey(p)));
      }
      for (const p of engine.pieces.values()) {
        if (rules.canSelect(p)) ownSelectable.add(H.posKey(p.position));
      }
      if (!m.selected) rules.placements().forEach((p) => placementSet.add(H.posKey(p)));
    }
    const clickable = new Set([...destSet, ...ownSelectable, ...placementSet]);
    // 詰めピンチのヒント: 1段目は動かす駒(配置なら何も光らせない)、2段目で行き先も光らせる
    const hintSet = new Set();
    const hint = m.mode === "tsume" ? activeTsumeHint(m) : null;
    if (hint) {
      if (hint.move[0] === "move") hintSet.add(H.posKey(engine.pieces.get(hint.move[1]).position));
      if (hint.stage === 2) hintSet.add(H.posKey(hint.move[0] === "move" ? hint.move[2] : hint.move[1]));
    }

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const key = r + "," + c;
        const cell = dom.cellNodes[r][c];
        cell.classList.toggle("is-hot", clickable.has(key));
        cell.classList.toggle("is-dest", destSet.has(key) && !engine.pieceAt([r, c]));
        cell.classList.toggle("is-bad", false);
        cell.classList.toggle("is-hint", hintSet.has(key));
      }
    }

    // 駒の描画(DOMノードを使い回してスライドアニメーションを効かせる)
    const seen = new Set();
    for (const piece of engine.pieces.values()) {
      seen.add(piece.id);
      let node = m.pieceNodes.get(piece.id);
      const isNew = !node;
      if (isNew) {
        node = el("div", { class: `piece p-${piece.player}` });
        const disc = el("div", { class: "disc" }, [el("span", { class: "label", text: pieceLabelFor(piece.player) })]);
        node.appendChild(disc);
        dom.piecesLayer.appendChild(node);
        m.pieceNodes.set(piece.id, node);
      }
      node.style.width = (100 / dom.size) + "%";
      node.style.height = (100 / dom.size) + "%";
      node.style.transform = `translate(${piece.position[1] * 100}%, ${piece.position[0] * 100}%)`;
      const isObligated = engine.obligated[piece.player].includes(piece.id);
      const isSelected = m.selected && m.selected[0] === piece.position[0] && m.selected[1] === piece.position[1];
      const isLast = m.lastAction && m.lastAction.to && m.lastAction.to[0] === piece.position[0] && m.lastAction.to[1] === piece.position[1];
      node.classList.toggle("is-obligated", isObligated);
      node.classList.toggle("is-selected", !!isSelected);
      node.classList.toggle("is-last", !!isLast);
      if (isNew) {
        node.classList.add("just-dropped");
        setTimeout(() => node.classList.remove("just-dropped"), 550);
      }
    }
    for (const [id, node] of Array.from(m.pieceNodes)) {
      if (!seen.has(id)) { node.remove(); m.pieceNodes.delete(id); }
    }
  }

  function drawStatus() {
    const m = App.match, dom = App.gameDom;
    const engine = m.engine;
    for (const p of ["A", "B"]) {
      const side = p === "A" ? dom.sideA : dom.sideB;
      side.node.classList.toggle("is-active", engine.currentPlayer === p && !engine.isOver());
      side.name.textContent = playerDisplayName(p);
      side.stockCount.textContent = String(engine.stock[p]);
      const total = p === "A" ? m.stockA : m.stockB;
      clearNode(side.dots);
      for (let i = 0; i < total; i++) {
        side.dots.appendChild(el("span", { class: `stock-dot${i >= engine.stock[p] ? " is-spent" : ""}` }));
      }
      const obligatedCount = engine.obligated[p].length;
      side.alert.classList.toggle("is-on", obligatedCount > 0);
      side.alert.textContent = obligatedCount ? `移動義務あり(${obligatedCount}個)` : "";
    }
  }

  // 形勢バー: 左が先手、右が後手。読み直している間・AIの思考中は直前の値を薄く残す
  function drawEvalMeter() {
    const m = App.match, dom = App.gameDom;
    if (!m || !dom || !dom.evalMeter) return;
    const em = dom.evalMeter;
    const v = m.evalView || { status: "thinking", result: null };
    const r = v.result;
    em.nameA.textContent = playerDisplayName("A");
    em.nameB.textContent = playerDisplayName("B");
    const winA = r ? r.winA : 0.5;
    // 読み切り・終局以外は 0% / 100% と言い切らない
    const pctA = r && (r.final || r.mate) ? Math.round(winA * 100) : Math.min(99, Math.max(1, Math.round(winA * 100)));
    em.pctA.textContent = r ? `${pctA}%` : "--%";
    em.pctB.textContent = r ? `${100 - pctA}%` : "--%";
    em.fill.style.width = `${winA * 100}%`;
    em.bar.setAttribute("aria-label", r ? `形勢 先手${pctA}% 後手${100 - pctA}%` : "形勢 未計算");
    em.root.classList.toggle("is-stale", v.status !== "ready");
    em.note.textContent = evalNoteText(m, v);
  }

  function evalNoteText(m, v) {
    const r = v.result;
    if (r && r.final) return m.engine.winner ? `${playerDisplayName(m.engine.winner)}の勝ち` : "引き分け";
    if (v.status === "thinking") return "読んでいます…";
    if (v.status === "paused") return "AIの思考中は読みを止めています";
    if (v.status === "failed" || !r) return "読めませんでした";
    if (r.mate) return `${playerDisplayName(r.mate)}の勝ちを読み切り(あと${r.matePlies}手)`;
    const s = Math.round(r.score);
    return `先手から見た評価値 ${s > 0 ? "+" : ""}${s}(${r.depth}手先まで)`;
  }

  function drawLog() {
    const dom = App.gameDom;
    const m = App.match;
    clearNode(dom.logList);
    const msgs = m.logMessages.slice(-40);
    if (!msgs.length) { dom.logList.appendChild(el("li", { class: "log-empty", text: "まだ手はありません。" })); return; }
    msgs.slice().reverse().forEach((msg) => dom.logList.appendChild(el("li", { text: msg })));
  }

  function drawBanner() {
    const m = App.match, dom = App.gameDom;
    const engine = m.engine;
    clearNode(dom.bannerHost);
    if (m.mode === "tsume") { drawTsumeBanner(); return; }
    if (!engine.winner && !engine.isDraw) return;
    let cls = "neutral", text = "";
    if (engine.winner) {
      const winnerName = playerDisplayName(engine.winner);
      if (m.mode === "pvai") {
        if (engine.winner === m.humanPlayer) { cls = "success"; text = `${winnerName}の勝ちです。相手の駒を挟んで動けなくしました。`; }
        else { cls = "danger"; text = `${winnerName}の勝ちです。あなたの駒が挟まれて動けなくなりました。`; }
      } else if (m.timeoutLoser) {
        cls = "neutral"; text = `${playerDisplayName(m.timeoutLoser)}の時間切れ。${winnerName}の勝ちです。`;
      } else {
        cls = "neutral"; text = `${winnerName}の勝ちです。`;
      }
    } else {
      cls = "warning";
      text = "引き分けです(同一局面が繰り返されました)。";
    }
    const banner = el("div", { class: `banner ${cls}` });
    banner.appendChild(el("span", { text }));
    const actions = el("div", { style: { display: "flex", gap: "8px" } });
    if (m.finishedRecord) {
      actions.appendChild(el("button", { class: "btn btn-compact", text: "感想戦を見る", onclick: () => openReview(m.finishedRecord) }));
      actions.appendChild(el("button", { class: "btn btn-compact", text: "棋譜をダウンロード", onclick: () => downloadKifuCsv(m.finishedRecord) }));
    }
    banner.appendChild(actions);
    dom.bannerHost.appendChild(banner);
    const note = ratingNoteFor(m.finishedRecord);
    if (note) {
      dom.bannerHost.appendChild(el("div", { class: `rating-note ${note.cls}` }, [
        el("span", { text: note.text }),
        el("button", { class: "btn btn-compact", text: "レートの推移", onclick: () => goto("rating") }),
      ]));
    }
  }

  function drawTsumeBanner() {
    const m = App.match, dom = App.gameDom;
    const engine = m.engine;
    const pz = m.puzzle;
    let cls = null, text = "";
    const buttons = [];
    const btn = (label, fn) => buttons.push(el("button", { class: "btn btn-compact", text: label, onclick: fn }));
    const next = () => startTsumePuzzle(nextTsumePuzzle(pz));
    if (m.tsumeReplay) {
      if (!m.tsumeReplay.done) return;
      cls = "neutral";
      text = `解答: ${pz.line.map((lb, i) => `${i + 1}.${lb.replace("-", "→")}`).join(" ")}`;
      btn("もう一度挑戦", () => startTsumePuzzle(pz));
      btn("次の問題へ", next);
    } else if (engine.winner === m.humanPlayer) {
      const plies = tsumeCounts(m).plies;
      cls = "success";
      const how = plies <= pz.par ? "最短手順" : `最短は${pz.par}手`;
      const note = m.tsumeStars === 3 ? "" : (m.tsumeHintUsed || m.tsumeUndoUsed ? " ※ヒント・待ったを使うと★2つまで" : "");
      text = `詰み! ${starText(m.tsumeStars)} ${plies}手(${how})${note}`;
      btn("次の問題へ", next);
      btn("解答を見る", startTsumeReplay);
    } else if (m.tsumeFailed || engine.winner || engine.isDraw) {
      cls = "danger";
      text = m.tsumeFailed
        || (engine.winner ? "挟み返されて、あなたの義務の駒が動けなくなりました。" : "同じ局面に戻ってしまいました(千日手)。");
      btn("待った(1手戻す)", onUndo);
      btn("解答を見る", startTsumeReplay);
    }
    if (!cls) return;
    const banner = el("div", { class: `banner ${cls}` });
    banner.appendChild(el("span", { text }));
    banner.appendChild(el("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } }, buttons));
    dom.bannerHost.appendChild(banner);
  }

  // ============================================================ 棋譜CSV(ダウンロード)
  function matchRecordToCsv(record) {
    const lines = [];
    lines.push("# 挟みゲーム 対戦記録");
    lines.push(`# 日時: ${record.timestamp}`);
    lines.push(`# モード: ${record.modeLabel}`);
    lines.push(`# 盤面: ${record.rows}x${record.cols} / 移動範囲: ${record.moveRange} / 接触制限: ${record.contactLimit} / 持ち駒: 先手${record.stockA} 後手${record.stockB}`);
    lines.push(`# 結果: ${record.resultText}`);
    lines.push(`# 形勢表示: ${record.evalDisplay ? "あり" : "なし"}`);
    lines.push("turn,player,action,from,to,sandwiched,self_sandwiched");
    record.moves.forEach((mv) => {
      const row = [mv.turn, mv.player, mv.action, mv.from, mv.to, (mv.sandwiched || []).join(";"), mv.selfSandwiched ? "○" : ""];
      lines.push(row.map(csvEscape).join(","));
    });
    return lines.join("\n");
  }
  function csvEscape(v) {
    v = String(v);
    if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }
  function kifuCsvFileName(record) { return `kifu_${record.id}.csv`; }
  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: fileName });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function downloadKifuCsv(record) {
    if (IS_LINE_BROWSER) { offerLineHandoff([record]); return; }
    const csv = "﻿" + matchRecordToCsv(record);
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), kifuCsvFileName(record));
  }
  // 複数の棋譜CSVを1つのZIPにまとめてダウンロードする。ブラウザは連続ダウンロードを
  // ブロックしがちなので、1件ずつではなく1ファイルに固める(1件だけならCSVそのまま)。
  function downloadKifuCsvBundle(records) {
    if (!records.length) return;
    if (IS_LINE_BROWSER) { offerLineHandoff(records); return; }
    if (records.length === 1) { downloadKifuCsv(records[0]); return; }
    const enc = new TextEncoder();
    const files = records.map((rec) => ({ name: kifuCsvFileName(rec), data: enc.encode("﻿" + matchRecordToCsv(rec)) }));
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    downloadBlob(buildZip(files, d), `kifu_${records.length}games_${stamp}.zip`);
  }

  // ============================================================ LINE内ブラウザ対策
  // LINEのアプリ内ブラウザはファイルのダウンロードに対応していない。しかも対戦履歴は
  // そのアプリ内ブラウザ側のlocalStorageにあるため、単に外部ブラウザで開き直しても
  // 記録は見えない。そこで選んだ記録を圧縮してURLの#kifu=に載せ、LINEの
  // ?openExternalBrowser=1(外部ブラウザで開かせる公式パラメータ)で開き直して、
  // 開いた先の履歴に取り込んでから保存してもらう。
  const IS_LINE_BROWSER = / Line\//i.test(navigator.userAgent);
  const KIFU_HASH_PREFIX = "#kifu=";
  const KIFU_TRANSFER_MAX_CHARS = 60000; // URLが長すぎて外部ブラウザに渡らないのを避ける目安

  function bytesToBase64Url(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function base64UrlToBytes(text) {
    let b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function pipeBytes(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  }
  // 先頭1文字で形式を表す: "z" = deflate圧縮済み, "j" = 生のJSON(圧縮APIが無い環境用)
  async function encodeKifuTransfer(records) {
    // 感想戦の解析結果は開き直した先で作り直せるので、URLを短くするため載せない
    const slim = records.map((r) => { const c = Object.assign({}, r); delete c.analysis; return c; });
    const bytes = new TextEncoder().encode(JSON.stringify(slim));
    if (window.CompressionStream) {
      try { return "z" + bytesToBase64Url(await pipeBytes(bytes, new CompressionStream("deflate-raw"))); } catch (e) { /* 生JSONで送る */ }
    }
    return "j" + bytesToBase64Url(bytes);
  }
  async function decodeKifuTransfer(code) {
    let bytes = base64UrlToBytes(code.slice(1));
    if (code[0] === "z") bytes = await pipeBytes(bytes, new DecompressionStream("deflate-raw"));
    const records = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(records)) throw new Error("bad payload");
    return records.filter((r) => r && typeof r.id === "string" && Array.isArray(r.moves));
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 下の旧方式へ */ }
    const ta = el("textarea", { style: { position: "fixed", top: "0", left: "0", opacity: "0" } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function offerLineHandoff(records) {
    const veil = el("div", { class: "veil" });
    const close = () => veil.remove();
    const openBtn = el("button", {
      class: "btn btn-compact", text: "ブラウザで開いて保存",
      style: { borderColor: "var(--accent)", color: "var(--accent)", fontWeight: "700" },
    });
    const copyBtn = el("button", { class: "btn btn-compact", text: "CSVをコピー" });
    openBtn.addEventListener("click", async () => {
      openBtn.disabled = true;
      let code;
      try { code = await encodeKifuTransfer(records); } catch (e) { code = null; }
      if (!code || code.length > KIFU_TRANSFER_MAX_CHARS) {
        openBtn.disabled = false;
        toast(code ? "一度に送るには多すぎます。選ぶ件数を減らしてください。" : "記録の変換に失敗しました。");
        return;
      }
      close();
      location.href = location.origin + location.pathname + "?openExternalBrowser=1" + KIFU_HASH_PREFIX + code;
    });
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(records.map(matchRecordToCsv).join("\n\n"));
      toast(ok ? `${records.length}件分のCSVをコピーしました` : "コピーできませんでした");
      if (ok) close();
    });
    veil.appendChild(el("div", { class: "modal" }, [
      el("p", { text: "LINEのアプリ内ブラウザでは、ファイルを保存できません。" }),
      el("p", { style: { color: "var(--text-secondary)", fontSize: "12.5px" }, text: `「ブラウザで開いて保存」を押すと、Safari・Chromeなどで開き直します。選んだ${records.length}件の対局記録も一緒に引き継がれるので、開いた先でダウンロードしてください。うまく切り替わらない場合は「CSVをコピー」でメモ帳などに貼り付けられます。` }),
      el("div", { class: "modal-actions", style: { flexWrap: "wrap" } }, [
        el("button", { class: "btn btn-compact", text: "キャンセル", onclick: close }),
        copyBtn,
        openBtn,
      ]),
    ]));
    document.body.appendChild(veil);
  }

  // #kifu=... 付きで開かれたら、記録をこの端末の履歴に取り込んで対戦履歴画面を開く。
  async function importKifuFromHash() {
    const code = location.hash.slice(KIFU_HASH_PREFIX.length);
    history.replaceState(null, "", location.pathname); // 再読み込みで二重に取り込まないよう消す
    let incoming;
    try { incoming = await decodeKifuTransfer(code); } catch (e) {
      toast("引き継いだ対局記録を読み取れませんでした");
      return null;
    }
    const list = loadHistory();
    const known = new Set(list.map((r) => r.id));
    // レートは対局した端末で計算するので、引き継いだ記録ではもう計算しない
    incoming.forEach((r) => { if (!known.has(r.id)) { list.push(Object.assign(r, { ratingPending: false })); known.add(r.id); } });
    // idは「作成時刻(ms)_乱数」なので、その時刻順に並べ直して履歴の時系列を保つ
    list.sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0));
    saveHistoryList(list);
    return incoming.map((r) => r.id);
  }

  // 無圧縮(STORE)ZIPの最小実装。外部ライブラリを使わずに済ませるため、
  // ローカルファイルヘッダ+中央ディレクトリ+終端レコードだけを自前で組み立てる。
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function buildZip(files, date) {
    const enc = new TextEncoder();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);        // 展開に必要なバージョン
      local.setUint16(6, 0x0800, true);    // ファイル名はUTF-8
      local.setUint16(8, 0, true);         // 無圧縮
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(local.buffer, name, f.data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);      // 30〜41(拡張/コメント長・属性等)は0のまま
      central.push(cd.buffer, name);
      offset += 30 + name.length + size;
    });
    const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end.buffer]), { type: "application/zip" });
  }

  // ============================================================ チュートリアル
  // 実際の盤を使ったレッスン形式。局面・課題・相手の手は content.js の TUTORIAL_LESSONS、
  // 達成判定や「指せない理由」の文言は tutorial.js(Python 版と同じ判定)。
  const TU = window.HasamiTutorial;
  const LS_TUTORIAL = "hasami:tutorial:v1";
  function loadTutorialProgress() {
    try { const p = JSON.parse(localStorage.getItem(LS_TUTORIAL) || "{}"); return { done: Array.isArray(p.done) ? p.done : [], last: p.last | 0 }; } catch (e) { return { done: [], last: 0 }; }
  }
  function saveTutorialProgress(p) { try { localStorage.setItem(LS_TUTORIAL, JSON.stringify(p)); } catch (e) { /* 保存できなくても使える */ } }

  function renderTutorial(root) {
    const lessons = C.TUTORIAL_LESSONS;
    const progress = loadTutorialProgress();
    const S = { token: 0, lesson: 0, step: 0, engine: null, start: null, status: "play", selected: null, last: null, lines: [], tried: new Set(), hint: null, pieceNodes: new Map(), dom: null, feedback: { cls: null, lines: [] }, startLast: null, startLines: [] };

    const screen = el("div", { class: "screen" });
    screen.appendChild(el("h1", { class: "card-title", text: "チュートリアル", style: { fontSize: "24px" } }));
    const chips = el("div", { class: "tut-chips", role: "tablist", "aria-label": "レッスン一覧" });
    screen.appendChild(chips);

    const layout = el("div", { class: "tut-layout" });
    const lessonDoc = el("div", { class: "doc tut-lesson" });
    const taskBox = el("div", { class: "tut-task" });
    const boardArea = el("div", { class: "tut-board" });
    const feedbackBox = el("div", { class: "tut-feedback-area" });
    layout.appendChild(lessonDoc); layout.appendChild(taskBox); layout.appendChild(boardArea); layout.appendChild(feedbackBox);
    screen.appendChild(layout);

    const nav = el("div", { class: "tutorial-nav" });
    const prevBtn = el("button", { class: "btn", text: "← 前のレッスン", onclick: () => openLesson(S.lesson - 1) });
    const indicator = el("span", { class: "tutorial-page-indicator" });
    const nextBtn = el("button", { class: "btn", text: "次のレッスン →", onclick: () => openLesson(S.lesson + 1) });
    nav.appendChild(prevBtn); nav.appendChild(indicator); nav.appendChild(nextBtn);
    screen.appendChild(nav);
    root.appendChild(screen);

    // 前回の続きから(全部終えていれば最初から)
    const firstOpen = lessons.findIndex((_, i) => !progress.done.includes(i));
    openLesson(firstOpen < 0 ? 0 : Math.min(progress.last, firstOpen));

    function lessonObj() { return lessons[S.lesson]; }
    function stepObj() { return lessonObj().steps[S.step]; }
    function later(ms, fn) { const t = S.token; setTimeout(() => { if (t === S.token && App.screen === "tutorial") fn(); }, ms); }

    function openLesson(i) {
      if (i < 0 || i >= lessons.length) return;
      S.token++;
      S.lesson = i;
      progress.last = i;
      saveTutorialProgress(progress);
      const L = lessons[i];
      S.engine = L.board ? TU.buildEngine(L.board) : null;
      S.pieceNodes = new Map();
      S.last = null;
      S.lines = [];
      buildLessonDom(L);
      startStep(0);
      if (L.finale) markLessonDone();
      window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    }

    function buildLessonDom(L) {
      clearNode(chips);
      lessons.forEach((les, i) => {
        const cls = "tut-chip" + (i === S.lesson ? " is-current" : "") + (progress.done.includes(i) ? " is-done" : "");
        chips.appendChild(el("button", {
          class: cls, role: "tab", "aria-selected": String(i === S.lesson), title: les.title,
          text: progress.done.includes(i) ? `✓${i + 1}` : String(i + 1), onclick: () => openLesson(i),
        }));
      });
      clearNode(lessonDoc);
      lessonDoc.appendChild(el("div", { class: "tut-kicker", text: `レッスン ${S.lesson + 1} / ${lessons.length}` }));
      lessonDoc.appendChild(el("h2", { text: L.title }));
      L.body.forEach((line) => lessonDoc.appendChild(el("p", { text: line })));

      clearNode(boardArea);
      layout.classList.toggle("no-board", !L.board);
      if (L.board) {
        const shell = buildBoardShell(L.board.size, { onCellClick: onTutorialCell, fx: true });
        boardArea.appendChild(shell.boardFrame);
        const status = el("div", { class: "tut-status" });
        boardArea.appendChild(status);
        S.dom = Object.assign({ status, size: L.board.size }, shell);
      } else {
        S.dom = null;
      }
      indicator.textContent = `${S.lesson + 1} / ${lessons.length}`;
      prevBtn.disabled = S.lesson === 0;
      nextBtn.disabled = S.lesson === lessons.length - 1;
    }

    function startStep(k) {
      S.step = k;
      S.selected = null;
      S.tried = new Set();
      S.hint = null;
      const step = stepObj();
      if (step.pre) {
        S.status = "busy";
        setFeedback("info", "相手が指します…");
        drawAll();
        later(650, () => {
          const act = TU.resolveAction(S.engine, "B", step.pre);
          const result = TU.playAs(S.engine, "B", act);
          S.last = { from: act.from || null, to: act.to };
          S.lines = TU.sandwichLines(S.engine, act, result);
          S.start = S.engine.clone();
          S.startLast = S.last;
          S.startLines = S.lines;
          S.status = "play";
          setFeedback("warn", step.preText);
          drawAll();
        });
        return;
      }
      S.start = S.engine ? S.engine.clone() : null;
      S.startLast = S.last;
      S.startLines = S.lines;
      S.status = step.goal === "read" ? "done" : "play";
      setFeedback(null, "");
      drawAll();
    }

    function resetStep() {
      S.token++;
      S.engine = S.start.clone();
      S.selected = null;
      S.tried = new Set();
      S.hint = null;
      S.last = S.startLast;
      S.lines = S.startLines;
      S.status = "play";
      const step = stepObj();
      setFeedback(step.pre ? "warn" : null, step.pre ? step.preText : "");
      drawAll();
    }

    function markLessonDone() {
      if (!progress.done.includes(S.lesson)) {
        progress.done.push(S.lesson);
        saveTutorialProgress(progress);
        const chip = chips.children[S.lesson];
        if (chip) { chip.classList.add("is-done"); chip.textContent = `✓${S.lesson + 1}`; }
      }
    }

    function completeStep(...lines) {
      S.status = "done";
      S.hint = null;
      const step = stepObj();
      const lastStep = S.step === lessonObj().steps.length - 1;
      if (lastStep && !step.reply) markLessonDone();
      setFeedback("success", ...lines);
      drawAll();
      if (step.reply && !S.engine.isOver()) {
        S.status = "busy";
        drawAll();
        later(1600, () => {
          const act = TU.resolveAction(S.engine, "B", step.reply);
          const result = TU.playAs(S.engine, "B", act);
          S.last = { from: act.from || null, to: act.to };
          S.lines = TU.sandwichLines(S.engine, act, result);
          S.status = "done";
          if (lastStep) markLessonDone();
          setFeedback("success", ...lines, step.replyText);
          drawAll();
        });
      }
    }

    // ---- 盤のクリック ----
    function onTutorialCell(r, c) {
      if (!S.engine || S.status === "busy" || S.status === "fail" || S.engine.isOver()) return;
      const engine = S.engine;
      const step = stepObj();
      const pos = [r, c];
      const piece = engine.pieceAt(pos);
      const label = posLabel(pos);

      if (step.goal === "tryBad" && S.status === "play") {
        if (step.marks.includes(label)) {
          S.tried.add(label);
          const reason = TU.placementBlockReason(engine, "A", pos) || "";
          const need = step.need || step.marks.length;
          if (S.tried.size >= need) completeStep(`【${label}】${reason}`, step.success);
          else { setFeedback("warn", `【${label}】${reason}`, `あと${need - S.tried.size}つ、✕のマスを試してみましょう。`); drawAll(); }
        } else {
          setFeedback("info", "まずは✕の付いたマスをタップしてみましょう。");
        }
        return;
      }

      if (S.selected) {
        const selPiece = engine.pieceAt(S.selected);
        if (r === S.selected[0] && c === S.selected[1]) {
          if (!(engine.obligated.A.length === 1 && engine.obligated.A[0] === selPiece.id)) S.selected = null;
          drawAll();
          return;
        }
        if (!piece && engine.legalMoves(selPiece.id).some((p) => p[0] === r && p[1] === c)) {
          doAction({ kind: "move", from: S.selected, to: pos, pieceId: selPiece.id });
          return;
        }
        if (piece && piece.player === "A") { trySelect(piece); return; }
        if (piece) { setFeedback("info", "それは相手の駒です。動かせるのは水色の自分の駒だけです。"); return; }
        const why = TU.moveBlockReason(engine, selPiece, pos) || "選んだ駒はそこへは動けません。";
        const extra = engine.stock.A > 0 && !engine.obligated.A.length
          ? "駒を置きたいときは、選んだ駒をもう一度タップして選択をやめてから空きマスをタップします。" : "金色の点のマスを選んでください。";
        setFeedback("warn", why, extra);
        return;
      }

      if (piece) {
        if (piece.player === "A") trySelect(piece);
        else setFeedback("info", "それは相手の駒です。動かせるのは水色の自分の駒だけです。");
        return;
      }
      if (engine.legalPlacements("A").some((p) => p[0] === r && p[1] === c)) {
        doAction({ kind: "place", to: pos });
        return;
      }
      setFeedback("warn", TU.placementBlockReason(engine, "A", pos) || "そこには置けません。");
    }

    function trySelect(piece) {
      const engine = S.engine;
      const obl = engine.obligated.A;
      if (obl.length && !obl.includes(piece.id)) {
        const where = Array.from(new Set(obl)).map((pid) => posLabel(engine.pieces.get(pid).position)).join("・");
        setFeedback("warn", `今は移動義務のある駒(赤い輪の${where})しか動かせません。`);
        return;
      }
      if (!engine.legalMoves(piece.id).length) {
        setFeedback("warn", "この駒は今、動ける場所がありません。");
        return;
      }
      S.selected = piece.position.slice();
      if (S.status === "play" && stepObj().goal === "select") { completeStep(stepObj().success); return; }
      drawAll();
    }

    function doAction(act) {
      const engine = S.engine;
      const result = TU.playAs(engine, "A", act);
      S.last = { from: act.from || null, to: act.to };
      S.lines = TU.sandwichLines(engine, act, result);
      S.selected = null;
      S.hint = null;
      const desc = TU.describeResult(engine, act, result);
      const step = stepObj();
      const verdict = S.status === "play" ? TU.judgeStep(step, engine, act, result) : "continue";
      const replyComing = verdict === "success" && step.reply && !engine.isOver();
      if (!replyComing) TU.passBack(engine);

      if (verdict === "success") {
        completeStep(step.success);
      } else if (verdict === "fail") {
        S.status = "fail";
        setFeedback("danger", desc, step.fail || step.hint);
      } else if (engine.winner === "B") {
        S.status = "fail";
        setFeedback("danger", desc, "義務のある駒がどこにも動けなくなりました。本当の対戦なら負けです。「やり直す」で戻りましょう。");
      } else if (verdict === "chain") {
        setFeedback("warn", step.chain || desc);
      } else if (S.status === "play" && step.goal === "reach") {
        setFeedback("info", desc, `まだ${step.target}に着いていません。続けて動かしましょう。`);
      } else if (S.status === "play" && step.goal === "escape" && engine.obligated.A.length) {
        setFeedback("warn", desc, "まだ移動義務が残っています。");
      } else {
        setFeedback(desc ? "info" : null, desc);
      }
      drawAll();
    }

    function showHint() {
      const step = stepObj();
      const sol = step.solution || [];
      const cells = new Set();
      const engine = S.engine;
      if (sol[0] === "move") {
        const from = posFromLabel(sol[1]);
        const p = engine && engine.pieceAt(from);
        if (p && p.player === "A") { cells.add(H.posKey(from)); cells.add(H.posKey(posFromLabel(sol[2]))); }
      } else if (sol[0] === "place" && sol[1] !== "auto") cells.add(H.posKey(posFromLabel(sol[1])));
      else if (sol[0] === "select") cells.add(H.posKey(posFromLabel(sol[1])));
      else if (sol[0] === "tap") sol.slice(1).forEach((lb) => cells.add(H.posKey(posFromLabel(lb))));
      S.hint = cells;
      setFeedback("info", "ヒント: " + step.hint);
      drawAll();
    }

    // ---- 表示 ----
    function setFeedback(cls, ...lines) {
      S.feedback = { cls, lines: lines.filter((t) => t) };
      drawFeedback();
    }

    function drawAll() {
      drawTask();
      drawTutorialBoard();
      drawFeedback();
    }

    function drawTask() {
      clearNode(taskBox);
      const L = lessonObj();
      const step = stepObj();
      if (L.finale) {
        taskBox.appendChild(el("div", { class: "tut-task-head" }, [el("span", { text: "次にすること" })]));
        const row = el("div", { class: "tut-actions" });
        row.appendChild(el("button", {
          class: "btn btn-primary", text: "AI(初級)と練習対局する",
          onclick: () => startNewMatch({
            mode: "pvai", boardSize: 7, moveRange: 1, contactLimit: C.DEFAULT_CONTACT_LIMIT,
            aiLevel: 2, aiLevelB: null, aiSpecialist: false, aiSpecialistB: false,
            stockA: defaultStockForSize(7), stockB: defaultStockForSize(7), ruleTemplate: null,
            side: "A", timeControl: null, evalDisplay: false,
          }),
        }));
        row.appendChild(el("button", { class: "btn", text: "戦略コラムを読む", onclick: () => goto("strategy") }));
        row.appendChild(el("button", { class: "btn", text: "メニューで設定を選ぶ", onclick: () => goto("menu") }));
        taskBox.appendChild(row);
        taskBox.appendChild(el("p", { class: "tut-note", text: "練習対局は 7×7・移動範囲1・接触制限4 の標準的な設定で、あなたが先手です。" }));
        return;
      }
      const total = L.steps.length;
      taskBox.appendChild(el("div", { class: "tut-task-head" }, [
        el("span", { text: "やってみよう" }),
        total > 1 ? el("span", { class: "tut-step-count", text: `ステップ ${S.step + 1} / ${total}` }) : null,
      ]));
      taskBox.appendChild(el("p", { class: "tut-task-text", text: step.task }));
      const row = el("div", { class: "tut-actions" });
      const hintBtn = el("button", { class: "btn btn-compact", text: "ヒント", onclick: showHint });
      hintBtn.disabled = S.status !== "play";
      row.appendChild(hintBtn);
      row.appendChild(el("button", { class: "btn btn-compact", text: "やり直す", onclick: resetStep }));
      taskBox.appendChild(row);
    }

    function drawFeedback() {
      clearNode(feedbackBox);
      const L = lessonObj();
      if (S.feedback.lines.length) {
        const box = el("div", { class: `tut-feedback ${S.feedback.cls || "info"}`, role: "status" });
        S.feedback.lines.forEach((t) => box.appendChild(el("p", { text: t })));
        feedbackBox.appendChild(box);
      }
      const row = el("div", { class: "tut-actions" });
      if (S.status === "fail") {
        row.appendChild(el("button", { class: "btn btn-primary", text: "やり直す", onclick: resetStep }));
      } else if (S.status === "done" && !L.finale) {
        const lastStep = S.step === L.steps.length - 1;
        if (!lastStep) row.appendChild(el("button", { class: "btn btn-primary", text: "次のステップへ →", onclick: () => startStep(S.step + 1) }));
        else if (S.lesson < lessons.length - 1) row.appendChild(el("button", { class: "btn btn-primary", text: "次のレッスンへ →", onclick: () => openLesson(S.lesson + 1) }));
      }
      if (row.children.length) feedbackBox.appendChild(row);
      nextBtn.classList.toggle("btn-nav", progress.done.includes(S.lesson));
    }

    function drawTutorialBoard() {
      const dom = S.dom;
      if (!dom) return;
      const engine = S.engine;
      const step = stepObj();
      const size = dom.size;
      const canAct = (S.status === "play" || S.status === "done") && !engine.isOver() && engine.currentPlayer === "A";

      const destSet = new Set(), hot = new Set(), marks = new Set(), glow = new Set(S.hint || []);
      if (step.target) glow.add(H.posKey(posFromLabel(step.target)));
      if (step.goal === "tryBad" && S.status === "play") step.marks.forEach((lb) => marks.add(H.posKey(posFromLabel(lb))));
      if (canAct) {
        const obl = engine.obligated.A;
        for (const p of engine.pieces.values()) {
          if (p.player === "A" && (!obl.length || obl.includes(p.id))) hot.add(H.posKey(p.position));
        }
        if (S.selected) {
          const sp = engine.pieceAt(S.selected);
          if (sp) engine.legalMoves(sp.id).forEach((p) => { destSet.add(H.posKey(p)); hot.add(H.posKey(p)); });
        } else if (step.goal !== "tryBad" || S.status !== "play") {
          engine.legalPlacements("A").forEach((p) => hot.add(H.posKey(p)));
        }
        marks.forEach((k) => hot.add(k));
      }
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const key = r + "," + c;
          const cell = dom.cellNodes[r][c];
          cell.classList.toggle("is-hot", hot.has(key));
          cell.classList.toggle("is-dest", destSet.has(key));
          cell.classList.toggle("is-hint", glow.has(key));
          cell.classList.toggle("is-mark", marks.has(key) && !S.tried.has(posLabel([r, c])));
          cell.classList.toggle("is-mark-done", marks.has(key) && S.tried.has(posLabel([r, c])));
        }
      }

      const seen = new Set();
      for (const piece of engine.pieces.values()) {
        seen.add(piece.id);
        let node = S.pieceNodes.get(piece.id);
        const isNew = !node;
        if (isNew) {
          node = el("div", { class: `piece p-${piece.player}` }, [el("div", { class: "disc" }, [el("span", { class: "label", text: piece.player === "A" ? "You" : "相手" })])]);
          dom.piecesLayer.appendChild(node);
          S.pieceNodes.set(piece.id, node);
        }
        node.style.width = (100 / size) + "%";
        node.style.height = (100 / size) + "%";
        node.style.transform = `translate(${piece.position[1] * 100}%, ${piece.position[0] * 100}%)`;
        node.classList.toggle("is-obligated", engine.obligated[piece.player].includes(piece.id));
        node.classList.toggle("is-selected", !!(S.selected && S.selected[0] === piece.position[0] && S.selected[1] === piece.position[1]));
        node.classList.toggle("is-last", !!(S.last && S.last.to[0] === piece.position[0] && S.last.to[1] === piece.position[1]));
        if (isNew && S.last && S.last.to[0] === piece.position[0] && S.last.to[1] === piece.position[1]) {
          node.classList.add("just-dropped");
          setTimeout(() => node.classList.remove("just-dropped"), 550);
        }
      }
      for (const [id, node] of Array.from(S.pieceNodes)) {
        if (!seen.has(id)) { node.remove(); S.pieceNodes.delete(id); }
      }

      // 挟んだ線(両端の駒・壁を結ぶ)
      const fx = dom.fxLayer;
      while (fx.firstChild) fx.removeChild(fx.firstChild);
      const unit = 100 / size;
      S.lines.forEach(([p1, p2]) => {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", (p1[1] + 0.5) * unit); line.setAttribute("y1", (p1[0] + 0.5) * unit);
        line.setAttribute("x2", (p2[1] + 0.5) * unit); line.setAttribute("y2", (p2[0] + 0.5) * unit);
        line.setAttribute("class", "tut-flank");
        fx.appendChild(line);
      });

      // 手番・持ち駒・義務
      clearNode(dom.status);
      let turn;
      if (engine.winner === "A") turn = "あなたの勝ち!";
      else if (engine.winner === "B") turn = "あなたの負け";
      else if (S.status === "busy") turn = "相手の番です…";
      else turn = "あなたの番です";
      dom.status.appendChild(el("span", { class: "tut-turn", text: turn }));
      dom.status.appendChild(el("span", {}, [
        el("span", { class: "legend-dot", style: { background: C.PLAYER_COLORS.A.legend } }),
        document.createTextNode(`あなたの持ち駒 ${engine.stock.A}`),
      ]));
      dom.status.appendChild(el("span", {}, [
        el("span", { class: "legend-dot", style: { background: C.PLAYER_COLORS.B.legend } }),
        document.createTextNode(`相手の持ち駒 ${engine.stock.B}`),
      ]));
      const obl = [];
      for (const p of ["A", "B"]) {
        const labels = Array.from(new Set(engine.obligated[p])).map((pid) => posLabel(engine.pieces.get(pid).position));
        if (labels.length) obl.push(`${p === "A" ? "あなた" : "相手"}の${labels.join("・")}`);
      }
      if (obl.length) dom.status.appendChild(el("span", { class: "tut-obl", text: "移動義務: " + obl.join(" / ") }));
    }
  }

  // ============================================================ 戦略コラム
  function renderStrategy(root) {
    const screen = el("div", { class: "screen" });
    screen.appendChild(el("h1", { class: "card-title", text: "戦略コラム", style: { fontSize: "24px" } }));
    const doc = el("div", { class: "doc" });
    doc.appendChild(el("div", { class: "lede", text: "探索AIとの検証を通して見えてきた勝ち筋" }));
    C.STRATEGY_ARTICLES.forEach(([heading, body]) => {
      const item = el("div", { class: "strategy-item" });
      item.appendChild(el("h3", { text: heading }));
      item.appendChild(el("p", { text: body }));
      doc.appendChild(item);
    });
    screen.appendChild(doc);
    root.appendChild(screen);
  }

  // ============================================================ 戦術レポート
  function renderReport(root) {
    const screen = el("div", { class: "screen" });
    screen.appendChild(el("h1", { class: "card-title", text: "戦術レポート", style: { fontSize: "24px" } }));
    const doc = el("div", { class: "doc" });
    doc.appendChild(el("div", { class: "lede", text: `特化テンプレート専用AI『${AI.SPECIALIST_AI_NAME}』を自己対戦で仕上げる過程で判明した、人間の実戦でも使える戦術のまとめ` }));
    C.TACTICS_REPORT.forEach(([kind, text]) => {
      if (kind === "h1") doc.appendChild(el("h2", { text }));
      else if (kind === "h2") doc.appendChild(el("h3", { text }));
      else if (kind === "pre") doc.appendChild(el("pre", { text }));
      else doc.appendChild(el("p", { text }));
    });
    screen.appendChild(doc);
    root.appendChild(screen);
  }

  // ============================================================ レート(AI戦の結果と指し手の質)
  // 計算式とAIレベルのレートは rating.js(HasamiRating)。ここは記録・解析・画面の部分
  const RT = window.HasamiRating;
  const LS_RATING = "hasami:rating:v1";
  const RATING_LEVELS = RT.LEVELS;

  function loadRatingStore() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_RATING) || "null");
      if (s && Array.isArray(s.games)) return s;
    } catch (e) { /* 壊れていたら作り直す */ }
    return { v: 1, games: [] };
  }
  function saveRatingStore(s) {
    try { localStorage.setItem(LS_RATING, JSON.stringify(s)); } catch (e) { /* 保存できなくても対局はできる */ }
  }
  function currentRating(store) {
    const g = (store || loadRatingStore()).games;
    return g.length ? g[g.length - 1].after : null;
  }
  function ratingLevelKey(level, specialist) { return specialist ? "S" : String(level); }
  function ratingLevelName(key) { return key === "S" ? AI.SPECIALIST_AI_NAME : AI.LEVELS[key].name; }

  // AI戦の記録に付ける、レートの対象かどうかと計算に要る情報。対象外ならその理由
  function ratingInfoFor(m) {
    if (m.mode !== "pvai") return null;
    const human = m.humanPlayer;
    const result = m.engine.winner ? (m.engine.winner === human ? "win" : "loss") : "draw";
    let reason = null;
    if (m.resumedFrom) reason = "感想戦の途中から再開した対局";
    else if (m.evalDisplay) reason = "形勢表示ありの対局";
    else if (m.undoUsed) reason = "待ったを使った対局";
    return { side: human, level: ratingLevelKey(m.aiLevel, m.aiSpecialist), result, eligible: !reason, reason };
  }

  // 解析し終えた対局から、レートの1件ぶんを作る(判定できる手が少なすぎれば null)
  function buildRatingEntry(record, frames, results, store) {
    const info = record.ratingInfo;
    const losses = [];
    const counts = { 大悪手: 0, 悪手: 0, 疑問手: 0 };
    for (let i = 1; i < frames.length; i++) {
      if (frames[i - 1].currentPlayer !== info.side) continue;
      const j = judgeAt(record, frames, results, i);
      if (!j || j.forced) continue;
      losses.push(j.loss);
      if (j.label) counts[j.label]++;
    }
    if (losses.length < RT.MIN_MOVES) return null;
    const avgLoss = losses.reduce((s, v) => s + v, 0) / losses.length;
    return Object.assign({
      id: record.id, at: parseInt(record.id, 10) || Date.now(), timestamp: record.timestamp,
      level: info.level, levelName: ratingLevelName(info.level), side: info.side, result: info.result,
      moves: losses.length, avgLoss, counts,
    }, RT.rate(store.games, info.level, info.result, avgLoss));
  }

  // ---- 対局の解析(裏方の Worker。形勢表示・感想戦の Worker とは別) ----
  // 対局のAIが考えている間は止めて待つ(AIの読みの邪魔をしない)
  let bgWorker = null, bgWorkerOk = true;
  const bgPending = new Map();
  function bgAnalyze(engine, template) {
    return new Promise((resolve) => {
      if (!bgWorker && bgWorkerOk && Worker_) {
        try {
          bgWorker = new Worker_("ai-worker.js?v=8");
          bgWorker.onmessage = (e) => {
            const cb = bgPending.get(e.data.reqId);
            if (cb) { bgPending.delete(e.data.reqId); cb(e.data.ok ? e.data.result : null); }
          };
          bgWorker.onerror = () => { bgWorkerOk = false; bgWorker = null; bgPending.forEach((cb) => cb(null)); bgPending.clear(); };
        } catch (e) { bgWorkerOk = false; }
      }
      if (bgWorker && bgWorkerOk) {
        const reqId = reqSeq++;
        bgPending.set(reqId, resolve);
        bgWorker.postMessage({ kind: "analyze", reqId, config: engine.config, state: engineSnapshot(engine), template, timeBudget: AI.EVAL_TIME_BUDGET });
      } else {
        setTimeout(() => { try { resolve(AI.analyzePosition(engine, template, 250)); } catch (e) { resolve(null); } }, 30);
      }
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function analyzeRecordInBackground(record, onProgress) {
    const frames = rebuildFramesFromRecord(record);
    const results = (cachedAnalysis(record, frames.length) || new Array(frames.length).fill(null)).slice();
    const template = recordUsesTemplate(record);
    for (let i = 0; i < frames.length; i++) {
      if (results[i]) continue;
      while (App.match && App.match.aiThinking) await sleep(500);
      results[i] = (await bgAnalyze(frames[i].engineClone, template))
        || { winA: 0.5, mate: null, matePlies: null, depth: 0, final: false, best: null, nActs: 0 };
      if (onProgress) onProgress(results.filter(Boolean).length, results.length);
    }
    saveRecordAnalysis(record, results);
    return { frames, results };
  }

  // ---- レート計算待ちの対局を、古い順に1局ずつ片づける(ページを閉じても次に開いたとき続きから) ----
  const ratingBusy = { running: false, current: null };
  function setRecordRatingState(id, patch) {
    const list = loadHistory();
    const i = list.findIndex((r) => r.id === id);
    if (i >= 0) { Object.assign(list[i], patch); saveHistoryList(list); }
  }
  async function processPendingRatings() {
    if (ratingBusy.running) return;
    ratingBusy.running = true;
    try {
      for (;;) {
        const record = loadHistory().find((r) => r.ratingPending);
        if (!record) break;
        ratingBusy.current = { id: record.id, done: 0, total: 0 };
        const { frames, results } = await analyzeRecordInBackground(record, (done, total) => {
          ratingBusy.current = { id: record.id, done, total };
          onRatingProgress(record.id);
        });
        const store = loadRatingStore();
        if (!store.games.some((g) => g.id === record.id)) {
          const entry = buildRatingEntry(record, frames, results, store);
          if (entry) { store.games.push(entry); saveRatingStore(store); }
          setRecordRatingState(record.id, { ratingPending: false, ratingExcluded: entry ? null : "判定できる手が少なすぎる対局" });
        } else {
          setRecordRatingState(record.id, { ratingPending: false });
        }
        ratingBusy.current = null;
        onRatingProgress(record.id);
      }
    } finally {
      ratingBusy.running = false;
      ratingBusy.current = null;
    }
  }
  // 対局画面の結果表示・レート画面を、計算の進み具合に合わせて描き直す
  function onRatingProgress(id) {
    const m = App.match;
    if (App.screen === "game" && m && m.finishedRecord && m.finishedRecord.id === id && App.gameDom) drawBanner();
    if (App.screen === "rating" && App.ratingRefresh) App.ratingRefresh();
  }

  // 対局画面の結果表示に添える、レートの一言
  function ratingNoteFor(record) {
    if (!record || !record.ratingInfo) return null;
    if (!record.ratingInfo.eligible) return { cls: "muted", text: `レート対象外(${record.ratingInfo.reason})` };
    const cur = ratingBusy.current;
    if (cur && cur.id === record.id) return { cls: "muted", text: `レートを計算しています…(AIが指し手を解析中 ${cur.done} / ${cur.total || "?"})` };
    const entry = loadRatingStore().games.find((g) => g.id === record.id);
    if (entry) {
      const diff = entry.before == null ? null : entry.after - entry.before;
      const sign = diff == null ? "" : diff >= 0 ? `(+${diff})` : `(${diff})`;
      const from = entry.before == null ? "" : `${entry.before} → `;
      return { cls: "ok", text: `レート ${from}${entry.after}${sign}${entry.provisional ? " 暫定" : ""}  内容 ${entry.qualityPerf} / 結果 ${entry.resultPerf}` };
    }
    const latest = loadHistory().find((r) => r.id === record.id);
    if (latest && latest.ratingExcluded) return { cls: "muted", text: `レート対象外(${latest.ratingExcluded})` };
    return { cls: "muted", text: "レートの計算を待っています…" };
  }

  // ============================================================ レート画面
  function renderRating(root) {
    const screen = el("div", { class: "screen" });
    screen.appendChild(el("h1", { class: "card-title", text: "レート", style: { fontSize: "24px" } }));
    screen.appendChild(el("div", { class: "field-hint", text: "AI戦の結果と、あなたの指し手の質(AIが解析した平均損失)から計算します。この端末のブラウザに保存され、他の端末とは共有されません。" }));
    const body = el("div", { class: "rating-body" });
    screen.appendChild(body);
    root.appendChild(screen);

    function draw() {
      clearNode(body);
      const store = loadRatingStore();
      const games = store.games;
      const cur = currentRating(store);

      const head = el("div", { class: "card rating-head" });
      head.appendChild(el("div", { class: "rating-now" }, [
        el("span", { class: "rating-label", text: "現在のレート" }),
        el("b", { class: "rating-value", text: cur == null ? "----" : String(cur) }),
        el("span", { class: "rating-sub", text: cur == null ? "AI戦を1局終えると表示されます"
          : games.length < RT.PROVISIONAL_GAMES ? `暫定(あと${RT.PROVISIONAL_GAMES - games.length}局で確定) / ${games.length}局`
            : `${games.length}局` }),
      ]));
      if (cur != null) {
        const near = RT.nearestLevel(cur);
        head.appendChild(el("div", { class: "rating-sub", text: `近い強さのAI: ${ratingLevelName(near[0])}(${near[1]})` }));
      }
      const pend = loadHistory().filter((r) => r.ratingPending).length;
      if (pend) {
        const c = ratingBusy.current;
        head.appendChild(el("div", { class: "rating-sub", text: `計算待ち ${pend}局${c && c.total ? `(解析中 ${c.done} / ${c.total})` : ""}` }));
      }
      body.appendChild(head);

      // ---- 推移のグラフ ----
      const card = el("div", { class: "card rating-chart-card" });
      card.appendChild(el("div", { class: "card-title", text: "レートの推移", style: { fontSize: "14px" } }));
      if (!games.length) {
        card.appendChild(el("div", { class: "field-hint", text: "まだ記録がありません。メニューで「AI戦」を選んで対局してください(形勢表示なし・待ったなしの対局が対象です)。" }));
      } else {
        card.appendChild(buildRatingChart(games));
      }
      body.appendChild(card);

      // ---- 対局ごとの記録(新しい順) ----
      if (games.length) {
        const list = el("ul", { class: "rating-list" });
        games.slice().reverse().forEach((g) => {
          const diff = g.before == null ? "" : `${g.after - g.before >= 0 ? "+" : ""}${g.after - g.before}`;
          const res = g.result === "win" ? "勝ち" : g.result === "loss" ? "負け" : "引き分け";
          const rec = loadHistory().find((r) => r.id === g.id);
          list.appendChild(el("li", { class: "rating-row" }, [
            el("div", { class: "rating-row-main" }, [
              el("span", { class: `rating-res res-${g.result}`, text: res }),
              el("span", { text: `vs ${g.levelName}(${g.levelRating})${g.side === "A" ? " 先手" : " 後手"}` }),
              el("b", { class: "rating-after", text: `${g.after}` }),
              el("span", { class: `rating-diff ${diff.startsWith("-") ? "down" : "up"}`, text: diff }),
            ]),
            el("div", { class: "rating-row-sub", text: `${g.timestamp}  平均損失 ${(g.avgLoss * 100).toFixed(1)}%(大悪手${g.counts.大悪手}・悪手${g.counts.悪手}・疑問手${g.counts.疑問手})  内容 ${g.qualityPerf} / 結果 ${g.resultPerf} → この対局 ${g.perf}` }),
            rec ? el("button", { class: "btn btn-compact", text: "感想戦", onclick: () => openReview(rec) }) : null,
          ]));
        });
        body.appendChild(list);
      }

      // ---- 計算方法とレベルの目安 ----
      const how = el("div", { class: "card rating-how" });
      how.appendChild(el("div", { class: "card-title", text: "計算のしかた", style: { fontSize: "14px" } }));
      [
        "1局ごとに「結果」と「内容」のパフォーマンスを出し、その平均をその対局のパフォーマンスにします。",
        "結果: 相手AIのレート +400(勝ち)/ −400(負け)/ ±0(引き分け)。",
        "内容: あなたの手の平均損失(感想戦の悪手判定と同じ。AIの最善手と同じ手・他に手がない手は0)をレートに換算した値。強いAIほど平均損失が小さい関係から換算しています。",
        `最初の${RT.PROVISIONAL_GAMES}局は暫定としてパフォーマンスの平均、その後は レート +${RT.STEP}×(パフォーマンス − レート) で更新します。`,
        "対象はAI戦のみ。形勢表示あり・待ったを使った・感想戦から再開した対局は数えません。",
        "AIのレートは特化テンプレート(7×7・持ち駒15・接触3・移動3)でレベル同士を対戦させて測ったもので、ほかの盤の設定でも同じ値を使います(目安です)。",
      ].forEach((t) => how.appendChild(el("p", { class: "rating-how-p", text: t })));
      how.appendChild(el("div", { class: "rating-levels" },
        Object.entries(RATING_LEVELS).sort((a, b) => a[1] - b[1])
          .map(([k, v]) => el("span", { class: "rating-level-chip", text: `${ratingLevelName(k)} ${v}` }))));
      if (games.length) {
        how.appendChild(el("button", {
          class: "btn btn-compact", text: "レートの記録を消す", style: { marginTop: "10px" },
          onclick: () => confirmModal("レートの記録をすべて消します(対戦履歴は残ります)。よろしいですか?", "消す").then((ok) => {
            if (!ok) return;
            saveRatingStore({ v: 1, games: [] });
            draw();
          }),
        }));
      }
      body.appendChild(how);
    }
    App.ratingRefresh = draw;
    draw();
    processPendingRatings();
  }

  // レートの推移(折れ線)。横軸は対局の順番、背景にAIレベルの目安の横線を引く
  function buildRatingChart(games) {
    const SVGNS = "http://www.w3.org/2000/svg";
    // 画面の幅に合わせて座標系の幅を決める(スマホで縮小されて文字が小さくなりすぎないように)
    const W = Math.round(Math.min(600, Math.max(300, (root.clientWidth || 600) - 64))), H = 220, PL = 44, PR = 12, PT = 12, PB = 22;
    const vals = games.map((g) => g.after).concat(games.map((g) => g.perf));
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const padV = Math.max(60, (hi - lo) * 0.12);
    lo = Math.floor((lo - padV) / 50) * 50; hi = Math.ceil((hi + padV) / 50) * 50;
    const n = games.length;
    const x = (i) => PL + (n === 1 ? (W - PL - PR) / 2 : (i / (n - 1)) * (W - PL - PR));
    const y = (v) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "rating-chart");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `レートの推移(${n}局、最新 ${games[n - 1].after})`);
    const mk = (tag, attrs, text) => {
      const node = document.createElementNS(SVGNS, tag);
      for (const k in attrs) node.setAttribute(k, attrs[k]);
      if (text != null) node.textContent = text;
      svg.appendChild(node);
      return node;
    };
    // 縦軸の目盛り
    const step = (hi - lo) > 800 ? 200 : 100;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      mk("line", { x1: PL, x2: W - PR, y1: y(v), y2: y(v), class: "rc-grid" });
      mk("text", { x: PL - 6, y: y(v) + 4, class: "rc-axis", "text-anchor": "end" }, String(v));
    }
    // AIレベルの目安(範囲内のものだけ)。近すぎるレベルどうしは名前をまとめて重ならないようにする
    const shown = Object.entries(RATING_LEVELS).filter(([, v]) => v > lo && v < hi).sort((p, q) => q[1] - p[1]);
    let lastY = -Infinity, group = [];
    const flush = () => {
      if (!group.length) return;
      mk("text", { x: W - PR - 2, y: group[0].y - 3, class: "rc-level-label", "text-anchor": "end" }, group.map((g) => g.name).join("・"));
      group = [];
    };
    shown.forEach(([k, v]) => {
      mk("line", { x1: PL, x2: W - PR, y1: y(v), y2: y(v), class: "rc-level" });
      if (y(v) - lastY < 13) group.push({ name: ratingLevelName(k), y: group.length ? group[0].y : y(v) });
      else { flush(); group = [{ name: ratingLevelName(k), y: y(v) }]; lastY = y(v); }
    });
    flush();
    // 対局ごとのパフォーマンス(薄い点)とレート(線と点)
    games.forEach((g, i) => mk("circle", { cx: x(i), cy: y(g.perf), r: 2.5, class: "rc-perf" }));
    if (n >= 2) mk("path", { d: games.map((g, i) => `${i ? "L" : "M"} ${x(i)} ${y(g.after)}`).join(" "), class: "rc-line" });
    games.forEach((g, i) => {
      const c = mk("circle", { cx: x(i), cy: y(g.after), r: 4, class: `rc-pt res-${g.result}` });
      const title = document.createElementNS(SVGNS, "title");
      title.textContent = `${i + 1}局目 ${g.timestamp}\nvs ${g.levelName} ${g.result === "win" ? "勝ち" : g.result === "loss" ? "負け" : "引き分け"}\nレート ${g.after} / この対局 ${g.perf}`;
      c.appendChild(title);
    });
    mk("text", { x: PL, y: H - 6, class: "rc-axis" }, "1局目");
    if (n > 1) mk("text", { x: W - PR, y: H - 6, class: "rc-axis", "text-anchor": "end" }, `${n}局目`);
    const wrap = el("div", { class: "rating-chart-wrap" }, [svg]);
    wrap.appendChild(el("div", { class: "rating-chart-legend" }, [
      el("span", {}, [el("i", { class: "lg lg-line" }), document.createTextNode("レート")]),
      el("span", {}, [el("i", { class: "lg lg-perf" }), document.createTextNode("その対局のパフォーマンス")]),
      el("span", {}, [el("i", { class: "lg lg-win" }), document.createTextNode("勝ち")]),
      el("span", {}, [el("i", { class: "lg lg-loss" }), document.createTextNode("負け")]),
      el("span", {}, [el("i", { class: "lg lg-level" }), document.createTextNode("AIの強さの目安")]),
    ]));
    return wrap;
  }

  // ============================================================ 対戦履歴
  // payload.preselect: 最初から選択しておく記録のid(LINEから引き継いだ記録など)
  function renderHistory(root, payload) {
    const preselect = (payload && payload.preselect) || [];
    const screen = el("div", { class: "screen" });
    screen.appendChild(el("h1", { class: "card-title", text: "対戦履歴", style: { fontSize: "24px" } }));
    screen.appendChild(el("div", { class: "field-hint", text: "この端末のブラウザに保存されている対戦記録です(他の端末とは共有されません)。" }));
    if (preselect.length) {
      screen.appendChild(el("div", { class: "banner success" }, [
        el("span", { text: `LINEから${preselect.length}件の対局記録を引き継ぎました。選択済みなので「まとめてダウンロード」で保存できます。` }),
      ]));
    } else if (IS_LINE_BROWSER) {
      screen.appendChild(el("div", { class: "banner neutral" }, [
        el("span", { text: "LINEで開いています。ダウンロードするときは、記録を引き継いでSafari・Chromeなどのブラウザで開き直します。" }),
      ]));
    }
    const card = el("div", { class: "card", style: { width: "min(640px,100%)" } });
    const list = el("ul", { class: "history-list" });
    const records = loadHistory().slice().reverse();
    if (!records.length) {
      card.appendChild(el("div", { class: "history-empty", text: "まだ対戦記録がありません。対戦を1局終えると、ここに表示されます。" }));
    } else {
      // まとめてダウンロード用の選択状態(画面を開き直すとリセット)
      const selected = new Set(records.filter((r) => preselect.includes(r.id)).map((r) => r.id));
      const checkboxes = [];
      const countText = el("span", { class: "history-bulk-count" });
      const downloadBtn = el("button", {
        class: "btn btn-compact", onclick: () => downloadKifuCsvBundle(records.filter((r) => selected.has(r.id))),
      });
      function refreshBulk() {
        checkboxes.forEach(([cb, rec]) => { cb.checked = selected.has(rec.id); });
        countText.textContent = `${selected.size} / ${records.length}件を選択`;
        downloadBtn.disabled = selected.size === 0;
        downloadBtn.textContent = selected.size >= 2 ? `まとめてダウンロード(ZIP・${selected.size}件)` : "まとめてダウンロード";
      }
      function selectRecords(recs) {
        selected.clear();
        recs.forEach((r) => selected.add(r.id));
        refreshBulk();
      }
      const bulk = el("div", { class: "history-bulk" });
      const pickers = el("div", { class: "history-bulk-pickers" });
      pickers.appendChild(el("button", { class: "btn btn-compact", text: "すべて", onclick: () => selectRecords(records) }));
      [10, 30].filter((n) => records.length > n).forEach((n) => {
        pickers.appendChild(el("button", { class: "btn btn-compact", text: `最新${n}件`, onclick: () => selectRecords(records.slice(0, n)) }));
      });
      pickers.appendChild(el("button", { class: "btn btn-compact", text: "解除", onclick: () => selectRecords([]) }));
      bulk.appendChild(pickers);
      bulk.appendChild(el("div", { class: "history-bulk-action" }, [countText, downloadBtn]));
      card.appendChild(bulk);

      records.forEach((rec) => {
        const row = el("li", { class: "history-row" });
        const cl = rec.contactLimit != null ? `接触${rec.contactLimit}` : "接触制限なし";
        const cb = el("input", {
          type: "checkbox", class: "history-check", "aria-label": `${rec.timestamp} の対局を選択`,
          onchange: () => { if (cb.checked) selected.add(rec.id); else selected.delete(rec.id); refreshBulk(); },
        });
        checkboxes.push([cb, rec]);
        row.appendChild(el("label", { class: "history-pick" }, [
          cb,
          el("div", { class: "history-text" }, [
            el("div", { class: "history-head", text: `${rec.modeLabel} - ${rec.resultText}` }),
            el("div", { class: "history-sub", text: `${rec.timestamp}  ${rec.rows}x${rec.cols} / ${cl}${rec.evalDisplay ? " / 形勢表示あり" : ""}` }),
          ]),
        ]));
        const actions = el("div", { class: "history-actions" });
        actions.appendChild(el("button", { class: "btn btn-compact", text: "感想戦", onclick: () => openReview(rec) }));
        actions.appendChild(el("button", { class: "btn btn-compact", text: "CSV", onclick: () => downloadKifuCsv(rec) }));
        row.appendChild(actions);
        list.appendChild(row);
      });
      card.appendChild(list);
      refreshBulk();
    }
    screen.appendChild(card);
    root.appendChild(screen);
  }

  // ============================================================ 感想戦(棋譜再生)
  function openReview(record) {
    // レート計算などで解析結果が保存されていれば、そちら(保存済みの記録)を使う
    App.reviewRecord = loadHistory().find((r) => r.id === record.id) || record;
    App.screen = "review";
    render();
  }

  // 感想戦の盤に描く1局面ぶんの情報(本譜の各手と、検討の変化手順の局面で共通)
  function frameSnapshot(engine, desc, lastAction) {
    const board = new Map();
    for (const [pos, pid] of engine.board) board.set(pos, engine.pieces.get(pid).player);
    return {
      board,
      obligated: {
        A: engine.obligated.A.map((pid) => engine.pieces.get(pid).position),
        B: engine.obligated.B.map((pid) => engine.pieces.get(pid).position),
      },
      currentPlayer: engine.currentPlayer, winner: engine.winner, isDraw: engine.isDraw,
      desc, lastAction: lastAction || null,
      engineClone: engine.clone(), // 「この局面から対局を再開する」機能・検討の読みのために保持しておく
    };
  }

  function rebuildFramesFromRecord(record) {
    const config = makeConfig({
      rows: record.rows, cols: record.cols, moveRange: record.moveRange,
      wallSandwich: record.wallSandwich, contactLimit: record.contactLimit,
    });
    const engine = new GameEngine(config);
    engine.stock.A = record.stockA;
    engine.stock.B = record.stockB;
    const snapshot = (desc, lastAction) => frameSnapshot(engine, desc, lastAction);
    const frames = [snapshot("対局開始", null)];
    for (const mv of record.moves) {
      try {
        let lastAction;
        if (mv.action === "配置") {
          const pos = posFromLabel(mv.to);
          engine.placePiece(engine.currentPlayer, pos);
          lastAction = { from: null, to: pos };
        } else {
          const from = posFromLabel(mv.from);
          const to = posFromLabel(mv.to);
          const piece = engine.pieceAt(from);
          if (!piece) break;
          engine.movePiece(engine.currentPlayer, piece.id, to);
          lastAction = { from, to };
        }
        let label = `${mv.turn}手目: ${mv.player}が${mv.action}(${mv.to})`;
        if (mv.sandwiched && mv.sandwiched.length) label += ` [${mv.sandwiched.join(",")}を挟んだ]`;
        if (mv.selfSandwiched) label += " [自分の駒が挟まれた]";
        frames.push(snapshot(label, lastAction));
      } catch (e) { break; }
    }
    return frames;
  }

  // 感想戦のある局面から、実際に対局を再開する(追加仕様3)。
  // frames[ply] が再開する局面(ply = それまでに指された手数)
  function openResumeSetup(record, frames, ply) {
    const veil = el("div", { class: "veil" });
    const engine0 = frames[ply].engineClone;
    const sideSelect = el("select", { class: "field-select" }, [
      el("option", { value: "A", text: "先手(A)" }),
      el("option", { value: "B", text: "後手(B)" }),
    ]);
    sideSelect.value = engine0.currentPlayer;
    const levelSelect = el("select", { class: "field-select" });
    AI.LEVEL_ORDER.forEach((i) => levelSelect.appendChild(el("option", { value: String(i), text: AI.LEVELS[i].name })));
    levelSelect.value = "5";
    const modal = el("div", { class: "modal" }, [
      el("p", { text: "この局面から、実際に対局を再開します。どちらのプレイヤーを担当しますか?" }),
      el("div", { class: "field-row" }, [el("div", { class: "field-label", text: "担当する側" }), sideSelect]),
      el("div", { class: "field-row" }, [el("div", { class: "field-label", text: "相手AIの強さ" }), levelSelect]),
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn", text: "キャンセル", onclick: () => veil.remove() }),
        el("button", { class: "btn btn-primary", text: "再開する", style: { width: "auto", fontSize: "14px", padding: "10px 16px" }, onclick: () => {
          veil.remove();
          resumeMatchFromEngine(engine0.clone(), sideSelect.value, parseInt(levelSelect.value, 10), { record, frames, ply });
        } }),
      ]),
    ]);
    veil.appendChild(modal);
    document.body.appendChild(veil);
  }

  // 対戦履歴に残す記録が感想戦の局面だけで途切れないよう、元の対局の持ち駒(初期値)と
  // 再開までの手を引き継ぐ(engine.stock は「残りの」持ち駒なので記録には使えない)。
  function resumeMatchFromEngine(engine, humanPlayer, aiLevel, source) {
    const { record, frames, ply } = source;
    App.match = {
      mode: "pvai",
      boardSize: engine.config.rows, moveRange: engine.config.moveRange, contactLimit: engine.config.contactLimit,
      aiLevel, aiLevelB: null, aiSpecialist: false, aiSpecialistB: false,
      stockA: record.stockA, stockB: record.stockB,
      ruleTemplate: recordUsesTemplate(record) ? C.TEMPLATE_ID : null,
      engine,
      humanPlayer,
      resumedFrom: { id: record.id, ply },
      selected: null,
      lastAction: frames[ply].lastAction,
      logMessages: [`(感想戦の${ply}手目の局面から再開: それまでの${ply}手も棋譜に含めて保存します)`],
      kifuRecords: [],
      historyStack: [],
      aiThinking: false,
      aiVsAiPaused: false,
      kifuSaved: false,
      pieceNodes: new Map(),
      startedAt: Date.now(),
      onlineActions: [],
      // 形勢表示はメニューの設定(持ち時間なしの対局の既定)に従う
      evalDisplay: !(loadMenuSettings() && loadMenuSettings().evalCasual === false),
      evalView: null,
    };
    // 再開までの手。指し手の名前(あなた/AI)はこの対局の担当に合わせて付け直す
    App.match.kifuRecords = record.moves.slice(0, ply).map((mv, i) => {
      const mover = mv.mover || frames[i].currentPlayer;
      return Object.assign({}, mv, { turn: i + 1, mover, player: playerDisplayName(mover) });
    });
    App.screen = "game";
    render();
    proceedTurn();
  }

  // ---- 感想戦の解析(勝率グラフと悪手判定) ----
  // 各局面を形勢表示と同じ評価役で読み(analyzePosition)、隣り合う局面の勝率の差から1手ずつ判定する
  // (judgeMove)。読み終えた結果は対戦履歴の記録に保存して、次からはすぐ表示する。
  const ANALYSIS_VERSION = 1;

  function cachedAnalysis(record, nFrames) {
    const a = record.analysis;
    return a && a.v === ANALYSIS_VERSION && Array.isArray(a.frames) && a.frames.length === nFrames ? a.frames : null;
  }

  function saveRecordAnalysis(record, results) {
    record.analysis = { v: ANALYSIS_VERSION, budget: AI.EVAL_TIME_BUDGET, frames: results };
    const list = loadHistory();
    const i = list.findIndex((r) => r.id === record.id);
    if (i >= 0) { list[i].analysis = record.analysis; saveHistoryList(list); }
  }

  function recordUsesTemplate(record) {
    return C.configMatchesTemplate(record.rows, record.cols, record.moveRange, record.contactLimit,
      record.wallSandwich !== false, record.stockA, record.stockB);
  }

  // i手目(1始まり)の判定。解析が両側の局面ぶん揃っていなければ null
  function judgeAt(record, frames, results, i) {
    if (i < 1 || !results[i - 1] || !results[i]) return null;
    const mv = record.moves[i - 1];
    return AI.judgeMove(results[i - 1], results[i], frames[i - 1].currentPlayer, [mv.from || "", mv.to]);
  }

  function bestMoveText(best) {
    return best[0] ? `${best[0]}→${best[1]}` : `${best[1]}に配置`;
  }

  function pct(w) { return `${Math.round(w * 100)}%`; }

  function renderReview(root) {
    const record = App.reviewRecord;
    const screen = el("div", { class: "screen" });
    if (!record) { root.appendChild(el("p", { text: "記録が見つかりません。" })); return; }
    const frames = rebuildFramesFromRecord(record);
    let index = frames.length - 1;
    const nameOf = (p) => (p === "A" ? record.playerALabel || "先手" : record.playerBLabel || "後手");
    const cached = cachedAnalysis(record, frames.length);
    const results = cached ? cached.slice() : new Array(frames.length).fill(null);

    screen.appendChild(el("h1", { class: "card-title", text: "感想戦", style: { fontSize: "24px" } }));
    const cl = record.contactLimit != null ? `接触制限${record.contactLimit}` : "接触制限なし";
    screen.appendChild(el("div", { class: "field-hint", text: `${record.modeLabel} / ${record.rows}x${record.cols} / ${cl}${record.evalDisplay ? " / 形勢表示あり" : ""} - ${record.resultText}` }));

    // ---- 勝率グラフ(上が先手100%、下が後手100%)と、解析の進み具合・手の判定のまとめ ----
    const graphCard = el("div", { class: "review-graph-card" });
    const summary = el("div", { class: "review-summary" });
    graphCard.appendChild(summary);
    const SVGNS = "http://www.w3.org/2000/svg";
    const GW = 600, GH = 130, GP = 8;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "review-graph");
    svg.setAttribute("viewBox", `0 0 ${GW} ${GH}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "先手の勝率の推移(上ほど先手が優勢)。クリックでその手へ移動");
    graphCard.appendChild(svg);
    graphCard.appendChild(el("div", { class: "review-graph-legend" }, [
      el("span", { text: `上: ${nameOf("A")}(先手)優勢 / 下: ${nameOf("B")}(後手)優勢` }),
      el("span", {}, [
        el("i", { class: "mk mk-big" }), document.createTextNode("悪手・大悪手 "),
        el("i", { class: "mk mk-small" }), document.createTextNode("疑問手 "),
        el("i", { class: "mk mk-mate" }), document.createTextNode("詰みを読み切り"),
      ]),
    ]));
    screen.appendChild(graphCard);

    // 検討の変化手順(詰み手順の樹形図で選んだ局面)を盤に出している間の帯
    const varBanner = el("div", { class: "var-banner", style: { display: "none" } });
    screen.appendChild(varBanner);
    const boardWrap = el("div", { class: "board-wrap" });
    const size = record.rows;
    const { boardFrame, cellNodes, piecesLayer, fxLayer } = buildBoardShell(size, { fx: true });
    boardWrap.appendChild(boardFrame);
    screen.appendChild(boardWrap);

    const desc = el("div", { class: "review-desc" });
    const verdict = el("div", { class: "review-verdict" });
    screen.appendChild(desc);
    screen.appendChild(verdict);
    const toolbar = el("div", { class: "review-toolbar" });
    const step = el("span", { class: "review-step" });
    const first = el("button", { class: "btn btn-compact", text: "|<< 最初" });
    const prev = el("button", { class: "btn btn-compact", text: "< 前へ" });
    const next = el("button", { class: "btn btn-compact", text: "次へ >" });
    const last = el("button", { class: "btn btn-compact", text: "最後 >>|" });
    toolbar.appendChild(first); toolbar.appendChild(prev); toolbar.appendChild(step); toolbar.appendChild(next); toolbar.appendChild(last);
    screen.appendChild(toolbar);
    const jumpBar = el("div", { class: "review-toolbar" });
    const prevBad = el("button", { class: "btn btn-compact", text: "◀ 前の疑問手・悪手" });
    const nextBad = el("button", { class: "btn btn-compact", text: "次の疑問手・悪手 ▶" });
    const nextMate = el("button", { class: "btn btn-compact", text: "◆ 詰みを読み切った局面へ" });
    jumpBar.appendChild(prevBad); jumpBar.appendChild(nextBad); jumpBar.appendChild(nextMate);
    screen.appendChild(jumpBar);

    // AIの検討: 最善手・読み筋・詰み手順の樹形図
    const studyCard = el("div", { class: "study-card" });
    screen.appendChild(studyCard);

    const resumeBtn = el("button", { class: "btn btn-compact", text: "この局面から対局を再開する", onclick: () => openResumeSetup(record, frames, index) });
    screen.appendChild(resumeBtn);

    const list = el("ul", { class: "review-list" });
    list.appendChild(el("li", { text: "0: (対局開始)", onclick: () => { index = 0; renderFrame(); } }));
    const moveItems = [];
    record.moves.slice(0, frames.length - 1).forEach((mv, i) => {
      let line = `${mv.turn}: ${mv.player} ${mv.action}(${mv.to})`;
      if (mv.sandwiched && mv.sandwiched.length) line += ` [${mv.sandwiched.join(",")}]`;
      if (mv.selfSandwiched) line += " [自分挟み]";
      const tag = el("span", { class: "review-tag" });
      const li = el("li", { onclick: () => { index = i + 1; renderFrame(); } }, [el("span", { text: line }), tag]);
      moveItems.push({ li, tag });
      list.appendChild(li);
    });
    screen.appendChild(list);
    screen.appendChild(el("button", { class: "btn", text: "← メニューに戻る", onclick: () => goto("menu"), style: { marginTop: "6px" } }));
    root.appendChild(screen);

    svg.addEventListener("click", (e) => {
      const rect = svg.getBoundingClientRect();
      const n = frames.length - 1;
      if (!n || !rect.width) return;
      index = Math.round(((e.clientX - rect.left) / rect.width) * n);
      renderFrame();
    });

    function judgedMoves() {
      const out = [];
      for (let i = 1; i < frames.length; i++) out.push(judgeAt(record, frames, results, i));
      return out;
    }

    function drawGraph() {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const n = Math.max(1, frames.length - 1);
      const x = (i) => (i / n) * GW;
      const y = (w) => GP + (1 - w) * (GH - 2 * GP);
      const mk = (tag, attrs) => {
        const node = document.createElementNS(SVGNS, tag);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        svg.appendChild(node);
        return node;
      };
      mk("rect", { x: 0, y: 0, width: GW, height: GH, class: "g-bg" });
      // 詰みを読み切った局面の範囲を帯で強調する(先手の詰みは上端、後手の詰みは下端に濃い印)
      const half = GW / n / 2;
      const runs = mateRuns();
      for (const run of runs) {
        const x0 = Math.max(0, x(run.start) - half), x1 = Math.min(GW, x(run.end) + half);
        mk("rect", { x: x0, y: 0, width: Math.max(2, x1 - x0), height: GH, class: "g-mate" });
        mk("rect", { x: x0, y: run.side === "A" ? 0 : GH - 5, width: Math.max(2, x1 - x0), height: 5, class: "g-mate-edge" });
      }
      // 読み終えた先頭からの連続部分だけを線にする
      let upto = -1;
      while (upto + 1 < results.length && results[upto + 1]) upto++;
      if (upto >= 0) {
        let area = `M ${x(0)} ${y(0)}`;
        let line = "";
        for (let i = 0; i <= upto; i++) {
          area += ` L ${x(i)} ${y(results[i].winA)}`;
          line += `${i ? " L" : "M"} ${x(i)} ${y(results[i].winA)}`;
        }
        area += ` L ${x(upto)} ${y(0)} Z`;
        mk("path", { d: area, class: "g-area" });
        mk("path", { d: line, class: "g-line", "vector-effect": "non-scaling-stroke" });
      }
      // 詰みの範囲の線は金色で重ね、読み切った最初の局面に縦線を引く
      for (const run of runs) {
        let d = "";
        for (let i = run.start; i <= run.end; i++) d += `${i === run.start ? "M" : " L"} ${x(i)} ${y(winAAt(i))}`;
        if (run.end > run.start) mk("path", { d, class: "g-line-mate", "vector-effect": "non-scaling-stroke" });
        mk("line", { x1: x(run.start), x2: x(run.start), y1: 0, y2: GH, class: "g-mate-start", "vector-effect": "non-scaling-stroke" });
      }
      mk("line", { x1: 0, x2: GW, y1: y(0.5), y2: y(0.5), class: "g-mid", "vector-effect": "non-scaling-stroke" });
      mk("line", { x1: x(index), x2: x(index), y1: 0, y2: GH, class: "g-cursor", "vector-effect": "non-scaling-stroke" });
      judgedMoves().forEach((j, k) => {
        if (!j || !j.mark) return;
        const i = k + 1;
        mk("rect", { x: x(i) - 3, y: y(results[i].winA) - 3, width: 6, height: 6, class: j.mark === "?!" ? "g-mk-small" : "g-mk-big" });
      });
    }

    function drawSummary() {
      clearNode(summary);
      const done = results.filter(Boolean).length;
      if (done < results.length) {
        summary.appendChild(el("span", { class: "review-progress", text: `AIが解析しています… ${done} / ${results.length} 局面(1局面 約${(AI.EVAL_TIME_BUDGET / 1000).toFixed(1)}秒)` }));
        return;
      }
      const judged = judgedMoves();
      for (const p of ["A", "B"]) {
        const mine = judged.filter((j, k) => j && frames[k].currentPlayer === p && !j.forced);
        const count = (lb) => mine.filter((j) => j.label === lb).length;
        const avg = mine.length ? mine.reduce((s, j) => s + j.loss, 0) / mine.length : 0;
        const role = p === "A" ? "先手" : "後手";
        summary.appendChild(el("div", { class: `review-score side-${p.toLowerCase()}` }, [
          el("b", { text: nameOf(p).startsWith(role) ? nameOf(p) : `${role} ${nameOf(p)}` }),
          el("span", { text: `大悪手 ${count("大悪手")} / 悪手 ${count("悪手")} / 疑問手 ${count("疑問手")}` }),
          el("span", { class: "review-avg", text: `平均損失 ${(avg * 100).toFixed(1)}%` }),
        ]));
      }
      const runs = mateRuns();
      if (runs.length) {
        const parts = runs.map((run) => {
          const r = posInfo(run.start);
          return `${nameOf(run.side)} ${run.start}手目〜(読み切った時点であと${r.matePlies}手)`;
        });
        summary.appendChild(el("div", { class: "review-mate-line", text: `◆ 詰みの読み切り: ${parts.join(" / ")}` }));
      }
    }

    function drawTags() {
      judgedMoves().forEach((j, k) => {
        const item = moveItems[k];
        if (!item) return;
        item.tag.textContent = j && j.label ? ` ${j.mark} ${j.label} −${Math.floor(j.loss * 100)}%` : "";
        item.li.classList.toggle("is-bad", !!(j && j.mark && j.mark !== "?!"));
        item.li.classList.toggle("is-dubious", !!(j && j.mark === "?!"));
        item.li.classList.toggle("is-mate", !!mateAt(k + 1));
      });
    }

    function drawVerdict() {
      clearNode(verdict);
      const r = posInfo(index); // じっくり読んだ局面はその結果を出す
      let text;
      if (!r) text = "形勢: 解析中…";
      else if (r.final) text = frames[index].winner ? `${nameOf(frames[index].winner)}の勝ち` : "引き分け";
      else if (r.mate) text = `形勢: ${nameOf(r.mate)}の勝ちを読み切り(あと${r.matePlies}手)`;
      else text = `形勢: 先手 ${pct(r.winA)} / 後手 ${pct(1 - r.winA)}`;
      verdict.appendChild(el("div", { text }));
      const j = judgeAt(record, frames, results, index);
      if (!j) return;
      const cls = j.mark ? (j.mark === "?!" ? "is-dubious" : "is-bad") : "is-ok";
      const mover = nameOf(frames[index - 1].currentPlayer);
      const head = `この手(${mover})`;
      const rate = `${mover}の勝率 ${pct(j.before)} → ${pct(j.after)}`;
      let line;
      if (j.forced) line = `${head}: 他に指せる手がない局面でした`;
      else if (j.isBest) line = `${head}: 最善手(AIの読みと一致)  ${rate}`;
      else if (j.loss < 0.01) line = `${head}: 問題なし  ${rate}`;
      else {
        line = `${head}: ${j.label ? `${j.mark} ${j.label}` : "問題なし"}  ${rate}(−${Math.floor(j.loss * 100)}%)`;
        const best = results[index - 1].best;
        if (best) line += ` / AIの最善手: ${bestMoveText(best)}`;
      }
      verdict.appendChild(el("div", { class: `review-judge ${cls}`, text: line }));
    }

    // ---- AIの検討(最善手・読み筋・詰み手順の樹形図) ----
    const deepCache = new Map(); // 局面番号 → じっくり読んだ結果(deepAnalyze)
    const treeCache = new Map(); // 局面番号 → { status: "loading" | "ready" | "failed", data, reason, rev, expanding }
    let deepLoading = null;      // じっくり読んでいる局面番号
    let treeOpen = false;        // 樹形図を開いている(詰みのある別の局面へ移っても開いたまま)
    let varPath = null;          // 樹形図で選んだ手までのノード列(根の次の手から)。null なら本譜を表示
    let shownIndex = -1;
    let studySig = "";
    let showBest = loadReviewPrefs().showBest !== false;
    let treeDisp = new Map();    // 樹形図のノード → 表示用ノード(まとめた受けの手の一覧を引くため)

    // i手目の局面の解析結果(じっくり読んだ結果があればそちら)
    function posInfo(i) { return deepCache.get(i) || results[i] || null; }
    function winAAt(i) { const r = posInfo(i); return r ? r.winA : 0.5; }

    // i手目の局面で詰みを読み切っていれば勝つ側("A"/"B")。終局の局面は、直前から続く詰みの続きのときだけ数える
    function mateAt(i) {
      const r = posInfo(i);
      if (!r || !r.mate) return null;
      if (r.final) return i > 0 && mateAt(i - 1) === r.mate ? r.mate : null;
      return r.mate;
    }

    // 詰みを読み切った局面の連続する範囲 [{ start, end, side }]
    function mateRuns() {
      const runs = [];
      for (let i = 0; i < frames.length; i++) {
        const side = mateAt(i);
        if (!side) continue;
        const last = runs[runs.length - 1];
        if (last && last.side === side && last.end === i - 1) last.end = i;
        else runs.push({ start: i, end: i, side });
      }
      return runs;
    }

    function moveText(n) { return bestMoveText([n.from, n.to]); }

    // 樹形図で選んだ手順を本譜の局面に並べた局面。並べられなければ null
    function variationFrame(path) {
      const engine = frames[index].engineClone.clone();
      let lastAction = null, lastResult = null;
      try {
        for (const n of path) {
          const to = posFromLabel(n.to);
          if (n.from) {
            const from = posFromLabel(n.from);
            lastResult = engine.movePiece(engine.currentPlayer, engine.pieceAt(from).id, to);
            lastAction = { from, to };
          } else {
            lastResult = engine.placePiece(engine.currentPlayer, to);
            lastAction = { from: null, to };
          }
        }
      } catch (e) { return null; }
      const sand = lastResult ? lastResult.newlySandwiched.map((pid) => posLabel(engine.pieces.get(pid).position)) : [];
      return { frame: frameSnapshot(engine, "", lastAction), sand, node: path[path.length - 1] };
    }

    // 選んだ手の次の手(本線 = 先頭の枝)。path が null なら根の次の手
    function nextInLine(path) {
      const t = treeCache.get(index);
      if (!t || t.status !== "ready") return null;
      const node = path ? path[path.length - 1] : null;
      if (node && (node.pending || node.end)) return null;
      const kids = node ? node.kids : t.data.kids;
      return kids && kids.length ? kids[0] : null;
    }

    // 盤の矢印: 本譜では最善手、変化手順では次の手(本線)
    function drawArrow(variation) {
      clearNode(fxLayer);
      let move = null, side = null;
      if (variation) {
        const next = nextInLine(varPath);
        if (next && !variation.frame.winner) { move = [next.from, next.to]; side = next.side; }
      } else if (showBest) {
        const frame = frames[index];
        const r = posInfo(index);
        if (r && r.best && !frame.winner && !frame.isDraw) { move = r.best; side = frame.currentPlayer; }
      }
      if (!move) return;
      const NS = "http://www.w3.org/2000/svg";
      const add = (parent, tag, attrs) => {
        const node = document.createElementNS(NS, tag);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        parent.appendChild(node);
        return node;
      };
      const cell = 100 / size;
      const center = (label) => { const [r, c] = posFromLabel(label); return [(c + 0.5) * cell, (r + 0.5) * cell]; };
      const g = add(fxLayer, "g", { class: `best-arrow side-${side.toLowerCase()}` });
      const [tx, ty] = center(move[1]);
      const sw = cell * 0.11;
      if (move[0]) {
        const [fx, fy] = center(move[0]);
        const len = Math.hypot(tx - fx, ty - fy) || 1;
        const ux = (tx - fx) / len, uy = (ty - fy) / len;
        const head = cell * 0.34;
        const hx = tx - ux * cell * 0.04, hy = ty - uy * cell * 0.04; // 矢じりの先
        const bx = hx - ux * head, by = hy - uy * head;                // 矢じりの付け根
        const px = -uy * head * 0.62, py = ux * head * 0.62;
        add(g, "line", { x1: fx + ux * cell * 0.3, y1: fy + uy * cell * 0.3, x2: bx, y2: by, "stroke-width": sw, class: "arrow-shaft" });
        add(g, "polygon", { points: `${hx},${hy} ${bx + px},${by + py} ${bx - px},${by - py}`, class: "arrow-head" });
      } else {
        const s = cell * 0.14;
        add(g, "circle", { cx: tx, cy: ty, r: cell * 0.32, "stroke-width": sw * 0.8, class: "arrow-ring" });
        add(g, "path", { d: `M ${tx - s} ${ty} H ${tx + s} M ${tx} ${ty - s} V ${ty + s}`, "stroke-width": sw * 0.8, class: "arrow-plus" });
      }
    }

    function drawVarBanner(variation) {
      clearNode(varBanner);
      if (!variation) { varBanner.style.display = "none"; return; }
      varBanner.style.display = "";
      let text = `検討中の変化: ${index}手目の局面から${varPath.length}手進めた局面`;
      if (variation.frame.winner) text += ` ― ${nameOf(variation.frame.winner)}の勝ち(詰み)`;
      else text += `(あと${variation.node.mate}手で詰み)`;
      varBanner.appendChild(el("span", { text }));
      varBanner.appendChild(el("button", { class: "btn btn-compact", text: "本譜に戻る", onclick: () => { varPath = null; renderFrame(); } }));
    }

    function runDeep(i) {
      deepLoading = i;
      requestStudy("deep", frames[i].engineClone, { template: recordUsesTemplate(record), timeBudget: AI.DEEP_TIME_BUDGET }, (res, cancelled) => {
        if (deepLoading === i) deepLoading = null;
        if (cancelled) return;
        if (res) {
          const tree = res.tree;
          delete res.tree;
          deepCache.set(i, res);
          // 詰み探索で見つけた詰みは樹形図も一緒に届く。それ以外は詰みの手数が変わりうるので作り直す
          if (tree) treeCache.set(i, { status: "ready", data: tree, rev: 0 });
          else treeCache.delete(i);
        }
        refreshAll();
      });
      renderFrame();
    }

    function ensureTree(i) {
      const r = posInfo(i);
      if (treeCache.has(i) || !r || !r.mate || r.final) return;
      treeCache.set(i, { status: "loading", rev: 0 });
      // AIの評価の手数より長い詰み方しか示せないこともあるので、上限には少し余裕を持たせる
      requestStudy("mateTree", frames[i].engineClone, { winner: r.mate, plies: r.matePlies + 4, path: [] }, (res, cancelled) => {
        if (cancelled) { treeCache.delete(i); return; }
        treeCache.set(i, res && res.ok
          ? { status: "ready", data: res, rev: 0 }
          : { status: "failed", reason: res ? res.reason : "error", rev: 0 });
        if (index === i) renderFrame();
      });
    }

    // 枝が多くて展開を後回しにしたノード(pending)の続きを読む
    function expandNode(path) {
      const i = index;
      const t = treeCache.get(i);
      const node = path[path.length - 1];
      if (!t || t.expanding) return;
      t.expanding = node; t.rev++;
      requestStudy("mateTree", frames[i].engineClone, { winner: posInfo(i).mate, plies: node.mate, path: path.map((n) => [n.from, n.to]) }, (res, cancelled) => {
        t.expanding = null; t.rev++;
        if (cancelled) return;
        if (res && res.ok) { node.kids = res.kids; node.pending = false; } else node.failed = true;
        if (index === i) renderFrame();
      });
      renderFrame();
    }

    function drawStudy() {
      const frame = frames[index];
      const r = posInfo(index);
      if (treeOpen && r && r.mate && !frame.winner && deepLoading == null) ensureTree(index); // じっくり読んでいる間は待つ
      const tree = treeCache.get(index);
      const sig = [index, r ? [r.best && r.best.join(), r.mate, r.matePlies, r.deep, r.depth].join() : "-", deepLoading, treeOpen,
        tree ? `${tree.status}${tree.rev}` : "-", showBest, varPath ? varPath.map((n) => n.from + n.to).join(",") : ""].join("|");
      if (sig === studySig) return;
      studySig = sig;
      const oldScroll = studyCard.querySelector(".mate-tree-scroll");
      const keep = oldScroll ? [oldScroll.scrollLeft, oldScroll.scrollTop] : null;
      clearNode(studyCard);

      const bestCheck = el("input", { type: "checkbox" });
      bestCheck.checked = showBest;
      bestCheck.addEventListener("change", () => { showBest = bestCheck.checked; saveReviewPref("showBest", showBest); renderFrame(); });
      studyCard.appendChild(el("div", { class: "study-head" }, [
        el("span", { class: "study-title", text: "AIの検討" }),
        el("label", { class: "study-check" }, [bestCheck, document.createTextNode("盤に最善手を矢印で表示")]),
      ]));
      if (frame.winner || frame.isDraw) {
        studyCard.appendChild(el("div", { class: "study-muted", text: "対局が終わった局面です。前の局面に戻ると、その局面の最善手や詰み手順を見られます。" }));
        return;
      }

      const bestRow = el("div", { class: "study-best" });
      if (!r) {
        bestRow.appendChild(el("span", { class: "study-muted", text: "この局面はまだ解析中です(「じっくり読む」ですぐに読むこともできます)。" }));
      } else if (r.best) {
        bestRow.appendChild(document.createTextNode(`最善手(${nameOf(frame.currentPlayer)}の番): `));
        bestRow.appendChild(el("b", { text: bestMoveText(r.best) }));
        const how = r.mateBy ? "詰み探索で発見" : `読みの深さ ${r.depth}手`;
        bestRow.appendChild(el("span", { class: "study-muted", text: `  ${r.deep ? "じっくり読み" : "解析"}・${how}` }));
      } else {
        bestRow.appendChild(el("span", { class: "study-muted", text: "最善手を読み切れませんでした。" }));
      }
      studyCard.appendChild(bestRow);

      if (r && r.pv && r.pv.length > 1) {
        const pv = el("div", { class: "study-pv" }, [el("span", { class: "study-muted", text: "読み筋:" })]);
        let side = frame.currentPlayer;
        r.pv.forEach((mv) => {
          pv.appendChild(el("span", { class: `pv-chip side-${side.toLowerCase()}`, text: bestMoveText(mv), title: nameOf(side) }));
          side = otherPlayer(side);
        });
        studyCard.appendChild(pv);
      }

      const deepBtn = el("button", {
        class: "btn btn-compact",
        text: deepLoading === index ? "読んでいます…" : (r && r.deep ? "じっくり読みました" : `じっくり読む(${AI.DEEP_TIME_BUDGET / 1000}秒・読み筋つき)`),
        onclick: () => runDeep(index),
      });
      deepBtn.disabled = deepLoading === index || !!(r && r.deep);
      studyCard.appendChild(el("div", { class: "study-actions" }, [deepBtn]));

      if (r && r.mate) {
        studyCard.appendChild(el("div", { class: "study-mate" }, [
          el("span", { text: `◆ ${nameOf(r.mate)}の勝ちを読み切り ― あと${r.matePlies}手で詰み` }),
          el("button", {
            class: "btn btn-compact", text: treeOpen ? "樹形図を閉じる" : "詰み手順を見る(樹形図)",
            onclick: () => { treeOpen = !treeOpen; if (!treeOpen) varPath = null; renderFrame(); },
          }),
        ]));
        if (treeOpen) drawTreeArea(r, tree, keep);
      }
    }

    function drawTreeArea(r, tree, keep) {
      const area = el("div", { class: "mate-tree-area" });
      studyCard.appendChild(area);
      if (!tree || tree.status === "loading") {
        area.appendChild(el("div", { class: "study-muted", text: "詰み手順を組み立てています…(受けの手をすべて確かめるので、数秒かかることがあります)" }));
        return;
      }
      if (tree.status === "failed") {
        area.appendChild(el("div", { class: "study-muted", text: tree.reason === "timeout"
          ? "詰み手順の組み立てが時間内に終わりませんでした(受けの手が多すぎる局面です)。"
          : "この局面の詰みは、受けの手を1つずつ確かめる探索では示しきれませんでした。" }));
        area.appendChild(el("div", { class: "study-muted", text: r.pv && r.pv.length > 1
          ? "上の「読み筋」が、AIが詰みと読んだ本線です。"
          : "「じっくり読む」を押すと、AIが詰みと読んだ本線(読み筋)を表示します。" }));
        return;
      }
      const data = tree.data;
      const winner = r.mate;
      let head = `${nameOf(winner)}の詰み手順(${data.mate}手)。縦に並んだ枝は${nameOf(otherPlayer(winner))}の受けの候補で、上ほど長く粘る受けです。`;
      if (data.mate > r.matePlies) head += `(AIの評価では最短${r.matePlies}手ですが、ここでは1手ずつ確かめられた手順を示しています)`;
      area.appendChild(el("div", { class: "mt-head", text: head }));
      const scroll = el("div", { class: "mate-tree-scroll" }, [buildTreeSvg(data, winner)]);
      area.appendChild(scroll);
      if (keep) { scroll.scrollLeft = keep[0]; scroll.scrollTop = keep[1]; }
      // 選んだ手が見えるところまで(必要なぶんだけ)スクロールする
      const selRect = scroll.querySelector(".mt-node.is-sel rect");
      if (selRect) {
        const x = +selRect.getAttribute("x"), y = +selRect.getAttribute("y");
        const w = +selRect.getAttribute("width"), h = +selRect.getAttribute("height");
        if (x + w > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = x + w + 12 - scroll.clientWidth;
        if (x < scroll.scrollLeft) scroll.scrollLeft = Math.max(0, x - 12);
        if (y + h > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = y + h + 12 - scroll.clientHeight;
        if (y < scroll.scrollTop) scroll.scrollTop = Math.max(0, y - 12);
      }
      area.appendChild(treeInfo(winner));

      const back = el("button", { class: "btn btn-compact", text: "◀ 1手戻る", onclick: () => { varPath = varPath.length > 1 ? varPath.slice(0, -1) : null; renderFrame(); } });
      back.disabled = !varPath;
      const next = nextInLine(varPath);
      const fwd = el("button", { class: "btn btn-compact", text: "1手進む ▶", onclick: () => { varPath = (varPath || []).concat([next]); renderFrame(); } });
      fwd.disabled = !next;
      const toEnd = el("button", { class: "btn btn-compact", text: "本線を詰みまで ▶▶", onclick: () => {
        let p = varPath || [], n;
        while ((n = nextInLine(p.length ? p : null))) p = p.concat([n]);
        varPath = p.length ? p : null;
        renderFrame();
      } });
      toEnd.disabled = !next;
      area.appendChild(el("div", { class: "mt-steps" }, [back, fwd, toEnd]));
    }

    // 樹形図で選んでいる手の説明
    function treeInfo(winner) {
      const info = el("div", { class: "mt-info" });
      if (!varPath) {
        info.textContent = "手をクリック(タップ)すると、その局面を盤に表示します。金の枠が詰みの局面です。";
        return info;
      }
      const node = varPath[varPath.length - 1];
      const line = el("div", { class: "study-pv" });
      varPath.forEach((n, k) => {
        if (k) line.appendChild(el("span", { class: "study-muted", text: "→" }));
        line.appendChild(el("span", { class: `pv-chip side-${n.side.toLowerCase()}`, text: moveText(n), title: nameOf(n.side) }));
      });
      info.appendChild(line);
      const v = variationFrame(varPath);
      let text = `${nameOf(node.side)}が${moveText(node)}`;
      if (v && v.sand.length) text += `(${v.sand.join("・")}を挟む)`;
      text += node.end
        ? `。${nameOf(otherPlayer(node.side))}は動かせる駒がなくなり、${nameOf(node.side)}の勝ち(詰み)です。`
        : `。ここから${node.mate}手で詰みます。`;
      info.appendChild(el("div", { text }));
      const d = treeDisp.get(node);
      if (d && d.alts.length > 1) {
        const reply = node.kids[0];
        info.appendChild(el("div", { class: "study-muted", text: `この局面の受けは ${d.alts.map(moveText).join(" / ")} のどれを選んでも、次の${moveText(reply)}で詰みます(樹形図では1つにまとめています)。` }));
      }
      return info;
    }

    // 受けの手のうち、同じ返し手でその場で詰むもの同士は1つの表示にまとめる
    function displayKids(kids, winner) {
      const out = [], groups = new Map();
      for (const k of kids) {
        const reply = k.side !== winner && k.kids && k.kids.length === 1 ? k.kids[0] : null;
        if (reply && reply.end) {
          const key = reply.from + ">" + reply.to;
          const g = groups.get(key);
          if (g) { g.alts.push(k); continue; }
          const d = { node: k, alts: [k] };
          groups.set(key, d);
          out.push(d);
        } else {
          out.push({ node: k, alts: [k] });
        }
      }
      return out;
    }

    // 樹形図(左が今の局面、右へ行くほど先の手)。本線は1行目にまっすぐ並べる
    function buildTreeSvg(data, winner) {
      const COL = 118, CW = 104, CH = 24, ROW = 32, PAD = 8;
      const NS = "http://www.w3.org/2000/svg";
      const t = treeCache.get(index);
      let rows = 0, maxDepth = 0;
      treeDisp = new Map();
      const root = { node: null, alts: [], parent: null };
      (function lay(d, depth) {
        d.depth = depth;
        maxDepth = Math.max(maxDepth, depth);
        const raw = d.node ? d.node.kids : data.kids;
        d.kids = d.node && d.node.pending ? [] : displayKids(raw || [], winner);
        d.kids.forEach((k) => { k.parent = d; treeDisp.set(k.node, k); });
        if (d.node && d.node.pending) { maxDepth = Math.max(maxDepth, depth + 1); d.row = rows++; return; }
        if (!d.kids.length) { d.row = rows++; return; }
        d.kids.forEach((k) => lay(k, depth + 1));
        d.row = d.kids[0].row;
      })(root, 0);

      const W = PAD * 2 + maxDepth * COL + CW, Hh = PAD * 2 + (rows - 1) * ROW + CH;
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "mate-tree");
      svg.setAttribute("width", W); svg.setAttribute("height", Hh);
      svg.setAttribute("viewBox", `0 0 ${W} ${Hh}`);
      svg.setAttribute("role", "group");
      svg.setAttribute("aria-label", "詰み手順の樹形図");
      const add = (parent, tag, attrs, text) => {
        const node = document.createElementNS(NS, tag);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        if (text != null) node.textContent = text;
        parent.appendChild(node);
        return node;
      };
      const onPath = new Set(varPath || []);
      const sel = varPath ? varPath[varPath.length - 1] : null;
      const xy = (depth, row) => [PAD + depth * COL, PAD + row * ROW];
      const pathTo = (d) => { const p = []; for (let x = d; x && x.node; x = x.parent) p.unshift(x.node); return p; };
      const links = add(svg, "g", {});
      const nodes = add(svg, "g", {});

      function link(d1, depth2, row2, lit) {
        const [x1, y1] = xy(d1.depth, d1.row);
        const [x2, y2] = xy(depth2, row2);
        const xm = x1 + CW + (COL - CW) / 2;
        add(links, "path", { d: `M ${x1 + CW} ${y1 + CH / 2} H ${xm} V ${y2 + CH / 2} H ${x2}`, class: `mt-link${lit ? " on-path" : ""}` });
      }

      function chip(depth, row, cls, label, tag, title, onClick) {
        const [x, y] = xy(depth, row);
        const g = add(nodes, "g", { class: `mt-node ${cls}`, tabindex: "0", role: "button" });
        add(g, "title", {}, title);
        add(g, "rect", { x, y, width: CW, height: CH, rx: 5 });
        if (cls.includes("side-")) add(g, "circle", { class: "dot", cx: x + 11, cy: y + CH / 2, r: 4.5 });
        const text = add(g, "text", { x: cls.includes("side-") ? x + 21 : x + CW / 2, y: y + CH / 2 + 4, "text-anchor": cls.includes("side-") ? "start" : "middle" }, label);
        if (tag) add(text, "tspan", { class: "tag" }, tag);
        g.addEventListener("click", onClick);
        g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } });
      }

      // 読み上げの順が本線→他の受けになるよう、親のノードを先に描く(線は別のグループ)
      (function draw(d) {
        drawChip(d);
        if (d.node && d.node.pending) link(d, d.depth + 1, d.row, false);
        for (const k of d.kids) { link(d, k.depth, k.row, onPath.has(k.node)); draw(k); }
      })(root);
      return svg;

      function drawChip(d) {
        if (!d.node) {
          chip(0, d.row, `is-root${varPath ? "" : " is-sel"}`, `${index}手目の局面`, null,
            `${index}手目の局面(${nameOf(frames[index].currentPlayer)}の番)。クリックで最初に戻る`, () => { varPath = null; renderFrame(); });
          return;
        }
        const n = d.node;
        const cls = [`side-${n.side.toLowerCase()}`, n.end ? "is-end" : "", onPath.has(n) ? "on-path" : "", n === sel ? "is-sel" : ""].join(" ");
        const extra = d.alts.length > 1 ? ` 他${d.alts.length - 1}` : (n.end ? " 詰み" : null);
        let title = `${nameOf(n.side)}: ${d.alts.map(moveText).join(" / ")}`;
        title += n.end ? "(詰み)" : `(このあと${n.mate}手で詰み)`;
        chip(d.depth, d.row, cls, moveText(n), extra, title, () => { varPath = pathTo(d); renderFrame(); });
        if (n.pending) {
          const busy = t && t.expanding === n;
          chip(d.depth + 1, d.row, "is-pending", busy ? "読んでいます…" : (n.failed ? "読み切れず" : "続きを読む…"), null,
            "枝が多いので後回しにした続きを読みます", () => { if (!n.failed) expandNode(pathTo(d)); });
        }
      }
    }

    function badIndices() {
      const out = [];
      judgedMoves().forEach((j, k) => { if (j && j.mark) out.push(k + 1); });
      return out;
    }

    function paintBoard(frame) {
      clearNode(piecesLayer);
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) cellNodes[r][c].classList.remove("is-last");
      const obligatedPositions = new Set();
      for (const p of ["A", "B"]) for (const pos of frame.obligated[p]) obligatedPositions.add(pos[0] + "," + pos[1]);
      for (const [pos, player] of frame.board) {
        const [r, c] = pos.split(",").map(Number);
        const node = el("div", { class: `piece p-${player}` });
        node.style.width = (100 / size) + "%"; node.style.height = (100 / size) + "%";
        node.style.transform = `translate(${c * 100}%, ${r * 100}%)`;
        node.appendChild(el("div", { class: "disc" }, [el("span", { class: "label", text: player })]));
        if (obligatedPositions.has(pos)) node.classList.add("is-obligated");
        piecesLayer.appendChild(node);
      }
      if (frame.lastAction) {
        const to = frame.lastAction.to;
        cellNodes[to[0]][to[1]].classList.add("is-last");
      }
    }

    function renderFrame() {
      index = Math.max(0, Math.min(frames.length - 1, index));
      if (index !== shownIndex) { varPath = null; shownIndex = index; } // 本譜の手を移ったら変化手順の表示はやめる
      const frame = frames[index];
      const variation = varPath ? variationFrame(varPath) : null;
      if (!variation) varPath = null;
      paintBoard(variation ? variation.frame : frame);
      drawArrow(variation);
      drawVarBanner(variation);
      desc.textContent = frame.desc;
      step.textContent = `${index} / ${frames.length - 1} 手`;
      first.disabled = prev.disabled = index === 0;
      next.disabled = last.disabled = index === frames.length - 1;
      resumeBtn.disabled = !!(frame.winner || frame.isDraw);
      const bad = badIndices();
      prevBad.disabled = !bad.some((i) => i < index);
      nextBad.disabled = !bad.some((i) => i > index);
      nextMate.disabled = !mateRuns().some((run) => run.start !== index);
      Array.from(list.children).forEach((li, i) => li.classList.toggle("is-current", i === index));
      drawVerdict();
      drawGraph();
      drawStudy();
    }
    first.addEventListener("click", () => { index = 0; renderFrame(); });
    prev.addEventListener("click", () => { index--; renderFrame(); });
    next.addEventListener("click", () => { index++; renderFrame(); });
    last.addEventListener("click", () => { index = frames.length - 1; renderFrame(); });
    prevBad.addEventListener("click", () => {
      const b = badIndices().filter((i) => i < index);
      if (b.length) { index = b[b.length - 1]; renderFrame(); }
    });
    nextBad.addEventListener("click", () => {
      const b = badIndices().find((i) => i > index);
      if (b != null) { index = b; renderFrame(); }
    });
    nextMate.addEventListener("click", () => {
      const starts = mateRuns().map((run) => run.start).filter((i) => i !== index);
      if (!starts.length) return;
      index = starts.find((i) => i > index) != null ? starts.find((i) => i > index) : starts[0]; // 最後まで行ったら先頭へ
      renderFrame();
    });

    function refreshAll() { drawSummary(); drawTags(); renderFrame(); }
    refreshAll();

    // まだ解析していない局面を、最初から1つずつ読む(この画面を離れたら打ち切る)
    if (results.some((r) => !r)) {
      const token = App.reviewToken = (App.reviewToken || 0) + 1;
      const template = recordUsesTemplate(record);
      const stillHere = () => App.screen === "review" && App.reviewToken === token;
      const analyzeNext = () => {
        if (!stillHere()) return;
        const i = results.findIndex((r) => !r);
        if (i < 0) { saveRecordAnalysis(record, results); refreshAll(); return; }
        requestEval(frames[i].engineClone, template, (res) => {
          if (!stillHere()) return;
          // 読めなかった局面(Worker の不調など)は互角扱いで埋めて先へ進む
          results[i] = res || { winA: 0.5, mate: null, matePlies: null, depth: 0, final: false, best: null, nActs: 0 };
          refreshAll();
          analyzeNext();
        }, "analyze");
      };
      analyzeNext();
    }
  }

  // ============================================================ オンライン(手番リンク方式)
  // onlineActions の要素は {kind:"place", to:[r,c]} または {kind:"move", from:[r,c], to:[r,c]}。
  // evalDisplay: 形勢表示あり(作った人が決め、両者に同じ設定で表示する)。なしなら載せない
  function encodeMatchCode(config, stockA, stockB, onlineActions, evalDisplay) {
    const payload = {
      r: config.rows, mr: config.moveRange, cl: config.contactLimit,
      sa: stockA, sb: stockB,
      mv: onlineActions.map((a) => (a.kind === "place" ? ["p", posLabel(a.to)] : ["m", posLabel(a.from), posLabel(a.to)])),
    };
    if (evalDisplay) payload.ev = 1;
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decodeMatchCode(code) {
    let b64 = code.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  }

  function renderOnline(root) {
    const screen = el("div", { class: "screen" });
    screen.appendChild(el("h1", { class: "card-title", text: "オンライン対戦", style: { fontSize: "24px" } }));

    const hash = location.hash;
    const m = hash.match(/^#online=(.+)$/);
    if (m) { renderOnlineFromCode(screen, m[1]); root.appendChild(screen); return; }

    screen.appendChild(el("div", { class: "online-note" }, [
      el("div", { text: "この挟みゲームは GitHub Pages 上で動く「静的サイト」なので、Python版のように" }),
      el("div", { text: "TCPで直接つなぐことはできません(サーバーが無いため、外から接続を受け付けられないのです)。" }),
      el("div", { text: "代わりに、盤面のデータを短いリンクに変換して順番に送り合う「手番リンク」方式で、" }),
      el("div", { text: "離れた相手と(LINEやメールなどで)対局できます。同じ画面を2人で使う対人戦と同じ操作方法です。" }),
    ]));

    const card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "card-title", text: "新しい対局を作る" }));

    const sizeRow = el("div", { class: "field-row" });
    sizeRow.appendChild(el("div", { class: "field-label", text: "盤面サイズ" }));
    const sizeSelect = el("select", { class: "field-select" });
    C.BOARD_SIZE_CHOICES.forEach((n) => sizeSelect.appendChild(el("option", { value: n, text: `${n} x ${n}` })));
    sizeSelect.value = "7";
    sizeRow.appendChild(el("div", { class: "field-control" }, [sizeSelect]));
    card.appendChild(sizeRow);

    const rangeRow = el("div", { class: "field-row" });
    rangeRow.appendChild(el("div", { class: "field-label", text: "移動範囲" }));
    const rangeSelect = el("select", { class: "field-select" }, [1, 2, 3].map((n) => el("option", { value: n, text: n + "マス" })));
    rangeRow.appendChild(el("div", { class: "field-control" }, [rangeSelect]));
    card.appendChild(rangeRow);

    const contactRow = el("div", { class: "field-row" });
    contactRow.appendChild(el("div", { class: "field-label", text: "接触制限" }));
    const contactSelect = el("select", { class: "field-select" }, C.CONTACT_LIMIT_CHOICES.map((n) => el("option", { value: n, text: String(n) })));
    contactSelect.value = String(C.DEFAULT_CONTACT_LIMIT);
    contactRow.appendChild(el("div", { class: "field-control" }, [contactSelect]));
    card.appendChild(contactRow);

    const stockRow = el("div", { class: "field-row" });
    stockRow.appendChild(el("div", { class: "field-label", text: "持ち駒(先手・後手とも同数)" }));
    const stockInput = el("input", { class: "stock-input", type: "number", min: "1", value: String(defaultStockForSize(7)) });
    stockRow.appendChild(el("div", { class: "field-control" }, [stockInput]));
    card.appendChild(stockRow);

    sizeSelect.addEventListener("change", () => { stockInput.value = String(defaultStockForSize(parseInt(sizeSelect.value, 10))); });

    // 形勢表示はオンライン対戦では既定でオフ。オンにすると両者の画面に表示する
    const evalCheck = el("input", { type: "checkbox" });
    card.appendChild(el("label", { class: "check-row", style: { marginTop: "8px" } }, [evalCheck, document.createTextNode("対局中に形勢(優勢・劣勢の%)を表示する")]));
    card.appendChild(el("div", { class: "field-hint", text: "既定はオフです。オンにすると、リンクを受け取った相手の画面にも同じように表示されます(棋譜には「形勢表示あり」と記録)。" }));

    const createBtn = el("button", { class: "btn btn-primary", text: "対局を作ってリンクを発行", style: { marginTop: "14px" } });
    card.appendChild(createBtn);
    screen.appendChild(card);
    root.appendChild(screen);

    createBtn.addEventListener("click", () => {
      const config = { rows: parseInt(sizeSelect.value, 10), cols: parseInt(sizeSelect.value, 10), moveRange: parseInt(rangeSelect.value, 10), contactLimit: parseInt(contactSelect.value, 10) };
      const stock = parseInt(stockInput.value, 10) || defaultStockForSize(config.rows);
      const code = encodeMatchCode(config, stock, stock, [], evalCheck.checked);
      location.hash = "online=" + code;
      goto("online");
    });
  }

  function renderOnlineFromCode(screen, code) {
    let payload;
    try { payload = decodeMatchCode(code); } catch (e) {
      screen.appendChild(el("div", { class: "online-note", text: "リンクを読み取れませんでした。URLが途中で切れていないか確認してください。" }));
      return;
    }
    const config = makeConfig({ rows: payload.r, cols: payload.r, moveRange: payload.mr, contactLimit: payload.cl, wallSandwich: true });
    const engine = new GameEngine(config);
    engine.stock.A = payload.sa; engine.stock.B = payload.sb;
    const onlineActions = [];
    for (const mv of payload.mv) {
      let action, from = null, to;
      if (mv[0] === "p") {
        to = posFromLabel(mv[1]);
        action = ["place", to];
      } else {
        from = posFromLabel(mv[1]);
        to = posFromLabel(mv[2]);
        const piece = engine.pieceAt(from);
        if (!piece) { screen.appendChild(el("div", { class: "online-note", text: "局面の再現に失敗しました。" })); return; }
        action = ["move", piece.id, to];
      }
      try {
        AI.applyAction(engine, engine.currentPlayer, action);
        onlineActions.push(mv[0] === "p" ? { kind: "place", to } : { kind: "move", from, to });
      } catch (e) {
        screen.appendChild(el("div", { class: "online-note", text: "局面の再現に失敗しました(不正なリンクの可能性があります)。" }));
        return;
      }
    }

    App.match = {
      mode: "online", boardSize: config.rows, moveRange: config.moveRange, contactLimit: config.contactLimit,
      aiLevel: null, aiLevelB: null, aiSpecialist: false, aiSpecialistB: false,
      stockA: payload.sa, stockB: payload.sb, ruleTemplate: null,
      engine, humanPlayer: "A", selected: null, lastAction: null,
      logMessages: [], kifuRecords: [], historyStack: [], aiThinking: false, aiVsAiPaused: false,
      kifuSaved: false, pieceNodes: new Map(), onlineActions,
      // 形勢表示は対局を作った人が決め、リンクに載せて両者に同じ設定で表示する
      evalDisplay: !!payload.ev, evalView: null,
    };
    App.screen = "game";
    render();
    injectOnlineShareUI();
    refreshEval();
  }

  function injectOnlineShareUI() {
    const m = App.match;
    if (m.mode !== "online") return;
    const dom = App.gameDom;
    const box = el("div", { class: "card", style: { width: "min(560px,100%)" } });
    box.appendChild(el("div", { class: "card-title", text: "手番を相手に送る", style: { fontSize: "14px" } }));
    box.appendChild(el("div", { class: "field-hint", text: "自分の手を指したら、下のリンクをコピーして相手に送ってください。相手がリンクを開いて指すと、また新しいリンクが作られます。" }));
    const shareBox = el("div", { class: "share-box", style: { marginTop: "10px" } });
    const input = el("input", { readonly: true });
    const copyBtn = el("button", { class: "btn btn-compact", text: "コピー" });
    shareBox.appendChild(input); shareBox.appendChild(copyBtn);
    box.appendChild(shareBox);
    dom.bannerHost.parentElement.insertBefore(box, dom.bannerHost.nextSibling);

    function refreshLink() {
      const code = encodeMatchCode(m.engine.config, m.stockA, m.stockB, m.onlineActions, m.evalDisplay);
      const url = location.origin + location.pathname + "#online=" + code;
      input.value = url;
    }
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        toast("リンクをコピーしました");
      } catch (e) {
        input.select();
        toast("コピーできませんでした。手動で選択してコピーしてください。");
      }
    });
    refreshLink();
    App.onlineRefreshLink = refreshLink;
  }

  // ============================================================ 起動
  // #online=<コード> を含むリンクから開かれた場合は、そのままオンライン対局へ。
  // #kifu=<コード> はLINE内ブラウザから引き継いだ対局記録(offerLineHandoff参照)。
  if (location.hash.startsWith(KIFU_HASH_PREFIX)) {
    App.screen = "history";
    importKifuFromHash().then((ids) => { render(ids && ids.length ? { preselect: ids } : undefined); });
  } else {
    App.screen = /^#online=/.test(location.hash) ? "online" : "menu";
    render();
  }
  window.addEventListener("hashchange", () => {
    if (/^#online=/.test(location.hash) && App.screen !== "game") { App.screen = "online"; render(); }
  });
  // 前回ページを閉じたときにレート計算が終わっていなかった対局があれば、裏で続きを計算する
  setTimeout(processPendingRatings, 1500);
})();
