// Generate M3-style tonal ramps in OKLCH from a set of source colours.
// Self-tests the colour conversions before emitting anything.
'use strict';

/* ---------------- sRGB <-> OKLab/OKLCH ---------------- */

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

function rgbToOklab(r, g, b) {
  r = srgbToLin(r / 255);
  g = srgbToLin(g / 255);
  b = srgbToLin(b / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb(L, A, B) {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ * l_ * l_,
    m = m_ * m_ * m_,
    s = s_ * s_ * s_;
  return {
    r: linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const inGamut = (c) => c.r >= -0.0001 && c.r <= 1.0001 && c.g >= -0.0001 && c.g <= 1.0001 && c.b >= -0.0001 && c.b <= 1.0001;

// Reduce chroma until the colour fits sRGB, the same idea browsers use for out-of-gamut oklch.
function toHex(L, C, H) {
  let c = C;
  let rgb;
  for (let i = 0; i < 200; i++) {
    const h = (H * Math.PI) / 180;
    rgb = oklabToRgb(L, c * Math.cos(h), c * Math.sin(h));
    if (inGamut(rgb)) break;
    c -= 0.002;
    if (c < 0) {
      c = 0;
      rgb = oklabToRgb(L, 0, 0);
      break;
    }
  }
  const f = (v) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return { hex: '#' + f(rgb.r) + f(rgb.g) + f(rgb.b), chroma: c };
}

function hexToOklch(hex) {
  const r = parseInt(hex.slice(1, 3), 16),
    g = parseInt(hex.slice(3, 5), 16),
    b = parseInt(hex.slice(5, 7), 16);
  const { L, a, b: bb } = rgbToOklab(r, g, b);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C: Math.sqrt(a * a + bb * bb), H };
}

/* ---------------- self-test ---------------- */
console.log('--- conversion self-test (hex -> oklch -> hex round trip) ---');
let ok = true;
for (const h of ['#5457d6', '#ffffff', '#000000', '#ff3b30', '#34c759', '#6750a4']) {
  const { L, C, H } = hexToOklch(h);
  const back = toHex(L, C, H).hex;
  const good = back.toLowerCase() === h.toLowerCase();
  if (!good) ok = false;
  console.log(`${good ? 'ok  ' : 'FAIL'} ${h} -> oklch(${(L * 100).toFixed(1)}% ${C.toFixed(3)} ${H.toFixed(1)}) -> ${back}`);
}
if (!ok) {
  console.log('conversions are wrong, aborting');
  process.exit(1);
}

/* ---------------- WCAG helper ---------------- */
const lum = (hex) => {
  const v = [1, 3, 5].map((i) => srgbToLin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => {
  let x = lum(a),
    y = lum(b);
  if (x < y) [x, y] = [y, x];
  return (x + 0.05) / (y + 0.05);
};

/* ---------------- ramps ---------------- */

// M3 tone == CIE L*. Convert an L* target to the OKLab L that renders it, by solving
// for the neutral grey of that L* and reading its OKLab lightness.
function lstarToOklabL(lstar) {
  // L* -> relative luminance Y
  const y = lstar > 8 ? Math.pow((lstar + 16) / 116, 3) : lstar / 903.3;
  // neutral grey of luminance y -> OKLab L
  const c = linToSrgb(y) * 255;
  return rgbToOklab(c, c, c).L;
}

const TONES = [0, 4, 6, 10, 12, 17, 20, 22, 24, 30, 40, 50, 60, 70, 80, 87, 90, 92, 94, 95, 96, 98, 99, 100];

// Chroma taper: full chroma mid-ramp, easing off toward both ends the way M3 does.
function chromaFor(base, lstar) {
  const t = lstar / 100;
  const peak = 1 - Math.pow(Math.abs(t - 0.55) / 0.55, 1.6);
  return base * Math.max(0, peak);
}

const RAMPS = {
  // name, source hex, chroma multiplier
  p: { src: '#5457d6', mul: 1.0, label: 'primary / indigo' },
  n: { src: '#5457d6', mul: 0.06, label: 'neutral (faintly indigo-tinted)' },
  nv: { src: '#5457d6', mul: 0.14, label: 'neutral-variant' },
  ok: { src: '#1e9e4a', mul: 1.0, label: 'success / green' },
  warn: { src: '#c07000', mul: 1.0, label: 'warning / amber' },
  err: { src: '#d3352f', mul: 1.0, label: 'error / red' },
};

const out = {};
console.log('\n--- ramps ---');
for (const [key, r] of Object.entries(RAMPS)) {
  const { C, H } = hexToOklch(r.src);
  out[key] = {};
  const parts = [];
  for (const t of TONES) {
    const L = lstarToOklabL(t);
    const c = chromaFor(C * r.mul, t);
    const res = toHex(L, c, H);
    out[key][t] = { hex: res.hex, L, C: res.chroma, H };
    parts.push(`${t}:${res.hex}`);
  }
  console.log(`\n${key} (${r.label}, hue ${H.toFixed(1)})`);
  console.log('  ' + parts.join(' '));
}

/* ---------------- role check ---------------- */
console.log('\n--- role contrast (M3 tone assignments) ---');
const L = (k, t) => out[k][t].hex;
const rows = [
  ['light on-primary/primary', L('p', 100), L('p', 40)],
  ['light on-primary-container/container', L('p', 30), L('p', 90)],
  ['light on-surface/surface', L('n', 10), L('n', 98)],
  ['light on-surface-variant/surface', L('nv', 30), L('n', 98)],
  ['light on-surface-variant/surface-container', L('nv', 30), L('n', 94)],
  ['light outline/surface', L('nv', 50), L('n', 98)],
  ['light primary/surface', L('p', 40), L('n', 98)],
  ['light ok/surface', L('ok', 40), L('n', 98)],
  ['light warn/surface', L('warn', 40), L('n', 98)],
  ['light err/surface', L('err', 40), L('n', 98)],
  ['dark on-primary/primary', L('p', 20), L('p', 80)],
  ['dark on-primary-container/container', L('p', 90), L('p', 30)],
  ['dark on-surface/surface', L('n', 90), L('n', 6)],
  ['dark on-surface-variant/surface', L('nv', 80), L('n', 6)],
  ['dark on-surface-variant/surface-container', L('nv', 80), L('n', 12)],
  ['dark outline/surface', L('nv', 60), L('n', 6)],
  ['dark primary/surface', L('p', 80), L('n', 6)],
  ['dark ok/surface', L('ok', 80), L('n', 6)],
  ['dark warn/surface', L('warn', 80), L('n', 6)],
  ['dark err/surface', L('err', 80), L('n', 6)],
];
let bad = 0;
for (const [name, fg, bg] of rows) {
  const r = ratio(fg, bg);
  const min = name.includes('outline') ? 3 : 4.5;
  const pass = r >= min;
  if (!pass) bad++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name.padEnd(42)} ${fg} on ${bg} = ${r.toFixed(2)}:1 (min ${min})`);
}
console.log(bad ? `\n${bad} role pair(s) failing` : '\nall role pairs pass');

require('fs').writeFileSync(
  'C:/Users/babko/.claude/jobs/608898af/tmp/ramps.json',
  JSON.stringify(
    Object.fromEntries(
      Object.entries(out).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([t, o]) => [t, o]))])
    ),
    null,
    1
  )
);
console.log('\nwrote ramps.json');
