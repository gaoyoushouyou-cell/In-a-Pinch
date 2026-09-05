/*!
 * engine.js — 挟みゲーム「IN A PINCH」のルールエンジン(ブラウザ版)
 *
 * In_a_Pinch_app_5.py の GameEngine / GameConfig を JavaScript に移植したもの。
 * ルールは一切変えていない(盤面サイズ可変・移動範囲・壁挟み・接触制限・
 * 挟み義務の連鎖・引き分け判定まで、Python 版と同じロジック)。
 *
 * このファイルはメインスレッドと Web Worker(ai-worker.js)の両方から
 * <script> / importScripts で読み込まれる「クラシックスクリプト」なので、
 * import/export は使わず、グローバルにクラス・関数を生やす形にしている。
 */
(function (global) {
  "use strict";

  const DIRECTIONS = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
  ];
  const AXIS_PAIRS = [
    [[-1, 0], [1, 0]],
    [[0, -1], [0, 1]],
  ];

  function otherPlayer(p) {
    return p === "A" ? "B" : "A";
  }

  function posKey(pos) {
    return pos[0] + "," + pos[1];
  }

  function initialStock(config) {
    if (config.stockPerPlayer != null) return config.stockPerPlayer;
    return Math.max(3, Math.ceil((config.rows * config.cols) / 4));
  }

  function makeConfig(opts) {
    return Object.assign({
      rows: 7,
      cols: 7,
      moveRange: 1,
      stockPerPlayer: null,
      repetitionLimit: 3,
      wallSandwich: true,
      contactLimit: null,
    }, opts);
  }

  class IllegalMoveError extends Error {}
  class GameOverError extends Error {}

  class GameEngine {
    constructor(config) {
      this.config = config;
      this.board = new Map(); // posKey -> pieceId
      this.pieces = new Map(); // id -> {id, player, position:[r,c]}
      this._nextPieceId = 1;
      this.stock = { A: initialStock(config), B: initialStock(config) };
      this.currentPlayer = "A";
      this.obligated = { A: [], B: [] };
      this.winner = null;
      this.isDraw = false;
      this._stateHistory = new Map();
    }

    inBounds(pos) {
      const [r, c] = pos;
      return r >= 0 && r < this.config.rows && c >= 0 && c < this.config.cols;
    }

    pieceAt(pos) {
      const pid = this.board.get(posKey(pos));
      return pid == null ? null : this.pieces.get(pid);
    }

    isOver() {
      return this.winner != null || this.isDraw;
    }

    legalPlacements(player) {
      if (this.obligated[player].length) return [];
      if (this.stock[player] <= 0) return [];
      const result = [];
      for (let r = 0; r < this.config.rows; r++) {
        for (let c = 0; c < this.config.cols; c++) {
          const pos = [r, c];
          if (this.board.has(posKey(pos))) continue;
          if (this._wouldPlacementSandwich(player, pos)) continue;
          if (this._wouldExceedContactLimit(player, pos, null)) continue;
          result.push(pos);
        }
      }
      return result;
    }

    // 挟みの「両端」判定。壁ルール有効時に盤外なら 'wall'、player 自身の駒なら 'piece'、
    // それ以外(空き/敵駒/壁ルール無効時の盤外)は null を返す。
    _flank(pos, player) {
      if (!this.inBounds(pos)) return this.config.wallSandwich ? "wall" : null;
      const piece = this.pieceAt(pos);
      if (piece && piece.player === player) return "piece";
      return null;
    }

    _wouldPlacementSandwich(player, pos) {
      const opponent = otherPlayer(player);
      for (const [dr, dc] of DIRECTIONS) {
        const mid = [pos[0] + dr, pos[1] + dc];
        const midPiece = this.inBounds(mid) ? this.pieceAt(mid) : null;
        if (!midPiece || midPiece.player !== opponent) continue;
        const far = [pos[0] + dr * 2, pos[1] + dc * 2];
        if (this._flank(far, player)) return true;
      }
      for (const [[dr1, dc1], [dr2, dc2]] of AXIS_PAIRS) {
        const n1 = [pos[0] + dr1, pos[1] + dc1];
        const n2 = [pos[0] + dr2, pos[1] + dc2];
        const f1 = this._flank(n1, opponent);
        const f2 = this._flank(n2, opponent);
        if (!f1 || !f2) continue;
        if (f1 === "wall" && f2 === "wall") continue;
        return true;
      }
      return false;
    }

    _contactGroupSize(player, pos, excludePos) {
      const excludeKey = excludePos ? posKey(excludePos) : null;
      const posK = posKey(pos);
      const occupied = (p) => {
        const k = posKey(p);
        if (k === excludeKey) return false;
        if (k === posK) return true;
        const piece = this.pieceAt(p);
        return !!piece && piece.player === player;
      };
      const visited = new Set([posK]);
      const stack = [pos];
      while (stack.length) {
        const cur = stack.pop();
        for (const [dr, dc] of DIRECTIONS) {
          const nxt = [cur[0] + dr, cur[1] + dc];
          const k = posKey(nxt);
          if (visited.has(k) || !this.inBounds(nxt)) continue;
          if (occupied(nxt)) {
            visited.add(k);
            stack.push(nxt);
          }
        }
      }
      return visited.size;
    }

    _wouldExceedContactLimit(player, pos, excludePos) {
      const limit = this.config.contactLimit;
      if (limit == null) return false;
      return this._contactGroupSize(player, pos, excludePos) > limit;
    }

    placePiece(player, pos) {
      this._assertTurn(player);
      const legal = this.legalPlacements(player);
      if (!legal.some((p) => p[0] === pos[0] && p[1] === pos[1])) {
        throw new IllegalMoveError(`${pos} には配置できません`);
      }
      const piece = { id: this._nextPieceId, player, position: pos };
      this._nextPieceId += 1;
      this.pieces.set(piece.id, piece);
      this.board.set(posKey(pos), piece.id);
      this.stock[player] -= 1;
      return this._finishTurn({ newlySandwiched: [], selfSandwiched: false, winner: null, draw: false });
    }

    legalMoves(pieceId) {
      const piece = this.pieces.get(pieceId);
      const result = [];
      for (const [dr, dc] of DIRECTIONS) {
        for (let step = 1; step <= this.config.moveRange; step++) {
          const pos = [piece.position[0] + dr * step, piece.position[1] + dc * step];
          if (!this.inBounds(pos)) break;
          if (this.board.has(posKey(pos))) break;
          if (this._wouldExceedContactLimit(piece.player, pos, piece.position)) continue;
          result.push(pos);
        }
      }
      return result;
    }

    movablePieces(player) {
      if (this.obligated[player].length) {
        return this.obligated[player].filter((pid) => this.legalMoves(pid).length > 0);
      }
      const out = [];
      for (const [pid, p] of this.pieces) {
        if (p.player === player && this.legalMoves(pid).length > 0) out.push(pid);
      }
      return out;
    }

    movePiece(player, pieceId, dest) {
      this._assertTurn(player);
      const piece = this.pieces.get(pieceId);
      if (piece.player !== player) throw new IllegalMoveError("自分の駒ではありません");
      if (this.obligated[player].length && !this.obligated[player].includes(pieceId)) {
        throw new IllegalMoveError("移動義務のある駒を先に動かしてください");
      }
      const legal = this.legalMoves(pieceId);
      if (!legal.some((p) => p[0] === dest[0] && p[1] === dest[1])) {
        throw new IllegalMoveError(`${dest} へは移動できません`);
      }

      this.board.delete(posKey(piece.position));
      piece.position = dest;
      this.board.set(posKey(dest), pieceId);

      const idx = this.obligated[player].indexOf(pieceId);
      if (idx >= 0) this.obligated[player].splice(idx, 1);

      const result = { newlySandwiched: [], selfSandwiched: false, winner: null, draw: false };
      const newlySandwiched = this._checkSandwiches(piece);
      result.newlySandwiched = newlySandwiched;
      if (newlySandwiched.length) {
        this.obligated[otherPlayer(player)].push(...newlySandwiched);
      }

      const selfSandwiched = this._checkSelfSandwich(piece);
      result.selfSandwiched = selfSandwiched;
      if (selfSandwiched) {
        this.obligated[player].push(pieceId);
      }

      return this._finishTurn(result);
    }

    _checkSandwiches(movedPiece) {
      const opponent = otherPlayer(movedPiece.player);
      const found = [];
      for (const [dr, dc] of DIRECTIONS) {
        const mid = [movedPiece.position[0] + dr, movedPiece.position[1] + dc];
        const midPiece = this.inBounds(mid) ? this.pieceAt(mid) : null;
        if (!midPiece || midPiece.player !== opponent) continue;
        const far = [movedPiece.position[0] + dr * 2, movedPiece.position[1] + dc * 2];
        if (this._flank(far, movedPiece.player)) found.push(midPiece.id);
      }
      return found;
    }

    _checkSelfSandwich(movedPiece) {
      const opponent = otherPlayer(movedPiece.player);
      for (const [[dr1, dc1], [dr2, dc2]] of AXIS_PAIRS) {
        const n1 = [movedPiece.position[0] + dr1, movedPiece.position[1] + dc1];
        const n2 = [movedPiece.position[0] + dr2, movedPiece.position[1] + dc2];
        const f1 = this._flank(n1, opponent);
        const f2 = this._flank(n2, opponent);
        if (!f1 || !f2) continue;
        if (f1 === "wall" && f2 === "wall") continue;
        return true;
      }
      return false;
    }

    _assertTurn(player) {
      if (this.isOver()) throw new GameOverError("ゲームは既に終了しています");
      if (player !== this.currentPlayer) throw new IllegalMoveError("あなたの手番ではありません");
    }

    _finishTurn(result) {
      this.currentPlayer = otherPlayer(this.currentPlayer);
      if (this.obligated[this.currentPlayer].length) {
        if (this.movablePieces(this.currentPlayer).length === 0) {
          this.winner = otherPlayer(this.currentPlayer);
          result.winner = this.winner;
          return result;
        }
      } else if (this.legalPlacements(this.currentPlayer).length === 0
          && this.movablePieces(this.currentPlayer).length === 0) {
        this.winner = otherPlayer(this.currentPlayer);
        result.winner = this.winner;
        return result;
      }

      const stateKey = this._stateKey();
      const count = (this._stateHistory.get(stateKey) || 0) + 1;
      this._stateHistory.set(stateKey, count);
      if (count >= this.config.repetitionLimit) {
        this.isDraw = true;
        result.draw = true;
      }
      return result;
    }

    _stateKey() {
      const boardEntries = [];
      for (const [pos, pid] of this.board) boardEntries.push(pos + ":" + this.pieces.get(pid).player);
      boardEntries.sort();
      const oblA = [...this.obligated.A].sort((a, b) => a - b).join(",");
      const oblB = [...this.obligated.B].sort((a, b) => a - b).join(",");
      return boardEntries.join("|") + "#" + this.currentPlayer + "#" + oblA + "#" + oblB;
    }

    // Python 版の GameEngine.clone() と同じく、探索AIが1手ごとに大量に複製するため
    // 専用の高速コピーを用意する(JSON往復や再帰deepcopyより大幅に速い)。
    clone() {
      const other = Object.create(GameEngine.prototype);
      other.config = this.config; // 対局中は不変なので共有
      other.board = new Map(this.board);
      other.pieces = new Map();
      for (const [id, p] of this.pieces) {
        other.pieces.set(id, { id: p.id, player: p.player, position: [p.position[0], p.position[1]] });
      }
      other._nextPieceId = this._nextPieceId;
      other.stock = { A: this.stock.A, B: this.stock.B };
      other.currentPlayer = this.currentPlayer;
      other.obligated = { A: this.obligated.A.slice(), B: this.obligated.B.slice() };
      other.winner = this.winner;
      other.isDraw = this.isDraw;
      other._stateHistory = new Map(this._stateHistory);
      return other;
    }
  }

  function posLabel(pos) {
    return String.fromCharCode(65 + pos[1]) + (pos[0] + 1);
  }

  function posFromLabel(label) {
    label = label.trim();
    const col = label.toUpperCase().charCodeAt(0) - 65;
    const row = parseInt(label.slice(1), 10) - 1;
    return [row, col];
  }

  function defaultStockForSize(size) {
    return Math.max(3, Math.ceil((size * size) / 4));
  }

  const Hasami = {
    DIRECTIONS, AXIS_PAIRS,
    otherPlayer, posKey, initialStock, makeConfig,
    GameEngine, IllegalMoveError, GameOverError,
    posLabel, posFromLabel, defaultStockForSize,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Hasami;
  } else {
    global.Hasami = Hasami;
  }
})(typeof self !== "undefined" ? self : this);
