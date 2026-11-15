// -*- coding: utf-8 -*-
/*!
 * tsume_lab.js — 「詰めピンチ」問題の発掘・選別ツール(開発用、サイトには含まれない)
 *
 * 2026-11-15 改訂: 問題はすべて「実際の対局に現れた局面そのまま」から採る。
 *   旧版は AI 自己対戦の局面から不要駒を最大22枚取り除いていたため、盤上2〜3枚に持ち駒が
 *   合わない(盤上+持ち駒が初期の持ち駒数にならない)ありえない盤面が多く、さらに
 *   「挟む手だけ」という縛りのせいで、実戦なら挟まない手1つで済むところを遠回りする
 *   必要のない手順(15手かけて詰ますが、静かな手を1回使えば3手で勝てる、など)が混じっていた。
 *
 * 開発手法:
 *   1. 発掘 (mine)   … 棋譜(人どうし・AI戦・AI同士)の全局面を tsume.js のソルバーで調べ、
 *                        詰みを証明できた局面を候補として集める。局面は一切いじらない。
 *   2. 品質の判定    … 候補ごとに次を調べて記録する(quality)。
 *        - 遠回り: 静かな手(挟まない手)を1〜2回許すと、より短く勝てるか。勝てるなら
 *                  「挟む手だけ」の主手順は実戦では必要のない手を含むので不採用。
 *        - 詰め上がり: 最後に動けなくなった駒の四方が何でふさがれているか
 *                  (E=攻め方の駒 / O=受け方自身の駒 / W=盤の端 / C=接触制限で行けない)。
 *                  盤の端に追い込むより、盤の内側で攻め方の駒が取り囲んで詰ますほうを高く評価する
 *                  (芸術点 art)。
 *        - 主手順のまとまり: 主手順で挟まれる受け方の駒の数(少ないほど一つの狙いに集中している)。
 *   3. 選別 (build)  … 唯一解・初手の候補2つ以上・遠回りなしを満たす候補から、芸術点の高い順に、
 *                        同じ対局からは1カテゴリ1問、対称形の重複を除いて選ぶ。
 *   4. 検証          … dev/tsume_lab.html がアプリの AI(奥義)を攻め方に指させて、
 *                        詰めピンチの縛りなしでも最短手数より早くは勝てないことを確かめる。
 *                        test_node.js は全問の手数・唯一解・主手順・持ち駒の数・遠回りなしを再検証する。
 *
 * Node.js があれば:
 *   node tsume_lab.js mine  <出力.jsonl> <棋譜フォルダ ...>
 *   node tsume_lab.js build <入力.jsonl ...>        → tsume-data.js を書き出す
 * Node.js の無いPCでは dev/lab_server.py + dev/tsume_lab.html(Web Worker で並列に回す)。
 */
(function (global) {
  "use strict";
  const isNode = typeof module !== "undefined" && module.exports && typeof require !== "undefined";
  const H = global.Hasami || (isNode ? require("./engine.js") : null);
  const AI = global.HasamiAI || (isNode ? require("./ai.js") : null);
  const T = global.HasamiTsume || (isNode ? require("./tsume.js") : null);

  const MAX_PAR = 15;       // 挟む手だけの詰めピンチの最大手数
  const MAX_PAR_QUIET = 7;  // 詰めろ問題の最大手数
  const NODE_LIMIT = 150000;
  const FASTER_NODE_LIMIT = 300000;
  const MAX_BOARD = 9;      // スマホで遊べる大きさまで
  const MIN_ART = 5;        // 隅に追い込むだけの詰み(芸術点 5 未満)は採らない

  // ---------------------------------------------------------------- 棋譜
  function parseKifuCsv(text) {
    text = text.replace(/^﻿/, "");
    let boardSize = 7, moveRange = 3, contactLimit = null, stockA = null, stockB = null, mode = "";
    const moves = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("# モード:")) { mode = line.slice(6).trim(); continue; }
      if (line.startsWith("# 盤面:")) {
        const mSize = line.match(/(\d+)x(\d+)/);
        const mRange = line.match(/移動範囲:\s*(\d+)/);
        const mContact = line.match(/接触制限:\s*(\d+)/);
        const mStock = line.match(/先手(\d+)\s*後手(\d+)/);
        if (mSize) boardSize = parseInt(mSize[1], 10);
        if (mRange) moveRange = parseInt(mRange[1], 10);
        if (mContact) contactLimit = parseInt(mContact[1], 10);
        if (mStock) { stockA = parseInt(mStock[1], 10); stockB = parseInt(mStock[2], 10); }
        continue;
      }
      if (line.startsWith("#") || line.startsWith("turn,") || !line.trim()) continue;
      const [turn, , action, from, to] = line.split(",");
      moves.push({ turn: parseInt(turn, 10), action, from: from || null, to });
    }
    return { boardSize, moveRange, contactLimit, stockA, stockB, mode, moves };
  }

  // 棋譜の各局面を順に返す(each(engine, ply))。途中で不正な手があればそこで止める
  function replayKifu(k, each) {
    const cfg = H.makeConfig({ rows: k.boardSize, cols: k.boardSize, moveRange: k.moveRange,
      wallSandwich: true, contactLimit: k.contactLimit });
    const e = new H.GameEngine(cfg);
    if (k.stockA != null) { e.stock.A = k.stockA; e.stock.B = k.stockB; }
    for (const mv of k.moves) {
      if (e.isOver()) break;
      const p = e.currentPlayer;
      try {
        if (mv.action === "配置") e.placePiece(p, H.posFromLabel(mv.to));
        else e.movePiece(p, e.pieceAt(H.posFromLabel(mv.from)).id, H.posFromLabel(mv.to));
      } catch (err) { return `turn ${mv.turn}: ${err.message}`; }
      each(e, mv.turn);
    }
    return null;
  }

  // ---------------------------------------------------------------- 品質の判定
  // 詰め上がりの形(finalNet)・芸術点(artScore)・遠回りの判定(fasterWin)は tsume.js にある
  // (アプリの「新作を作る」でも同じ基準を使うため)。
  const finalNet = T.finalNet, artScore = T.artScore;
  const fasterWin = (engine, solver, par, quiet) => T.fasterWin(engine, solver, par, quiet, FASTER_NODE_LIMIT);

  function pick(a) {
    return { par: a.par, line: a.line, unique: a.unique, alternatives: a.alternatives, widths: a.widths,
      rootChecks: a.rootChecks, proofNodes: a.proofNodes };
  }

  // 1局面を調べる。詰みが証明できなければ null
  function examine(engine, source) {
    if (engine.isOver()) return null;
    const solver = engine.currentPlayer;
    const base = { source, position: T.positionFromEngine(engine) };
    let c = null;
    const a0 = T.analyze(engine, solver, MAX_PAR, { nodeLimit: NODE_LIMIT });
    if (a0) c = Object.assign(base, { quiet: 0 }, pick(a0));
    else {
      const a1 = T.analyze(engine, solver, MAX_PAR_QUIET, { quiet: 1, nodeLimit: NODE_LIMIT });
      if (a1 && a1.quietUsed) c = Object.assign(base, { quiet: 1 }, pick(a1));
    }
    if (!c) return null;
    const net = finalNet(c.position, c.line);
    const fw = (c.par < 3 || !c.unique) ? { faster: null, unknown: false } : fasterWin(engine, solver, c.par, c.quiet);
    c.quality = { net, art: artScore(net), faster: fw.faster, fasterLine: fw.line || null, fasterUnknown: fw.unknown };
    return c;
  }

  // 棋譜1局を調べる。onCandidate(c) に候補を渡す。戻り値: { positions, error }
  function mineKifuText(text, file, onCandidate) {
    const k = parseKifuCsv(text);
    if (k.boardSize > MAX_BOARD) return { positions: 0, error: "board too large" };
    let positions = 0;
    const error = replayKifu(k, (e, ply) => {
      positions++;
      const c = examine(e, { kind: "kifu", file, ply, mode: k.mode, stock: [k.stockA, k.stockB] });
      if (c) onCandidate(c);
    });
    return { positions, error };
  }

  // ---------------------------------------------------------------- 選別
  const CATEGORIES = [
    { key: "p1", title: "1手詰め", sub: "入門", test: (c) => !c.quiet && c.par === 1, quota: 10 },
    { key: "p3", title: "3手詰め", sub: "初級", test: (c) => !c.quiet && c.par === 3, quota: 12 },
    { key: "p5", title: "5手詰め", sub: "中級", test: (c) => !c.quiet && c.par === 5, quota: 12 },
    { key: "p7", title: "7手詰め", sub: "上級", test: (c) => !c.quiet && c.par === 7, quota: 10 },
    { key: "p9", title: "9手以上", sub: "難問", test: (c) => !c.quiet && c.par >= 9, quota: 10 },
    { key: "q", title: "詰めろ問題", sub: "1回だけ挟まない手", test: (c) => c.quiet === 1 && c.par >= 3, quota: 10 },
  ];

  // 難しさの目安: 読むべき局面の多さ(証明に要したノード数)と、主手順の各局面での候補の多さ
  function difficulty(c) {
    const w = c.widths || [];
    let branch = 0;
    for (let i = 0; i < w.length; i++) branch += Math.log2(1 + w[i]);
    return Math.log2(1 + c.proofNodes) + branch;
  }

  // 採用の条件(理由の配列を返す。空なら採用できる)
  function rejectReasons(c) {
    const why = [];
    const q = c.quality || {};
    if (c.position.rows > MAX_BOARD) why.push("board");
    if (c.par >= 3 && !c.unique) why.push("not unique");
    if (!c.quiet && c.rootChecks < 2) why.push("one check");
    if (q.faster != null) why.push("faster with quiet move");
    if (q.fasterUnknown) why.push("faster unknown");
    if (!q.net) why.push("no net");
    else if (q.art < MIN_ART) why.push("corner");
    else if (q.net.targets >= 3) why.push("scattered"); // 3つ以上の駒をあちこち挟む、まとまりのない手順
    return why;
  }

  // 盤上の駒+持ち駒が、その対局の初期の持ち駒数と一致するか(局面をいじっていない証拠)
  function stockConsistent(position, initial) {
    if (!initial || initial[0] == null) return true;
    let a = 0, b = 0;
    for (const p of position.pieces) (p[0] === "A" ? a++ : b++);
    return a + position.stockA === initial[0] && b + position.stockB === initial[1];
  }

  function gameKeyOf(c) {
    return c.source.kind === "kifu" ? c.source.file : `${c.source.config}/${c.source.seed}/${c.source.game}`;
  }

  // 候補の山から問題集を選ぶ。verified: id → AI検証の結果(任意。faster な問題は除く)
  function build(all, opts) {
    opts = opts || {};
    const exclude = opts.exclude || new Set(); // canonicalKey の除外(AI 検証で遠回りが見つかった問題)
    const seen = new Set();
    const chosen = [];
    const stats = {};
    for (const cat of CATEGORIES) {
      const pool = all.filter((c) => cat.test(c) && !rejectReasons(c).length && stockConsistent(c.position, c.source.stock));
      stats[cat.key] = { raw: all.filter(cat.test).length, valid: pool.length };
      // 盤の内側で取り囲む詰み(包囲詰め)を最優先。その中では人の実戦(棋譜)由来を先に、
      // 芸術点の高い順、主手順が一つの駒に集中しているもの、難しい順
      const surround = (c) => (c.quality.art >= T.ART_SURROUND ? 1 : 0);
      const human = (c) => (c.source.kind === "kifu" ? 1 : 0);
      pool.sort((a, b) => surround(b) - surround(a) || human(b) - human(a)
        || b.quality.art - a.quality.art
        || a.quality.net.targets - b.quality.net.targets
        || difficulty(b) - difficulty(a));
      const perGame = new Set();
      const perConfig = {};
      const picked = [];
      for (const c of pool) {
        if (picked.length >= cat.quota) break;
        const gk = gameKeyOf(c);
        if (perGame.has(gk)) continue;
        const cfgKey = `${c.position.rows}/${c.position.moveRange}/${c.position.contactLimit}`;
        if (cfgKey !== "7/3/3" && (perConfig[cfgKey] || 0) >= 3) continue;
        const key = T.canonicalKey(c.position);
        if (seen.has(key) || exclude.has(key)) continue;
        const engine = T.engineFromPosition(c.position);
        const tags = T.themeTags(engine, c.position.currentPlayer, c.line);
        const puzzle = { par: c.par, quiet: c.quiet, position: c.position, line: c.line, rootChecks: c.rootChecks,
          widths: c.widths, proofNodes: c.proofNodes, removed: 0, tags, source: c.source, category: cat.key,
          art: c.quality.art, net: c.quality.net.pieces.map((p) => p.sides).join("/") };
        puzzle.difficulty = Math.round(difficulty(puzzle) * 10) / 10;
        seen.add(key);
        perGame.add(gk);
        perConfig[cfgKey] = (perConfig[cfgKey] || 0) + 1;
        picked.push(puzzle);
      }
      // カテゴリ内はやさしい順に並べる
      picked.sort((a, b) => a.par - b.par || a.difficulty - b.difficulty);
      stats[cat.key].picked = picked.length;
      chosen.push(...picked);
    }
    chosen.forEach((p, i) => { p.no = i + 1; p.id = `tp${String(i + 1).padStart(3, "0")}`; });
    return { puzzles: chosen, stats };
  }

  function dataFileText(puzzles) {
    const cats = CATEGORIES.map(({ key, title, sub }) => ({ key, title, sub }));
    const lines = [];
    lines.push("/*!");
    lines.push(" * tsume-data.js — 詰めピンチの問題集(tsume_lab.js build が自動生成。手で編集しないこと)");
    lines.push(" *");
    lines.push(" * 全問、実際の対局(棋譜)に現れた局面をそのまま使っている(駒を取り除いたり足したりしない)。");
    lines.push(" * 各問は tsume.js のソルバーで「最短手数(par)・唯一解・主手順」を証明済みで、");
    lines.push(" * 挟まない手を1〜2回許しても par より早くは勝てない(=主手順に必要のない手がない)ことも確かめてある。");
    lines.push(" * position.pieces の4番目の数字は移動義務(重複数)。line は主手順(攻めは最短、受けは最長抵抗)。");
    lines.push(" * art は芸術点(盤の内側で攻め方の駒が取り囲んで詰ますほど高い)、net は詰め上がりで動けない駒の");
    lines.push(" * 上下左右(E=攻め方の駒 / O=受け方の駒 / W=盤の端 / C=接触制限)。");
    lines.push(" */");
    lines.push("(function (global) {");
    lines.push("  \"use strict\";");
    lines.push("  const CATEGORIES = " + JSON.stringify(cats) + ";");
    lines.push("  const PUZZLES = [");
    for (const p of puzzles) {
      const o = { id: p.id, no: p.no, category: p.category, par: p.par, quiet: p.quiet, tags: p.tags,
        rootChecks: p.rootChecks, difficulty: p.difficulty, art: p.art, net: p.net, removed: p.removed,
        source: p.source, line: p.line, position: p.position };
      lines.push("    " + JSON.stringify(o) + ",");
    }
    lines.push("  ];");
    lines.push("  const TsumeData = { CATEGORIES, PUZZLES };");
    lines.push("  if (typeof module !== \"undefined\" && module.exports) module.exports = TsumeData;");
    lines.push("  else global.HasamiTsumeData = TsumeData;");
    lines.push("})(typeof self !== \"undefined\" ? self : this);");
    return lines.join("\r\n") + "\r\n";
  }

  const Lab = { parseKifuCsv, replayKifu, finalNet, artScore, fasterWin, examine, mineKifuText,
    CATEGORIES, difficulty, rejectReasons, stockConsistent, build, dataFileText };

  if (isNode && require.main === module) {
    const fs = require("fs");
    const path = require("path");
    const [cmd, ...args] = process.argv.slice(2);
    if (cmd === "mine") {
      const fd = fs.openSync(args[0], "w");
      let found = 0;
      for (const dir of args.slice(1)) {
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".csv")).sort()) {
          mineKifuText(fs.readFileSync(path.join(dir, f), "utf8"), f, (c) => { fs.writeSync(fd, JSON.stringify(c) + "\n"); found++; });
          console.log(`${f}: 累計 ${found} 件`);
        }
      }
      fs.closeSync(fd);
    } else if (cmd === "build") {
      const all = [];
      for (const f of args) for (const line of fs.readFileSync(f, "utf8").split("\n")) if (line.trim()) all.push(JSON.parse(line));
      const { puzzles, stats } = build(all);
      fs.writeFileSync(path.join(__dirname, "tsume-data.js"), dataFileText(puzzles));
      console.log(JSON.stringify(stats));
      console.log(`${puzzles.length} 問を tsume-data.js に書き出しました`);
    } else {
      console.error("usage: node tsume_lab.js mine <out.jsonl> <kifu dir...> | build <in.jsonl...>");
      process.exit(1);
    }
  }

  if (isNode) module.exports = Lab;
  else global.HasamiTsumeLab = Lab;
})(typeof self !== "undefined" ? self : this);
