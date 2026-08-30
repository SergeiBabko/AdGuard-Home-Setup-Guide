#!/usr/bin/env node
"use strict";
//
// Check that every link the page and the README actually offer a reader still resolves.
//
//   node dev/check-links.js
//
// Only real hyperlinks are checked - href/src attributes in index.html and markdown links
// in README.md. URLs sitting inside <code> are deliberately skipped: those are DoH
// endpoints meant to be pasted into AdGuard Home, not clicked, and a plain GET to one
// answers 404 or 505 because it wants a DNS query rather than a page. Treating them as
// links produces a wall of false failures and trains you to ignore the output.
//
// This exists because a link rotted silently: the Ukrainian Security Filter's project
// repository - and the whole GitHub account behind it - was deleted, while AdGuard's
// registry went on serving a frozen copy of the list and still naming the dead homepage.
// Nothing in the offline gates could have noticed.

const fs = require("fs");
const path = require("path");
const { pool } = require("./registry.js");

const ROOT = path.join(__dirname, "..");
const TIMEOUT = 25000;

function collect() {
  const found = new Map(); // url -> Set of sources
  const add = (url, where) => {
    if (!/^https?:/i.test(url)) return;
    if (!found.has(url)) found.set(url, new Set());
    found.get(url).add(where);
  };

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  for (const m of html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)) add(m[1], "index.html");

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const m of readme.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) add(m[1], "README.md");
  for (const m of readme.matchAll(/^\s*(https?:\/\/\S+?)\s*$/gm)) add(m[1], "README.md");

  return found;
}

// Only these mean the link is actually wrong. Everything else non-2xx means the server
// declined to talk to a script - a bot filter, a rate limit, an outage - which says
// nothing about whether a reader clicking the link gets a page. someonewhocares.org
// answers this checker 403 and curl 200 from the same address, minutes apart; failing a
// release on that would teach you to ignore the gate, which is worse than not having one.
const DEAD = new Set([404, 410]);

// HEAD would be cheaper, but enough hosts answer it with 403 or 405 that the noise costs
// more than the bytes. GET with a browser-shaped User-Agent is what a reader would do.
async function probe(url) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: ctl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; link-check)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      // The body is never read - only the status matters, and some of these are megabytes.
      try {
        await res.body?.cancel();
      } catch {}
      if (res.ok) return { status: res.status, ok: true };
      last = { status: res.status, ok: false, dead: DEAD.has(res.status) };
      if (last.dead) return last; // a 404 will not become a 200 on retry
    } catch (e) {
      // One retry: a single timeout or reset is usually the network, not a dead link.
      last = { status: 0, ok: false, dead: true, error: e.name === "AbortError" ? "timeout" : e.message };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

(async () => {
  const found = collect();
  const urls = [...found.keys()].sort();
  console.log(`checking ${urls.length} links`);

  let done = 0;
  const results = await pool(urls, 8, async (url) => {
    const r = await probe(url);
    if (++done % 20 === 0) process.stdout.write(`  ${done}/${urls.length}\n`);
    return { url, ...r };
  });

  const dead = results.filter((r) => !r.ok && r.dead);
  const refused = results.filter((r) => !r.ok && !r.dead);
  console.log("");

  for (const r of refused) {
    console.log(`  note    HTTP ${r.status} - server refused a scripted request  ${r.url}`);
  }
  for (const r of dead) {
    console.log(`  BROKEN  ${r.error ? r.error : "HTTP " + r.status}  ${r.url}`);
    console.log(`          in ${[...found.get(r.url)].join(", ")}`);
  }

  if (dead.length) {
    console.log(`\nRESULT: ${dead.length} of ${urls.length} links broken`);
    process.exit(1);
  }
  console.log(
    `RESULT: all ${urls.length} links resolve` + (refused.length ? ` (${refused.length} unverifiable, see notes)` : ""),
  );
})().catch((e) => {
  console.error("\n" + e.stack);
  process.exit(1);
});
