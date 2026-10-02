// $WRESTLER GALAXY: boot, input, game loop, screens.
import { Match, OPPONENTS, LANES } from './match.js';
import { Audio } from './audio.js';
import { Pyro } from './pyro.js';
import { Stage } from './stage.js';
import { drawText } from './font.js';
import { drawWrestler } from './sprites.js';
import { HERO_PALETTE, HERO_PARTS, RUGPULL_PALETTE, RUGPULL_PARTS, UI } from './palette.js';
import { W, H, FLOOR_Y, TRACK_Y, ROW_Y0, ROW_H, HIT_X, drawArena, drawRingBack, drawRingFront, drawLane, drawHUD, drawCutIn, drawTitleBust } from './render.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = W;
canvas.height = H;
ctx.imageSmoothingEnabled = false;

const settings = Object.assign({ offsetMs: 0, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, muted: false }, JSON.parse(localStorage.getItem('wg-settings') || '{}'));
const saveSettings = () => localStorage.setItem('wg-settings', JSON.stringify(settings));

const audio = new Audio();
audio.muted = settings.muted;
const pyro = new Pyro(W, H);
pyro.reduced = settings.reduced;

const game = {
  screen: 'title', // title | fight | result | calibrate
  match: null,
  stage: null,
  pressed: [0, 0, 0, 0, 0],
  judge: null,
  laneTint: 0,
  best: +(localStorage.getItem('wg-best') || 0),
  calib: null,
};
window.WG = { game, audio, pyro, settings };

// ---------- Screen fit: integer scaling, letterboxed ----------
function fit() {
  const s = Math.max(1, Math.floor(Math.min(innerWidth / W, innerHeight / H)));
  const scale = s >= 2 ? s : Math.min(innerWidth / W, innerHeight / H);
  canvas.style.width = `${Math.floor(W * scale)}px`;
  canvas.style.height = `${Math.floor(H * scale)}px`;
}
addEventListener('resize', fit);
fit();

// ---------- Input ----------
// Arrow keys are primary. D F J K stay as a hidden alternative for rhythm-game players.
const KEYMAP = { ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3, KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3 };

/** Song time in seconds, corrected by the player's calibration offset. */
function songNow() {
  return audio.songTime() - settings.offsetMs / 1000;
}

function lanePress(lane) {
  audio.init();
  audio.resume();
  game.pressed[lane] = 0.12;
  if (game.screen === 'fight' && game.match && !game.match.over) {
    const g = game.match.press(lane, songNow());
    if (!g) audio.sfxTick();
  } else if (game.screen === 'calibrate') {
    calibTap();
  }
}

function confirm() {
  audio.init();
  audio.resume();
  if (game.screen === 'title') startFight();
  else if (game.screen === 'result') game.screen = 'title';
}

/**
 * Typed specials need a keyboard. Touch-first devices (no fine pointer, no key seen yet)
 * keep the two-arrow chord finisher instead. Any real key press flips this on.
 */
let sawKey = false;
addEventListener('keydown', () => { sawKey = true; }, { capture: true });
function hasKeyboard() {
  return sawKey || matchMedia('(pointer: fine)').matches;
}

/** True while a typed special is on screen: every letter key belongs to it. */
function typingNow() {
  const m = game.match;
  return game.screen === 'fight' && m && !m.over && m.seq && m.seq.typed;
}

function letterPress(ch) {
  audio.init();
  audio.resume();
  game.pressed[4] = 0.12;
  const g = game.match.pressLetter(ch, songNow());
  if (!g || g === 'ghost') audio.sfxTick();
}

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  // During a typed special, letters (including the D/F/J/K lane keys and M/C/R shortcuts) type.
  if (typingNow() && /^Key[A-Z]$/.test(e.code)) {
    e.preventDefault();
    return letterPress(e.code.slice(3));
  }
  // During tap kick-out: any arrow key or Space kicks the shoulder up.
  if (game.screen === 'fight' && game.match && !game.match.over && game.match.kickoutState) {
    if (e.code === 'Space' || e.code.startsWith('Arrow')) {
      e.preventDefault();
      audio.init(); audio.resume();
      audio.sfxTick();
      return game.match.tapKickout(songNow());
    }
  }
  if (e.code in KEYMAP) {
    e.preventDefault();
    if (game.screen === 'fight' || game.screen === 'calibrate') return lanePress(KEYMAP[e.code]);
  }
  if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); confirm(); }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyC' && game.screen === 'title') startCalibration();
  if (e.code === 'KeyR' && game.screen === 'title') { settings.reduced = !settings.reduced; pyro.reduced = settings.reduced; saveSettings(); }
  if (e.code === 'Escape' && game.screen !== 'title') { audio.stop(); game.screen = 'title'; }
});

function toggleMute() {
  settings.muted = !settings.muted;
  audio.setMuted(settings.muted);
  saveSettings();
  muteBtn.textContent = settings.muted ? 'Sound off' : 'Sound on';
  muteBtn.setAttribute('aria-pressed', String(settings.muted));
}
const muteBtn = document.getElementById('mute');
function syncChrome() {
  muteBtn.classList.toggle('is-hidden', game.screen === 'fight' || game.screen === 'calibrate');
}
muteBtn.addEventListener('click', toggleMute);
muteBtn.textContent = settings.muted ? 'Sound off' : 'Sound on';

// Touch / mouse: the lane columns are tap pads; elsewhere confirms.
canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * W;
  const y = ((e.clientY - r.top) / r.height) * H;
  // Touch: the bottom track is split into four big pads (left to right = Left, Down, Up, Right).
  if (game.screen === 'fight' && y >= TRACK_Y - 30) {
    return lanePress(Math.max(0, Math.min(LANES - 1, Math.floor((x / W) * LANES))));
  }
  if (game.screen === 'calibrate') return lanePress(0);
  confirm();
});

// Gamepad: d-pad or face buttons map to lanes, Start confirms.
const padPrev = {};
function pollPads() {
  for (const p of navigator.getGamepads ? navigator.getGamepads() : []) {
    if (!p) continue;
    const map = { 14: 0, 13: 1, 12: 2, 15: 3, 2: 0, 0: 1, 3: 2, 1: 3 };
    for (const [b, lane] of Object.entries(map)) {
      const down = p.buttons[b]?.pressed;
      const k = p.index + ':' + b;
      if (down && !padPrev[k]) {
        if (game.screen === 'fight' || game.screen === 'calibrate') lanePress(lane);
        else confirm();
      }
      padPrev[k] = down;
    }
    const st = p.buttons[9]?.pressed;
    if (st && !padPrev[p.index + ':9']) confirm();
    padPrev[p.index + ':9'] = st;
  }
}

// ---------- Flow ----------
function startFight() {
  const opp = OPPONENTS.rugpull;
  game.match = new Match({ opponent: opp, seed: (Math.random() * 1e9) | 0, typing: hasKeyboard() });
  game.stage = new Stage();
  game.judge = null;
  game.teach = null;
  game.matchId = (game.matchId || 0) + 1;
  game.screen = 'fight';
  game.resultShown = false;
  audio.start(opp.bpm);
  audio.sfxBell();
  audio.sfxCrowd(2, 0.3);
}

function handleEvents(now) {
  const m = game.match, st = game.stage;
  for (const e of m.takeEvents()) {
    st.onEvent(e, now, pyro, audio);
    switch (e.type) {
      case 'countin':
        game.countin = { label: e.label, t: now };
        if (e.label === 'FIGHT') audio.intensity = 1;
        audio.sfxTick();
        break;
      case 'judge':
        game.judge = { grade: e.grade, t: now };
        if (e.grade === 'miss') audio.sfxMiss(); else audio.sfxHit(e.grade);
        if (e.grade === 'perfect') pyro.burst(HIT_X, ROW_Y0 + e.lane * ROW_H + 4, 6, { speed: 50, life: 0.25, pal: ['#fff', '#FFD84A', '#35BDD2'] });
        break;
      case 'predator':
        pyro.word('BE THE', { y: 42, scale: 3, hold: 1.2, now, cx: 160 });
        pyro.word('PREDATOR', { y: 68, scale: 4, hold: 1.8, now, cx: 160, palette: ['#FFFFFF', '#FF6BD6', '#F02E98', '#D10A7A', '#6E0340', '#35BDD2'] });
        audio.intensity = 2;
        audio.sfxPyro();
        game.laneTint = 1;
        break;
      case 'predatorLost':
        audio.intensity = 1;
        break;
      case 'knockdown':
        pyro.word('NEVER', { y: 40, scale: 3, hold: 1.6, now, cx: 160 });
        pyro.word('TAP OUT', { y: 66, scale: 4, hold: 2.0, now, cx: 160 });
        audio.sfxPyro();
        break;
      case 'win':
      case 'lose':
        game.resultAt = now + 2.2;
        if (e.type === 'win') pyro.word('WINNER', { y: 50, scale: 4, hold: 2.5, now, cx: 160 });
        break;
    }
  }
}

// ---------- Calibration: tap along with 8 clicks ----------
function startCalibration() {
  audio.init();
  audio.resume();
  audio.start(100);
  audio.intensity = -1; // metronome only
  game.calib = { taps: [], start: audio.songTime() };
  game.screen = 'calibrate';
}
function calibTap() {
  const c = game.calib;
  const t = audio.songTime();
  const spb = 0.6;
  const nearest = Math.round(t / spb) * spb;
  c.taps.push(t - nearest);
  if (c.taps.length >= 8) {
    const s = [...c.taps].sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    settings.offsetMs = Math.round(med * 1000);
    saveSettings();
    audio.stop();
    game.calibResult = { ms: settings.offsetMs, t: performance.now() };
    game.screen = 'title';
  }
}

// ---------- Loop ----------
let last = performance.now();
function frame(nowMs) {
  const dtReal = Math.min(0.05, (nowMs - last) / 1000);
  last = nowMs;
  const now = nowMs / 1000;
  pollPads();
  audio.pump();
  for (let i = 0; i < game.pressed.length; i++) game.pressed[i] = Math.max(0, game.pressed[i] - dtReal);
  game.laneTint = Math.max(0, game.laneTint - dtReal * 1.5);

  syncChrome();
  if (game.screen === 'fight') {
    const m = game.match, st = game.stage;
    const t = songNow();
    m.update(t);
    handleEvents(now);
    // Hit-stop freezes the stage (not the notes, which stay on the audio clock).
    let dt = dtReal;
    if (st.hitstop > 0) { st.hitstop -= dtReal; dt = 0; }
    st.update(dt, now, m, pyro, audio);
    pyro.update(dtReal, now);
    drawFight(now, t);
    if (m.over && game.resultAt && now > game.resultAt) {
      game.screen = 'result';
      game.resultShownAt = now;
      audio.stop();
      if (m.score > game.best) { game.best = m.score; localStorage.setItem('wg-best', String(m.score)); }
    }
  } else {
    pyro.update(dtReal, now);
    if (game.screen === 'title') drawTitle(now);
    else if (game.screen === 'result') drawResult(now);
    else if (game.screen === 'calibrate') drawCalib(now);
  }
  requestAnimationFrame(frame);
}

function drawFight(now, t) {
  const m = game.match, st = game.stage;
  const beat = 60 / m.bpm;
  const beatPhase = ((t % beat) + beat) % beat / beat;
  ctx.save();
  if (!settings.reduced && st.shake > 0) ctx.translate(Math.round((Math.random() - 0.5) * st.shake), Math.round((Math.random() - 0.5) * st.shake));
  drawArena(ctx, { beatPhase, hype: st.hype, predator: m.predator, now });
  drawRingBack(ctx);
  // Referee at the back.
  drawStageCaption(ctx, m, st, now);
  drawTeach(now, m);
  // Draw the wrestler further back (lower y) first; both on the same line here, so draw victim first.
  const heroOpts = { pose: st.hero.down ? 'down' : st.hero.pose, facing: 1, pal: HERO_PALETTE, parts: HERO_PARTS, glow: m.predator, flash: st.hero.flash > 0, lift: st.hero.lift, rot: st.hero.rot || 0, pivot: st.hero.pivot };
  const oppOpts = { pose: st.opp.down ? 'down' : st.opp.pose, facing: -1, pal: RUGPULL_PALETTE, parts: RUGPULL_PARTS, flash: st.opp.flash > 0, lift: st.opp.lift, rot: st.opp.rot || 0, pivot: st.opp.pivot };
  const heroOnTop = st.throwAnim?.by === 'hero' ? false : true;
  // Shadows.
  for (const a of [st.hero, st.opp]) {
    const sw = a.down ? 22 : Math.max(8, 13 - Math.round(a.lift / 6));
    ctx.fillStyle = 'rgba(40,44,90,0.35)';
    ctx.fillRect(Math.round(a.x) - sw, FLOOR_Y - 1, sw * 2, 2);
    ctx.fillRect(Math.round(a.x) - sw + 3, FLOOR_Y + 1, sw * 2 - 6, 1);
  }
  // When the two wrestlers overlap, rims keep them from merging into one silhouette.
  const close = Math.abs(st.hero.x - st.opp.x) < 26;
  if (heroOnTop) {
    drawWrestler(ctx, st.opp.x, FLOOR_Y, oppOpts);
    if (close) outlineWrestler(ctx, st.hero.x, heroOpts, '#000');
    drawWrestler(ctx, st.hero.x, FLOOR_Y, heroOpts);
  } else {
    drawWrestler(ctx, st.hero.x, FLOOR_Y, heroOpts);
    if (close) outlineWrestler(ctx, st.opp.x, oppOpts, '#000');
    drawWrestler(ctx, st.opp.x, FLOOR_Y, oppOpts);
  }
  // Dust.
  for (const d of st.dust) { ctx.fillStyle = '#c9cbe0'; ctx.fillRect(Math.round(d.x), Math.round(d.y), 2, 2); }
  drawRingFront(ctx, st.ropeSag);
  ctx.restore();

  // Move name banner.
  if (st.moveName && now - st.moveName.t < 1.2) {
    const c = st.moveName.by === 'hero' ? UI.offense : UI.defense;
    const tw = st.moveName.text.length * 12 + 10;
    const slide = Math.round(Math.max(0, 1 - (now - st.moveName.t) * 8) * 40) * (st.moveName.by === 'hero' ? -1 : 1);
    void tw; void c;
    plate(ctx, st.moveName.text, 160 + slide, 30, st.moveName.by === 'hero' ? PINK : CYAN, 2);
  }
  // Pin count.
  if (st.ref.count > 0 && !m.over) plate(ctx, String(st.ref.count), 160, 60, CYAN, 4);
  else if (m.over && st.ref.count === 3 && now - st.ref.slapT < 1.2) plate(ctx, '3', 160, 60, CYAN, 4);

  // Count-in.
  if (game.countin && now - game.countin.t < 0.55) {
    const k = (now - game.countin.t) / 0.55;
    plate(ctx, game.countin.label, 160, 58 - Math.round(k * 6), game.countin.label === 'FIGHT' ? PINK : CYAN, 4);
  }
  if (st.cutIn && now - st.cutIn.t0 < 1.0) drawCutIn(ctx, (now - st.cutIn.t0) / 1.0);

  drawLane(ctx, m, t, { pressed: game.pressed, judge: game.judge, tint: game.laneTint });
  drawHUD(ctx, m, m.opp, RUGPULL_PALETTE, now, m.predator);
  pyro.draw(ctx, now);
  pyro.drawFlash(ctx);
}

// 1px outline hugging the front wrestler's silhouette, so an overlapping pair stays two
// shapes. The sprite is drawn once into a buffer, turned black, then stamped at 4 offsets.
const rimBuf = document.createElement('canvas');
rimBuf.width = W; rimBuf.height = H;
const rimCtx = rimBuf.getContext('2d');
rimCtx.imageSmoothingEnabled = false;
function outlineWrestler(ctx, x, opts, col) {
  rimCtx.setTransform(1, 0, 0, 1, 0, 0);
  rimCtx.globalCompositeOperation = 'source-over';
  rimCtx.clearRect(0, 0, W, H);
  drawWrestler(rimCtx, x, FLOOR_Y, opts);
  rimCtx.globalCompositeOperation = 'source-in';
  rimCtx.fillStyle = col;
  rimCtx.fillRect(0, 0, W, H);
  rimCtx.globalCompositeOperation = 'source-over';
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.drawImage(rimBuf, dx, dy);
}

function drawTitle(now) {
  ctx.fillStyle = UI.bg;
  ctx.fillRect(0, 0, W, H);
  // Starfield: it is a galaxy.
  for (let i = 0; i < 70; i++) {
    const x = (i * 97 + Math.floor(now * (4 + (i % 3) * 6))) % W;
    const y = (i * 53) % H;
    ctx.fillStyle = i % 7 === 0 ? UI.defense : i % 5 === 0 ? UI.offense : '#3a4380';
    ctx.fillRect(x, y, 1, 1);
  }
  const bob = Math.round(Math.sin(now * 2) * 2);
  // Bust built from the source portrait grid.
  ctx.fillStyle = '#000';
  drawTitleBust(ctx, 18, 30 + bob, 6);
  drawText(ctx, '$WRESTLER', 212, 30, UI.offense, { align: 'center', scale: 3, shadow: UI.defense });
  drawText(ctx, 'GALAXY', 212, 58, '#fff', { align: 'center', scale: 3, shadow: UI.defense });
  drawText(ctx, 'FOLLOW THE FLOW LANE.', 212, 92, UI.grey, { align: 'center' });
  drawText(ctx, 'MISS AND YOU LOSE CONTROL.', 212, 102, UI.grey, { align: 'center' });
  if (Math.floor(now * 2) % 2) drawText(ctx, 'PRESS ENTER OR TAP', 212, 122, UI.kickout, { align: 'center', shadow: '#000' });
  drawText(ctx, 'ARROW KEYS  OR TAP', 212, 140, '#fff', { align: 'center' });
  drawText(ctx, 'C CALIBRATE  R MOTION  M MUTE', 212, 152, UI.grey, { align: 'center' });
  const off = game.calibResult && performance.now() - game.calibResult.t < 3000 ? `OFFSET SET ${game.calibResult.ms}MS` : `BEST ${String(game.best).padStart(7, '0')}`;
  drawText(ctx, off, 212, 166, UI.defense, { align: 'center' });
  drawText(ctx, settings.reduced ? 'REDUCED MOTION ON' : '', 4, 172, UI.grey);
  pyro.draw(ctx, now);
}

function drawResult(now) {
  const m = game.match;
  ctx.fillStyle = UI.bg;
  ctx.fillRect(0, 0, W, H);
  const won = m.phase === 'won';
  // Banner.
  ctx.fillStyle = won ? '#0d2a20' : '#2a0d16';
  ctx.fillRect(0, 0, W, 30);
  ctx.fillStyle = won ? UI.kickout : UI.defense;
  ctx.fillRect(0, 29, W, 1);
  drawText(ctx, won ? 'VICTORY' : 'DEFEAT', W / 2, 9, won ? UI.kickout : UI.defense, { align: 'center', scale: 3, shadow: '#000' });

  const total = m.stats.perfect + m.stats.great + m.stats.good + m.stats.miss;
  const acc = total ? Math.round(((m.stats.perfect + m.stats.great * 0.8 + m.stats.good * 0.5) / total) * 100) : 0;
  const grade = acc >= 95 ? 'S' : acc >= 88 ? 'A' : acc >= 78 ? 'B' : acc >= 65 ? 'C' : acc >= 50 ? 'D' : 'E';
  const gradeCol = { S: UI.finisher, A: UI.kickout, B: UI.offense, C: '#FFD84A', D: UI.defense, E: UI.grey }[grade];
  const age = now - (game.resultShownAt ?? now);

  // Portrait / fallen hero side.
  if (won) drawTitleBust(ctx, 16, 40, 5);
  else {
    // Rim light so the navy body does not vanish into the background.
    ctx.fillStyle = '#101638';
    ctx.fillRect(4, 40, 108, 96);
    ctx.fillStyle = UI.offense;
    ctx.fillRect(4, 40, 108, 1);
    ctx.fillRect(4, 135, 108, 1);
    ctx.fillRect(4, 40, 1, 96);
    ctx.fillRect(111, 40, 1, 96);
    drawWrestler(ctx, 58, 128, { pose: 'down', facing: 1, pal: HERO_PALETTE, parts: HERO_PARTS });
    ctx.fillStyle = 'rgba(53,189,210,0.35)';
    ctx.fillRect(20, 130, 76, 1);
    ctx.fillRect(26, 132, 64, 1);
  }

  // Stats panel, with the numbers counting up.
  const px = 128, py = 34;
  ctx.fillStyle = '#0b0f28';
  ctx.fillRect(px, py, 180, 104);
  ctx.fillStyle = '#1b2560';
  ctx.fillRect(px, py, 180, 1);
  ctx.fillRect(px, py + 103, 180, 1);
  ctx.fillRect(px, py, 1, 104);
  ctx.fillRect(px + 179, py, 1, 104);
  const shown = Math.min(1, age / 0.9);
  drawText(ctx, 'SCORE', px + 8, py + 8, UI.grey);
  drawText(ctx, String(Math.round(m.score * shown)), px + 172, py + 4, UI.offense, { align: 'right', scale: 2 });
  drawText(ctx, 'GRADE', px + 8, py + 26, UI.grey);
  drawText(ctx, grade, px + 172, py + 20, gradeCol, { align: 'right', scale: 3 });
  const lines = [
    ['ACCURACY', acc + '%'],
    ['PERFECT', m.stats.perfect],
    ['GREAT', m.stats.great],
    ['GOOD', m.stats.good],
    ['MISS', m.stats.miss],
    ['BEST STREAK', m.maxStreak],
    ['KNOCKDOWNS', m.knockdowns],
  ];
  lines.forEach(([k, v], i) => {
    const y = py + 50 + i * 8;
    drawText(ctx, k, px + 8, y, UI.grey);
    drawText(ctx, String(typeof v === 'number' ? Math.round(v * shown) : v), px + 172, y, '#fff', { align: 'right' });
  });
  if (Math.floor(now * 2) % 2) drawText(ctx, won ? 'PRESS ENTER: BACK TO TITLE' : 'PRESS ENTER: TRY AGAIN', W / 2, 156, UI.kickout, { align: 'center' });
}

// All in-fight text goes on a solid black plate in one flat colour (pink or cyan), no shadow,
// so it reads over the crowd, the ring and the wrestlers alike.
const PINK = '#FF6BD6';
const CYAN = '#35E0F0';
function plate(ctx, text, cx, y, col, scale = 1) {
  const tw = text.length * 6 * scale;
  const pad = 2 * scale;
  const h = 7 * scale + pad * 2;
  const x0 = Math.round(cx - tw / 2 - pad);
  ctx.fillStyle = '#000';
  ctx.fillRect(x0, y - pad, Math.round(tw + pad * 2), h);
  drawText(ctx, text, cx, y, col, { align: 'center', scale });
}

// The current move, its stage caption and a pip row: one pip per stage, filled as it lands.
function drawStageCaption(ctx, m, st, now) {
  const seq = m.seq;
  const move = seq ? seq.move : null;
  if (!move) return;
  const perStage = seq.kind === 'finisher' ? 2 : 1;
  const done = Math.min(move.stages.length, Math.ceil(seq.hits / perStage));
  const col = seq.kind === 'defense' ? UI.defense : seq.kind === 'finisher' ? UI.finisher : UI.offense;
  const label = move.name;
  const lw = label.length * 6 + 10;
  plate(ctx, label, 160, 8, seq.kind === 'defense' ? CYAN : PINK);
  // Pips: filled = stages of the move already performed.
  const pw = move.stages.length * 5 + 2;
  const px0 = Math.round(160 - pw / 2);
  ctx.fillStyle = '#000';
  ctx.fillRect(px0 - 1, 17, pw + 2, 6);
  for (let i = 0; i < move.stages.length; i++) {
    ctx.fillStyle = i < done ? col : '#2a3468';
    ctx.fillRect(px0 + i * 5, 18, 3, 4);
  }
  // Stage caption (CHOP!, LOCK UP, SLAM!...) fades fast so it reads as a beat, not a label.
  const stg = st.stageFx;
  if (stg && stg.stage && stg.stage.label && now - stg.t0 < 0.6) {
    const a = Math.min(1, (0.6 - (now - stg.t0)) * 4);
    ctx.globalAlpha = a;
    plate(ctx, stg.stage.label, 160, 30, stg.heroAttacks === false ? CYAN : PINK, 2);
    ctx.globalAlpha = 1;
  }
}

// One-line teach cards, shown the first time a phase type appears in a match.
const TAUGHT = new Set();
const TEACH = {
  offense: 'FOLLOW THE ARROWS',
  defense: 'BLOCK 4 IN A ROW TO TAKE CONTROL',
  kickout: 'SPAM ANY ARROW KEY TO KICK OUT',
  finisher: 'CHORDS: PRESS BOTH ARROWS TOGETHER',
  special: 'TYPE THE NAME ON THE BEAT',
};

function drawTeach(now, m) {
  const kind = m.seq && m.seq.typed ? 'special' : m.phase;
  if (!TEACH[kind]) return;
  const key = game.matchId + ':' + kind;
  if (!TAUGHT.has(key)) { TAUGHT.add(key); game.teach = { text: TEACH[kind], t: now }; }
  if (!game.teach || now - game.teach.t > 3.2) return;
  const a = Math.min(1, (now - game.teach.t) * 4) * Math.min(1, Math.max(0, (3.2 - (now - game.teach.t)) * 2));
  ctx.globalAlpha = a;
  plate(ctx, game.teach.text, 160, 87, kind === 'defense' || kind === 'kickout' ? CYAN : PINK);
  ctx.globalAlpha = 1;
}

function drawCalib(now) {
  ctx.fillStyle = UI.bg;
  ctx.fillRect(0, 0, W, H);
  const t = audio.songTime();
  const ph = ((t / 0.6) % 1 + 1) % 1;
  const r = Math.round(20 - ph * 12);
  ctx.fillStyle = ph < 0.12 ? '#fff' : UI.offense;
  ctx.fillRect(W / 2 - r, 80 - r, r * 2, r * 2);
  drawText(ctx, 'TAP ANY ARROW ON THE CLICK', W / 2, 20, '#fff', { align: 'center' });
  drawText(ctx, `${game.calib.taps.length} / 8`, W / 2, 130, UI.kickout, { align: 'center', scale: 2 });
  drawText(ctx, 'ESC TO CANCEL', W / 2, 160, UI.grey, { align: 'center' });
}

// Test hook: lets a headless harness drive real lane presses and read match state.
window.__wg = { game, lanePress, get audio() { return audio; }, get stage() { return game.stage; }, get match() { return game.match; } };

requestAnimationFrame(frame);
