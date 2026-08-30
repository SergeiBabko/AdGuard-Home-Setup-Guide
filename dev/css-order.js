#!/usr/bin/env node
/*
  Cascade-equivalence checker for the stylesheet split.

      node dev/css-order.js snapshot &lt;out.json&gt; &lt;file...&gt;   record a rule sequence
      node dev/css-order.js compare  &lt;out.json&gt; &lt;file...&gt;   compare against a snapshot

  The split of styles.css into layer files must not change which declaration wins.
  A pixel diff would prove that, but needs a browser. This proves the stronger,
  checkable property instead:

    - the exact same set of (context, selector, property, value) declarations exists, and
    - no two declarations that could collide had their relative order reversed.

  Two rules can only collide if they declare a property in common inside the same
  at-rule context. So the check reports every such pair whose order flipped. An empty
  report means the cascade outcome is provably unchanged for every element.

  Dev-only. Nothing here ships with the page.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const norm = (s) => s.trim().replace(/\s+/g, ' ');

/*
  Flatten a stylesheet to an ordered list of declarations.
  Each entry: { ctx, sel, prop, val } where ctx is the enclosing at-rule chain
  (media/supports/layer), so rules in different contexts are never compared.
*/
function flatten(css, out, ctx) {
  let i = 0;
  const n = css.length;
  while (i < n) {
    // find the next '{'
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const head = norm(css.slice(i, open));

    // locate the matching '}'
    let depth = 1;
    let j = open + 1;
    while (j < n && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);

    if (head.startsWith('@')) {
      if (/^@(media|supports|layer|container)\b/.test(head)) {
        // Nested context: recurse. A bare "@layer a, b;" has no block and is skipped.
        flatten(body, out, ctx ? ctx + ' >> ' + head : head);
      }
      // @keyframes / @font-face: record wholesale, order within them is irrelevant here
      else out.push({ ctx: ctx || '', sel: head, prop: '@block', val: norm(body) });
    } else {
      for (const part of body.split(';')) {
        const k = part.indexOf(':');
        if (k < 0) continue;
        const prop = norm(part.slice(0, k));
        if (!prop || prop.startsWith('@')) continue;
        // guard against nested-block leftovers
        if (prop.includes('{') || prop.includes('}')) continue;
        out.push({ ctx: ctx || '', sel: head, prop, val: norm(part.slice(k + 1)) });
      }
    }
    i = j;
  }
}

function load(files) {
  const out = [];
  for (const f of files) {
    const p = path.resolve(ROOT, f);
    flatten(strip(fs.readFileSync(p, 'utf8')), out, '');
  }
  return out;
}

const key = (d) => `${d.ctx}|${d.sel}|${d.prop}`;
const full = (d) => `${key(d)}|${d.val}`;

/* ------------------------------------------------------------------- commands */

/*
  Specificity, approximately per the spec: [ids, classes/attrs/pseudo-classes, types].
  :where() contributes nothing; :is()/:not() take their most specific argument. Good
  enough to find cross-layer inversions, which is all it is used for.
*/
function specificity(sel) {
  let best = [0, 0, 0];
  for (const one of sel.split(',')) {
    let s = one.trim();
    if (!s) continue;
    s = s.replace(/:where\([^)]*\)/g, ''); // contributes zero
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const cls =
      (s.match(/\.[\w-]+/g) || []).length +
      (s.match(/\[[^\]]*\]/g) || []).length +
      (s.match(/:(?!:)[\w-]+/g) || []).length;
    const typ = (s.match(/(^|[\s>+~(])[a-zA-Z][\w-]*/g) || []).length + (s.match(/::[\w-]+/g) || []).length;
    const v = [ids, cls, typ];
    if (v[0] > best[0] || (v[0] === best[0] && (v[1] > best[1] || (v[1] === best[1] && v[2] > best[2])))) best = v;
  }
  return best;
}
const cmpSpec = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/*
  Two rules only compete if some element can match both. Comparing whole selectors is
  undecidable in general, but the *key compound* (the part after the last combinator)
  is a cheap and effective filter: ".eyebrow span" and ".seg" can never hit the same
  element, so their specificity ordering is irrelevant.
*/
function keyCompound(one) {
  const s = one.trim().split(/\s*[\s>+~]\s*/).pop() || '';
  return {
    classes: new Set((s.match(/\.[\w-]+/g) || []).map((c) => c.slice(1))),
    ids: new Set((s.match(/#[\w-]+/g) || []).map((c) => c.slice(1))),
    type: (s.match(/^[a-zA-Z][\w-]*/) || [''])[0].toLowerCase(),
  };
}

/*
  Rather than reason abstractly about whether two selectors *could* intersect, decide it
  against the real document: build an inventory of every element in index.html and ask
  whether any single one matches both key compounds. Attribute and pseudo-class parts are
  ignored, which only ever over-approximates (never misses a real collision).
*/
let INVENTORY = null;
function inventory() {
  if (INVENTORY) return INVENTORY;
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const els = [];
  for (const m of html.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const cls = (m[2].match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean);
    els.push({ tag: m[1].toLowerCase(), classes: new Set(cls) });
  }
  // script.js builds the dropdown at runtime, so those elements are not in the markup.
  els.push({ tag: 'span', classes: new Set(['dd']) });
  els.push({ tag: 'span', classes: new Set(['dd', 'open']) });
  els.push({ tag: 'button', classes: new Set(['dd-btn']) });
  els.push({ tag: 'div', classes: new Set(['dd-menu']) });
  els.push({ tag: 'div', classes: new Set(['dd-opt']) });
  INVENTORY = els;
  return els;
}

const matchesKey = (el, k) =>
  (!k.type || k.type === el.tag) && [...k.classes].every((c) => el.classes.has(c));

function mayCollide(selA, selB) {
  const els = inventory();
  for (const a of selA.split(',')) {
    for (const b of selB.split(',')) {
      if (!a.trim() || !b.trim()) continue;
      const ka = keyCompound(a);
      const kb = keyCompound(b);
      if (ka.ids.size && kb.ids.size && ![...ka.ids].some((x) => kb.ids.has(x))) continue;
      if (els.some((el) => matchesKey(el, ka) && matchesKey(el, kb))) return true;
    }
  }
  return false;
}

/*
  Report what would change if each file became a cascade layer, in file order.
  Layers beat specificity, so the only rules whose outcome can change are those where
  an EARLIER file has HIGHER specificity than a LATER file for the same property.
  Today the earlier one wins; under layers the later one would.
*/
function layerReport(fileDecls) {
  const issues = [];
  const groups = new Map(); // ctx|prop -> [{file, sel, spec}]
  fileDecls.forEach((d) => {
    const g = d.ctx + '|' + d.prop;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(d);
  });
  for (const [g, list] of groups) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.fileIdx >= b.fileIdx) continue; // same or later file: order already decides
        if (a.sel === b.sel) continue;
        if (!mayCollide(a.sel, b.sel)) continue; // cannot match the same element
        if (cmpSpec(specificity(a.sel), specificity(b.sel)) > 0) {
          issues.push(
            `  RISK   [${g.split('|')[1]}]  "${a.sel}" (${a.file}, spec ${specificity(a.sel)}) ` +
              `outranks "${b.sel}" (${b.file}, spec ${specificity(b.sel)}) today; layers would flip it`
          );
        }
      }
    }
  }
  return issues;
}

const [cmd, snapPath, ...files] = process.argv.slice(2);
if (!cmd || (cmd !== 'layers' && !snapPath) || (cmd === 'layers' && !snapPath)) {
  console.error('usage: node dev/css-order.js <snapshot|compare|layers> <out.json|-> <file...>');
  process.exit(2);
}

if (cmd === 'layers') {
  const all = [];
  const list = [snapPath, ...files];
  list.forEach((f, idx) => {
    const one = [];
    flatten(strip(fs.readFileSync(path.resolve(ROOT, f), 'utf8')), one, '');
    one.forEach((d) => all.push(Object.assign(d, { file: path.basename(f), fileIdx: idx })));
  });
  console.log('Cascade-layer safety check');
  console.log('  files (in layer order): ' + list.map((f) => path.basename(f)).join(' < '));
  const issues = layerReport(all);
  console.log('');
  if (!issues.length) console.log('  ok     wrapping these files in layers changes no outcome');
  else issues.forEach((s) => console.log(s));
  console.log(issues.length ? `\nRESULT: ${issues.length} rule(s) would change` : '\nRESULT: layering is safe');
  process.exit(issues.length ? 1 : 0);
}

const decls = load(files);

if (cmd === 'snapshot') {
  fs.writeFileSync(path.resolve(ROOT, snapPath), JSON.stringify(decls, null, 0));
  console.log(`snapshot: ${decls.length} declarations from ${files.length} file(s) -> ${snapPath}`);
  process.exit(0);
}

if (cmd !== 'compare') {
  console.error('unknown command: ' + cmd);
  process.exit(2);
}

const before = JSON.parse(fs.readFileSync(path.resolve(ROOT, snapPath), 'utf8'));
const after = decls;

console.log(`Cascade equivalence check`);
console.log(`  before: ${before.length} declarations`);
console.log(`  after:  ${after.length} declarations`);

let problems = 0;

/* 1. same multiset of declarations? */
const countBy = (arr, fn) => {
  const m = new Map();
  for (const d of arr) m.set(fn(d), (m.get(fn(d)) || 0) + 1);
  return m;
};
const bF = countBy(before, full);
const aF = countBy(after, full);

const missing = [];
const added = [];
for (const [k, c] of bF) if ((aF.get(k) || 0) < c) missing.push(k);
for (const [k, c] of aF) if ((bF.get(k) || 0) < c) added.push(k);

console.log('\n[1] declaration set');
if (!missing.length && !added.length) console.log('  ok     identical');
else {
  problems += missing.length + added.length;
  missing.slice(0, 20).forEach((k) => console.log('  LOST   ' + k));
  if (missing.length > 20) console.log(`  ...    ${missing.length - 20} more lost`);
  added.slice(0, 20).forEach((k) => console.log('  NEW    ' + k));
  if (added.length > 20) console.log(`  ...    ${added.length - 20} more new`);
}

/* 2. did any potentially-colliding pair reverse order? */
console.log('\n[2] order of colliding declarations');

// index positions per (ctx, prop) - only these can ever collide
function positions(arr) {
  const m = new Map();
  arr.forEach((d, i) => {
    const g = d.ctx + '|' + d.prop;
    if (!m.has(g)) m.set(g, []);
    m.get(g).push({ sel: d.sel, i });
  });
  return m;
}
const pb = positions(before);
const pa = positions(after);

let flips = 0;
const shown = [];
for (const [g, listB] of pb) {
  const listA = pa.get(g);
  if (!listA || listB.length < 2) continue;
  // rank each selector by its first appearance
  const rankA = new Map();
  listA.forEach((x, idx) => {
    if (!rankA.has(x.sel)) rankA.set(x.sel, idx);
  });
  for (let x = 0; x < listB.length; x++) {
    for (let y = x + 1; y < listB.length; y++) {
      const s1 = listB[x].sel;
      const s2 = listB[y].sel;
      if (s1 === s2) continue;
      const r1 = rankA.get(s1);
      const r2 = rankA.get(s2);
      if (r1 === undefined || r2 === undefined) continue;
      if (r1 > r2) {
        flips++;
        if (shown.length < 25) shown.push(`  FLIP   [${g.split('|')[1]}]  "${s1}"  was before  "${s2}"  - now after`);
      }
    }
  }
}
if (!flips) console.log('  ok     no colliding declaration changed relative order');
else {
  problems += flips;
  shown.forEach((s) => console.log(s));
  if (flips > shown.length) console.log(`  ...    ${flips - shown.length} more flips`);
}

console.log(
  problems
    ? `\nRESULT: ${problems} issue(s) - the split may change rendering`
    : '\nRESULT: cascade provably unchanged'
);
process.exit(problems ? 1 : 0);
