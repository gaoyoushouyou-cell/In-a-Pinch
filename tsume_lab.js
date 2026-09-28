// -*- coding: utf-8 -*-
/*!
 * tsume_lab.js — 「詰めピンチ」問題の発掘・選別ツール(開発用、サイトには含まれない)
 *
 * 開発手法(3段階):
 *   1. 発掘 (mine)   … 実戦の棋譜と、学習型AI同士の速い自己対戦の全局面を
 *                        tsume.js のソルバーで調べ、詰みを証明できた局面を候補として集める。
 *                        「挟む手だけで詰む」本格詰めピンチ(最大15手)と、
 *                        「1回だけ挟まない手が要る」詰めろ問題(最大7手)の2種類。
 *   2. 選別 (build)  … 唯一解(最終手以外の攻め手がすべて1通り)を満たす候補だけを残し、
 *                        不要駒を取り除いて(自己対戦由来のみ。実戦由来は局面をそのまま残す)
 *                        対称形の重複を除き、手数・難易度・テーマが散らばるように選ぶ。
 *   3. 検証          … 書き出した tsume-data.js は test_node.js が全問、
 *                        手数・唯一解・主手順の合法性を独立に再検証する。
 *
 * 使い方:
 *   node tsume_lab.js mine-kifu  <棋譜フォルダ> <出力.jsonl>
 *   node tsume_lab.js mine-self  <設定名> <seed> <対局数> <出力.jsonl>
 *        設定名: t7(7×7・移動3・接触3、テンプレート) / s5(5×5) / r1(7×7・移動1・接触4) / b9(9×9)
 *   node tsume_lab.js build      <入力.jsonl ...>        → tsume-data.js を書き出す
 */
const fs = require("fs");
const path = require("path");
const H = require("./engine.js");
const AI = require("./ai.js");
const T = require("./tsume.js");

const CONFIGS = {
  t7: { rows: 7, cols: 7, moveRange: 3, contactLimit: 3, wallSandwich: true, stock: 15 },
  s5: { rows: 5, cols: 5, moveRange: 3, contactLimit: 3, wallSandwich: true, stock: 8 },
  r1: { rows: 7, cols: 7, moveRange: 1, contactLimit: 4, wallSandwich: true, stock: 13 },
  b9: { rows: 9, cols: 9, moveRange: 3, contactLimit: 3, wallSandwich: true, stock: 21 },
};
const MAX_PAR = 15;       // 挟む手だけの詰めピンチの最大手数
const MAX_PAR_QUIET = 7;  // 詰めろ問題の最大手数
const NODE_LIMIT = 150000;
const MAX_BOARD = 9;      // スマホで遊べる大きさまで

// ---------------------------------------------------------------- 発掘
function examine(engine, source) {
  if (engine.isOver()) return null;
  const solver = engine.currentPlayer;
  const base = { source, position: T.positionFromEngine(engine) };
  const a0 = T.analyze(engine, solver, MAX_PAR, { nodeLimit: NODE_LIMIT });
  if (a0) return Object.assign(base, { quiet: 0 }, pick(a0));
  const a1 = T.analyze(engine, solver, MAX_PAR_QUIET, { quiet: 1, nodeLimit: NODE_LIMIT });
  if (a1 && a1.quietUsed) return Object.assign(base, { quiet: 1 }, pick(a1));
  return null;
}
function pick(a) {
  return { par: a.par, line: a.line, unique: a.unique, alternatives: a.alternatives, widths: a.widths,
    rootChecks: a.rootChecks, proofNodes: a.proofNodes };
}

function parseKifuCsv(text) {
  text = text.replace(/^﻿/, "");
  let boardSize = 7, moveRange = 3, contactLimit = null, stockA = null, stockB = null;
  const moves = [];
  for (const line of text.split(/\r?\n/)) {
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
  return { boardSize, moveRange, contactLimit, stockA, stockB, moves };
}

function mineKifu(dir, out) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".csv")).sort();
  const fd = fs.openSync(out, "w");
  let found = 0, positions = 0;
  for (const f of files) {
    const k = parseKifuCsv(fs.readFileSync(path.join(dir, f), "utf8"));
    if (k.boardSize > MAX_BOARD) continue;
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
      } catch (err) { console.error(`${f} turn ${mv.turn}: ${err.message}`); break; }
      positions++;
      const c = examine(e, { kind: "kifu", file: f, ply: mv.turn });
      if (c) { fs.writeSync(fd, JSON.stringify(c) + "\n"); found++; }
    }
    console.log(`${f}: 累計 ${found} 件 / ${positions} 局面`);
  }
  fs.closeSync(fd);
}

function mineSelf(name, seed, games, out) {
  const spec = CONFIGS[name];
  const rng = T.mulberry32(seed);
  const fd = fs.openSync(out, "w");
  let found = 0;
  for (let g = 0; g < games; g++) {
    const cfg = H.makeConfig(Object.assign({}, spec, { stockPerPlayer: spec.stock }));
    const e = new H.GameEngine(cfg);
    const weights = name === "t7" ? AI.LEARNED_WEIGHTS_TEMPLATE : AI.LEARNED_WEIGHTS_GENERIC;
    const ms = 20 + Math.floor(rng() * 60);
    const ais = {
      A: new AI.LearnedSearchAI("A", "lab", ms, weights, Math.floor(rng() * 1e9)),
      B: new AI.LearnedSearchAI("B", "lab", ms, weights, Math.floor(rng() * 1e9)),
    };
    const opening = 2 + Math.floor(rng() * 8);
    for (let ply = 0; ply < 200 && !e.isOver(); ply++) {
      const p = e.currentPlayer;
      const acts = AI.generateActions(e, p);
      // 序盤はランダム、以降もたまに悪手を混ぜて局面の幅を広げる
      const action = ply < opening || rng() < 0.05 ? acts[Math.floor(rng() * acts.length)] : ais[p].chooseAction(e);
      AI.applyAction(e, p, action);
      if (ply < 6) continue;
      const c = examine(e, { kind: "self", config: name, seed, game: g, ply: ply + 1 });
      if (c) { fs.writeSync(fd, JSON.stringify(c) + "\n"); found++; }
    }
    if (g % 10 === 9) console.log(`${name} seed${seed}: ${g + 1}局 / 候補 ${found} 件`);
  }
  fs.closeSync(fd);
}

// ---------------------------------------------------------------- 選別
// 各カテゴリの定員。[キー, 条件, 定員]
const CATEGORIES = [
  { key: "p1", title: "1手詰め", sub: "入門", test: (c) => !c.quiet && c.par === 1, quota: 10 },
  { key: "p3", title: "3手詰め", sub: "初級", test: (c) => !c.quiet && c.par === 3, quota: 12 },
  { key: "p5", title: "5手詰め", sub: "中級", test: (c) => !c.quiet && c.par === 5, quota: 12 },
  { key: "p7", title: "7手詰め", sub: "上級", test: (c) => !c.quiet && c.par === 7, quota: 10 },
  { key: "p9", title: "9〜11手詰め", sub: "難問", test: (c) => !c.quiet && (c.par === 9 || c.par === 11), quota: 10 },
  { key: "p13", title: "13手以上", sub: "超難問", test: (c) => !c.quiet && c.par >= 13, quota: 6 },
  { key: "q", title: "詰めろ問題", sub: "1回だけ挟まない手", test: (c) => c.quiet === 1 && c.par >= 3, quota: 10 },
];

// 難しさの目安: 読むべき局面の多さ(証明に要したノード数)と、主手順の各局面での候補の多さ
function difficulty(c) {
  const w = c.widths || [];
  let branch = 0;
  for (let i = 0; i < w.length; i++) branch += Math.log2(1 + w[i]);
  return Math.log2(1 + c.proofNodes) + branch;
}

function build(inputs) {
  const all = [];
  for (const f of inputs) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) if (line.trim()) all.push(JSON.parse(line));
  }
  console.log(`候補 ${all.length} 件を読み込みました`);
  const seen = new Set();
  const chosen = [];
  const stats = {};
  for (const cat of CATEGORIES) {
    let pool = all.filter((c) => cat.test(c) && c.position.rows <= MAX_BOARD)
      .filter((c) => (c.par < 3 || c.unique) && (c.quiet || c.rootChecks >= 2));
    stats[cat.key] = { raw: all.filter(cat.test).length, valid: pool.length };
    // 実戦由来を優先し、そのあと難しい順。ただし同じ対局からは1カテゴリ1問まで
    pool.sort((a, b) => (b.source.kind === "kifu") - (a.source.kind === "kifu") || difficulty(b) - difficulty(a));
    const perGame = new Set();
    const perConfig = {};
    const picked = [];
    for (const c of pool) {
      if (picked.length >= cat.quota) break;
      const gameKey = c.source.kind === "kifu" ? c.source.file : `${c.source.config}/${c.source.seed}/${c.source.game}`;
      if (perGame.has(gameKey)) continue;
      const cfgKey = `${c.position.rows}/${c.position.moveRange}/${c.position.contactLimit}`;
      // 盤の設定が偏らないよう、テンプレート(7/3/3)以外は1カテゴリ3問まで
      if (cfgKey !== "7/3/3" && (perConfig[cfgKey] || 0) >= 3) continue;
      let puzzle;
      const engine = T.engineFromPosition(c.position);
      if (c.source.kind === "kifu") {
        puzzle = { par: c.par, quiet: c.quiet, position: c.position, line: c.line, rootChecks: c.rootChecks,
          widths: c.widths, proofNodes: c.proofNodes, removed: 0,
          tags: T.themeTags(engine, c.position.currentPlayer, c.line) };
      } else {
        const info = T.analyze(engine, c.position.currentPlayer, c.par, { quiet: c.quiet, nodeLimit: NODE_LIMIT * 4 });
        if (!info) continue;
        const m = T.minimize(engine, c.position.currentPlayer, info, { quiet: c.quiet, nodeLimit: NODE_LIMIT });
        puzzle = { par: m.info.par, quiet: c.quiet, position: T.positionFromEngine(m.engine), line: m.info.line,
          rootChecks: m.info.rootChecks, widths: m.info.widths, proofNodes: m.info.proofNodes,
          removed: engine.pieces.size - m.engine.pieces.size,
          tags: T.themeTags(m.engine, c.position.currentPlayer, m.info.line) };
      }
      const key = T.canonicalKey(puzzle.position);
      if (seen.has(key)) continue;
      seen.add(key);
      perGame.add(gameKey);
      perConfig[cfgKey] = (perConfig[cfgKey] || 0) + 1;
      puzzle.source = c.source;
      puzzle.category = cat.key;
      puzzle.difficulty = Math.round(difficulty(puzzle) * 10) / 10;
      picked.push(puzzle);
    }
    // カテゴリ内はやさしい順に並べる
    picked.sort((a, b) => a.par - b.par || a.difficulty - b.difficulty);
    stats[cat.key].picked = picked.length;
    chosen.push(...picked);
  }
  chosen.forEach((p, i) => { p.no = i + 1; p.id = `tp${String(i + 1).padStart(3, "0")}`; });
  writeData(chosen);
  console.log(JSON.stringify(stats));
  const tagCount = {};
  for (const p of chosen) for (const t of p.tags) tagCount[t] = (tagCount[t] || 0) + 1;
  console.log("テーマ:", JSON.stringify(tagCount));
  console.log(`${chosen.length} 問を tsume-data.js に書き出しました`);
}

function writeData(puzzles) {
  const cats = CATEGORIES.map(({ key, title, sub }) => ({ key, title, sub }));
  const lines = [];
  lines.push("/*!");
  lines.push(" * tsume-data.js — 詰めピンチの問題集(tsume_lab.js build が自動生成。手で編集しないこと)");
  lines.push(" *");
  lines.push(" * 各問は tsume.js のソルバーで「最短手数(par)・唯一解・主手順」を証明済み。");
  lines.push(" * position.pieces の4番目の数字は移動義務(重複数)。line は主手順");
  lines.push(" * (攻めは最短、受けは最長抵抗)。source は出典(kifu=実戦の棋譜 / self=AI同士の自己対戦)。");
  lines.push(" */");
  lines.push("(function (global) {");
  lines.push("  \"use strict\";");
  lines.push("  const CATEGORIES = " + JSON.stringify(cats) + ";");
  lines.push("  const PUZZLES = [");
  for (const p of puzzles) {
    const o = { id: p.id, no: p.no, category: p.category, par: p.par, quiet: p.quiet, tags: p.tags,
      rootChecks: p.rootChecks, difficulty: p.difficulty, removed: p.removed, source: p.source,
      line: p.line, position: p.position };
    lines.push("    " + JSON.stringify(o) + ",");
  }
  lines.push("  ];");
  lines.push("  const TsumeData = { CATEGORIES, PUZZLES };");
  lines.push("  if (typeof module !== \"undefined\" && module.exports) module.exports = TsumeData;");
  lines.push("  else global.HasamiTsumeData = TsumeData;");
  lines.push("})(typeof self !== \"undefined\" ? self : this);");
  fs.writeFileSync(path.join(__dirname, "tsume-data.js"), lines.join("\r\n") + "\r\n");
}

// ---------------------------------------------------------------- main
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "mine-kifu") mineKifu(args[0], args[1]);
else if (cmd === "mine-self") mineSelf(args[0], parseInt(args[1], 10), parseInt(args[2], 10), args[3]);
else if (cmd === "build") build(args);
else {
  console.error("usage: node tsume_lab.js mine-kifu <dir> <out.jsonl> | mine-self <t7|s5|r1|b9> <seed> <games> <out.jsonl> | build <in.jsonl...>");
  process.exit(1);
}
