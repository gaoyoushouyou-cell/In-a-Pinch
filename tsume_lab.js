// -*- coding: utf-8 -*-
/*!
 * tsume_lab.js — 「詰めピンチ」パズルの発掘・検証ツール(開発用、サイトには含まれない)
 *
 * 使い方:
 *   node tsume_lab.js <棋譜CSVのパス>
 *
 * 手順:
 *   1. 指定した棋譜(In_a_Pinch_app_5.py / このアプリの「棋譜をダウンロード」で
 *      得られるCSV形式)をエンジンで最初から再生する。
 *   2. 後半の「後手(B)の手番」になる各局面をチェックポイントとして記録する。
 *   3. 各チェックポイントについて、AND/OR探索(ai.js の proveForcedWin)で
 *      「後手が正しく指せば必ず勝てる」ことを浅い手数から順に証明を試みる
 *      (証明できない場合、それはまだ相手に逃げ道がある可能性を意味する。
 *      「証明できなかった」は「強制勝ちではない」の証明ではないことに注意)。
 *   4. 証明できた局面を手数の昇順に並べ、レベル別の詰めピンチ候補として出力する。
 *
 * 証明にかかる計算量は探索の深さ2手ごとにおよそ100〜300倍に増えるため、
 * ノード数の予算(NODE_BUDGET)を超えたら深追いせずに次の深さへ諦める。
 * 出力された候補は content.js の TSUME_PUZZLES にそのまま転記できる形にしてある。
 */
const fs = require("fs");
const path = require("path");
const H = require("./engine.js");
const AI = require("./ai.js");

const NODE_BUDGET = 200000;
const DEPTHS_TO_TRY = [1, 3, 5, 7];

function parseKifuCsv(text) {
  text = text.replace(/^﻿/, ""); // Excel向けにBOM付きUTF-8で保存されているため
  const lines = text.split(/\r?\n/);
  let boardSize = 7, moveRange = 3, contactLimit = 3;
  const moves = [];
  for (const line of lines) {
    if (line.startsWith("# 盤面:")) {
      const mSize = line.match(/(\d+)x(\d+)/);
      const mRange = line.match(/移動範囲:\s*(\d+)/);
      const mContact = line.match(/接触制限:\s*(\d+)/);
      if (mSize) boardSize = parseInt(mSize[1], 10);
      if (mRange) moveRange = parseInt(mRange[1], 10);
      if (mContact) contactLimit = parseInt(mContact[1], 10);
      continue;
    }
    if (line.startsWith("#") || line.startsWith("turn,") || !line.trim()) continue;
    const cols = line.split(",");
    const [turn, player, action, from, to] = cols;
    moves.push({ turn: parseInt(turn, 10), player, action, from: from || null, to });
  }
  return { boardSize, moveRange, contactLimit, moves };
}

function playerOf(name) { return name === "プレイヤー1" || name === "A" ? "A" : "B"; }

function replay(kifu, stockPerSide) {
  const cfg = H.makeConfig({
    rows: kifu.boardSize, cols: kifu.boardSize, moveRange: kifu.moveRange,
    wallSandwich: true, contactLimit: kifu.contactLimit,
  });
  const e = new H.GameEngine(cfg);
  e.stock.A = stockPerSide; e.stock.B = stockPerSide;
  const snapshots = {};
  for (const mv of kifu.moves) {
    const pl = playerOf(mv.player);
    if (e.isOver()) break;
    if (e.currentPlayer !== pl) { console.error(`!! turn ${mv.turn}: mover mismatch`); break; }
    try {
      if (mv.action === "配置" || mv.action === "place") {
        e.placePiece(pl, H.posFromLabel(mv.to));
      } else {
        const from = H.posFromLabel(mv.from);
        const piece = e.pieceAt(from);
        if (!piece) break;
        e.movePiece(pl, piece.id, H.posFromLabel(mv.to));
      }
    } catch (err) { console.error(`!! turn ${mv.turn} failed: ${err.message}`); break; }
    if (pl === "A" && e.currentPlayer === "B" && !e.isOver()) snapshots[mv.turn] = e.clone();
  }
  return { finalEngine: e, snapshots };
}

function proveForcedWin(engine, solver, maxDepth, cache, budget) {
  budget.n++;
  if (budget.n > budget.limit) throw new Error("budget");
  const stateKey = engine._stateKey() + "|" + maxDepth;
  if (cache.has(stateKey)) return cache.get(stateKey);
  if (engine.winner === solver) { const r = { forced: true, plies: 0 }; cache.set(stateKey, r); return r; }
  const opponent = solver === "A" ? "B" : "A";
  if (engine.winner === opponent || engine.isDraw) { const r = { forced: false, plies: null }; cache.set(stateKey, r); return r; }
  if (maxDepth <= 0) { const r = { forced: false, plies: null }; cache.set(stateKey, r); return r; }
  const current = engine.currentPlayer;
  const actions = AI.generateActions(engine, current);
  if (!actions.length) { const r = { forced: false, plies: null }; cache.set(stateKey, r); return r; }
  if (current === solver) {
    let best = null;
    for (const action of actions) {
      const child = engine.clone();
      AI.applyAction(child, current, action);
      const r = proveForcedWin(child, solver, maxDepth - 1, cache, budget);
      if (r.forced && (best === null || r.plies + 1 < best.plies)) best = { forced: true, plies: r.plies + 1 };
    }
    const r = best || { forced: false, plies: null };
    cache.set(stateKey, r);
    return r;
  }
  let worst = 0;
  for (const action of actions) {
    const child = engine.clone();
    AI.applyAction(child, current, action);
    const r = proveForcedWin(child, solver, maxDepth - 1, cache, budget);
    if (!r.forced) { const out = { forced: false, plies: null }; cache.set(stateKey, out); return out; }
    if (r.plies > worst) worst = r.plies;
  }
  const r = { forced: true, plies: worst + 1 };
  cache.set(stateKey, r);
  return r;
}

function serializeEngine(engine) {
  return {
    rows: engine.config.rows, cols: engine.config.cols, moveRange: engine.config.moveRange,
    contactLimit: engine.config.contactLimit, wallSandwich: engine.config.wallSandwich,
    stockA: engine.stock.A, stockB: engine.stock.B, currentPlayer: engine.currentPlayer,
    pieces: Array.from(engine.pieces.values()).map((p) => [p.player, p.position[0], p.position[1]]),
  };
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) { console.error("usage: node tsume_lab.js <kifu.csv> [stockPerSide]"); process.exit(1); }
  const stockPerSide = parseInt(process.argv[3] || "15", 10);
  const text = fs.readFileSync(csvPath, "utf8");
  const kifu = parseKifuCsv(text);
  const { finalEngine, snapshots } = replay(kifu, stockPerSide);
  console.log(`replay finished: winner=${finalEngine.winner} draw=${finalEngine.isDraw} checkpoints=${Object.keys(snapshots).length}`);

  const found = [];
  for (const turn of Object.keys(snapshots).map(Number).sort((a, b) => a - b)) {
    const base = snapshots[turn];
    let result = null;
    for (const depth of DEPTHS_TO_TRY) {
      const cache = new Map();
      const budget = { n: 0, limit: NODE_BUDGET };
      try {
        const r = proveForcedWin(base.clone(), "B", depth, cache, budget);
        if (r.forced) { result = { turn, plies: r.plies, depth, nodes: budget.n }; break; }
      } catch (e) { break; }
    }
    if (result) {
      console.log(`turn ${turn}: FORCED WIN in ${result.plies} plies (nodes=${result.nodes})`);
      found.push({ turn, plies: result.plies, position: serializeEngine(base) });
    }
  }

  found.sort((a, b) => a.plies - b.plies);
  const puzzles = found.map((f, i) => ({
    id: `${path.basename(csvPath, ".csv")}-${f.turn}`,
    level: i + 1, plies: f.plies,
    title: `詰めピンチ Lv.${i + 1}(${f.plies}手)`,
    hint: "",
    position: f.position,
  }));
  const outPath = "tsume_candidates.json";
  fs.writeFileSync(outPath, JSON.stringify(puzzles, null, 1));
  console.log(`\n${puzzles.length} 件の候補を ${outPath} に書き出しました。内容を見て content.js の TSUME_PUZZLES に転記してください。`);
}

main();
