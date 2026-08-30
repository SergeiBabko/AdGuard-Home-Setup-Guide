#!/usr/bin/env node
/*
  Headless WCAG contrast gate for the design tokens.

  Reads the project's CSS, collects every custom property declared on :root, resolves
  var() chains and light-dark() per theme, then scores the semantic pairs.
  Exits non-zero if any required pair fails, so it works as a check in any stage.

      node dev/contrast-check.js                  # auto-discovers the stylesheets
      node dev/contrast-check.js styles.css       # or name them explicitly

  Dev-only. Nothing here ships with the page, and index.html never references it.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function discoverFiles(argv) {
  if (argv.length) return argv.map((f) => path.resolve(ROOT, f));
  const found = [];
  // tokens first so later files can override, mirroring the <link> order in index.html
  for (const f of [
    'styles/tokens.css',
    'styles/base.css',
    'styles/layout.css',
    'styles/components.css',
    'styles/overrides.css',
    'styles.css',
  ]) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) found.push(p);
  }
  return found;
}

/* ------------------------------------------------------------------ parsing */

// A leading /* ... */ inside a block would otherwise be read as part of the next
// property name, silently dropping the first declaration of every block.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/*
  Walk blocks with real brace matching and carry the enclosing at-rule chain.

  A regex cannot do this: given `@supports not (...) { :root { ... } }` it happily
  reports the inner `:root` as a top-level rule, which silently fed the light-only
  fallback values into BOTH theme maps and made the dark audit a copy of the light one.
*/
function eachBlock(src, fn, ctx) {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim().replace(/\s+/g, ' ');
    let depth = 1;
    let j = open + 1;
    while (j < n && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith('@')) eachBlock(body, fn, ctx ? ctx + ' ' + head : head);
    else fn(head, body, ctx || '');
    i = j;
  }
}

function decls(body) {
  const out = {};
  // Split on ';' at depth 0 so values containing ';'-free but ','-heavy functions survive.
  for (const part of body.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k.startsWith('--')) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

/*
  Build one token map per theme.

  Two theming styles are supported so this keeps working across the migration:
    old - separate :root[data-theme="dark"] / prefers-color-scheme blocks
    new - a single declaration using light-dark(lightValue, darkValue)
*/
function buildMaps(files) {
  const light = {};
  const dark = {};
  for (const file of files) {
    const css = stripComments(fs.readFileSync(file, 'utf8'));
    eachBlock(css, (sel, body, ctx) => {
      if (!sel.includes(':root') && !sel.includes('html')) return;
      // The light-dark() fallback block is for engines that cannot run the real token
      // set. Auditing it would audit a page nobody modern sees, so skip it here.
      if (/@supports\s+not/.test(ctx)) return;
      // Preference-conditional blocks are audited separately, not folded into the base.
      if (/prefers-contrast|forced-colors|prefers-reduced/.test(ctx)) return;
      const d = decls(body);
      if (!Object.keys(d).length) return;
      const isDarkOnly =
        sel.includes('[data-theme="dark"]') ||
        sel.includes(':not([data-theme="light"])') ||
        /prefers-color-scheme:\s*dark/.test(ctx);
      const isLightOnly = sel.includes('[data-theme="light"]') && !sel.includes(':not(');
      if (isDarkOnly) Object.assign(dark, d);
      else if (isLightOnly) Object.assign(light, d);
      else {
        Object.assign(light, d);
        Object.assign(dark, d);
      }
    });
  }
  return { light, dark };
}

/* --------------------------------------------------------------- resolution */

// Split "a, b" at the top level, respecting nested parens.
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function inner(v, fnName) {
  const i = v.toLowerCase().indexOf(fnName + '(');
  if (i !== 0) return null;
  let depth = 0;
  for (let j = i + fnName.length; j < v.length; j++) {
    if (v[j] === '(') depth++;
    else if (v[j] === ')') {
      depth--;
      if (depth === 0) return v.slice(i + fnName.length + 1, j);
    }
  }
  return null;
}

function resolve(map, value, theme, depth = 0) {
  if (value == null || depth > 20) return value;
  let v = String(value).trim();

  const ld = inner(v, 'light-dark');
  if (ld !== null) {
    const args = splitArgs(ld);
    return resolve(map, theme === 'dark' ? args[1] : args[0], theme, depth + 1);
  }

  const va = inner(v, 'var');
  if (va !== null) {
    const args = splitArgs(va);
    const next = map[args[0]];
    if (next === undefined) return args.length > 1 ? resolve(map, args[1], theme, depth + 1) : null;
    return resolve(map, next, theme, depth + 1);
  }

  return v;
}

/* -------------------------------------------------------------- colour math */

function toRGBA(v) {
  if (!v) return null;
  v = String(v).trim();
  let m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: parseInt(h.slice(6, 8), 16) / 255,
    };
  }
  m = v.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1]
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(parseFloat);
    if (p.length < 3 || p.slice(0, 3).some(isNaN)) return null;
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 && !isNaN(p[3]) ? p[3] : 1 };
  }
  return null;
}

const over = (fg, bg) =>
  fg.a >= 1
    ? fg
    : {
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      };

const lum = (c) =>
  [c.r, c.g, c.b]
    .map((v) => ((v /= 255), v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);

function ratio(f, b) {
  let a = lum(f);
  let c = lum(b);
  if (a < c) [a, c] = [c, a];
  return (a + 0.05) / (c + 0.05);
}

/* ------------------------------------------------------------------- pairs */

/*
  The three surfaces text actually lands on: the page itself, a card, and the tinted
  container used by pills, code blocks and the nav.
*/
const SURFACES = ['--page', '--surface-container-lowest', '--surface-container'];

// Must clear 4.5:1 — real text on a real background.
const TEXT = [
  // the three label tiers, each against every surface they can appear on
  ...['--label', '--label-2', '--label-3'].flatMap((fg) => SURFACES.map((bg) => [fg, bg])),
  // accent text: links, active nav, the rule-card numerals
  ...SURFACES.map((bg) => ['--primary', bg]),
  // status text
  ...SURFACES.map((bg) => ['--success', bg]),
  ...SURFACES.map((bg) => ['--caution', bg]),
  ...SURFACES.map((bg) => ['--error', bg]),
  // every container role against the on- role that is meant to sit on it
  ['--on-primary', '--primary'],
  ['--on-primary-container', '--primary-container'],
  ['--on-success-container', '--success-container'],
  ['--on-caution-container', '--caution-container'],
  ['--on-error-container', '--error-container'],
  // Selected and over-budget table rows. These carry ordinary row text, not on-container
  // text, so the quiet large-area tones have to clear 4.5:1 against the normal label
  // tiers - which is the whole reason they cannot simply be nudged until they look nice.
  ['--label', '--success-surface', '--surface-container-lowest'],
  ['--label-2', '--success-surface', '--surface-container-lowest'],
  ['--label-3', '--success-surface', '--surface-container-lowest'],
  ['--label', '--error-surface', '--surface-container-lowest'],
  ['--label-2', '--error-surface', '--surface-container-lowest'],
  ['--label-3', '--error-surface', '--surface-container-lowest'],
  ['--on-error-container', '--error-surface', '--surface-container-lowest'],
  ['--primary', '--success-surface', '--surface-container-lowest'],
];

// Must clear 3:1 — meaningful non-text: borders that carry state, meter fills, focus rings.
const UI = [
  ['--outline', '--page'],
  ['--outline', '--surface-container-lowest'],
  ['--outline', '--surface-container'],
  ['--focus-ring', '--page'],
  ['--focus-ring', '--surface-container-lowest'],
  ['--thumb', '--page'], // a scrollbar thumb indicates position, so it is a real control
  ['--success', '--fill-2'], // the meter fill against its groove
  ['--error', '--fill-2'],
];

// Reported but never fatal: decorative boundaries and the surface ladder, which carry
// no contrast requirement. M3 is explicit that outline-variant has no guarantee, and a
// divider is not an affordance - unlike --outline above, which bounds real controls.
const INFO = [
  ['--surface-container-lowest', '--page'],
  ['--surface-container', '--page'],
  ['--surface-container-high', '--page'],
  ['--surface-container-highest', '--page'],
  ['--outline-variant', '--surface-container-lowest'],
  ['--separator', '--surface-container-lowest'],
  ['--separator-opaque', '--surface-container-lowest'],
];

/*
  If the token vocabulary is renamed and these lists are not updated, every pair silently
  drops out and the gate passes while checking almost nothing. This is the guard against
  that: it caught exactly that failure once already.
*/
const MIN_TEXT_PAIRS = 24;

/* -------------------------------------------------------------- self-test */

function selfTest() {
  const W = { r: 255, g: 255, b: 255, a: 1 };
  const K = { r: 0, g: 0, b: 0, a: 1 };
  const cases = [
    ['black on white', ratio(K, W), 21.0],
    ['#767676 on white', ratio(toRGBA('#767676'), W), 4.54],
    ['#949494 on black', ratio(toRGBA('#949494'), K), 6.92],
    ['50% black over white', ratio(over(toRGBA('rgba(0,0,0,0.5)'), W), W), 3.98],
  ];
  let ok = true;
  for (const [name, got, want] of cases) {
    const pass = Math.abs(got - want) < 0.02;
    if (!pass) {
      ok = false;
      console.log(`  FAIL self-test ${name}: ${got.toFixed(2)} expected ~${want}`);
    }
  }
  return ok;
}

/* ------------------------------------------------------------------- main */

const files = discoverFiles(process.argv.slice(2));
if (!files.length) {
  console.error('No stylesheets found.');
  process.exit(2);
}

console.log('Contrast gate');
console.log('  sources: ' + files.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).join(', '));

if (!selfTest()) {
  console.error('  colour maths self-test FAILED - aborting');
  process.exit(2);
}
console.log('  colour maths self-test ok');

const maps = buildMaps(files);
let hardFailures = 0;

for (const theme of ['light', 'dark']) {
  const map = maps[theme];
  const val = (k) => (map[k] === undefined ? null : toRGBA(resolve(map, map[k], theme)));
  // What a translucent colour is ultimately flattened onto: the page itself.
  const base = val('--page') || val('--surface-container-lowest') || { r: 255, g: 255, b: 255, a: 1 };

  console.log(`\n${theme.toUpperCase()}  (${Object.keys(map).length} tokens declared)`);

  let textPairsChecked = 0;
  for (const [label, pairs, min, fatal] of [
    ['text', TEXT, 4.5, true],
    ['ui', UI, 3, true],
    ['info', INFO, 3, false],
  ]) {
    const rows = [];
    for (const [f, b, under3] of pairs) {
      const fv = val(f);
      const bv = val(b);
      if (!fv || !bv) continue; // token not present in this token set
      // A pair may name a third token: the surface it actually sits on. It matters only
      // for translucent backgrounds - composing a 10% tint over --page when the real
      // backdrop is a white card gives a ratio the user never sees.
      const under = (under3 && val(under3)) || base;
      const bg = over(bv, under);
      const fg = over(fv, bg);
      const r = ratio(fg, bg);
      rows.push({ f, b, r, ok: r >= min });
    }
    if (!rows.length) continue;
    if (label === 'text') textPairsChecked = rows.length;
    rows.sort((a, b) => a.r - b.r);
    const bad = rows.filter((x) => !x.ok);
    if (fatal) hardFailures += bad.length;
    const head = fatal
      ? bad.length
        ? `${bad.length} FAILING`
        : 'all pass'
      : `${bad.length} below ${min}:1 (informational)`;
    console.log(`  [${label}] ${rows.length} pairs, min ${min}:1 - ${head}`);
    for (const x of rows) {
      const mark = x.ok ? '   ok ' : fatal ? '  FAIL' : '  note';
      if (!x.ok || process.env.VERBOSE) console.log(`${mark} ${x.f} on ${x.b} = ${x.r.toFixed(2)}:1`);
    }
  }

  // A rename in tokens.css drops every pair whose name changed. Without this the gate
  // would keep reporting "all pass" while checking almost nothing.
  if (textPairsChecked < MIN_TEXT_PAIRS) {
    console.log(
      `  FAIL   only ${textPairsChecked} text pairs resolved, expected at least ${MIN_TEXT_PAIRS}.` +
        ` Token names in this file are stale.`
    );
    hardFailures++;
  }
}

console.log(
  hardFailures ? `\nRESULT: ${hardFailures} required pair(s) failing` : '\nRESULT: all required pairs pass'
);
process.exit(hardFailures ? 1 : 0);
