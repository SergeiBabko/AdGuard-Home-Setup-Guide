#!/usr/bin/env node
"use strict";
//
// Stamp the AdGuard Home version the guide is written against into index.html and README.md.
//
//   node dev/refresh-version.js            report what would change, write nothing
//   node dev/refresh-version.js --write    apply it
//
// The guide describes settings screen by screen, so it is only true of a particular
// release - AdGuard Home has moved settings between screens and changed defaults inside a
// patch series more than once. The footer therefore names the release the text was checked
// against, and this keeps that claim honest without anyone having to remember the format.
//
// `releases/latest` is used rather than the tag list because it already excludes
// prereleases and drafts, which is exactly the set a reader should be running.
//
// This script owns the AdGuard Home version and its release date.
// dev/refresh-counts.js owns the blocklist snapshot date. They touch different spans of
// the same two files on purpose - neither can clobber the other's fact.

const fs = require("fs");
const path = require("path");
const { longDate } = require("./registry.js");

const LATEST = "https://api.github.com/repos/AdguardTeam/AdGuardHome/releases/latest";
const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");
const README = path.join(ROOT, "README.md");
const WRITE = process.argv.includes("--write");

// Compare two "0.107.79" strings numerically. String compare gets this wrong the moment a
// component reaches double digits ("0.107.9" > "0.107.79" lexically), which is precisely
// the range this project is in.
function cmp(a, b) {
  const x = a.replace(/^v/, "").split(".").map(Number);
  const y = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// --- the spans this script maintains --------------------------------------------------

// index.html footer:  ...>v0.107.79</a> (18 August 2026).<br />
const IDX_HREF = /(releases\/tag\/)v[\d.]+/g;
const IDX_TEXT = /(>\s*)v[\d.]+(<\/a\s*>\s*)\(([^)]*)\)(\.<br \/>)/;

// README Notes:  Current for **AdGuard Home v0.107.79** (18 August 2026).
const RM = /(Current for \*\*AdGuard Home )v[\d.]+(\*\* \()([^)]*)(\))/;

function require1(re, s, what) {
  const hits = s.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (!hits || hits.length !== 1) {
    throw new Error(`${what}: expected exactly 1 match, found ${hits ? hits.length : 0} - was it reworded?`);
  }
}

(async () => {
  const res = await fetch(LATEST, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "adguard-home-setup-guide-dev" },
  });
  if (!res.ok) {
    // 403 here is almost always the unauthenticated 60-requests-per-hour limit, which is
    // worth naming rather than leaving as a bare status code.
    const hint = res.status === 403 ? " (GitHub rate limit? it resets hourly)" : "";
    throw new Error(`GitHub API: HTTP ${res.status}${hint}`);
  }
  const rel = await res.json();
  const tag = String(rel.tag_name || "").replace(/^v/, "");
  if (!/^\d+(\.\d+)+$/.test(tag)) throw new Error(`unexpected tag shape: ${rel.tag_name}`);
  const released = longDate(new Date(rel.published_at));

  const html = fs.readFileSync(INDEX, "utf8");
  const readme = fs.readFileSync(README, "utf8");

  require1(IDX_TEXT, html, "index.html version+date");
  require1(RM, readme, "README.md provenance line");

  const cur = IDX_TEXT.exec(html)[0].match(/v([\d.]+)/)[1];
  const curDate = IDX_TEXT.exec(html)[3];

  console.log(`page:   v${cur} (${curDate})`);
  console.log(`latest: v${tag} (${released})`);

  const d = cmp(tag, cur);
  if (d === 0 && curDate === released) {
    console.log("\nalready current - nothing to do");
    return;
  }
  if (d < 0) {
    // Not an error worth failing on, but it always means something is off: either the page
    // was stamped from a prerelease, or a release was pulled.
    console.log(`\nNOTE: the page names a NEWER version than releases/latest. Not touching it.`);
    return;
  }

  console.log(`\nwould update: v${cur} -> v${tag}, ${curDate} -> ${released}`);
  console.log("the guide text itself is NOT checked by this script - read the changelog:");
  console.log(`  https://github.com/AdguardTeam/AdGuardHome/blob/master/CHANGELOG.md`);

  if (!WRITE) {
    console.log("\n(dry run - pass --write to apply)");
    return;
  }

  fs.writeFileSync(
    INDEX,
    html.replace(IDX_HREF, `$1v${tag}`).replace(IDX_TEXT, `$1v${tag}$2(${released})$4`),
  );
  console.log("\nwrote index.html");

  fs.writeFileSync(README, readme.replace(RM, `$1v${tag}$2${released}$4`));
  console.log("wrote README.md");
})().catch((e) => {
  console.error("\n" + e.stack);
  process.exit(1);
});
