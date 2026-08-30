#!/usr/bin/env node
/*
  Design-system lint. Headless, no dependencies.

      node dev/lint.js

  Checks, in order:
    1. var(--x) references with no declaration anywhere  -> error
    2. declared tokens that nothing references            -> warning
    3. raw colour literals outside the token file         -> warning
    3b. relative url() assets that do not resolve         -> error
    4. blocklist markup integrity in index.html           -> error
    5. calculator data consistency vs the stated budget   -> report

  Dev-only. Nothing here ships with the page.
*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

let errors = 0;
let warnings = 0;
const err = (m) => (errors++, console.log('  ERROR  ' + m));
const warn = (m) => (warnings++, console.log('  warn   ' + m));

/* ------------------------------------------------------------------ inputs */

const CSS_CANDIDATES = [
  'styles/tokens.css',
  'styles/base.css',
  'styles/layout.css',
  'styles/components.css',
  'styles/overrides.css',
  'styles.css',
];
const cssFiles = CSS_CANDIDATES.map((f) => path.join(ROOT, f)).filter(fs.existsSync);

if (!cssFiles.length) {
  console.error('No stylesheets found.');
  process.exit(2);
}

// Comments are stripped before analysis; otherwise a commented-out hex reads as a real one
// and a "/* ... */ --foo:" reads as a property named "*/ --foo".
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const sources = cssFiles.map((f) => ({ file: f, text: strip(fs.readFileSync(f, 'utf8')) }));

// The token file is wherever tokens are allowed to hold literals. Falls back to the
// single stylesheet before the split happens.
const TOKEN_FILE = fs.existsSync(path.join(ROOT, 'styles/tokens.css')) ? 'styles/tokens.css' : 'styles.css';

console.log('Design-system lint');
console.log('  sources: ' + cssFiles.map(rel).join(', '));
console.log('  token file: ' + TOKEN_FILE);

/* ------------------------------------------------------- 0: CSS syntax sanity */

//
// A stray comment-close marker after an already-closed comment leaves prose sitting at
// declaration level. The CSS parser recovers at the next semicolon, silently eating the
// declaration that followed - which is exactly how --state-hover once vanished while
// every other check still passed, because the token name was still present in the text.
//
console.log('\n[0] stylesheet syntax');
let syntax = 0;
for (const { file } of sources) {
  const raw = fs.readFileSync(file, 'utf8');

  // unbalanced comment markers
  const opens = (raw.match(/\/\*/g) || []).length;
  const closes = (raw.match(/\*\//g) || []).length;
  if (opens !== closes) {
    syntax++;
    err(`${rel(file)} has ${opens} '/*' but ${closes} '*/'`);
  }
  // a close marker that is not preceded by an open one
  let depth = 0;
  for (let i = 0; i < raw.length - 1; i++) {
    if (raw[i] === '/' && raw[i + 1] === '*') {
      depth++;
      i++;
    } else if (raw[i] === '*' && raw[i + 1] === '/') {
      depth--;
      i++;
      if (depth < 0) {
        syntax++;
        err(`${rel(file)}:${raw.slice(0, i).split('\n').length} stray '*/' outside a comment`);
        depth = 0;
      }
    }
  }

  // braces
  const s = strip(raw);
  let d = 0;
  let min = 0;
  for (const c of s) {
    if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (d < min) min = d;
    }
  }
  if (d !== 0 || min < 0) {
    syntax++;
    err(`${rel(file)} brace balance ${d} (min depth ${min})`);
  }

  // Text sitting at declaration level. Checked per declaration rather than per line,
  // because a `transition:` value legitimately spans several lines. Only innermost
  // blocks are inspected, so nested at-rules do not confuse it.
  const body = /\{([^{}]*)\}/g;
  let blk;
  while ((blk = body.exec(s))) {
    for (const chunk of blk[1].split(';')) {
      const t = chunk.trim();
      if (!t) continue;
      if (/^[-a-zA-Z_*][\w-]*\s*:/.test(t)) continue; // a normal declaration
      syntax++;
      const line = s.slice(0, blk.index + blk[1].indexOf(chunk)).split('\n').length;
      err(`${rel(file)}:~${line} not a declaration: ${t.replace(/\s+/g, ' ').slice(0, 60)}`);
    }
  }
}
if (!syntax) console.log('  ok     comments, braces and declarations well formed');

/* ------------------------------------------- 1 & 2: token declarations vs uses */

const declared = new Map(); // name -> [file...]
const used = new Map(); // name -> [file...]

for (const { file, text } of sources) {
  for (const m of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
    if (!declared.has(m[1])) declared.set(m[1], []);
    declared.get(m[1]).push(rel(file));
  }
  for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    if (!used.has(m[1])) used.set(m[1], []);
    used.get(m[1]).push(rel(file));
  }
}

// Tokens the JS sets at runtime rather than in CSS.
const RUNTIME_TOKENS = new Set(['--navh', '--nav-h']);

console.log('\n[1] unresolved var() references');
let unresolved = 0;
for (const [name, files] of used) {
  if (declared.has(name) || RUNTIME_TOKENS.has(name)) continue;
  // A var() with a fallback is survivable, but still worth naming.
  unresolved++;
  err(`${name} used in ${[...new Set(files)].join(', ')} but never declared`);
}
if (!unresolved) console.log('  ok     every var() resolves');

console.log('\n[2] declared but unreferenced tokens');
// A design system legitimately declares its whole vocabulary up front, so unreferenced
// tokens in the token file are counted, not scolded. Anywhere else they are dead weight.
let dead = 0;
let unusedSystem = 0;
for (const [name, files] of declared) {
  if (used.has(name) || RUNTIME_TOKENS.has(name)) continue;
  const only = [...new Set(files)];
  if (only.length === 1 && only[0] === TOKEN_FILE) {
    unusedSystem++;
    continue;
  }
  dead++;
  warn(`${name} declared in ${only.join(', ')} but never used`);
}
if (!dead) console.log('  ok     no dead tokens outside ' + TOKEN_FILE);
if (unusedSystem) console.log(`  info   ${unusedSystem} token(s) declared in ${TOKEN_FILE} not yet consumed`);

/* ------------------------------- 2b: reference ramps must stay inside the token file */

// Layer 0 is raw material. A component reaching past the semantic roles into a specific
// tone means a role is missing, and it silently breaks theming: a tone is one fixed
// colour, where a role resolves per scheme.
console.log('\n[2b] reference-ramp leakage');
const RAMP = /var\(\s*--(p|n|nv|ok|warn|err)-\d+\s*\)/g;
let leaks = 0;
for (const { file, text } of sources) {
  if (rel(file) === TOKEN_FILE) continue;
  text.split('\n').forEach((line, i) => {
    const hits = line.match(RAMP);
    if (!hits) return;
    leaks++;
    err(`${rel(file)}:${i + 1} uses ${hits.join(' ')} directly - use a semantic role`);
  });
}
if (!leaks) console.log('  ok     components use semantic roles only');

/* ------------------------------------------------ 3: colour literals outside tokens */

console.log('\n[3] raw colour literals outside ' + TOKEN_FILE);
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\boklab\(/g;

// Literals that are legitimately not theme colours.
const ALLOWED_LINE = /transparent|currentColor|scrollbar-color|forced-color|SYSTEM-OK/;

let literals = 0;
for (const { file, text } of sources) {
  if (rel(file) === TOKEN_FILE) continue;
  text.split('\n').forEach((line, i) => {
    COLOUR.lastIndex = 0;
    const hits = line.match(COLOUR);
    if (!hits) return;
    if (ALLOWED_LINE.test(line)) return;
    literals++;
    warn(`${rel(file)}:${i + 1}  ${hits.join(' ')}  -> ${line.trim().slice(0, 72)}`);
  });
}
if (!literals) console.log('  ok     no stray colour literals');

/* --------------------------------------------------- 3b: asset url() targets */

// A url() resolves against the STYLESHEET, not the document, so moving a rule between
// files silently repoints every relative asset in it. That is exactly how the hero icon
// disappeared: the rule moved from /styles.css to /styles/layout.css and kept asking for
// "favicon.ico", which now meant /styles/favicon.ico. Nothing failed - the background
// just painted nothing, in one 16px square.
console.log('');
console.log('[3b] asset url() targets');
let assets = 0;
let broken = 0;
for (const f of cssFiles) {
  const dir = path.dirname(f);
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const ref = m[1].trim();
    if (/^(data:|https?:|#)/i.test(ref)) continue; // inline, remote or an SVG fragment
    assets++;
    if (!fs.existsSync(path.resolve(dir, ref.split('?')[0].split('#')[0]))) {
      broken++;
      err(`${rel(f)}: url("${ref}") does not resolve (looked in ${rel(dir)}/)`);
    }
  }
}
if (!assets) console.log('  ok     no relative url() assets');
else if (!broken) console.log(`  ok     all ${assets} relative url() asset(s) resolve`);

/* ------------------------------------------------------- 4: markup integrity */

console.log('\n[4] blocklist markup integrity');
const htmlPath = path.join(ROOT, 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const rows = [...html.matchAll(/<tr\b([^>]*\bdata-rules=[^>]*)>/g)].map((m) => m[1]);
const attr = (s, n) => {
  const m = s.match(new RegExp(n + '="([^"]*)"'));
  return m ? m[1] : null;
};

console.log(`  info   ${rows.length} blocklist rows found`);
let bad = 0;
rows.forEach((a, i) => {
  for (const need of ['data-rules', 'data-ram', 'data-i', 'data-nm']) {
    if (attr(a, need) === null) {
      bad++;
      err(`row ${i} is missing ${need}`);
    }
  }
});
if (!bad) console.log('  ok     every row carries data-rules, data-ram, data-i, data-nm');

// Accessible-name check on the 58 switches.
const switches = [...html.matchAll(/<label class="sw">\s*<input type="checkbox"([^>]*)>/g)].map((m) => m[1]);
const unnamed = switches.filter((a) => !/aria-label=|aria-labelledby=|\bid=/.test(a)).length;
if (unnamed) warn(`${unnamed} of ${switches.length} switches have no accessible name`);
else if (switches.length) console.log(`  ok     all ${switches.length} switches have an accessible name`);

// Column-count consistency: data-cols labels vs <td> per row.
let colMismatch = 0;
for (const t of html.matchAll(/<table\b[^>]*data-cols="([^"]*)"[^>]*>([\s\S]*?)<\/table>/g)) {
  const want = t[1].split('|').length;
  const body = t[2];
  const bodyRows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].slice(1); // skip header row
  bodyRows.forEach((r) => {
    const tds = (r[1].match(/<td\b/g) || []).length;
    if (tds && tds !== want) {
      colMismatch++;
      if (colMismatch <= 5) err(`table "${t[1].slice(0, 40)}..." expects ${want} cells, a row has ${tds}`);
    }
  });
}
if (!colMismatch) console.log('  ok     every row cell count matches its data-cols header');
else if (colMismatch > 5) console.log(`  ...    ${colMismatch - 5} more column mismatches`);

// data-rules is the single source of truth for a blocklist row. data-ram and both visible
// cells are views of it, all three derived by dev/registry.js from the same 102 B/rule
// constant the footer states. Hand-editing one and not the others is exactly how the
// Smart-TV row came to render 159 rules as "0.01 MB" when the arithmetic says 0.02, so
// the agreement is asserted here rather than left to whoever edits next.
const { ramAttr, ramCell, rulesCell } = require('./registry.js');
let derived = 0;
for (const m of html.matchAll(/<tr\s+([^>]*data-rules[^>]*)>([\s\S]*?)<\/tr>/g)) {
  const n = Number(attr(m[1], 'data-rules'));
  const bigs = [...m[2].matchAll(/<span class="big">([\s\S]*?)<\/span>/g)].map((x) => x[1]);
  const name = attr(m[1], 'data-nm');
  const want = [ramAttr(n), rulesCell(n), `${ramCell(n)}<i>MB</i>`];
  const got = [attr(m[1], 'data-ram'), bigs[0], bigs[1]];
  for (let i = 0; i < 3; i++) {
    if (got[i] !== want[i]) {
      derived++;
      err(`${name}: ${['data-ram', 'rules cell', 'memory cell'][i]} is ${JSON.stringify(got[i])}, ` +
          `but ${n} rules derives ${JSON.stringify(want[i])}`);
    }
  }
}
if (!derived) console.log('  ok     every row\'s memory and rules cells are derived from its data-rules');

/* --------------------------------------------------- 4b: scroll-spy integrity */

// The pill nav and the sidebar both drive the spy through data-spy. A typo here fails
// silently at runtime: the link simply never highlights.
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const spies = [...html.matchAll(/data-spy="([^"]+)"/g)].map((m) => m[1]);
const spyTargets = [...new Set(spies)];
const orphanSpies = spyTargets.filter((s) => !ids.has(s));
if (orphanSpies.length) orphanSpies.forEach((s) => err(`data-spy="${s}" has no matching element id`));
else console.log(`  ok     ${spies.length} spy links across ${spyTargets.length} targets all resolve`);

/* ---------------------------------------------- 5: calculator data consistency */

console.log('\n[5] calculator data');
const checkedRows = [...html.matchAll(/<tr\b([^>]*\bdata-rules=[^>]*)>([\s\S]*?)<\/tr>/g)].filter((m) =>
  /<input type="checkbox" checked/.test(m[2])
);
const sum = (arr, k) => arr.reduce((s, m) => s + parseFloat(attr(m[1], k) || 0), 0);
const totalRules = sum(checkedRows, 'data-rules');
const totalRam = sum(checkedRows, 'data-ram');

// Mirrors the BUD table in script.js: RAM -> [lean, typical, loaded]
const BUDGET_512_TYPICAL = 233;
console.log(`  info   ${checkedRows.length} lists preselected`);
console.log(`  info   ${totalRules.toLocaleString('en-US')} rules, ${Math.round(totalRam)} MB`);
if (checkedRows.length) {
  const fits = totalRam <= BUDGET_512_TYPICAL;
  console.log(
    `  ${fits ? 'ok    ' : 'warn  '} default selection ${fits ? 'fits' : 'EXCEEDS'} the 512 MB / Typical budget of ${BUDGET_512_TYPICAL} MB`
  );
  if (!fits) warnings++;
}

/* -------------------------------------------------------------------- result */

console.log(`\nRESULT: ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
