/*!
 * sound.js — 効果音と BGM(音声ファイルを使わず Web Audio でその場で合成・作曲する)
 *
 * 効果音: 碁石の「パチ」・拍子木・箏(Karplus-Strong の弦モデル)・りん・小鼓・笙 など。
 * BGM: 場面ごとに和風の旋律をその場で作って鳴らす(毎回少しずつ違う)。作曲の規則は下の「BGM」の節。
 * 設定(音・BGM・音量・演出の強さ・画面の切り替え・振動)はこの端末のブラウザに保存する
 * (localStorage `hasami:sound:v1`)。最初は無音で、はじめて対局するときに「音を出しますか?」と尋ねる。
 * ブラウザは画面に触れるまで音を出せないので、タップのたびに AudioContext を起こす。
 */
(function (global) {
  "use strict";

  const LS_SOUND = "hasami:sound:v1";
  const DEFAULTS = { on: true, asked: false, volume: 0.8, bgm: true, bgmVolume: 0.5, fx: "標準", transition: "墨", vibrate: false };
  const prefs = Object.assign({}, DEFAULTS);
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(LS_SOUND) || "{}")); } catch (e) { /* 既定のまま */ }
  function savePrefs() { try { localStorage.setItem(LS_SOUND, JSON.stringify(prefs)); } catch (e) { /* 保存できなくても鳴らせる */ } }
  const soundOn = () => !!(prefs.on && prefs.asked);

  let K = null; // { ctx, se, bgm, rev, bgmRev, noise, ks }

  function kit(create) {
    try {
      if (!K) {
        if (!create) return null;
        const AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return null;
        const ctx = new AC();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 3; comp.attack.value = 0.003; comp.release.value = 0.25;
        comp.connect(ctx.destination);
        const se = ctx.createGain(); se.gain.value = prefs.volume; se.connect(comp);
        // BGM の出口に 4次のハイパス(240Hz、バターワース)を置き、低い音を一切通さない
        const bgm = ctx.createGain(); bgm.gain.value = 0;
        const hp1 = ctx.createBiquadFilter(), hp2 = ctx.createBiquadFilter();
        hp1.type = hp2.type = "highpass"; hp1.frequency.value = hp2.frequency.value = 240; hp1.Q.value = 0.541; hp2.Q.value = 1.307;
        bgm.connect(hp1); hp1.connect(hp2); hp2.connect(comp);
        const rev = ctx.createConvolver(); rev.buffer = makeIR(ctx, 2.8); rev.connect(se);
        const bgmRev = ctx.createConvolver(); bgmRev.buffer = makeIR(ctx, 3.4); bgmRev.connect(bgm);
        const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = noise.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
        K = { ctx, se, bgm, rev, bgmRev, noise, ks: {} };
      }
      if (K.ctx.state === "suspended") K.ctx.resume();
      return K;
    } catch (e) { return null; }
  }

  // 残響: 減衰する雑音。時間とともに高音から消える(空気吸収)ように、ならしを強めていく
  function makeIR(ctx, sec) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), b = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        y += (0.6 - 0.52 * t) * ((Math.random() * 2 - 1) - y);
        d[i] = i < sr * 0.018 ? 0 : y * Math.pow(1 - t, 3.2);
      }
    }
    return b;
  }

  function midi(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  // 出力先(効果音 or BGM)と残響の量を持った入口
  function bus(k, wet, toBgm) {
    const g = k.ctx.createGain(); g.connect(toBgm ? k.bgm : k.se);
    if (wet) { const s = k.ctx.createGain(); s.gain.value = wet; g.connect(s); s.connect(toBgm ? k.bgmRev : k.rev); }
    return g;
  }
  function tone(k, out, type, f, t, att, peak, dec, f2) {
    const c = k.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + att + dec);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + att + dec);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + att + dec + 0.05);
  }
  function hit(k, out, t, type, freq, q, att, peak, dec) {
    const c = k.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = k.noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + att); g.gain.exponentialRampToValueAtTime(0.0001, t + att + dec);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(t, Math.random() * 1.5); s.stop(t + att + dec + 0.05);
  }

  // ---------------------------------------------------------------- 楽器
  // 箏: Karplus-Strong 法。周期は整数で作り、再生速度で正確な音程に合わせる
  const KS_A = 0.32;
  function ksBuf(k, N) {
    if (k.ks[N]) return k.ks[N];
    const c = k.ctx, sr = c.sampleRate, len = Math.floor(sr * 2.6), b = c.createBuffer(1, len, sr), d = b.getChannelData(0);
    const line = new Float32Array(N);
    let y = 0, mean = 0;
    for (let i = 0; i < N; i++) { y += 0.75 * ((Math.random() * 2 - 1) - y); line[i] = y; mean += y; }
    mean /= N;
    const pp = Math.max(1, Math.round(N * 0.18)), src = line.slice();
    for (let i = 0; i < N; i++) line[i] = (src[i] - mean) - 0.55 * (src[(i + N - pp) % N] - mean); // 撥く位置
    let idx = 0, peak = 0;
    for (let i = 0; i < len; i++) {
      const cur = line[idx], nxt = line[(idx + 1) % N];
      d[i] = cur; if (Math.abs(cur) > peak) peak = Math.abs(cur);
      line[idx] = 0.9985 * ((1 - KS_A) * cur + KS_A * nxt);
      idx = (idx + 1) % N;
    }
    for (let i = 0; i < len; i++) d[i] /= (peak || 1);
    k.ks[N] = b;
    return b;
  }
  // o.bend: 押し手(はじいた後に弦を押して音程を上げる)の半音数
  function pluck(k, out, f, t, vel, o) {
    o = o || {};
    const c = k.ctx, sr = c.sampleRate, N = Math.max(2, Math.round(sr / f + KS_A));
    const rate = f / (sr / (N - KS_A));
    const s = c.createBufferSource(); s.buffer = ksBuf(k, N);
    s.playbackRate.setValueAtTime(rate, t);
    if (o.bend) { const bt = t + (o.bendAt || 0.3); s.playbackRate.setValueAtTime(rate, bt); s.playbackRate.linearRampToValueAtTime(rate * Math.pow(2, o.bend / 12), bt + 0.14); }
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = o.tone || 4200; lp.Q.value = 0.5;
    const g = c.createGain(), dur = o.dur || 2.2;
    g.gain.setValueAtTime(vel, t); g.gain.setTargetAtTime(0.0001, t + dur, 0.12);
    s.connect(lp); lp.connect(g); g.connect(out);
    s.start(t); s.stop(t + dur + 0.8);
    hit(k, out, t, "bandpass", 2600, 1.4, 0.0006, 0.10 * vel, 0.012); // 爪の当たり
  }
  // りん: 打ち物の非整数倍音(1 : 2.76 : 5.40 : 8.93)。各倍音を少しずらした2本で鳴らし「うなり」を出す
  function rin(k, out, f, t, vel) {
    const R = [1, 2.76, 5.40, 8.93], A = [1, 0.45, 0.22, 0.10], D = [4.5, 2.4, 1.3, 0.7];
    for (let i = 0; i < 4; i++) for (let j = -1; j <= 1; j += 2) tone(k, out, "sine", f * R[i] + j * 0.45 * (i + 1), t, 0.004, 0.5 * vel * A[i], D[i]);
  }
  // 笙: 自由簧(リード)の倍音の多い音を のこぎり波 + ローパスで近似。1音を ±3セントの2本にして揺らぎを出す
  function sho(k, out, freqs, t, dur, vel) {
    const c = k.ctx, g = c.createGain(), lp = c.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 1900; lp.Q.value = 0.3;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel, t + 1.3);
    g.gain.setValueAtTime(vel, t + Math.max(1.3, dur - 1.7)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g); g.connect(out);
    freqs.forEach((f) => [-3, 3].forEach((ct) => {
      const o = c.createOscillator(), og = c.createGain();
      o.type = "sawtooth"; o.frequency.value = f * Math.pow(2, ct / 1200); og.gain.value = 0.07 / freqs.length;
      o.connect(og); og.connect(lp); o.start(t); o.stop(t + dur + 0.1);
    }));
  }
  // 尺八: 正弦波 + 三角波(2倍音)+ 息の雑音。メリ(低めから入って上げる)と、遅れてかかるユリ(揺れ)
  function shaku(k, out, f, t, dur, vel, meri) {
    const c = k.ctx, o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain(), g2 = c.createGain();
    const lfo = c.createOscillator(), lg = c.createGain();
    const f0 = f * Math.pow(2, -(meri == null ? 0.7 : meri) / 12);
    o.type = "sine"; o2.type = "triangle";
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.2);
    o2.frequency.setValueAtTime(f0 * 2, t); o2.frequency.exponentialRampToValueAtTime(f * 2, t + 0.2);
    lfo.frequency.value = 4.8; lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.011, t + Math.max(0.3, dur * 0.75));
    lfo.connect(lg); lg.connect(o.frequency);
    g2.gain.value = 0.12; o2.connect(g2); g2.connect(g); o.connect(g);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vel, t + 0.12);
    g.gain.linearRampToValueAtTime(vel * 0.7, t + dur * 0.45); g.gain.linearRampToValueAtTime(vel * 0.9, t + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    g.connect(out);
    const ns = c.createBufferSource(), nf = c.createBiquadFilter(), ng = c.createGain();
    ns.buffer = k.noise; ns.loop = true; nf.type = "bandpass"; nf.frequency.value = f * 2; nf.Q.value = 4;
    ng.gain.setValueAtTime(0.0001, t); ng.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.05); ng.gain.exponentialRampToValueAtTime(vel * 0.09, t + 0.3);
    ng.gain.setValueAtTime(vel * 0.09, t + dur); ng.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    ns.connect(nf); nf.connect(ng); ng.connect(out);
    [o, o2, lfo].forEach((x) => { x.start(t); x.stop(t + dur + 0.4); });
    ns.start(t, Math.random()); ns.stop(t + dur + 0.4);
  }
  function hyoshigi(k, t, v) {
    const o = bus(k, 0.32);
    tone(k, o, "sine", 2450, t, 0.0006, 0.42 * v, 0.10); tone(k, o, "sine", 3720, t, 0.0006, 0.2 * v, 0.06); tone(k, o, "sine", 1180, t, 0.0006, 0.12 * v, 0.05);
    hit(k, o, t, "bandpass", 3000, 1, 0.0004, 0.5 * v, 0.014);
  }
  // 太鼓(BGM 用): 低い音は一切使わない。胴鳴りは 300Hz 以上の締太鼓ふうの高い「トン」
  const PERC = {
    don(k, o, t, v) { tone(k, o, "sine", 380, t, 0.003, 0.5 * v, 0.2, 320); tone(k, o, "sine", 690, t, 0.003, 0.16 * v, 0.08, 600); hit(k, o, t, "bandpass", 1300, 1.2, 0.001, 0.32 * v, 0.04); },
    ka(k, o, t, v) { hit(k, o, t, "bandpass", 2000, 2, 0.001, 0.3 * v, 0.03); tone(k, o, "sine", 1250, t, 0.001, 0.12 * v, 0.03); },
    ten(k, o, t, v) { tone(k, o, "sine", 520, t, 0.002, 0.32 * v, 0.1, 470); hit(k, o, t, "bandpass", 2400, 1.2, 0.001, 0.22 * v, 0.025); },
    suzu(k, o, t, v) { for (let i = 0; i < 5; i++) tone(k, o, "sine", 4200 + Math.random() * 2600, t + Math.random() * 0.06, 0.001, 0.06 * v, 0.3); },
  };

  // ---------------------------------------------------------------- 効果音
  const SE = {
    // 碁石の「パチ」: 石の硬い打音(3.6kHz 付近)+ 木の盤の胴鳴り(160Hz)
    pachi(k, t) {
      const o = bus(k, 0.10);
      hit(k, o, t, "bandpass", 3600, 1.6, 0.0008, 0.8, 0.032);
      tone(k, o, "sine", 1950, t, 0.0008, 0.14, 0.05); tone(k, o, "sine", 3050, t, 0.0008, 0.06, 0.03);
      tone(k, o, "sine", 160, t, 0.002, 0.26, 0.09, 120);
    },
    // 相手(AI・相手側)の手: 少し低く小さく。耳だけでも「相手が指した」と分かる
    pachiFar(k, t) {
      const o = bus(k, 0.10);
      hit(k, o, t, "bandpass", 2900, 1.6, 0.0008, 0.6, 0.032);
      tone(k, o, "sine", 1620, t, 0.0008, 0.11, 0.05); tone(k, o, "sine", 140, t, 0.002, 0.24, 0.09, 105);
    },
    // 挟んだ: 両側の石が触れ合う「カチッ」。2打を 22ms ずらす。壁なら1打 + 低い木の音
    kachi(k, t, wall) {
      const o = bus(k, 0.12);
      tone(k, o, "sine", 3150, t, 0.0005, 0.16, 0.035); hit(k, o, t, "bandpass", 4200, 2.2, 0.0005, 0.26, 0.013);
      if (!wall) { tone(k, o, "sine", 2850, t + 0.022, 0.0005, 0.13, 0.035); hit(k, o, t + 0.022, "bandpass", 3900, 2.2, 0.0005, 0.2, 0.013); }
      else tone(k, o, "sine", 520, t + 0.01, 0.002, 0.12, 0.05, 440);
    },
    kotsu(k, t) { const o = bus(k, 0.05); hit(k, o, t, "bandpass", 1500, 3, 0.001, 0.28, 0.02); tone(k, o, "sine", 1040, t, 0.001, 0.09, 0.045); },
    tap(k, t) { const o = bus(k, 0.03); hit(k, o, t, "bandpass", 2300, 2, 0.001, 0.10, 0.014); tone(k, o, "sine", 1320, t, 0.001, 0.03, 0.03); },
    // 指せない: 低く鈍い「コン」(責めない音)
    kon(k, t) {
      const o = bus(k, 0.06);
      tone(k, o, "sine", 215, t, 0.002, 0.38, 0.15, 182); tone(k, o, "triangle", 430, t, 0.002, 0.06, 0.06);
      hit(k, o, t, "lowpass", 900, 0.7, 0.001, 0.2, 0.035);
    },
    swish(k, t, slow) {
      const c = k.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), o = bus(k, 0.08), dur = slow ? 0.55 : 0.28;
      s.buffer = k.noise; f.type = "bandpass"; f.Q.value = slow ? 0.9 : 1.1;
      f.frequency.setValueAtTime(slow ? 380 : 500, t); f.frequency.exponentialRampToValueAtTime(slow ? 1600 : 2200, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(slow ? 0.045 : 0.06, t + dur * 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(o); s.start(t, Math.random()); s.stop(t + dur + 0.05);
    },
    // 襖が開く: 木の小さな「トン」+ すべる音
    fusuma(k, t) { const o = bus(k, 0.12); tone(k, o, "sine", 240, t, 0.002, 0.22, 0.08, 200); hit(k, o, t, "bandpass", 1100, 1.5, 0.001, 0.14, 0.025); SE.swish(k, t + 0.04, true); },
    // 義務が解けた: 陶器の割れる粒 + 箏の高いレ→ラ(核音どうしの完全4度の下行 = 張りがほどける)
    crack(k, t) {
      const o = bus(k, 0.22);
      for (let i = 0; i < 4; i++) hit(k, o, t + i * 0.017 + Math.random() * 0.008, "highpass", 2600 + i * 400, 0.8, 0.0005, 0.38 * (1 - i * 0.18), 0.028);
      tone(k, o, "sine", 3400, t, 0.001, 0.05, 0.18, 2900);
      pluck(k, o, midi(86), t + 0.05, 0.15, { dur: 0.9, tone: 6000 }); pluck(k, o, midi(81), t + 0.15, 0.11, { dur: 1.0, tone: 6000 });
    },
    // 対局開始: 歌舞伎の柝(き)にならい「カン……カン」。2打目をわずかに強く
    start(k, t) { hyoshigi(k, t, 0.6); hyoshigi(k, t + 0.62, 0.8); },
    // 勝ち: 民謡音階(レ ファ ソ ラ ド)のラ→ド→レ、レのオクターブ(掻き手)で終止、りん
    win(k, t) {
      const o = bus(k, 0.3);
      pluck(k, o, midi(69), t, 0.26); pluck(k, o, midi(72), t + 0.16, 0.26); pluck(k, o, midi(74), t + 0.32, 0.28, { dur: 1.2 });
      pluck(k, o, midi(62), t + 0.62, 0.32, { dur: 2.4 }); pluck(k, o, midi(74), t + 0.635, 0.26, { dur: 2.4 });
      rin(k, bus(k, 0.4), midi(86), t + 0.66, 0.14);
    },
    // 負け: 都節音階(レ ミ♭ ソ ラ シ♭)のレ→シ♭→ラ、低いミ♭→レ。半音で核音へ落ちる「陰」の終止
    lose(k, t) {
      const o = bus(k, 0.3);
      pluck(k, o, midi(74), t, 0.2, { tone: 3200 }); pluck(k, o, midi(70), t + 0.24, 0.2, { tone: 3200 }); pluck(k, o, midi(69), t + 0.48, 0.22, { dur: 1.6, tone: 3200 });
      pluck(k, o, midi(51), t + 0.86, 0.26, { tone: 2200 }); pluck(k, o, midi(50), t + 1.12, 0.28, { dur: 2.6, tone: 2000 });
    },
    // 引き分け: 空虚5度(レ+ラ)のあと核音ソを残す。主音に帰らない宙づりの響き
    draw(k, t) {
      const o = bus(k, 0.35);
      pluck(k, o, midi(50), t, 0.26, { dur: 2.2, tone: 2600 }); pluck(k, o, midi(57), t + 0.02, 0.22, { dur: 2.2, tone: 2600 });
      pluck(k, o, midi(67), t + 0.6, 0.24, { dur: 2.8 });
    },
    // 形勢が良くなった: 小鼓の「ポン」(胴の共鳴がわずかに上ずる)/ 苦しくなった: 皮をゆるめた低い「プ」
    pon(k, t) {
      const o = bus(k, 0.35);
      tone(k, o, "sine", 300, t, 0.003, 0.45, 0.42, 335); tone(k, o, "sine", 610, t, 0.002, 0.07, 0.12);
      hit(k, o, t, "bandpass", 900, 1.4, 0.0008, 0.28, 0.04);
    },
    pu(k, t) { const o = bus(k, 0.25); tone(k, o, "sine", 205, t, 0.004, 0.38, 0.22, 190); hit(k, o, t, "lowpass", 700, 0.8, 0.001, 0.25, 0.05); },
    // 詰みを読み切った: 笙の合竹(レ ミ ラ シ、2度と4度を重ねた和音)がふくらみ、りんが一つ
    mate(k, t) {
      sho(k, bus(k, 0.45), [74, 76, 81, 83].map(midi), t, 3.4, 0.42);
      rin(k, bus(k, 0.4), midi(86), t + 0.9, 0.12);
    },
    // 秒読み: 木の小さな「コッ」。f は音の高さ
    tick(k, t, a) {
      const f = (a && a.f) || 1760, v = (a && a.v) || 0.5, o = bus(k, 0.08);
      tone(k, o, "sine", f, t, 0.0008, 0.30 * v, 0.05); tone(k, o, "sine", f * 1.52, t, 0.0008, 0.09 * v, 0.03);
      hit(k, o, t, "bandpass", f * 1.3, 1.5, 0.0005, 0.25 * v, 0.012);
    },
    // 時間切れ: 拍子木を一つと、低いレを短く
    flag(k, t) { hyoshigi(k, t, 0.9); tone(k, bus(k, 0.2), "sine", midi(50), t + 0.05, 0.02, 0.2, 1.1); },
    // 詰めピンチの星: 1つごとに箏。★3は レ→ソ→高いレ(主音へ帰って「完成」)、★2は レ→ソ で止める(「あと一歩」)
    star(k, t, a) {
      const p = bus(k, 0.35);
      hit(k, p, t, "bandpass", 1800, 1.2, 0.001, 0.12, 0.02);
      pluck(k, p, midi(a.m), t + 0.02, 0.3, { dur: a.last ? 2.4 : 1.2 });
      if (a.last && a.m === 74) pluck(k, p, midi(62), t + 0.035, 0.22, { dur: 2.4 });
    },
    // 判子の鈍い「トン」+ 箏のラ→レ(4度上の主音へ: 解決)
    hanko(k, t) {
      const o = bus(k, 0.12);
      tone(k, o, "sine", 125, t, 0.002, 0.4, 0.1, 95); hit(k, o, t, "lowpass", 600, 0.7, 0.001, 0.35, 0.04);
      const p = bus(k, 0.35);
      pluck(k, p, midi(69), t + 0.18, 0.26, { dur: 1 }); pluck(k, p, midi(74), t + 0.36, 0.3, { dur: 2 });
    },
    // レートが上がった: 民謡音階を駆け上がり、主音レで止まる
    rise(k, t) {
      const p = bus(k, 0.3);
      [62, 65, 67, 69, 72, 74].forEach((m, i) => pluck(k, p, midi(m), t + i * 0.16, 0.18 + i * 0.022, { dur: i === 5 ? 2.2 : 0.9 }));
    },
  };

  // ---------------------------------------------------------------- BGM
  // 作曲の規則
  //  - 音階は日本の3つ(小泉文夫のテトラコルド理論): 律(レ ミ ソ ラ シ)・民謡(レ ファ ソ ラ ド)・都節(レ ミ♭ ソ ラ シ♭)。
  //    どれも核音 レ・ソ・ラ(完全4度の枠)を共有し、間に入る音だけが違う。形勢で音階を替えても土台が同じなので、
  //    ぶつからずに色だけが変わる(互角=律、優勢=民謡、劣勢=都節)
  //  - フレーズは2つで1組。前句は核音ソかラで止め(半終止)、後句で主音レに帰る(全終止)。
  //    都節では核音の半音上(ミ♭・シ♭)から下りて終わる
  //  - 序破急: 詰みが見えたら小節ごとに少しだけテンポを上げる。詰まされそうなときは遅くし、太鼓を心拍に。
  //    秒読みは ♩=60 にして時計の1秒と拍をそろえる
  //  - 間: フレーズのあとに必ず休みを置く。低い音は一切使わない(どの音も主音レ D4 以上、太鼓も 300Hz 以上、
  //    出口にもハイパスを置く)。箏・尺八・笙の中高音域だけで響きを作る
  //  - 場面の切り替えは、今のフレーズの切れ目で行う
  const TONIC = 62; // レ(D4)
  const SC = {
    ritsu: { off: [0, 2, 5, 7, 9], sho: [[74, 76, 81, 83], [69, 74, 76, 81]] },
    minyo: { off: [0, 3, 5, 7, 10], sho: [[74, 79, 81, 84], [72, 74, 79, 81]] },
    miyako: { off: [0, 1, 5, 7, 8], sho: [[74, 75, 79, 81], [70, 74, 75, 81]] },
  };
  const SCENES = {
    home: { scale: "ritsu", bpm: 56, rub: 0.18, lead: "koto", reg: 0, range: [2, 9], len: [3, 5], rest: [3, 6], rhythm: [1, 1, 1.5, 2, 0.5], sho: true, shoVel: 0.18, perc: "none", rin: 24, wet: 0.45 },
    even: { scale: "ritsu", bpm: 72, rub: 0.05, lead: "koto", reg: 0, range: [2, 9], len: [4, 6], rest: [2, 4], rhythm: [1, 0.5, 0.5, 1, 1.5], perc: "sparse", rin: 0, wet: 0.3 },
    ahead: { scale: "minyo", bpm: 78, rub: 0.03, lead: "koto", answer: true, reg: 0, range: [3, 10], len: [4, 6], rest: [2, 3], rhythm: [0.5, 0.5, 1, 0.5, 1], perc: "shime", rin: 0, wet: 0.28 },
    behind: { scale: "miyako", bpm: 60, rub: 0.1, lead: "koto", answer: true, reg: 0, range: [0, 5], len: [3, 5], rest: [2, 5], rhythm: [1, 1.5, 1, 2], oshide: 0.45, sho: true, shoVel: 0.12, perc: "none", rin: 0, wet: 0.38 },
    mateWin: { scale: "minyo", bpm: 80, bpmEnd: 92, accel: 1, rub: 0, lead: "koto", reg: 0, range: [4, 11], len: [4, 6], rest: [1, 3], rhythm: [0.5, 0.5, 1, 0.5, 1], sararin: true, perc: "jiuchi", rin: 16, wet: 0.25 },
    mateLose: { scale: "miyako", bpm: 54, bpmEnd: 46, accel: -0.6, rub: 0.08, lead: "shaku", reg: 0, range: [0, 4], len: [2, 4], rest: [3, 5], rhythm: [2, 1.5, 3], sho: true, shoVel: 0.09, perc: "heart", rin: 0, wet: 0.4 },
    byoyomi: { scale: "ritsu", bpm: 60, rub: 0, lead: null, sho: true, shoVel: 0.1, shoChord: [69, 74, 81], perc: "clock", rin: 0, wet: 0.2, duck: 0.6 },
    review: { scale: "ritsu", bpm: 48, rub: 0.15, lead: "koto", reg: 0, range: [1, 8], len: [3, 5], rest: [4, 8], rhythm: [1, 1.5, 2, 1], sho: true, shoVel: 0.09, perc: "none", rin: 32, wet: 0.55 },
    tsume: { scale: "miyako", bpm: 50, rub: 0.3, lead: "shaku", reg: 0, range: [2, 8], len: [2, 4], rest: [3, 6], rhythm: [2, 3, 1.5, 4], perc: "none", rin: 0, wet: 0.5 },
    tutorial: { scale: "minyo", bpm: 84, rub: 0.02, lead: "koto", reg: 0, range: [5, 10], len: [4, 4], rest: [2, 2], rhythm: [0.5, 0.5, 1], motif: true, perc: "suzu", rin: 0, wet: 0.25 },
  };
  const KAKU_TARGET = { ritsu: [2, 3], minyo: [2, 3], miyako: [3] }; // 前句の止め(核音ソ・ラ。都節はラ = シ♭から下りる)
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const deg = (i) => ((i % 5) + 5) % 5;
  function noteOf(sc, reg, i) { return TONIC + reg + 12 * Math.floor(i / 5) + sc.off[deg(i)]; }
  // 旋律の歩み: 順次進行を多めに、跳躍は3度程度まで
  function stepOnce(i, lo, hi) {
    const r = Math.random();
    const s = r < 0.3 ? -1 : r < 0.6 ? 1 : r < 0.72 ? -2 : r < 0.84 ? 2 : r < 0.92 ? 0 : (Math.random() < 0.5 ? -3 : 3);
    let n = i + s;
    if (n < lo) n = lo + (lo - n);
    if (n > hi) n = hi - (n - hi);
    return Math.max(lo, Math.min(hi, n));
  }
  function nearestDeg(i, d, lo, hi) {
    let best = null;
    for (let j = lo; j <= hi; j++) if (deg(j) === d && (best == null || Math.abs(j - i) < Math.abs(best - i))) best = j;
    return best == null ? i : best;
  }
  function makePhrase(scn, start, closing) {
    const lo = scn.range[0], hi = scn.range[1], len = rnd(scn.len[0], scn.len[1]);
    const target = closing ? 0 : pick(KAKU_TARGET[scn.scale]);
    const idx = [];
    let i = start;
    for (let n = 0; n < len; n++) {
      if (n === len - 1) i = nearestDeg(i, target, lo, hi);
      else if (n === len - 2 && scn.scale === "miyako") i = Math.min(hi, nearestDeg(i, target, lo, hi - 1) + 1); // 半音上から核音へ
      else i = stepOnce(i, lo, hi);
      idx.push(i);
    }
    return idx;
  }

  let M = null; // 再生中の BGM の状態
  function bgmLevel(scn) { return prefs.bgmVolume * 0.55 * ((scn && scn.duck) || 1); }

  function bgmStart(key) {
    const k = kit(true);
    if (!k) return;
    const scn = SCENES[key], now = k.ctx.currentTime + 0.15;
    k.bgm.gain.cancelScheduledValues(k.ctx.currentTime);
    k.bgm.gain.setValueAtTime(Math.max(0.0001, k.bgm.gain.value), k.ctx.currentTime);
    k.bgm.gain.linearRampToValueAtTime(bgmLevel(scn), k.ctx.currentTime + 1.5);
    M = { key, scn, pending: null, bpm: scn.bpm, nextPhrase: now, nextStep: now, step: 0, bar: 0, beat: 0,
      cur: scn.range ? Math.round((scn.range[0] + scn.range[1]) / 2) : 5, phraseNo: 0, phraseEnd: now, nextSho: now, shoIdx: 0, motif: null };
    bgmApply(scn, key);
    M.iv = setInterval(bgmSched, 25);
  }
  function bgmApply(scn, key) {
    const k = K;
    M.scn = scn; M.key = key; M.bpm = scn.bpm; M.motif = null;
    M.out = bus(k, scn.wet, true);
    M.pout = bus(k, 0.18, true);
    k.bgm.gain.setTargetAtTime(bgmLevel(scn), k.ctx.currentTime, 0.4);
  }
  function bgmStop() {
    if (!M) return;
    clearInterval(M.iv);
    M = null;
    if (K) {
      const t = K.ctx.currentTime;
      K.bgm.gain.cancelScheduledValues(t);
      K.bgm.gain.setValueAtTime(Math.max(0.0001, K.bgm.gain.value), t);
      K.bgm.gain.linearRampToValueAtTime(0.0001, t + 1.2);
    }
  }
  function bgmSched() {
    const k = K, m = M;
    if (!k || !m) return;
    const now = k.ctx.currentTime;
    if (m.pending && now > m.phraseEnd) m.nextPhrase = Math.min(m.nextPhrase, now + 0.25);
    if (m.nextPhrase < now + 0.2) {
      if (m.pending) { bgmApply(SCENES[m.pending], m.pending); m.pending = null; }
      bgmPhrase(m.nextPhrase);
    }
    while (m.nextStep < now + 0.2) {
      bgmPulse(m.nextStep, m.step);
      m.nextStep += 30 / m.bpm;
      m.step = (m.step + 1) % 8;
      if (m.step === 0) {
        m.bar++;
        const s = m.scn;
        if (s.accel) m.bpm = s.accel > 0 ? Math.min(s.bpmEnd, m.bpm + s.accel) : Math.max(s.bpmEnd, m.bpm + s.accel);
      }
    }
    if (m.scn.sho && m.nextSho < now + 0.2) {
      const chord = m.scn.shoChord || SC[m.scn.scale].sho[m.shoIdx++ % 2];
      const at = Math.max(now, m.nextSho);
      sho(k, bus(k, 0.5, true), chord.map(midi), at, 9.5, m.scn.shoVel || 0.18);
      m.nextSho = at + 8; // 1.5秒重ねて和音を移す(笙の手移り)
    } else if (!m.scn.sho) m.nextSho = Math.max(m.nextSho, now);
  }
  function bgmPhrase(t0) {
    const k = K, m = M, scn = m.scn, sc = SC[scn.scale], beat = 60 / m.bpm;
    if (!scn.lead) { m.nextPhrase = m.phraseEnd = t0 + 4 * beat; return; }
    const closing = m.phraseNo % 2 === 1;
    let idx;
    if (scn.motif) { // 同じ短い動機を少しずつ変えて繰り返す(覚えやすさ)
      if (!m.motif || m.phraseNo % 4 === 0) m.motif = makePhrase(scn, m.cur, closing);
      const shift = m.phraseNo % 4 === 2 ? 1 : 0;
      idx = m.motif.map((v) => Math.min(scn.range[1], v + shift));
      idx[idx.length - 1] = nearestDeg(idx[idx.length - 1], closing ? 0 : 3, scn.range[0], scn.range[1]);
    } else idx = makePhrase(scn, m.cur, closing);
    let t = t0;
    const out = m.out;
    if (scn.sararin) { for (let g = 0; g < 5; g++) pluck(k, out, midi(noteOf(sc, scn.reg, scn.range[0] + g)), t + g * 0.035, 0.1, { dur: 0.8 }); t += 0.25; }
    idx.forEach((i, n) => {
      const last = n === idx.length - 1, note = noteOf(sc, scn.reg, i);
      const dur = last ? pick([2, 2.5, 3]) : pick(scn.rhythm);
      const len = dur * beat * (1 + scn.rub * (Math.random() * 2 - 1));
      if (scn.lead === "koto") {
        const opt = { dur: Math.max(0.8, len * 1.6) };
        if (scn.oshide && dur >= 1.5 && Math.random() < scn.oshide) {
          opt.bend = sc.off[(deg(i) + 1) % 5] - sc.off[deg(i)] === 1 ? 1 : 2; opt.bendAt = beat * 0.5;
        }
        pluck(k, out, midi(note), t, 0.26 + Math.random() * 0.05, opt);
        if (n === 0 && Math.random() < 0.35) pluck(k, out, midi(note + 12), t + 0.012, 0.12, { dur: 1.4 }); // 掻き手(上のオクターブ)
      } else {
        shaku(k, out, midi(note), t, Math.max(0.5, len * 0.92), 0.11, Math.random() < 0.5 ? 1 : 0.4);
      }
      t += len;
    });
    m.cur = idx[idx.length - 1];
    m.phraseEnd = t;
    if (scn.answer) { // 尺八の合いの手
      const ai = nearestDeg(m.cur + 2, 2, 0, 12), aReg = Math.max(0, scn.reg);
      let at = t + beat * 0.5;
      [stepOnce(ai, 4, 10), nearestDeg(ai, closing ? 0 : 3, 4, 10)].forEach((i, n) => {
        const l = (n === 1 ? 2 : 1) * beat;
        shaku(k, out, midi(noteOf(sc, aReg, i)), at, l * 0.95, 0.095, 0.6);
        at += l;
      });
      t = at;
    }
    m.phraseNo++;
    m.nextPhrase = t + rnd(scn.rest[0], scn.rest[1]) * beat;
  }
  function bgmPulse(t, step) {
    const k = K, m = M, scn = m.scn, out = m.pout, p = scn.perc;
    if (step % 2 === 0) m.beat++;
    if (p === "sparse" && step === 0 && m.bar % 2 === 0) PERC.don(k, out, t, 0.3);
    if (p === "shime") { const v = { 0: 0.24, 3: 0.15, 4: 0.2, 6: 0.13 }[step]; if (v) PERC.ten(k, out, t, v); }
    if (p === "jiuchi") { if (step === 0) PERC.don(k, out, t, 0.42); else if (step === 4) PERC.don(k, out, t, 0.26); else if (step === 6) PERC.ka(k, out, t, 0.16); }
    if (p === "heart" && step % 2 === 0) { PERC.don(k, out, t, 0.36); PERC.don(k, out, t + 0.28, 0.18); }
    if (p === "clock" && step % 2 === 0) PERC.don(k, out, t, 0.26);
    if (p === "suzu" && step === 0 && m.bar % 2 === 0) PERC.suzu(k, out, t, 0.9);
    if (scn.rin && step % 2 === 0 && m.beat % scn.rin === 1) rin(k, bus(k, 0.45, true), midi(86), t, 0.07);
  }

  // ---------------------------------------------------------------- 公開する口
  let wantScene = null; // 画面が望んでいる BGM の場面(音がオフのあいだも覚えておき、オンにしたら鳴らす)
  function syncBgm() {
    const key = soundOn() && prefs.bgm && !(global.document && global.document.hidden) ? wantScene : null;
    if (!key) { bgmStop(); return; }
    if (!SCENES[key]) return;
    if (!M) { bgmStart(key); return; }
    if (M.key === key) { M.pending = null; return; }
    M.pending = key; // 今のフレーズの切れ目で切り替える
  }
  if (global.document) global.document.addEventListener("visibilitychange", syncBgm);

  const Sound = {
    isOn: soundOn,
    isAsked() { return !!prefs.asked; },
    get(key) { return prefs[key]; },
    set(key, value) {
      prefs[key] = value;
      if (key === "on") prefs.asked = true;
      savePrefs();
      if (K && key === "volume") K.se.gain.setTargetAtTime(value, K.ctx.currentTime, 0.05);
      if (K && key === "bgmVolume" && M) K.bgm.gain.setTargetAtTime(bgmLevel(M.scn), K.ctx.currentTime, 0.1);
      if (key === "on" || key === "bgm") syncBgm();
    },
    setOn(on) {
      Sound.set("on", !!on);
      if (on) { const k = kit(true); if (k) SE.tap(k, k.ctx.currentTime + 0.01); }
    },
    // タップのたびに呼ぶ(以降は AI の手など、タップの外でも鳴らせる)
    unlock() { if (soundOn()) kit(true); },
    play(name, delaySec, arg) {
      if (!soundOn() || !SE[name]) return;
      const k = kit(true);
      if (!k) return;
      try { SE[name](k, k.ctx.currentTime + 0.01 + (delaySec || 0), arg); } catch (e) { /* 音が出せなくても対局は続く */ }
    },
    vibrate(ms) {
      if (!prefs.vibrate || !global.navigator || !global.navigator.vibrate) return;
      try { global.navigator.vibrate(ms); } catch (e) { /* 振動できない端末 */ }
    },
    canVibrate() { return !!(global.navigator && global.navigator.vibrate); },
    // 画面の BGM の場面を伝える(null で止める)
    bgm(key) { wantScene = key || null; syncBgm(); },
    bgmScene() { return M ? (M.pending || M.key) : null; },
    // 設定画面の試聴: 律音階のひとふし(最後は核音ラ→主音レ)
    previewBgm() {
      if (!soundOn()) return;
      const k = kit(true);
      if (!k) return;
      const t = k.ctx.currentTime + 0.05, o = bus(k, 0.35);
      const g = k.ctx.createGain(); g.gain.value = prefs.bgmVolume * 0.9 / Math.max(0.05, prefs.volume); g.connect(o);
      [[62, 0], [64, 0.32], [67, 0.64], [69, 0.96], [71, 1.6], [69, 1.92], [62, 2.4]].forEach(([n, d]) => pluck(k, g, midi(n), t + d, 0.3, { dur: 1.6 }));
    },
    SCENE_KEYS: Object.keys(SCENES),
  };

  global.HasamiSound = Sound;
})(typeof window !== "undefined" ? window : globalThis);
