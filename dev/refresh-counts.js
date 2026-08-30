#!/usr/bin/env node
"use strict";
//
// Re-count every blocklist in the AdGuard registry and refresh the numbers in index.html.
//
//   node dev/refresh-counts.js            report what would change, write nothing
//   node dev/refresh-counts.js --write    apply it
//
// Why this is a dev script and not something the page does at load time:
//
//   Nothing publishes a rule count. filters.json (48 KB) carries version, timeUpdated and
//   homepage but no count, and the list headers carry none either - so a Range request
//   buys nothing. The only way to learn a count is to download the whole list and count
//   lines, and the whole registry is ~120 MB. The page would have to fetch all of them,
//   not just the enabled ones, because the calculator's entire job is toggling lists you
//   have NOT enabled. That is ~40 MB gzipped per page load to correct a drift that
//   measured 0.39% at its worst - and it would cost the page its two standing properties:
//   no third-party requests, works with the network unplugged.
//
// Lists are streamed and counted in flight. Nothing is ever written to disk, so there is
// no cache to go stale and nothing that can be committed by accident.
//
// Rows are matched to the registry by the filter id in their "Rule file" link, not by
// name. Upstream renames lists in place (filter_25 went from "KOR: List-KR DNS" to
// "KOR: filterslists-KO" without changing id), so name matching would report a rename as
// a removal plus an addition and silently drop the row's editorial prose.

const fs = require("fs");
const path = require("path");
const { getRegistry, countRules, pool, ramAttr, ramCell, rulesCell, longDate } = require("./registry.js");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");
const README = path.join(ROOT, "README.md");
const WRITE = process.argv.includes("--write");

// --- read the page ------------------------------------------------------------------

// A row's opening tag spans several lines for some entries and one line for others, so
// the attribute block is matched as a unit rather than line by line.
const ROW_RE = /<tr\s+([^>]*data-rules[^>]*)>([\s\S]*?)<\/tr>/g;

const attr = (s, k) => new RegExp(`data-${k}="([^"]*)"`).exec(s)?.[1] ?? "";
const text = (s) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

function readRows(html) {
  const rows = [];
  for (const m of html.matchAll(ROW_RE)) {
    const [block, attrs, body] = m;
    const id = /HostlistsRegistry\/assets\/filter_(\d+)\.txt/.exec(body);
    if (!id) throw new Error(`row has no rule-file link: ${attr(attrs, "nm")}`);
    rows.push({
      id: Number(id[1]),
      block,
      attrs,
      body,
      name: text(/<span class="nm">([\s\S]*?)<\/span>/.exec(body)?.[1] ?? ""),
      rules: Number(attr(attrs, "rules")),
      on: /class="[^"]*\bon\b/.test(attrs),
    });
  }
  return rows;
}

// True when a row's three rendered numbers all agree with the data-rules it carries.
// data-rules is the single source; data-ram and both cells are views of it.
function renders(row) {
  const bigs = [...row.body.matchAll(/<span class="big">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
  return (
    attr(row.attrs, "ram") === ramAttr(row.rules) &&
    bigs[0] === rulesCell(row.rules) &&
    bigs[1] === `${ramCell(row.rules)}<i>MB</i>`
  );
}

// --- rewrite one row ----------------------------------------------------------------

// The invariant this depends on: a blocklist row contains exactly two `.big` spans, in
// document order Rules then Memory. Asserted rather than assumed - if the markup ever
// grows a third, this must fail loudly instead of writing the memory value into it.
function patchRow(row, rules) {
  const bigs = [...row.body.matchAll(/<span class="big">[\s\S]*?<\/span>/g)];
  if (bigs.length !== 2) {
    throw new Error(`${row.name}: expected 2 .big spans, found ${bigs.length}`);
  }
  const attrs = row.attrs
    .replace(/data-rules="[^"]*"/, `data-rules="${rules}"`)
    .replace(/data-ram="[^"]*"/, `data-ram="${ramAttr(rules)}"`);

  const nextRules = `<span class="big">${rulesCell(rules)}</span>`;
  const nextRam = `<span class="big">${ramCell(rules)}<i>MB</i></span>`;

  // Replaced back to front so the first replacement cannot shift the second's offset.
  let body = row.body;
  body = body.slice(0, bigs[1].index) + nextRam + body.slice(bigs[1].index + bigs[1][0].length);
  body = body.slice(0, bigs[0].index) + nextRules + body.slice(bigs[0].index + bigs[0][0].length);

  return `<tr ${attrs}>${body}</tr>`;
}

// --- main ---------------------------------------------------------------------------

(async () => {
  const html = fs.readFileSync(INDEX, "utf8");
  const rows = readRows(html);
  const registry = await getRegistry();
  const byId = new Map(registry.map((f) => [f.id, f]));

  console.log(`page: ${rows.length} rows   registry: ${registry.length} lists`);

  // Every row is re-counted, including any that upstream has retired - a retired list is
  // usually still offered by installed AdGuard Home builds, so the page keeps documenting
  // it and still needs a truthful number.
  const targets = rows.map((r) => ({
    row: r,
    reg: byId.get(r.id),
    url: byId.get(r.id)?.url ?? `https://adguardteam.github.io/HostlistsRegistry/assets/filter_${r.id}.txt`,
  }));

  process.stdout.write(`counting ${targets.length} lists`);
  let done = 0;
  const counted = await pool(targets, 6, async (t) => {
    try {
      const { rules, bytes } = await countRules(t.url);
      return { ...t, rules, bytes };
    } catch (e) {
      return { ...t, error: e.message };
    } finally {
      if (++done % 8 === 0) process.stdout.write(".");
    }
  });
  console.log(" done\n");

  const failed = counted.filter((c) => c.error);
  // A row is rewritten when the count moved OR when what it renders disagrees with the
  // count it already claims. The second case is not hypothetical: the Smart-TV row shipped
  // 159 rules as "0.01 MB" when 159 x 102 B rounds to 0.02, because the cell was written by
  // hand. Deriving both cells from data-rules on every run makes that unrepresentable.
  const changed = counted.filter((c) => !c.error && (c.rules !== c.row.rules || !renders(c.row)));
  const renamed = counted.filter((c) => c.reg && c.reg.name !== c.row.name);
  const retired = counted.filter((c) => !c.reg);
  const pageIds = new Set(rows.map((r) => r.id));
  const added = registry.filter((f) => !pageIds.has(f.id));
  const mb = counted.reduce((a, c) => a + (c.bytes || 0), 0) / 1048576;

  if (failed.length) {
    for (const f of failed) console.log(`  FAIL  ${f.row.name} - ${f.error}`);
    console.log("");
  }

  if (changed.length) {
    console.log(`rule counts changed (${changed.length}):`);
    for (const c of changed) {
      const d = c.rules - c.row.rules;
      const note = d === 0 ? "cells disagreed with data-rules" : `${d > 0 ? "+" : ""}${d} (${((d / c.row.rules) * 100).toFixed(2)}%)`;
      console.log(
        `  ${c.row.name.padEnd(48)} ${String(c.row.rules).padStart(7)} -> ${String(c.rules).padStart(7)}  ${note}`,
      );
    }
  } else {
    console.log("rule counts: no change");
  }

  // These three need a human: a new list needs Strengths/Drawbacks/Conflicts prose
  // written for it, and a rename may or may not be one the page has already annotated.
  const notices = [];
  for (const f of added) notices.push(`ADDED    ${f.name}  (group ${f.group}, ${f.url})`);
  for (const c of renamed) notices.push(`RENAMED  "${c.row.name}" -> "${c.reg.name}"  (filter_${c.row.id})`);
  for (const c of retired) notices.push(`RETIRED  ${c.row.name}  (filter_${c.row.id} is no longer in the registry)`);
  if (notices.length) {
    console.log("\nneeds a human (this script will not invent editorial copy):");
    for (const n of notices) console.log("  " + n);
  }

  console.log(`\nstreamed ${mb.toFixed(1)} MB, wrote none of it to disk`);

  if (!WRITE) {
    console.log("(dry run - pass --write to apply)");
    return;
  }

  // --- apply ------------------------------------------------------------------------

  let out = html;
  for (const c of changed) {
    if (!out.includes(c.row.block)) throw new Error(`${c.row.name}: row block not found`);
    out = out.replace(c.row.block, patchRow(c.row, c.rules));
  }

  const today = longDate(new Date());

  // The footer sentence is a claim about the REGISTRY, so it counts registry lists - not
  // page rows, which also include anything retired upstream that the page still documents.
  // The trailing "." is matched explicitly rather than swept up by the date group: a lazy
  // [^<]*? happily swallows it, and the replacement then silently drops the full stop.
  const footer =
    /(All )\d+( lists in the\s*\n?\s*<a href="https:\/\/adguardteam\.github\.io\/HostlistsRegistry\/"[^>]*>AdGuard registry<\/a>\s*\n?\s*were downloaded and counted on\s*)[^<.]*(\.<br \/>)/;
  if (!footer.test(out)) throw new Error("footer provenance line not found - was it reworded?");
  out = out.replace(footer, `$1${registry.length}$2${today}$3`);

  // The <meta name="description"> quotes the list count too. It is the one number on the
  // page nobody would ever think to re-check, because it is invisible in the browser.
  const rowsNow = readRows(out).length;
  const desc = /(content="[^"]*?and )\d+( blocklists with rule counts)/;
  if (!desc.test(out)) throw new Error("meta description list count not found - was it reworded?");
  out = out.replace(desc, `$1${rowsNow}$2`);

  // Only actually touch the file when something differs. Rewriting identical bytes would
  // still report "wrote index.html", which reads as a change on a run that made none.
  if (out !== html) {
    fs.writeFileSync(INDEX, out);
    console.log(`\nwrote index.html  (${changed.length} row${changed.length === 1 ? "" : "s"}, snapshot date ${today})`);
  } else {
    console.log(`\nindex.html unchanged  (snapshot date already ${today})`);
  }

  // The README's list count is a claim about the PAGE, so it counts rows.
  const finalRows = readRows(out);
  const onCount = finalRows.filter((r) => r.on).length;
  const before = fs.readFileSync(README, "utf8");
  const after = before
    .replace(/\b\d+ lists across General, Other, Regional and Security\b/, `${finalRows.length} lists across General, Other, Regional and Security`)
    .replace(/\bwith \d+ lists(\s*\n?\s*)preselected\b/, `with ${onCount} lists$1preselected`)
    // The other half of the provenance line. dev/refresh-version.js owns the version and
    // its release date in the same sentence; the two spans never overlap.
    .replace(/(Blocklist sizes counted on )[^.]*/, `$1${today}`);
  if (after !== before) {
    fs.writeFileSync(README, after);
    console.log(`wrote README.md   (${finalRows.length} lists, ${onCount} preselected)`);
  } else {
    console.log("README.md unchanged");
  }
})().catch((e) => {
  console.error("\n" + e.stack);
  process.exit(1);
});
