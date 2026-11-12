'use strict';
/* =====================================================================
 * TURBO RACER · 极速狂飙  v2.0 —— 街机检查点赛车
 *
 * 核心架构：
 *  - 分段式伪 3D 赛道引擎（弯道 / S 弯 / 坡道 / 丘陵 + 离心力）
 *  - 程序化无尽赛道生成，检查点推进关卡
 *  - 昼夜主题循环（正午 → 落日 → 午夜 → 黎明），午夜车头灯锥
 *  - 街机计时制：时间耗尽结束，冲检查点续命
 *  - NOS 氮气：贴身超车 / 吸尾流充能，Shift 释放
 *  - WebAudio：换挡声浪 / 氮气啸声 / 超车呼啸 / 检查点音阶
 * ===================================================================== */

/* ---------------- 工具 ---------------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[randi(0, arr.length - 1)];
const moveToward = (v, target, maxDelta) => {
  const d = target - v;
  return Math.abs(d) <= maxDelta ? target : v + Math.sign(d) * maxDelta;
};
const easeIn = (a, b, p) => a + (b - a) * p * p;
const easeInOut = (a, b, p) => a + (b - a) * ((-Math.cos(p * Math.PI) / 2) + 0.5);

function hexRGB(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lerpColor(a, b, t) {
  const A = hexRGB(a), B = hexRGB(b);
  return `rgb(${Math.round(lerp(A[0], B[0], t))},${Math.round(lerp(A[1], B[1], t))},${Math.round(lerp(A[2], B[2], t))})`;
}
function shade(hex, f) {
  const [r, g, b] = hexRGB(hex);
  return `rgb(${clamp(Math.round(r * f), 0, 255)},${clamp(Math.round(g * f), 0, 255)},${clamp(Math.round(b * f), 0, 255)})`;
}

/* ---------------- 音效系统 ---------------- */
const AudioSys = {
  ctx: null, master: null, engine: null, engineGain: null,
  nitroGain: null, muted: false,
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
      // 引擎：双振荡器
      const o1 = this.ctx.createOscillator();
      const o2 = this.ctx.createOscillator();
      o1.type = 'sawtooth'; o2.type = 'square'; o2.detune.value = 9;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 900;
      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.value = 0;
      o1.connect(lp); o2.connect(lp);
      lp.connect(this.engineGain); this.engineGain.connect(this.master);
      o1.start(); o2.start();
      this.engine = [o1, o2];
      // 氮气：循环白噪 + 带通
      const nb = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      const ns = this.ctx.createBufferSource();
      ns.buffer = nb; ns.loop = true;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.8;
      this.nitroGain = this.ctx.createGain();
      this.nitroGain.gain.value = 0;
      ns.connect(bp); bp.connect(this.nitroGain); this.nitroGain.connect(this.master);
      ns.start();
    } catch (e) { /* 静默降级 */ }
  },
  // 换挡声浪：5 个挡位内转速循环
  setEngine(speedPct, on, boosting) {
    if (!this.ctx || !this.engine) return;
    const t = this.ctx.currentTime;
    const g = Math.min(4, Math.floor(speedPct * 5));
    const rpm = speedPct * 5 - g;
    let f = 52 + rpm * 118 + g * 26;
    if (boosting) f *= 1.22;
    this.engine[0].frequency.setTargetAtTime(f, t, 0.05);
    this.engine[1].frequency.setTargetAtTime(f * 0.5, t, 0.05);
    const vol = on && !this.muted ? 0.04 + speedPct * 0.075 : 0;
    this.engineGain.gain.setTargetAtTime(vol, t, 0.1);
  },
  setNitro(on) {
    if (!this.ctx || !this.nitroGain) return;
    this.nitroGain.gain.setTargetAtTime(on && !this.muted ? 0.11 : 0, this.ctx.currentTime, 0.08);
  },
  beep(freq, dur = 0.12, vol = 0.25, type = 'square') {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  noiseBurst(dur, f0, f1, vol) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(f0, t);
    bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(t);
  },
  whoosh() { this.noiseBurst(0.28, 350, 2600, 0.35); },
  jingle() {
    this.beep(660, 0.1, 0.22); 
    setTimeout(() => this.beep(880, 0.1, 0.22), 110);
    setTimeout(() => this.beep(1320, 0.22, 0.25), 220);
  },
  crash() {
    if (!this.ctx || this.muted) return;
    this.noiseBurst(0.65, 900, 120, 0.85);
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.55);
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.65);
  },
  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }
};

/* ---------------- 画布 ---------------- */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resize);
resize();

/* ---------------- 世界常量 ----------------
 * 单位约定：1 段 = 200 单位；路面半宽 = 900 单位
 * 摄像机高 1000，FOV 100°；最大速度 12000 单位/秒(60 段/秒)
 * 显示时速：满速映射为 300 km/h
 */
const SEG_LEN = 200;
const ROAD_W = 900;
const CAM_H = 1000;
const CAM_D = 1 / Math.tan((100 / 2) * Math.PI / 180);   // ≈ 0.8391
const PLAYER_Z = CAM_H * CAM_D;                          // 玩家车在镜头前方距离 ≈ 839
const COCKPIT_H = 430;                                   // 驾驶舱视角镜头高度
const DRAW_DIST = 160;                                   // 绘制段数
const FOG_DENSITY = 6;
const MAX_SPEED = 12000;
const ACCEL = MAX_SPEED / 5;
const BRAKE = -MAX_SPEED;
const DECEL = -MAX_SPEED / 5;
const OFF_DECEL = -MAX_SPEED / 1.8;
const OFF_LIMIT = MAX_SPEED / 4;
const CENTRIFUGAL = 0.31;
const M_PER_UNIT = (300 / 3.6) / MAX_SPEED;              // 显示用：单位→米
const LANE_X = [-2 / 3, 0, 2 / 3];

const TREE_COLORS = ['#2f7d32', '#3a8f3e', '#2a6e2d', '#419a45', '#357a3b'];
const BILL_COLORS = ['#e74c3c', '#2980b9', '#8e44ad', '#16a085', '#d35400'];
const BILL_TEXTS = ['TURBO', 'NOS', '极速', '弯道王', '冲！'];
const TRAFFIC_COLORS = ['#3b6fd4', '#e6a23c', '#7a5af5', '#2ba84a', '#e8e8e8', '#f56aa0', '#26c6da', '#8d6e63'];

/* ---------------- 主题（昼夜循环） ---------------- */
const THEMES = [
  { name: '正午高速', skyTop: '#2a63c8', skyBot: '#a8d8f0', sun: '#fff3c4', grass1: '#5a9247', grass2: '#548a41', road1: '#45484d', road2: '#404349', rumble1: '#e8e8ea', rumble2: '#c0392b', lane: '#e8e8ea', fog: '#b8ccd8', mtFar: '#7d9b6e', mtNear: '#5c7d52', dark: 0 },
  { name: '落日大道', skyTop: '#4a3070', skyBot: '#ff9e5e', sun: '#ffcf7a', grass1: '#4d7038', grass2: '#476633', road1: '#3c3a44', road2: '#373540', rumble1: '#d8c8c0', rumble2: '#a8324a', lane: '#d8d0c8', fog: '#c89070', mtFar: '#6b5a7d', mtNear: '#4d4066', dark: 0.25 },
  { name: '午夜疾驰', skyTop: '#070c22', skyBot: '#1c2a52', sun: '#e8ecf5', grass1: '#17251c', grass2: '#141f18', road1: '#22252a', road2: '#1f2227', rumble1: '#7a7f8a', rumble2: '#5a2530', lane: '#8a8f9a', fog: '#0e1526', mtFar: '#141c30', mtNear: '#0e1424', dark: 1 },
  { name: '黎明海岸', skyTop: '#3a5d9e', skyBot: '#ffd7a8', sun: '#ffe8b0', grass1: '#3f6b3a', grass2: '#3a6436', road1: '#3a3d42', road2: '#363940', rumble1: '#d0cec8', rumble2: '#a04038', lane: '#c8c8c8', fog: '#c0b0a8', mtFar: '#5d7d9e', mtNear: '#48688a', dark: 0.15 },
];
function lerpTheme(A, B, t) {
  const o = { name: t < 0.5 ? A.name : B.name };
  for (const k of ['skyTop', 'skyBot', 'sun', 'grass1', 'grass2', 'road1', 'road2', 'rumble1', 'rumble2', 'lane', 'fog', 'mtFar', 'mtNear']) {
    o[k] = lerpColor(A[k], B[k], t);
  }
  o.dark = lerp(A.dark, B.dark, t);
  return o;
}

/* ---------------- 游戏状态 ---------------- */
const HS_KEY = 'turbo-racer-hs2';
function loadHS() { try { return +(localStorage.getItem(HS_KEY) || 0) || 0; } catch (e) { return 0; } }
function saveHS(v) { try { localStorage.setItem(HS_KEY, String(v)); } catch (e) { /* 忽略 */ } }

const G = {
  state: 'menu',        // menu | countdown | playing | crash | gameover | paused
  position: 0, speed: 0, playerX: 0, steerVis: 0, playerY: 0,
  cockpit: false, viewBlend: 0,   // 驾驶舱视角（0 追尾 → 1 舱内）
  timeLeft: 55, stage: 1, cpIndex: 0, stageStartSeg: 0,
  score: 0, combo: 0, comboTimer: 0,
  nos: 40, boosting: false, draft: false,
  cars: [], particles: [], texts: [],
  shake: 0, timeScale: 1, crashT: 0, spin: 0, spinV: 0,
  countdownT: 0, lastCount: 4, goT: 0,
  topSpeed: 0, finalScore: 0,
  highScore: loadHS(),
  keys: {}, touchSteer: 0, touchNos: false, isTouch: false,
  bgOffset: 0, bannerT: 0, bannerMain: '', bannerSub: '',
  lastTickSec: -1, elapsed: 0,
};

/* ---------------- 赛道数据 ---------------- */
let segments = [];      // 窗口化段数组
let baseIndex = 0;      // segments[0] 的绝对段号
let genIndex = 0;       // 下一个待生成的绝对段号
let lastY = 0;          // 生成器：当前路面高程
let checkpoints = [];   // 检查点绝对段号（有序）
let genStage = 0;       // 已生成到的关卡数

function segAt(abs) {
  const i = abs - baseIndex;
  return (i >= 0 && i < segments.length) ? segments[i] : null;
}
function segYAt(abs) {
  const s = segAt(abs);
  return s ? s.y : lastY;
}
function findSegment(z) {
  return segAt(Math.floor(z / SEG_LEN)) || segments[0];
}

function addSegment(curve, y, checkpoint) {
  const seg = { index: genIndex, curve, y, checkpoint: !!checkpoint, sprites: [], cars: [], vis: false };
  genIndex++;
  segments.push(seg);
  // 路旁散景
  if (Math.random() < 0.15) {
    seg.sprites.push({ type: 'tree', off: (Math.random() < 0.5 ? -1 : 1) * rand(1.4, 3.2), s: rand(0.75, 1.35), c: pick(TREE_COLORS) });
  }
  if (Math.random() < 0.02) {
    seg.sprites.push({ type: 'bill', off: (Math.random() < 0.5 ? -1 : 1) * rand(1.6, 2.3), c: pick(BILL_COLORS), txt: pick(BILL_TEXTS) });
  }
  return seg;
}

function addRoad(enter, hold, leave, curve, dy) {
  const startY = lastY, endY = startY + dy;
  const total = enter + hold + leave;
  for (let i = 0; i < enter; i++) addSegment(easeIn(0, curve, i / enter), easeInOut(startY, endY, i / total));
  for (let i = 0; i < hold; i++) addSegment(curve, easeInOut(startY, endY, (enter + i) / total));
  for (let i = 0; i < leave; i++) addSegment(easeInOut(curve, 0, i / leave), easeInOut(startY, endY, (enter + hold + i) / total));
  lastY = endY;
}

function generateStage() {
  genStage++;
  const d = Math.min(1, (genStage - 1) / 7);   // 难度系数
  addRoad(30, 60, 30, 0, 0);                   // 起步直道
  const n = 7 + randi(0, 3);
  for (let i = 0; i < n; i++) {
    const r = Math.random();
    if (r < 0.34) {                            // 弯道（可带坡）
      const c = rand(1.6, 2.4 + 3.6 * d) * (Math.random() < 0.5 ? -1 : 1);
      addRoad(randi(20, 35), randi(30, 60), randi(20, 35), c, rand(-0.5, 0.5) * SEG_LEN * rand(6, 18) * (0.5 + d));
    } else if (r < 0.56) {                     // S 弯
      const c = rand(1.6, 2.2 + 2.6 * d);
      addRoad(20, 30, 20, c, 0);
      addRoad(20, 30, 20, -c, rand(-1, 1) * SEG_LEN * 8);
    } else if (r < 0.76) {                     // 大坡
      addRoad(30, 40, 30, rand(-0.8, 0.8), rand(0.5, 1) * SEG_LEN * rand(14, 34) * (Math.random() < 0.5 ? -1 : 1) * (0.5 + d));
    } else {                                   // 直道
      addRoad(20, randi(30, 60), 20, 0, rand(-1, 1) * SEG_LEN * 6);
    }
  }
  addRoad(20, 30, 20, 0, 0);                   // 冲线前直道
  const cp = addSegment(0, lastY, true);       // 检查点段
  checkpoints.push(cp.index);
}

function ensureGenerated(uptoAbs) {
  while (genIndex < uptoAbs) generateStage();
}
function trimSegments(playerAbs) {
  const excess = playerAbs - baseIndex - 300;
  if (excess > 0) {
    segments.splice(0, excess);
    baseIndex += excess;
  }
}

function buildWorld() {
  segments = []; baseIndex = 0; genIndex = 0; lastY = 0; checkpoints = []; genStage = 0;
  generateStage();
  generateStage();
  generateStage();
}

/* ---------------- 星空 / 山脊（预生成） ---------------- */
const stars = [];
for (let i = 0; i < 110; i++) stars.push({ x: Math.random(), y: Math.random() * 0.42, r: rand(0.5, 1.6), tw: rand(0, 6.28) });

function makeRidge(n, base, amp) {
  const pts = [];
  let y = base;
  for (let i = 0; i <= n; i++) {
    y = clamp(y + rand(-1, 1) * amp * 0.5, base - amp, base + amp * 0.4);
    pts.push(y);
  }
  return pts;
}
const ridgeFar = makeRidge(48, 0.055, 0.045);
const ridgeNear = makeRidge(48, 0.028, 0.035);

/* ---------------- 车流 ---------------- */
function spawnTraffic() {
  const type = Math.random() < 0.16 ? 'truck' : 'car';
  const lane = pick(LANE_X);
  const z = G.position + DRAW_DIST * SEG_LEN * rand(0.85, 0.98);
  // 避免同位重叠
  for (const c of G.cars) {
    if (Math.abs(c.z - z) < 1500 && Math.abs(c.laneX - lane) < 0.4) return false;
  }
  G.cars.push({
    z, laneX: lane, targetLane: lane,
    speed: MAX_SPEED * (type === 'truck' ? rand(0.2, 0.3) : rand(0.27, 0.52 + Math.min(0.12, G.stage * 0.01))),
    type, color: pick(TRAFFIC_COLORS),
    passed: false, laneTimer: rand(4, 11),
    halfLen: type === 'truck' ? 620 : 240,
    halfW: type === 'truck' ? 0.26 : 0.21,
  });
  return true;
}

function updateTraffic(dt) {
  const pz = G.position + PLAYER_Z;
  const target = G.state === 'menu' ? 9 : Math.min(24, 9 + G.stage * 2);
  let tries = 0;
  while (G.cars.length < target && tries++ < 6) spawnTraffic();

  for (let i = G.cars.length - 1; i >= 0; i--) {
    const c = G.cars[i];
    c.z += c.speed * dt;

    // AI：前方同车道有慢车 → 跟随或变道
    let ahead = null;
    for (const o of G.cars) {
      if (o !== c && o.z > c.z && o.z - c.z < 2600 && Math.abs(o.laneX - c.targetLane) < 0.35) { ahead = o; break; }
    }
    if (ahead && c.speed > ahead.speed) {
      c.speed = lerp(c.speed, ahead.speed * 0.96, Math.min(1, 2 * dt));
      if (c.laneTimer <= 0) {
        const options = LANE_X.filter(l => Math.abs(l - c.laneX) > 0.3 && !(Math.abs(l - G.playerX) < 0.4 && Math.abs(c.z - pz) < 2000));
        if (options.length) { c.targetLane = pick(options); c.laneTimer = rand(5, 10); }
      }
    } else {
      // 随机变道（难度随关卡提升）
      c.laneTimer -= dt;
      if (c.laneTimer <= 0) {
        c.laneTimer = rand(5, 11);
        if (G.state === 'playing' && G.stage > 2 && Math.random() < 0.5) {
          const options = LANE_X.filter(l => Math.abs(l - c.laneX) > 0.3 && !(Math.abs(l - G.playerX) < 0.4 && Math.abs(c.z - pz) < 2000));
          if (options.length) c.targetLane = pick(options);
        }
      }
    }
    c.laneX = lerp(c.laneX, c.targetLane, Math.min(1, 0.8 * dt));

    // 超车 / 碰撞（仅比赛中）
    if (G.state === 'playing') {
      const dz = c.z - pz;
      const dx = Math.abs(c.laneX - G.playerX);
      if (Math.abs(dz) < c.halfLen + 240 && dx < c.halfW + 0.17) { doCrash(); return; }
      if (!c.passed && dz < -(c.halfLen + 240)) {
        c.passed = true;
        if (dx < 0.55) nearMiss(c);
      }
      // 吸尾流充能
      if (dz > 0 && dz < 2300 && dx < 0.4) G.draft = true;
    }

    if (c.z < G.position - 2000 || c.z > G.position + DRAW_DIST * SEG_LEN + 6000) G.cars.splice(i, 1);
  }
}

function nearMiss(c) {
  G.combo++;
  G.comboTimer = 3;
  const bonus = 150 * G.combo;
  G.score += bonus;
  G.nos = Math.min(100, G.nos + 15);
  AudioSys.whoosh();
  addText(`+${bonus} 超车!`, W / 2 + rand(-60, 60), H * 0.5, G.combo > 2 ? '#ff7043' : '#ffcf3f');
}

function addText(txt, x, y, color) {
  G.texts.push({ txt, x, y, life: 1.1, maxLife: 1.1, color: color || '#ffcf3f' });
}

/* ---------------- 输入 ---------------- */
window.addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  if (e.repeat) return;
  G.keys[e.code] = true;
  AudioSys.ensure();
  if (e.code === 'Enter' || e.code === 'Space') {
    if (G.state === 'menu' || G.state === 'gameover') start();
  }
  if (e.code === 'KeyP' || e.code === 'Escape') togglePause();
  if (e.code === 'KeyM') updateMuteBtn(AudioSys.toggleMute());
  if (e.code === 'KeyC') toggleView();
});
window.addEventListener('keyup', (e) => { G.keys[e.code] = false; });

function updateTouches(e) {
  G.touchSteer = 0;
  for (const t of e.touches) {
    if (t.clientX && t.clientY > H * 0.7 && t.clientX > W * 0.7) continue; // NOS 按钮区域
    G.touchSteer += t.clientX < W / 2 ? -1 : 1;
  }
  G.touchSteer = clamp(G.touchSteer, -1, 1);
}
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  AudioSys.ensure();
  G.isTouch = true;
  $('nosBtn').classList.add('show');
  if (G.state === 'menu' || G.state === 'gameover') { start(); return; }
  updateTouches(e);
}, { passive: false });
canvas.addEventListener('touchmove', (e) => { e.preventDefault(); updateTouches(e); }, { passive: false });
canvas.addEventListener('touchend', updateTouches);
canvas.addEventListener('touchcancel', updateTouches);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && G.state === 'playing') togglePause();
});

function throttleInput() {
  return !!(G.keys['ArrowUp'] || G.keys['KeyW'] || (G.isTouch && (G.state === 'playing' || G.state === 'countdown')));
}
function brakeInput() { return !!(G.keys['ArrowDown'] || G.keys['KeyS']); }
function steerInput() {
  let s = 0;
  if (G.keys['ArrowLeft'] || G.keys['KeyA']) s -= 1;
  if (G.keys['ArrowRight'] || G.keys['KeyD']) s += 1;
  return clamp(s + G.touchSteer, -1, 1);
}
function nosInput() {
  return !!(G.keys['ShiftLeft'] || G.keys['ShiftRight'] || G.touchNos);
}

/* ---------------- 流程 ---------------- */
const $ = (id) => document.getElementById(id);
function show(id) { for (const s of ['menu', 'gameover', 'pause']) $(s).classList.toggle('hidden', s !== id); }
function hideAll() { for (const s of ['menu', 'gameover', 'pause']) $(s).classList.add('hidden'); }

function start() {
  buildWorld();
  Object.assign(G, {
    state: 'countdown', countdownT: 3.6, lastCount: 4, goT: 0,
    position: 0, speed: 0, playerX: 0, steerVis: 0,
    timeLeft: 55, stage: 1, cpIndex: 0, stageStartSeg: 0,
    score: 0, combo: 0, comboTimer: 0, nos: 40, boosting: false,
    cars: [], particles: [], texts: [],
    shake: 0, timeScale: 1, crashT: 0, spin: 0, spinV: 0,
    topSpeed: 0, bannerT: 0, lastTickSec: -1, elapsed: 0, draft: false,
  });
  for (let i = 0; i < 9; i++) spawnTraffic();
  hideAll();
  AudioSys.ensure();
}

function doCrash() {
  if (G.state !== 'playing') return;
  G.state = 'crash';
  G.crashT = 1.7;
  G.spin = 0;
  G.spinV = rand(8, 11) * (Math.random() < 0.5 ? -1 : 1);
  G.shake = 20;
  G.timeScale = 0.4;
  G.combo = 0;
  G.speed = 0;
  AudioSys.crash();
  AudioSys.setNitro(false);
  const { px, py, pw } = playerScreenPos();
  for (let i = 0; i < 50; i++) {
    G.particles.push({
      x: px + rand(-pw, pw) * 0.6, y: py + rand(-pw, pw) * 0.5,
      vx: rand(-280, 280), vy: rand(-380, 60), g: 560,
      life: rand(0.5, 1.2), maxLife: 1.2, size: rand(3, 9),
      color: pick(['#ff9f43', '#ee5253', '#feca57', '#576574', '#ffd8a8'])
    });
  }
}

function checkpoint() {
  G.stage++;
  G.cpIndex++;
  G.stageStartSeg = checkpoints[G.cpIndex - 1] || 0;
  const bonus = clamp(26 - G.stage * 1.2, 12, 26);
  G.timeLeft += bonus;
  G.score += 500 * G.stage;
  G.nos = Math.min(100, G.nos + 25);
  G.bannerMain = `STAGE ${G.stage}`;
  G.bannerSub = THEMES[(G.stage - 1) % 4].name + `　+${bonus.toFixed(0)}s`;
  G.bannerT = 2.6;
  AudioSys.jingle();
}

function gameOver() {
  G.state = 'gameover';
  G.finalScore = Math.floor(G.score);
  const isRecord = G.finalScore > G.highScore;
  if (isRecord) { G.highScore = G.finalScore; saveHS(G.highScore); }
  $('goTitle').textContent = '⏰ 时间到！';
  $('finalScore').textContent = G.finalScore.toLocaleString();
  $('finalStage').textContent = G.stage;
  $('finalDist').textContent = (G.position * M_PER_UNIT / 1000).toFixed(2) + ' km';
  $('finalTop').textContent = Math.round(G.topSpeed / MAX_SPEED * 300) + ' km/h';
  $('newRecord').classList.toggle('hidden', !isRecord);
  show('gameover');
  AudioSys.setEngine(0, false);
  AudioSys.setNitro(false);
}

function togglePause() {
  if (G.state === 'playing') {
    G.state = 'paused';
    AudioSys.setEngine(0, false);
    AudioSys.setNitro(false);
    show('pause');
  } else if (G.state === 'paused') {
    G.state = 'playing';
    hideAll();
  }
}

function toggleView() {
  G.cockpit = !G.cockpit;
  $('viewBtn').classList.toggle('active', G.cockpit);
  $('viewBtn').textContent = G.cockpit ? '🚗' : '🎥';
}

/* ---------------- 更新 ---------------- */
function updatePlaying(dt) {
  const thr = throttleInput(), brk = brakeInput(), st = steerInput();
  const speedPct = G.speed / MAX_SPEED;
  const seg = findSegment(G.position + PLAYER_Z);

  // NOS
  const want = nosInput() && G.nos > 0 && G.speed > MAX_SPEED * 0.25;
  G.boosting = want;
  if (G.boosting) G.nos = Math.max(0, G.nos - 28 * dt);
  if (G.draft && !G.boosting) G.nos = Math.min(100, G.nos + 14 * dt);

  // 纵向
  if (thr) G.speed += ACCEL * dt * (G.boosting ? 1.9 : 1);
  else G.speed += DECEL * dt;
  if (brk) G.speed += BRAKE * dt;
  G.speed = clamp(G.speed, 0, G.boosting ? MAX_SPEED * 1.3 : MAX_SPEED);
  if (G.speed > G.topSpeed) G.topSpeed = G.speed;

  // 出界
  if (Math.abs(G.playerX) > 1) {
    if (G.speed > OFF_LIMIT) G.speed += OFF_DECEL * dt;
    G.shake = Math.max(G.shake, 5);
    if (Math.random() < 0.4) {
      const { px, py, pw } = playerScreenPos();
      G.particles.push({
        x: px + rand(-pw, pw), y: py + pw * 0.5,
        vx: rand(-40, 40), vy: rand(-90, -30), g: 60,
        life: rand(0.3, 0.7), maxLife: 0.7, size: rand(3, 7), color: '#b59a6b'
      });
    }
  }

  // 横向：转向 + 离心力
  const dxs = dt * 2 * speedPct;
  G.playerX -= dxs * speedPct * seg.curve * CENTRIFUGAL;
  G.playerX += dxs * st;
  G.playerX = clamp(G.playerX, -1.9, 1.9);
  G.steerVis = lerp(G.steerVis, st, Math.min(1, 10 * dt));

  // 前进
  G.position += G.speed * dt;
  G.elapsed += dt;
  G.score += G.speed * dt * 0.06 * (G.boosting ? 1.6 : 1);
  G.draft = false;
  updateTraffic(dt);
  if (G.state !== 'playing') return;

  // 检查点
  const playerAbs = Math.floor((G.position + PLAYER_Z) / SEG_LEN);
  while (G.cpIndex < checkpoints.length && playerAbs >= checkpoints[G.cpIndex]) {
    checkpoint();   // 内部已自增 cpIndex
  }
  ensureGenerated(playerAbs + DRAW_DIST + 400);
  trimSegments(playerAbs);

  // 倒计时
  G.timeLeft -= dt;
  const sec = Math.ceil(G.timeLeft);
  if (G.timeLeft < 5.5 && sec !== G.lastTickSec && sec > 0) {
    G.lastTickSec = sec;
    AudioSys.beep(1250, 0.07, 0.2);
  }
  if (G.timeLeft <= 0) { G.timeLeft = 0; gameOver(); return; }

  // 连击衰减
  if (G.comboTimer > 0) { G.comboTimer -= dt; if (G.comboTimer <= 0) G.combo = 0; }

  AudioSys.setEngine(speedPct, true, G.boosting);
  AudioSys.setNitro(G.boosting);
}

function update(dt, rdt, now) {
  switch (G.state) {
    case 'menu': {
      // 吸引模式：自动驾驶巡航
      G.speed = lerp(G.speed, MAX_SPEED * 0.68, Math.min(1, 0.8 * dt));
      const seg = findSegment(G.position + PLAYER_Z);
      const targetX = clamp(-seg.curve * 0.11, -0.55, 0.55);
      G.playerX = lerp(G.playerX, targetX, Math.min(1, 1.4 * dt));
      G.steerVis = lerp(G.steerVis, clamp((targetX - G.playerX) * 3, -1, 1), Math.min(1, 5 * dt));
      G.position += G.speed * dt;
      const playerAbs = Math.floor((G.position + PLAYER_Z) / SEG_LEN);
      ensureGenerated(playerAbs + DRAW_DIST + 400);
      trimSegments(playerAbs);
      updateTraffic(dt);
      AudioSys.setEngine(G.speed / MAX_SPEED, true, false);
      break;
    }
    case 'countdown': {
      G.countdownT -= rdt;
      const n = Math.ceil(Math.max(0, G.countdownT - 0.6));
      if (n !== G.lastCount) {
        G.lastCount = n;
        AudioSys.beep(n >= 1 ? 440 : 880, n >= 1 ? 0.12 : 0.4, 0.3);
      }
      G.steerVis = lerp(G.steerVis, steerInput(), Math.min(1, 10 * dt));
      G.playerX = clamp(G.playerX + steerInput() * 1.2 * dt, -1.5, 1.5);
      AudioSys.setEngine(throttleInput() ? 0.55 : 0.12, true, false);
      if (G.countdownT <= 0) {
        G.state = 'playing'; G.goT = 0.9;
        G.bannerMain = 'STAGE 1'; G.bannerSub = THEMES[0].name; G.bannerT = 2.2;
      }
      break;
    }
    case 'playing': {
      if (G.goT > 0) G.goT -= rdt;
      updatePlaying(dt);
      break;
    }
    case 'crash': {
      G.timeScale += (1 - G.timeScale) * Math.min(1, 3 * rdt);
      G.crashT -= rdt;
      G.spin += G.spinV * dt;
      G.spinV *= Math.exp(-1.2 * dt);
      G.timeLeft -= dt;                        // 撞车期间时间照走 —— 惩罚
      if (G.timeLeft <= 0) { G.timeLeft = 0; gameOver(); break; }
      updateTraffic(dt);
      if (Math.random() < 0.3) {
        const { px, py, pw } = playerScreenPos();
        G.particles.push({
          x: px + rand(-pw * 0.4, pw * 0.4), y: py - pw * 0.4,
          vx: rand(-25, 25), vy: rand(-110, -50), g: -30,
          life: rand(0.6, 1.3), maxLife: 1.3, size: rand(6, 14), color: 'rgba(90,90,95,0.6)'
        });
      }
      if (G.crashT <= 0) { G.state = 'playing'; G.spin = 0; }
      AudioSys.setEngine(0.1, true, false);
      break;
    }
  }
  updateParticles(dt);
  if (G.bannerT > 0) G.bannerT -= rdt;
  G.viewBlend = moveToward(G.viewBlend, G.cockpit ? 1 : 0, 4 * rdt);
  G.shake *= Math.exp(-6 * dt);
  G.bgOffset += findSegment(G.position + PLAYER_Z).curve * (G.speed / MAX_SPEED) * dt * 60;
}

function updateParticles(dt) {
  for (let i = G.particles.length - 1; i >= 0; i--) {
    const p = G.particles[i];
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt;
    p.life -= dt;
    if (p.life <= 0) G.particles.splice(i, 1);
  }
  for (let i = G.texts.length - 1; i >= 0; i--) {
    const t = G.texts[i];
    t.y -= 45 * dt; t.life -= dt;
    if (t.life <= 0) G.texts.splice(i, 1);
  }
}

/* ---------------- 绘制：基础图元 ---------------- */
function poly(x1, y1, x2, y2, x3, y3, x4, y4, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
  ctx.closePath();
  ctx.fill();
}
function rr(x, y, w, h, r) {
  rp(x, y, w, h, r);
  ctx.fill();
}
function rp(x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/* ---------------- 绘制：主题环境 ---------------- */
function drawSky(theme, now) {
  const g = ctx.createLinearGradient(0, 0, 0, H / 2 + 40);
  g.addColorStop(0, theme.skyTop);
  g.addColorStop(1, theme.skyBot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H / 2 + 40);

  // 星空
  if (theme.dark > 0.05) {
    for (const s of stars) {
      const a = theme.dark * (0.45 + 0.55 * Math.abs(Math.sin(now * 0.001 + s.tw)));
      ctx.globalAlpha = a;
      ctx.fillStyle = '#dfe8ff';
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 太阳 / 月亮（交叉淡入淡出）
  const sunA = clamp(1 - theme.dark * 1.4, 0, 1);
  if (sunA > 0.02) {
    const sx = W * 0.72, sy = H * 0.2;
    const sg = ctx.createRadialGradient(sx, sy, 4, sx, sy, 80);
    sg.addColorStop(0, theme.sun);
    sg.addColorStop(0.3, lerpColor('#000000', theme.sun, 0.55).replace('rgb', 'rgba').replace(')', ',0.55)'));
    sg.addColorStop(1, 'rgba(255,220,120,0)');
    ctx.globalAlpha = sunA;
    ctx.fillStyle = sg;
    ctx.fillRect(sx - 90, sy - 90, 180, 180);
    ctx.globalAlpha = 1;
  }
  if (theme.dark > 0.55) {
    const mx = W * 0.3, my = H * 0.16;
    ctx.globalAlpha = (theme.dark - 0.55) / 0.45;
    const mg = ctx.createRadialGradient(mx, my, 2, mx, my, 46);
    mg.addColorStop(0, 'rgba(235,240,250,0.95)');
    mg.addColorStop(0.5, 'rgba(200,215,240,0.25)');
    mg.addColorStop(1, 'rgba(200,215,240,0)');
    ctx.fillStyle = mg;
    ctx.fillRect(mx - 50, my - 50, 100, 100);
    ctx.fillStyle = '#e8ecf5';
    ctx.beginPath(); ctx.arc(mx, my, 17, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = theme.skyTop;
    ctx.beginPath(); ctx.arc(mx + 7, my - 4, 14, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // 云（白天可见）
  if (theme.dark < 0.6) {
    ctx.globalAlpha = (0.6 - theme.dark) / 0.6 * 0.8;
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 4; i++) {
      const cx = ((i * 0.27 + 0.1 + now * 0.000006 * (i + 1)) % 1.2 - 0.1) * W;
      const cy = H * (0.06 + i * 0.045);
      const s = 26 + i * 6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, s * 1.6, s * 0.5, 0, 0, Math.PI * 2);
      ctx.ellipse(cx - s, cy + s * 0.12, s * 0.85, s * 0.38, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + s, cy + s * 0.14, s * 0.95, s * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function drawMountains(theme) {
  const span = W * 2;
  for (const [ridge, color, par] of [[ridgeFar, theme.mtFar, 0.35], [ridgeNear, theme.mtNear, 0.7]]) {
    const off = ((-G.bgOffset * par) % span + span) % span;
    ctx.fillStyle = color;
    for (let rep = 0; rep < 2; rep++) {
      const x0 = -off + rep * span;
      ctx.beginPath();
      ctx.moveTo(x0, H / 2 + 4);
      const n = ridge.length - 1;
      for (let i = 0; i <= n; i++) {
        ctx.lineTo(x0 + (i / n) * span, H / 2 - ridge[i] * H);
      }
      ctx.lineTo(x0 + span, H / 2 + 4);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/* ---------------- 绘制：赛道与精灵 ---------------- */
function renderWorld(theme, now) {
  drawSky(theme, now);
  drawMountains(theme);

  // 基础草地
  ctx.fillStyle = theme.grass1;
  ctx.fillRect(0, H / 2, W, H / 2);

  const vb = G.viewBlend;
  const camZ = lerp(G.position, G.position + PLAYER_Z, vb);   // 舱内视角：镜头移到车头
  const camH = lerp(CAM_H, COCKPIT_H, vb);
  const baseAbs = Math.floor(camZ / SEG_LEN);
  const basePct = (camZ % SEG_LEN) / SEG_LEN;
  const playerAbs = Math.floor((G.position + PLAYER_Z) / SEG_LEN);
  const playerSeg = segAt(playerAbs) || segments[0];
  const playerPct = ((G.position + PLAYER_Z) % SEG_LEN) / SEG_LEN;
  const playerY = lerp(playerSeg.y, segYAt(playerAbs + 1), playerPct);
  G.playerY = playerY;

  const camX = G.playerX * ROAD_W + G.steerVis * 90 * vb;     // 舱内：随转向轻微摆头
  const camY = playerY + camH;

  // ---- 第一遍：路面 ----
  let maxy = H;
  let x = 0;
  let dx = -(segAt(baseAbs).curve * basePct);

  for (let n = 0; n < DRAW_DIST; n++) {
    const seg = segAt(baseAbs + n);
    if (!seg) break;
    const next = segAt(baseAbs + n + 1);
    const dz1 = seg.index * SEG_LEN - camZ;
    const dz2 = dz1 + SEG_LEN;
    const x1off = x, x2off = x + dx;
    x += dx;
    dx += seg.curve;

    seg.clip = maxy;
    seg.fog = 1 / Math.exp((n / DRAW_DIST) * (n / DRAW_DIST) * FOG_DENSITY);

    if (dz1 < 40 || !next) { seg.vis = false; continue; }

    const s1 = CAM_D / dz1, s2 = CAM_D / dz2;
    const sx1 = W / 2 + s1 * (x1off - camX) * (W / 2);
    const sy1 = H / 2 - s1 * (seg.y - camY) * (H / 2);
    const sw1 = s1 * ROAD_W * (W / 2);
    const sx2 = W / 2 + s2 * (x2off - camX) * (W / 2);
    const sy2 = H / 2 - s2 * (next.y - camY) * (H / 2);
    const sw2 = s2 * ROAD_W * (W / 2);

    seg.s1 = s1; seg.s2 = s2;
    seg.sx1 = sx1; seg.sy1 = sy1; seg.sw1 = sw1;
    seg.sx2 = sx2; seg.sy2 = sy2; seg.sw2 = sw2;

    if (sy2 >= sy1 || sy2 >= maxy) { seg.vis = false; continue; }

    const alt = Math.floor(seg.index / 3) % 2 === 0;
    // 草地条纹
    ctx.fillStyle = alt ? theme.grass1 : theme.grass2;
    ctx.fillRect(0, sy2, W, sy1 - sy2);
    // 路缘
    const r1 = sw1 / 8, r2 = sw2 / 8;
    const rc = alt ? theme.rumble1 : theme.rumble2;
    poly(sx1 - sw1 - r1, sy1, sx1 - sw1, sy1, sx2 - sw2, sy2, sx2 - sw2 - r2, sy2, rc);
    poly(sx1 + sw1 + r1, sy1, sx1 + sw1, sy1, sx2 + sw2, sy2, sx2 + sw2 + r2, sy2, rc);
    // 路面
    poly(sx1 - sw1, sy1, sx1 + sw1, sy1, sx2 + sw2, sy2, sx2 - sw2, sy2, alt ? theme.road1 : theme.road2);
    // 检查点斑马线
    if (seg.checkpoint) {
      const cells = 10;
      for (let i = 0; i < cells; i++) {
        const a = -1 + (2 * i) / cells, b = -1 + (2 * (i + 1)) / cells;
        const c = (i % 2 === 0) ? '#e8e8e8' : '#2a2a2a';
        poly(sx1 + sw1 * a, sy1, sx1 + sw1 * b, sy1, sx2 + sw2 * b, sy2, sx2 + sw2 * a, sy2, c);
      }
    } else if (seg.index % 6 < 3) {
      // 车道虚线
      const lw1 = Math.max(1, sw1 * 0.012), lw2 = Math.max(1, sw2 * 0.012);
      for (const b of [-1 / 3, 1 / 3]) {
        poly(sx1 + sw1 * b - lw1, sy1, sx1 + sw1 * b + lw1, sy1, sx2 + sw2 * b + lw2, sy2, sx2 + sw2 * b - lw2, sy2, theme.lane);
      }
    }
    // 雾
    const fa = 1 - seg.fog;
    if (fa > 0.02) {
      ctx.globalAlpha = fa;
      ctx.fillStyle = theme.fog;
      ctx.fillRect(0, sy2, W, sy1 - sy2 + 1);
      ctx.globalAlpha = 1;
    }
    maxy = sy2;
    seg.vis = true;
  }

  // ---- 午夜车头灯锥 ----
  if (theme.dark > 0.45 && G.state !== 'menu') drawHeadlights(baseAbs, theme);

  // ---- 第二遍：精灵（远 → 近）----
  // 车流装桶
  for (let n = 0; n < DRAW_DIST; n++) {
    const seg = segAt(baseAbs + n);
    if (seg) seg.cars.length = 0;
  }
  for (const c of G.cars) {
    const idx = Math.floor(c.z / SEG_LEN) - baseAbs;
    if (idx >= 0 && idx < DRAW_DIST && c.z - camZ > 60) segAt(baseAbs + idx).cars.push(c);
  }

  for (let n = DRAW_DIST - 1; n >= 0; n--) {
    const seg = segAt(baseAbs + n);
    if (!seg || !seg.vis) continue;
    const k = seg.s1 * (W / 2);           // 水平像素/世界单位
    const kv = seg.s1 * (H / 2);          // 垂直像素/世界单位

    for (const spr of seg.sprites) {
      const px = seg.sx1 + k * spr.off * ROAD_W;
      const gy = seg.sy1;
      if (spr.type === 'tree') {
        const s = spr.s;
        const th = 300 * s * kv, tw = 80 * s * k, cr = 300 * s * k;
        if (cr < 1.5) continue;
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath(); ctx.ellipse(px, gy, cr * 0.5, cr * 0.16, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#5b4026';
        ctx.fillRect(px - tw / 2, gy - th, tw, th);
        ctx.fillStyle = spr.c;
        ctx.beginPath();
        ctx.arc(px, gy - th - cr * 0.35, cr * 0.62, 0, Math.PI * 2);
        ctx.arc(px - cr * 0.4, gy - th - cr * 0.05, cr * 0.42, 0, Math.PI * 2);
        ctx.arc(px + cr * 0.4, gy - th - cr * 0.1, cr * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.beginPath(); ctx.arc(px - cr * 0.15, gy - th - cr * 0.55, cr * 0.25, 0, Math.PI * 2); ctx.fill();
      } else if (spr.type === 'bill') {
        const bw = 560 * k, bh = 420 * kv;
        if (bw < 3) continue;
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(px - bw / 2 + 6, gy - bh + 6, bw, bh);
        ctx.fillStyle = '#6b6f76';
        ctx.fillRect(px - bw * 0.3, gy - bh * 0.25, bw * 0.08, bh * 0.25);
        ctx.fillRect(px + bw * 0.22, gy - bh * 0.25, bw * 0.08, bh * 0.25);
        ctx.fillStyle = spr.c;
        ctx.fillRect(px - bw / 2, gy - bh, bw, bh * 0.78);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(px - bw / 2, gy - bh, bw, bh * 0.08);
        if (bw > 60) {
          ctx.fillStyle = '#fff';
          ctx.font = `900 ${bh * 0.3}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(spr.txt, px, gy - bh * 0.38);
        }
      }
    }

    // 检查点龙门架
    if (seg.checkpoint) {
      const poleL = seg.sx1 - k * 1.3 * ROAD_W;
      const poleR = seg.sx1 + k * 1.3 * ROAD_W;
      const pw = Math.max(2, 60 * k), ph = 780 * kv;
      if (pw > 2 && ph > 10) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(poleL + 4, seg.sy1 - ph + 4, pw, ph);
        ctx.fillRect(poleR + 4, seg.sy1 - ph + 4, pw, ph);
        ctx.fillStyle = '#c8ccd2';
        ctx.fillRect(poleL - pw / 2, seg.sy1 - ph, pw, ph);
        ctx.fillRect(poleR - pw / 2, seg.sy1 - ph, pw, ph);
        // 横梁：黑白格
        const bh2 = Math.max(6, 150 * kv);
        const y0 = seg.sy1 - ph;
        const cols = 14;
        for (let i = 0; i < cols; i++) {
          ctx.fillStyle = i % 2 === 0 ? '#e8e8e8' : '#222';
          ctx.fillRect(poleL + (poleR - poleL) * i / cols, y0, (poleR - poleL) / cols + 1, bh2);
        }
        if (poleR - poleL > 140) {
          ctx.fillStyle = '#ffcf3f';
          ctx.font = `900 ${bh2 * 0.6}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('CHECKPOINT', (poleL + poleR) / 2, y0 + bh2 * 0.75);
        }
      }
    }

    // 车流
    for (const c of seg.cars) {
      const pct = (c.z - seg.index * SEG_LEN) / SEG_LEN;
      const sc = lerp(seg.s1, seg.s2, pct);
      const cxx = lerp(seg.sx1, seg.sx2, pct) + sc * c.laneX * ROAD_W * (W / 2);
      const cyy = lerp(seg.sy1, seg.sy2, pct);
      const kk = sc * (W / 2);
      if (c.type === 'truck') {
        drawTruck(cxx, cyy, 0.52 * ROAD_W * kk, c.color, theme);
      } else {
        drawCar(cxx, cyy, 0.42 * ROAD_W * kk, c.color, { night: theme.dark });
      }
    }
  }
}

function drawHeadlights(baseAbs, theme) {
  const near = segAt(baseAbs + 9), far = segAt(baseAbs + 26);
  if (!near || !near.vis || !far || !far.vis) return;
  const { px, py, pw } = playerScreenPos();
  const nw = pw * 0.35;
  const fw1 = near.sw1 * 0.45, fw2 = far.sw2 * 0.6;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(0, py, 0, far.sy2);
  g.addColorStop(0, `rgba(255,240,190,${0.3 * theme.dark})`);
  g.addColorStop(1, 'rgba(255,240,190,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(px - nw, py);
  ctx.lineTo(px + nw, py);
  ctx.lineTo(near.sx1 + fw1, near.sy1);
  ctx.lineTo(far.sx2 + fw2, far.sy2);
  ctx.lineTo(far.sx2 - fw2, far.sy2);
  ctx.lineTo(near.sx1 - fw1, near.sy1);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ---------------- 绘制：车辆精灵 ---------------- */
function drawCar(cx, cy, w, color, o = {}) {
  if (w < 3) return;
  const h = w * 0.78;
  ctx.save();
  ctx.translate(cx, cy);
  if (o.tilt) ctx.rotate(o.tilt);

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, h * 0.42, w * 0.58, h * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#15161a';
  rr(-w * 0.56, h * 0.08, w * 0.15, h * 0.4, 3);
  rr(w * 0.41, h * 0.08, w * 0.15, h * 0.4, 3);

  const bg = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  bg.addColorStop(0, shade(color, 0.55));
  bg.addColorStop(0.5, color);
  bg.addColorStop(1, shade(color, 0.55));
  ctx.fillStyle = bg;
  rr(-w / 2, -h / 2, w, h, w * 0.16);

  ctx.fillStyle = shade(color, 0.72);
  rr(-w * 0.35, -h * 0.48, w * 0.7, h * 0.34, w * 0.1);
  ctx.fillStyle = '#22333f';
  rr(-w * 0.3, -h * 0.26, w * 0.6, h * 0.24, w * 0.06);
  ctx.fillStyle = 'rgba(160,210,235,0.35)';
  rr(-w * 0.26, -h * 0.24, w * 0.52, h * 0.09, w * 0.05);

  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  rr(-w * 0.44, h * 0.02, w * 0.88, h * 0.12, 4);
  ctx.fillStyle = shade(color, 0.5);
  rr(-w * 0.48, h * 0.28, w * 0.96, h * 0.18, w * 0.07);

  const glow = o.brake ? 0.5 : (o.night ? 0.45 : 0);
  if (glow > 0) { ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = w * glow; }
  ctx.fillStyle = o.brake ? '#ff5148' : '#c62f26';
  rr(-w * 0.45, h * 0.16, w * 0.26, h * 0.11, 3);
  rr(w * 0.19, h * 0.16, w * 0.26, h * 0.11, 3);
  ctx.shadowBlur = 0;

  if (o.player) {
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillRect(-w * 0.1, -h * 0.46, w * 0.07, h * 0.62);
    ctx.fillRect(w * 0.03, -h * 0.46, w * 0.07, h * 0.62);
    ctx.fillStyle = shade(color, 0.35);
    ctx.fillRect(-w * 0.3, -h * 0.34, w * 0.08, h * 0.12);
    ctx.fillRect(w * 0.22, -h * 0.34, w * 0.08, h * 0.12);
    rr(-w * 0.52, -h * 0.42, w * 1.04, h * 0.09, 3);
    if (o.boost) {
      const fl = h * (0.3 + Math.random() * 0.3);
      ctx.fillStyle = Math.random() < 0.5 ? '#ff9f43' : '#ffd8a8';
      for (const ex of [-w * 0.15, w * 0.15]) {
        ctx.beginPath();
        ctx.moveTo(ex - w * 0.06, h * 0.46);
        ctx.lineTo(ex + w * 0.06, h * 0.46);
        ctx.lineTo(ex, h * 0.46 + fl);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawTruck(cx, cy, w, color, theme) {
  if (w < 3) return;
  const h = w * 1.02;
  ctx.save();
  ctx.translate(cx, cy - h * 0.42);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(0, h * 0.46, w * 0.6, h * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#15161a';
  rr(-w * 0.55, h * 0.12, w * 0.14, h * 0.36, 3);
  rr(w * 0.41, h * 0.12, w * 0.14, h * 0.36, 3);

  // 集装箱
  const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  g.addColorStop(0, shade(color, 0.6));
  g.addColorStop(0.5, color);
  g.addColorStop(1, shade(color, 0.6));
  ctx.fillStyle = g;
  rr(-w / 2, -h / 2, w, h * 0.82, 6);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = Math.max(1, w * 0.02);
  for (let i = 1; i < 6; i++) {
    ctx.beginPath();
    ctx.moveTo(-w / 2 + (w * i) / 6, -h / 2);
    ctx.lineTo(-w / 2 + (w * i) / 6, -h / 2 + h * 0.82);
    ctx.stroke();
  }
  // 驾驶室顶部
  ctx.fillStyle = shade(color, 0.75);
  rr(-w * 0.32, -h / 2 - h * 0.14, w * 0.64, h * 0.16, 5);
  // 尾灯 & 后防撞杠
  ctx.fillStyle = '#5a5f66';
  rr(-w * 0.5, h * 0.3, w, h * 0.09, 3);
  if (theme.dark > 0.4) { ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = w * 0.4; }
  ctx.fillStyle = '#c62f26';
  rr(-w * 0.46, h * 0.2, w * 0.18, h * 0.08, 2);
  rr(w * 0.28, h * 0.2, w * 0.18, h * 0.08, 2);
  ctx.shadowBlur = 0;
  ctx.restore();
}

function playerScreenPos() {
  const pw = (CAM_D / PLAYER_Z) * 0.42 * ROAD_W * (W / 2);
  const ph = pw * 0.78;
  const chaseY = H - ph * 0.42 - 22;
  const py = lerp(chaseY, H * 0.7, G.viewBlend);   // 舱内视角：爆炸/车灯源移到挡风玻璃处
  return { px: W / 2 + G.steerVis * 14 * (1 - G.viewBlend), py, pw };
}

function drawPlayer(now) {
  if (G.viewBlend > 0.55) return;
  const a = 1 - clamp((G.viewBlend - 0.25) / 0.3, 0, 1);
  if (a <= 0) return;
  ctx.globalAlpha = a;
  const { px, py, pw } = playerScreenPos();
  const speedPct = G.speed / MAX_SPEED;
  const bounce = (Math.sin(now * 0.02) + Math.sin(now * 0.013)) * 1.6 * speedPct;
  const crashed = G.state === 'crash';
  drawCar(px + G.steerVis * 14, py + bounce, pw, crashed ? '#7a3b30' : '#e8452c', {
    player: true,
    tilt: crashed ? G.spin : G.steerVis * 0.07,
    brake: brakeInput() && !crashed,
    boost: G.boosting,
    night: currentTheme.dark
  });
  ctx.globalAlpha = 1;
}

/* ================= 驾驶舱视角（左舵布局） =================
 * 仪表台 + 转速/NOS 双仪表 + 中控屏 + 左侧方向盘
 * + 车内后视镜（实时渲染后方车流） + A柱 + 车顶 + 引擎盖
 */
function drawCockpit(theme, now) {
  const a = clamp((G.viewBlend - 0.3) / 0.4, 0, 1);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = a;
  const night = theme.dark;

  // ---- 风挡外：引擎盖 ----
  const hoodTop = H * 0.662, hoodBot = H * 0.8;
  const hg = ctx.createLinearGradient(0, hoodTop, 0, hoodBot);
  hg.addColorStop(0, '#c93c25');
  hg.addColorStop(0.5, '#e8452c');
  hg.addColorStop(1, '#9c2c1b');
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.moveTo(W * 0.1, hoodBot);
  ctx.lineTo(W * 0.26, hoodTop + H * 0.014);
  ctx.quadraticCurveTo(W / 2, hoodTop - H * 0.01, W * 0.74, hoodTop + H * 0.014);
  ctx.lineTo(W * 0.9, hoodBot);
  ctx.closePath();
  ctx.fill();
  // 引擎盖拉花（透视收缩）
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (const off of [-0.065, 0.038]) {
    ctx.beginPath();
    ctx.moveTo(W / 2 + off * W * 1.5 - W * 0.022, hoodBot);
    ctx.lineTo(W / 2 + off * W * 0.6 - W * 0.008, hoodTop + H * 0.018);
    ctx.lineTo(W / 2 + off * W * 0.6 + W * 0.008, hoodTop + H * 0.018);
    ctx.lineTo(W / 2 + off * W * 1.5 + W * 0.022, hoodBot);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.moveTo(W * 0.42, hoodBot);
  ctx.quadraticCurveTo(W * 0.49, hoodTop + H * 0.012, W * 0.56, hoodTop + H * 0.01);
  ctx.quadraticCurveTo(W * 0.6, H * 0.73, W * 0.56, hoodBot);
  ctx.closePath();
  ctx.fill();

  // ---- 风挡玻璃斜向反光 ----
  const sheen = ctx.createLinearGradient(W * 0.1, H * 0.1, W * 0.9, H * 0.65);
  sheen.addColorStop(0.3, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, `rgba(255,255,255,${0.055 - night * 0.035})`);
  sheen.addColorStop(0.7, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H * 0.8);

  // ---- 仪表台主体 ----
  const dashTop = H * 0.768;
  const dg = ctx.createLinearGradient(0, dashTop, 0, H);
  dg.addColorStop(0, '#23262c');
  dg.addColorStop(0.25, '#15171b');
  dg.addColorStop(1, '#0a0b0e');
  ctx.fillStyle = dg;
  ctx.beginPath();
  ctx.moveTo(-W * 0.02, H * 1.02);
  ctx.lineTo(-W * 0.02, dashTop + H * 0.035);
  ctx.quadraticCurveTo(W * 0.16, dashTop - H * 0.014, W * 0.4, dashTop + H * 0.002);
  ctx.quadraticCurveTo(W * 0.62, dashTop - H * 0.01, W * 0.84, dashTop + H * 0.028);
  ctx.quadraticCurveTo(W * 1.01, dashTop + H * 0.052, W * 1.02, dashTop + H * 0.065);
  ctx.lineTo(W * 1.02, H * 1.02);
  ctx.closePath();
  ctx.fill();
  // 仪表台顶部环境光缝
  ctx.strokeStyle = `rgba(125,145,175,${0.28 - night * 0.17})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-W * 0.02, dashTop + H * 0.035);
  ctx.quadraticCurveTo(W * 0.16, dashTop - H * 0.014, W * 0.4, dashTop + H * 0.002);
  ctx.quadraticCurveTo(W * 0.62, dashTop - H * 0.01, W * 0.84, dashTop + H * 0.028);
  ctx.quadraticCurveTo(W * 1.01, dashTop + H * 0.052, W * 1.02, dashTop + H * 0.065);
  ctx.stroke();

  // ---- 出风口 ×2 ----
  drawVent(W * 0.1, H * 0.822, W * 0.08, H * 0.048);
  drawVent(W * 0.815, H * 0.832, W * 0.08, H * 0.048);

  // ---- 仪表组（左舵驾驶位正前方）----
  drawGauge(W * 0.222, H * 0.878, Math.min(W * 0.063, H * 0.102), G.speed / (MAX_SPEED * 1.3), 'km/h', '#ff5148', night, ['0', '1', '2', '3']);
  drawGauge(W * 0.348, H * 0.888, Math.min(W * 0.049, H * 0.079), G.nos / 100, 'NOS', '#26c6da', night, null);

  // ---- 中控屏（时间 / 关卡）----
  drawConsole(theme, now);

  // ---- 方向盘（左侧驾驶位）----
  const wx = W * 0.295 + G.steerVis * 16;
  const wy = H * 1.18;
  const wr = Math.min(W * 0.215, H * 0.275);
  const rot = G.steerVis * 0.55 + (G.state === 'crash' ? G.spin * 0.4 : 0);
  ctx.save();
  ctx.translate(wx, wy);
  ctx.rotate(rot);
  ctx.strokeStyle = '#1e2025';
  ctx.lineWidth = wr * 0.13;
  ctx.beginPath(); ctx.arc(0, 0, wr, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#3d4049';
  ctx.lineWidth = wr * 0.05;
  ctx.beginPath(); ctx.arc(0, -wr * 0.02, wr * 0.92, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#26282e';
  ctx.lineWidth = wr * 0.11;
  for (const ang of [Math.PI, 0, Math.PI / 2]) {
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang) * wr * 0.1, Math.sin(ang) * wr * 0.1);
    ctx.lineTo(Math.cos(ang) * wr * 0.95, Math.sin(ang) * wr * 0.95);
    ctx.stroke();
  }
  ctx.fillStyle = '#d43a26';
  ctx.beginPath(); ctx.arc(0, 0, wr * 0.21, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `900 ${wr * 0.15}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('T', 0, wr * 0.05);
  ctx.restore();

  // ---- 车顶棚 ----
  ctx.fillStyle = '#0b0c0f';
  ctx.beginPath();
  ctx.moveTo(-W * 0.02, -H * 0.02);
  ctx.lineTo(W * 1.02, -H * 0.02);
  ctx.lineTo(W * 1.02, H * 0.04);
  ctx.quadraticCurveTo(W / 2, H * 0.078, -W * 0.02, H * 0.04);
  ctx.closePath();
  ctx.fill();

  // ---- A 柱（左右）----
  ctx.fillStyle = '#101115';
  ctx.beginPath();
  ctx.moveTo(-W * 0.02, H * 0.015); ctx.lineTo(W * 0.088, -H * 0.01);
  ctx.lineTo(W * 0.168, H * 0.78); ctx.lineTo(-W * 0.02, H * 0.85);
  ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(W * 1.02, H * 0.015); ctx.lineTo(W - W * 0.088, -H * 0.01);
  ctx.lineTo(W - W * 0.168, H * 0.78); ctx.lineTo(W * 1.02, H * 0.85);
  ctx.closePath(); ctx.fill();
  // A 柱高光棱线
  ctx.strokeStyle = 'rgba(130,145,170,0.18)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(W * 0.085, 0); ctx.lineTo(W * 0.163, H * 0.78);
  ctx.moveTo(W - W * 0.085, 0); ctx.lineTo(W - W * 0.163, H * 0.78);
  ctx.stroke();

  // ---- 车内后视镜 ----
  drawMirror(theme);

  // ---- 车内暗角 ----
  const vg = ctx.createRadialGradient(W / 2, H * 0.5, H * 0.36, W / 2, H * 0.5, H * 0.92);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.34)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/* 出风口 */
function drawVent(x, y, w, h) {
  ctx.fillStyle = '#0a0b0e';
  rp(x - w / 2, y - h / 2, w, h, h * 0.35); ctx.fill();
  ctx.strokeStyle = '#2b2e36';
  ctx.lineWidth = 1.5;
  rp(x - w / 2 + 2, y - h / 2 + 2, w - 4, h - 4, h * 0.3); ctx.stroke();
  ctx.strokeStyle = 'rgba(140,155,180,0.3)';
  ctx.lineWidth = 1.5;
  for (let i = 1; i <= 3; i++) {
    const ly = y - h / 2 + (h * i) / 4;
    ctx.beginPath();
    ctx.moveTo(x - w / 2 + 5, ly); ctx.lineTo(x + w / 2 - 5, ly);
    ctx.stroke();
  }
}

/* 圆形仪表盘（带指针动画 / 夜光） */
function drawGauge(x, y, r, val, label, needleColor, night, tickLabels) {
  val = clamp(val, 0, 1);
  ctx.save();
  ctx.fillStyle = '#06070a';
  ctx.beginPath(); ctx.arc(x, y, r * 1.13, 0, Math.PI * 2); ctx.fill();
  if (night > 0.4) { ctx.shadowColor = needleColor; ctx.shadowBlur = r * 0.55; }
  ctx.strokeStyle = night > 0.4 ? 'rgba(95,115,145,0.9)' : '#2b2e36';
  ctx.lineWidth = Math.max(1.5, r * 0.06);
  ctx.beginPath(); ctx.arc(x, y, r * 1.06, 0, Math.PI * 2); ctx.stroke();
  ctx.shadowBlur = 0;
  const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const ang = a0 + sweep * t;
    const major = i % 2 === 0;
    const r1 = r * (major ? 0.76 : 0.85), r2 = r * 0.92;
    ctx.strokeStyle = t > 0.82 ? '#e74c3c' : (night > 0.4 ? 'rgba(205,220,240,0.85)' : '#5a6070');
    ctx.lineWidth = major ? Math.max(1.5, r * 0.045) : Math.max(1, r * 0.025);
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
    ctx.lineTo(x + Math.cos(ang) * r2, y + Math.sin(ang) * r2);
    ctx.stroke();
  }
  if (tickLabels && r > 34) {
    ctx.fillStyle = night > 0.4 ? '#cfe0f5' : '#8a93a5';
    ctx.font = `700 ${Math.round(r * 0.2)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < tickLabels.length; i++) {
      const t = i / (tickLabels.length - 1);
      const ang = a0 + sweep * t;
      ctx.fillText(tickLabels[i], x + Math.cos(ang) * r * 0.58, y + Math.sin(ang) * r * 0.58);
    }
    ctx.textBaseline = 'alphabetic';
  }
  const na = a0 + sweep * val;
  if (night > 0.4) { ctx.shadowColor = needleColor; ctx.shadowBlur = r * 0.5; }
  ctx.strokeStyle = needleColor;
  ctx.lineWidth = Math.max(2, r * 0.06);
  ctx.beginPath();
  ctx.moveTo(x - Math.cos(na) * r * 0.14, y - Math.sin(na) * r * 0.14);
  ctx.lineTo(x + Math.cos(na) * r * 0.8, y + Math.sin(na) * r * 0.8);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#1a1d24';
  ctx.beginPath(); ctx.arc(x, y, r * 0.09, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = night > 0.4 ? '#9fb4d8' : '#6a7386';
  ctx.font = `700 ${Math.max(8, Math.round(r * 0.17))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(label, x, y + r * 0.46);
  ctx.restore();
}

/* 中控屏：时间 / 关卡 */
function drawConsole(theme, now) {
  const sx = W * 0.515, sy = H * 0.812, sw = W * 0.14, sh = H * 0.108;
  ctx.fillStyle = '#06070a';
  rp(sx - sw / 2 - 6, sy - sh / 2 - 6, sw + 12, sh + 12, 10); ctx.fill();
  const urgent = G.timeLeft < 10 && (G.state === 'playing' || G.state === 'crash');
  const blink = urgent && Math.sin(now * 0.012) > 0;
  if (theme.dark > 0.4) { ctx.shadowColor = urgent ? '#ff5148' : '#26c6da'; ctx.shadowBlur = 14; }
  const sg = ctx.createLinearGradient(0, sy - sh / 2, 0, sy + sh / 2);
  sg.addColorStop(0, '#0e1d2a'); sg.addColorStop(1, '#050a11');
  ctx.fillStyle = sg;
  rp(sx - sw / 2, sy - sh / 2, sw, sh, 6); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#4d6a86';
  ctx.font = `700 ${Math.max(8, sh * 0.2)}px system-ui, sans-serif`;
  ctx.fillText('TIME', sx, sy - sh * 0.18);
  ctx.fillStyle = blink ? '#ff8a80' : (urgent ? '#ff5148' : '#e8f4ff');
  ctx.font = `900 ${sh * 0.46}px system-ui, sans-serif`;
  ctx.fillText(String(Math.ceil(G.timeLeft)), sx, sy + sh * 0.22);
  ctx.fillStyle = '#4d6a86';
  ctx.font = `700 ${Math.max(8, sh * 0.18)}px system-ui, sans-serif`;
  ctx.fillText('STAGE ' + G.stage, sx, sy + sh * 0.42);
}

/* 车内后视镜：实时渲染后方车流 */
function drawMirror(theme) {
  const mw = W * 0.18, mh = H * 0.105;
  const mx = W / 2, my = H * 0.128;
  const gx0 = mx - mw / 2, gy0 = my - mh / 2;
  // 支架
  ctx.fillStyle = '#101115';
  ctx.fillRect(mx - W * 0.011, H * 0.045, W * 0.022, gy0 - H * 0.045 + 4);

  ctx.save();
  rp(gx0, gy0, mw, mh, mh * 0.14);
  ctx.clip();
  // 后方天空与地面
  const horizon = gy0 + mh * 0.55;
  ctx.fillStyle = theme.skyTop;
  ctx.fillRect(gx0, gy0, mw, mh * 0.6);
  ctx.fillStyle = theme.grass1;
  ctx.fillRect(gx0, horizon, mw, mh);
  // 后方路面（向后收缩）
  ctx.fillStyle = theme.road1;
  ctx.beginPath();
  ctx.moveTo(gx0, gy0 + mh);
  ctx.lineTo(gx0 + mw, gy0 + mh);
  ctx.lineTo(mx + mw * 0.11, horizon + mh * 0.05);
  ctx.lineTo(mx - mw * 0.11, horizon + mh * 0.05);
  ctx.closePath();
  ctx.fill();
  // 后方车流
  const pz = G.position + PLAYER_Z;
  const behind = [];
  for (const c of G.cars) {
    const dz = pz - c.z;
    if (dz > 250 && dz < 7500) behind.push({ c, dz });
  }
  behind.sort((p, q) => q.dz - p.dz);   // 远的先画
  for (const { c, dz } of behind.slice(0, 4)) {
    const prox = clamp(1 - dz / 7500, 0, 1);
    const s = mh * (0.24 + 0.85 * prox * prox) * (c.type === 'truck' ? 1.3 : 1);
    const cxm = clamp(mx + (c.laneX - G.playerX) * mw * 0.55, gx0 + s * 0.6, gx0 + mw - s * 0.6);
    const cym = horizon + mh * 0.06 + prox * prox * mh * 0.42;
    drawMirrorCar(cxm, cym, s, c.color, theme.dark);
  }
  // 玻璃色调 + 斜向反光
  ctx.fillStyle = `rgba(12,18,30,${0.16 + theme.dark * 0.14})`;
  ctx.fillRect(gx0, gy0, mw, mh);
  const msh = ctx.createLinearGradient(gx0, gy0, gx0 + mw, gy0 + mh);
  msh.addColorStop(0.35, 'rgba(255,255,255,0)');
  msh.addColorStop(0.55, 'rgba(255,255,255,0.09)');
  msh.addColorStop(0.75, 'rgba(255,255,255,0)');
  ctx.fillStyle = msh;
  ctx.fillRect(gx0, gy0, mw, mh);
  ctx.restore();

  // 镜框
  ctx.strokeStyle = '#14161b';
  ctx.lineWidth = Math.max(3, W * 0.007);
  rp(gx0, gy0, mw, mh, mh * 0.14); ctx.stroke();
  ctx.strokeStyle = 'rgba(150,165,190,0.25)';
  ctx.lineWidth = 1.5;
  rp(gx0 + 2, gy0 + 2, mw - 4, mh - 4, mh * 0.12); ctx.stroke();
}

/* 后视镜里的前视小车 */
function drawMirrorCar(x, y, s, color, night) {
  if (s < 3) return;
  const w = s * 1.05;
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath(); ctx.ellipse(x, y + s * 0.06, w * 0.55, s * 0.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  rp(x - w / 2, y - s * 0.82, w, s * 0.94, s * 0.18); ctx.fill();
  ctx.fillStyle = 'rgba(22,32,48,0.92)';
  rp(x - w * 0.36, y - s * 0.7, w * 0.72, s * 0.36, s * 0.1); ctx.fill();
  if (night > 0.4) { ctx.shadowColor = '#ffe9a8'; ctx.shadowBlur = s * 0.55; }
  ctx.fillStyle = night > 0.4 ? '#fff3c4' : '#cfd8e8';
  ctx.fillRect(x - w * 0.44, y - s * 0.26, w * 0.24, s * 0.13);
  ctx.fillRect(x + w * 0.2, y - s * 0.26, w * 0.24, s * 0.13);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(x - w * 0.48, y - s * 0.08, w * 0.96, s * 0.14);
}

/* ---------------- 绘制：特效与 HUD ---------------- */
function drawParticles() {
  for (const p of G.particles) {
    ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawTexts() {
  ctx.textAlign = 'center';
  for (const t of G.texts) {
    ctx.globalAlpha = clamp(t.life / t.maxLife, 0, 1);
    ctx.font = `700 ${Math.max(16, W * 0.024)}px system-ui, sans-serif`;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 4;
    ctx.strokeText(t.txt, t.x, t.y);
    ctx.fillStyle = t.color;
    ctx.fillText(t.txt, t.x, t.y);
  }
  ctx.globalAlpha = 1;
}

function drawSpeedLines() {
  const ratio = clamp((G.speed / MAX_SPEED - 0.7) / 0.3, 0, 1) + (G.boosting ? 0.5 : 0);
  if (ratio <= 0) return;
  ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.3, 0.16 * ratio)})`;
  ctx.lineWidth = 2;
  for (let i = 0; i < 12; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = W / 2 + side * rand(0.6, 1.05) * (W / 2);
    const y = rand(H * 0.45, H - 60);
    const len = rand(50, 160) * ratio;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + len);
    ctx.stroke();
  }
}

function drawHUD() {
  if (G.state === 'menu') return;
  const pad = 14;

  // 计时（顶部中央；舱内视角由中控屏显示，避免遮挡后视镜）
  const tSec = Math.ceil(G.timeLeft);
  const urgent = G.timeLeft < 10;
  if (G.viewBlend < 0.5) {
    ctx.fillStyle = 'rgba(10,14,24,0.5)';
    rr(W / 2 - 95, 10, 190, 62, 14);
    ctx.textAlign = 'center';
    ctx.fillStyle = urgent ? (Math.sin(performance.now() * 0.012) > 0 ? '#ff5148' : '#ffb0a8') : '#fff';
    ctx.font = `900 ${Math.max(30, W * 0.04)}px system-ui, sans-serif`;
    ctx.fillText(String(tSec), W / 2, 54);
    ctx.fillStyle = '#8fa8cc';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.fillText('TIME', W / 2, 26);
    const bw = 150;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    rr(W / 2 - bw / 2, 60, bw, 7, 3.5);
    const tp = clamp(G.timeLeft / 40, 0, 1);
    ctx.fillStyle = urgent ? '#ee5253' : (tp > 0.4 ? '#2ba84a' : '#ffcf3f');
    if (tp > 0.02) rr(W / 2 - bw / 2, 60, bw * tp, 7, 3.5);
  }

  // 得分 / 关卡（左上）
  ctx.fillStyle = 'rgba(10,14,24,0.5)';
  rr(12, 10, 178, 62, 14);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#8fa8cc';
  ctx.font = '700 11px system-ui, sans-serif';
  ctx.fillText('SCORE', 30, 28);
  ctx.fillStyle = '#fff';
  ctx.font = `800 ${Math.max(20, W * 0.026)}px system-ui, sans-serif`;
  ctx.fillText(Math.floor(G.score).toLocaleString(), 30, 56);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffcf3f';
  ctx.font = '700 13px system-ui, sans-serif';
  ctx.fillText('STAGE ' + G.stage, 174, 28);
  ctx.fillStyle = '#7d93b5';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.fillText('BEST ' + G.highScore.toLocaleString(), 174, 56);

  // 速度（右上）
  const kmh = Math.round(G.speed / MAX_SPEED * 300);
  ctx.fillStyle = 'rgba(10,14,24,0.5)';
  rr(W - 160, 10, 148, 62, 14);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#fff';
  ctx.font = `800 ${Math.max(24, W * 0.032)}px system-ui, sans-serif`;
  ctx.fillText(kmh, W - 52, 46);
  ctx.fillStyle = '#8fa8cc';
  ctx.font = '700 12px system-ui, sans-serif';
  ctx.fillText('km/h', W - 26, 46);
  const sbw = 110;
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  rr(W - 26 - sbw, 54, sbw, 8, 4);
  const sp = clamp(G.speed / (MAX_SPEED * 1.3), 0, 1);
  const sg = ctx.createLinearGradient(W - 26 - sbw, 0, W - 26, 0);
  sg.addColorStop(0, '#2ba84a'); sg.addColorStop(0.6, '#ffcf3f'); sg.addColorStop(1, '#ff5148');
  ctx.fillStyle = sg;
  if (sp > 0.02) rr(W - 26 - sbw, 54, sbw * sp, 8, 4);
  if (G.boosting) {
    ctx.fillStyle = '#26c6da';
    ctx.font = '900 12px system-ui, sans-serif';
    ctx.fillText('NOS!', W - 26, 30);
  }

  // NOS 氮气条（左下）
  const nbw = 150, nbh = 13;
  ctx.fillStyle = 'rgba(10,14,24,0.5)';
  rr(14, H - 44, nbw + 52, 30, 12);
  ctx.fillStyle = '#26c6da';
  ctx.font = '900 12px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('NOS', 26, H - 24);
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  rr(60, H - 38, nbw, nbh, 6.5);
  const np = G.nos / 100;
  ctx.fillStyle = np > 0.25 ? '#26c6da' : '#e67e22';
  if (np > 0.02) rr(60, H - 38, nbw * np, nbh, 6.5);

  // 连击（舱内视角下移，避开后视镜）
  if (G.combo > 1 && G.comboTimer > 0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff7043';
    ctx.font = `800 ${Math.max(16, W * 0.02)}px system-ui, sans-serif`;
    ctx.fillText(`🔥 连击 x${G.combo}`, W / 2, lerp(100, H * 0.3, G.viewBlend));
  }
}

function drawBanner() {
  if (G.bannerT <= 0) return;
  const a = clamp(G.bannerT / 0.5, 0, 1) * clamp((2.6 - G.bannerT) / 0.4, 0, 1);
  ctx.globalAlpha = Math.min(1, a);
  ctx.textAlign = 'center';
  ctx.font = `900 ${Math.max(40, W * 0.07)}px system-ui, sans-serif`;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 8;
  ctx.strokeText(G.bannerMain, W / 2, H * 0.3);
  ctx.fillStyle = '#fff';
  ctx.fillText(G.bannerMain, W / 2, H * 0.3);
  ctx.font = `700 ${Math.max(16, W * 0.024)}px system-ui, sans-serif`;
  ctx.fillStyle = '#ffcf3f';
  ctx.fillText(G.bannerSub, W / 2, H * 0.3 + 40);
  ctx.globalAlpha = 1;
}

function drawCountdown() {
  if (G.state === 'countdown') {
    if (G.countdownT > 0.6) {
      const n = Math.ceil(G.countdownT - 0.6);
      const frac = (G.countdownT - 0.6) - Math.floor(G.countdownT - 0.6);
      ctx.globalAlpha = clamp(0.3 + frac, 0, 1);
      drawBigCenter(String(n), n === 1 ? '#ffcf3f' : '#fff');
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = clamp(G.countdownT / 0.3, 0.15, 1);
      drawBigCenter('GO!', '#2ba84a');
      ctx.globalAlpha = 1;
    }
  } else if (G.state === 'playing' && G.goT > 0) {
    ctx.globalAlpha = clamp(G.goT / 0.5, 0, 1);
    drawBigCenter('GO!', '#2ba84a');
    ctx.globalAlpha = 1;
  }
}
function drawBigCenter(txt, color) {
  ctx.textAlign = 'center';
  ctx.font = `900 ${Math.max(64, W * 0.14)}px system-ui, sans-serif`;
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 10;
  ctx.strokeText(txt, W / 2, H * 0.42);
  ctx.fillStyle = color;
  ctx.fillText(txt, W / 2, H * 0.42);
}

/* ---------------- 主题计算 ---------------- */
let currentTheme = THEMES[0];
function computeTheme() {
  const ti = (G.stage - 1) % 4;
  const A = THEMES[ti], B = THEMES[(ti + 1) % 4];
  const cpPrev = G.cpIndex > 0 ? checkpoints[G.cpIndex - 1] : 0;
  const cpNext = checkpoints[G.cpIndex] || cpPrev + 1000;
  const playerAbs = Math.floor((G.position + PLAYER_Z) / SEG_LEN);
  const p = clamp((playerAbs - cpPrev) / Math.max(1, cpNext - cpPrev), 0, 1);
  currentTheme = lerpTheme(A, B, p);
}

/* ---------------- 渲染主入口 ---------------- */
function render(now) {
  computeTheme();
  ctx.save();
  if (G.shake > 0.3) ctx.translate(rand(-G.shake, G.shake), rand(-G.shake, G.shake));

  renderWorld(currentTheme, now);
  drawPlayer(now);
  drawCockpit(currentTheme, now);
  drawParticles();
  drawTexts();
  if (G.state === 'playing' || G.state === 'crash') drawSpeedLines();

  ctx.restore();

  drawHUD();
  drawBanner();
  drawCountdown();
}

/* ---------------- 主循环 ---------------- */
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const rdt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  update(rdt * G.timeScale, rdt, now);
  render(now);
}

/* ---------------- UI 绑定 ---------------- */
function updateMuteBtn(muted) { $('muteBtn').textContent = muted ? '🔇' : '🔊'; }
$('muteBtn').addEventListener('click', () => { AudioSys.ensure(); updateMuteBtn(AudioSys.toggleMute()); });
$('viewBtn').addEventListener('click', () => { AudioSys.ensure(); toggleView(); });
$('startBtn').addEventListener('click', () => { AudioSys.ensure(); start(); });
$('restartBtn').addEventListener('click', () => { AudioSys.ensure(); start(); });
$('resumeBtn').addEventListener('click', togglePause);
$('menu').addEventListener('click', (e) => { if (e.target.id === 'menu') { AudioSys.ensure(); start(); } });
$('pause').addEventListener('click', (e) => { if (e.target.id === 'pause') togglePause(); });
$('nosBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); G.touchNos = true; });
$('nosBtn').addEventListener('pointerup', () => { G.touchNos = false; });
$('nosBtn').addEventListener('pointerleave', () => { G.touchNos = false; });

$('menuHS').textContent = G.highScore.toLocaleString();
buildWorld();
for (let i = 0; i < 9; i++) spawnTraffic();

requestAnimationFrame(frame);
