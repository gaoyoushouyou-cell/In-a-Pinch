/*!
 * rating.js — AI戦のレート(結果と指し手の質から計算する)。画面を持たない計算部分だけ。
 *
 * 1局ごとに「パフォーマンス」を出してレートを更新する。
 *   結果のパフォーマンス = 相手レベルのレート ±400(勝ち +400 / 負け −400 / 引き分け ±0)
 *   内容のパフォーマンス = 自分の指し手の平均損失(感想戦の悪手判定と同じ物差し)をレートに換算した値
 *   その対局のパフォーマンス = 両者の平均
 * 最初の PROVISIONAL_GAMES 局は暫定期間として、パフォーマンスの平均をそのままレートにする。
 * その後は レート ← レート + STEP ×(パフォーマンス − レート)で少しずつ動かす。
 *
 * レベルのレート(LEVELS)と換算式(QUALITY)は dev/rating_ladder.js(レベル同士の対戦)と
 * dev/rating_calib.js(その対局を感想戦と同じ評価役で解析)で測ったもの。測定は特化テンプレートの
 * 設定(7×7・持ち駒15・接触3・移動3)で、ほかの盤の設定でも同じ値を使う(目安)。
 */
(function (global) {
  "use strict";

  // レベルの id(ai.js の LEVELS)→ レート。"S" = 奥義(テンプレート特化)。ランダム = 0 を基準にした。
  // 2026-10-01 の測定(隣のレベルどうし各8〜40局、本番と同じ持ち時間): 初級はランダムに40戦全勝、
  // 中級は初級に28戦全勝、究極は最強に14戦全勝など、全勝の組の差は「少なくともこのくらい」の値
  const LEVELS = { 1: 0, 2: 764, 3: 1466, 4: 1742, 8: 1897, 5: 1933, 6: 2518, 7: 2597, S: 2814 };
  // 内容のパフォーマンス = a + b × ln(平均損失 + eps)。各レベルの1局あたり平均損失(ランダム 19%、
  // 中級〜最強 8〜10%、究極・神・奥義 1〜2%)とレートの関係に当てはめた(ずれの目安 ±400)
  const QUALITY = { a: -620, b: -840, eps: 0.005 };
  const PROVISIONAL_GAMES = 5;
  const STEP = 0.2;
  const MIN_MOVES = 5; // 判定できる自分の手がこれより少ない対局は数えない

  function qualityPerformance(avgLoss) {
    const lv = Object.values(LEVELS);
    const v = QUALITY.a + QUALITY.b * Math.log(Math.max(0, avgLoss) + QUALITY.eps);
    return Math.max(Math.min(...lv) - 200, Math.min(Math.max(...lv) + 200, v));
  }

  function resultPerformance(levelRating, result) {
    const score = result === "win" ? 1 : result === "loss" ? 0 : 0.5;
    return levelRating + 400 * (2 * score - 1);
  }

  // これまでの記録 prev(古い順、各要素は after と perf を持つ)に1局ぶんを足したときの数値
  function rate(prev, levelKey, result, avgLoss) {
    const levelRating = LEVELS[levelKey];
    const resultPerf = resultPerformance(levelRating, result);
    const qualityPerf = qualityPerformance(avgLoss);
    const perf = (resultPerf + qualityPerf) / 2;
    const before = prev.length ? prev[prev.length - 1].after : null;
    const after = prev.length < PROVISIONAL_GAMES
      ? (prev.reduce((s, g) => s + g.perf, 0) + perf) / (prev.length + 1)
      : before + STEP * (perf - before);
    return {
      levelRating, resultPerf: Math.round(resultPerf), qualityPerf: Math.round(qualityPerf), perf: Math.round(perf),
      before: before == null ? null : Math.round(before), after: Math.round(after),
      provisional: prev.length + 1 < PROVISIONAL_GAMES,
    };
  }

  // rating に一番近い強さのレベル [id, レート]
  function nearestLevel(rating) {
    return Object.entries(LEVELS).sort((a, b) => Math.abs(a[1] - rating) - Math.abs(b[1] - rating))[0];
  }

  const R = { LEVELS, QUALITY, PROVISIONAL_GAMES, STEP, MIN_MOVES, qualityPerformance, resultPerformance, rate, nearestLevel };
  if (typeof module !== "undefined" && module.exports) module.exports = R;
  else global.HasamiRating = R;
})(typeof self !== "undefined" ? self : this);
