// Snail sprite renderers – "Snäckmageddon"
// Every style draws a snail with its foot centred on (0,0), facing right.
// The game flips it horizontally for left-facing snails.
//
//   drawSnail(ctx, style, {
//     x, y,          world position of the foot's bottom centre
//     facing,        1 = right, -1 = left
//     color,         team colour (CSS string)
//     scale,         1 = ~48 px wide
//     t,             time in seconds (animation)
//     walking,       true while moving (foot ripple, stalk sway)
//     aim,           aim angle in radians (eye direction), optional
//     dead,          draw as a gravestone-ish empty shell
//     look,          cosmetics { shell, hat } (js/cosmetics.js), optional
//     hp,            health 0–100: cracks appear below 70, optional
//     retract,       0–1, how far the eye stalks are pulled in, optional.
//                    A touched snail snaps them in and lets them back out
//                    slowly. At 1 the stalks are stubs on the head. The pixel
//                    style ignores it: its stalks are part of the sprite map.
//   })
import { drawShellPattern, drawHat, drawCracks } from './cosmetics.js';

export const SNAIL_STYLES = [
  {
    id: 'cartoon',
    name: 'Tecknad (Worms-stil)',
    blurb:
      'Stora ögon på långa stjälkar, knubbigt skal i lagfärg med gräddvit spiral. ' +
      'Uttrycksfull och lättläst på små skärmar – närmast Worms-känslan.',
  },
  {
    id: 'achatina',
    name: 'Naturtrogen Achatina',
    blurb:
      'Långt koniskt skal med mörka band, som riktiga afrikanska jättesnäckor. ' +
      'Jordiga färger, laget markeras med ett band runt skalspetsen.',
  },
  {
    id: 'kommando',
    name: 'Kommandosnäcka',
    blurb:
      'Tecknad grund med hjälm, kamouflageskal och lagfärgad bandana. ' +
      'Militär Worms-humor, arg blick när den siktar.',
  },
  {
    id: 'pixel',
    name: 'Retro pixel',
    blurb:
      '16-bitars pixelsprite i 24×16. Ger tydlig nostalgi-look och är extremt billig att rita.',
  },
  {
    id: 'flat',
    name: 'Flat / minimalistisk',
    blurb:
      'Rena geometriska former utan konturer. Modern, ren look som skalar snyggt till ikoner och UI.',
  },
];

// ---------- colour helpers ----------
const colorCache = new Map();
export function shade(hex, amt) {
  const key = hex + '|' + amt;
  if (colorCache.has(key)) return colorCache.get(key);
  const c = parseColor(hex);
  const f = (v) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  const out = `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
  colorCache.set(key, out);
  return out;
}
function parseColor(str) {
  if (str.startsWith('#')) {
    let h = str.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = str.match(/\d+/g);
  return m ? m.slice(0, 3).map(Number) : [200, 200, 200];
}

// ---------- shared pieces ----------
function ellipse(ctx, x, y, rx, ry, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
}

function eyeStalks(ctx, o, cfg) {
  // cfg: {x0, y0, len, spread, sway, eyeR, pupilR, stalkW, stalkColor, angry, aim}
  // o.retract 0–1 pulls the stalks in: shorter, stiller, and the eyes shrink
  // with them until only a stub is left. That is what a real snail does the
  // moment it is touched.
  const out = 1 - Math.max(0, Math.min(1, o.retract || 0));
  const sway = Math.sin(o.t * 4) * (o.walking ? 3 : 1) * out;
  const len = cfg.len * out;
  const eyeR = cfg.eyeR * out;
  const stalks = [
    { dx: -3, top: -len, lean: (-3 + sway) * out },
    { dx: 4, top: -len - 3 * out, lean: (2 + sway) * out },
  ];
  for (const s of stalks) {
    const bx = cfg.x0 + s.dx;
    const by = cfg.y0;
    const tx = bx + cfg.spread + s.lean;
    const ty = by + s.top;
    ctx.strokeStyle = cfg.stalkColor;
    ctx.lineWidth = cfg.stalkW;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx + 2, by + s.top * 0.5, tx, ty);
    ctx.stroke();
    // eye — once it is pulled in far enough there is nothing left but a stub
    if (cfg.eyeR > 0 && eyeR > 0.8) {
      const pupilR = cfg.pupilR * out;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(tx, ty - 1, eyeR, 0, Math.PI * 2);
      ctx.fill();
      if (cfg.outline) {
        ctx.strokeStyle = cfg.outline;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const a = o.aim ?? 0;
      const px = tx + Math.cos(a) * eyeR * 0.4;
      const py = ty - 1 - Math.sin(a) * eyeR * 0.4;
      ctx.fillStyle = '#1b1b1b';
      ctx.beginPath();
      ctx.arc(px, py, pupilR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(px - pupilR * 0.35, py - pupilR * 0.4, pupilR * 0.3, 0, Math.PI * 2);
      ctx.fill();
      if (cfg.angry) {
        ctx.strokeStyle = '#3a2a1a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tx - eyeR - 1, ty - eyeR - 3);
        ctx.lineTo(tx + eyeR, ty - eyeR);
        ctx.stroke();
      }
    } else if (cfg.eyeR > 0) {
      // A style that has eyes is here because they are pulled in: leave a stub
      // of tentacle in the body colour. A dark tip would read as sunglasses.
      ctx.fillStyle = cfg.stalkColor;
      ctx.beginPath();
      ctx.arc(tx, ty, cfg.stalkW * 0.8, 0, Math.PI * 2);
      ctx.fill();
      if (cfg.outline) {
        ctx.strokeStyle = cfg.outline;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    } else {
      // a style whose stalks end in a dark point by design
      ctx.fillStyle = cfg.tipColor || '#222';
      ctx.beginPath();
      ctx.arc(tx, ty, cfg.stalkW * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function spiral(ctx, cx, cy, r, color, width, turns = 1.6) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const ang = k * Math.PI * 2 * turns + Math.PI * 0.7;
    const rr = r * 0.12 + k * r * 0.72;
    const x = cx + Math.cos(ang) * rr;
    const y = cy + Math.sin(ang) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function footBase(ctx, o, color, opts = {}) {
  const ripple = o.walking ? Math.sin(o.t * 10) * 1.2 : 0;
  const w = opts.w ?? 22;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-w, 0);
  ctx.quadraticCurveTo(-w - 2, -6 + ripple, -w + 8, -8);
  ctx.lineTo(w - 12, -8 - ripple);
  ctx.quadraticCurveTo(w + 2, -12, w + 1, -4);
  ctx.quadraticCurveTo(w + 2, 0, w - 4, 0);
  ctx.closePath();
  ctx.fill();
  if (opts.outline) {
    ctx.strokeStyle = opts.outline;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// ---------- STYLE: cartoon ----------
function drawCartoon(ctx, o, gear) {
  const body = '#e0a878';
  const bodyDark = '#b9805a';
  const outline = '#4a2e1c';
  const s = Math.sin(o.t * 3);

  // foot
  footBase(ctx, o, body, { outline });
  // belly stripe
  ctx.fillStyle = bodyDark;
  ctx.beginPath();
  ctx.moveTo(-20, -1);
  ctx.lineTo(19, -1);
  ctx.lineTo(18, 0);
  ctx.lineTo(-21, 0);
  ctx.fill();

  // head / neck
  ctx.fillStyle = body;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(4, -6);
  ctx.quadraticCurveTo(8, -20 + s * 0.5, 18, -20);
  ctx.quadraticCurveTo(26, -20, 24, -12);
  ctx.quadraticCurveTo(23, -6, 16, -6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // shell
  const shellColor = gear ? '#5c7a3a' : o.color;
  ctx.fillStyle = shellColor;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(-6, -15, 13.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (gear) {
    // camo blotches
    ctx.save();
    ctx.beginPath();
    ctx.arc(-6, -15, 13.5, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#3e5626';
    ellipse(ctx, -12, -18, 5, 3.5, 0.4); ctx.fill();
    ellipse(ctx, -2, -8, 5, 3, -0.3); ctx.fill();
    ellipse(ctx, 2, -20, 4, 2.5, 0.2); ctx.fill();
    ctx.fillStyle = '#8a9a5a';
    ellipse(ctx, -9, -10, 4, 2.5, 0.2); ctx.fill();
    ctx.restore();
  }
  spiral(ctx, -6, -15, 13.5, gear ? '#2c3d1a' : '#fff3d6', 2.6);
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ellipse(ctx, -11, -22, 3.5, 2, -0.6);
  ctx.fill();

  // small mouth
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(19, -11, 3, 0.2, Math.PI - 0.6);
  ctx.stroke();

  // eyes
  eyeStalks(ctx, o, {
    x0: 16, y0: -19, len: 12, spread: 2, eyeR: 4.6, pupilR: 2.2,
    stalkW: 3.2, stalkColor: body, outline, angry: gear,
  });

  if (gear) {
    // helmet on shell
    ctx.fillStyle = '#4b5a2e';
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(-6, -19, 14, Math.PI * 1.05, Math.PI * 1.95);
    ctx.lineTo(9, -18);
    ctx.lineTo(-21, -18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#5f7040';
    ctx.fillRect(-20, -21, 30, 3);
    // strap
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-17, -18);
    ctx.quadraticCurveTo(-8, -6, 4, -14);
    ctx.stroke();
    // bandana on head, team colour
    ctx.fillStyle = o.color;
    ctx.beginPath();
    ctx.moveTo(9, -19);
    ctx.quadraticCurveTo(17, -23, 25, -18);
    ctx.lineTo(24, -15);
    ctx.quadraticCurveTo(17, -19, 10, -16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // bandana tail
    ctx.beginPath();
    ctx.moveTo(9, -18);
    ctx.lineTo(1, -23 + s);
    ctx.lineTo(3, -16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

// ---------- STYLE: achatina (natural) ----------
function drawAchatina(ctx, o) {
  const body = '#8f7d63';
  const bodyDark = '#6b5a44';
  const shellA = '#a0622e';
  const shellB = '#4b2d16';
  const s = Math.sin(o.t * 3);

  // foot – longer, lower
  footBase(ctx, o, body, { w: 24 });
  // skin texture
  ctx.fillStyle = 'rgba(60,45,30,0.25)';
  for (let i = 0; i < 9; i++) {
    const x = -20 + i * 5;
    ctx.beginPath();
    ctx.arc(x, -4 + ((i * 7) % 3), 1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = bodyDark;
  ctx.fillRect(-24, -1.5, 47, 1.5);

  // head
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(6, -7);
  ctx.quadraticCurveTo(12, -15 + s * 0.4, 20, -15);
  ctx.quadraticCurveTo(27, -15, 26, -9);
  ctx.quadraticCurveTo(25, -5, 18, -6);
  ctx.closePath();
  ctx.fill();

  // conical shell: elongated cone, apex pointing up and back
  const shellPath = () => {
    ctx.beginPath();
    ctx.moveTo(-26, 0);
    ctx.quadraticCurveTo(-10, -11, 8, -11);
    ctx.quadraticCurveTo(16, -11, 16, -3);
    ctx.quadraticCurveTo(16, 8, 6, 9);
    ctx.quadraticCurveTo(-10, 10, -26, 0);
    ctx.closePath();
  };
  ctx.save();
  ctx.translate(-8, -16);
  ctx.rotate(0.6);
  shellPath();
  const g = ctx.createLinearGradient(-20, -10, 10, 10);
  g.addColorStop(0, '#d0955a');
  g.addColorStop(1, shellA);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // growth bands
  ctx.strokeStyle = shellB;
  ctx.lineWidth = 2.2;
  for (let i = 0; i < 6; i++) {
    const x = 12 - i * 6;
    ctx.beginPath();
    ctx.moveTo(x, -14);
    ctx.quadraticCurveTo(x - 4, 0, x + 1, 14);
    ctx.stroke();
  }
  // lighter streaks
  ctx.strokeStyle = 'rgba(255,230,180,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const x = 9 - i * 6;
    ctx.beginPath();
    ctx.moveTo(x, -14);
    ctx.quadraticCurveTo(x - 4, 0, x + 1, 14);
    ctx.stroke();
  }
  // aperture lip
  ctx.fillStyle = 'rgba(255,240,220,0.5)';
  ellipse(ctx, 12, 0, 3, 7);
  ctx.fill();
  // team band near apex
  ctx.fillStyle = o.color;
  ctx.beginPath();
  ctx.moveTo(-20, -12);
  ctx.lineTo(-15, -12);
  ctx.lineTo(-15, 12);
  ctx.lineTo(-20, 12);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  shellPath();
  ctx.strokeStyle = '#3a2210';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // lower tentacles
  ctx.strokeStyle = body;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(24, -8);
  ctx.lineTo(29, -6 + s * 0.5);
  ctx.moveTo(23, -10);
  ctx.lineTo(28, -12 + s * 0.5);
  ctx.stroke();

  // eye stalks – small dark eyes at tips
  eyeStalks(ctx, o, {
    x0: 19, y0: -14, len: 13, spread: 3, eyeR: 0, stalkW: 2.4, stalkColor: body,
    tipColor: '#2a1d12',
  });
}

// ---------- STYLE: pixel ----------
const PIXEL_MAP = [
  '..................ww..ww',
  '..................wk..wk',
  '...................b..b.',
  '........TTTTT......b..b.',
  '......TTTTTTTTT....b..b.',
  '.....TTTtttttTTT...b..b.',
  '....TTTtcccccTTTT..b..b.',
  '....TTtccTTTctTTT.bbbb..',
  '...TTTtcTTTTTctTT.bbbbb.',
  '...TTTtcTTTTctTTTbbbbbb.',
  '...TTTttccccTTTTTbbbbbb.',
  '....TTTTTttTTTTTbbbbbbb.',
  '....TTTTTTTTTTTbbbbbbbb.',
  '.....TTTTTTTTTbbbbbbbbb.',
  '..bbbbbbbbbbbbbbbbbbbbb.',
  '.BBBBBBBBBBBBBBBBBBBBBB.',
];
const PIXEL_W = 24;
const PIXEL_H = 16;
function drawPixel(ctx, o) {
  const px = 2; // pixel size at scale 1
  const pal = {
    w: '#ffffff',
    k: '#111111',
    b: '#d9a066',
    B: '#8f5a2b',
    T: o.color,
    t: shade(o.color, -0.25),
    c: '#fff1c9',
  };
  const step = o.walking ? Math.round(Math.sin(o.t * 10)) : 0;
  const left = -PIXEL_W * px * 0.5;
  const top = -PIXEL_H * px;
  for (let y = 0; y < PIXEL_H; y++) {
    const row = PIXEL_MAP[y];
    for (let x = 0; x < PIXEL_W; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      ctx.fillStyle = pal[ch];
      // eye stalks wobble one pixel when walking
      const dx = y < 7 && (ch === 'b' || ch === 'w' || ch === 'k') ? step : 0;
      ctx.fillRect(left + (x + dx) * px, top + y * px, px * 1.08, px * 1.08);
    }
  }
}

// ---------- STYLE: flat ----------
function drawFlat(ctx, o) {
  const body = '#f0c27b';
  const s = Math.sin(o.t * 3);
  footBase(ctx, o, body, { w: 22 });
  // head
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(6, -6);
  ctx.quadraticCurveTo(10, -19 + s * 0.4, 19, -19);
  ctx.quadraticCurveTo(26, -19, 24, -11);
  ctx.quadraticCurveTo(23, -6, 16, -6);
  ctx.closePath();
  ctx.fill();
  // shell
  ctx.fillStyle = o.color;
  ctx.beginPath();
  ctx.arc(-6, -15, 13.5, 0, Math.PI * 2);
  ctx.fill();
  spiral(ctx, -6, -15, 13.5, 'rgba(255,255,255,0.85)', 3.4, 1.5);
  // eyes: thin stalks with black dots
  eyeStalks(ctx, o, {
    x0: 17, y0: -18, len: 11, spread: 2, eyeR: 0, stalkW: 2.2, stalkColor: body,
    tipColor: '#222',
  });
  // cheek
  ctx.fillStyle = 'rgba(240,120,110,0.5)';
  ctx.beginPath();
  ctx.arc(21, -10, 2, 0, Math.PI * 2);
  ctx.fill();
}

function drawDead(ctx, o) {
  // an empty, cracked shell
  ctx.fillStyle = '#c9b8a0';
  ctx.strokeStyle = '#5a4a3a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, -11, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  spiral(ctx, 0, -11, 11, '#8f7d63', 2, 1.4);
  ctx.strokeStyle = '#3a2a1a';
  ctx.beginPath();
  ctx.moveTo(-3, -20);
  ctx.lineTo(1, -13);
  ctx.lineTo(-2, -8);
  ctx.stroke();
}

export function drawSnail(ctx, style, o) {
  const scale = o.scale ?? 1;
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.scale(scale * (o.facing ?? 1), scale);
  if (o.dead) {
    drawDead(ctx, o);
  } else {
    switch (style) {
      case 'achatina': drawAchatina(ctx, o); break;
      case 'kommando': drawCartoon(ctx, o, true); break;
      case 'pixel':
        ctx.imageSmoothingEnabled = false;
        drawPixel(ctx, o);
        break;
      case 'flat': drawFlat(ctx, o); break;
      default: drawCartoon(ctx, o, false);
    }
    if (o.look && (style === 'cartoon' || style === 'flat')) drawShellPattern(ctx, o.look, o.color);
    if (style === 'cartoon' || style === 'flat' || style === 'kommando') drawCracks(ctx, o.hp);
    if (o.look) drawHat(ctx, o.look);
  }
  ctx.restore();
}

export const TEAM_COLORS = [
  { id: 'red', name: 'Röd', hex: '#e2453c' },
  { id: 'blue', name: 'Blå', hex: '#3b82f6' },
  { id: 'green', name: 'Grön', hex: '#3aaa5c' },
  { id: 'yellow', name: 'Gul', hex: '#f0c419' },
];
