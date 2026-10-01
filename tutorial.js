/*!
 * tutorial.js — 操作できるチュートリアルのルール判定(画面を持たない部分)
 *
 * レッスンの局面・課題・相手の決まった手は content.js の TUTORIAL_LESSONS にあり、
 * ここではそれを GameEngine に組み立て、課題の達成判定と「なぜその手が指せないか」の
 * 説明文を作る。画面(app.js の renderTutorial)と自動テスト(test_node.js)の両方から使う。
 * Python 版の同名関数(build_tutorial_engine など)と同じ判定・同じ文言にしている。
 */
(function (global) {
  "use strict";

  const H = (typeof module !== "undefined" && module.exports) ? require("./engine.js") : global.Hasami;
  const { GameEngine, makeConfig, posKey, posLabel, posFromLabel, otherPlayer, DIRECTIONS, AXIS_PAIRS } = H;

  function samePos(a, b) { return a[0] === b[0] && a[1] === b[1]; }

  // board: { size, moveRange, contactLimit, stockA, stockB, rows: [...] }
  function buildEngine(board) {
    const config = makeConfig({
      rows: board.size, cols: board.size, moveRange: board.moveRange,
      contactLimit: board.contactLimit, wallSandwich: true,
    });
    const engine = new GameEngine(config);
    engine.stock.A = board.stockA;
    engine.stock.B = board.stockB;
    board.rows.forEach((line, r) => {
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === ".") continue;
        const player = ch.toLowerCase() === "a" ? "A" : "B";
        const id = engine._nextPieceId++;
        engine.pieces.set(id, { id, player, position: [r, c] });
        engine.board.set(posKey([r, c]), id);
        if (ch !== ch.toLowerCase()) engine.obligated[player].push(id);
      }
    });
    engine.currentPlayer = "A";
    return engine;
  }

  // 挟みの「両端」になっているものの名前(駒ならそのマス、盤外なら「盤の端」)
  function flankName(engine, pos) {
    return engine.inBounds(pos) ? posLabel(pos) : "盤の端";
  }

  // pos に player が置けない理由(置けるなら null)
  function placementBlockReason(engine, player, pos) {
    if (engine.pieceAt(pos)) return null;
    if (engine.obligated[player].length) {
      return "移動義務のある駒(赤い輪)があるあいだは、駒を置けません。先にその駒を動かしましょう。";
    }
    if (engine.stock[player] <= 0) {
      return "持ち駒が残っていないので置けません。盤の上の自分の駒を動かしましょう。";
    }
    const opponent = otherPlayer(player);
    for (const [dr, dc] of DIRECTIONS) {
      const mid = [pos[0] + dr, pos[1] + dc];
      const midPiece = engine.inBounds(mid) ? engine.pieceAt(mid) : null;
      if (!midPiece || midPiece.player !== opponent) continue;
      const far = [pos[0] + dr * 2, pos[1] + dc * 2];
      if (engine._flank(far, player)) {
        return `ここに置くと、相手の${posLabel(mid)}を${flankName(engine, far)}と挟む形になります。`
          + "置いて挟むことはできません(挟めるのは駒を動かしたときだけです)。";
      }
    }
    for (const [[dr1, dc1], [dr2, dc2]] of AXIS_PAIRS) {
      const n1 = [pos[0] + dr1, pos[1] + dc1];
      const n2 = [pos[0] + dr2, pos[1] + dc2];
      const f1 = engine._flank(n1, opponent);
      const f2 = engine._flank(n2, opponent);
      if (!f1 || !f2 || (f1 === "wall" && f2 === "wall")) continue;
      const between = f1 === "wall" || f2 === "wall"
        ? `相手の${posLabel(f1 === "wall" ? n2 : n1)}と盤の端`
        : `相手の${posLabel(n1)}と${posLabel(n2)}`;
      return `ここは${between}の間なので、置いた瞬間に挟まれてしまいます。挟まれる場所には置けません。`;
    }
    if (engine._wouldExceedContactLimit(player, pos, null)) {
      const n = engine._contactGroupSize(player, pos, null);
      return `ここに置くと、上下左右につながった自分の駒が${n}個になり、接触制限(${engine.config.contactLimit}個まで)を超えてしまいます。`;
    }
    return null;
  }

  // piece を dest へ動かせない理由(動かせるなら null)
  function moveBlockReason(engine, piece, dest) {
    const [r0, c0] = piece.position;
    const [r1, c1] = dest;
    if (r0 !== r1 && c0 !== c1) return "駒は上下左右にまっすぐしか動けません(斜めには進めません)。";
    const dist = Math.abs(r1 - r0) + Math.abs(c1 - c0);
    const dr = Math.sign(r1 - r0), dc = Math.sign(c1 - c0);
    for (let s = 1; s < dist; s++) {
      const p = [r0 + dr * s, c0 + dc * s];
      if (engine.pieceAt(p)) return `途中の${posLabel(p)}に駒があるので、飛び越えて進めません。`;
    }
    if (engine.pieceAt(dest)) return null;
    if (dist > engine._maxSteps(piece.position, dr, dc)) {
      const onEdge = r0 === 0 || c0 === 0 || r0 === engine.config.rows - 1 || c0 === engine.config.cols - 1;
      return `一度に進めるのは移動範囲の${engine.config.moveRange}マスまでです`
        + (onEdge ? "(遠くまで滑れるのは、外周の駒が辺に沿って動くときだけです)。" : "。");
    }
    if (engine._wouldExceedContactLimit(piece.player, dest, piece.position)) {
      const n = engine._contactGroupSize(piece.player, dest, piece.position);
      return `そこへ動かすと、上下左右につながった自分の駒が${n}個になり、接触制限(${engine.config.contactLimit}個まで)を超えてしまいます。`;
    }
    return null;
  }

  // 相手の「空いている所へ置く」手: 盤の内側を優先し、どの駒からもいちばん遠いマス
  function autoPlacement(engine, player) {
    const legal = engine.legalPlacements(player);
    const { rows, cols } = engine.config;
    const inner = legal.filter(([r, c]) => r > 0 && c > 0 && r < rows - 1 && c < cols - 1);
    const pool = inner.length ? inner : legal;
    let best = null, bestScore = -1;
    for (const pos of pool) {
      let near = Infinity;
      for (const p of engine.pieces.values()) {
        near = Math.min(near, Math.abs(p.position[0] - pos[0]) + Math.abs(p.position[1] - pos[1]));
      }
      if (near > bestScore) { bestScore = near; best = pos; }
    }
    return best;
  }

  // ["place", "C3"|"auto"] / ["move", "C3", "C4"] を GameEngine の手に直す
  function resolveAction(engine, player, spec) {
    if (spec[0] === "place") {
      return { kind: "place", to: spec[1] === "auto" ? autoPlacement(engine, player) : posFromLabel(spec[1]) };
    }
    const from = posFromLabel(spec[1]);
    const piece = engine.pieceAt(from);
    return { kind: "move", from, to: posFromLabel(spec[2]), pieceId: piece ? piece.id : null };
  }

  // 手番に関係なく player の手として指す(相手の決まった手・練習中の手番の調整用)
  // 練習なので千日手は数えない(同じ所を行き来しても引き分けにしない)
  function playAs(engine, player, act) {
    engine.currentPlayer = player;
    const result = act.kind === "place" ? engine.placePiece(player, act.to) : engine.movePiece(player, act.pieceId, act.to);
    engine._stateHistory.clear();
    engine.isDraw = false;
    result.draw = false;
    return result;
  }

  // 相手が休むレッスンでは、手番をあなたに戻す。そのとき指せる手が無ければ負け
  function passBack(engine) {
    if (engine.isOver()) return;
    engine.currentPlayer = "A";
    const stuck = engine.obligated.A.length
      ? engine.movablePieces("A").length === 0
      : engine.legalPlacements("A").length === 0 && engine.movablePieces("A").length === 0;
    if (stuck) engine.winner = "B";
  }

  // あなたが指した直後の判定。
  // 戻り値: "success"(課題達成) / "fail"(やり直し) / "chain"(連鎖して義務が続く) / "continue"(続けて指す)
  function judgeStep(step, engine, act, result) {
    switch (step.goal) {
      case "place": return act.kind === "place" ? "success" : "continue";
      case "move": return act.kind === "move" ? "success" : "continue";
      case "select": return "continue";
      case "reach": {
        const hit = act.kind === "move" && samePos(act.to, posFromLabel(step.target));
        if (hit) return "success";
        return step.oneMove ? "fail" : "continue";
      }
      case "sandwich": return result.newlySandwiched.length ? "success" : "fail";
      case "win": return engine.winner === "A" ? "success" : "fail";
      case "escape":
        if (!engine.obligated.A.length) return "success";
        return result.selfSandwiched ? "chain" : "continue";
      default: return "continue";
    }
  }

  // 指した結果のひとこと(課題の文言とは別に、何が起きたかを伝える)
  function describeResult(engine, act, result) {
    const parts = [];
    if (result.newlySandwiched.length) {
      const labels = result.newlySandwiched.map((pid) => posLabel(engine.pieces.get(pid).position));
      parts.push(`${posLabel(act.to)}で相手の${labels.join("・")}を挟みました。`);
    }
    if (result.selfSandwiched) {
      parts.push(`${posLabel(act.to)}は相手の駒(または盤の端)に挟まれる場所でした。自分から入っても挟まれたことになり、移動義務が付きます。`);
    }
    return parts.join("");
  }

  // 挟んだ駒の両端(線で結んで見せる用)。[[端1, 端2], ...]
  function sandwichLines(engine, act, result) {
    const lines = [];
    for (const pid of result.newlySandwiched) {
      const mid = engine.pieces.get(pid).position;
      const dr = mid[0] - act.to[0], dc = mid[1] - act.to[1];
      lines.push([act.to, [mid[0] + dr, mid[1] + dc]]);
    }
    if (result.selfSandwiched) {
      const opponent = otherPlayer(engine.pieceAt(act.to).player);
      for (const [[dr1, dc1], [dr2, dc2]] of AXIS_PAIRS) {
        const n1 = [act.to[0] + dr1, act.to[1] + dc1];
        const n2 = [act.to[0] + dr2, act.to[1] + dc2];
        const f1 = engine._flank(n1, opponent), f2 = engine._flank(n2, opponent);
        if (f1 && f2 && !(f1 === "wall" && f2 === "wall")) { lines.push([n1, n2]); break; }
      }
    }
    return lines;
  }

  const Tutorial = {
    buildEngine, placementBlockReason, moveBlockReason, autoPlacement,
    resolveAction, playAs, passBack, judgeStep, describeResult, sandwichLines,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Tutorial;
  else global.HasamiTutorial = Tutorial;
})(typeof self !== "undefined" ? self : this);
