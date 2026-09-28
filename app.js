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
      worker = new Worker_("ai-worker.js?v=3");
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
    const renderers = {
      menu: renderMenu, game: renderGame, tutorial: renderTutorial, strategy: renderStrategy,
      report: renderReport, history: renderHistory, review: renderReview, online: renderOnline,
      tsume: renderTsumeMenu,
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

    const levelRowB = el("div", { class: "field-row", style: { display: "none" } });
    levelRowB.appendChild(el("div", { class: "field-label", text: "後手AIの強さ" }));
    const levelSelectB = buildLevelSelect();
    levelRowB.appendChild(el("div", { class: "field-control" }, [levelSelectB]));
    card.appendChild(levelRowB);

    card.appendChild(el("hr", { class: "hr" }));
    card.appendChild(el("div", { class: "field-hint", text: "持ち駒(AIの強さとは独立に自由に設定できます)" }));

    const defaultStock = defaultStockForSize(7);
    const stockRow = el("div", { class: "field-row" });
    stockRow.appendChild(el("div", { class: "field-label", text: "先手(1P) / 後手(2P・AI)" }));
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
      for (let i = 1; i <= 7; i++) sel.appendChild(el("option", { value: String(i), text: AI.LEVELS[i].name }));
      sel.value = "3";
      return sel;
    }

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
      const mode = modeInputs.pvai.checked ? "pvai" : modeInputs.pvp.checked ? "pvp" : "ai_vs_ai";
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

    startBtn.addEventListener("click", () => {
      errorText.textContent = "";
      const mode = modeInputs.pvai.checked ? "pvai" : modeInputs.pvp.checked ? "pvp" : "ai_vs_ai";
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

      startNewMatch({
        mode, boardSize: size, moveRange, contactLimit,
        aiLevel, aiLevelB, aiSpecialist: specA, aiSpecialistB: specB,
        stockA: sa, stockB: sb,
        ruleTemplate: template ? C.TEMPLATE_ID : null,
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

    App.match = {
      mode: opts.mode,
      boardSize: opts.boardSize, moveRange: opts.moveRange, contactLimit: opts.contactLimit,
      aiLevel: opts.aiLevel, aiLevelB: opts.aiLevelB,
      aiSpecialist: !!opts.aiSpecialist, aiSpecialistB: !!opts.aiSpecialistB,
      stockA: opts.stockA, stockB: opts.stockB,
      ruleTemplate: opts.ruleTemplate,
      engine,
      humanPlayer: "A",
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
      // オンライン(手番リンク)関連
      onlineActions: [],
    };
    App.screen = "game";
    render();
    maybeTriggerAI();
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
    try { w = new Worker_("ai-worker.js?v=3"); } catch (e) { toast("自動作問を開始できませんでした(ローカルサーバー経由で開いてください)"); return; }
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
    if (m.mode === "pvai") return `AI戦 - ${aiStrengthName(m.aiLevel, m.aiSpecialist)}`;
    if (m.mode === "tsume") return `詰めピンチ ${tsumeTitle(m.puzzle)}`;
    if (m.mode === "pvp") return "対人戦(同画面)";
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
    const m = App.match;
    recordIfFinished();
    updateGameUI();
    if (m.engine.isOver()) return;
    maybeTriggerAI();
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
    }
  }

  function resultText() {
    const m = App.match;
    if (m.engine.winner) return `${playerDisplayName(m.engine.winner)}の勝ち`;
    if (m.engine.isDraw) return "引き分け(千日手)";
    return "不明(対局途中)";
  }

  function buildMatchRecord(m) {
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
    if (m.mode === "ai_vs_ai") { topBar.appendChild(pauseBtn); topBar.appendChild(stepBtn); }
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
    if (!m || m.engine.isOver() || m.aiThinking) return;
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

  function onUndo() {
    const m = App.match;
    if (m.aiThinking || !m.historyStack.length) return;
    if (m.mode === "tsume" && m.tsumeReplay) return;
    let snap = null;
    if (m.mode === "tsume") {
      // あなたの手番まで戻す(失敗した手・詰ませた手の直前に戻れる)
      do { snap = m.historyStack.pop(); } while (m.historyStack.length && snap.engine.currentPlayer !== m.humanPlayer);
      m.tsumeUndoUsed = true;
      m.tsumeFailed = null;
      m.tsumeHint = null;
    } else {
      const popCount = (m.mode === "pvai" && m.historyStack.length >= 2) ? 2 : 1;
      for (let i = 0; i < popCount; i++) snap = m.historyStack.pop();
    }
    m.engine = snap.engine;
    m.logMessages.length = snap.logLen;
    m.kifuRecords.length = snap.kifuLen;
    if (m.onlineActions) m.onlineActions.length = snap.onlineLen;
    m.selected = null;
    m.lastAction = null;
    updateGameUI();
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
    return true;
  }

  function updateGameUI() {
    const m = App.match;
    const dom = App.gameDom;
    if (!m || !dom) return;
    const engine = m.engine;

    dom.modeText.textContent = modeLabelText() + (m.ruleTemplate ? " / 特化テンプレート" : "") + ` / 接触制限 ${engine.config.contactLimit}`;
    dom.restartBtn.disabled = false;
    dom.undoBtn.disabled = m.aiThinking || !m.historyStack.length || !!m.tsumeReplay;
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
    const csv = "﻿" + matchRecordToCsv(record);
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), kifuCsvFileName(record));
  }
  // 複数の棋譜CSVを1つのZIPにまとめてダウンロードする。ブラウザは連続ダウンロードを
  // ブロックしがちなので、1件ずつではなく1ファイルに固める(1件だけならCSVそのまま)。
  function downloadKifuCsvBundle(records) {
    if (!records.length) return;
    if (records.length === 1) { downloadKifuCsv(records[0]); return; }
    const enc = new TextEncoder();
    const files = records.map((rec) => ({ name: kifuCsvFileName(rec), data: enc.encode("﻿" + matchRecordToCsv(rec)) }));
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    downloadBlob(buildZip(files, d), `kifu_${records.length}games_${stamp}.zip`);
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
  function renderTutorial(root) {
    let page = 0;
    const screen = el("div", { class: "screen" });
    screen.appendChild(el("h1", { class: "card-title", text: "チュートリアル", style: { fontSize: "24px" } }));
    const doc = el("div", { class: "doc" });
    const title = el("h2", {});
    const diagram = el("div", { class: "tutorial-diagram" });
    const body = el("div", {});
    doc.appendChild(title); doc.appendChild(diagram); doc.appendChild(body);
    screen.appendChild(doc);
    const nav = el("div", { class: "tutorial-nav" });
    const prevBtn = el("button", { class: "btn", text: "← 前へ" });
    const indicator = el("span", { class: "tutorial-page-indicator" });
    const nextBtn = el("button", { class: "btn", text: "次へ →" });
    nav.appendChild(prevBtn); nav.appendChild(indicator); nav.appendChild(nextBtn);
    screen.appendChild(nav);
    root.appendChild(screen);

    function renderPage() {
      const p = C.TUTORIAL_PAGES[page];
      title.textContent = p.title;
      clearNode(body);
      p.body.forEach((line) => body.appendChild(el("p", { text: line || " " })));
      clearNode(diagram);
      if (p.grid) diagram.appendChild(renderMiniGrid(p.grid));
      else if (p.flow) diagram.appendChild(renderFlowDiagram(p.flow));
      indicator.textContent = `${page + 1} / ${C.TUTORIAL_PAGES.length}`;
      prevBtn.disabled = page === 0;
      nextBtn.disabled = page === C.TUTORIAL_PAGES.length - 1;
    }
    prevBtn.addEventListener("click", () => { if (page > 0) { page--; renderPage(); } });
    nextBtn.addEventListener("click", () => { if (page < C.TUTORIAL_PAGES.length - 1) { page++; renderPage(); } });
    renderPage();
  }

  function renderMiniGrid(spec) {
    const cells = spec.cells;
    const rows = cells.length, cols = cells[0].length;
    const cellPx = 46;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", cols * cellPx);
    svg.setAttribute("height", rows * cellPx);
    svg.setAttribute("viewBox", `0 0 ${cols * cellPx} ${rows * cellPx}`);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const val = cells[r][c];
        const x0 = c * cellPx, y0 = r * cellPx;
        if (val === "W") {
          svg.appendChild(svgRect(x0 + 1, y0 + 1, cellPx - 2, cellPx - 2, "var(--surface-raised)", "var(--border-bright)"));
          svg.appendChild(svgText(x0 + cellPx / 2, y0 + cellPx / 2, "壁", "var(--text-muted)", 12));
          continue;
        }
        const bg = (r + c) % 2 === 0 ? "var(--board-bg)" : "var(--board-bg-alt)";
        svg.appendChild(svgRect(x0 + 1, y0 + 1, cellPx - 2, cellPx - 2, bg, "var(--board-line)"));
        if (val === "H" || val === "A") {
          const player = val === "H" ? "A" : "B";
          const colors = C.PLAYER_COLORS[player];
          const pad = 6;
          svg.appendChild(svgCircle(x0 + cellPx / 2, y0 + cellPx / 2, cellPx / 2 - pad, colors.fill));
          svg.appendChild(svgText(x0 + cellPx / 2, y0 + cellPx / 2, val, colors.on, 15, true));
        } else if (val === "X") {
          const m = 12;
          svg.appendChild(svgLine(x0 + m, y0 + m, x0 + cellPx - m, y0 + cellPx - m, "var(--danger)"));
          svg.appendChild(svgLine(x0 + m, y0 + cellPx - m, x0 + cellPx - m, y0 + m, "var(--danger)"));
        }
        const hl = spec.highlights && spec.highlights[r + "," + c];
        if (hl) {
          const rect = svgRect(x0 + 2, y0 + 2, cellPx - 4, cellPx - 4, "none", hl === "danger" ? "var(--danger)" : "var(--accent)");
          rect.setAttribute("stroke-width", "2.5");
          svg.appendChild(rect);
        }
      }
    }
    return svg;
  }
  function svgRect(x, y, w, h, fill, stroke) {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", x); r.setAttribute("y", y); r.setAttribute("width", w); r.setAttribute("height", h);
    r.setAttribute("fill", fill); if (stroke) r.setAttribute("stroke", stroke);
    return r;
  }
  function svgCircle(cx, cy, rad, fill) {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", rad); c.setAttribute("fill", fill);
    return c;
  }
  function svgText(x, y, text, fill, size, bold) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", x); t.setAttribute("y", y + size * 0.35); t.setAttribute("text-anchor", "middle");
    t.setAttribute("fill", fill); t.setAttribute("font-size", size);
    if (bold) t.setAttribute("font-weight", "700");
    t.textContent = text;
    return t;
  }
  function svgLine(x1, y1, x2, y2, stroke) {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1); l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("stroke", stroke); l.setAttribute("stroke-width", "3"); l.setAttribute("stroke-linecap", "round");
    return l;
  }
  function renderFlowDiagram(steps) {
    const wrap = el("div", { style: { display: "flex", flexWrap: "wrap", gap: "10px", justifyContent: "center", alignItems: "center" } });
    steps.forEach((step, i) => {
      wrap.appendChild(el("div", {
        style: {
          background: "var(--surface-alt)", border: "1px solid var(--border)", borderRadius: "6px",
          padding: "10px 12px", fontSize: "12px", color: "var(--text-primary)", width: "130px", textAlign: "center", whiteSpace: "pre-line",
        }, text: step,
      }));
      if (i < steps.length - 1) wrap.appendChild(el("span", { style: { color: "var(--text-muted)" }, text: "→" }));
    });
    return wrap;
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

  // ============================================================ 対戦履歴
  function renderHistory(root) {
    const screen = el("div", { class: "screen" });
    screen.appendChild(el("h1", { class: "card-title", text: "対戦履歴", style: { fontSize: "24px" } }));
    screen.appendChild(el("div", { class: "field-hint", text: "この端末のブラウザに保存されている対戦記録です(他の端末とは共有されません)。" }));
    const card = el("div", { class: "card", style: { width: "min(640px,100%)" } });
    const list = el("ul", { class: "history-list" });
    const records = loadHistory().slice().reverse();
    if (!records.length) {
      card.appendChild(el("div", { class: "history-empty", text: "まだ対戦記録がありません。対戦を1局終えると、ここに表示されます。" }));
    } else {
      // まとめてダウンロード用の選択状態(画面を開き直すとリセット)
      const selected = new Set();
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
            el("div", { class: "history-sub", text: `${rec.timestamp}  ${rec.rows}x${rec.cols} / ${cl}` }),
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
    App.reviewRecord = record;
    App.screen = "review";
    render();
  }

  function rebuildFramesFromRecord(record) {
    const config = makeConfig({
      rows: record.rows, cols: record.cols, moveRange: record.moveRange,
      wallSandwich: record.wallSandwich, contactLimit: record.contactLimit,
    });
    const engine = new GameEngine(config);
    engine.stock.A = record.stockA;
    engine.stock.B = record.stockB;
    function snapshot(desc, lastAction) {
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
        engineClone: engine.clone(), // 「この局面から対局を再開する」機能のために保持しておく
      };
    }
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
  function openResumeSetup(frame) {
    const veil = el("div", { class: "veil" });
    const engine0 = frame.engineClone;
    const sideSelect = el("select", { class: "field-select" }, [
      el("option", { value: "A", text: "先手(A)" }),
      el("option", { value: "B", text: "後手(B)" }),
    ]);
    sideSelect.value = engine0.currentPlayer;
    const levelSelect = el("select", { class: "field-select" });
    for (let i = 1; i <= 7; i++) levelSelect.appendChild(el("option", { value: String(i), text: AI.LEVELS[i].name }));
    levelSelect.value = "5";
    const modal = el("div", { class: "modal" }, [
      el("p", { text: "この局面から、実際に対局を再開します。どちらのプレイヤーを担当しますか?" }),
      el("div", { class: "field-row" }, [el("div", { class: "field-label", text: "担当する側" }), sideSelect]),
      el("div", { class: "field-row" }, [el("div", { class: "field-label", text: "相手AIの強さ" }), levelSelect]),
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn", text: "キャンセル", onclick: () => veil.remove() }),
        el("button", { class: "btn btn-primary", text: "再開する", style: { width: "auto", fontSize: "14px", padding: "10px 16px" }, onclick: () => {
          veil.remove();
          resumeMatchFromEngine(engine0.clone(), sideSelect.value, parseInt(levelSelect.value, 10));
        } }),
      ]),
    ]);
    veil.appendChild(modal);
    document.body.appendChild(veil);
  }

  function resumeMatchFromEngine(engine, humanPlayer, aiLevel) {
    App.match = {
      mode: "pvai",
      boardSize: engine.config.rows, moveRange: engine.config.moveRange, contactLimit: engine.config.contactLimit,
      aiLevel, aiLevelB: null, aiSpecialist: false, aiSpecialistB: false,
      stockA: engine.stock.A, stockB: engine.stock.B,
      ruleTemplate: null,
      engine,
      humanPlayer,
      selected: null,
      lastAction: null,
      logMessages: [`(感想戦から再開: ここまでの手は対戦ログに含まれません)`],
      kifuRecords: [],
      historyStack: [],
      aiThinking: false,
      aiVsAiPaused: false,
      kifuSaved: false,
      pieceNodes: new Map(),
      startedAt: Date.now(),
      onlineActions: [],
    };
    App.screen = "game";
    render();
    maybeTriggerAI();
  }

  function renderReview(root) {
    const record = App.reviewRecord;
    const screen = el("div", { class: "screen" });
    if (!record) { root.appendChild(el("p", { text: "記録が見つかりません。" })); return; }
    const frames = rebuildFramesFromRecord(record);
    let index = frames.length - 1;

    screen.appendChild(el("h1", { class: "card-title", text: "感想戦", style: { fontSize: "24px" } }));
    const cl = record.contactLimit != null ? `接触制限${record.contactLimit}` : "接触制限なし";
    screen.appendChild(el("div", { class: "field-hint", text: `${record.modeLabel} / ${record.rows}x${record.cols} / ${cl} - ${record.resultText}` }));

    const boardWrap = el("div", { class: "board-wrap" });
    const size = record.rows;
    const { boardFrame, cellNodes, piecesLayer } = buildBoardShell(size, {});
    boardWrap.appendChild(boardFrame);
    screen.appendChild(boardWrap);

    const desc = el("div", { class: "review-desc" });
    screen.appendChild(desc);
    const toolbar = el("div", { class: "review-toolbar" });
    const step = el("span", { class: "review-step" });
    const first = el("button", { class: "btn btn-compact", text: "|<< 最初" });
    const prev = el("button", { class: "btn btn-compact", text: "< 前へ" });
    const next = el("button", { class: "btn btn-compact", text: "次へ >" });
    const last = el("button", { class: "btn btn-compact", text: "最後 >>|" });
    toolbar.appendChild(first); toolbar.appendChild(prev); toolbar.appendChild(step); toolbar.appendChild(next); toolbar.appendChild(last);
    screen.appendChild(toolbar);

    const resumeBtn = el("button", { class: "btn btn-compact", text: "この局面から対局を再開する", onclick: () => openResumeSetup(frames[index]) });
    screen.appendChild(resumeBtn);

    const list = el("ul", { class: "review-list" });
    list.appendChild(el("li", { text: "0: (対局開始)", onclick: () => { index = 0; renderFrame(); } }));
    record.moves.forEach((mv, i) => {
      let line = `${mv.turn}: ${mv.player} ${mv.action}(${mv.to})`;
      if (mv.sandwiched && mv.sandwiched.length) line += ` [${mv.sandwiched.join(",")}]`;
      if (mv.selfSandwiched) line += " [自分挟み]";
      list.appendChild(el("li", { text: line, onclick: () => { index = i + 1; renderFrame(); } }));
    });
    screen.appendChild(list);
    screen.appendChild(el("button", { class: "btn", text: "← メニューに戻る", onclick: () => goto("menu"), style: { marginTop: "6px" } }));
    root.appendChild(screen);

    function renderFrame() {
      index = Math.max(0, Math.min(frames.length - 1, index));
      const frame = frames[index];
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
      desc.textContent = frame.desc;
      step.textContent = `${index} / ${frames.length - 1} 手`;
      first.disabled = prev.disabled = index === 0;
      next.disabled = last.disabled = index === frames.length - 1;
      resumeBtn.disabled = !!(frame.winner || frame.isDraw);
      Array.from(list.children).forEach((li, i) => li.classList.toggle("is-current", i === index));
    }
    first.addEventListener("click", () => { index = 0; renderFrame(); });
    prev.addEventListener("click", () => { index--; renderFrame(); });
    next.addEventListener("click", () => { index++; renderFrame(); });
    last.addEventListener("click", () => { index = frames.length - 1; renderFrame(); });
    renderFrame();
  }

  // ============================================================ オンライン(手番リンク方式)
  // onlineActions の要素は {kind:"place", to:[r,c]} または {kind:"move", from:[r,c], to:[r,c]}。
  function encodeMatchCode(config, stockA, stockB, onlineActions) {
    const payload = {
      r: config.rows, mr: config.moveRange, cl: config.contactLimit,
      sa: stockA, sb: stockB,
      mv: onlineActions.map((a) => (a.kind === "place" ? ["p", posLabel(a.to)] : ["m", posLabel(a.from), posLabel(a.to)])),
    };
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

    const createBtn = el("button", { class: "btn btn-primary", text: "対局を作ってリンクを発行", style: { marginTop: "14px" } });
    card.appendChild(createBtn);
    screen.appendChild(card);
    root.appendChild(screen);

    createBtn.addEventListener("click", () => {
      const config = { rows: parseInt(sizeSelect.value, 10), cols: parseInt(sizeSelect.value, 10), moveRange: parseInt(rangeSelect.value, 10), contactLimit: parseInt(contactSelect.value, 10) };
      const stock = parseInt(stockInput.value, 10) || defaultStockForSize(config.rows);
      const code = encodeMatchCode(config, stock, stock, []);
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
    };
    App.screen = "game";
    render();
    injectOnlineShareUI();
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
      const code = encodeMatchCode(m.engine.config, m.stockA, m.stockB, m.onlineActions);
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
  App.screen = /^#online=/.test(location.hash) ? "online" : "menu";
  render();
  window.addEventListener("hashchange", () => {
    if (/^#online=/.test(location.hash) && App.screen !== "game") { App.screen = "online"; render(); }
  });
})();
