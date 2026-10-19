#!/usr/bin/env node
/*
 * AmritaKalakriti — placeholder artwork generator.
 *
 * Writes painterly, self-contained SVG renditions of traditional Indian art
 * styles into public/images/art/. Zero dependencies; deterministic output
 * (seeded PRNG per artwork).
 *
 *   node scripts/generate-art.js            # generate every artwork
 *   node scripts/generate-art.js konark-sun # generate only matching file(s)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'images', 'art');

/* ------------------------------------------------------------------ */
/* Core helpers                                                        */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Random helper bundle around a seeded generator. */
function makeRng(seed) {
  const r = mulberry32(typeof seed === 'string' ? hashStr(seed) : seed);
  r.range = (a, b) => a + r() * (b - a);
  r.int = (a, b) => Math.floor(a + r() * (b - a + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.sign = () => (r() < 0.5 ? -1 : 1);
  r.gauss = () => {
    let u = 0;
    for (let i = 0; i < 4; i++) u += r();
    return (u - 2) / 0.577;
  };
  return r;
}

const PI = Math.PI;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Compact number formatting (1 decimal, no trailing zeros, no -0). */
function f(v) {
  const r = Math.round(v * 10) / 10;
  return (r === 0 ? 0 : r).toString();
}
/** Integer formatting. */
function fi(v) {
  const r = Math.round(v);
  return (r === 0 ? 0 : r).toString();
}
/** Join a list of numbers into a compact path fragment. */
function nums(list, fmt = f) {
  let s = '';
  for (let i = 0; i < list.length; i++) {
    const t = fmt(list[i]);
    if (i > 0 && t[0] !== '-') s += ' ';
    s += t;
  }
  return s;
}

const pol = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

/* --- colour ------------------------------------------------------- */
function rgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function hex(c) {
  return (
    '#' +
    c
      .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
      .join('')
  );
}
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scalec = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
function gradc(stops, t) {
  // stops: [[t, [r,g,b]], ...] sorted
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mixc(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}
const stopsOf = (arr) => arr.map(([t, h]) => [t, rgb(h)]);

/* --- noise -------------------------------------------------------- */
function makeNoise2(rng) {
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = rng();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const v = (x, y) => vals[perm[(perm[x & 255] + y) & 255]];
  const n = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
    const a = v(xi, yi), b = v(xi + 1, yi), c = v(xi, yi + 1), d = v(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), w);
  };
  n.fbm = (x, y, oct = 4) => {
    let s = 0, amp = 0.5, fr = 1, tot = 0;
    for (let i = 0; i < oct; i++) {
      s += amp * n(x * fr, y * fr);
      tot += amp;
      amp *= 0.5;
      fr *= 2.03;
    }
    return s / tot;
  };
  return n;
}

/* --- paths -------------------------------------------------------- */
/** Smooth path through points (Catmull-Rom -> cubic Bezier). */
function smoothPath(pts, closed = false, k = 1, fmt = f) {
  const n = pts.length;
  if (n < 2) return '';
  const P = (i) => (closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)]);
  let d = `M${nums(pts[0], fmt)}`;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const c1 = [p1[0] + ((p2[0] - p0[0]) / 6) * k, p1[1] + ((p2[1] - p0[1]) / 6) * k];
    const c2 = [p2[0] - ((p3[0] - p1[0]) / 6) * k, p2[1] - ((p3[1] - p1[1]) / 6) * k];
    d += `C${nums([c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]], fmt)}`;
  }
  return d + (closed ? 'Z' : '');
}
function polyPath(pts, closed = true, fmt = f) {
  return 'M' + pts.map((p) => nums(p, fmt)).join('L') + (closed ? 'Z' : '');
}
/** Wobbly closed blob around a centre. */
function blob(rng, cx, cy, rx, ry, n = 10, jit = 0.18, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const k = 1 + (rng() - 0.5) * 2 * jit;
    const x = Math.cos(a) * rx * k, y = Math.sin(a) * ry * k;
    pts.push([cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]);
  }
  return smoothPath(pts, true);
}
/** Leaf / petal shape from base point toward angle, given length & width. */
function leafPts(x, y, ang, len, wid, n = 6, tipSharp = 1, asym = 0, pk = 0.85) {
  const left = [], right = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = Math.pow(Math.sin(PI * Math.pow(t, pk)), tipSharp) * wid * 0.5;
    const ax = x + Math.cos(ang) * len * t, ay = y + Math.sin(ang) * len * t;
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    left.push([ax + nx * w * (1 + asym), ay + ny * w * (1 + asym)]);
    right.push([ax - nx * w * (1 - asym), ay - ny * w * (1 - asym)]);
  }
  return left.concat(right.reverse().slice(1, -1));
}
function leafPath(x, y, ang, len, wid, opts = {}) {
  return smoothPath(leafPts(x, y, ang, len, wid, opts.n || 6, opts.sharp || 1, opts.asym || 0, opts.pk || 0.85), true);
}

/* --- svg ---------------------------------------------------------- */
function svgDoc(w, h, defs, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice">` +
    `<defs>${defs}</defs>${body}</svg>\n`
  );
}

/* --- filters ------------------------------------------------------ */
const FX = {
  /** Hand-drawn wobble via displacement. */
  wobble(id, freq = 0.04, scale = 4, seed = 1, oct = 2, w = 0, h = 0) {
    const region = w ? `filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"` : 'x="-5%" y="-5%" width="110%" height="110%"';
    return `<filter id="${id}" ${region}><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${oct}" seed="${seed}"/><feDisplacementMap in="SourceGraphic" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/></filter>`;
  },
  /** Canvas weave + grain multiplied over the source. */
  canvas(id, seed = 3, strength = 1, w = 1000, h = 1000) {
    return (
      `<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.9 0.13" numOctaves="2" seed="${seed}" result="a"/>` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.13 0.9" numOctaves="2" seed="${seed + 1}" result="b"/>` +
      `<feComposite in="a" in2="b" operator="arithmetic" k2="0.5" k3="0.5" result="w"/>` +
      `<feDiffuseLighting in="w" surfaceScale="${2.2 * strength}" diffuseConstant="1" lighting-color="#fff" result="l"><feDistantLight azimuth="225" elevation="58"/></feDiffuseLighting>` +
      `<feComponentTransfer in="l" result="l2"><feFuncR type="linear" slope="0.5" intercept="0.62"/><feFuncG type="linear" slope="0.5" intercept="0.62"/><feFuncB type="linear" slope="0.5" intercept="0.62"/></feComponentTransfer>` +
      `<feBlend in="SourceGraphic" in2="l2" mode="multiply"/>` +
      `</filter>`
    );
  },
  /** Thick-paint relief (luminance driven) + bristly edges. */
  impasto(id, seed = 5, relief = 2.5, bristle = 3) {
    return (
      `<filter id="${id}" x="-2%" y="-2%" width="104%" height="104%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.25 0.05" numOctaves="2" seed="${seed}" result="t"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="t" scale="${bristle}" xChannelSelector="R" yChannelSelector="G" result="d"/>` +
      `<feColorMatrix in="d" type="luminanceToAlpha" result="lum"/>` +
      `<feGaussianBlur in="lum" stdDeviation="1.1" result="bl"/>` +
      `<feSpecularLighting in="bl" surfaceScale="${relief}" specularConstant="0.55" specularExponent="16" lighting-color="#fff4dc" result="s"><feDistantLight azimuth="225" elevation="42"/></feSpecularLighting>` +
      `<feComposite in="s" in2="d" operator="in" result="s2"/>` +
      `<feComposite in="d" in2="s2" operator="arithmetic" k2="1" k3="0.45"/>` +
      `</filter>`
    );
  },
  /** Speckle grain generated from noise (apply to a full-size rect). */
  speckle(id, color = '#3a2a1a', freq = 0.85, k = 1.6, b = -0.75, seed = 9) {
    const c = rgb(color).map((v) => (v / 255).toFixed(3));
    return `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="3" seed="${seed}"/><feColorMatrix values="0 0 0 0 ${c[0]} 0 0 0 0 ${c[1]} 0 0 0 0 ${c[2]} ${k} 0 0 0 ${b}"/></filter>`;
  },
  /** Paper tooth: lit bumpy surface, meant for multiply overlay. */
  paper(id, freq = 0.04, scale = 1.6, seed = 11) {
    return (
      `<filter id="${id}" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="5" seed="${seed}" result="n"/>` +
      `<feDiffuseLighting in="n" surfaceScale="${scale}" diffuseConstant="1.15" lighting-color="#fff" result="l"><feDistantLight azimuth="235" elevation="60"/></feDiffuseLighting>` +
      `<feComponentTransfer><feFuncR type="linear" slope="0.55" intercept="0.5"/><feFuncG type="linear" slope="0.55" intercept="0.5"/><feFuncB type="linear" slope="0.55" intercept="0.5"/></feComponentTransfer>` +
      `</filter>`
    );
  },
  /** Watercolour wash: wobbly edge, pooled darker rim, granulation. */
  watercolor(id, seed = 2, wob = 16, freq = 0.025, rim = 0.9, gran = 0.35) {
    const k = (0.55 * rim).toFixed(2), k1 = (1 + 0.55 * rim).toFixed(2);
    return (
      `<filter id="${id}" x="-15%" y="-15%" width="130%" height="130%" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="4" seed="${seed}" result="t"/>` +
      `<feDisplacementMap in="SourceGraphic" in2="t" scale="${wob}" xChannelSelector="R" yChannelSelector="G" result="d"/>` +
      `<feGaussianBlur in="d" stdDeviation="3.5" result="b"/>` +
      `<feComposite in="d" in2="b" operator="out" result="e"/>` +
      `<feColorMatrix in="e" type="matrix" values="${k1} 0 0 0 -${k} 0 ${k1} 0 0 -${k} 0 0 ${k1} 0 -${k} 0 0 0 ${(1.6 * rim).toFixed(2)} 0" result="ek"/>` +
      `<feMerge result="m"><feMergeNode in="d"/><feMergeNode in="ek"/></feMerge>` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="${seed + 7}" result="g"/>` +
      `<feColorMatrix in="g" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 ${(-gran * 2.2).toFixed(2)} ${(1 + gran * 0.6).toFixed(2)}" result="gm"/>` +
      `<feComposite in="m" in2="gm" operator="in"/>` +
      `</filter>`
    );
  },
  /** Soft wet-in-wet bleed (blurred + displaced). */
  bleed(id, blur = 14, seed = 4, wob = 30) {
    return `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="${seed}" result="t"/><feDisplacementMap in="SourceGraphic" in2="t" scale="${wob}" xChannelSelector="R" yChannelSelector="G" result="d"/><feGaussianBlur in="d" stdDeviation="${blur}"/></filter>`;
  },
  blur(id, sd = 4, pad = 30) {
    return `<filter id="${id}" x="-${pad}%" y="-${pad}%" width="${100 + 2 * pad}%" height="${100 + 2 * pad}%"><feGaussianBlur stdDeviation="${sd}"/></filter>`;
  },
};

/** Gradient builders. */
function linGrad(id, stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1, extra = '') {
  return (
    `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${extra}>` +
    stops.map(([o, c, op]) => `<stop offset="${o}" stop-color="${c}"${op !== undefined ? ` stop-opacity="${op}"` : ''}/>`).join('') +
    `</linearGradient>`
  );
}
function radGrad(id, stops, cx = 0.5, cy = 0.5, r = 0.5, extra = '') {
  return (
    `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}"${extra}>` +
    stops.map(([o, c, op]) => `<stop offset="${o}" stop-color="${c}"${op !== undefined ? ` stop-opacity="${op}"` : ''}/>`).join('') +
    `</radialGradient>`
  );
}

/* ------------------------------------------------------------------ */
/* Painterly brush-stroke engine (canvas paintings)                    */
/* ------------------------------------------------------------------ */
/**
 * Scatter short curved brush strokes over a region, colouring each from a
 * scene colour function, and group them by colour/width for compact output.
 */
function brushStrokes(rng, o) {
  const {
    x0 = 0, y0 = 0, x1, y1, sp, len, wid, col, ang,
    jit = 0.07, hue = 0.04, bend = 0.25, angJit = 0.25, mask, K = 36, wb = 3,
  } = o;
  const list = [];
  for (let y = y0; y < y1; y += sp) {
    for (let x = x0; x < x1; x += sp) {
      const px = x + rng() * sp, py = y + rng() * sp;
      if (mask && !mask(px, py)) continue;
      let c = col(px, py, rng);
      if (!c) continue;
      const j = 1 + (rng() - 0.5) * 2 * jit;
      c = c.map((v) => clamp(v * j * (1 + (rng() - 0.5) * 2 * hue), 0, 255));
      const L = len[0] + rng() * (len[1] - len[0]);
      const wt = rng();
      const W = wid[0] + (Math.min(wb - 1, Math.floor(wt * wb)) / Math.max(1, wb - 1)) * (wid[1] - wid[0]);
      const a = ang(px, py) + (rng() - 0.5) * 2 * angJit;
      const ca = Math.cos(a), sa = Math.sin(a);
      const sx = px - (ca * L) / 2, sy = py - (sa * L) / 2;
      const b = (rng() - 0.5) * 2 * bend * L;
      const cx = (ca * L) / 2 - sa * b, cy = (sa * L) / 2 + ca * b;
      const isx = Math.round(sx), isy = Math.round(sy);
      let seg, ex, ey;
      if (o.horiz) { const l = Math.round(L); seg = `h${l}`; ex = isx + l; ey = isy; }
      else {
        const dx = Math.round(ca * L), dy = Math.round(sa * L);
        seg = bend ? `q${nums([cx, cy, dx, dy], fi)}` : `l${nums([dx, dy], fi)}`;
        ex = isx + dx; ey = isy + dy;
      }
      list.push({ c, W: Math.round(W), sx: isx, sy: isy, seg, ex, ey });
    }
  }
  if (!list.length) return '';
  const pal = kmeans(rng, list.map((s) => s.c), K);
  const groups = new Map();
  for (const s of list) {
    const key = hex(pal.centers[pal.nearest(s.c)]) + '|' + s.W;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  let out = '';
  for (const [key, ss] of groups) {
    const [c, w] = key.split('|');
    // relative moves between strokes keep the numbers short
    ss.sort((a, b) => Math.floor(a.sy / 40) - Math.floor(b.sy / 40) || a.sx - b.sx);
    let d = '', px = 0, py = 0;
    ss.forEach((s, i) => {
      d += i === 0 ? `M${s.sx} ${s.sy}` : `m${nums([s.sx - px, s.sy - py], fi)}`;
      d += s.seg;
      px = s.ex; py = s.ey;
    });
    out += `<path stroke="${c}" stroke-width="${w}" d="${d}"/>`;
  }
  return `<g fill="none" stroke-linecap="round">${out}</g>`;
}

/**
 * Palette-knife marks: flat quadrilateral slabs of paint. `items` is a list of
 * {x, y, ang, L, W, c:[r,g,b], skew}; output grouped by quantised colour.
 */
function knifeMarks(rng, items, K = 40, opacity = 1) {
  if (!items.length) return '';
  const pal = kmeans(rng, items.map((i) => i.c), K);
  const groups = new Map();
  for (const it of items) {
    const ca = Math.cos(it.ang), sa = Math.sin(it.ang);
    const nx = -sa, ny = ca;
    const sk = it.skew || 0;
    const x0 = Math.round(it.x - (nx * it.W) / 2 - (ca * it.L) / 2);
    const y0 = Math.round(it.y - (ny * it.W) / 2 - (sa * it.L) / 2);
    const a = [nx * it.W, ny * it.W];
    const b = [ca * it.L + nx * sk, sa * it.L + ny * sk];
    const t = it.taper === undefined ? 0.8 : it.taper;
    const c = [-nx * it.W * t, -ny * it.W * t];
    const d = `M${x0} ${y0}l${nums([a[0], a[1]], fi)}l${nums([b[0], b[1]], fi)}l${nums([c[0], c[1]], fi)}z`;
    const key = hex(pal.centers[pal.nearest(it.c)]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  let out = '';
  for (const [c, ds] of groups) out += `<path fill="${c}" d="${ds.join('')}"/>`;
  return opacity < 1 ? `<g opacity="${opacity}">${out}</g>` : out;
}

/** Tiny k-means colour quantiser (deterministic given rng). */
function kmeans(rng, cols, K, iters = 8) {
  K = Math.min(K, cols.length);
  const centers = [];
  for (let i = 0; i < K; i++) centers.push(cols[Math.floor(rng() * cols.length)].slice());
  const nearest = (c) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < centers.length; i++) {
      const e = centers[i];
      const d = (c[0] - e[0]) ** 2 + (c[1] - e[1]) ** 2 + (c[2] - e[2]) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  };
  for (let it = 0; it < iters; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (const c of cols) {
      const a = acc[nearest(c)];
      a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; a[3]++;
    }
    acc.forEach((a, i) => { if (a[3]) centers[i] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  return { centers, nearest };
}

/* ------------------------------------------------------------------ */
/* Artworks                                                            */
/* ------------------------------------------------------------------ */
const ART = {};

/* ---------------- Canvas: Golden Dusk over the Ganga ---------------- */
ART['golden-dusk-ganga.svg'] = (rng) => {
  const W = 1000, H = 750, HZ = 440, p = 'gd';
  const N = makeNoise2(rng);
  const SX = 660, SY = 392, SR = 30;
  const skyStops = stopsOf([[0, '#3a3163'], [0.2, '#69426f'], [0.42, '#b7586a'], [0.62, '#e47e4c'], [0.82, '#f2aa45'], [1, '#f8d27c']]);
  const glow = (x, y) => {
    const d = Math.hypot(x - SX, (y - SY) * 1.35);
    return clamp(Math.exp(-d / 150) * 0.7 + Math.exp(-d / 50) * 0.75, 0, 1);
  };
  function sky(x, y) {
    let c = gradc(skyStops, clamp(y / HZ, 0, 1));
    const band = smooth(30, 110, y) * (1 - smooth(300, 390, y));
    const n = N.fbm(x * 0.0045, y * 0.02, 4);
    const cl = smooth(0.5, 0.66, n) * band;
    if (cl > 0) {
      const lit = clamp(Math.exp(-Math.hypot(x - SX, y - SY) / 300) * 1.2 + (y / HZ) * 0.3, 0, 1);
      c = mixc(c, mixc([88, 50, 84], [250, 166, 98], lit), cl * 0.85);
    }
    c = mixc(c, [255, 238, 192], glow(x, y));
    if (Math.hypot(x - SX, y - SY) < SR) c = [255, 247, 218];
    return c;
  }
  // ---- ghat geometry: buildings recede toward the horizon on the left bank
  const wl = (x) => 552 - x * 0.175; // water line along the ghat
  const st = (x) => wl(x) - (64 - x * 0.085); // top of the steps
  const GX = 610;
  const top = new Float32Array(GX + 1).fill(9999);
  const shapeAt = new Int16Array(GX + 1).fill(-1);
  const shapes = [];
  const facades = [[132, 74, 64], [150, 92, 70], [112, 60, 62], [160, 104, 82], [124, 70, 76], [98, 52, 58]];
  let x = -20;
  while (x < GX - 14) {
    const sc = 1 - Math.max(0, x) / 1100;
    const w = rng.range(40, 84) * sc;
    const h = rng.range(90, 200) * sc;
    const x1 = Math.min(GX, x + w);
    const base = Math.max(st(x), st(x1)) + 6;
    const tp = st(x) - h;
    const color = mixc(rng.pick(facades), [70, 36, 50], rng.range(0.1, 0.45));
    shapes.push({ x0: x, x1, tp, base, color, sc, dome: rng() < 0.4, chhatri: rng() < 0.35 });
    const id = shapes.length - 1;
    for (let xx = Math.max(0, Math.floor(x)); xx <= Math.min(GX, Math.ceil(x1)); xx++) if (tp < top[xx]) { top[xx] = tp; shapeAt[xx] = id; }
    x = x1 - rng.range(0, 5);
  }
  const temples = [[96, 1.0], [322, 0.8], [496, 0.62]];
  const tShapes = temples.map(([cx, s]) => {
    const base = st(cx) - 34 * s, ht = 236 * s, wt = 66 * s;
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      pts.push([cx - wt / 2 + wt * t, base - ht * (1 - Math.pow(Math.abs(2 * t - 1), 1.7))]);
    }
    for (let xx = Math.floor(cx - wt / 2); xx <= cx + wt / 2; xx++) {
      const t = base - ht * (1 - Math.pow(Math.min(1, Math.abs((2 * (xx - cx)) / wt)), 1.7));
      if (xx >= 0 && xx <= GX && t < top[xx]) { top[xx] = t; shapeAt[xx] = -2; }
    }
    return { cx, s, base, ht, wt, d: smoothPath(pts) + `L${f(cx + wt / 2 + 10 * s)} ${f(base + 70 * s)}L${f(cx - wt / 2 - 10 * s)} ${f(base + 70 * s)}Z` };
  });
  const bankTop = (x) => HZ - 4 - 7 * Math.pow(N(x * 0.025, 7.3), 1.5) - 3 * N(x * 0.12, 2.1);

  function col(x, y) {
    const xi = Math.round(clamp(x, 0, GX));
    if (x < GX && y >= top[xi] && y < st(x) + 4) {
      const id = shapeAt[xi];
      const c = id >= 0 ? shapes[id].color : [110, 56, 62];
      return mixc(c, [200, 110, 80], 0.25 * N(x * 0.05, y * 0.05));
    }
    if (x < 600 && y >= st(x) && y < wl(x)) {
      const k = (y - st(x)) / (wl(x) - st(x));
      return mixc([170, 104, 80], [96, 54, 58], k * 0.8);
    }
    const wy = x < 600 ? wl(x) : HZ;
    if (y < wy) {
      if (x > 560 && y > bankTop(x)) return mixc([92, 56, 76], [255, 220, 170], glow(x, y) * 0.5);
      return sky(x, y);
    }
    const depth = y - HZ;
    const ry = clamp(HZ - depth * 1.2 - 4, 0, HZ - 1);
    let c = sky(x + (N(x * 0.01, y * 0.2) - 0.5) * 60, ry);
    c = mixc(c, [62, 30, 50], 0.22 + clamp(depth / 300, 0, 1) * 0.35);
    const cw = 16 + depth * 0.6;
    const s = Math.exp(-Math.pow((x - SX) / cw, 2)) * (0.3 + 0.7 * N(x * 0.06, y * 0.4));
    c = mixc(c, [255, 216, 134], clamp(s * 1.15 - 0.05, 0, 1));
    if (x < GX) {
      const xr = Math.round(clamp(x + (N(x * 0.02, y * 0.3) - 0.5) * 24, 0, GX));
      const yr = wl(xr) - (y - wl(xr)) * 0.9;
      if (yr >= top[xr] && y > wl(xr)) c = mixc(c, [56, 28, 42], yr < st(xr) ? 0.72 : 0.4);
    }
    return c;
  }

  const defs =
    linGrad(`${p}-sky`, skyStops.map(([t, c]) => [t, hex(c)]), 0, 0, 0, HZ, ' gradientUnits="userSpaceOnUse"') +
    radGrad(`${p}-glow`, [[0, '#fff4cf', 1], [0.25, '#ffd98a', 0.75], [1, '#ffb050', 0]]) +
    radGrad(`${p}-sun`, [[0, '#fffbe8'], [0.7, '#fff2c4'], [1, '#ffe2a0', 0]]) +
    linGrad(`${p}-wat`, [[0, '#b96a52'], [0.4, '#7a3f50'], [1, '#3c2440']]) +
    linGrad(`${p}-bld`, [[0, '#000', 0], [1, '#2a1020', 0.35]]) +
    radGrad(`${p}-vig`, [[0.55, '#000', 0], [1, '#1a0a14', 0.45]], 0.5, 0.5, 0.75) +
    FX.canvas(`${p}-cv`, 3, 1, W, H) +
    FX.impasto(`${p}-imp`, 5, 2.4, 3) +
    FX.wobble(`${p}-wb`, 0.06, 3, 2) +
    `<filter id="${p}-rip" x="-10%" y="-10%" width="120%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.015 0.22" numOctaves="2" seed="4"/><feDisplacementMap in="SourceGraphic" scale="16" xChannelSelector="R" yChannelSelector="G"/></filter>` +
    FX.blur(`${p}-bl`, 3, 200) +
    FX.blur(`${p}-sb`, 6, 100);

  // ---- base layer
  let base = `<rect width="${W}" height="${H}" fill="url(#${p}-sky)"/>`;
  base += `<rect y="${HZ - 2}" width="${W}" height="${H - HZ + 2}" fill="url(#${p}-wat)"/>`;
  base += `<ellipse cx="${SX}" cy="${SY}" rx="260" ry="190" fill="url(#${p}-glow)"/>`;

  // buildings as crisp silhouettes (painted with clipped strokes)
  let bpath = '';
  let bld = '';
  for (const s of shapes) {
    const d = polyPath([[s.x0, s.base], [s.x0, s.tp], [s.x1, s.tp], [s.x1, s.base]]);
    bpath += d;
    bld += `<path d="${d}" fill="${hex(s.color)}"/>`;
  }
  for (const t of tShapes) { bpath += t.d; bld += `<path d="${t.d}" fill="#6e3644"/>`; }
  const stepsD = `M0 ${f(st(0))}L600 ${f(st(600))}L600 ${f(wl(600))}L0 ${f(wl(0))}Z`;
  base += bld + `<path d="${stepsD}" fill="#8a5048"/>`;

  // ---- brush strokes
  let strokes = '';
  const inBld = (x, y) => x < GX && y >= top[Math.round(clamp(x, 0, GX))] - 3 && y < wl(x);
  strokes += brushStrokes(rng, { x0: -10, y0: -10, x1: W + 10, y1: HZ + 6, sp: 28, len: [36, 74], wid: [12, 18], K: 30, wb: 2, col, ang: (x, y) => 0.08 * Math.sin(x * 0.012 + y * 0.03), bend: 0.22, angJit: 0.16, mask: (x, y) => !inBld(x, y) });
  strokes += brushStrokes(rng, { x0: -10, y0: HZ - 2, x1: W + 10, y1: H + 10, sp: 22, len: [32, 72], wid: [7, 9], K: 32, wb: 1, col, ang: () => 0, horiz: true, mask: (x, y) => y > (x < 600 ? wl(x) : HZ) });
  const bStrokes = brushStrokes(rng, { x0: -10, y0: 150, x1: GX + 6, y1: 560, sp: 13, len: [10, 20], wid: [5, 7], K: 20, wb: 2, col, ang: (x, y) => (y >= st(x) + 2 ? -0.17 : PI / 2), bend: 0.08, angJit: 0.06, mask: inBld });
  let glit = '';
  for (let i = 0; i < 170; i++) {
    const y = HZ + 4 + Math.pow(rng(), 1.3) * 300;
    const cw = 16 + (y - HZ) * 0.6;
    const xx = SX + rng.gauss() * cw * 0.55;
    const l = rng.range(6, 18) + (y - HZ) * 0.05;
    glit += `M${fi(xx - l / 2)} ${fi(y)}h${fi(l)}`;
  }
  strokes += `<path d="${glit}" stroke="#fff0c0" stroke-width="2.6" stroke-linecap="round" opacity=".85"/>`;

  // ---- architectural details
  let det = '';
  let win = '', arch = '', ledge = '', lit = '', dark = '';
  for (const s of shapes) {
    const { x0, x1, tp, base, sc } = s;
    const w = x1 - x0;
    // ledges / cornices
    const floors = Math.max(1, Math.floor((base - tp) / (34 * sc)));
    for (let k = 0; k < floors; k++) {
      const y = tp + 6 * sc + k * 34 * sc;
      ledge += `M${f(x0)} ${f(y)}h${f(w)}`;
      // windows along this floor
      const nw = Math.max(1, Math.floor(w / (16 * sc)));
      for (let i = 0; i < nw; i++) {
        const wx = x0 + ((i + 0.5) * w) / nw - 2.5 * sc, wy = y + 10 * sc;
        if (wy > base - 12 * sc) continue;
        const r = rng();
        if (r < 0.22) win += `M${f(wx)} ${f(wy)}h${f(5 * sc)}v${f(8 * sc)}h${f(-5 * sc)}Z`;
        else if (r < 0.55) arch += `M${fi(wx)} ${fi(wy + 10 * sc)}v${fi(-8 * sc)}l${f(2.5 * sc)}-2l${f(2.5 * sc)} 2v${fi(8 * sc)}Z`;
      }
    }
    if (rng() < 0.5) lit += `M${fi(x1 - 1)} ${fi(tp)}V${fi(base - 4)}`;
    lit += `M${fi(x0)} ${fi(tp)}h${fi(w)}`;
    if (s.dome) {
      const cx = (x0 + x1) / 2, r = Math.min(w * 0.22, 12 * sc);
      dark += `M${f(cx - r)} ${f(tp)}a${f(r)} ${f(r * 1.15)} 0 0 1 ${f(2 * r)} 0Z`;
      det += `<path d="M${f(cx)} ${f(tp - r * 1.15)}v${f(-6 * sc)}" stroke="#2c1420" stroke-width="${f(1.5 * sc)}"/>`;
    } else if (s.chhatri) {
      const cx = x0 + w * 0.3, r = 8 * sc;
      dark += `M${f(cx - r)} ${f(tp - 9 * sc)}a${f(r)} ${f(r)} 0 0 1 ${f(2 * r)} 0ZM${f(cx - r + 1)} ${f(tp - 9 * sc)}h${f(2 * sc)}v${f(9 * sc)}h${f(-2 * sc)}ZM${f(cx + r - 3 * sc)} ${f(tp - 9 * sc)}h${f(2 * sc)}v${f(9 * sc)}h${f(-2 * sc)}Z`;
    }
  }
  det += `<path d="${ledge}" stroke="#e8a070" stroke-width="2" opacity=".5"/>`;
  det += `<path d="${arch}" fill="#3a1a28" opacity=".75"/>`;
  det += `<path d="${dark}" fill="#5a2c3a"/>`;
  det += `<path d="${lit}" stroke="#f7b56a" stroke-width="1.6" fill="none" opacity=".55"/>`;
  det += `<path d="${win}" fill="#ffd27a"/><path d="${win}" fill="#ffc060" filter="url(#${p}-bl)"/>`;
  for (const t of tShapes) {
    const { cx, base, ht, s, wt } = t;
    const ty = base - ht;
    for (let i = -2; i <= 2; i++) det += `<path d="M${f(cx + i * 11 * s)} ${f(base + 40 * s)}Q${f(cx + i * 9 * s)} ${f(base - ht * 0.5)} ${f(cx)} ${f(ty + 10)}" stroke="#3a1828" stroke-width="1.4" fill="none" opacity=".6"/>`;
    for (let k = 1; k < 7; k++) {
      const yy = base - ht * (k / 7);
      const hw = (wt / 2) * Math.pow(1 - k / 7, 1 / 1.7);
      det += `<path d="M${f(cx - hw)} ${f(yy)}h${f(2 * hw)}" stroke="#3a1828" stroke-width="1.2" opacity=".45"/>`;
    }
    det += `<path d="M${f(cx + wt * 0.5)} ${f(base + 40 * s)}Q${f(cx + wt * 0.45)} ${f(base - ht * 0.45)} ${f(cx + 2)} ${f(ty + 6)}" stroke="#f7b56a" stroke-width="2.4" fill="none" opacity=".7"/>`;
    det += `<ellipse cx="${f(cx)}" cy="${f(ty + 3)}" rx="${f(9 * s)}" ry="${f(4 * s)}" fill="#4a2232"/><path d="M${f(cx)} ${f(ty)}v${f(-30 * s)}" stroke="#2d1622" stroke-width="2"/><circle cx="${f(cx)}" cy="${f(ty - 3)}" r="${f(3.5 * s)}" fill="#e2b04a"/>`;
    det += `<path d="M${f(cx)} ${f(ty - 30 * s)}q${f(14 * s)} ${f(2 * s)} ${f(26 * s)} ${f(9 * s)}q${f(-12 * s)} ${f(3 * s)} ${f(-26 * s)} ${f(7 * s)}Z" fill="#ea6a2e"/>`;
  }
  // steps
  det += `<path d="M0 ${f(st(0))}L600 ${f(st(600))}" stroke="#f0a070" stroke-width="2.5" opacity=".6"/>`;
  for (let k = 1; k < 10; k++) {
    const t = k / 10;
    det += `<path d="M0 ${f(lerp(st(0), wl(0), t))}L600 ${f(lerp(st(600), wl(600), t))}" stroke="${k % 2 ? '#5a2e36' : '#d89474'}" stroke-width="${f(2.2 - t)}" opacity=".5"/>`;
  }
  for (const ux of [60, 150, 205, 380, 430, 540]) {
    const sc = 1 - ux / 1100, uy = lerp(st(ux), wl(ux), 0.45);
    det += `<path d="M${f(ux)} ${f(uy)}v${f(-24 * sc)}" stroke="#2b1520" stroke-width="${f(1.6 * sc)}"/><path d="M${f(ux - 17 * sc)} ${f(uy - 20 * sc)}Q${f(ux)} ${f(uy - 34 * sc)} ${f(ux + 17 * sc)} ${f(uy - 20 * sc)}Z" fill="#3b1d26"/><path d="M${f(ux + 2)} ${f(uy - 30 * sc)}Q${f(ux + 12 * sc)} ${f(uy - 26 * sc)} ${f(ux + 16 * sc)} ${f(uy - 21 * sc)}" stroke="#f0a060" stroke-width="1.2" fill="none"/>`;
  }
  for (let i = 0; i < 26; i++) {
    const fx = rng.range(10, 580), sc = 1 - fx / 1100;
    const fy = lerp(st(fx), wl(fx), rng.range(0.2, 0.95));
    const c = rng.pick(['#2b1520', '#3a1a24', '#d8603a', '#f0c05a', '#f4ede0']);
    det += `<path d="M${f(fx)} ${f(fy)}v${f(-8 * sc)}" stroke="${c}" stroke-width="${f(2.6 * sc)}" stroke-linecap="round"/><circle cx="${f(fx)}" cy="${f(fy - 10 * sc)}" r="${f(1.5 * sc)}" fill="#2b1520"/>`;
  }
  // far bank tree line
  let bank = `M560 ${HZ + 2}`;
  for (let xx = 560; xx <= W; xx += 8) bank += `L${xx} ${f(bankTop(xx))}`;
  det += `<path d="${bank}L${W} ${HZ + 3}Z" fill="#7a4a5e" opacity=".75"/>`;
  // boats
  const hull = 'M-62-10Q-30 2 0 3Q30 2 64-14L57-4Q30 13 0 14Q-32 13-55-1Z';
  const boat = (bx, by, s, flip, people) => {
    const tr = `translate(${f(bx)} ${f(by)}) scale(${flip ? -s : s} ${s})`;
    let b = `<path d="${hull}" fill="#2a1520"/><path d="M-62-10Q-30 2 0 3Q30 2 64-14" stroke="#f3a457" stroke-width="2" fill="none" opacity=".8"/>`;
    if (people >= 1) b += `<path d="M-28 1v-30M-34-2l4-26" stroke="#2a1520" stroke-width="5" stroke-linecap="round"/><circle cx="-29" cy="-35" r="4.5" fill="#2a1520"/><path d="M-44-34L-6 22" stroke="#2a1520" stroke-width="2"/><path d="M-26-30v26" stroke="#f3a457" stroke-width="1.4" opacity=".7"/>`;
    if (people >= 2) b += `<path d="M18 3q4-14 10-16q6 2 8 16Z" fill="#c64a2c"/><circle cx="27" cy="-17" r="4" fill="#2a1520"/>`;
    const refl = `<g transform="translate(0 ${f(30 * s)}) scale(1 -1)" opacity=".45">${b}</g>`;
    return `<g transform="${tr}"><g filter="url(#${p}-rip)">${refl}</g>${b}</g>`;
  };
  det += boat(780, 476, 0.5, true, 1) + boat(470, 548, 0.85, false, 2) + boat(860, 640, 1.15, true, 1);
  let diya = '';
  for (let i = 0; i < 22; i++) {
    const dx = rng.range(40, 520), dy = rng.range(wl(dx) + 10, wl(dx) + 90);
    diya += `M${f(dx)} ${f(dy)}h3`;
  }
  det += `<path d="${diya}" stroke="#ffb040" stroke-width="7" stroke-linecap="round" opacity=".55" filter="url(#${p}-bl)"/><path d="${diya}" stroke="#fff0b0" stroke-width="2.4" stroke-linecap="round"/>`;
  let birds = '';
  for (const [bx, by, s] of [[560, 200, 1], [590, 186, 0.8], [612, 214, 0.9], [530, 230, 0.7], [640, 176, 0.6]]) {
    birds += `M${f(bx - 9 * s)} ${f(by - 3 * s)}q${f(5 * s)} ${f(-2 * s)} ${f(9 * s)} ${f(3 * s)}q${f(4 * s)} ${f(-5 * s)} ${f(9 * s)} ${f(-3 * s)}`;
  }
  det += `<path d="${birds}" stroke="#3a2034" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;

  const body =
    `<clipPath id="${p}-bc"><path d="${bpath}"/></clipPath>` +
    `<g filter="url(#${p}-cv)">` +
    base +
    `<g filter="url(#${p}-imp)">${strokes}<g clip-path="url(#${p}-bc)" opacity=".8">${bStrokes}</g></g>` +
    `<circle cx="${SX}" cy="${SY}" r="${SR + 4}" fill="url(#${p}-sun)" filter="url(#${p}-sb)"/>` +
    `<g filter="url(#${p}-wb)">${det}</g>` +
    `<rect width="${W}" height="${H}" fill="url(#${p}-vig)"/>` +
    `</g>`;
  return svgDoc(W, H, defs, body);
};

/* ---------------- Canvas: Monsoon Hills ---------------- */
ART['monsoon-hills.svg'] = (rng) => {
  const W = 1000, H = 750, p = 'mh';
  const N = makeNoise2(rng);
  const layers = [
    { base: 296, amp: 60, fr: 0.0042, c: [132, 150, 166], top: [150, 166, 180], fog: 0.35 },
    { base: 352, amp: 82, fr: 0.0036, c: [92, 116, 130], top: [112, 136, 146], fog: 0.35 },
    { base: 422, amp: 104, fr: 0.0031, c: [58, 92, 86], top: [86, 124, 102], fog: 0.3 },
    { base: 504, amp: 128, fr: 0.0027, c: [40, 84, 52], top: [96, 142, 72], fog: 0.22 },
    { base: 598, amp: 92, fr: 0.0034, c: [30, 68, 38], top: [80, 128, 54], fog: 0.18 },
    { base: 696, amp: 64, fr: 0.0045, c: [22, 48, 28], top: [62, 100, 44], fog: 0 },
  ];
  layers.forEach((L, i) => {
    const off = rng.range(0, 100);
    const tilt = [0.03, -0.05, 0.07, -0.06, 0.05, -0.03][i];
    L.r = (x) => (x - 500) * tilt + L.r0(x);
    L.r0 = (x) => {
      const n = N.fbm(x * L.fr + off, i * 3.7, 3);
      const mesa = smooth(0.44, 0.56, n);
      return L.base - L.amp * (0.2 + 0.8 * mesa) * (0.75 + 0.5 * N(x * 0.006 + off, i + 4)) - 10 * N(x * 0.035 + off, i) - 3 * N(x * 0.15, i + 9);
    };
  });
  const MIST = [206, 216, 218];
  const layerAt = (x, y) => {
    for (let i = layers.length - 1; i >= 0; i--) if (y >= layers[i].r(x)) return i;
    return -1;
  };
  function sky(x, y) {
    const t = clamp(y / 330, 0, 1);
    let c = mixc([78, 90, 104], [192, 200, 204], Math.pow(t, 1.3));
    const n = N.fbm(x * 0.004 + 30, y * 0.008, 5);
    c = mixc(c, [58, 68, 82], smooth(0.45, 0.75, n) * 0.75 * (1 - t * 0.6));
    c = mixc(c, [220, 226, 226], smooth(0.62, 0.8, N.fbm(x * 0.006, y * 0.012 + 5, 4)) * 0.6);
    return c;
  }
  function hill(i, x, y) {
    const L = layers[i];
    const dy = y - L.r(x);
    let c = mixc(L.top, L.c, smooth(0, 46, dy));
    c = mixc(c, scalec(L.c, 0.78), smooth(0.5, 0.75, N.fbm(x * 0.012, y * 0.02 + i * 9, 3)) * 0.7);
    c = mixc(c, [L.top[0] * 1.08, L.top[1] * 1.1, L.top[2] * 0.9], smooth(0.62, 0.8, N.fbm(x * 0.02 + 9, y * 0.03 + i, 2)) * 0.5);
    return mixc(c, MIST, smooth(30, 120, dy) * L.fog);
  }
  const defs =
    linGrad(`${p}-sky`, [[0, '#505c6b'], [0.25, '#77838f'], [0.45, '#b6bfc4']], 0, 0, 0, 1) +
    FX.canvas(`${p}-cv`, 7, 1, W, H) +
    FX.impasto(`${p}-imp`, 8, 2.2, 3) +
    FX.blur(`${p}-mist`, 12, 60) +
    FX.blur(`${p}-bl`, 2.5, 100) +
    FX.wobble(`${p}-wb`, 0.05, 4, 6) +
    radGrad(`${p}-vig`, [[0.6, '#000', 0], [1, '#0d1814', 0.4]], 0.5, 0.5, 0.75);

  let out = `<rect width="${W}" height="${H}" fill="url(#${p}-sky)"/>`;
  out += `<g filter="url(#${p}-imp)">` + brushStrokes(rng, {
    x0: -10, y0: -10, x1: W + 10, y1: 330, sp: 29, len: [34, 66], wid: [12, 18], K: 34, wb: 2, col: sky, bend: 0.3, angJit: 0.2,
    ang: (x, y) => (N(x * 0.005 + 3, y * 0.006) - 0.5) * 1.4, mask: (x, y) => y < layers[0].r(x) + 10,
  }) + '</g>';

  // waterfall location: steep plateau edge on layer 3
  const L3 = layers[3];
  let best = 600, bestS = 0;
  for (let x = 480; x < 860; x += 3) {
    const sl = L3.r(x + 6) - L3.r(x - 6);
    if (Math.abs(sl) > bestS && L3.r(x) < L3.base - L3.amp * 0.5) { bestS = Math.abs(sl); best = x; }
  }
  const dir = L3.r(best + 6) > L3.r(best - 6) ? -1 : 1;
  const falls = [[best + dir * 26, 1], [best + dir * 120, 0.6]];

  layers.forEach((L, i) => {
    let d = `M-10 ${H + 10}`;
    for (let x = -10; x <= W + 10; x += 10) d += `L${x} ${fi(L.r(x))}`;
    d += `L${W + 10} ${H + 10}Z`;
    out += `<clipPath id="${p}-c${i}"><path id="${p}-h${i}" d="${d}"/></clipPath>`;
    out += `<use href="#${p}-h${i}" fill="${hex(mixc(L.c, MIST, L.fog * 0.5))}"/>`;
    const near = i === 5;
    out += `<g clip-path="url(#${p}-c${i})"><g filter="url(#${p}-imp)">` + brushStrokes(rng, {
      x0: -10, y0: L.base - L.amp - 14, x1: W + 10, y1: Math.min(H + 10, (layers[i + 1] ? layers[i + 1].base : H) + 10),
      sp: near ? 16 : 22 - i * 0.6, len: near ? [12, 26] : [18, 40], wid: near ? [4, 6] : [8, 8], K: near ? 14 : 10, wb: near ? 2 : 1,
      col: (x, y) => hill(i, x, y), bend: near ? 0.25 : 0.15, angJit: near ? 0.35 : 0.12,
      ang: near ? () => -PI / 2 + 0.25 : (x) => Math.atan2(L.r(x + 6) - L.r(x - 6), 12) * 0.8,
      mask: (x, y) => y >= L.r(x) - 4 && (near || y < layers[i + 1].r(x) + 12),
    }) + '</g></g>';
    // forested crest
    if (i === 3 || i === 4) {
      let tr = '', inRun = false, back = [];
      const s = i === 4 ? 1.3 : 0.8;
      for (let x = -10; x <= W + 10; x += 7) {
        const on = N(x * 0.008, i * 5) > 0.52;
        const y = L.r(x);
        if (on) {
          if (!inRun) { tr += `M${fi(x)} ${fi(y + 2)}`; back = []; inRun = true; }
          tr += `Q${fi(x + 3.5)} ${fi(y - rng.range(5, 11) * s)} ${fi(x + 7)} ${fi(L.r(x + 7) + 1)}`;
          back.push([x + 7, L.r(x + 7) + 10 * s]);
        } else if (inRun) {
          tr += back.reverse().map(([bx, by]) => `L${fi(bx)} ${fi(by)}`).join('') + 'Z';
          inRun = false;
        }
      }
      if (inRun) tr += back.reverse().map(([bx, by]) => `L${fi(bx)} ${fi(by)}`).join('') + 'Z';
      out += `<path d="${tr}" fill="${hex(scalec(L.c, 0.85))}" opacity=".8" filter="url(#${p}-wb)"/>`;
    }
    if (i === 3) {
      let cliffs = '', fallSvg = '';
      for (const [fx, s] of falls) {
        const y0 = L.r(fx) + 2, len = 190 * s + 30;
        cliffs += blob(rng, fx + 2, y0 + len * 0.42, 20 * s, len * 0.48, 12, 0.25);
        const pts = [[fx, y0]];
        let xx = fx;
        for (let k = 1; k <= 7; k++) { xx += rng.range(-4, 4) * s; pts.push([xx, y0 + (len * k) / 7]); }
        const fd = smoothPath(pts);
        fallSvg += `<path d="${fd}" stroke="#e8efee" stroke-width="${f(12 * s)}" fill="none" opacity=".25" filter="url(#${p}-bl)"/>`;
        fallSvg += `<path d="${fd}" stroke="#dfe8e6" stroke-width="${f(4.5 * s)}" fill="none" stroke-linecap="round" opacity=".75"/>`;
        fallSvg += `<path d="${fd}" stroke="#fff" stroke-width="${f(1.3 * s)}" fill="none" opacity=".9" transform="translate(${f(-1.2 * s)} 0)"/>`;
        fallSvg += `<ellipse cx="${f(xx)}" cy="${f(y0 + len)}" rx="${f(34 * s)}" ry="${f(9 * s)}" fill="#e3ebea" opacity=".55" filter="url(#${p}-mist)"/>`;
      }
      out += `<g clip-path="url(#${p}-c3)"><path d="${cliffs}" fill="#24402e" opacity=".5" filter="url(#${p}-wb)"/>${fallSvg}</g>`;
    }
    // valley mist in front of this layer
    if (i < 5) {
      let mist = '';
      const nxt = layers[i + 1];
      for (let k = 0; k < 4; k++) {
        const cx = rng.range(-50, W + 50), cy = nxt.r(cx) - rng.range(2, 16);
        mist += `<ellipse cx="${fi(cx)}" cy="${fi(cy)}" rx="${fi(rng.range(120, 260))}" ry="${fi(rng.range(10, 20))}"/>`;
      }
      out += `<g fill="#dfe6e6" opacity="${f(0.5 - i * 0.06)}" filter="url(#${p}-mist)">${mist}</g>`;
    }
  });

  let rain = '', rain2 = '';
  for (let k = 0; k < 220; k++) {
    const x = rng.range(-40, W + 40), y = rng.range(-20, H);
    const l = rng.range(18, 52);
    const seg = `M${fi(x)} ${fi(y)}l${f(l * 0.22)} ${fi(l)}`;
    if (rng() < 0.6) rain += seg; else rain2 += seg;
  }
  const body =
    `<g filter="url(#${p}-cv)">` + out +
    `<path d="${rain}" stroke="#e9eff0" stroke-width="1.3" opacity=".3" stroke-linecap="round"/>` +
    `<path d="${rain2}" stroke="#c9d4d8" stroke-width="2" opacity=".2" stroke-linecap="round"/>` +
    `<rect width="${W}" height="${H}" fill="url(#${p}-vig)"/>` +
    `</g>`;
  return svgDoc(W, H, defs, body);
};

/* ---------------- Canvas: Lotus Pond Reverie (palette knife) ---------------- */
ART['abstract-lotus-pond.svg'] = (rng) => {
  const W = 900, H = 900, p = 'lp';
  const N = makeNoise2(rng);
  const blooms = [
    { x: 540, y: 400, s: 1.25 },
    { x: 238, y: 610, s: 0.95 },
    { x: 724, y: 712, s: 0.75 },
  ];
  const pads = [
    { x: 600, y: 488, r: 150, rot: -0.1 },
    { x: 250, y: 690, r: 130, rot: 0.15 },
    { x: 150, y: 300, r: 110, rot: -0.2 },
    { x: 760, y: 790, r: 120, rot: 0.1 },
    { x: 420, y: 820, r: 95, rot: -0.05 },
    { x: 800, y: 300, r: 80, rot: 0.2 },
    { x: 360, y: 470, r: 70, rot: 0.1 },
  ];
  // --- water: deep teal, lighter near the top, with rose / gold reflections
  function water(x, y) {
    let c = gradc(stopsOf([[0, '#6fb0a6'], [0.35, '#2f7f7a'], [0.7, '#1b5a60'], [1, '#123e4a']]), y / H);
    const n = N.fbm(x * 0.006, y * 0.012, 4);
    c = mixc(c, [24, 60, 78], smooth(0.55, 0.75, n) * 0.6);
    c = mixc(c, [96, 176, 168], smooth(0.6, 0.78, N.fbm(x * 0.01 + 7, y * 0.02, 3)) * 0.55);
    for (const b of blooms) {
      const d = Math.hypot((x - b.x) / 1.6, y - b.y - 120 * b.s);
      c = mixc(c, [214, 128, 128], clamp(1 - d / (110 * b.s), 0, 1) * 0.55);
    }
    c = mixc(c, [214, 176, 96], smooth(0.7, 0.85, N(x * 0.015 + 3, y * 0.05)) * 0.5);
    return c;
  }
  const bg = [];
  for (let y = -20; y < H + 20; y += 28) {
    for (let x = -60; x < W + 40; x += 62) {
      const px = x + rng() * 50, py = y + rng() * 28;
      const c = water(px, py).map((v) => v * (0.94 + rng() * 0.12));
      bg.push({ x: px, y: py, ang: rng.range(-0.1, 0.1) + 0.12 * Math.sin(py * 0.012 + px * 0.004), L: rng.range(90, 170), W: rng.range(24, 42), c, skew: rng.range(-8, 8), taper: rng.range(0.6, 1) });
    }
  }
  const hi = [];
  for (let k = 0; k < 150; k++) {
    const x = rng.range(-20, W + 20), y = rng.range(0, H);
    const c = mixc(water(x, y), [170, 222, 208], rng.range(0.25, 0.5));
    hi.push({ x, y, ang: rng.range(-0.12, 0.12), L: rng.range(40, 110), W: rng.range(6, 14), c, taper: 0.5 });
  }
  // reflections of the blooms: rose slabs dragged downward
  for (const b of blooms) {
    for (let k = 0; k < 9; k++) {
      const x = b.x + rng.range(-50, 50) * b.s, y = b.y + rng.range(110, 220) * b.s;
      hi.push({ x, y, ang: rng.range(-0.15, 0.15), L: rng.range(30, 70) * b.s, W: rng.range(7, 14), c: rgb(rng.pick(['#c76f6f', '#d98c88', '#b86070'])), taper: 0.6 });
    }
  }
  // --- lily pads: notched discs, knife slabs clipped inside
  let padShapes = '', padClip = '';
  const padItems = [];
  const rim = [];
  for (const pd of pads) {
    const notch = rng.range(0, TAU);
    const ry = 0.42;
    const ep = (a, r = 1) => {
      const ex = Math.cos(a) * pd.r * r, ey = Math.sin(a) * pd.r * ry * r;
      return [pd.x + ex * Math.cos(pd.rot) - ey * Math.sin(pd.rot), pd.y + ex * Math.sin(pd.rot) + ey * Math.cos(pd.rot)];
    };
    const p1 = ep(notch + 0.2), p2 = ep(notch - 0.2);
    const d = `M${f(pd.x)} ${f(pd.y)}L${nums(p1)}A${f(pd.r)} ${f(pd.r * ry)} ${f((pd.rot * 180) / PI)} 1 1 ${nums(p2)}Z`;
    padClip += d;
    padShapes += `<path d="${d}" fill="${rng.pick(['#3f7d5c', '#4a7a52', '#356e55'])}"/>`;
    const n = Math.round(pd.r * 0.3);
    for (let i = 0; i < n; i++) {
      const a = rng.range(0, TAU), rr = Math.sqrt(rng()) * 0.95;
      const [x, y] = ep(a, rr);
      const lit = clamp(0.55 - (x - pd.x) / pd.r * 0.35 - (y - pd.y) / (pd.r * ry) * 0.3 + rng.range(-0.25, 0.25), 0, 1);
      const c = gradc(stopsOf([[0, '#1d4a3c'], [0.35, '#3f7d5c'], [0.6, '#7a8b5e'], [0.85, '#a7b46c'], [1, '#d6d690']]), lit);
      padItems.push({ x, y, ang: pd.rot + rng.range(-0.35, 0.35), L: pd.r * rng.range(0.4, 0.8), W: pd.r * rng.range(0.1, 0.2), c, skew: rng.range(-4, 4), taper: 0.7 });
    }
    for (let k = 0; k < 3; k++) {
      const a = rng.range(PI * 1.1, PI * 1.85);
      const [x, y] = ep(a, 0.93);
      rim.push({ x, y, ang: Math.atan2(Math.cos(a) * ry, -Math.sin(a)) + pd.rot, L: pd.r * 0.45, W: 5, c: [226, 228, 168], taper: 0.3 });
    }
  }
  // --- lotus blooms: cupped petals as knife-shaped slabs
  let petals = '';
  const petalItems = [];
  const stems = [];
  for (const b of blooms) {
    const s = b.s;
    stems.push(`M${f(b.x + 6 * s)} ${f(b.y + 30 * s)}q${f(-8 * s)} ${f(40 * s)} ${f(2 * s)} ${f(80 * s)}`);
    const ring = (n, spread, len, wid, dy, cols, angOff = 0) => {
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const a = -PI / 2 + (t - 0.5) * spread + angOff + rng.range(-0.06, 0.06);
        const L = len * s * (1 - Math.abs(t - 0.5) * 0.35) * rng.range(0.9, 1.08);
        const w = wid * s;
        const bx = b.x + Math.cos(a + PI / 2) * 0 + (t - 0.5) * 30 * s, by = b.y + dy * s;
        const col = rgb(cols[Math.min(cols.length - 1, Math.floor(rng() * cols.length))]);
        petals += `<path d="${leafPath(bx, by, a, L, w, { sharp: 0.8, n: 5 })}" fill="${hex(col)}"/>`;
        // knife streaks on the petal
        for (let k = 0; k < 3; k++) {
          const tt = rng.range(0.3, 0.75);
          const lc = mixc(col, k === 0 ? [255, 236, 228] : [150, 60, 70], k === 0 ? 0.55 : 0.3);
          petalItems.push({ x: bx + Math.cos(a) * L * tt + rng.range(-w, w) * 0.18, y: by + Math.sin(a) * L * tt, ang: a + rng.range(-0.12, 0.12), L: L * rng.range(0.35, 0.55), W: w * rng.range(0.16, 0.3), c: lc, taper: 0.4 });
        }
      }
    };
    ring(5, 2.4, 120, 54, 0, ['#a84e5c', '#b85c66', '#9a4456']);
    ring(4, 1.6, 120, 58, 6, ['#d27b7b', '#c76f6f', '#dc8a86']);
    // seed pod in gold
    petals += `<ellipse cx="${f(b.x)}" cy="${f(b.y - 12 * s)}" rx="${f(24 * s)}" ry="${f(9 * s)}" fill="#d6a443"/>`;
    for (let k = 0; k < 7; k++) petalItems.push({ x: b.x + rng.range(-18, 18) * s, y: b.y - 12 * s + rng.range(-5, 5) * s, ang: rng.range(-0.3, 0.3), L: 16 * s, W: 5 * s, c: rgb(rng.pick(['#f0d27a', '#c8963e', '#e2c285'])) });
    ring(3, 1.9, 104, 62, 18, ['#e8a6a0', '#f0b8b0', '#e29b96']);
    ring(2, 2.6, 84, 56, 30, ['#f3c6bd', '#eab0a8'], 0);
  }
  // --- bud on a stem
  const bud = { x: 360, y: 250 };
  stems.push(`M${bud.x} ${bud.y + 40}q-14 120 8 260`);
  petals += `<path d="${leafPath(bud.x, bud.y + 44, -PI / 2 - 0.05, 96, 46, { sharp: 0.7 })}" fill="#b85c66"/>`;
  petals += `<path d="${leafPath(bud.x + 4, bud.y + 44, -PI / 2 + 0.12, 84, 30, { sharp: 0.7 })}" fill="#e8a6a0"/>`;
  petalItems.push({ x: bud.x + 6, y: bud.y + 6, ang: -PI / 2 + 0.1, L: 50, W: 9, c: [250, 222, 214], taper: 0.4 });
  // --- gold leaf: broad sun-glint slabs and small flecks
  const gold = [];
  for (let k = 0; k < 16; k++) {
    const x = rng.range(560, 900), y = rng.range(60, 260) + (x - 560) * -0.1;
    gold.push({ x, y, ang: rng.range(-0.08, 0.08), L: rng.range(40, 110), W: rng.range(8, 18), c: rgb(rng.pick(['#e2c285', '#c8963e', '#f0d898'])), taper: 0.6 });
  }
  for (let k = 0; k < 36; k++) {
    gold.push({ x: rng.range(0, W), y: rng.range(0, H), ang: rng.range(-0.3, 0.3), L: rng.range(8, 26), W: rng.range(3, 6), c: rgb(rng.pick(['#e2c285', '#c8963e', '#f3dca0'])) });
  }

  const defs =
    FX.canvas(`${p}-cv`, 21, 1.1, W, H) +
    FX.impasto(`${p}-imp`, 13, 3.6, 2) +
    FX.wobble(`${p}-wb`, 0.05, 3, 4) +
    radGrad(`${p}-vig`, [[0.6, '#000', 0], [1, '#06161a', 0.45]], 0.5, 0.5, 0.75);
  const body =
    `<g filter="url(#${p}-cv)">` +
    `<rect width="${W}" height="${H}" fill="#1f5c60"/>` +
    `<g filter="url(#${p}-imp)">` +
    knifeMarks(rng, bg, 34) +
    knifeMarks(rng, hi, 18, 0.85) +
    `<path d="${stems.join('')}" stroke="#2a4a34" stroke-width="7" fill="none" stroke-linecap="round" filter="url(#${p}-wb)"/>` +
    `<clipPath id="${p}-pc"><path d="${padClip}"/></clipPath>` +
    `<g filter="url(#${p}-wb)">${padShapes}<g clip-path="url(#${p}-pc)">${knifeMarks(rng, padItems, 24)}</g>${knifeMarks(rng, rim, 4)}</g>` +
    `<g filter="url(#${p}-wb)">${petals}</g>` +
    knifeMarks(rng, petalItems, 28) +
    knifeMarks(rng, gold, 10, 0.9) +
    `</g>` +
    `<rect width="${W}" height="${H}" fill="url(#${p}-vig)"/>` +
    `</g>`;
  return svgDoc(W, H, defs, body);
};

/* ------------------------------------------------------------------ */
/* Watercolour helpers                                                  */
/* ------------------------------------------------------------------ */
/** Paper base, tooth texture and speckle for watercolour works. */
function wcPaper(p, W, H, tone = '#fbf8f1') {
  const defs =
    FX.paper(`${p}-pp`, 0.035, 2.2, 17) +
    FX.speckle(`${p}-sp`, '#7a6a55', 0.9, 1.4, -0.82, 23);
  const under = `<rect width="${W}" height="${H}" fill="${tone}"/>`;
  const over =
    `<rect width="${W}" height="${H}" filter="url(#${p}-pp)" style="mix-blend-mode:multiply" opacity=".55"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-sp)" opacity=".35"/>`;
  return { defs, under, over };
}
/** 8-direction gradients (base -> tip) for objects with a main axis. */
function dirGrads(id, c0, c1, c2) {
  let s = '';
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    const x = Math.cos(a) * 0.5, y = Math.sin(a) * 0.5;
    s += linGrad(`${id}${k}`, [[0, c0], [0.55, c1], [1, c2]], f(0.5 - x), f(0.5 - y), f(0.5 + x), f(0.5 + y));
  }
  return s;
}
const dirIndex = (a) => ((Math.round(a / (TAU / 8)) % 8) + 8) % 8;

/* ---------------- Watercolour: Lotus in Morning Mist ---------------- */
ART['lotus-morning-mist.svg'] = (rng) => {
  const W = 800, H = 1000, p = 'lm';
  const paper = wcPaper(p, W, H);
  let defs = paper.defs +
    FX.watercolor(`${p}-wc`, 3, 10, 0.03, 1.1, 0.4) +
    FX.watercolor(`${p}-wl`, 8, 18, 0.02, 0.9, 0.5) +
    FX.bleed(`${p}-bl`, 26, 5, 60) +
    FX.bleed(`${p}-b2`, 9, 9, 20) +
    FX.wobble(`${p}-pen`, 0.08, 2.5, 12) +
    dirGrads(`${p}-pa`, '#fbeff0', '#f2b9c2', '#d8687e') +
    dirGrads(`${p}-pb`, '#f9e6e8', '#eaa3b0', '#c95a72') +
    linGrad(`${p}-f1`, [[0, '#8fb0cf', 1], [1, '#8fb0cf', 0.1]], 0.2, 0, 0.6, 1) +
    linGrad(`${p}-f2`, [[0, '#a9a2cf', 1], [1, '#a9a2cf', 0.1]], 1, 0, 0.3, 1) +
    linGrad(`${p}-f3`, [[0, '#7fa3a6', 0.1], [0.5, '#7fa3a6', 1], [1, '#7fa3a6', 0.2]], 0, 0, 1, 0) +
    linGrad(`${p}-stem`, [[0, '#8a9a52'], [0.5, '#6f8a52'], [1, '#5f7a58']]);

  let bg = '';
  // misty background: soft-edged washes that leave the paper breathing
  bg += `<g filter="url(#${p}-bl)" opacity=".5">`;
  bg += `<path d="${blob(rng, 170, 150, 230, 130, 9, 0.35)}" fill="#a9c4da"/>`;
  bg += `<path d="${blob(rng, 680, 110, 170, 110, 9, 0.35)}" fill="#c6c0dc"/>`;
  bg += `<path d="${blob(rng, 60, 500, 90, 200, 9, 0.35)}" fill="#b7cfe0"/>`;
  bg += `<path d="${blob(rng, 760, 470, 90, 170, 9, 0.35)}" fill="#bcd2dc"/>`;
  bg += `<path d="${blob(rng, 440, 930, 360, 90, 9, 0.3)}" fill="#a8c4c8"/>`;
  bg += `</g>`;
  bg += `<g filter="url(#${p}-wl)" opacity=".22">`;
  bg += `<path d="${blob(rng, 210, 170, 210, 110, 10, 0.3)}" fill="url(#${p}-f1)"/>`;
  bg += `<path d="${blob(rng, 700, 160, 130, 90, 10, 0.3)}" fill="url(#${p}-f2)"/>`;
  bg += `<path d="${blob(rng, 560, 920, 230, 60, 10, 0.3)}" fill="url(#${p}-f3)"/>`;
  bg += `</g>`;
  bg += `<g filter="url(#${p}-b2)" opacity=".25">`;
  bg += `<path d="${blob(rng, 110, 700, 120, 40, 12, 0.15, -0.15)}" fill="#7f9f8a"/>`;
  bg += `<path d="${blob(rng, 720, 640, 100, 34, 12, 0.15, 0.2)}" fill="#86a394"/>`;
  bg += `</g>`;

  // ---- leaves
  let leaves = '';
  let ci = 0;
  const leaf = (cx, cy, rx, ry, rot, tone) => {
    const d = blob(rng, cx, cy, rx, ry, 22, 0.07, rot);
    const id = `${p}-k${ci++}`;
    let s = `<clipPath id="${id}"><path d="${d}"/></clipPath>`;
    s += `<g filter="url(#${p}-wl)" opacity=".9"><path d="${d}" fill="${tone[0]}" opacity=".75"/>`;
    s += `<g clip-path="url(#${id})"><g filter="url(#${p}-b2)">`;
    s += `<path d="${blob(rng, cx - rx * 0.35, cy - ry * 0.2, rx * 0.5, ry * 0.5, 8, 0.3)}" fill="${tone[1]}" opacity=".7"/>`;
    s += `<path d="${blob(rng, cx + rx * 0.4, cy + ry * 0.3, rx * 0.45, ry * 0.5, 8, 0.3)}" fill="${tone[2]}" opacity=".6"/>`;
    s += `<path d="${blob(rng, cx + rx * 0.1, cy - ry * 0.55, rx * 0.5, ry * 0.25, 8, 0.3)}" fill="#e8efd0" opacity=".6"/>`;
    s += `</g></g></g>`;
    // lifted veins radiating from the centre
    const vx = cx + rx * 0.05, vy = cy + ry * 0.1;
    let v = '';
    for (let k = 0; k < 13; k++) {
      const a = (k / 13) * TAU + rng.range(-0.1, 0.1);
      const ex = Math.cos(a) * rx * 0.9, ey = Math.sin(a) * ry * 0.9;
      v += `M${f(vx)} ${f(vy)}q${f(ex * 0.5 + rng.range(-6, 6))} ${f(ey * 0.5 + rng.range(-4, 4))} ${f(ex * Math.cos(rot) - ey * Math.sin(rot))} ${f(ex * Math.sin(rot) + ey * Math.cos(rot))}`;
    }
    s += `<path d="${v}" stroke="#eef3dc" stroke-width="2.2" fill="none" opacity=".45" filter="url(#${p}-pen)" clip-path="url(#${id})"/>`;
    s += `<ellipse cx="${f(vx)}" cy="${f(vy)}" rx="5" ry="3" fill="#5f7a3e" opacity=".6"/>`;
    return s;
  };
  // stems first (behind leaves and flowers)
  const stem = (x0, y0, x1, y1, bend, w) =>
    `<path d="M${f(x0)} ${f(y0)}Q${f((x0 + x1) / 2 + bend)} ${f((y0 + y1) / 2)} ${f(x1)} ${f(y1)}" stroke="url(#${p}-stem)" stroke-width="${w}" fill="none" stroke-linecap="round" opacity=".85" filter="url(#${p}-wc)"/>`;
  let stems = '';
  stems += stem(430, 470, 400, 1010, -30, 7);
  stems += stem(232, 640, 262, 1010, 24, 6);
  stems += stem(598, 300, 560, 1010, 40, 5.5);
  stems += stem(150, 880, 120, 1010, -6, 6);

  leaves += leaf(590, 800, 190, 74, -0.06, ['#7f9a5a', '#a9b866', '#4f7f6e']);
  leaves += leaf(165, 878, 150, 52, 0.08, ['#6f8f62', '#9fb56a', '#4a7466']);
  // a young rolled leaf rising on the left
  const rl = leafPath(96, 760, -PI / 2 + 0.28, 230, 92, { sharp: 0.9, pk: 1.1, asym: 0.35 });
  leaves += `<clipPath id="${p}-rl"><path d="${rl}"/></clipPath><g filter="url(#${p}-wl)" opacity=".85"><path d="${rl}" fill="#7a9a62" opacity=".72"/><g clip-path="url(#${p}-rl)" filter="url(#${p}-b2)"><path d="${blob(rng, 150, 640, 40, 110, 8, 0.3)}" fill="#3f6b5c" opacity=".6"/><path d="${blob(rng, 80, 600, 26, 80, 8, 0.3)}" fill="#c4cf86" opacity=".7"/></g></g>`;
  leaves += `<path d="M96 760q46-110 66-224" stroke="#e8efd2" stroke-width="2" fill="none" opacity=".5" filter="url(#${p}-pen)"/>`;

  // ---- lotus flowers
  let flowers = '';
  let pencil = '';
  const petal = (x, y, a, len, wid, scheme, op = 0.88) => {
    const d = leafPath(x, y, a, len, wid, { sharp: 0.75, pk: 1.25, n: 7 });
    const g = `${p}-${scheme}${dirIndex(a)}`;
    let s = `<g filter="url(#${p}-wc)" opacity="${op}"><path d="${d}" fill="url(#${g})"/>`;
    // fine veins
    let v = '';
    for (let k = -1; k <= 1; k++) {
      const ox = -Math.sin(a) * k * wid * 0.18, oy = Math.cos(a) * k * wid * 0.18;
      v += `M${f(x + ox * 0.3)} ${f(y + oy * 0.3)}q${f(Math.cos(a) * len * 0.45 + ox)} ${f(Math.sin(a) * len * 0.45 + oy)} ${f(Math.cos(a) * len * 0.82 + ox * 0.4)} ${f(Math.sin(a) * len * 0.82 + oy * 0.4)}`;
    }
    s += `<path d="${v}" stroke="#c45a74" stroke-width="1" fill="none" opacity=".35"/></g>`;
    if (rng() < 0.3) pencil += `<path d="${leafPath(x + rng.range(-3, 3), y + rng.range(-3, 3), a + rng.range(-0.04, 0.04), len * rng.range(0.98, 1.04), wid * 1.02, { sharp: 0.75, pk: 1.25, n: 7 })}"/>`;
    return s;
  };
  const lotus = (cx, cy, s, open) => {
    let out = '';
    // back petals
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const a = -PI / 2 + (t - 0.5) * 1.5 * open;
      out += petal(cx + (t - 0.5) * 20 * s, cy, a, 150 * s * (1 - Math.abs(t - 0.5) * 0.3), 66 * s, 'pb', 0.8);
    }
    // side petals spreading
    for (const side of [-1, 1]) {
      out += petal(cx + side * 18 * s, cy + 8 * s, -PI / 2 + side * 1.25 * open, 140 * s, 64 * s, 'pa');
      out += petal(cx + side * 22 * s, cy + 18 * s, -PI / 2 + side * 1.75 * open, 120 * s, 58 * s, 'pb', 0.82);
    }
    // seed pod and stamens
    out += `<g filter="url(#${p}-wc)"><ellipse cx="${f(cx)}" cy="${f(cy - 4 * s)}" rx="${f(30 * s)}" ry="${f(14 * s)}" fill="#e9c457" opacity=".9"/><ellipse cx="${f(cx)}" cy="${f(cy - 7 * s)}" rx="${f(20 * s)}" ry="${f(7 * s)}" fill="#c9a83c" opacity=".7"/></g>`;
    let st = '';
    for (let k = 0; k < 18; k++) {
      const ax = cx + rng.range(-34, 34) * s, ay = cy + rng.range(-2, 8) * s;
      st += `M${f(ax)} ${f(ay)}l${f(rng.range(-4, 4) * s)} ${f(-rng.range(10, 20) * s)}`;
    }
    out += `<path d="${st}" stroke="#e0a53a" stroke-width="${f(2.2 * s)}" stroke-linecap="round" opacity=".85"/>`;
    // front petals cupping forward
    out += petal(cx - 14 * s, cy + 22 * s, -PI / 2 - 0.42 * open, 128 * s, 76 * s, 'pa', 0.92);
    out += petal(cx + 14 * s, cy + 22 * s, -PI / 2 + 0.42 * open, 128 * s, 76 * s, 'pa', 0.92);
    out += petal(cx, cy + 30 * s, -PI / 2, 104 * s, 70 * s, 'pa', 0.9);
    return out;
  };
  flowers += lotus(430, 430, 1.25, 1);
  flowers += lotus(232, 620, 0.92, 0.82);
  // bud
  flowers += `<g transform="translate(598 300)">` +
    petal(0, 12, -PI / 2 - 0.12, 120, 64, 'pb', 0.85) +
    petal(4, 14, -PI / 2 + 0.1, 112, 56, 'pa', 0.9) +
    petal(-2, 16, -PI / 2 - 0.02, 92, 40, 'pa', 0.75) + `</g>`;
  flowers += `<g filter="url(#${p}-wc)"><path d="M590 312q8 8 16 0l-2 10q-6 4-12 0Z" fill="#6f8a4a" opacity=".85"/></g>`;

  // ---- splatters & water marks
  let spl = '';
  for (let k = 0; k < 26; k++) {
    const x = rng.range(60, 760), y = rng.range(80, 980), r = Math.pow(rng(), 2) * 5 + 1;
    spl += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${rng.pick(['#eaa0b0', '#a9c4da', '#a9bd84', '#e48ca0'])}" opacity="${f(rng.range(0.3, 0.55))}"/>`;
  }
  let water = '';
  for (let k = 0; k < 14; k++) {
    const x = rng.range(250, 760), y = rng.range(900, 990);
    water += `M${f(x)} ${f(y)}h${f(rng.range(30, 110))}`;
  }

  const body =
    paper.under +
    bg +
    stems +
    `<path d="${water}" stroke="#93b3c4" stroke-width="3" stroke-linecap="round" opacity=".45" filter="url(#${p}-wc)"/>` +
    leaves +
    // morning mist drifting over the lower stems
    `<g filter="url(#${p}-bl)" opacity=".7"><path d="${blob(rng, 400, 760, 420, 46, 9, 0.25)}" fill="#fbf8f1"/></g>` +
    flowers +
    `<g fill="none" stroke="#6b6158" stroke-width=".8" opacity=".2" filter="url(#${p}-pen)">${pencil}</g>` +
    `<g filter="url(#${p}-wc)">${spl}</g>` +
    paper.over;
  return svgDoc(W, H, defs, body);
};

/* ---------------- Watercolour: Backwaters at Dawn ---------------- */
ART['backwaters-dawn.svg'] = (rng) => {
  const W = 1000, H = 750, p = 'bw', HZ = 408;
  const paper = wcPaper(p, W, H);
  const defs = paper.defs +
    FX.watercolor(`${p}-wc`, 4, 8, 0.035, 1, 0.35) +
    FX.watercolor(`${p}-wl`, 9, 20, 0.018, 0.8, 0.45) +
    FX.watercolor(`${p}-wp`, 12, 7, 0.04, 0.55, 0.22) +
    FX.bleed(`${p}-bl`, 24, 5, 50) +
    FX.bleed(`${p}-b2`, 8, 8, 16) +
    FX.wobble(`${p}-pen`, 0.08, 2, 12) +
    `<filter id="${p}-rf" x="-10%" y="-10%" width="120%" height="130%"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.09" numOctaves="2" seed="6"/><feDisplacementMap in="SourceGraphic" scale="18" xChannelSelector="R" yChannelSelector="G"/><feGaussianBlur stdDeviation="1.6 3"/></filter>` +
    linGrad(`${p}-sky`, [[0, '#b4bddc'], [0.4, '#d8c2d8'], [0.72, '#f6c6a8'], [1, '#fbd6a6']]) +
    linGrad(`${p}-wat`, [[0, '#f5d2b6'], [0.3, '#dcc0d6'], [1, '#a9abcf']]) +
    radGrad(`${p}-sun`, [[0, '#fff3d6', 1], [0.3, '#fbdca8', 0.9], [1, '#f6c09a', 0]]);

  let s = paper.under;
  // ---- sky: graded wet-in-wet wash leaving paper-white cloud gaps
  s += `<g filter="url(#${p}-bl)" opacity=".85"><rect x="-40" y="-40" width="${W + 80}" height="${HZ + 50}" fill="url(#${p}-sky)"/></g>`;
  s += `<g filter="url(#${p}-bl)" opacity=".8">`;
  for (const [x, y, rx, ry] of [[220, 120, 170, 34], [560, 70, 210, 30], [820, 190, 150, 26], [380, 250, 140, 20]]) s += `<path d="${blob(rng, x, y, rx, ry, 9, 0.3)}" fill="#fbf8f1"/>`;
  s += `</g>`;
  s += `<g filter="url(#${p}-wl)" opacity=".35">`;
  s += `<path d="${blob(rng, 160, 70, 220, 26, 10, 0.3, -0.04)}" fill="#a79bc8"/>`;
  s += `<path d="${blob(rng, 720, 130, 200, 18, 10, 0.3, 0.03)}" fill="#b49ac0"/>`;
  s += `<path d="${blob(rng, 450, 190, 160, 12, 10, 0.3)}" fill="#c9a2b8"/>`;
  s += `<path d="${blob(rng, 880, 300, 120, 10, 10, 0.3)}" fill="#e8a890"/>`;
  s += `</g>`;
  // sun
  s += `<ellipse cx="640" cy="${HZ - 40}" rx="260" ry="150" fill="url(#${p}-sun)"/>`;
  s += `<g filter="url(#${p}-wc)"><circle cx="640" cy="${HZ - 40}" r="28" fill="#fbe3b0" opacity=".9"/></g>`;

  // ---- far shore with palms silhouetted in haze
  let shore = `M-20 ${HZ + 6}`;
  for (let x = -20; x <= W + 20; x += 20) shore += `L${x} ${f(HZ - 8 - rng.range(0, 10) - (x > 380 && x < 560 ? 10 : 0))}`;
  shore += `L${W + 20} ${HZ + 6}Z`;
  let farPalms = '';
  for (let k = 0; k < 26; k++) {
    const x = rng.range(-10, W + 10), h = rng.range(26, 60), lean = rng.range(-8, 8);
    const tx = x + lean, ty = HZ - 10 - h;
    farPalms += `M${f(x)} ${f(HZ - 8)}Q${f(x + lean * 0.2)} ${f(HZ - 10 - h / 2)} ${f(tx)} ${f(ty)}`;
    for (let j = 0; j < 6; j++) {
      const a = PI + (j / 5) * PI + rng.range(-0.2, 0.2);
      const l = rng.range(9, 15);
      farPalms += `M${f(tx)} ${f(ty)}q${f(Math.cos(a) * l * 0.6)} ${f(Math.sin(a) * l * 0.6 - 3)} ${f(Math.cos(a) * l)} ${f(Math.sin(a) * l * 0.4 + 4)}`;
    }
  }
  const far = `<g filter="url(#${p}-wc)" opacity=".75"><path d="${shore}" fill="#9d97bb"/><path d="${farPalms}" stroke="#9d97bb" stroke-width="2.4" fill="none" stroke-linecap="round"/></g>`;
  s += `<g id="${p}-far">${far}</g>`;

  // ---- water
  s += `<g filter="url(#${p}-bl)" opacity=".8"><rect x="-40" y="${HZ}" width="${W + 80}" height="${H - HZ + 40}" fill="url(#${p}-wat)"/></g>`;
  s += `<use href="#${p}-far" transform="matrix(1 0 0 -1 0 ${2 * HZ + 10})" opacity=".45" filter="url(#${p}-rf)"/>`;
  s += `<g filter="url(#${p}-bl)" opacity=".7"><ellipse cx="640" cy="${HZ + 80}" rx="70" ry="110" fill="#f8d6aa"/></g>`;
  s += `<g filter="url(#${p}-b2)" opacity=".6"><ellipse cx="640" cy="${HZ + 50}" rx="24" ry="60" fill="#fdf0d4"/></g>`;
  s += `<g filter="url(#${p}-bl)" opacity=".35"><rect x="-40" y="${H - 90}" width="${W + 80}" height="140" fill="#8a84b4"/></g>`;
  let lift = '', ripple = '';
  for (let k = 0; k < 40; k++) {
    const y = HZ + 14 + Math.pow(rng(), 1.2) * (H - HZ - 20), x = rng.range(-20, W);
    const l = rng.range(40, 160) * (0.5 + (y - HZ) / (H - HZ));
    if (rng() < 0.55) lift += `M${f(x)} ${f(y)}h${f(l)}`;
    else ripple += `M${f(x)} ${f(y)}h${f(l * 0.6)}`;
  }
  s += `<path d="${lift}" stroke="#fdf7ee" stroke-width="3" opacity=".7" filter="url(#${p}-wc)"/>`;
  s += `<path d="${ripple}" stroke="#8f88b4" stroke-width="2" opacity=".35" filter="url(#${p}-wc)"/>`;

  // ---- houseboat (kettuvallam) and canoe
  const hb = (x, y, sc) => {
    let g = `<g transform="translate(${x} ${y}) scale(${sc})">`;
    g += `<path d="M-132 2C-132-36-118-52-88-52L88-52C118-52 132-36 132 2Z" fill="#8c6a68"/>`;
    g += `<path d="M-124-24C-120-38-108-44-86-44L86-44C108-44 120-38 124-24M-130-10H130" stroke="#5e4250" stroke-width="3" fill="none"/>`;
    for (let i = -4; i <= 4; i++) g += `<path d="M${i * 25 - 7} 0v-18q7-7 14 0v18Z" fill="#3e2a3e" opacity=".85"/>`;
    g += `<path d="M-190-26Q-176 4-130 4L130 4Q176 2 196-34L190-34Q168 26 0 30Q-150 28-192-20Z" fill="#46324a"/>`;
    g += `<path d="M-130 4L130 4" stroke="#c9a48a" stroke-width="2" opacity=".6"/>`;
    g += `</g>`;
    return g;
  };
  const boatSvg = `<g filter="url(#${p}-wc)" opacity=".88">${hb(700, HZ + 66, 0.58)}</g>`;
  s += `<g id="${p}-hb">${boatSvg}</g>`;
  s += `<use href="#${p}-hb" transform="matrix(1 0 0 -1 0 ${2 * (HZ + 84)})" opacity=".35" filter="url(#${p}-rf)"/>`;
  const canoe = `<g filter="url(#${p}-wc)" opacity=".9"><path d="M690 604q80 16 200-10l-4 9q-90 22-190 8Z" fill="#3a2a3e"/>` +
    `<path d="M792 600l-5-26h14l-3 26Z" fill="#efe6dc"/><path d="M786 576l3-30q8-4 12 0l2 30Z" fill="#3a2a3e"/><circle cx="795" cy="538" r="7.5" fill="#3a2a3e"/>` +
    `<path d="M800 552l20 14M790 552l-6 18" stroke="#3a2a3e" stroke-width="4.5" stroke-linecap="round"/><path d="M760 470L846 660" stroke="#3a2a3e" stroke-width="2.6"/></g>`;
  s += `<g id="${p}-cn">${canoe}</g>`;
  s += `<use href="#${p}-cn" transform="matrix(1 0 0 -1 0 ${2 * 606})" opacity=".3" filter="url(#${p}-rf)"/>`;

  // ---- near bank and coconut palms leaning over the water
  let bank = `M-30 ${H + 20}L-30 616`;
  for (let x = -30; x <= 420; x += 15) bank += `L${x} ${f(616 + Math.pow(Math.max(0, x - 80) / 340, 2) * 140 + rng.range(-5, 5))}`;
  bank += `L440 ${H + 20}Z`;
  let palms = '';
  const palm = (bx, by, len, lean, bow, sc) => {
    const tx = bx + Math.cos(lean) * len, ty = by + Math.sin(lean) * len;
    const nx = -Math.sin(lean), ny = Math.cos(lean);
    const cx = (bx + tx) / 2 + nx * bow, cy = (by + ty) / 2 + ny * bow;
    const w0 = 12 * sc, w1 = 5.5 * sc;
    let t = `<path d="M${f(bx + nx * w0)} ${f(by + ny * w0)}Q${f(cx + nx * 8 * sc)} ${f(cy + ny * 8 * sc)} ${f(tx + nx * w1)} ${f(ty + ny * w1)}L${f(tx - nx * w1)} ${f(ty - ny * w1)}Q${f(cx - nx * 8 * sc)} ${f(cy - ny * 8 * sc)} ${f(bx - nx * w0)} ${f(by - ny * w0)}Z" fill="#4c3c4a"/>`;
    let rings = '';
    for (let k = 1; k < 16; k++) {
      const u = k / 16;
      const px = (1 - u) * (1 - u) * bx + 2 * u * (1 - u) * cx + u * u * tx;
      const py = (1 - u) * (1 - u) * by + 2 * u * (1 - u) * cy + u * u * ty;
      const w = lerp(w0, w1, u);
      rings += `M${f(px - nx * w)} ${f(py - ny * w)}l${f(nx * w * 1.4)} ${f(ny * w * 1.4)}`;
    }
    t += `<path d="${rings}" stroke="#2c2234" stroke-width="1.4" opacity=".55"/>`;
    // arching fronds with drooping leaflets
    let fr = '', spine = '';
    const nf = 10;
    for (let i = 0; i < nf; i++) {
      const a = -PI / 2 + (i / (nf - 1) - 0.5) * 4.2 + rng.range(-0.12, 0.12);
      const L = rng.range(110, 150) * sc * (Math.sin(-a) > 0.6 ? 0.75 : 1);
      const ca = Math.cos(a), sa = Math.sin(a);
      const mx = tx + ca * L * 0.5, my = ty + sa * L * 0.5 - L * 0.22;
      const ex = tx + ca * L * 0.95, ey = ty + sa * L * 0.6 + L * 0.3;
      spine += `M${f(tx)} ${f(ty)}Q${f(mx)} ${f(my)} ${f(ex)} ${f(ey)}`;
      const top = [], bot = [];
      const K = 30;
      for (let k = 0; k <= K; k++) {
        const u = k / K;
        const px = (1 - u) * (1 - u) * tx + 2 * u * (1 - u) * mx + u * u * ex;
        const py = (1 - u) * (1 - u) * ty + 2 * u * (1 - u) * my + u * u * ey;
        const dx = 2 * (1 - u) * (mx - tx) + 2 * u * (ex - mx), dy = 2 * (1 - u) * (my - ty) + 2 * u * (ey - my);
        const dl = Math.hypot(dx, dy) || 1;
        let nx2 = -dy / dl, ny2 = dx / dl;
        if (ny2 < 0) { nx2 = -nx2; ny2 = -ny2; }
        // leaflets hang mostly downward
        const hx = nx2 * 0.45 + (ex > tx ? 0.25 : -0.25), hy = ny2 * 0.45 + 0.75;
        const w = Math.sin(PI * Math.pow(Math.max(u, 0.04), 0.6)) * rng.range(30, 44) * sc * (k % 2 ? rng.range(0.8, 1.1) : 0.1);
        top.push([px - nx2 * 1.5 * sc, py - ny2 * 1.5 * sc]);
        bot.push([px + hx * w, py + hy * w]);
      }
      fr += polyPath(top.concat(bot.reverse()));
    }
    t += `<path d="${spine}" stroke="#2a3a42" stroke-width="${f(3 * sc)}" fill="none" stroke-linecap="round"/>`;
    t += `<path d="${fr}" fill="#2f4448" opacity=".92"/>`;
    t += `<circle cx="${f(tx - 3 * sc)}" cy="${f(ty + 8 * sc)}" r="${f(8 * sc)}" fill="#3e3a30"/><circle cx="${f(tx + 7 * sc)}" cy="${f(ty + 11 * sc)}" r="${f(7 * sc)}" fill="#4a4434"/>`;
    return t;
  };
  palms += palm(40, 622, 420, -1.25, 40, 1.05);
  palms += palm(130, 618, 360, -0.92, 50, 0.95);
  palms += palm(240, 640, 300, -0.62, 60, 0.85);
  palms += palm(-10, 640, 260, -1.5, -10, 0.8);
  const palmG = `<g filter="url(#${p}-wp)" opacity=".9">${palms}</g>`;
  s += `<g id="${p}-pl">${palmG}</g>`;
  s += `<use href="#${p}-pl" transform="matrix(1 0 0 -1 0 ${2 * 628})" opacity=".2" filter="url(#${p}-rf)"/>`;
  s += `<clipPath id="${p}-bk"><path d="${bank}"/></clipPath>`;
  s += `<g filter="url(#${p}-wl)" opacity=".88"><path d="${bank}" fill="#3c4039"/><g clip-path="url(#${p}-bk)" filter="url(#${p}-b2)"><path d="${blob(rng, 110, 650, 160, 40, 8, 0.3)}" fill="#5a6248" opacity=".45"/><path d="${blob(rng, 300, 720, 120, 40, 8, 0.3)}" fill="#33382f" opacity=".7"/><path d="${blob(rng, 40, 720, 120, 40, 8, 0.3)}" fill="#6a5a50" opacity=".6"/></g></g>`;
  let hy = '', hyf = '';
  for (let k = 0; k < 7; k++) {
    const x = rng.range(300, 620), y = rng.range(640, 730);
    hy += blob(rng, x, y, rng.range(14, 30), rng.range(4, 7), 7, 0.3);
    hyf += `M${f(x + rng.range(-8, 8))} ${f(y - 4)}h.1`;
  }
  s += `<g filter="url(#${p}-wc)" opacity=".8"><path d="${hy}" fill="#5a7a52"/><path d="${hyf}" stroke="#b9a0d0" stroke-width="5" stroke-linecap="round"/></g>`;
  let grass = '';
  for (let k = 0; k < 46; k++) {
    const x = rng.range(-10, 380), y = 612 + Math.max(0, x - 60) * 0.12 + rng.range(-6, 20);
    grass += `M${f(x)} ${f(y)}q${f(rng.range(-6, 6))} ${f(-rng.range(10, 20))} ${f(rng.range(-12, 12))} ${f(-rng.range(18, 34))}`;
  }
  s += `<path d="${grass}" stroke="#3f4a3a" stroke-width="2" fill="none" opacity=".7" filter="url(#${p}-pen)"/>`;
  // birds
  let birds = '';
  for (const [bx, by, k] of [[420, 150, 1], [446, 166, 0.8], [470, 142, 0.7]]) birds += `M${f(bx - 10 * k)} ${f(by)}q${f(5 * k)} ${f(-5 * k)} ${f(10 * k)} 0q${f(5 * k)} ${f(-5 * k)} ${f(10 * k)} 0`;
  s += `<path d="${birds}" stroke="#5a4a64" stroke-width="2" fill="none" opacity=".7" filter="url(#${p}-pen)"/>`;
  s += paper.over;
  return svgDoc(W, H, defs, s);
};

/* ---------------- Watercolour: Kingfisher & Blossoms ---------------- */
ART['kingfisher-blossoms.svg'] = (rng) => {
  const W = 800, H = 1000, p = 'kf';
  const paper = wcPaper(p, W, H);
  const defs = paper.defs +
    FX.watercolor(`${p}-wc`, 5, 7, 0.04, 0.9, 0.35) +
    FX.watercolor(`${p}-wl`, 9, 16, 0.02, 0.7, 0.45) +
    FX.watercolor(`${p}-wb`, 14, 5, 0.05, 0.6, 0.25) +
    FX.bleed(`${p}-bl`, 26, 5, 50) +
    FX.bleed(`${p}-b2`, 6, 8, 12) +
    FX.wobble(`${p}-pen`, 0.09, 2, 12) +
    radGrad(`${p}-pa`, [[0, '#d9567a'], [0.35, '#f09ab0'], [1, '#fbd8e0']]) +
    radGrad(`${p}-pb`, [[0, '#c43f66'], [0.4, '#e9809c'], [1, '#f8c4d0']]) +
    linGrad(`${p}-or`, [[0, '#f4a860'], [0.5, '#ea8236'], [1, '#c9622a']], 0, 0, 0.3, 1) +
    linGrad(`${p}-bu`, [[0, '#2fa6c8'], [0.6, '#1e75a2'], [1, '#1b5a86']], 0, 0, 1, 1) +
    linGrad(`${p}-aq`, [[0, '#7fbcc0', 0], [0.5, '#7fbcc0', 0.8], [1, '#7fbcc0', 1]], 0, 0, 0.4, 1) +
    linGrad(`${p}-br`, [[0, '#7a5e4c'], [1, '#4c3a34']], 0, 0, 0, 1) +
    `<path id="${p}-pt" d="M0 0C-.5-.2-.55-.85-.17-1Q0-.9.17-1C.55-.85.5-.2 0 0Z"/>` +
    `<g id="${p}-fa">${[0, 72, 144, 216, 288].map((a) => `<use href="#${p}-pt" transform="rotate(${a}) scale(26)"/>`).join('')}</g>`;

  let s = paper.under;
  // background washes: soft aqua behind the bird, pink haze, plenty of white
  s += `<g filter="url(#${p}-bl)" opacity=".5">`;
  s += `<path d="${blob(rng, 400, 600, 250, 220, 9, 0.35)}" fill="#bfdcd8"/>`;
  s += `<path d="${blob(rng, 650, 230, 170, 150, 9, 0.35)}" fill="#f2d0d8"/>`;
  s += `<path d="${blob(rng, 160, 380, 130, 160, 9, 0.35)}" fill="#f4dde2"/>`;
  s += `<path d="${blob(rng, 330, 880, 260, 90, 9, 0.35)}" fill="#cfe0cf"/>`;
  s += `</g>`;
  s += `<g filter="url(#${p}-wl)" opacity=".22"><path d="${blob(rng, 430, 560, 200, 170, 10, 0.3)}" fill="url(#${p}-aq)"/></g>`;

  // ---- branch with twigs (dry-brush feel)
  const bpts = [[-40, 900], [140, 836], [320, 776], [500, 730], [670, 694], [840, 676]];
  const b2 = [[850, 40], [720, 92], [600, 160], [500, 214], [420, 238]];
  const branchY = (x) => {
    for (let i = 1; i < bpts.length; i++) if (x <= bpts[i][0]) {
      const t = (x - bpts[i - 1][0]) / (bpts[i][0] - bpts[i - 1][0]);
      return lerp(bpts[i - 1][1], bpts[i][1], t);
    }
    return bpts[bpts.length - 1][1];
  };
  const thick = (pts, w0, w1) => {
    const top = [], bot = [];
    pts.forEach((pt, i) => {
      const t = i / (pts.length - 1);
      const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      const dx = q[0] - o[0], dy = q[1] - o[1], dl = Math.hypot(dx, dy) || 1;
      const w = lerp(w0, w1, t) * (1 + rng.range(-0.08, 0.08));
      top.push([pt[0] - (dy / dl) * w, pt[1] + (dx / dl) * w]);
      bot.push([pt[0] + (dy / dl) * w, pt[1] - (dx / dl) * w]);
    });
    return smoothPath(top.concat(bot.reverse()), true);
  };
  const twigs = [
    [[200, 818], [176, 720], [164, 640], [130, 560]],
    [[610, 708], [640, 620], [680, 540], [700, 470]],
    [[740, 688], [770, 630], [800, 580]],
    [[80, 856], [56, 790], [30, 730]],
    [[640, 140], [622, 220], [630, 300], [612, 360]],
    [[520, 206], [490, 280], [470, 330]],
    [[760, 76], [770, 160], [748, 230]],
  ];
  let br = `<path d="${thick(bpts, 18, 8)}" fill="url(#${p}-br)"/><path d="${thick(b2, 13, 4)}" fill="url(#${p}-br)"/>`;
  for (const tw of twigs) br += `<path d="${thick(tw, 6, 1.6)}" fill="#6a5244"/>`;
  let bark = '';
  for (let k = 0; k < 40; k++) {
    const x = rng.range(-20, 820), y = branchY(x) + rng.range(-7, 9);
    bark += `M${f(x)} ${f(y)}l${f(rng.range(10, 30))} ${f(rng.range(-6, 3))}`;
  }
  s += `<g filter="url(#${p}-wb)" opacity=".92">${br}</g>`;
  s += `<path d="${bark}" stroke="#3a2a26" stroke-width="1.6" opacity=".45" fill="none" filter="url(#${p}-pen)"/>`;
  s += `<path d="${smoothPath(bpts.map(([x, y]) => [x, y - 9]))}" stroke="#c9b09a" stroke-width="2.4" opacity=".5" fill="none" filter="url(#${p}-pen)"/>`;

  // ---- blossoms, buds and young leaves
  let leaves = '', flowersA = '', flowersB = '', centers = '', stam = '', tips = '', buds = '';
  const flower = (x, y, sc, rot, deep, squash = 1) => {
    const u = `<use href="#${p}-fa" transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)}) scale(${f(sc)} ${f(sc * squash)})"/>`;
    if (deep) flowersB += u; else flowersA += u;
    centers += `M${f(x)} ${f(y)}h.1`;
    for (let k = 0; k < 7; k++) {
      const a = rng.range(0, TAU), r = rng.range(5, 11) * sc;
      stam += `M${f(x)} ${f(y)}l${f(Math.cos(a) * r)} ${f(Math.sin(a) * r * squash)}`;
      tips += `M${f(x + Math.cos(a) * r)} ${f(y + Math.sin(a) * r * squash)}h.1`;
    }
  };
  const clusters = [[130, 560, 4], [164, 650, 3], [700, 470, 4], [690, 560, 2], [800, 580, 3], [30, 730, 3], [612, 360, 4], [630, 270, 2], [470, 330, 3], [748, 230, 4], [440, 250, 3], [560, 180, 2], [330, 770, 2], [560, 720, 2], [690, 110, 2]];
  for (const [cx, cy, n] of clusters) {
    for (let k = 0; k < n; k++) {
      const x = cx + rng.range(-40, 40), y = cy + rng.range(-40, 30);
      flower(x, y, rng.range(0.95, 1.45), rng.range(0, 72), rng() < 0.4, rng() < 0.3 ? rng.range(0.55, 0.8) : 1);
    }
    for (let k = 0; k < 2; k++) {
      const x = cx + rng.range(-50, 50), y = cy + rng.range(-50, 14);
      buds += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="7" ry="10" transform="rotate(${f(rng.range(-30, 30))} ${f(x)} ${f(y)})" fill="#d2557a"/>`;
      buds += `<path d="M${f(x - 6)} ${f(y + 6)}q6 10 12 0" stroke="#6f8f4a" stroke-width="3" fill="none"/>`;
    }
    for (let k = 0; k < 2; k++) {
      const a = rng.range(-PI, 0);
      leaves += `<path d="${leafPath(cx + rng.range(-20, 20), cy + rng.range(0, 20), a, rng.range(40, 60), rng.range(18, 24), { sharp: 0.9 })}" fill="${rng.pick(['#8fb35a', '#a3be62', '#7ea256'])}"/>`;
    }
  }
  // drifting petals
  let fall = '';
  for (let k = 0; k < 9; k++) {
    fall += `<use href="#${p}-pt" transform="translate(${f(rng.range(60, 760))} ${f(rng.range(560, 960))}) rotate(${f(rng.range(0, 360))}) scale(${f(rng.range(14, 20))} ${f(rng.range(10, 18))})"/>`;
  }
  s += `<g filter="url(#${p}-wc)" opacity=".8">${leaves}</g>`;
  s += `<g filter="url(#${p}-wc)" opacity=".85"><g fill="url(#${p}-pa)">${flowersA}</g><g fill="url(#${p}-pb)">${flowersB}</g>${buds}<g fill="#f2a6b8">${fall}</g></g>`;
  s += `<path d="${stam}" stroke="#b8406a" stroke-width="1.2" opacity=".7"/>`;
  s += `<path d="${centers}" stroke="#a8325a" stroke-width="7" stroke-linecap="round" opacity=".8"/>`;
  s += `<path d="${tips}" stroke="#f0c040" stroke-width="3.4" stroke-linecap="round"/>`;

  // ---- kingfisher (facing left), perched on the branch
  const bx = 380, by = branchY(380) - 12;
  let bird = `<g transform="translate(${bx} ${by}) scale(1.6)">`;
  // base silhouette (orange underparts)
  bird += `<g filter="url(#${p}-wc)">`;
  bird += `<path d="M-74-140C-66-172-14-178 6-150C24-128 44-98 60-66L120-10L110 2L50-28C34-8 0 4-24-6C-52-22-70-60-72-100L-70-113Z" fill="url(#${p}-or)"/>`;
  // back + wing + tail
  bird += `<path d="M2-150C24-128 44-98 60-66L120-10L110 2L50-26C36-30 18-32 2-42C-14-56-20-82-14-104C-10-118-6-132 2-150Z" fill="url(#${p}-bu)"/>`;
  bird += `<path d="M24-74C44-58 66-40 96-16L84-14C62-24 40-36 14-50Z" fill="#164a6a" opacity=".85"/>`;
  bird += `<path d="M6-146C26-122 42-96 58-66L66-58C48-94 32-122 12-150Z" fill="#46d0dc"/>`;
  // crown cap
  bird += `<path d="M-74-140C-66-172-14-178 6-150C2-138-10-133-22-134C-42-137-60-136-74-133Z" fill="#2386b0"/>`;
  // moustache stripe
  bird += `<path d="M-70-114C-56-108-36-104-14-112L-12-104C-36-96-56-99-71-108Z" fill="#1f6f98"/>`;
  // cheek, white throat & neck patch
  bird += `<ellipse cx="-36" cy="-123" rx="17" ry="8" fill="#ec8a3e"/>`;
  bird += `<ellipse cx="-62" cy="-103" rx="10" ry="6" fill="#fbf6ec"/>`;
  bird += `<path d="M-14-132C-4-130 0-118-4-108C-10-104-16-112-16-122Z" fill="#fbf6ec"/>`;
  bird += `</g>`;
  // bill
  bird += `<g filter="url(#${p}-wb)"><path d="M-72-141L-178-120L-70-112Z" fill="#2b2a30"/><path d="M-74-126L-172-119" stroke="#6a5a5a" stroke-width="1.2"/></g>`;
  // eye stripe & eye
  bird += `<path d="M-72-133C-58-132-44-131-24-127" stroke="#173a52" stroke-width="4" fill="none" stroke-linecap="round" opacity=".8"/>`;
  bird += `<circle cx="-46" cy="-131" r="6.5" fill="#15151a"/><circle cx="-48" cy="-133" r="2" fill="#fff"/>`;
  // speckles on crown and wing coverts
  let sp = '';
  for (let k = 0; k < 26; k++) {
    const a = rng.range(PI * 1.05, PI * 1.95), r = rng.range(14, 30);
    sp += `M${f(-34 + Math.cos(a) * r)} ${f(-140 + Math.sin(a) * r * 0.8)}h.1`;
  }
  for (let k = 0; k < 22; k++) sp += `M${f(rng.range(-6, 30))} ${f(rng.range(-100, -60))}h.1`;
  bird += `<path d="${sp}" stroke="#8fe0ec" stroke-width="2.6" stroke-linecap="round" opacity=".8"/>`;
  // feather lines
  bird += `<path d="M30-62l60 44M22-56l52 40M40-70l70 54M8-60q10 30 40 34" stroke="#0f3a54" stroke-width="1.2" fill="none" opacity=".6" filter="url(#${p}-pen)"/>`;
  bird += `<path d="M-60-80q8 26 30 44M-44-60q10 20 24 28" stroke="#b55a22" stroke-width="1" fill="none" opacity=".5" filter="url(#${p}-pen)"/>`;
  // feet
  bird += `<path d="M-16-6l-5 12M-2-6l3 12M-25 7h10M-4 7h10" stroke="#d6503a" stroke-width="3.2" stroke-linecap="round"/>`;
  bird += `</g>`;
  s += bird;
  s += paper.over;
  return svgDoc(W, H, defs, s);
};

/* ------------------------------------------------------------------ */
/* Pattachitra toolkit                                                  */
/* ------------------------------------------------------------------ */
const PT = {
  red: '#a8291d', maroon: '#6e1b13', yel: '#eaa92e', ochre: '#d38a22', white: '#f4ead0',
  black: '#1b120e', indigo: '#28407a', green: '#2f6b3b', peach: '#f0b98a', pink: '#e27c6a',
};
/** Border motif tiles: draw within (tw x w), u along the band, v inward. */
const PT_MOTIFS = {
  dots: (tw, w) => `<rect width="${tw}" height="${w}" fill="${PT.black}"/><circle cx="${tw / 2}" cy="${w / 2}" r="${f(w * 0.22)}" fill="${PT.white}"/>`,
  petal: (tw, w) =>
    `<rect width="${tw}" height="${w}" fill="${PT.yel}"/>` +
    `<path d="M${f(tw / 2)} ${f(w - 2)}C${f(tw * 0.05)} ${f(w * 0.7)} ${f(tw * 0.2)} ${f(w * 0.2)} ${f(tw / 2)} 3C${f(tw * 0.8)} ${f(w * 0.2)} ${f(tw * 0.95)} ${f(w * 0.7)} ${f(tw / 2)} ${f(w - 2)}Z" fill="${PT.red}" stroke="${PT.black}" stroke-width="1.6"/>` +
    `<path d="M${f(tw / 2)} ${f(w - 5)}C${f(tw * 0.3)} ${f(w * 0.65)} ${f(tw * 0.35)} ${f(w * 0.35)} ${f(tw / 2)} ${f(w * 0.3)}" fill="none" stroke="${PT.white}" stroke-width="1.2"/>` +
    `<circle cx="0" cy="${f(w * 0.3)}" r="2" fill="${PT.black}"/><circle cx="${tw}" cy="${f(w * 0.3)}" r="2" fill="${PT.black}"/>`,
  tri: (tw, w) =>
    `<rect width="${tw}" height="${w}" fill="${PT.white}"/><path d="M0 ${w}L${f(tw / 2)} 1L${tw} ${w}Z" fill="${PT.black}"/><path d="M${f(tw * 0.3)} ${f(w - 1)}L${f(tw / 2)} ${f(w * 0.45)}L${f(tw * 0.7)} ${f(w - 1)}Z" fill="${PT.red}"/>`,
  flower: (tw, w) => {
    const cx = tw / 2, cy = w / 2, r = w * 0.36;
    let s = `<rect width="${tw}" height="${w}" fill="${PT.red}"/>`;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * 360;
      s += `<ellipse cx="${f(cx)}" cy="${f(cy - r * 0.55)}" rx="${f(r * 0.26)}" ry="${f(r * 0.5)}" transform="rotate(${a} ${f(cx)} ${f(cy)})" fill="${PT.white}" stroke="${PT.black}" stroke-width="1.2"/>`;
    }
    s += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r * 0.34)}" fill="${PT.yel}" stroke="${PT.black}" stroke-width="1.4"/><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r * 0.1)}" fill="${PT.black}"/>`;
    s += `<circle cx="0" cy="${f(cy)}" r="${f(w * 0.08)}" fill="${PT.yel}"/><circle cx="${tw}" cy="${f(cy)}" r="${f(w * 0.08)}" fill="${PT.yel}"/>`;
    s += `<circle cx="0" cy="5" r="1.6" fill="${PT.white}"/><circle cx="0" cy="${w - 5}" r="1.6" fill="${PT.white}"/>`;
    return s;
  },
  vine: (tw, w) => {
    const m = w / 2, a = w * 0.22;
    let s = `<rect width="${tw}" height="${w}" fill="${PT.yel}"/>`;
    s += `<path d="M0 ${f(m)}C${f(tw * 0.25)} ${f(m - a * 1.6)} ${f(tw * 0.25)} ${f(m - a * 1.6)} ${f(tw / 2)} ${f(m)}S${f(tw * 0.75)} ${f(m + a * 1.6)} ${tw} ${f(m)}" fill="none" stroke="${PT.black}" stroke-width="2"/>`;
    s += `<path d="${leafPath(tw * 0.25, m - a * 1.2, -PI / 2 - 0.5, w * 0.36, w * 0.22)}" fill="${PT.red}" stroke="${PT.black}" stroke-width="1.3"/>`;
    s += `<path d="${leafPath(tw * 0.75, m + a * 1.2, PI / 2 - 0.5, w * 0.36, w * 0.22)}" fill="${PT.green}" stroke="${PT.black}" stroke-width="1.3"/>`;
    s += `<circle cx="${f(tw * 0.5)}" cy="${f(m)}" r="${f(w * 0.1)}" fill="${PT.white}" stroke="${PT.black}" stroke-width="1.1"/>`;
    s += `<circle cx="${f(tw * 0.1)}" cy="${f(m + a * 1.3)}" r="1.8" fill="${PT.red}"/><circle cx="${f(tw * 0.6)}" cy="${f(m - a * 1.3)}" r="1.8" fill="${PT.black}"/>`;
    return s;
  },
};
/**
 * Concentric decorative bands around a rectangle. bands: [{k, w, tw}] or
 * {line: colour, w}. Returns defs, svg and the inner rectangle.
 */
function pattaBorder(p, W, H, bands) {
  let defs = '', svg = '', o = 0;
  bands.forEach((b, i) => {
    const w = b.w;
    if (b.line) {
      svg += `<path d="M${f(o + w / 2)} ${f(o + w / 2)}H${f(W - o - w / 2)}V${f(H - o - w / 2)}H${f(o + w / 2)}Z" fill="none" stroke="${b.line}" stroke-width="${w}"/>`;
      o += w;
      return;
    }
    const id = `${p}-m${i}`;
    defs += `<g id="${id}">${PT_MOTIFS[b.k](b.tw, w)}</g>`;
    const Lh = W - 2 * o - 2 * w, Lv = H - 2 * o - 2 * w;
    const nh = Math.max(1, Math.round(Lh / b.tw)), nv = Math.max(1, Math.round(Lv / b.tw));
    const sh = Lh / nh / b.tw, sv = Lv / nv / b.tw;
    const pat = (pid, sc, mtx) =>
      `<pattern id="${pid}" patternUnits="userSpaceOnUse" width="${f(b.tw * sc)}" height="${w}" patternTransform="matrix(${mtx})"><use href="#${id}" transform="scale(${sc.toFixed(4)} 1)"/></pattern>`;
    defs += pat(`${id}t`, sh, `1 0 0 1 ${f(o + w)} ${f(o)}`);
    defs += pat(`${id}b`, sh, `1 0 0 -1 ${f(o + w)} ${f(H - o)}`);
    defs += pat(`${id}l`, sv, `0 1 1 0 ${f(o)} ${f(o + w)}`);
    defs += pat(`${id}r`, sv, `0 1 -1 0 ${f(W - o)} ${f(o + w)}`);
    svg += `<rect x="${f(o + w)}" y="${f(o)}" width="${f(Lh)}" height="${w}" fill="url(#${id}t)"/>`;
    svg += `<rect x="${f(o + w)}" y="${f(H - o - w)}" width="${f(Lh)}" height="${w}" fill="url(#${id}b)"/>`;
    svg += `<rect x="${f(o)}" y="${f(o + w)}" width="${w}" height="${f(Lv)}" fill="url(#${id}l)"/>`;
    svg += `<rect x="${f(W - o - w)}" y="${f(o + w)}" width="${w}" height="${f(Lv)}" fill="url(#${id}r)"/>`;
    // corner blocks with a small rosette
    for (const [cx, cy] of [[o, o], [W - o - w, o], [o, H - o - w], [W - o - w, H - o - w]]) {
      svg += `<rect x="${f(cx)}" y="${f(cy)}" width="${w}" height="${w}" fill="${PT.black}"/>`;
      if (w >= 14) svg += `<circle cx="${f(cx + w / 2)}" cy="${f(cy + w / 2)}" r="${f(w * 0.32)}" fill="${PT.yel}" stroke="${PT.white}" stroke-width="1.5"/><circle cx="${f(cx + w / 2)}" cy="${f(cy + w / 2)}" r="${f(w * 0.12)}" fill="${PT.red}"/>`;
    }
    o += w;
  });
  return { defs, svg, inner: [o, o, W - o, H - o] };
}
/** Cloth texture, chalk-ground crackle and hand wobble for patta paintings. */
function pattaFinish(p, W, H) {
  const defs =
    FX.wobble(`${p}-hw`, 0.035, 3, 3, 2, W, H) +
    FX.canvas(`${p}-cv`, 31, 0.8, W, H) +
    FX.speckle(`${p}-sp`, '#2a1608', 0.6, 1.5, -0.85, 41) +
    `<filter id="${p}-ck" x="0" y="0" width="100%" height="100%"><feTurbulence type="turbulence" baseFrequency="0.035" numOctaves="2" seed="17"/><feColorMatrix values="0 0 0 0 0.16 0 0 0 0 0.09 0 0 0 0 0.05 -2.2 0 0 0 0.24"/></filter>` +
    radGrad(`${p}-ag`, [[0.55, '#000', 0], [1, '#3a1a06', 0.3]], 0.5, 0.5, 0.75);
  const over =
    `<rect width="${W}" height="${H}" filter="url(#${p}-ck)" opacity=".5"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-sp)" opacity=".5"/>` +
    `<rect width="${W}" height="${H}" fill="url(#${p}-ag)"/>`;
  return { defs, over };
}
/** Small three-dot / tiny-flower fillers scattered on empty ground. */
function dotFill(rng, x0, y0, x1, y1, n, avoid, color = PT.white) {
  let d = '';
  let tries = 0, made = 0;
  while (made < n && tries < n * 20) {
    tries++;
    const x = rng.range(x0, x1), y = rng.range(y0, y1);
    if (avoid && avoid(x, y)) continue;
    const r = 2.2;
    d += `M${f(x)} ${f(y - r)}h.1M${f(x - r)} ${f(y + r * 0.7)}h.1M${f(x + r)} ${f(y + r * 0.7)}h.1`;
    made++;
  }
  return `<path d="${d}" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/>`;
}

/* ---------------- Pattachitra: Konark Sun ---------------- */
/** Frontal Surya face (radius ~100 at scale 1), Pattachitra conventions. */
function suryaFace(p) {
  const B = PT.black;
  let s = `<circle r="104" fill="#f3b63d" stroke="${B}" stroke-width="4"/>`;
  let dots = '';
  for (let k = 0; k < 44; k++) {
    const a = (k / 44) * TAU;
    dots += `M${f(Math.cos(a) * 95)} ${f(Math.sin(a) * 95)}h.1`;
  }
  s += `<path d="${dots}" stroke="${PT.red}" stroke-width="4.4" stroke-linecap="round"/>`;
  // crown band across the forehead
  s += `<path d="M-66-58Q0-92 66-58" fill="none" stroke="${B}" stroke-width="7"/><path d="M-66-58Q0-92 66-58" fill="none" stroke="${PT.white}" stroke-width="2.4" stroke-dasharray=".1 7" stroke-linecap="round"/>`;
  const half = (sx) => {
    const t = `scale(${sx} 1)`;
    let h = `<g transform="${t}">`;
    h += `<path d="M7-30C30-54 60-52 80-34C60-44 30-45 9-25Z" fill="${B}"/>`;
    h += `<path d="M11-15C28-33 57-33 76-18C57-5 28-3 11-15Z" fill="#fffaf0" stroke="${B}" stroke-width="2.6"/>`;
    h += `<circle cx="40" cy="-17" r="9.5" fill="${B}"/><circle cx="37" cy="-20" r="2.6" fill="#fff"/>`;
    h += `<path d="M76-18L92-28M74-15Q84-12 90-20" fill="none" stroke="${B}" stroke-width="2.6" stroke-linecap="round"/>`;
    h += `<path d="M52 18m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0M44 30h.1M60 30h.1" fill="${PT.red}" stroke="${PT.red}" stroke-width="4" stroke-linecap="round"/>`;
    h += `<circle cx="100" cy="30" r="11" fill="${PT.yel}" stroke="${B}" stroke-width="2.5"/><circle cx="100" cy="30" r="4" fill="${PT.red}"/><circle cx="100" cy="46" r="4" fill="${PT.white}" stroke="${B}" stroke-width="1.5"/>`;
    h += `</g>`;
    return h;
  };
  s += half(1) + half(-1);
  s += `<path d="M0-24C-4-4-9 13-7 24C-3 31 6 31 10 24" fill="none" stroke="${B}" stroke-width="3" stroke-linecap="round"/>`;
  s += `<path d="M-23 46C-13 38-4 40 0 44C4 40 13 38 23 46C13 57-13 57-23 46Z" fill="#c42a22" stroke="${B}" stroke-width="2.2"/><path d="M-23 46Q0 50 23 46" fill="none" stroke="${B}" stroke-width="1.6"/>`;
  s += `<path d="M0-68C7-57 7-45 0-36C-7-45-7-57 0-68Z" fill="${PT.red}" stroke="${PT.white}" stroke-width="2.4"/>`;
  s += `<path d="M-14 72Q0 78 14 72" fill="none" stroke="${B}" stroke-width="2.4" stroke-linecap="round"/>`;
  return s;
}

ART['konark-sun.svg'] = (rng) => {
  const W = 900, H = 900, p = 'ks', B = PT.black;
  const border = pattaBorder(p, W, H, [
    { k: 'dots', w: 12, tw: 12 }, { line: B, w: 3 }, { k: 'petal', w: 26, tw: 24 }, { line: B, w: 3 },
    { k: 'tri', w: 14, tw: 14 }, { line: PT.yel, w: 4 }, { line: B, w: 2 }, { k: 'flower', w: 38, tw: 42 },
    { line: B, w: 3 }, { k: 'vine', w: 28, tw: 56 }, { line: B, w: 3 },
  ]);
  const fin = pattaFinish(p, W, H);
  const [x0, y0, x1, y1] = border.inner;
  const C = W / 2, R = 292;
  let s = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${PT.red}"/>`;

  // corner quarter-lotuses
  const corner = (cx, cy, a0) => {
    let g = '';
    const ring = (n, len, wid, fill, line) => {
      for (let k = 0; k < n; k++) {
        const a = a0 + ((k + 0.5) / n) * (PI / 2);
        g += `<path d="${leafPath(cx, cy, a, len, wid, { sharp: 0.8, pk: 1.1, n: 4 })}" fill="${fill}" stroke="${B}" stroke-width="2.4"/>`;
        if (line) {
          const [ex, ey] = pol(cx, cy, len * 0.72, a);
          const [sx, sy] = pol(cx, cy, len * 0.28, a);
          g += `<path d="M${f(sx)} ${f(sy)}L${f(ex)} ${f(ey)}" stroke="${line}" stroke-width="1.6"/>`;
        }
      }
    };
    ring(6, 132, 52, PT.indigo, PT.white);
    ring(5, 104, 50, PT.yel, PT.red);
    ring(4, 74, 44, PT.white, PT.red);
    g += `<circle cx="${cx}" cy="${cy}" r="36" fill="${PT.green}" stroke="${B}" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="22" fill="${PT.yel}" stroke="${B}" stroke-width="2"/>`;
    return g;
  };
  let defs = `<g id="${p}-cr">${corner(0, 0, 0)}</g>`;
  s += `<use href="#${p}-cr" transform="translate(${x0} ${y0})"/><use href="#${p}-cr" transform="translate(${x1} ${y0}) rotate(90)"/><use href="#${p}-cr" transform="translate(${x1} ${y1}) rotate(180)"/><use href="#${p}-cr" transform="translate(${x0} ${y1}) rotate(270)"/>`;
  s += dotFill(rng, x0 + 6, y0 + 6, x1 - 6, y1 - 6, 130, (x, y) => Math.hypot(x - C, y - C) < R + 12 || [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].some(([a, b]) => Math.hypot(x - a, y - b) < 140));

  // the chariot wheel
  let wh = `<g transform="translate(${C} ${C})">`;
  wh += `<circle r="${R}" fill="${PT.yel}" stroke="${B}" stroke-width="5"/>`;
  wh += `<circle r="248" fill="${PT.indigo}" stroke="${B}" stroke-width="3"/>`;
  let stars = '';
  for (let k = 0; k < 140; k++) {
    const a = rng.range(0, TAU), r = rng.range(170, 242);
    stars += `M${f(Math.cos(a) * r)} ${f(Math.sin(a) * r)}h.1`;
  }
  wh += `<path d="${stars}" stroke="${PT.white}" stroke-width="2.6" stroke-linecap="round" opacity=".85"/>`;
  // rim beads and teeth
  let beads = '', teeth = '';
  defs += `<g id="${p}-bd"><circle cx="276" r="7.5" fill="${PT.white}" stroke="${B}" stroke-width="2"/><circle cx="${f(276 * Math.cos(PI / 40))}" cy="${f(276 * Math.sin(PI / 40))}" r="2.6" fill="${PT.red}"/></g>`;
  for (let k = 0; k < 40; k++) beads += `<use href="#${p}-bd" transform="rotate(${k * 9})"/>`;
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * TAU, a1 = ((k + 1) / 64) * TAU, am = (a + a1) / 2;
    teeth += `M${nums(pol(0, 0, 262, a))}L${nums(pol(0, 0, 250, am))}L${nums(pol(0, 0, 262, a1))}`;
  }
  wh += `<circle r="262" fill="none" stroke="${B}" stroke-width="3"/>`;
  wh += `<path d="${teeth}" fill="${PT.red}" stroke="${B}" stroke-width="1.4"/>` + beads;
  // spokes
  const spoke = (a, w0, w1, r0, r1, fill, major) => {
    const ca = Math.cos(a), sa = Math.sin(a), nx = -sa, ny = ca;
    const pts = [[ca * r0 + nx * w0, sa * r0 + ny * w0], [ca * r1 + nx * w1, sa * r1 + ny * w1], [ca * r1 - nx * w1, sa * r1 - ny * w1], [ca * r0 - nx * w0, sa * r0 - ny * w0]];
    let g = `<path d="${polyPath(pts)}" fill="${fill}" stroke="${B}" stroke-width="3"/>`;
    if (major) {
      for (const r of [170, 186, 224, 238]) {
        const w = lerp(w0, w1, (r - r0) / (r1 - r0));
        g += `<path d="M${f(ca * r + nx * w)} ${f(sa * r + ny * w)}L${f(ca * r - nx * w)} ${f(sa * r - ny * w)}" stroke="${B}" stroke-width="3"/>`;
      }
      g += `<circle cx="${f(ca * 205)}" cy="${f(sa * 205)}" r="15" fill="${PT.red}" stroke="${B}" stroke-width="2.5"/><circle cx="${f(ca * 205)}" cy="${f(sa * 205)}" r="6" fill="${PT.white}" stroke="${B}" stroke-width="1.5"/>`;
    } else {
      for (const r of [176, 200, 224]) g += `<circle cx="${f(ca * r)}" cy="${f(sa * r)}" r="3" fill="${PT.red}"/>`;
    }
    return g;
  };
  for (let k = 0; k < 8; k++) wh += spoke((k / 8) * TAU + PI / 8, 6, 5, 150, 250, PT.white, false);
  for (let k = 0; k < 8; k++) wh += spoke((k / 8) * TAU, 18, 13, 150, 250, PT.yel, true);
  // flame rays around the face
  let fl = '';
  defs += `<path id="${p}-fl" d="${leafPath(100, 0, 0, 80, 36, { sharp: 0.7, pk: 0.7, asym: 0.25, n: 5 })}" stroke="${B}" stroke-width="2.6"/>`;
  defs += `<path id="${p}-fw" d="${leafPath(100, 0, 0, 54, 20, { sharp: 0.7, pk: 0.7, n: 4 })}" fill="${PT.white}" stroke="${B}" stroke-width="2"/>`;
  for (let k = 0; k < 20; k++) {
    fl += `<use href="#${p}-fl" fill="${k % 2 ? PT.red : PT.yel}" transform="rotate(${k * 18 - 90})"/>`;
    fl += `<use href="#${p}-fw" transform="rotate(${k * 18 - 81})"/>`;
  }
  wh += fl;
  wh += `<circle r="110" fill="${B}"/>`;
  let hd = '';
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * TAU;
    hd += `M${f(Math.cos(a) * 107)} ${f(Math.sin(a) * 107)}h.1`;
  }
  wh += `<path d="${hd}" stroke="${PT.white}" stroke-width="3.6" stroke-linecap="round"/>`;
  wh += suryaFace(p);
  wh += `</g>`;
  s += wh;

  const body =
    `<g filter="url(#${p}-cv)"><g filter="url(#${p}-hw)">${s}${border.svg}</g>${fin.over}</g>`;
  return svgDoc(W, H, border.defs + fin.defs + defs, body);
};

/* ---------------- Pattachitra: Tree of Life ---------------- */
/** Pattachitra parrot facing right; origin at the feet. */
function pattaParrot(p) {
  const B = PT.black;
  let s = '';
  s += `<path d="M-6 6C-20 30-34 56-52 86L-44 88C-28 60-14 34 2 10Z" fill="${PT.indigo}" stroke="${B}" stroke-width="2.4"/>`;
  s += `<path d="M-2 8C-12 34-20 62-28 94L-20 94C-10 64-2 36 6 10Z" fill="${PT.green}" stroke="${B}" stroke-width="2.4"/>`;
  s += `<path d="M2-52C-22-44-30-8-12 14L6 12C22-6 24-36 16-50Z" fill="#4f9a3e" stroke="${B}" stroke-width="3"/>`;
  s += `<path d="M2-34C-14-24-18 0-8 16C2 4 8-16 6-34Z" fill="${PT.green}" stroke="${B}" stroke-width="2.4"/>`;
  s += `<path d="M-6-20l8 6M-8-8l9 6M-7 4l8 5" stroke="${PT.yel}" stroke-width="2" fill="none"/>`;
  s += `<circle cx="10" cy="-50" r="15" fill="#4f9a3e" stroke="${B}" stroke-width="3"/>`;
  s += `<path d="M22-56C36-58 40-42 30-36C30-42 26-46 21-44Z" fill="#d23a22" stroke="${B}" stroke-width="2.4"/>`;
  s += `<path d="M-2-40Q12-30 24-42" fill="none" stroke="${B}" stroke-width="4"/><path d="M-2-40Q12-30 24-42" fill="none" stroke="${PT.red}" stroke-width="1.6"/>`;
  s += `<circle cx="14" cy="-53" r="5" fill="${PT.white}" stroke="${B}" stroke-width="1.6"/><circle cx="15" cy="-53" r="2.2" fill="${B}"/>`;
  s += `<path d="M-2 12v8M6 12v8" stroke="${B}" stroke-width="3" stroke-linecap="round"/>`;
  return s;
}
/** Pattachitra peacock facing right; origin at the feet. */
function pattaPeacock(p) {
  const B = PT.black;
  let s = '';
  // long trailing tail with eye feathers
  s += `<path d="M-16-26C-70-40-150-30-196 8C-150 14-70 18-10 4Z" fill="${PT.green}" stroke="${B}" stroke-width="3"/>`;
  let fl = '', eyes = '';
  for (let k = 0; k < 7; k++) {
    const t = k / 6;
    const x = -40 - t * 140, y = -18 + t * 18 + (k % 2 ? -6 : 6);
    fl += `M-14-10L${f(x)} ${f(y)}`;
    eyes += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="11" ry="8" fill="${PT.yel}" stroke="${B}" stroke-width="2"/><ellipse cx="${f(x + 1)}" cy="${f(y)}" rx="6" ry="4.5" fill="${PT.indigo}"/><circle cx="${f(x + 2)}" cy="${f(y)}" r="2" fill="${PT.white}"/>`;
  }
  s += `<path d="${fl}" stroke="${B}" stroke-width="1.4" fill="none"/>` + eyes;
  // body and neck
  s += `<path d="M24-118C16-92 22-70 14-52C4-34-24-30-28-10C-30 8-8 16 10 12C34 6 44-14 40-40C36-62 34-90 38-112Z" fill="${PT.indigo}" stroke="${B}" stroke-width="3"/>`;
  s += `<path d="M10-46C-6-40-18-26-16-10C-4-14 8-22 18-36Z" fill="${PT.ochre}" stroke="${B}" stroke-width="2.4"/>`;
  s += `<path d="M-10-14l8-8M-4-8l8-9M2-2l8-9" stroke="${B}" stroke-width="1.4"/>`;
  let sc = '';
  for (let k = 0; k < 6; k++) sc += `M${30 - k * 1.2} ${-100 + k * 12}h.1`;
  s += `<path d="${sc}" stroke="${PT.white}" stroke-width="3.4" stroke-linecap="round"/>`;
  // head, crest, beak, eye
  s += `<circle cx="32" cy="-118" r="11" fill="${PT.indigo}" stroke="${B}" stroke-width="3"/>`;
  s += `<path d="M42-120L56-114L42-110Z" fill="${PT.yel}" stroke="${B}" stroke-width="2"/>`;
  s += `<path d="M30-120q6-4 10 0" stroke="${PT.white}" stroke-width="2.6" fill="none"/><circle cx="36" cy="-120" r="2" fill="${B}"/>`;
  s += `<path d="M28-128l-8-16M32-129l0-18M36-128l8-16" stroke="${B}" stroke-width="1.6"/>`;
  s += `<path d="M20-144h.1M32-147h.1M44-144h.1" stroke="${PT.yel}" stroke-width="6" stroke-linecap="round"/>`;
  // legs
  s += `<path d="M2 12l-4 26M14 10l2 28M-8 38h12M10 38h12" stroke="${B}" stroke-width="3" stroke-linecap="round"/>`;
  return s;
}
/** 8-petal rosette (cached as a symbol; defs collected in PT_DEFS). */
let PT_DEFS = '', PT_P = 'pt';
const PT_LIB = new Map();
function pattaRosette(cx, cy, r, pet = PT.white, mid = PT.yel) {
  const key = `${r}|${pet}|${mid}`;
  if (!PT_LIB.has(key)) {
    const id = `${PT_P}-ro${PT_LIB.size}`;
    PT_LIB.set(key, id);
    PT_DEFS += `<g id="${id}">${pattaRosetteRaw(0, 0, r, pet, mid)}</g>`;
  }
  return `<use href="#${PT_LIB.get(key)}" x="${f(cx)}" y="${f(cy)}"/>`;
}
function pattaRosetteRaw(cx, cy, r, pet, mid) {
  const B = PT.black;
  let s = '';
  for (let k = 0; k < 8; k++) s += `<ellipse cx="${f(cx)}" cy="${f(cy - r * 0.55)}" rx="${f(r * 0.27)}" ry="${f(r * 0.5)}" transform="rotate(${k * 45} ${f(cx)} ${f(cy)})" fill="${pet}" stroke="${B}" stroke-width="1.8"/>`;
  s += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r * 0.32)}" fill="${mid}" stroke="${B}" stroke-width="2"/><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r * 0.1)}" fill="${PT.red}"/>`;
  return s;
}

ART['tree-of-life-patta.svg'] = (rng) => {
  const W = 800, H = 1000, p = 'tl', B = PT.black;
  PT_DEFS = ''; PT_LIB.clear(); PT_P = p;
  const border = pattaBorder(p, W, H, [
    { k: 'dots', w: 12, tw: 12 }, { line: B, w: 3 }, { k: 'petal', w: 24, tw: 22 }, { line: B, w: 3 },
    { k: 'tri', w: 14, tw: 14 }, { line: PT.yel, w: 4 }, { line: B, w: 2 }, { k: 'flower', w: 34, tw: 38 }, { line: B, w: 3 },
  ]);
  const fin = pattaFinish(p, W, H);
  const [x0, y0, x1, y1] = border.inner;
  const C = W / 2;
  let s = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${PT.red}"/>`;
  let defs = '';

  // ground: row of hillocks
  let hills = '';
  const gy = y1 - 50;
  for (let x = x0 - 20, i = 0; x < x1 + 20; x += 46, i++) {
    hills += `<path d="M${x} ${y1}V${gy + 18}a23 23 0 0 1 46 0V${y1}Z" fill="${i % 2 ? PT.green : PT.indigo}" stroke="${B}" stroke-width="2.6"/>`;
    hills += `<path d="M${x + 8} ${gy + 22}a15 15 0 0 1 30 0" fill="none" stroke="${PT.white}" stroke-width="1.6"/>`;
  }
  s += hills;

  // half of the tree (mirrored), built from double-stroked branches
  let half = '';
  const branches = [
    // [startY, endX, endY, curlR, ctrlDX, ctrlDY]
    [700, 250, 640, 26, 60, -10],
    [612, 170, 520, 30, 90, 10],
    [520, 230, 410, 26, 70, -20],
    [430, 150, 320, 30, 100, 0],
    [340, 250, 240, 24, 60, -20],
    [262, 190, 170, 22, 80, -10],
  ];
  let bd = '', curls = [], leaves = '', fruits = '';
  for (const [sy, ex, ey, cr, cdx, cdy] of branches) {
    const sx = C - 6;
    const cx = (sx + ex) / 2 + cdx * 0.3, cy = Math.min(sy, ey) + cdy - 30;
    let d = `M${sx} ${sy}Q${f(cx)} ${f(cy)} ${ex} ${ey}`;
    // spiral curl at the end (inward, downward)
    const pts = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10, a = -PI / 2 - t * PI * 1.6, r = cr * (1 - t * 0.6);
      pts.push([ex + cr * 0 + Math.cos(a) * r - 0, ey + cr + Math.sin(a) * r]);
    }
    d += smoothPath(pts).replace(/^M[^C]+/, '');
    bd += d;
    curls.push([ex, ey + cr]);
    // leaves along the branch
    for (let k = 1; k <= 4; k++) {
      const t = k / 5;
      const bx = (1 - t) * (1 - t) * sx + 2 * t * (1 - t) * cx + t * t * ex;
      const by = (1 - t) * (1 - t) * sy + 2 * t * (1 - t) * cy + t * t * ey;
      const up = k % 2 === 0;
      const a = up ? -PI / 2 - 0.6 : PI / 2 + 0.3;
      leaves += `<path d="${leafPath(bx, by, a, 42, 20, { sharp: 0.8, n: 4 })}" fill="${k % 3 === 0 ? PT.yel : PT.green}" stroke="${B}" stroke-width="2.4"/>`;
      const [mx, my] = pol(bx, by, 32, a);
      leaves += `<path d="M${f(bx)} ${f(by)}L${f(mx)} ${f(my)}" stroke="${PT.white}" stroke-width="1.4"/>`;
    }
    fruits += `<circle cx="${f(ex + 18)}" cy="${f(ey - 26)}" r="9" fill="${PT.red}" stroke="${B}" stroke-width="2.4"/><circle cx="${f(ex + 15)}" cy="${f(ey - 29)}" r="2.4" fill="${PT.white}"/>`;
  }
  half += `<path d="${bd}" fill="none" stroke="${B}" stroke-width="15" stroke-linecap="round"/><path d="${bd}" fill="none" stroke="${PT.ochre}" stroke-width="9" stroke-linecap="round"/><path d="${bd}" fill="none" stroke="${PT.white}" stroke-width="1.2" stroke-dasharray="3 6"/>`;
  half += leaves + fruits;
  for (const [cx, cy] of curls) half += pattaRosette(cx, cy, 18, rng() < 0.5 ? PT.white : PT.yel, PT.red);
  // parrot on an upper branch, peacock beside the pot
  half += `<g transform="translate(266 302) scale(-1 1) scale(.95)">${pattaParrot(p)}</g>`;
  half += `<g transform="translate(298 ${gy + 8}) scale(.95)">${pattaPeacock(p)}</g>`;
  defs += `<g id="${p}-half">${half}</g>`;
  s += `<use href="#${p}-half"/><use href="#${p}-half" transform="matrix(-1 0 0 1 ${W} 0)"/>`;

  // trunk with chevrons
  const trunk = `M${C - 26} 760C${C - 18} 600 ${C - 22} 420 ${C - 10} 170L${C + 10} 170C${C + 22} 420 ${C + 18} 600 ${C + 26} 760Z`;
  s += `<path d="${trunk}" fill="${PT.ochre}" stroke="${B}" stroke-width="4"/>`;
  let chev = '';
  for (let y = 190; y < 750; y += 22) {
    const w = lerp(8, 22, (y - 170) / 590);
    chev += `M${f(C - w)} ${y + 8}L${C} ${y}L${f(C + w)} ${y + 8}`;
  }
  s += `<path d="${chev}" fill="none" stroke="${B}" stroke-width="2.4"/><path d="M${C} 180V750" stroke="${PT.white}" stroke-width="1.6" stroke-dasharray="2 9"/>`;
  // crowning lotus
  let crown = '';
  for (let k = 0; k < 7; k++) {
    const a = -PI / 2 + (k / 6 - 0.5) * 2.6;
    crown += `<path d="${leafPath(C, 172, a, 70, 30, { sharp: 0.8, n: 4 })}" fill="${k % 2 ? PT.white : PT.yel}" stroke="${B}" stroke-width="2.6"/>`;
  }
  s += crown + `<circle cx="${C}" cy="172" r="16" fill="${PT.red}" stroke="${B}" stroke-width="3"/><circle cx="${C}" cy="172" r="6" fill="${PT.yel}"/>`;
  // kalash pot at the base
  s += `<path d="M${C - 34} 742h68l-6 14c34 10 46 34 46 58c0 30-24 46-74 46s-74-16-74-46c0-24 12-48 46-58Z" fill="${PT.yel}" stroke="${B}" stroke-width="4"/>`;
  s += `<path d="M${C - 62} 806h124M${C - 66} 836h132" stroke="${B}" stroke-width="3"/>`;
  let tri = '';
  for (let k = 0; k < 10; k++) tri += `M${C - 60 + k * 12} 806l6 12l6-12`;
  s += `<path d="${tri}" fill="${PT.red}" stroke="${B}" stroke-width="1.6"/>`;
  s += pattaRosette(C, 782, 18, PT.white, PT.red);
  for (const a of [-2.4, -1.9, -1.25, -0.7]) s += `<path d="${leafPath(C, 742, a, 52, 20, { sharp: 0.8, n: 4 })}" fill="${PT.green}" stroke="${B}" stroke-width="2.4"/>`;
  s += `<path d="M${C - 34} 742h68" stroke="${B}" stroke-width="6"/>`;
  // sun and moon in the upper corners
  s += pattaRosette(x0 + 60, y0 + 60, 34, PT.yel, PT.red);
  s += `<circle cx="${x1 - 60}" cy="${y0 + 60}" r="30" fill="${PT.white}" stroke="${B}" stroke-width="3"/><circle cx="${x1 - 48}" cy="${y0 + 52}" r="26" fill="${PT.red}"/>`;
  s += dotFill(rng, x0 + 8, y0 + 8, x1 - 8, gy, 190, (x, y) => Math.abs(x - C) < 44 + (y > 700 ? 60 : 0) || (y < y0 + 104 && (x < x0 + 104 || x > x1 - 104)));

  const body = `<g filter="url(#${p}-cv)"><g filter="url(#${p}-hw)">${s}${border.svg}</g>${fin.over}</g>`;
  return svgDoc(W, H, border.defs + fin.defs + defs + PT_DEFS, body);
};

/* ---------------- Pattachitra: Matsya — The Divine Fish ---------------- */
ART['matsya-patta.svg'] = (rng) => {
  const W = 1000, H = 750, p = 'mt', B = PT.black;
  PT_DEFS = ''; PT_LIB.clear(); PT_P = p;
  const border = pattaBorder(p, W, H, [
    { k: 'dots', w: 12, tw: 12 }, { line: B, w: 3 }, { k: 'petal', w: 24, tw: 22 }, { line: B, w: 3 },
    { k: 'tri', w: 14, tw: 14 }, { line: PT.yel, w: 4 }, { line: B, w: 2 }, { k: 'flower', w: 34, tw: 38 }, { line: B, w: 3 },
  ]);
  const fin = pattaFinish(p, W, H);
  const [x0, y0, x1, y1] = border.inner;
  const WY = 520; // water line
  let defs = '';
  // scale pattern (two-tone rows of half discs facing the head)
  const scale = (cx, cy, fill) =>
    `<path d="M${cx} ${cy - 18}A18 18 0 0 0 ${cx} ${cy + 18}Z" fill="${fill}" stroke="${B}" stroke-width="2.4"/><path d="M${cx - 2} ${cy - 10}A10 10 0 0 0 ${cx - 2} ${cy + 10}" fill="none" stroke="${PT.white}" stroke-width="1.6"/><circle cx="${cx - 9}" cy="${cy}" r="2" fill="${B}"/>`;
  defs += `<pattern id="${p}-sc" patternUnits="userSpaceOnUse" width="26" height="36" patternTransform="translate(500 360)">` +
    scale(26, 0, PT.yel) + scale(26, 36, PT.yel) + scale(13, 18, PT.red) + scale(39, 18, PT.red) + `</pattern>`;
  // waves
  defs += `<pattern id="${p}-wv" patternUnits="userSpaceOnUse" width="64" height="34" patternTransform="translate(${x0} ${WY + 10})"><rect width="64" height="34" fill="${PT.indigo}"/>` +
    `<path d="M0 28C8 8 30 2 40 14C46 22 38 30 30 24M32 11C44 2 58 6 64 28" fill="none" stroke="${PT.white}" stroke-width="2.2" stroke-linecap="round"/>` +
    `<path d="M-32 11C-20 2-6 6 0 28" fill="none" stroke="${PT.white}" stroke-width="2.2"/></pattern>`;

  let s = `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${PT.red}"/>`;
  // scalloped canopy along the top
  let sc = '', tas = '';
  for (let x = x0, i = 0; x < x1; x += 40, i++) {
    sc += `M${x} ${y0}a20 22 0 0 0 40 0Z`;
    tas += `M${x + 20} ${y0 + 22}v10`;
  }
  s += `<path d="${sc}" fill="${PT.yel}" stroke="${B}" stroke-width="2.6"/><path d="${tas}" stroke="${B}" stroke-width="2"/>`;
  s += `<path d="${tas.replace(/v10/g, 'm0 14h.1')}" stroke="${PT.red}" stroke-width="9" stroke-linecap="round"/>`;
  s += `<path d="${tas.replace(/v10/g, 'm0 14h.1')}" stroke="${B}" stroke-width="2" stroke-linecap="round" fill="none"/>`;
  // water with stylised waves
  s += `<path d="M${x0} ${WY}C${x0 + 120} ${WY - 16} ${x0 + 240} ${WY + 14} 500 ${WY}S${x1 - 120} ${WY - 16} ${x1} ${WY}V${y1}H${x0}Z" fill="url(#${p}-wv)" stroke="${B}" stroke-width="4"/>`;
  // lotus clusters at the sides (side-view lotus)
  const lotus = (cx, cy, k) => {
    let g = `<path d="M${cx} ${cy + 30}Q${cx + 10 * k} ${cy + 90} ${cx + 4 * k} ${WY + 6}" stroke="${PT.green}" stroke-width="6" fill="none"/><path d="M${cx} ${cy + 30}Q${cx + 10 * k} ${cy + 90} ${cx + 4 * k} ${WY + 6}" stroke="${B}" stroke-width="1.4" fill="none"/>`;
    for (const [a, len, wid, col] of [[-PI / 2 - 0.9, 58, 30, PT.pink], [-PI / 2 + 0.9, 58, 30, PT.pink], [-PI / 2 - 0.45, 66, 32, PT.white], [-PI / 2 + 0.45, 66, 32, PT.white], [-PI / 2, 72, 36, PT.pink]]) {
      g += `<path d="${leafPath(cx, cy + 30, a, len, wid, { sharp: 0.8, n: 4 })}" fill="${col}" stroke="${B}" stroke-width="2.6"/>`;
      const [ex, ey] = pol(cx, cy + 30, len * 0.7, a);
      g += `<path d="M${cx} ${cy + 26}L${f(ex)} ${f(ey)}" stroke="${PT.red}" stroke-width="1.4"/>`;
    }
    g += `<ellipse cx="${cx + 54 * k}" cy="${WY - 4}" rx="58" ry="18" fill="${PT.green}" stroke="${B}" stroke-width="3"/><path d="M${cx + 54 * k} ${WY - 4}l${-40 * k} -6M${cx + 54 * k} ${WY - 4}l${40 * k} -4M${cx + 54 * k} ${WY - 4}l${-10 * k} 14" stroke="${PT.yel}" stroke-width="1.6"/>`;
    return g;
  };
  s += lotus(x0 + 52, 330, 1) + lotus(x1 - 52, 330, -1);
  s += pattaRosette(x0 + 70, y0 + 80, 24, PT.yel, PT.red) + pattaRosette(x1 - 70, y0 + 80, 24, PT.yel, PT.red);

  // ---- the fish (facing left)
  const fx = 492, fy = 334;
  let fish = `<g transform="translate(${fx} ${fy}) scale(.88)">`;
  const bodyD = smoothPath([[-300, 6], [-262, -62], [-170, -112], [-40, -120], [110, -92], [210, -42], [246, -6], [210, 34], [110, 80], [-40, 108], [-170, 100], [-262, 56]], true);
  // tail fin
  let tail = `<path d="M228-18L344-120Q318-6 344 118L228 18Z" fill="${PT.yel}" stroke="${B}" stroke-width="4"/>`;
  let rays = '';
  for (let k = -5; k <= 5; k++) rays += `M236 0L${f(338 - Math.abs(k) * 2)} ${f(k * 21)}`;
  tail += `<path d="${rays}" stroke="${B}" stroke-width="1.8"/>`;
  tail += `<path d="M246-30L320-100Q300-60 300-20ZM246 30L320 100Q300 60 300 20Z" fill="${PT.red}" stroke="${B}" stroke-width="2"/>`;
  // dorsal and lower fins
  let fins = `<path d="M-90-114Q-20-210 40-196Q120-160 150-86Z" fill="${PT.red}" stroke="${B}" stroke-width="4"/>`;
  let fr = '';
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    fr += `M${f(lerp(-80, 140, t))} ${f(lerp(-112, -88, t))}L${f(lerp(-50, 120, t))} ${f(-190 + Math.pow(t - 0.4, 2) * 300)}`;
  }
  fins += `<path d="${fr}" stroke="${PT.yel}" stroke-width="2.6"/>`;
  fins += `<path d="M30 100Q70 170 150 150Q140 110 130 76Z" fill="${PT.red}" stroke="${B}" stroke-width="3.6"/><path d="M50 104l40 40M76 98l46 44M100 90l34 46" stroke="${PT.yel}" stroke-width="2.2"/>`;
  fish += tail + fins;
  fish += `<path d="${bodyD}" fill="url(#${p}-sc)" stroke="${B}" stroke-width="5"/>`;
  // head plate with ornaments
  fish += `<clipPath id="${p}-bc"><path d="${bodyD}"/></clipPath>`;
  fish += `<g clip-path="url(#${p}-bc)"><path d="M-320-140H-170C-140-60-140 60-170 140H-320Z" fill="${PT.yel}" stroke="${B}" stroke-width="4"/>`;
  fish += `<path d="M-160-130C-128-60-128 60-160 130" fill="none" stroke="${B}" stroke-width="10"/><path d="M-160-130C-128-60-128 60-160 130" fill="none" stroke="${PT.white}" stroke-width="3" stroke-dasharray=".1 9" stroke-linecap="round"/>`;
  fish += `<path d="M-182-130C-150-60-150 60-182 130" fill="none" stroke="${PT.red}" stroke-width="5"/>`;
  // white belly band
  fish += `<path d="M-150 70C-60 112 80 96 230 30" fill="none" stroke="${PT.white}" stroke-width="16"/><path d="M-150 70C-60 112 80 96 230 30" fill="none" stroke="${B}" stroke-width="2" stroke-dasharray="6 6"/></g>`;
  // eye, mouth, crown, gill flourish
  fish += `<path d="M-268-30C-252-50-214-52-196-30C-214-12-252-12-268-30Z" fill="#fffaf0" stroke="${B}" stroke-width="3"/><circle cx="-232" cy="-31" r="11" fill="${B}"/><circle cx="-235" cy="-34" r="3" fill="#fff"/>`;
  fish += `<path d="M-196-30L-180-40M-200-26L-182-24" stroke="${B}" stroke-width="2.6" stroke-linecap="round"/><path d="M-270-50C-250-70-210-68-190-50" fill="none" stroke="${B}" stroke-width="4"/>`;
  fish += `<path d="M-300 6C-290 20-278 24-264 22" fill="none" stroke="${B}" stroke-width="3"/><path d="M-301 6q8-6 18-2" stroke="${PT.red}" stroke-width="4" fill="none"/>`;
  fish += `<path d="M-250-74L-244-118L-226-92L-212-128L-198-92L-180-118L-176-70Z" fill="${PT.yel}" stroke="${B}" stroke-width="3"/><circle cx="-212" cy="-96" r="5" fill="${PT.red}"/><path d="M-250-74Q-212-60-176-70" fill="none" stroke="${B}" stroke-width="3"/>`;
  fish += `<path d="${leafPath(-150, 40, 2.5, 70, 32, { sharp: 0.8, n: 4 })}" fill="${PT.yel}" stroke="${B}" stroke-width="3"/><path d="M-150 40l-40 24M-150 40l-48 14M-150 40l-30 32" stroke="${PT.red}" stroke-width="1.8"/>`;
  fish += `</g>`;
  s += fish;
  // small fish in the waves
  const minnow = (x, y, k, c) => `<g transform="translate(${x} ${y}) scale(${k})"><path d="M-30 0Q0-18 26 0Q0 18-30 0Z" fill="${c}" stroke="${B}" stroke-width="2.4"/><path d="M24 0l14-10v20Z" fill="${c}" stroke="${B}" stroke-width="2.4"/><circle cx="-18" cy="-2" r="3" fill="${B}"/><path d="M-8-8q4 8 0 16M2-8q4 8 0 16" stroke="${B}" stroke-width="1.6" fill="none"/></g>`;
  s += minnow(300, 600, 1, PT.yel) + minnow(700, 610, -1, PT.white) + minnow(850, 580, 0.8, PT.pink) + minnow(160, 585, -0.8, PT.white);
  // bubbles & filler dots
  let bub = '';
  for (const [bx, by, r] of [[200, 300, 7], [214, 278, 5], [226, 258, 3.5], [860, 230, 6], [850, 208, 4]]) bub += `<circle cx="${bx}" cy="${by}" r="${r}" fill="none" stroke="${PT.white}" stroke-width="2"/>`;
  s += bub;
  s += dotFill(rng, x0 + 8, y0 + 40, x1 - 8, WY - 14, 200, (x, y) => {
    const dx = (x - fx) / 360, dy = (y - fy) / 150;
    return dx * dx + dy * dy < 1.05 || Math.hypot(x - (x0 + 52), y - 340) < 80 || Math.hypot(x - (x1 - 52), y - 340) < 80 || Math.hypot(x - (x0 + 70), y - y0 - 80) < 34 || Math.hypot(x - (x1 - 70), y - y0 - 80) < 34 || (y > fy - 200 && y < fy - 60 && x > fx - 100 && x < fx + 160);
  });

  const body = `<g filter="url(#${p}-cv)"><g filter="url(#${p}-hw)">${s}${border.svg}</g>${fin.over}</g>`;
  return svgDoc(W, H, border.defs + fin.defs + defs + PT_DEFS, body);
};

/* ------------------------------------------------------------------ */
/* Madhubani toolkit                                                    */
/* ------------------------------------------------------------------ */
const MB = {
  paper: '#f1e3c2', ink: '#1d1611', red: '#d6402a', yel: '#f0b328', green: '#4f8a3a',
  indigo: '#2c427f', pink: '#e0607e', orange: '#ec7d2a', teal: '#2f8a86',
};
/** Line-work patterns (black ink) used to fill shapes. */
function mbPatterns(p) {
  const pat = (id, w, h, inner, tr = '') => `<pattern id="${p}-${id}" patternUnits="userSpaceOnUse" width="${w}" height="${h}"${tr ? ` patternTransform="${tr}"` : ''}>${inner}</pattern>`;
  const I = MB.ink;
  return (
    pat('h1', 7, 7, `<path d="M0 0V7" stroke="${I}" stroke-width="1.5"/>`, 'rotate(45)') +
    pat('h2', 7, 7, `<path d="M0 0V7" stroke="${I}" stroke-width="1.5"/>`, 'rotate(-45)') +
    pat('hx', 8, 8, `<path d="M0 0V8M0 0H8" stroke="${I}" stroke-width="1.3"/>`, 'rotate(45)') +
    pat('hv', 6, 10, `<path d="M0 0V10" stroke="${I}" stroke-width="1.5"/>`) +
    pat('dt', 10, 10, `<circle cx="5" cy="5" r="1.7" fill="${I}"/>`) +
    pat('dt2', 12, 12, `<circle cx="3" cy="3" r="1.6" fill="${I}"/><circle cx="9" cy="9" r="1.6" fill="${I}"/>`) +
    pat('sc', 16, 12, `<path d="M0 12A8 8 0 0 1 16 12M-8 6A8 8 0 0 1 8 6M8 6A8 8 0 0 1 24 6" fill="none" stroke="${I}" stroke-width="1.4"/>`) +
    pat('zz', 12, 10, `<path d="M0 8L3 2L6 8L9 2L12 8" fill="none" stroke="${I}" stroke-width="1.4"/>`) +
    pat('cc', 14, 14, `<circle cx="7" cy="7" r="3.4" fill="none" stroke="${I}" stroke-width="1.3"/>`)
  );
}
/** Shape with colour fill, optional line-work overlay and double ink outline. */
let MB_ID = 0;
let MB_LIB = new Map();
let MB_DEFS = '';
let MB_CSS = new Map();
let MB_P = 'mb';
function mbReset(p) { MB_P = p; MB_ID = 0; MB_LIB = new Map(); MB_DEFS = ''; MB_CSS = new Map(); }
/** Class name for a fill:none stroke style (keeps repeated outlines compact). */
function mbCls(stroke, w) {
  const k = `${stroke}|${w}`;
  if (!MB_CSS.has(k)) MB_CSS.set(k, `${MB_P}-c${MB_CSS.size.toString(36)}`);
  return MB_CSS.get(k);
}
function mbStyle() {
  let css = '';
  for (const [k, c] of MB_CSS) { const [st, w] = k.split('|'); css += `.${c}{fill:none;stroke:${st};stroke-width:${w}}`; }
  return `<style>${css}</style>`;
}
/** Cache a motif drawn at the origin; returns a <use> placing it. */
function mbUse(key, build, tr) {
  if (!MB_LIB.has(key)) {
    const id = `${MB_P}-y${MB_LIB.size.toString(36)}`;
    MB_LIB.set(key, id);
    const inner = build();
    MB_DEFS += `<g id="${id}">${inner}</g>`;
  }
  return `<use href="#${MB_LIB.get(key)}" transform="${tr}"/>`;
}
function mbShape(p, d, fill, pat, gap = MB.paper, w = 7) {
  const id = `${p}${(MB_ID++).toString(36)}`;
  MB_DEFS += `<path id="${id}" d="${d}"/>`;
  let s = `<use href="#${id}" fill="${fill}"/>`;
  if (pat) s += `<use href="#${id}" fill="url(#${p}-${pat})"/>`;
  s += `<use href="#${id}" class="${mbCls(MB.ink, w)}"/><use href="#${id}" class="${mbCls(gap, f(w - 3.2))}"/>`;
  return s;
}
/** Double-line stroke (for lines that are not closed shapes). */
function mbLine(d, gap = MB.paper, w = 7) {
  const id = `${MB_P}-l${(MB_ID++).toString(36)}`;
  MB_DEFS += `<path id="${id}" d="${d}"/>`;
  return `<g fill="none" stroke-linecap="round"><use href="#${id}" stroke="${MB.ink}" stroke-width="${w}"/><use href="#${id}" stroke="${gap}" stroke-width="${f(w - 3.2)}"/></g>`;
}
/** Madhubani flower: ring of petals around a hatched centre. */
function mbFlower(p, cx, cy, r, n, petal, centre, pat = 'hv') {
  return mbUse(`fl${r}|${n}|${petal}|${centre}|${pat}`, () => mbFlowerRaw(p, 0, 0, r, n, petal, centre, pat), `translate(${f(cx)} ${f(cy)})`);
}
function mbFlowerRaw(p, cx, cy, r, n, petal, centre, pat) {
  let s = '';
  for (let k = 0; k < n; k++) {
    const a = (k / n) * TAU - PI / 2;
    s += mbShape(p, leafPath(cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3, a, r * 0.75, r * 0.5, { sharp: 0.7, n: 4 }), petal, k % 2 ? pat : null, MB.paper, 5);
  }
  s += mbShape(p, `M${f(cx - r * 0.34)} ${f(cy)}a${f(r * 0.34)} ${f(r * 0.34)} 0 1 0 ${f(r * 0.68)} 0a${f(r * 0.34)} ${f(r * 0.34)} 0 1 0 ${f(-r * 0.68)} 0Z`, centre, 'dt', MB.paper, 5);
  return s;
}
/** Paper and ink finish for Madhubani works. */
function mbFinish(p, W, H) {
  const defs =
    FX.wobble(`${p}-hw`, 0.03, 2.6, 5, 2, W, H) +
    FX.paper(`${p}-pp`, 0.03, 2.4, 7) +
    FX.speckle(`${p}-sp`, '#6a4a22', 0.5, 1.6, -0.86, 19) +
    `<filter id="${p}-fb" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.2" numOctaves="2" seed="5"/><feColorMatrix values="0 0 0 0 .55 0 0 0 0 .4 0 0 0 0 .2 1.4 0 0 0 -.62"/></filter>`;
  const over =
    `<rect width="${W}" height="${H}" filter="url(#${p}-pp)" style="mix-blend-mode:multiply" opacity=".6"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-fb)" opacity=".25"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-sp)" opacity=".5"/>`;
  return { defs, over };
}
/** Border: double lines and a band of alternating motifs. */
function mbBorder(p, W, H, m = 18, bw = 46, kind = 'leaf') {
  let s = '';
  const rectD = (o) => `M${o} ${o}H${W - o}V${H - o}H${o}Z`;
  s += `<path d="${rectD(m)}" fill="none" stroke="${MB.ink}" stroke-width="4"/>`;
  s += `<path d="${rectD(m + 8)}" fill="none" stroke="${MB.ink}" stroke-width="2.4"/>`;
  s += `<path d="${rectD(m + bw)}" fill="none" stroke="${MB.ink}" stroke-width="2.4"/>`;
  s += `<path d="${rectD(m + bw + 8)}" fill="none" stroke="${MB.ink}" stroke-width="4"/>`;
  const c0 = m + 8, c1 = m + bw;
  const mid = (c0 + c1) / 2, bh = c1 - c0;
  const side = (x0, y0, x1, y1, horiz) => {
    const len = horiz ? x1 - x0 : y1 - y0;
    const n = Math.max(2, Math.round(len / (bh * 0.9)));
    const step = len / n;
    let g = '';
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) * step;
      const x = horiz ? x0 + t : x0, y = horiz ? y0 : y0 + t;
      const along = horiz ? 0 : PI / 2;
      if (kind === 'leaf') {
        const a = along + (i % 2 ? 0.6 : -0.6);
        const col = i % 2 ? MB.green : MB.red;
        g += mbUse(`bl${bh}|${col}`, () => mbShape(p, leafPath(-bh * 0.38, 0, 0, bh * 0.76, bh * 0.36, { sharp: 0.7, n: 4 }), col, i % 2 ? null : 'h1', MB.paper, 4.4), `translate(${f(x)} ${f(y)}) rotate(${f((a * 180) / PI)})`);
      } else {
        g += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(bh * 0.3)}" fill="${i % 2 ? MB.yel : MB.red}" stroke="${MB.ink}" stroke-width="2.4"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(bh * 0.1)}" fill="${MB.ink}"/>`;
        const hx = horiz ? step / 2 : 0, hy = horiz ? 0 : step / 2;
        g += `<path d="M${f(x + hx - (horiz ? 0 : bh * 0.35))} ${f(y + hy - (horiz ? bh * 0.35 : 0))}l${horiz ? 0 : f(bh * 0.7)} ${horiz ? f(bh * 0.7) : 0}" stroke="${MB.ink}" stroke-width="2"/>`;
      }
    }
    return g;
  };
  s += `<g>${side(c1, mid, W - c1, mid, true)}${side(c1, H - mid, W - c1, H - mid, true)}${side(mid, c1, mid, H - c1, false)}${side(W - mid, c1, W - mid, H - c1, false)}</g>`;
  for (const [x, y] of [[mid, mid], [W - mid, mid], [mid, H - mid], [W - mid, H - mid]]) s += mbFlower(p, x, y, bh * 0.62, 8, MB.yel, MB.red);
  return { svg: s, inner: m + bw + 10 };
}

/* ---------------- Madhubani: Fish Pair ---------------- */
ART['madhubani-fish-pair.svg'] = (rng) => {
  const W = 900, H = 900, p = 'mf', C = 450;
  mbReset(p);
  const fin = mbFinish(p, W, H);
  const border = mbBorder(p, W, H, 18, 50, 'leaf');
  const I0 = border.inner;
  let s = `<rect width="${W}" height="${H}" fill="${MB.paper}"/>`;

  // fish built along a circular spine (two fish chasing head-to-tail)
  const R = 205, MW = 150;
  const fish = (th0, colors, k) => {
    const span = PI * 0.8;
    const ang = (u) => th0 + u * span;
    const spine = (u) => { const a = ang(u); return [C + Math.cos(a) * R, C + Math.sin(a) * R, a]; };
    const wid = (u) => Math.pow(Math.sin(PI * (0.1 + 0.86 * Math.min(1, u)) ** 0.8), 0.9) * MW / 2;
    const edge = (u, side) => { const [x, y, a] = spine(u); const w = wid(u); return [x + Math.cos(a) * w * side, y + Math.sin(a) * w * side]; };
    const P = (a, r) => [C + Math.cos(a) * r, C + Math.sin(a) * r];
    // outline
    const A = [], Bk = [];
    for (let i = 0; i <= 16; i++) { const u = (i / 16) * 0.98; A.push(edge(u, 1)); Bk.push(edge(u, -1)); }
    const bodyD = smoothPath([spine(-0.04)].concat(A, Bk.reverse()).map((q) => [q[0], q[1]]), true);
    let g = '';
    // tail fin
    const [tx, ty, ta] = spine(0.98);
    const tdir = ta + PI / 2;
    const T = (along, across) => [tx + Math.cos(tdir) * along + Math.cos(ta) * across, ty + Math.sin(tdir) * along + Math.sin(ta) * across];
    const tailD = `M${nums(T(-10, 16))}C${nums(T(30, 34))} ${nums(T(60, 76))} ${nums(T(96, 84))}C${nums(T(78, 40))} ${nums(T(66, 12))} ${nums(T(58, 0))}C${nums(T(66, -12))} ${nums(T(78, -40))} ${nums(T(96, -84))}C${nums(T(60, -76))} ${nums(T(30, -34))} ${nums(T(-10, -16))}Z`;
    g += mbShape(p, tailD, colors[3], 'hv');
    // fins
    const finD = (u0, u1, side, h) => {
      const a = edge(u0, side), b = edge(u1, side);
      const um = (u0 * 0.35 + u1 * 0.65);
      const [mx, my, ma] = spine(um);
      const pk = [mx + Math.cos(ma) * side * (wid(um) + h), my + Math.sin(ma) * side * (wid(um) + h)];
      const [m2x, m2y, m2a] = spine(u0);
      return `M${nums(a)}C${nums([m2x + Math.cos(m2a) * side * (wid(u0) + h * 0.8), m2y + Math.sin(m2a) * side * (wid(u0) + h * 0.8)])} ${nums(pk)} ${nums(pk)}Q${nums([(pk[0] + b[0]) / 2, (pk[1] + b[1]) / 2])} ${nums(b)}Z`;
    };
    g += mbShape(p, finD(0.3, 0.6, 1, 54), colors[3], 'h2');
    g += mbShape(p, finD(0.48, 0.68, -1, 36), colors[3], 'h1');
    // body: base colour, then pattern sectors clipped to the outline
    const cid = `${p}-fc${k}`;
    g += `<clipPath id="${cid}"><path d="${bodyD}"/></clipPath>`;
    const cuts = [-0.1, 0.24, 0.43, 0.6, 0.76, 1.05];
    const fills = [[colors[0], null], [colors[1], 'sc'], [colors[2], 'hx'], [colors[0], 'dt'], [colors[1], 'zz']];
    const Ro = R + 120, Ri = R - 120;
    const bul = 0.07;
    let secs = '';
    for (let i = 0; i < cuts.length - 1; i++) {
      const a0 = ang(cuts[i]), a1 = ang(cuts[i + 1]);
      const b0 = i === 1 ? bul : 0, b1 = i === 0 ? bul : 0;
      const d = `M${nums(P(a0, Ro))}A${Ro} ${Ro} 0 0 1 ${nums(P(a1, Ro))}Q${nums(P(a1 + b1, R))} ${nums(P(a1, Ri))}A${Ri} ${Ri} 0 0 0 ${nums(P(a0, Ri))}Q${nums(P(a0 + b0, R))} ${nums(P(a0, Ro))}Z`;
      secs += `<path d="${d}" fill="${fills[i][0]}"/>` + (fills[i][1] ? `<path d="${d}" fill="url(#${p}-${fills[i][1]})"/>` : '');
    }
    let cl = '';
    for (const [i, u] of cuts.slice(1, -1).entries()) {
      const a = ang(u);
      cl += i === 0 ? `M${nums(P(a, Ro))}Q${nums(P(a + bul, R))} ${nums(P(a, Ri))}` : `M${nums(P(a, Ro))}L${nums(P(a, Ri))}`;
    }
    secs += `<path d="${cl}" fill="none" stroke="${MB.ink}" stroke-width="13"/><path d="${cl}" fill="none" stroke="${MB.yel}" stroke-width="6.6"/><path d="${cl}" fill="none" stroke="${MB.ink}" stroke-width="2.2" stroke-dasharray=".1 7" stroke-linecap="round"/>`;
    g += `<g clip-path="url(#${cid})">${secs}</g>`;
    {
      const a1 = ang(0.24), a2 = ang(0.19);
      const gd = `M${nums(P(a1, Ro))}Q${nums(P(a1 + bul, R))} ${nums(P(a1, Ri))}L${nums(P(a2, Ri))}Q${nums(P(a2 + bul, R))} ${nums(P(a2, Ro))}Z`;
      g += `<g clip-path="url(#${cid})"><path d="${gd}" fill="url(#${p}-h1)"/><path d="${gd}" fill="none" stroke="${MB.ink}" stroke-width="3"/></g>`;
    }
    g += mbLine(bodyD, MB.paper, 8);
    // head: eye with lashes, lips
    const [hx, hy, ha] = spine(0.1);
    const ex = hx + Math.cos(ha) * 10, ey = hy + Math.sin(ha) * 10;
    g += `<circle cx="${f(ex)}" cy="${f(ey)}" r="24" fill="${MB.paper}" stroke="${MB.ink}" stroke-width="4"/><circle cx="${f(ex)}" cy="${f(ey)}" r="13" fill="${MB.ink}"/><circle cx="${f(ex - 4)}" cy="${f(ey - 4)}" r="3.5" fill="${MB.paper}"/>`;
    let lashes = '';
    for (let j = 0; j < 7; j++) {
      const a = ha - PI * 0.35 + (j / 6) * PI * 0.7;
      lashes += `M${f(ex + Math.cos(a) * 26)} ${f(ey + Math.sin(a) * 26)}l${f(Math.cos(a) * 9)} ${f(Math.sin(a) * 9)}`;
    }
    g += `<path d="${lashes}" stroke="${MB.ink}" stroke-width="2.4"/>`;
    const [mx, my, ma] = spine(-0.03);
    const tng = ma - PI / 2;
    g += `<path d="M${f(mx + Math.cos(ma) * 10)} ${f(my + Math.sin(ma) * 10)}q${f(Math.cos(tng) * 14)} ${f(Math.sin(tng) * 14)} ${f(-Math.cos(ma) * 20)} ${f(-Math.sin(ma) * 20)}" fill="${MB.red}" stroke="${MB.ink}" stroke-width="2.6"/>`;
    return g;
  };
  // central lotus
  s += mbFlower(p, C, C, 92, 10, MB.pink, MB.yel, 'h1');
  s += mbFlower(p, C, C, 46, 8, MB.yel, MB.red, 'hv');
  s += fish(PI * 1.04, [MB.red, MB.yel, MB.green, MB.indigo], 0);
  s += fish(PI * 2.04, [MB.indigo, MB.yel, MB.red, MB.green], 1);
  // corner fillers: lotus buds with leaves, small fishes, sun
  const bud = (x, y, a) => {
    let g = mbLine(`M${f(x)} ${f(y)}q${f(Math.cos(a + 0.4) * 50)} ${f(Math.sin(a + 0.4) * 50)} ${f(Math.cos(a) * 90)} ${f(Math.sin(a) * 90)}`, MB.green, 7);
    const [bx, by] = [x + Math.cos(a) * 90, y + Math.sin(a) * 90];
    g += mbShape(p, leafPath(bx, by, a, 60, 40, { sharp: 0.7, n: 4 }), MB.pink, 'h2', MB.paper, 6);
    g += mbShape(p, leafPath(x + Math.cos(a) * 40, y + Math.sin(a) * 40, a + 1.2, 54, 26, { sharp: 0.8, n: 4 }), MB.green, 'hv', MB.paper, 5);
    return g;
  };
  const q = I0 + 20;
  s += bud(q, q + 30, -0.2) + bud(W - q, q + 30, PI + 0.2) + bud(q, H - q - 30, 0.2) + bud(W - q, H - q - 30, PI - 0.2);
  s += mbFlower(p, q + 40, q + 120, 30, 8, MB.yel, MB.red);
  s += mbFlower(p, W - q - 40, H - q - 120, 30, 8, MB.yel, MB.red);
  s += mbFlower(p, W - q - 40, q + 120, 26, 6, MB.orange, MB.indigo);
  s += mbFlower(p, q + 40, H - q - 120, 26, 6, MB.orange, MB.indigo);
  const leafB = (col) => () => mbShape(p, leafPath(-11, 0, 0, 22, 12, { sharp: 0.8, n: 3 }), col, null, MB.paper, 3.6);
  // small flowers and sprigs filling the gaps
  const spots = [];
  for (let t = 0; t < 400 && spots.length < 18; t++) {
    const x = rng.range(I0 + 30, W - I0 - 30), y = rng.range(I0 + 30, H - I0 - 30);
    if (Math.hypot(x - C, y - C) < 350) continue;
    if (Math.min(Math.hypot(x - q, y - q), Math.hypot(x - W + q, y - q), Math.hypot(x - q, y - H + q), Math.hypot(x - W + q, y - H + q)) < 140) continue;
    if (spots.some(([a, b]) => Math.hypot(a - x, b - y) < 70)) continue;
    spots.push([x, y]);
  }
  spots.forEach(([x, y], i) => {
    if (i % 3 === 2) {
      const a = rng.range(0, TAU);
      s += mbLine(`M${f(x - Math.cos(a) * 26)} ${f(y - Math.sin(a) * 26)}Q${f(x + Math.sin(a) * 10)} ${f(y - Math.cos(a) * 10)} ${f(x + Math.cos(a) * 26)} ${f(y + Math.sin(a) * 26)}`, MB.green, 5);
      s += mbUse(`rl${MB.green}`, leafB(MB.green), `translate(${f(x)} ${f(y)}) rotate(${f((a * 180) / PI - 60)})`);
      s += mbUse(`rl${MB.red}`, leafB(MB.red), `translate(${f(x)} ${f(y)}) rotate(${f((a * 180) / PI + 120)})`);
    } else s += mbFlower(p, x, y, 18, 6, i % 2 ? MB.yel : MB.pink, i % 2 ? MB.red : MB.indigo, 'hv');
  });
  // tiny dot clusters to leave no empty space
  let dots = '';
  for (let k = 0; k < 220; k++) {
    const x = rng.range(I0 + 6, W - I0 - 6), y = rng.range(I0 + 6, H - I0 - 6);
    const r = Math.hypot(x - C, y - C);
    if (r < 330) continue;
    dots += `M${f(x)} ${f(y)}h.1`;
  }
  s += `<path d="${dots}" stroke="${MB.ink}" stroke-width="4" stroke-linecap="round"/>`;
  // ring of leaves around the fish circle
  for (let k = 0; k < 28; k++) {
    const a = (k / 28) * TAU;
    const [x, y] = pol(C, C, 322, a);
    const col = k % 2 ? MB.green : MB.red;
    s += mbUse(`rl${col}`, leafB(col), `translate(${f(x)} ${f(y)}) rotate(${f(((a + PI / 2 + (k % 2 ? 0.4 : -0.4)) * 180) / PI)})`);
  }
  s += border.svg;
  const body = `<g filter="url(#${p}-hw)">${s}</g>${fin.over}`;
  return svgDoc(W, H, mbStyle() + mbPatterns(p) + fin.defs + MB_DEFS, body);
};

/* ---------------- Madhubani: Mayur — Dancing Peacock ---------------- */
ART['madhubani-peacock.svg'] = (rng) => {
  const W = 800, H = 1000, p = 'mp';
  mbReset(p);
  const fin = mbFinish(p, W, H);
  const border = mbBorder(p, W, H, 18, 46, 'leaf');
  const I0 = border.inner;
  let s = `<rect width="${W}" height="${H}" fill="${MB.paper}"/>`;
  // ---- tail fan
  const FX0 = 438, FY0 = 612, FR = 296;
  const nF = 13;
  const feathers = [];
  for (let k = 0; k < nF; k++) feathers.push(PI * 1.03 + (k / (nF - 1)) * PI * 0.97);
  // order: outer-left to right, draw back ones first
  let tail = '';
  feathers.forEach((a, k) => {
    const col = [MB.green, MB.teal, MB.green][k % 3];
    tail += mbShape(p, leafPath(FX0, FY0, a, FR, 86, { sharp: 0.6, pk: 1.3, n: 6 }), col, k % 2 ? 'h1' : 'h2', MB.paper, 6);
    // central quill
    const [qx, qy] = pol(FX0, FY0, FR * 0.74, a);
    tail += `<path d="M${FX0} ${FY0}L${f(qx)} ${f(qy)}" stroke="${MB.ink}" stroke-width="2.4"/>`;
  });
  // eyes near the tips
  feathers.forEach((a, k) => {
    const [ex, ey] = pol(FX0, FY0, FR * 0.8, a);
    const rot = (a * 180) / PI;
    tail += mbUse('eye', () =>
      mbShape(p, 'M-30 0a30 22 0 1 0 60 0a30 22 0 1 0-60 0Z', MB.yel, 'hv', MB.paper, 5) +
      mbShape(p, 'M-19 0a19 14 0 1 0 38 0a19 14 0 1 0-38 0Z', MB.teal, null, MB.paper, 4) +
      `<ellipse rx="10" ry="8" fill="${MB.indigo}" stroke="${MB.ink}" stroke-width="2.4"/><circle r="3.4" fill="${MB.ink}"/>`, `translate(${f(ex)} ${f(ey)}) rotate(${f(rot)})`);
  });
  // ring of dots along the fan edge
  let fd = '';
  for (let k = 0; k <= 60; k++) {
    const a = PI * 1.0 + (k / 60) * PI * 1.0;
    const [x, y] = pol(FX0, FY0, FR + 18, a);
    fd += `M${f(x)} ${f(y)}h.1`;
  }
  tail += `<path d="${fd}" stroke="${MB.red}" stroke-width="8" stroke-linecap="round"/><path d="${fd}" stroke="${MB.ink}" stroke-width="2.6" stroke-linecap="round" transform="translate(0 0)"/>`;
  s += tail;
  // trailing lower tail feathers sweeping down-right
  for (let k = 0; k < 4; k++) {
    const a = 0.05 + k * 0.16;
    s += mbShape(p, leafPath(FX0, FY0 + 40, a + 0.35, 170, 38, { sharp: 0.7, n: 5 }), k % 2 ? MB.green : MB.teal, 'hv', MB.paper, 5);
  }
  // ---- body, neck, head
  const bodyD = 'M392 520C360 548 340 600 344 660C348 740 404 780 470 770C540 758 572 700 556 640C540 590 470 584 438 556C418 538 410 520 410 500Z';
  s += mbShape(p, bodyD, MB.indigo, 'sc', MB.paper, 8);
  const neckD = 'M392 524C384 470 352 440 330 404C318 384 316 364 330 352C346 340 368 350 372 368C380 402 410 440 416 500Z';
  s += mbShape(p, neckD, MB.indigo, 'dt', MB.paper, 7);
  s += mbShape(p, 'M360 380C380 420 402 456 412 500C408 470 392 430 372 400Z', MB.teal, null, MB.paper, 4);
  // wing
  s += mbShape(p, 'M430 600C470 590 530 610 552 660C556 700 530 736 490 742C510 700 490 640 430 600Z', MB.green, 'hx', MB.paper, 6);
  s += mbShape(p, 'M450 620C484 626 516 650 530 690C500 670 476 650 450 620Z', MB.yel, 'h1', MB.paper, 4);
  // head
  s += mbShape(p, 'M314 360C312 336 332 322 350 328C366 334 372 352 366 366C356 380 330 382 314 360Z', MB.indigo, null, MB.paper, 6);
  s += mbShape(p, 'M316 350L282 360L316 366Z', MB.yel, null, MB.paper, 4);
  s += `<path d="M322 345C330 336 346 336 352 346C346 354 330 356 322 345Z" fill="${MB.paper}" stroke="${MB.ink}" stroke-width="2.6"/><circle cx="337" cy="345" r="5" fill="${MB.ink}"/>`;
  s += `<path d="M352 346l12 4M322 352l-4 6" stroke="${MB.ink}" stroke-width="2.4" stroke-linecap="round"/>`;
  // crest
  let crest = '';
  for (const [dx, dy] of [[-14, -46], [-2, -52], [12, -48], [22, -40]]) crest += `M346 330l${dx} ${dy}`;
  s += `<path d="${crest}" stroke="${MB.ink}" stroke-width="2.6"/>`;
  for (const [dx, dy] of [[-14, -46], [-2, -52], [12, -48], [22, -40]]) s += `<ellipse cx="${346 + dx}" cy="${330 + dy}" rx="6" ry="9" fill="${MB.red}" stroke="${MB.ink}" stroke-width="2.4"/>`;
  // legs
  s += mbLine('M440 768L432 850M432 850l-24 10M432 850l-6 18M432 850l18 10', MB.orange, 7);
  s += mbLine('M486 768L494 846M494 846l-22 12M494 846l2 18M494 846l22 8', MB.orange, 7);
  // ground: plants and grass
  const GY = 880;
  s += mbLine(`M${I0 + 10} ${GY}Q${W / 2} ${GY - 20} ${W - I0 - 10} ${GY}`, MB.green, 7);
  for (let k = 0; k < 9; k++) {
    const x = I0 + 30 + k * ((W - 2 * I0 - 60) / 8);
    const y = GY - 4 - Math.sin((k / 8) * PI) * 16;
    for (const da of [-0.5, 0, 0.5]) s += mbUse(`gl${da}`, () => mbShape(p, leafPath(0, 0, -PI / 2 + da, 46, 16, { sharp: 0.8, n: 4 }), MB.green, da ? null : 'hv', MB.paper, 4), `translate(${f(x)} ${f(y)})`);
  }
  // flowers and fillers around
  s += mbFlower(p, I0 + 70, I0 + 80, 48, 10, MB.red, MB.yel, 'h1');
  s += mbFlower(p, W - I0 - 70, I0 + 80, 44, 8, MB.pink, MB.yel, 'hv');
  s += mbFlower(p, I0 + 50, I0 + 200, 24, 6, MB.yel, MB.indigo, 'hv');
  s += mbFlower(p, W - I0 - 50, I0 + 200, 24, 6, MB.yel, MB.red, 'hv');
  s += mbFlower(p, I0 + 60, 640, 34, 8, MB.yel, MB.red, 'hv');
  s += mbFlower(p, W - I0 - 54, 800, 30, 6, MB.pink, MB.indigo, 'h2');
  s += mbFlower(p, I0 + 70, 800, 26, 6, MB.orange, MB.green, 'hv');
  // Madhubani sun with a face at the top
  const SX = W / 2, SY = 178;
  let rays = '';
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU;
    const [ax, ay] = pol(SX, SY, 52, a - 0.17), [bx, by] = pol(SX, SY, 52, a + 0.17), [tx, ty] = pol(SX, SY, 86, a);
    rays += mbShape(p, `M${f(ax)} ${f(ay)}L${f(tx)} ${f(ty)}L${f(bx)} ${f(by)}Z`, k % 2 ? MB.red : MB.orange, k % 2 ? 'h1' : null, MB.paper, 4.4);
  }
  s += rays + mbShape(p, `M${SX - 54} ${SY}a54 54 0 1 0 108 0a54 54 0 1 0-108 0Z`, MB.yel, null, MB.paper, 7);
  s += `<path d="M${SX - 30} ${SY - 8}q12-12 24 0q-12 8-24 0ZM${SX + 6} ${SY - 8}q12-12 24 0q-12 8-24 0Z" fill="${MB.paper}" stroke="${MB.ink}" stroke-width="2.6"/><circle cx="${SX - 18}" cy="${SY - 9}" r="4" fill="${MB.ink}"/><circle cx="${SX + 18}" cy="${SY - 9}" r="4" fill="${MB.ink}"/>`;
  s += `<path d="M${SX} ${SY - 4}v18l-6 4M${SX - 34} ${SY - 20}q16-10 30-2M${SX + 4} ${SY - 22}q16-8 30 2" fill="none" stroke="${MB.ink}" stroke-width="2.6" stroke-linecap="round"/><path d="M${SX - 14} ${SY + 28}q14 10 28 0q-14-6-28 0Z" fill="${MB.red}" stroke="${MB.ink}" stroke-width="2.4"/>`;
  let dots = '';
  for (let k = 0; k < 200; k++) {
    const x = rng.range(I0 + 6, W - I0 - 6), y = rng.range(I0 + 6, GY - 20);
    const r = Math.hypot(x - FX0, y - FY0);
    if (r < FR + 40 && y < FY0 + 60) continue;
    if (x > 300 && x < 600 && y > 300) continue;
    if (Math.hypot(x - SX, y - SY) < 100) continue;
    dots += `M${f(x)} ${f(y)}h.1`;
  }
  s += `<path d="${dots}" stroke="${MB.ink}" stroke-width="4" stroke-linecap="round"/>`;
  s += border.svg;
  const body = `<g filter="url(#${p}-hw)">${s}</g>${fin.over}`;
  return svgDoc(W, H, mbStyle() + mbPatterns(p) + fin.defs + MB_DEFS, body);
};

/* ------------------------------------------------------------------ */
/* Warli toolkit                                                        */
/* ------------------------------------------------------------------ */
const WL = { bg: '#8c3a20', paint: '#f3ece0' };
/** Mud-plastered wall background + rice-paste paint texture filters. */
function warliBase(p, W, H, seed = 3) {
  const defs =
    `<filter id="${p}-mud" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><feTurbulence type="fractalNoise" baseFrequency="0.006 0.012" numOctaves="4" seed="${seed}"/><feColorMatrix values="0 0 0 0 .32 0 0 0 0 .1 0 0 0 0 .04 1.3 0 0 0 -.45"/></filter>` +
    `<filter id="${p}-mud2" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="${seed + 4}"/><feColorMatrix values="0 0 0 0 .78 0 0 0 0 .42 0 0 0 0 .26 1.4 0 0 0 -.62"/></filter>` +
    FX.speckle(`${p}-sp`, '#2a0e04', 0.8, 1.6, -0.88, seed + 9) +
    FX.paper(`${p}-pp`, 0.05, 2.4, seed + 2) +
    `<filter id="${p}-pt" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="2" seed="${seed + 1}" result="w"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="w" scale="3.2" xChannelSelector="R" yChannelSelector="G" result="d"/>` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="${seed + 2}" result="n"/>` +
    `<feColorMatrix in="n" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.9 1.9" result="m"/>` +
    `<feComposite in="d" in2="m" operator="in"/></filter>`;
  const under =
    `<rect width="${W}" height="${H}" fill="${WL.bg}"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-mud)" opacity=".7"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-mud2)" opacity=".35"/>`;
  const over =
    `<rect width="${W}" height="${H}" filter="url(#${p}-pp)" style="mix-blend-mode:multiply" opacity=".55"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-sp)" opacity=".5"/>`;
  return { defs, under, over };
}
/** Warli human figure at the origin (feet at y=0), returned as one path. */
function warliFig(pose = 'stand', rng) {
  const j = () => (rng ? rng.range(-1.2, 1.2) : 0);
  let d = 'M-5.5-50a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0Z';
  d += `M${f(-11 + j() * 0.5)}-41L${f(11 + j() * 0.5)}-41L0-27Z M0-27L-8.5-14L8.5-14Z`;
  const legs = {
    stand: 'M-4-14L-7 0M4-14L7 0',
    walk: 'M-4-14L-11-1M4-14L8-6L11 0',
    dance: `M-4-14L-11-7L-8 0M4-14L${f(10 + j())}-6L13 0`,
    dance2: 'M-4-14L-9-5L-13 0M4-14L11-7L9 0',
  };
  const arms = {
    hands: 'M-10-40L-15-33M10-40L15-33',
    pot: 'M-10-40L-9-56M10-40L18-30',
    hip: 'M-10-40L-17-33L-6-28M10-40L17-33L6-28',
    up: 'M-10-40L-18-54M10-40L18-54',
    plough: 'M-10-40L-22-34M10-40L-18-30',
    swing: 'M-10-40L-20-46M10-40L19-31',
  };
  const [lg, am] = pose.split('/');
  d += legs[lg || 'stand'] + arms[am || 'hands'];
  return d;
}
/** Warli tree: trunk with branching twigs and leaves. */
function warliTree(rng, x, y, h, kind = 0) {
  let d = `M${f(x - 4)} ${f(y)}L${f(x - 2)} ${f(y - h)}L${f(x + 2)} ${f(y - h)}L${f(x + 4)} ${f(y)}Z`;
  let leaves = '';
  if (kind === 0) {
    // leafy tree: branches with small leaves
    for (let k = 0; k < 9; k++) {
      const by = y - h * (0.35 + (k / 9) * 0.65);
      const side = k % 2 ? 1 : -1;
      const len = h * (0.42 - (k / 9) * 0.3);
      const ex = x + side * len, ey = by - len * 0.5;
      d += `M${f(x)} ${f(by)}L${f(ex)} ${f(ey)}`;
      for (let t = 1; t <= 4; t++) {
        const px = lerp(x, ex, t / 4), py = lerp(by, ey, t / 4);
        leaves += `M${f(px)} ${f(py)}l${f(side * 3)} ${f(-7)}l${f(side * 3)} 7ZM${f(px)} ${f(py)}l${f(side * 4)} 5l${f(side * 4)}-3Z`;
      }
    }
  } else {
    // palm-like tree
    const tx = x, ty = y - h;
    for (let k = 0; k < 9; k++) {
      const a = PI + (k / 8) * PI;
      const ex = tx + Math.cos(a) * h * 0.38, ey = ty + Math.sin(a) * h * 0.25 + h * 0.08;
      d += `M${f(tx)} ${f(ty)}Q${f((tx + ex) / 2)} ${f(ty - h * 0.12)} ${f(ex)} ${f(ey)}`;
      for (let t = 1; t <= 5; t++) {
        const px = lerp(tx, ex, t / 5), py = lerp(ty, ey, t / 5) - Math.sin((t / 5) * PI) * h * 0.06;
        leaves += `M${f(px)} ${f(py)}l${f(1.5)} 8`;
      }
    }
  }
  return { d, leaves };
}

/* ---------------- Warli: Tarpa Dance Circle ---------------- */
ART['warli-tarpa-dance.svg'] = (rng) => {
  const W = 900, H = 900, p = 'wt', C = 450;
  const base = warliBase(p, W, H, 3);
  let defs = base.defs;
  // figure variants for the dance spiral
  const poses = ['dance/hands', 'dance2/hands', 'stand/hands', 'walk/hands'];
  poses.forEach((ps, i) => { defs += `<path id="${p}-f${i}" d="${warliFig(ps, rng)}"/>`; });
  let figs = '';
  // spiral of dancers, heads outward, holding hands
  let th = 0, r = 124;
  const b = 12;
  while (r < 322) {
    const x = C + Math.cos(th) * r, y = C + Math.sin(th) * r;
    const sc = 0.64 + (r / 322) * 0.3;
    const rot = (th * 180) / PI + 90;
    figs += `<use href="#${p}-f${rng.int(0, 3)}" transform="translate(${f(x)} ${f(y)}) rotate(${f(rot + rng.range(-4, 4))}) scale(${f(sc)})"/>`;
    const step = (30 * sc) / r;
    th += step;
    r = 124 + b * th;
  }
  // central tarpa player and drummer
  let mid = '';
  mid += `<path d="${warliFig('dance/swing')}" transform="translate(${C - 22} ${C + 50}) scale(1.9)"/>`;
  // tarpa: long curved gourd horn from the mouth, flaring at the end
  mid += `<path d="M${C - 10} ${C - 44}Q${C + 40} ${C - 40} ${C + 66} ${C + 6}L${C + 82} ${C + 22}Q${C + 76} ${C + 30} ${C + 60} ${C + 20}Q${C + 36} ${C - 26} ${C - 10} ${C - 36}Z"/>`;
  mid += `<path d="M${C + 74} ${C + 14}a10 10 0 1 0 10 10" fill="none"/>`;
  // drummer and a woman clapping
  mid += `<path d="${warliFig('walk/plough')}" transform="translate(${C + 92} ${C - 30}) scale(1.05)"/>`;
  mid += `<path d="M${C + 64} ${C - 62}a10 7 0 1 0 0.1 0Z"/>`;
  mid += `<path d="${warliFig('dance2/up')}" transform="translate(${C - 86} ${C - 26}) scale(1.05)"/>`;
  let ring = '';
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * TAU;
    ring += `M${f(C + Math.cos(a) * 104)} ${f(C + Math.sin(a) * 104)}h.1`;
  }
  mid += `<path d="${ring}" fill="none" stroke-width="5"/>`;
  // corner scenes: sun, moon, trees, birds, deer, hut
  let sc2 = '';
  const sun = (x, y, r0) => {
    let d = `M${x - r0} ${y}a${r0} ${r0} 0 1 0 ${2 * r0} 0a${r0} ${r0} 0 1 0 ${-2 * r0} 0Z`;
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * TAU;
      d += `M${f(x + Math.cos(a) * (r0 + 6))} ${f(y + Math.sin(a) * (r0 + 6))}L${f(x + Math.cos(a) * (r0 + 18))} ${f(y + Math.sin(a) * (r0 + 18))}`;
    }
    return d;
  };
  sc2 += `<path d="${sun(92, 92, 34)}"/>`;
  sc2 += `<path d="M${W - 92} 58a36 36 0 1 0 30 58a30 30 0 1 1-30-58Z"/>`;
  const stars = [[W - 160, 60], [W - 60, 150], [W - 190, 130], [W - 130, 40]];
  sc2 += `<path d="${stars.map(([x, y]) => `M${x - 5} ${y}h10M${x} ${y - 5}v10`).join('')}" fill="none"/>`;
  for (const [x, y, h, k] of [[70, 860, 170, 0], [150, 860, 110, 1], [W - 70, 860, 180, 1], [W - 160, 860, 120, 0]]) {
    const t = warliTree(rng, x, y, h, k);
    sc2 += `<path d="${t.d}"/><path d="${t.leaves}"/>`;
  }
  // birds
  let birds = '';
  for (let k = 0; k < 9; k++) {
    const x = rng.range(180, 720), y = rng.range(26, 90) + (Math.abs(x - C) < 160 ? 0 : 0);
    birds += `M${f(x - 9)} ${f(y - 4)}q4 1 9 5q5-4 9-5`;
  }
  sc2 += `<path d="${birds}" fill="none"/>`;
  // deer
  const deer = (x, y, s, flip) => `<g transform="translate(${x} ${y}) scale(${flip ? -s : s} ${s})"><path d="M-20-22L14-22L-3-10ZM-3-10L-18 0M-3-10L12 0M-20-22L-24-6M14-22L18-6M14-22L22-36L30-34L24-30ZM22-36l-2-10l-4 4M22-36l4-10l4 4"/></g>`;
  sc2 += deer(70, 520, 1.3, false) + deer(W - 72, 360, 1.2, true);
  // hut at left middle
  const hut = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-48 0L0-40L48 0ZM-38 0h76v46h-76ZM-8 46v-26h16v26Z" fill-rule="evenodd"/><path d="M-30-6l30-26l30 26" fill="none" stroke="${WL.bg}" stroke-width="2"/></g>`;
  sc2 += hut(250, 800, 0.9) + hut(W - 260, 800, 0.8);
  // border: dotted line + triangles
  let bord = `<path d="M18 18H${W - 18}V${H - 18}H18Z" fill="none" stroke-width="3"/>`;
  let tri = '';
  for (let x = 30; x < W - 30; x += 24) tri += `M${x} 30l12-0l-6 10ZM${x} ${H - 30}l12 0l-6-10Z`;
  for (let y = 54; y < H - 54; y += 24) tri += `M30 ${y}l0 12l10-6ZM${W - 30} ${y}l0 12l-10-6Z`;
  bord += `<path d="${tri}"/>`;

  const body =
    base.under +
    `<g fill="${WL.paint}" stroke="${WL.paint}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" filter="url(#${p}-pt)">` +
    figs + mid + sc2 + bord +
    `</g>` + base.over;
  return svgDoc(W, H, defs, body);
};

/* ---------------- Warli: Village Harvest ---------------- */
ART['warli-village-life.svg'] = (rng) => {
  const W = 1000, H = 750, p = 'wv';
  const base = warliBase(p, W, H, 8);
  let defs = base.defs;
  const P = WL.paint;
  // reusable motifs
  defs += `<path id="${p}-bull" d="M-30-34L26-34L20-16L-26-16ZM6-34q6-9 13 0ZM26-33L41-27L35-19ZM30-33l3-10M35-32l8-6M-24-16L-27 0M-14-16L-12 0M11-16L9 0M19-16L22 0M-30-32q-9 6-6 21"/>`;
  defs += `<path id="${p}-wpot" d="${warliFig('walk/pot', rng)}M-15-61a7 6 0 1 0 14 0a7 6 0 1 0-14 0ZM4-52a3 3 0 1 0 0.1 0Z"/>`;
  defs += `<path id="${p}-wpot2" d="${warliFig('stand/pot', rng)}M-15-61a7 6 0 1 0 14 0a7 6 0 1 0-14 0ZM4-52a3 3 0 1 0 0.1 0Z"/>`;
  defs += `<path id="${p}-man" d="${warliFig('walk/swing', rng)}"/>`;
  defs += `<path id="${p}-hut" d="M-50 0L0-42L50 0ZM-40 0h80v48h-80ZM-9 48v-28h18v28Z"/>`;
  defs += `<path id="${p}-plant" d="M0 0V-12M0-6l-6-8M0-6l6-8M0-2l-8-4M0-2l8-4"/>`;
  defs += `<path id="${p}-bird" d="M-10-4q5 1 10 6q5-5 10-6M0 2l0 0" fill="none"/>`;
  let s = '';
  const use = (id, x, y, sc = 1, flip = false, rot = 0) => `<use href="#${p}-${id}" transform="translate(${f(x)} ${f(y)})${rot ? ` rotate(${f(rot)})` : ''} scale(${f(flip ? -sc : sc)} ${f(sc)})"/>`;

  // sun and birds
  let sun = `M840 92a34 34 0 1 0 68 0a34 34 0 1 0-68 0Z`;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU;
    sun += `M${f(874 + Math.cos(a) * 42)} ${f(92 + Math.sin(a) * 42)}L${f(874 + Math.cos(a) * 54)} ${f(92 + Math.sin(a) * 54)}`;
  }
  s += `<path d="${sun}"/>`;
  for (let k = 0; k < 11; k++) s += use('bird', rng.range(340, 780), rng.range(50, 130), rng.range(0.8, 1.3), rng() < 0.5, rng.range(-15, 15));
  // huts cluster top-left with trees
  s += use('hut', 120, 200, 1) + use('hut', 240, 214, 0.85) + use('hut', 180, 140, 0.7);
  for (const [x, y, h, k] of [[330, 260, 150, 0], [60, 260, 120, 1], [520, 300, 200, 0]]) {
    const t = warliTree(rng, x, y, h, k);
    s += `<path d="${t.d}"/><path d="${t.leaves}"/>`;
  }
  // a woman sweeping & a man resting near the huts
  s += use('wpot2', 300, 300, 0.9) + use('man', 380, 300, 0.9, true);
  // ground lines (dotted rows)
  let dots = '';
  for (const y of [312, 470, 640]) for (let x = 40; x < W - 40; x += 11) dots += `M${x} ${y + Math.sin(x * 0.02) * 4}h.1`;
  s += `<path d="${dots}" fill="none" stroke-width="4"/>`;
  // farmer ploughing with two bullocks (right, middle band)
  s += use('bull', 780, 450, 1.15, false) + use('bull', 800, 432, 1.05, false);
  s += `<path d="M700 404L812 418M700 404L690 452l-14 2" fill="none" stroke-width="3"/>`;
  s += `<path d="${warliFig('walk/plough', rng)}" transform="translate(690 452) scale(1.05)"/>`;
  // paddy fields
  for (let r = 0; r < 3; r++) for (let k = 0; k < 13; k++) s += use('plant', 620 + k * 26 + (r % 2) * 13, 350 + r * 24, 0.9);
  // women carrying pots, walking in a row (middle band left)
  for (let k = 0; k < 4; k++) s += use(k % 2 ? 'wpot' : 'wpot2', 120 + k * 52, 455 - (k % 2) * 4, 1.1);
  // women pounding grain with a pestle
  s += `<path d="${warliFig('stand/up', rng)}" transform="translate(372 455) scale(1.05)"/>`;
  s += `<path d="${warliFig('stand/up', rng)}" transform="translate(452 455) scale(1.05) scale(-1 1)"/>`;
  s += `<path d="M412 384V452M398 455l6-14h16l6 14Z" fill="none" stroke-width="3.4"/><path d="M398 455h28l-4-14h-20Z"/>`;
  // bullock cart (bottom left)
  s += use('bull', 300, 610, 1.15) + use('bull', 318, 594, 1.05);
  s += `<path d="M120 572h120v10H120ZM240 577L320 566" fill="none" stroke-width="3"/><path d="M120 572h120v10H120Z"/>`;
  let wheel = 'M150 600a22 22 0 1 0 44 0a22 22 0 1 0-44 0Z';
  s += `<path d="${wheel}" fill="none" stroke-width="3.4"/>`;
  let sp = '';
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * PI;
    sp += `M${f(172 + Math.cos(a) * 22)} ${f(600 + Math.sin(a) * 22)}L${f(172 - Math.cos(a) * 22)} ${f(600 - Math.sin(a) * 22)}`;
  }
  s += `<path d="${sp}" fill="none" stroke-width="2"/>`;
  s += `<path d="M130 572q20-44 50-44q30 0 50 44" fill="none" stroke-width="3"/>`;
  s += `<path d="${warliFig('stand/swing', rng)}" transform="translate(236 572) scale(.85)"/>`;
  // dancers by the trees and a drummer (bottom right)
  for (let k = 0; k < 5; k++) s += `<path d="${warliFig(k % 2 ? 'dance/hands' : 'dance2/hands', rng)}" transform="translate(${500 + k * 28} ${612}) scale(.9)"/>`;
  {
    const t = warliTree(rng, 900, 640, 170, 1);
    s += `<path d="${t.d}"/><path d="${t.leaves}"/>`;
    const t2 = warliTree(rng, 420, 640, 110, 0);
    s += `<path d="${t2.d}"/><path d="${t2.leaves}"/>`;
  }
  // chickens and a dog
  const hen = (x, y, k) => `<path d="M0 0m-10-8q2-10 12-10l4-6l4 6l-4 2q4 10-6 18ZM-4 0v6M2 0v6M-10-10l-6-6" transform="translate(${x} ${y}) scale(${k} 1)"/>`;
  s += hen(370, 640, 1) + hen(390, 646, -1) + hen(560, 300, 1);
  s += `<path d="M560 690L590 690L586 678L564 678ZM590 690l8-10l4 4M564 690l-2 10M570 690v10M582 690v10M588 690v10M564 680l-8-6"/>`;
  // well with a woman drawing water, children playing (top band)
  s += `<path d="M600 300h60v-34h-60ZM604 266v-46M656 266v-46M598 220h64" fill="none" stroke-width="3"/><path d="M600 300h60v-34h-60Z"/><path d="M630 220v30M624 250h12v10h-12Z" fill="none" stroke-width="2"/>`;
  s += `<path d="${warliFig('stand/up', rng)}" transform="translate(690 300) scale(1.05)"/>`;
  s += use('wpot', 740, 300, 1.05, true);
  for (const [x, ps] of [[470, 'dance/up'], [500, 'dance2/hands']]) s += `<path d="${warliFig(ps, rng)}" transform="translate(${x} 300) scale(.7)"/>`;
  s += `<path d="M485 268a6 6 0 1 0 0.1 0Z"/>`;
  {
    const t = warliTree(rng, 800, 300, 120, 0);
    s += `<path d="${t.d}"/><path d="${t.leaves}"/>`;
  }
  // goats with a herder (middle band)
  const goat = (x, y, k) => `<g transform="translate(${x} ${y}) scale(${k} 1)"><path d="M-16-22L14-22L10-12L-12-12ZM-12-12l-2 12M-6-12v12M6-12v12M10-12l2 12M14-22l8-6l4 4l-6 6ZM22-28l-2-8M22-28l4-8M-16-20l-6 6"/></g>`;
  s += goat(560, 455, 1) + goat(610, 460, -1) + goat(590, 432, 1);
  s += `<path d="${warliFig('walk/swing', rng)}" transform="translate(520 455) scale(1.05)"/>`;
  // pond with fish and a fisherman (bottom band)
  s += `<path d="M640 600q60-30 120 0q-60 26-120 0Z" fill="none" stroke-width="3"/>`;
  for (const [x, y, k] of [[680, 600, 1], [720, 596, -1], [705, 606, 1]]) s += `<path d="M${x - 10 * k} ${y}q${10 * k}-8 ${20 * k} 0q${-10 * k} 8 ${-20 * k} 0ZM${x + 10 * k} ${y}l${6 * k}-5v10Z"/>`;
  s += `<path d="${warliFig('walk/plough', rng)}" transform="translate(790 612) scale(1.05)"/><path d="M768 580q-20 10-30 28" fill="none" stroke-width="2"/>`;
  // border
  let tri = '';
  for (let x = 30; x < W - 30; x += 24) tri += `M${x} 30h12l-6 10ZM${x} ${H - 30}h12l-6-10Z`;
  for (let y = 54; y < H - 54; y += 24) tri += `M30 ${y}v12l10-6ZM${W - 30} ${y}v12l-10-6Z`;
  s += `<path d="M18 18H${W - 18}V${H - 18}H18Z" fill="none" stroke-width="3"/><path d="${tri}"/>`;

  const body =
    base.under +
    `<g fill="${P}" stroke="${P}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" filter="url(#${p}-pt)">${s}</g>` +
    base.over;
  return svgDoc(W, H, defs, body);
};

/* ------------------------------------------------------------------ */
/* Mandala builder                                                      */
/* ------------------------------------------------------------------ */
/**
 * Build a mandala centred at the origin from a ring spec. Each motif is drawn
 * once (pointing up) into defs and repeated with rotated <use> elements.
 * col: {ink, lw, fills...}; returns {defs, svg}.
 */
function buildMandala(p, spec, col) {
  let defs = '', svg = '';
  const up = (r, a) => [Math.sin(a) * r, -Math.cos(a) * r];
  spec.forEach((R, i) => {
    const id = `${p}-r${i}`;
    const n = R.n || 1;
    const lw = R.lw || col.lw;
    const ink = R.ink || col.ink;
    const fill = R.fill || 'none';
    let m = '';
    switch (R.t) {
      case 'circle':
        svg += `<circle r="${R.r}" fill="${fill}" stroke="${ink}" stroke-width="${lw}"/>`;
        return;
      case 'disc':
        svg += `<circle r="${R.r}" fill="${fill}" stroke="${ink}" stroke-width="${lw}"/>`;
        if (R.dot) svg += `<circle r="${f(R.r * 0.35)}" fill="${R.dot}"/>`;
        return;
      case 'band':
        svg += `<circle r="${(R.r0 + R.r1) / 2}" fill="none" stroke="${R.fill}" stroke-width="${R.r1 - R.r0}"/>`;
        return;
      case 'ticks': {
        let d = '';
        for (let k = 0; k < n; k++) {
          const a = ((k + (R.off || 0)) / n) * TAU;
          const [x0, y0] = up(R.r0, a), [x1, y1] = up(R.r1, a);
          d += `M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}`;
        }
        svg += `<path d="${d}" stroke="${R.c || ink}" stroke-width="${lw}"/>`;
        return;
      }
      case 'zig': {
        let d = '';
        for (let k = 0; k <= n * 2; k++) {
          const [x, y] = up(k % 2 ? R.r1 : R.r0, (k / (n * 2)) * TAU);
          d += (k ? 'L' : 'M') + `${f(x)} ${f(y)}`;
        }
        svg += `<path d="${d}" fill="${fill}" stroke="${R.c || ink}" stroke-width="${lw}" stroke-linejoin="round"/>`;
        return;
      }
      case 'dots': {
        let d = '';
        for (let k = 0; k < n; k++) {
          const [x, y] = up(R.r, ((k + (R.off || 0)) / n) * TAU);
          d += `M${f(x)} ${f(y)}h.01`;
        }
        svg += `<path d="${d}" stroke="${R.c || ink}" stroke-width="${R.s * 2}" stroke-linecap="round"/>`;
        return;
      }
      case 'petal':
      case 'lotus': {
        const L = R.r1 - R.r0;
        const d = leafPath(0, -R.r0, -PI / 2, L, R.w, R.t === 'lotus' ? { sharp: 0.55, pk: 1.25, n: 6 } : { sharp: R.sharp || 0.8, n: 5 });
        m += `<path d="${d}" fill="${fill}" stroke="${ink}" stroke-width="${lw}"/>`;
        if (R.inner) {
          const d2 = leafPath(0, -R.r0 - L * 0.12, -PI / 2, L * 0.72, R.w * 0.55, R.t === 'lotus' ? { sharp: 0.55, pk: 1.25, n: 5 } : { sharp: 0.8, n: 4 });
          m += `<path d="${d2}" fill="${R.innerFill || 'none'}" stroke="${ink}" stroke-width="${f(lw * 0.75)}"/>`;
        }
        if (R.vein) m += `<path d="M0 ${f(-R.r0 - L * 0.1)}V${f(-R.r1 + L * 0.14)}" stroke="${ink}" stroke-width="${f(lw * 0.7)}"/>`;
        if (R.hatch) {
          let h = '';
          for (let k = 1; k < R.hatch; k++) {
            const t = k / R.hatch;
            const w = Math.pow(Math.sin(PI * Math.pow(t, 0.85)), 0.8) * R.w * 0.42;
            h += `M${f(-w)} ${f(-R.r0 - L * t)}h${f(2 * w)}`;
          }
          m += `<path d="${h}" stroke="${ink}" stroke-width="${f(lw * 0.6)}"/>`;
        }
        if (R.tipDot) m += `<circle cy="${f(-R.r1 - R.tipDot * 2.2)}" r="${R.tipDot}" fill="${R.tipC || ink}"/>`;
        break;
      }
      case 'scallop': {
        const a = PI / n;
        const [x0, y0] = up(R.r, -a), [x1, y1] = up(R.r, a), [cx, cy] = up(R.r + R.d * 2, 0);
        m += `<path d="M${f(x0)} ${f(y0)}Q${f(cx)} ${f(cy)} ${f(x1)} ${f(y1)}" fill="${fill}" stroke="${ink}" stroke-width="${lw}"/>`;
        if (R.dots) m += `<circle cy="${f(-R.r - R.d * 0.55)}" r="${f(R.d * 0.22)}" fill="${R.dotC || ink}"/>`;
        if (R.double) {
          const [ax, ay] = up(R.r + 3, -a * 0.8), [bx, by] = up(R.r + 3, a * 0.8), [qx, qy] = up(R.r + R.d * 2 - 6, 0);
          m += `<path d="M${f(ax)} ${f(ay)}Q${f(qx)} ${f(qy)} ${f(bx)} ${f(by)}" fill="none" stroke="${ink}" stroke-width="${f(lw * 0.6)}"/>`;
        }
        break;
      }
      case 'spike': {
        const a = PI / n;
        const [x0, y0] = up(R.r0, -a), [x1, y1] = up(R.r0, a);
        m += `<path d="M${f(x0)} ${f(y0)}L0 ${-R.r1}L${f(x1)} ${f(y1)}" fill="${fill}" stroke="${ink}" stroke-width="${lw}" stroke-linejoin="round"/>`;
        break;
      }
      case 'drop': {
        // teardrop with the round end outward and a curled tip
        const L = R.r1 - R.r0, w = R.w;
        const d = `M0 ${-R.r0}C${f(w * 0.2)} ${f(-R.r0 - L * 0.3)} ${f(w * 0.55)} ${f(-R.r0 - L * 0.55)} ${f(w * 0.5)} ${f(-R.r0 - L * 0.78)}A${f(w * 0.5)} ${f(w * 0.5)} 0 1 0 ${f(-w * 0.5)} ${f(-R.r0 - L * 0.78)}C${f(-w * 0.55)} ${f(-R.r0 - L * 0.55)} ${f(-w * 0.2)} ${f(-R.r0 - L * 0.3)} 0 ${-R.r0}Z`;
        m += `<path d="${d}" fill="${fill}" stroke="${ink}" stroke-width="${lw}"/>`;
        m += `<circle cy="${f(-R.r0 - L * 0.78)}" r="${f(w * 0.22)}" fill="${R.innerFill || 'none'}" stroke="${ink}" stroke-width="${f(lw * 0.7)}"/>`;
        break;
      }
      case 'arch': {
        // small arches between two radii (lace)
        const a = PI / n;
        const [x0, y0] = up(R.r0, -a * 0.9), [x1, y1] = up(R.r0, a * 0.9);
        m += `<path d="M${f(x0)} ${f(y0)}C${nums(up(R.r1, -a * 0.9))} ${nums(up(R.r1, a * 0.9))} ${f(x1)} ${f(y1)}" fill="${fill}" stroke="${ink}" stroke-width="${lw}"/>`;
        if (R.dots) m += `<circle cy="${f(-(R.r0 + R.r1) / 2 + 2)}" r="${R.dots}" fill="${R.dotC || ink}"/>`;
        break;
      }
      default:
        break;
    }
    defs += `<g id="${id}">${m}</g>`;
    const off = R.off || 0;
    let u = '';
    for (let k = 0; k < n; k++) u += `<use href="#${id}" transform="rotate(${f(((k + off) / n) * 360)})"/>`;
    svg += u;
  });
  return { defs, svg };
}

/* ---------------- Mandala: Golden Bloom ---------------- */
ART['mandala-golden-bloom.svg'] = (rng) => {
  const W = 900, H = 900, p = 'mg', C = 450;
  const g1 = `url(#${p}-g)`, g2 = `url(#${p}-g2)`;
  const ink = '#e6c27a';
  const spec = [
    { t: 'lotus', n: 8, r0: 6, r1: 46, w: 26, fill: g1, inner: true },
    { t: 'disc', r: 12, fill: '#5a1420', dot: '#f0d595' },
    { t: 'circle', r: 54 },
    { t: 'ticks', n: 72, r0: 54, r1: 60, lw: 1 },
    { t: 'dots', n: 32, r: 64, s: 2.2 },
    { t: 'lotus', n: 12, r0: 70, r1: 132, w: 46, fill: g2, inner: true, innerFill: '#5a1420', vein: true },
    { t: 'lotus', n: 12, r0: 72, r1: 118, w: 30, fill: g1, off: 0.5, vein: true },
    { t: 'circle', r: 138, lw: 2.4 },
    { t: 'zig', n: 48, r0: 138, r1: 144, lw: 1 },
    { t: 'circle', r: 144 },
    { t: 'scallop', n: 28, r: 148, d: 9, dots: true, double: true },
    { t: 'dots', n: 56, r: 166, s: 1.4 },
    { t: 'petal', n: 24, r0: 170, r1: 242, w: 30, hatch: 9, tipDot: 3 },
    { t: 'petal', n: 24, r0: 172, r1: 222, w: 16, fill: g1, off: 0.5, inner: true },
    { t: 'circle', r: 250, lw: 2.4 },
    { t: 'ticks', n: 120, r0: 250, r1: 256, lw: 0.9 },
    { t: 'dots', n: 60, r: 261, s: 3.4, c: '#f0d595' },
    { t: 'circle', r: 268 },
    { t: 'drop', n: 30, r0: 272, r1: 336, w: 24, fill: g2, innerFill: '#5a1420' },
    { t: 'petal', n: 30, r0: 280, r1: 320, w: 10, off: 0.5, vein: true },
    { t: 'circle', r: 344 },
    { t: 'arch', n: 60, r0: 346, r1: 370, dots: 1.8 },
    { t: 'scallop', n: 30, r: 374, d: 12, double: true, dots: true },
    { t: 'ticks', n: 30, r0: 400, r1: 412, lw: 1.2, off: 0.5 },
    { t: 'dots', n: 90, r: 418, s: 1.8 },
  ];
  const m = buildMandala(p, spec, { ink, lw: 1.6 });
  const defs =
    radGrad(`${p}-bg`, [[0, '#6a1a26'], [0.6, '#4a0f19'], [1, '#2a060c']], 0.5, 0.5, 0.72) +
    radGrad(`${p}-g`, [[0, '#f6dea0'], [0.5, '#d9a94e'], [1, '#a8742c']], 0.4, 0.35, 0.8) +
    linGrad(`${p}-g2`, [[0, '#f3d898'], [0.5, '#c8963e'], [1, '#8a5a22']], 0, 0, 1, 1) +
    radGrad(`${p}-sh`, [[0, '#fff3cf', 0.22], [1, '#fff3cf', 0]], 0.32, 0.28, 0.5) +
    FX.wobble(`${p}-wb`, 0.05, 1.6, 4, 2, W, H) +
    FX.paper(`${p}-pp`, 0.045, 1.8, 9) +
    FX.speckle(`${p}-sp`, '#f0d595', 0.7, 1.4, -0.93, 13) +
    m.defs;
  // corner filigree: quarter rosettes
  let corners = '';
  const cq = (x, y, rot) => {
    let g = `<g transform="translate(${x} ${y}) rotate(${rot})" fill="none" stroke="${ink}" stroke-width="1.4">`;
    for (const r of [40, 70, 100]) g += `<path d="M${r} 0A${r} ${r} 0 0 1 0 ${r}"/>`;
    for (let k = 0; k < 7; k++) {
      const a = ((k + 0.5) / 7) * (PI / 2);
      g += `<path d="${leafPath(Math.cos(a) * 42, Math.sin(a) * 42, a, 54, 16, { n: 4 })}" fill="${g1}" fill-opacity=".85"/>`;
    }
    for (let k = 0; k < 12; k++) {
      const a = ((k + 0.5) / 12) * (PI / 2);
      g += `<circle cx="${f(Math.cos(a) * 112)}" cy="${f(Math.sin(a) * 112)}" r="2.4" fill="${ink}" stroke="none"/>`;
    }
    return g + '</g>';
  };
  corners += cq(0, 0, 0) + cq(W, 0, 90) + cq(W, H, 180) + cq(0, H, 270);
  const body =
    `<rect width="${W}" height="${H}" fill="url(#${p}-bg)"/>` +
    `<g filter="url(#${p}-wb)">` +
    `<g transform="translate(${C} ${C})">${m.svg}</g>${corners}</g>` +
    `<rect width="${W}" height="${H}" fill="url(#${p}-sh)"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-pp)" style="mix-blend-mode:multiply" opacity=".45"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-sp)" opacity=".35"/>`;
  return svgDoc(W, H, defs, body);
};

/* ---------------- Mandala: Lotus Chakra ---------------- */
ART['mandala-lotus-chakra.svg'] = (rng) => {
  const W = 900, H = 900, p = 'mc', C = 450;
  const ink = '#4a2e17';
  const rose = '#c76f6f', pink = '#e8a6a0', sage = '#7a8b5e', gold = '#c8963e', lgold = '#e2c285', cream = '#fbf6ec';
  const spec = [
    { t: 'band', r0: 150, r1: 406, fill: '#f6ead6' },
    { t: 'band', r0: 0, r1: 70, fill: '#f8e3dc' },
    { t: 'lotus', n: 8, r0: 8, r1: 50, w: 28, fill: pink, inner: true, innerFill: '#f3c9c2' },
    { t: 'disc', r: 14, fill: gold, dot: cream },
    { t: 'circle', r: 58, fill: 'none' },
    { t: 'ticks', n: 64, r0: 58, r1: 63, lw: 1 },
    { t: 'dots', n: 28, r: 67, s: 2.4, c: gold },
    { t: 'lotus', n: 16, r0: 72, r1: 138, w: 40, fill: sage, inner: true, innerFill: '#a3b083', off: 0.5 },
    { t: 'lotus', n: 16, r0: 74, r1: 150, w: 44, fill: rose, inner: true, innerFill: pink, vein: true, tipDot: 2.4, tipC: gold },
    { t: 'circle', r: 158, lw: 2.2 },
    { t: 'band', r0: 160, r1: 172, fill: lgold },
    { t: 'circle', r: 172 },
    { t: 'dots', n: 48, r: 166, s: 2, c: ink },
    { t: 'arch', n: 32, r0: 172, r1: 200, fill: '#f3e3c4', dots: 2.2, dotC: rose },
    { t: 'ticks', n: 32, r0: 200, r1: 208, off: 0.5 },
    { t: 'petal', n: 32, r0: 206, r1: 268, w: 26, fill: pink, hatch: 7, tipDot: 2.6, tipC: gold },
    { t: 'petal', n: 32, r0: 210, r1: 250, w: 14, fill: sage, off: 0.5, vein: true },
    { t: 'circle', r: 276, lw: 2.2 },
    { t: 'band', r0: 276, r1: 282, fill: lgold },
    { t: 'zig', n: 64, r0: 276, r1: 282, lw: 1 },
    { t: 'circle', r: 282 },
    { t: 'scallop', n: 40, r: 284, d: 8, fill: '#f3e3c4', dots: true, dotC: rose },
    { t: 'dots', n: 80, r: 297, s: 1.4, c: ink },
    { t: 'drop', n: 24, r0: 302, r1: 366, w: 28, fill: rose, innerFill: lgold },
    { t: 'dots', n: 24, r: 376, s: 2.6, c: sage, off: 0.5 },
    { t: 'lotus', n: 24, r0: 304, r1: 350, w: 22, fill: sage, off: 0.5, inner: true, innerFill: '#a3b083' },
    { t: 'circle', r: 374 },
    { t: 'arch', n: 48, r0: 376, r1: 396, fill: pink, dots: 1.6, dotC: ink },
    { t: 'ticks', n: 48, r0: 398, r1: 408, off: 0.5 },
    { t: 'dots', n: 96, r: 414, s: 2, c: gold },
  ];
  const m = buildMandala(p, spec, { ink, lw: 1.6 });
  const defs =
    radGrad(`${p}-bg`, [[0, '#fdf9f0'], [0.7, '#fbf6ec'], [1, '#efe2c8']], 0.5, 0.5, 0.75) +
    FX.wobble(`${p}-wb`, 0.05, 1.6, 7, 2, W, H) +
    FX.paper(`${p}-pp`, 0.04, 2.4, 3) +
    FX.speckle(`${p}-sp`, '#8a6a44', 0.8, 1.5, -0.9, 21) +
    m.defs;
  let corners = '';
  const cq = (x, y, rot) => {
    let g = `<g transform="translate(${x} ${y}) rotate(${rot})" stroke="${ink}" stroke-width="1.4">`;
    for (let k = 0; k < 5; k++) {
      const a = ((k + 0.5) / 5) * (PI / 2);
      g += `<path d="${leafPath(Math.cos(a) * 20, Math.sin(a) * 20, a, 92, 34, { sharp: 0.55, pk: 1.25, n: 5 })}" fill="${k % 2 ? rose : pink}"/>`;
    }
    for (let k = 0; k < 4; k++) {
      const a = ((k + 1) / 5) * (PI / 2);
      g += `<path d="${leafPath(Math.cos(a) * 30, Math.sin(a) * 30, a, 120, 22, { n: 4 })}" fill="${sage}"/>`;
    }
    g += `<path d="M0 0m0 140A140 140 0 0 0 140 0" fill="none"/>`;
    for (let k = 0; k < 14; k++) {
      const a = ((k + 0.5) / 14) * (PI / 2);
      g += `<circle cx="${f(Math.cos(a) * 154)}" cy="${f(Math.sin(a) * 154)}" r="3" fill="${gold}" stroke="none"/>`;
    }
    return g + '</g>';
  };
  corners += cq(0, 0, 0) + cq(W, 0, 90) + cq(W, H, 180) + cq(0, H, 270);
  const body =
    `<rect width="${W}" height="${H}" fill="url(#${p}-bg)"/>` +
    `<g filter="url(#${p}-wb)"><g transform="translate(${C} ${C})">${m.svg}</g>${corners}</g>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-pp)" style="mix-blend-mode:multiply" opacity=".55"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-sp)" opacity=".4"/>`;
  return svgDoc(W, H, defs, body);
};

/* ------------------------------------------------------------------ */
/* Gond toolkit                                                         */
/* ------------------------------------------------------------------ */
const GD = {
  navy: '#121a3a', ink: '#24161a', white: '#fbf3e4', orange: '#ef7a33', yel: '#f6c533', pink: '#e8457c',
  magenta: '#b8348f', teal: '#1fa39a', cyan: '#3cbcd8', lime: '#9ccc3d', green: '#2f9a5a', red: '#d8392b', violet: '#6a4bb0',
};
/** Pattern fills used inside Gond shapes (light and dark variants). */
function gondPatterns(p, k = 1) {
  const pat = (id, w, h, inner, tr = '') => `<pattern id="${p}-${id}" patternUnits="userSpaceOnUse" width="${w}" height="${h}" patternTransform="${tr ? tr + ' ' : ''}scale(${k})">${inner}</pattern>`;
  const Wc = GD.white, K = GD.ink;
  return (
    pat('dw', 9, 9, `<circle cx="4.5" cy="4.5" r="1.6" fill="${Wc}"/>`) +
    pat('dk', 9, 9, `<circle cx="4.5" cy="4.5" r="1.5" fill="${K}"/>`) +
    pat('sw', 12, 10, `<path d="M1 3h6M7 8h6M-5 8h6" stroke="${Wc}" stroke-width="1.6" stroke-linecap="round"/>`, 'rotate(-20)') +
    pat('sk', 10, 8, `<path d="M1 2h5M6 6h5M-4 6h5" stroke="${K}" stroke-width="1.5" stroke-linecap="round"/>`, 'rotate(70)') +
    pat('lk', 5, 10, `<path d="M2.5 0V10" stroke="${K}" stroke-width="1.1"/>`, 'rotate(30)') +
    pat('lw', 6, 10, `<path d="M3 0V10" stroke="${Wc}" stroke-width="1.3"/>`, 'rotate(-35)') +
    pat('sc', 16, 12, `<path d="M0 12A8 8 0 0 1 16 12M-8 6A8 8 0 0 1 8 6M8 6A8 8 0 0 1 24 6" fill="none" stroke="${K}" stroke-width="1.3"/>`) +
    pat('cw', 12, 12, `<circle cx="6" cy="6" r="3" fill="none" stroke="${Wc}" stroke-width="1.3"/><circle cx="6" cy="6" r=".9" fill="${Wc}"/>`)
  );
}
/** A Gond shape: colour fill, pattern overlay, ink outline + white inner contour. */
let GD_DEFS = '', GD_ID = 0;
function gondShape(p, d, fill, pat, cx, cy, k = 0.86, ink = GD.ink, w = 3) {
  const id = `${p}${(GD_ID++).toString(36)}`;
  GD_DEFS += `<path id="${id}" d="${d}"/>`;
  let s = `<use href="#${id}" fill="${fill}"/>`;
  if (pat) s += `<use href="#${id}" fill="url(#${p}-${pat})"/>`;
  s += `<use href="#${id}" fill="none" stroke="${ink}" stroke-width="${w}"/>`;
  if (k) s += `<use href="#${id}" fill="none" stroke="${GD.white}" stroke-width="1.4" stroke-dasharray="5 3" transform="translate(${f(cx * (1 - k))} ${f(cy * (1 - k))}) scale(${k})"/>`;
  return s;
}

/* ---------------- Gond: Tree of Birds ---------------- */
ART['gond-tree-birds.svg'] = (rng) => {
  const W = 800, H = 1000, p = 'gt';
  GD_DEFS = ''; GD_ID = 0;
  let defs = gondPatterns(p);
  // leaf symbol (pointing right, length 100) recoloured with currentColor
  defs += `<g id="${p}-lf"><path d="M0 0C24-30 70-30 100 0C70 30 24 30 0 0Z" fill="currentColor" stroke="${GD.ink}" stroke-width="3"/>` +
    `<path d="M0 0C24-30 70-30 100 0Z" fill="url(#${p}-dw)" opacity=".85"/>` +
    `<path d="M4 0H92M24 0l14 12M44 0l14 12M64 0l12 9M22 0l12-10M42 0l14-12M62 0l12-10" stroke="${GD.ink}" stroke-width="1.6" fill="none"/>` +
    `<path d="M8 2C28 22 66 22 92 3" fill="none" stroke="${GD.white}" stroke-width="1.3" stroke-dasharray="4 3"/></g>`;
  // bird symbol (facing right, ~90 long, feet at origin)
  defs += `<g id="${p}-bd">` +
    `<path d="${leafPath(-30, -26, PI + 0.55, 70, 22, { n: 4 })}" fill="${GD.pink}" stroke="${GD.ink}" stroke-width="2.4"/>` +
    `<path d="${leafPath(-30, -24, PI + 0.15, 80, 24, { n: 4 })}" fill="${GD.yel}" stroke="${GD.ink}" stroke-width="2.4"/>` +
    `<path d="${leafPath(-30, -22, PI - 0.3, 66, 22, { n: 4 })}" fill="${GD.cyan}" stroke="${GD.ink}" stroke-width="2.4"/>` +
    `<path d="M-34-28L-88-58M-34-24L-106-36M-34-20L-90-2" stroke="${GD.ink}" stroke-width="1.4" fill="none"/>` +
    `<path d="M-48-34l-6 6M-60-40l-6 7M-72-46l-6 7M-50-25l-2 8M-64-28l-2 8M-78-31l-2 8M-50-16l2 7M-62-12l2 7" stroke="${GD.white}" stroke-width="1.6" fill="none"/>` +
    `<path d="M-36-22C-30-48 0-56 18-46C30-40 34-26 26-12C14 2-20 4-36-22Z" fill="currentColor" stroke="${GD.ink}" stroke-width="3"/>` +
    `<path d="M-36-22C-30-48 0-56 18-46C30-40 34-26 26-12C14 2-20 4-36-22Z" fill="url(#${p}-dw)"/>` +
    `<path d="M-24-28C-8-40 10-36 14-24C4-14-12-14-24-28Z" fill="${GD.white}" opacity=".95" stroke="${GD.ink}" stroke-width="2"/>` +
    `<path d="M-24-28C-8-40 10-36 14-24C4-14-12-14-24-28Z" fill="url(#${p}-lk)"/>` +
    `<circle cx="14" cy="-44" r="15" fill="currentColor" stroke="${GD.ink}" stroke-width="3"/>` +
    `<circle cx="18" cy="-46" r="6" fill="${GD.white}" stroke="${GD.ink}" stroke-width="1.6"/><circle cx="19.5" cy="-46" r="2.6" fill="${GD.ink}"/>` +
    `<path d="M28-48L44-42L28-38Z" fill="${GD.yel}" stroke="${GD.ink}" stroke-width="2"/>` +
    `<path d="M8-58q-2-12 6-16M14-58q4-12 12-12" stroke="${GD.ink}" stroke-width="2" fill="none"/><circle cx="14" cy="-74" r="3" fill="${GD.yel}"/><circle cx="26" cy="-70" r="3" fill="${GD.yel}"/>` +
    `<path d="M-6-4v6M2-4v6M-10 2h8M-2 2h8" stroke="${GD.ink}" stroke-width="2.4" stroke-linecap="round"/></g>`;

  // deer symbol (facing right, feet at origin)
  defs += `<g id="${p}-dr">` +
    `<path d="M-36-38L-40 0M-24-38L-20 0M20-38L16 0M32-38L37 0" stroke="${GD.ink}" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="M-50-60C-40-82 30-82 40-62C46-50 40-40 30-38L-40-38C-52-40-56-50-50-60Z" fill="currentColor" stroke="${GD.ink}" stroke-width="3"/>` +
    `<path d="M-50-60C-40-82 30-82 40-62C46-50 40-40 30-38L-40-38C-52-40-56-50-50-60Z" fill="url(#${p}-sw)"/>` +
    `<path d="M-40-58C-20-70 10-70 30-58" fill="none" stroke="${GD.white}" stroke-width="1.6" stroke-dasharray="5 3"/>` +
    `<path d="M26-68L42-104L56-100L44-60Z" fill="currentColor" stroke="${GD.ink}" stroke-width="3"/><path d="M26-68L42-104L56-100L44-60Z" fill="url(#${p}-lk)"/>` +
    `<path d="M40-112C46-120 66-118 72-106C66-98 48-98 40-112Z" fill="currentColor" stroke="${GD.ink}" stroke-width="3"/>` +
    `<circle cx="56" cy="-110" r="3.4" fill="${GD.ink}"/><path d="M44-114l-12-6l8 10Z" fill="${GD.yel}" stroke="${GD.ink}" stroke-width="1.6"/>` +
    `<path d="M48-118l-6-26M45-130l-12-8M47-138l8-10M54-118l6-24M58-130l12-6M59-136l2-12" stroke="${GD.ink}" stroke-width="2.6" fill="none" stroke-linecap="round"/>` +
    `<path d="M-50-58l-10-6" stroke="${GD.ink}" stroke-width="4" stroke-linecap="round"/></g>`;
  let s = `<rect width="${W}" height="${H}" fill="${GD.navy}"/>`;
  // ---- tree trunk and branches as tapered patterned limbs
  const limb = (pts, w0, w1) => {
    const top = [], bot = [];
    pts.forEach((pt, i) => {
      const t = i / (pts.length - 1);
      const q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
      const dx = q[0] - o[0], dy = q[1] - o[1], dl = Math.hypot(dx, dy) || 1;
      const w = lerp(w0, w1, t);
      top.push([pt[0] - (dy / dl) * w, pt[1] + (dx / dl) * w]);
      bot.push([pt[0] + (dy / dl) * w, pt[1] - (dx / dl) * w]);
    });
    return smoothPath(top.concat(bot.reverse()), true);
  };
  const limbs = [
    { pts: [[400, 1010], [396, 900], [404, 780], [400, 640], [398, 560]], w0: 62, w1: 40 },
    { pts: [[398, 600], [340, 520], [260, 460], [170, 420]], w0: 34, w1: 12 },
    { pts: [[402, 600], [470, 520], [550, 470], [640, 440]], w0: 34, w1: 12 },
    { pts: [[400, 580], [392, 470], [410, 360], [400, 250]], w0: 30, w1: 12 },
    { pts: [[320, 500], [300, 420], [250, 340], [200, 290]], w0: 14, w1: 7 },
    { pts: [[490, 510], [520, 420], [570, 340], [610, 290]], w0: 14, w1: 7 },
    { pts: [[404, 420], [460, 360], [520, 230]], w0: 12, w1: 6 },
    { pts: [[398, 440], [340, 360], [280, 220]], w0: 12, w1: 6 },
    { pts: [[400, 960], [320, 990], [250, 1010]], w0: 18, w1: 6 },
    { pts: [[400, 660], [360, 652], [300, 650]], w0: 9, w1: 5 },
    { pts: [[400, 670], [440, 662], [510, 660]], w0: 9, w1: 5 },
    { pts: [[400, 960], [480, 990], [560, 1012]], w0: 18, w1: 6 },
  ];
  let tree = '';
  const tc = [GD.orange, GD.red];
  const lds = limbs.map((L) => limb(L.pts, L.w0, L.w1));
  // outline pass first, then fills, so joints merge cleanly
  tree += `<path d="${lds.join('')}" fill="none" stroke="${GD.ink}" stroke-width="6.4"/>`;
  lds.forEach((d, i) => { tree += `<path d="${d}" fill="${i ? tc[i % 2] : GD.orange}"/>`; });
  tree += `<path d="${lds.join('')}" fill="url(#${p}-sk)"/>`;
  // trunk stripes: wavy white lines along the trunk
  let tl = '';
  for (let k = -3; k <= 3; k++) tl += `M${400 + k * 12} 1000C${396 + k * 11} 900 ${404 + k * 9} 760 ${400 + k * 6} 600`;
  tree += `<path d="${tl}" fill="none" stroke="${GD.white}" stroke-width="1.6" stroke-dasharray="7 5" opacity=".9"/>`;
  s += tree;

  // ---- leaf clusters at branch ends
  const leafCols = [GD.green, GD.lime, GD.teal, GD.yel, GD.pink, GD.cyan];
  const cluster = (cx, cy, n, sc, a0 = -PI / 2, spread = PI * 1.6) => {
    let g = '';
    for (let k = 0; k < n; k++) {
      const a = a0 + (k / (n - 1) - 0.5) * spread + rng.range(-0.08, 0.08);
      const s2 = sc * rng.range(0.85, 1.1);
      g += `<use href="#${p}-lf" color="${leafCols[(k + Math.round(cx)) % leafCols.length]}" transform="translate(${f(cx)} ${f(cy)}) rotate(${f((a * 180) / PI)}) scale(${f(s2)})"/>`;
    }
    g += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(12 * sc)}" fill="${GD.pink}" stroke="${GD.ink}" stroke-width="2.4"/><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(5 * sc)}" fill="${GD.yel}"/>`;
    return g;
  };
  s += cluster(170, 420, 9, 1.05, PI * 1.1, PI * 1.5);
  s += cluster(640, 440, 9, 1.05, -PI * 0.1, PI * 1.5);
  s += cluster(400, 240, 11, 1.15, -PI / 2, PI * 1.7);
  s += cluster(200, 290, 7, 0.9, -PI * 0.7, PI * 1.2);
  s += cluster(610, 290, 7, 0.9, -PI * 0.3, PI * 1.2);
  s += cluster(520, 220, 6, 0.85, -PI * 0.4, PI);
  s += cluster(280, 210, 6, 0.85, -PI * 0.6, PI);
  // ---- birds perched and flying
  const bird = (x, y, sc, col, flip) => `<use href="#${p}-bd" color="${col}" transform="translate(${x} ${y}) scale(${f(flip ? -sc * 1.15 : sc * 1.15)} ${f(sc * 1.15)})"/>`;
  s += bird(300, 470, 0.9, GD.magenta, true);
  s += bird(520, 482, 0.9, GD.cyan, false);
  s += bird(250, 345, 0.75, GD.yel, true);
  s += bird(560, 352, 0.75, GD.pink, false);
  s += bird(410, 372, 0.8, GD.lime, false);
  s += bird(330, 646, 0.95, GD.orange, true) + bird(476, 656, 0.95, GD.teal, false);
  s += bird(130, 140, 0.7, GD.yel, false) + bird(680, 120, 0.7, GD.magenta, true) + bird(720, 640, 0.75, GD.cyan, true) + bird(90, 700, 0.75, GD.pink, false);

  // ground: patterned hillocks and grass
  let gr = '';
  for (let k = 0; k < 7; k++) {
    const x = 40 + k * 120, w = 70;
    const d = `M${x - w} ${H + 4}Q${x} ${H - 90 - (k % 2) * 20} ${x + w} ${H + 4}Z`;
    gr += gondShape(p, d, [GD.green, GD.teal, GD.lime][k % 3], k % 2 ? 'dw' : 'sw', x, H - 20, 0.8);
  }
  s += gr;
  s += `<use href="#${p}-dr" color="${GD.yel}" transform="translate(190 930) scale(1.05)"/>`;
  s += `<use href="#${p}-dr" color="${GD.cyan}" transform="translate(612 934) scale(-1 1)"/>`;
  s += bird(130, 780, 0.8, GD.lime, false) + bird(690, 800, 0.8, GD.orange, true);
  // stars / dot clusters on the night ground
  let st = '';
  for (let k = 0; k < 110; k++) {
    const x = rng.range(20, W - 20), y = rng.range(20, 900);
    if (Math.abs(x - 400) < 300 && y > 150 && y < 700) continue;
    st += `M${f(x)} ${f(y)}h.1`;
  }
  s += `<path d="${st}" stroke="${GD.white}" stroke-width="3.2" stroke-linecap="round" opacity=".7"/>`;

  const fin = FX.wobble(`${p}-wb`, 0.04, 2, 8, 2, W, H) + FX.paper(`${p}-pp`, 0.04, 1.6, 4) + FX.speckle(`${p}-sp`, '#ffffff', 0.7, 1.4, -0.93, 31);
  const body =
    `<g filter="url(#${p}-wb)">${s}</g>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-pp)" style="mix-blend-mode:multiply" opacity=".5"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-sp)" opacity=".18"/>`;
  return svgDoc(W, H, defs + fin + GD_DEFS, body);
};

/* ---------------- Gond: Sacred Fish ---------------- */
ART['gond-sacred-fish.svg'] = (rng) => {
  const W = 1000, H = 750, p = 'gf';
  GD_DEFS = ''; GD_ID = 0;
  let defs = gondPatterns(p, 0.72);
  const K = GD.ink;
  let s = `<rect width="${W}" height="${H}" fill="#fbf3e4"/>`;
  // faint water currents
  let wl = '';
  for (let k = 0; k < 14; k++) {
    const y = 40 + k * 50 + rng.range(-10, 10), x = rng.range(-50, 300);
    wl += `M${f(x)} ${f(y)}c40-14 80 14 120 0s80 14 120 0s80 14 120 0s80 14 120 0s80 14 120 0s80 14 120 0`;
  }
  s += `<path d="${wl}" fill="none" stroke="#9fd0d6" stroke-width="2" stroke-dasharray="10 7" opacity=".7"/>`;
  // pebbles along the bottom
  let pb = '';
  for (let k = 0; k < 16; k++) {
    const x = 30 + k * 62 + rng.range(-10, 10), y = H - 22 + rng.range(-8, 6), rx = rng.range(20, 32), ry = rng.range(12, 18);
    const c = [GD.orange, GD.violet, GD.teal, GD.yel, GD.pink][k % 5];
    pb += gondShape(p, `M${f(x - rx)} ${f(y)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`, c, k % 2 ? 'dw' : 'sw', x, y, 0.7, K, 2.4);
  }
  // water weeds rising from the bottom
  let weeds = '';
  const weed = (x0, h, col, k2) => {
    let d = `M${x0} ${H}`;
    const pts = [];
    for (let k = 0; k <= 6; k++) pts.push([x0 + Math.sin(k * 1.1 + k2) * 16, H - (h * k) / 6]);
    const stem = smoothPath(pts);
    let g = `<path d="${stem}" fill="none" stroke="${K}" stroke-width="7" stroke-linecap="round"/><path d="${stem}" fill="none" stroke="${GD.green}" stroke-width="3.6" stroke-linecap="round"/>`;
    for (let k = 1; k <= 5; k++) {
      const [x, y] = pts[k];
      const side = k % 2 ? 1 : -1;
      const a = -PI / 2 + side * 0.9;
      const lp = leafPath(x, y, a, 60, 24, { n: 4 });
      g += gondShape(p, lp, col, k % 2 ? 'dw' : 'lk', x + Math.cos(a) * 30, y + Math.sin(a) * 30, 0.75, K, 2.4);
    }
    return g;
  };
  weeds += weed(80, 330, GD.green, 0) + weed(190, 220, GD.lime, 2) + weed(880, 360, GD.teal, 1) + weed(950, 210, GD.lime, 3) + weed(560, 150, GD.green, 4);
  s += weeds;

  // ---- fish
  const fish = (cx, cy, sc, flip, cols) => {
    const tr = `translate(${cx} ${cy}) scale(${flip ? -sc : sc} ${sc})`;
    const body = smoothPath([[200, 0], [150, -62], [60, -92], [-50, -88], [-150, -44], [-196, 0], [-150, 44], [-50, 88], [60, 92], [150, 62]], true);
    const id = `${p}-b${cx}`;
    let g = `<g transform="${tr}">`;
    // fins and tail behind the body
    g += gondShape(p, 'M-186 0C-220-30-260-80-292-98C-276-50-270-20-262 0C-270 20-276 50-292 98C-260 80-220 30-186 0Z', cols[3], 'lk', -240, 0, 0.8, K, 3);
    g += `<path d="M-200 0L-280-80M-200 0L-270-40M-200 0L-266 0M-200 0L-270 40M-200 0L-280 80" stroke="${K}" stroke-width="1.6"/>`;
    g += gondShape(p, 'M-80-86C-60-150 10-160 50-96Z', cols[2], 'lk', -20, -110, 0.8, K, 3);
    g += gondShape(p, 'M-60 86C-50 140 0 150 30 90Z', cols[2], 'lk', -20, 110, 0.8, K, 3);
    g += `<clipPath id="${id}"><path d="${body}"/></clipPath>`;
    // body sections
    const xs = [260, 112, 40, -40, -110, -260];
    const pats = ['dk', 'dw', 'sc', 'sw', 'cw'];
    let sec = '';
    for (let k = 0; k < xs.length - 1; k++) {
      const a = xs[k], b = xs[k + 1];
      const d = `M${a} -200Q${a - 26} 0 ${a} 200L${b} 200Q${b - 26} 0 ${b} -200Z`;
      sec += `<path d="${d}" fill="${cols[k % cols.length]}"/>` + (pats[k] ? `<path d="${d}" fill="url(#${p}-${pats[k]})"/>` : '');
    }
    let cuts = '';
    for (const x of xs.slice(1, -1)) cuts += `M${x} -200Q${x - 26} 0 ${x} 200`;
    let cuts2 = '';
    for (const x of xs.slice(1, -1)) for (const o of [-11, 11]) cuts2 += `M${x + o} -200Q${x + o - 26} 0 ${x + o} 200`;
    sec += `<path d="${cuts2}" fill="none" stroke="${K}" stroke-width="1.6" stroke-dasharray="4 4"/>`;
    sec += `<path d="${cuts}" fill="none" stroke="${K}" stroke-width="8"/><path d="${cuts}" fill="none" stroke="${GD.white}" stroke-width="2.6" stroke-dasharray="1 6" stroke-linecap="round"/>`;
    // head ornament: gill arc with dashes
    sec += `<path d="M150-80Q120 0 150 80" fill="none" stroke="${K}" stroke-width="3"/><path d="M140-74Q112 0 140 74" fill="none" stroke="${K}" stroke-width="2" stroke-dasharray="4 4"/>`;
    g += `<g clip-path="url(#${id})">${sec}</g>`;
    g += `<path d="${body}" fill="none" stroke="${K}" stroke-width="4"/>`;
    g += `<path d="${body}" fill="none" stroke="${GD.white}" stroke-width="1.6" stroke-dasharray="6 4" transform="scale(.9)"/>`;
    // eye and mouth
    g += `<circle cx="150" cy="-18" r="20" fill="${GD.white}" stroke="${K}" stroke-width="3"/><circle cx="150" cy="-18" r="13" fill="${cols[4] || GD.teal}" stroke="${K}" stroke-width="2"/><circle cx="152" cy="-18" r="6.5" fill="${K}"/><circle cx="148" cy="-22" r="2.2" fill="${GD.white}"/>`;
    let lash = '';
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * TAU;
      lash += `M${f(150 + Math.cos(a) * 27)} ${f(-18 + Math.sin(a) * 27)}h.1`;
    }
    g += `<path d="${lash}" stroke="${K}" stroke-width="4" stroke-linecap="round"/>`;
    g += `<path d="M199 6l-18 2" fill="none" stroke="${K}" stroke-width="3" stroke-linecap="round"/>`;
    g += `</g>`;
    return g;
  };
  s += fish(440, 320, 1.15, false, [GD.yel, GD.orange, GD.teal, GD.pink, GD.violet]);
  s += fish(720, 560, 0.78, true, [GD.pink, GD.violet, GD.yel, GD.cyan, GD.orange]);
  s += fish(800, 150, 0.52, true, [GD.lime, GD.teal, GD.orange, GD.yel, GD.pink]);
  s += fish(170, 600, 0.45, false, [GD.cyan, GD.yel, GD.pink, GD.orange, GD.green]);
  s += pb;
  // bubbles
  let bub = '';
  for (const [x, y, r] of [[700, 270, 9], [722, 240, 6], [736, 214, 4], [240, 240, 7], [262, 216, 5], [520, 520, 6], [538, 500, 4]]) bub += `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${K}" stroke-width="2"/><circle cx="${x - r * 0.35}" cy="${y - r * 0.35}" r="${f(r * 0.25)}" fill="${K}"/>`;
  s += bub;

  const fin = FX.wobble(`${p}-wb`, 0.04, 2, 8, 2, W, H) + FX.paper(`${p}-pp`, 0.035, 2.2, 6) + FX.speckle(`${p}-sp`, '#6a4a2a', 0.8, 1.5, -0.9, 11);
  const body =
    `<g filter="url(#${p}-wb)">${s}</g>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-pp)" style="mix-blend-mode:multiply" opacity=".55"/>` +
    `<rect width="${W}" height="${H}" filter="url(#${p}-sp)" opacity=".35"/>`;
  return svgDoc(W, H, defs + fin + GD_DEFS, body);
};

/* ------------------------------------------------------------------ */
/* Handcrafted decor — product shots                                   */
/* ------------------------------------------------------------------ */
/** Soft studio backdrop with a gentle floor fade and vignette. */
function studioBackdrop(p, W, H, top = '#efe9e0', bottom = '#d8cec0') {
  const defs =
    linGrad(`${p}-bd`, [[0, top], [1, bottom]]) +
    radGrad(`${p}-vg`, [[0.5, '#000', 0], [1, '#2a1e14', 0.22]], 0.5, 0.45, 0.8) +
    FX.speckle(`${p}-gr`, '#5a4a3a', 0.9, 1.2, -0.95, 7);
  const svg =
    `<rect width="${W}" height="${H}" fill="url(#${p}-bd)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#${p}-vg)"/>`;
  const grain = `<rect width="${W}" height="${H}" filter="url(#${p}-gr)" opacity=".25"/>`;
  return { defs, svg, grain };
}

/* ---------------- Hand-painted Mandala Wall Plate ---------------- */
ART['mandala-wall-plate.svg'] = (rng) => {
  const W = 900, H = 900, p = 'wp', C = 450, CY = 438, R = 360;
  const bd = studioBackdrop(p, W, H, '#eee8de', '#dcd2c4');
  const white = '#f7f1e6', gold = '#e0b04f', red = '#c8463a', tq = '#3fb3b0', pink = '#f08aa0', yel = '#f3cf4a';
  // dot-painted mandala (classic hand-painted plate look)
  const spec = [
    { t: 'disc', r: 26, fill: gold, ink: 'none' },
    { t: 'dots', n: 1, r: 0, s: 9, c: red },
    { t: 'dots', n: 12, r: 36, s: 5, c: white },
    { t: 'lotus', n: 8, r0: 44, r1: 96, w: 40, fill: red, ink: white, lw: 2.4, inner: true, innerFill: pink },
    { t: 'dots', n: 8, r: 102, s: 5, c: yel, off: 0.5 },
    { t: 'dots', n: 32, r: 112, s: 3.4, c: white },
    { t: 'dots', n: 40, r: 124, s: 4.2, c: tq },
    { t: 'lotus', n: 16, r0: 134, r1: 196, w: 36, fill: '#26386e', ink: gold, lw: 2.4, inner: true, innerFill: tq },
    { t: 'dots', n: 16, r: 204, s: 4.5, c: white, off: 0.5 },
    { t: 'dots', n: 64, r: 214, s: 3.2, c: yel },
    { t: 'dots', n: 64, r: 225, s: 4.6, c: red, off: 0.5 },
    { t: 'drop', n: 24, r0: 232, r1: 286, w: 22, fill: white, ink: 'none', innerFill: red },
    { t: 'dots', n: 24, r: 250, s: 3, c: tq, off: 0.5 },
    { t: 'dots', n: 24, r: 266, s: 4, c: pink, off: 0.5 },
    { t: 'dots', n: 90, r: 296, s: 3, c: white },
    { t: 'dots', n: 90, r: 306, s: 2.4, c: gold, off: 0.5 },
  ];
  const m = buildMandala(p, spec, { ink: white, lw: 2 });
  const defs = bd.defs + m.defs +
    radGrad(`${p}-base`, [[0, '#24346a'], [0.75, '#1b2752'], [1, '#121b3c']], 0.45, 0.4, 0.7) +
    radGrad(`${p}-rim`, [[0.9, '#000', 0], [0.95, '#000', 0.1], [0.99, '#000', 0.3], [1, '#000', 0.45]]) +
    linGrad(`${p}-lit`, [[0, '#fff', 0.35], [0.45, '#fff', 0], [0.7, '#000', 0], [1, '#000', 0.3]], 0.15, 0.1, 0.85, 0.9) +
    linGrad(`${p}-rimg`, [[0, '#fbe7a8'], [0.35, '#e2b456'], [0.7, '#c8963e'], [1, '#7a5220']], 0.1, 0, 0.9, 1) +
    linGrad(`${p}-step`, [[0, '#000', 0.45], [0.5, '#000', 0.1], [1, '#fff', 0.35]], 0.1, 0, 0.9, 1) +
    FX.blur(`${p}-sh`, 18, 40) +
    FX.blur(`${p}-hl`, 6, 40) +
    FX.wobble(`${p}-wb`, 0.06, 1.8, 3, 2, W, H);
  let s = bd.svg;
  // contact shadow on the wall
  s += `<ellipse cx="${C + 18}" cy="${CY + 30}" rx="${R}" ry="${R}" fill="#3a2a1c" opacity=".35" filter="url(#${p}-sh)"/>`;
  // plate body + gold rim
  s += `<circle cx="${C}" cy="${CY}" r="${R}" fill="url(#${p}-rimg)"/>`;
  s += `<circle cx="${C}" cy="${CY}" r="${R - 30}" fill="url(#${p}-base)"/>`;
  s += `<circle cx="${C}" cy="${CY}" r="${R - 30}" fill="none" stroke="url(#${p}-step)" stroke-width="5"/>`;
  // dot border on rim
  let rd = '';
  for (let k = 0; k < 120; k++) {
    const a = (k / 120) * TAU;
    rd += `M${f(C + Math.cos(a) * (R - 15))} ${f(CY + Math.sin(a) * (R - 15))}h.01`;
  }
  s += `<path d="${rd}" stroke="#8a2a1c" stroke-width="6" stroke-linecap="round" opacity=".8"/>`;
  s += `<circle cx="${C}" cy="${CY}" r="${R - 4}" fill="none" stroke="#5a3a14" stroke-width="2" opacity=".5"/><circle cx="${C}" cy="${CY}" r="${R - 26}" fill="none" stroke="#5a3a14" stroke-width="2" opacity=".5"/>`;
  s += `<g filter="url(#${p}-wb)"><g transform="translate(${C} ${CY})">${m.svg}</g></g>`;
  // curvature shading: well, rim and light falloff
  s += `<circle cx="${C}" cy="${CY}" r="${R - 32}" fill="none" stroke="#000" stroke-opacity=".3" stroke-width="10" filter="url(#${p}-hl)"/>`;
  s += `<circle cx="${C}" cy="${CY}" r="${R}" fill="url(#${p}-rim)"/>`;
  s += `<circle cx="${C}" cy="${CY}" r="${R}" fill="url(#${p}-lit)"/>`;
  // specular highlight along the upper-left rim
  s += `<path d="M${f(C - R * 0.86)} ${f(CY - R * 0.36)}A${R - 8} ${R - 8} 0 0 1 ${f(C - R * 0.2)} ${f(CY - R * 0.93)}" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity=".55" filter="url(#${p}-hl)"/>`;
  s += `<path d="M${f(C + R * 0.6)} ${f(CY + R * 0.74)}A${R - 6} ${R - 6} 0 0 0 ${f(C + R * 0.9)} ${f(CY + R * 0.3)}" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".25" filter="url(#${p}-hl)"/>`;
  s += bd.grain;
  return svgDoc(W, H, defs, s);
};

/* ---------------- Hand-painted Diya Set ---------------- */
ART['painted-diya-set.svg'] = (rng) => {
  const W = 1000, H = 750, p = 'dy';
  let defs =
    linGrad(`${p}-wall`, [[0, '#3e2f29'], [0.55, '#5c4639'], [1, '#6f5544']]) +
    linGrad(`${p}-tbl`, [[0, '#8b6f5c'], [1, '#b3967e']]) +
    radGrad(`${p}-vg`, [[0.45, '#000', 0], [1, '#140a05', 0.45]], 0.5, 0.55, 0.8) +
    radGrad(`${p}-glow`, [[0, '#ffd27a', 0.55], [0.4, '#ff9a3c', 0.18], [1, '#ff8a30', 0]]) +
    radGrad(`${p}-pool`, [[0, '#ffc070', 0.45], [1, '#ff9040', 0]]) +
    radGrad(`${p}-fl`, [[0, '#fffbe8'], [0.35, '#ffe48a'], [0.75, '#ffa53a'], [1, '#e8561e']], 0.5, 0.7, 0.6) +
    linGrad(`${p}-oil`, [[0, '#2a160b'], [1, '#5a3418']]) +
    FX.blur(`${p}-b1`, 8, 80) + FX.blur(`${p}-b2`, 2, 80) + FX.blur(`${p}-b3`, 16, 80) +
    FX.speckle(`${p}-gr`, '#1a0d06', 0.9, 1.3, -0.92, 5) +
    FX.wobble(`${p}-wb`, 0.08, 1.5, 9);
  let s = `<rect width="${W}" height="${H}" fill="url(#${p}-wall)"/>`;
  let bok = '';
  for (let k = 0; k < 14; k++) bok += `<circle cx="${f(rng.range(20, 980))}" cy="${f(rng.range(30, 300))}" r="${f(rng.range(14, 40))}" fill="${rng.pick(['#ffcf80', '#ffb060', '#ffe0a0'])}" opacity="${f(rng.range(0.08, 0.2))}"/>`;
  s += `<g filter="url(#${p}-b1)">${bok}</g>`;
  const TY = 370;
  s += `<rect y="${TY}" width="${W}" height="${H - TY}" fill="url(#${p}-tbl)"/>`;
  s += `<rect y="${TY - 6}" width="${W}" height="14" fill="#2a1d16" opacity=".35" filter="url(#${p}-b2)"/>`;
  // diya bodies: each painted in a different scheme
  const schemes = [
    { body: '#b5482a', band: '#f3c13a', dot: '#fff4dc', acc: '#2f7a6f' },
    { body: '#c8642e', band: '#7a2a58', dot: '#fff4dc', acc: '#f3c13a' },
    { body: '#2f5f8a', band: '#f3c13a', dot: '#fff4dc', acc: '#d8452f' },
    { body: '#a33a2a', band: '#3a8a6a', dot: '#f8e6b0', acc: '#f08a3a' },
    { body: '#d27a2e', band: '#b5342a', dot: '#fff4dc', acc: '#2f5f8a' },
    { body: '#7a2a40', band: '#e8b03a', dot: '#fff4dc', acc: '#3fa39a' },
  ];
  schemes.forEach((sc, i) => {
    defs += linGrad(`${p}-s${i}`, [[0, sc.body], [0.55, sc.body], [1, '#2a120a']], 0, 0, 0.3, 1);
  });
  defs += linGrad(`${p}-shade`, [[0, '#fff', 0.25], [0.35, '#fff', 0], [0.7, '#000', 0.1], [1, '#000', 0.45]], 0, 0, 1, 0);
  const diya = (x, y, sc, i, flip) => {
    const S = schemes[i];
    const rx = 82, ry = 22;
    let g = `<g transform="translate(${x} ${y}) scale(${flip ? -sc : sc} ${sc})">`;
    // table shadow and warm pool of light
    g += `<ellipse cx="6" cy="58" rx="100" ry="18" fill="#1a0c06" opacity=".45" filter="url(#${p}-b1)"/>`;
    // outer body (bowl) with a pinched spout on the right
    const body = `M${-rx} 0C${-rx} 30 -50 58 0 60C50 58 ${rx} 30 ${rx} 0C${rx + 16} -2 ${rx + 34} -10 ${rx + 46} -16C${rx + 30} 4 ${rx + 10} 12 ${rx - 4} 14Z`;
    g += `<path d="${body}" fill="url(#${p}-s${i})"/>`;
    // painted decoration: band, dot rows and petals
    g += `<path d="M${-rx + 4} 12C-50 30 50 30 ${rx - 4} 12" fill="none" stroke="${S.band}" stroke-width="9"/>`;
    let dots = '', dots2 = '', pet = '';
    for (let k = 0; k <= 16; k++) {
      const t = k / 16, xx = lerp(-rx + 10, rx - 10, t);
      const yy = 13 + Math.sin(t * PI) * 16;
      dots += `M${f(xx)} ${f(yy)}h.01`;
      const y2 = 30 + Math.sin(t * PI) * 18;
      if (k % 2 === 0 && k > 0 && k < 16) dots2 += `M${f(xx)} ${f(y2)}h.01`;
      if (k % 2 === 1 && k > 1 && k < 15) pet += `M${f(xx)} ${f(y2 - 6)}q5 7 0 14q-5-7 0-14Z`;
    }
    g += `<path d="${dots}" stroke="${S.dot}" stroke-width="4.4" stroke-linecap="round"/>`;
    g += `<path d="${pet}" fill="${S.acc}" stroke="${S.dot}" stroke-width="1.2"/>`;
    g += `<path d="${dots2}" stroke="${S.dot}" stroke-width="5.4" stroke-linecap="round"/>`;
    g += `<path d="${body}" fill="url(#${p}-shade)"/>`;
    // rim and oil
    g += `<ellipse rx="${rx}" ry="${ry}" fill="${S.body}" stroke="#2a120a" stroke-opacity=".35" stroke-width="2"/>`;
    g += `<ellipse cy="2" rx="${rx - 9}" ry="${ry - 6}" fill="url(#${p}-oil)"/>`;
    g += `<path d="M${-rx + 4} -4C-40 -20 40 -20 ${rx - 4} -4" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2.4"/>`;
    g += `<ellipse cx="-20" cy="-2" rx="26" ry="4" fill="#fff" opacity=".18"/>`;
    let rimDots = '';
    for (let k = 0; k < 22; k++) {
      const a = (k / 22) * TAU;
      rimDots += `M${f(Math.cos(a) * (rx - 4))} ${f(Math.sin(a) * (ry - 2))}h.01`;
    }
    g += `<path d="${rimDots}" stroke="${S.band}" stroke-width="3.4" stroke-linecap="round"/>`;
    // wick and flame at the spout
    const fx = rx + 34, fy = -12;
    g += `<path d="M${rx + 14} -6L${fx} ${fy}" stroke="#3a2412" stroke-width="4" stroke-linecap="round"/>`;
    g += `</g>`;
    // flame drawn upright (not mirrored) in page space
    const wx = x + (flip ? -1 : 1) * (rx + 34) * sc, wy = y + fy * sc;
    let fl = `<ellipse cx="${f(wx)}" cy="${f(wy - 30 * sc)}" rx="${f(150 * sc)}" ry="${f(150 * sc)}" fill="url(#${p}-glow)"/>`;
    const lean = rng.range(-4, 4);
    const fs = sc * 1.3;
    const fd = `M${f(wx)} ${f(wy + 4 * sc)}C${f(wx - 16 * fs)} ${f(wy - 4 * fs)} ${f(wx - 12 * fs)} ${f(wy - 30 * fs)} ${f(wx + lean * fs)} ${f(wy - 62 * fs)}C${f(wx + 12 * fs)} ${f(wy - 30 * fs)} ${f(wx + 16 * fs)} ${f(wy - 4 * fs)} ${f(wx)} ${f(wy + 4 * sc)}Z`;
    fl += `<path d="${fd}" fill="#ff9a3c" opacity=".7" filter="url(#${p}-b2)"/><path d="${fd}" fill="url(#${p}-fl)"/>`;
    fl += `<ellipse cx="${f(wx)}" cy="${f(wy - 8 * sc)}" rx="${f(4 * sc)}" ry="${f(8 * sc)}" fill="#7ab8ff" opacity=".5"/>`;
    return { g, fl };
  };
  const placements = [
    [230, 420, 1.08, 0, false], [500, 408, 1.05, 1, false], [760, 420, 1.08, 2, false],
    [140, 590, 1.32, 3, false], [480, 600, 1.38, 4, false], [850, 590, 1.32, 5, true],
  ];
  let pools = '', bodies = '', flames = '';
  for (const [x, y, sc, i, fl] of placements) {
    pools += `<ellipse cx="${x + (fl ? -60 : 60) * sc}" cy="${y + 52 * sc}" rx="${f(170 * sc)}" ry="${f(40 * sc)}" fill="url(#${p}-pool)"/>`;
    const d = diya(x, y, sc, i, fl);
    bodies += d.g;
    flames += d.fl;
  }
  // marigold petals and a flower on the table
  let pet = '';
  for (let k = 0; k < 18; k++) {
    const x = rng.range(40, 960), y = rng.range(680, 740), a = rng.range(0, 360);
    pet += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="7" ry="3.6" transform="rotate(${f(a)} ${f(x)} ${f(y)})" fill="${rng.pick(['#f39a1e', '#f6b42a', '#e8601e', '#d8342e'])}"/>`;
  }
  let mg = '';
  for (let r = 3; r >= 0; r--) for (let k = 0; k < 14; k++) {
    const a = (k / 14) * TAU + r * 0.3;
    mg += `<ellipse cx="${f(330 + Math.cos(a) * (6 + r * 7))}" cy="${f(706 + Math.sin(a) * (3 + r * 3.4))}" rx="7" ry="4" transform="rotate(${f((a * 180) / PI)} ${f(330 + Math.cos(a) * (6 + r * 7))} ${f(706 + Math.sin(a) * (3 + r * 3.4))})" fill="${['#f7c23a', '#f5a524', '#ef8a1a', '#e2701a'][r]}"/>`;
  }
  s += pools + `<g filter="url(#${p}-wb)">${bodies}${pet}${mg}</g>` + flames;
  s += `<rect width="${W}" height="${H}" fill="url(#${p}-vg)"/>`;
  s += `<rect width="${W}" height="${H}" filter="url(#${p}-gr)" opacity=".3"/>`;
  return svgDoc(W, H, defs, s);
};

/* ---------------- Lippan Art Mirror Panel ---------------- */
ART['lippan-mirror-panel.svg'] = (rng) => {
  const W = 900, H = 900, p = 'lx', C = 450, CY = 440, R = 360;
  const bd = studioBackdrop(p, W, H, '#ece6dc', '#d6ccbd');
  const clay = '#f4efe4';
  let defs = bd.defs +
    radGrad(`${p}-base`, [[0, '#2a7276'], [0.7, '#1d5a5e'], [1, '#13403f']], 0.42, 0.38, 0.75) +
    radGrad(`${p}-mir`, [[0, '#ffffff'], [0.35, '#d9e3e6'], [0.7, '#8e9ca2'], [1, '#4f5c62']], 0.35, 0.3, 0.75) +
    linGrad(`${p}-mird`, [[0, '#f4f8fa'], [0.45, '#9aa8ae'], [0.55, '#c8d3d6'], [1, '#56646a']], 0, 0, 1, 1) +
    linGrad(`${p}-lit`, [[0, '#fff', 0.18], [0.5, '#fff', 0], [1, '#000', 0.22]], 0.15, 0.1, 0.85, 0.9) +
    FX.blur(`${p}-sh`, 16, 40) +
    `<filter id="${p}-rel" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="5" result="t"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="t" scale="2.4" xChannelSelector="R" yChannelSelector="G" result="src"/>` +
    `<feGaussianBlur in="src" stdDeviation="1.6" result="b"/>` +
    `<feDiffuseLighting in="b" surfaceScale="2.4" diffuseConstant="1.1" lighting-color="#fff" result="dl"><feDistantLight azimuth="225" elevation="50"/></feDiffuseLighting>` +
    `<feComposite in="dl" in2="src" operator="in" result="dl2"/>` +
    `<feBlend in="src" in2="dl2" mode="multiply" result="sh"/>` +
    `<feSpecularLighting in="b" surfaceScale="2.4" specularConstant=".7" specularExponent="18" lighting-color="#fff" result="sp"><feDistantLight azimuth="225" elevation="50"/></feSpecularLighting>` +
    `<feComposite in="sp" in2="src" operator="in" result="sp2"/>` +
    `<feOffset in="src" dx="2.2" dy="3" result="o"/><feGaussianBlur in="o" stdDeviation="1.6" result="ob"/>` +
    `<feColorMatrix in="ob" values="0 0 0 0 0 0 0 0 0 .04 0 0 0 0 .05 0 0 0 .5 0" result="ds"/>` +
    `<feMerge><feMergeNode in="ds"/><feMergeNode in="sh"/><feMergeNode in="sp2"/></feMerge></filter>`;
  let s = bd.svg;
  s += `<circle cx="${C + 16}" cy="${CY + 26}" r="${R}" fill="#2a2018" opacity=".4" filter="url(#${p}-sh)"/>`;
  s += `<circle cx="${C}" cy="${CY}" r="${R}" fill="url(#${p}-base)"/>`;
  // ---- clay relief pattern (white) and mirrors
  let clayS = '', mir = '';
  const P = (r, a) => [C + Math.cos(a) * r, CY + Math.sin(a) * r];
  const ring = (r, w = 5.5) => `<circle cx="${C}" cy="${CY}" r="${r}" fill="none" stroke="${clay}" stroke-width="${w}"/>`;
  const mirror = (x, y, r) => {
    mir += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="url(#${p}-mir)"/>`;
    clayS += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r + 2.6)}" fill="none" stroke="${clay}" stroke-width="4.2"/>`;
  };
  const diamond = (x, y, r, a) => {
    const pts = [0, 1, 2, 3].map((k) => [x + Math.cos(a + (k * PI) / 2) * r * (k % 2 ? 0.6 : 1), y + Math.sin(a + (k * PI) / 2) * r * (k % 2 ? 0.6 : 1)]);
    mir += `<path d="${polyPath(pts)}" fill="url(#${p}-mird)"/>`;
    clayS += `<path d="${polyPath(pts)}" fill="none" stroke="${clay}" stroke-width="4" stroke-linejoin="round"/>`;
  };
  // centre medallion
  mirror(C, CY, 30);
  clayS += ring(42, 5);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    const [x, y] = P(64, a);
    diamond(x, y, 16, a);
  }
  clayS += ring(86, 5);
  // zigzag ring with mirrors in the triangles
  let zz = '';
  const nZ = 16;
  for (let k = 0; k <= nZ * 2; k++) {
    const [x, y] = P(k % 2 ? 140 : 92, (k / (nZ * 2)) * TAU);
    zz += (k ? 'L' : 'M') + `${f(x)} ${f(y)}`;
  }
  clayS += `<path d="${zz}" fill="none" stroke="${clay}" stroke-width="6" stroke-linejoin="round"/>`;
  for (let k = 0; k < nZ; k++) {
    const [x, y] = P(108, ((k + 0.5) / nZ) * TAU + PI / nZ - PI / nZ);
    mirror(x, y, 6.5);
    const [x2, y2] = P(126, (k / nZ) * TAU + PI / nZ);
    mirror(x2, y2, 5);
  }
  clayS += ring(146, 5);
  // arches with mirrors
  const nA = 20;
  let arch = '';
  for (let k = 0; k < nA; k++) {
    const a0 = (k / nA) * TAU, a1 = ((k + 1) / nA) * TAU, am = (a0 + a1) / 2;
    const [x0, y0] = P(150, a0), [x1, y1] = P(150, a1), [cx, cy] = P(206, am);
    arch += `M${f(x0)} ${f(y0)}Q${f(cx)} ${f(cy)} ${f(x1)} ${f(y1)}`;
    const [mx, my] = P(170, am);
    mirror(mx, my, 9);
    const [dx, dy] = P(192, a0);
    clayS += `<circle cx="${f(dx)}" cy="${f(dy)}" r="4" fill="${clay}"/>`;
  }
  clayS += `<path d="${arch}" fill="none" stroke="${clay}" stroke-width="6"/>`;
  clayS += ring(206) + ring(216, 4);
  // diamond band
  const nD = 28;
  for (let k = 0; k < nD; k++) {
    const a = (k / nD) * TAU;
    const [x, y] = P(240, a);
    diamond(x, y, 16, a);
    const [x2, y2] = P(240, a + PI / nD);
    clayS += `<circle cx="${f(x2)}" cy="${f(y2)}" r="3.4" fill="${clay}"/>`;
  }
  clayS += ring(264) + ring(274, 4);
  // chevrons pointing outward with small mirrors
  const nC = 36;
  let chev = '';
  for (let k = 0; k < nC; k++) {
    const a = (k / nC) * TAU, da = PI / nC;
    const [x0, y0] = P(282, a - da * 0.8), [x1, y1] = P(304, a), [x2, y2] = P(282, a + da * 0.8);
    chev += `M${f(x0)} ${f(y0)}L${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
    const [mx, my] = P(318, a + da);
    mirror(mx, my, 6);
  }
  clayS += `<path d="${chev}" fill="none" stroke="${clay}" stroke-width="5.5" stroke-linejoin="round"/>`;
  clayS += ring(332, 5);
  // scalloped outer rim
  let sc = '';
  const nS = 48;
  for (let k = 0; k < nS; k++) {
    const a0 = (k / nS) * TAU, a1 = ((k + 1) / nS) * TAU;
    const [x0, y0] = P(338, a0), [x1, y1] = P(338, a1), [cx, cy] = P(356, (a0 + a1) / 2);
    sc += `${k ? '' : `M${f(x0)} ${f(y0)}`}Q${f(cx)} ${f(cy)} ${f(x1)} ${f(y1)}`;
  }
  clayS += `<path d="${sc}" fill="none" stroke="${clay}" stroke-width="6"/>`;
  s += `<g filter="url(#${p}-rel)">${clayS}</g>`;
  s += mir;
  // mirror glints
  let gl = '';
  for (let k = 0; k < 26; k++) {
    const a = rng.range(0, TAU), r = rng.range(0, 330);
    const [x, y] = P(r, a);
    gl += `M${f(x - 3)} ${f(y)}h6M${f(x)} ${f(y - 3)}v6`;
  }
  s += `<path d="${gl}" stroke="#fff" stroke-width="1.2" opacity=".55"/>`;
  s += `<circle cx="${C}" cy="${CY}" r="${R}" fill="url(#${p}-lit)"/>`;
  s += `<circle cx="${C}" cy="${CY}" r="${R - 1}" fill="none" stroke="#0c2a2a" stroke-width="3" opacity=".5"/>`;
  s += bd.grain;
  return svgDoc(W, H, defs, s);
};


/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const filter = process.argv.slice(2);
  const names = Object.keys(ART).filter((n) => !filter.length || filter.some((q) => n.includes(q)));
  for (const name of names) {
    const svg = ART[name](makeRng(name));
    fs.writeFileSync(path.join(OUT_DIR, name), svg);
    console.log(`${name.padEnd(28)} ${(Buffer.byteLength(svg) / 1024).toFixed(1).padStart(6)} KB`);
  }
}

main();
