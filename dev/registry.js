"use strict";
//
// Shared helpers for the two refresh scripts. Nothing here ships; dev/ is not deployed.
//
// The one rule this file exists to enforce: list content is NEVER written to disk. The
// four big lists are 5-43 MB each and the whole registry is ~120 MB, so a cache would be
// both a git accident waiting to happen and a stale-data source. Lists are streamed and
// counted as the bytes arrive, then discarded.

const REGISTRY = "https://adguardteam.github.io/HostlistsRegistry/assets/filters.json";

// Memory per rule, in bytes. Measured on an OpenWrt router; the page's footer says so and
// every Memory cell is derived from it, so it lives in exactly one place.
const BYTES_PER_RULE = 102;
const MB = 1048576;

// U+202F NARROW NO-BREAK SPACE. index.html and script.js:275 both group thousands with it,
// so a plain space here would silently desynchronise the static cells from the live meter.
const THIN = "\u202F";

async function getRegistry() {
  const res = await fetch(REGISTRY);
  if (!res.ok) throw new Error(`registry: HTTP ${res.status}`);
  const json = await res.json();
  return json.filters.map((f) => ({
    key: f.filterKey,
    id: f.filterId,
    name: f.name,
    group: f.groupId,
    url: f.downloadUrl,
    home: f.homepage,
    desc: f.description,
    updated: f.timeUpdated,
    deprecated: !!f.deprecated,
  }));
}

// Count the rules in a list without ever holding the whole file, or writing any of it.
//
// A rule is a line that is neither blank nor a comment. AdGuard Home's own "Rules count"
// column uses the same definition - verified against three lists of different shapes
// (filter_8 NoCoin 313, filter_6 Game Console 15, filter_63 Windows/Office 389), all exact.
//
// The counting is done on chunk boundaries rather than by splitting the whole body,
// because a 43 MB string plus its split array is ~500 MB of heap for no reason.
async function countRules(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let bytes = 0;
  let rules = 0;
  let tail = ""; // partial line carried across chunk boundaries
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of res.body) {
    bytes += chunk.length;
    const text = tail + decoder.decode(chunk, { stream: true });
    const lines = text.split("\n");
    tail = lines.pop(); // may be incomplete; the next chunk finishes it
    for (const line of lines) if (isRule(line)) rules++;
  }
  if (isRule(tail)) rules++; // a final line with no trailing newline
  return { rules, bytes };
}

function isRule(line) {
  const s = line.trim();
  return s !== "" && s[0] !== "!" && s[0] !== "#";
}

// Run `jobs` with a fixed number in flight. Sequential would take minutes over 120 MB;
// unbounded would open 64 sockets to one host and invite a rate limit.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// --- the three number formats index.html uses -------------------------------------

// data-ram: megabytes at 3dp with trailing zeros stripped, but never bare ("0" -> "0.0"),
// which is the shape every existing row already has.
function ramAttr(rules) {
  const n = Number(((rules * BYTES_PER_RULE) / MB).toFixed(3));
  const s = String(n);
  return s.includes(".") ? s : s + ".0";
}

// The Memory cell shows fewer digits as the number grows, so the column stays scannable:
// 0.08 / 1.3 / 22. Derived from the same value as the attribute, never stored separately.
function ramCell(rules) {
  const v = (rules * BYTES_PER_RULE) / MB;
  if (v >= 10) return String(Math.round(v));
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

function rulesCell(rules) {
  return rules.toLocaleString("en-US").replace(/,/g, THIN);
}

// --- date formatting used by both scripts ------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// "30 August 2026" - the form the footer already uses.
function longDate(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

module.exports = {
  REGISTRY, BYTES_PER_RULE, MB, THIN,
  getRegistry, countRules, isRule, pool,
  ramAttr, ramCell, rulesCell, longDate,
};
