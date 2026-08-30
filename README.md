# AdGuard Home &ndash; setup guide

A single-page guide to configuring [AdGuard Home](https://adguard.com/adguard-home/overview.html), from upstream
resolvers to blocklists.

**Read it
here → [sergeibabko.github.io/AdGuard-Home-Setup-Guide](https://sergeibabko.github.io/AdGuard-Home-Setup-Guide/)**

AdGuard Home ships with defaults tuned for a safe first boot rather than a working home network. The guide walks
through each settings screen in the order the interface presents them, and for every option says what to set and,
more importantly, why.

## The six rules

The page opens with six rules that carry most of the value. If you read nothing else, read those:

1. **Encrypt the connection** &ndash; use a `quic://`, `https://` or `tls://` upstream, not a bare IP.
2. **Let only AdGuard Home block things** &ndash; a filtering upstream hides its blocks from your log.
3. **One big list is enough** &ndash; general blocklists overlap 80&ndash;95%.
4. **Security lists are the exception** &ndash; those are built from different sources, so several genuinely help.
5. **Turn on one list at a time** &ndash; enabling several at once can crash the service with no useful error.
6. **Nothing is filtered until your devices use it** &ndash; set AdGuard Home as the DNS server on your router.

## What it covers

| Section                          | What's in it                                                                                                                         |
|----------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| **Upstreams**                    | Three copy-paste configurations, all 7 protocols compared, and 16 non-filtering resolvers with their jurisdiction and logging policy |
| **DNS server settings**          | 11 settings, each with a recommended value and the trade-offs of the alternatives                                                    |
| **General, logging and privacy** | 9 settings                                                                                                                           |
| **Cache**                        | 4 settings                                                                                                                           |
| **Encryption**                   | 8 settings for serving encrypted DNS to your own clients                                                                             |
| **Blocklists**                   | 65 lists across General, Other, Regional and Security, with rule counts, memory cost, strengths, drawbacks and conflicts             |

## The memory calculator

Blocklists are where people get into trouble, because the cost stays invisible until the router runs out of memory
and the service dies. So the blocklist section is interactive rather than a static table.

Pick your RAM (128 MB through 8 GB+) and how much else the box is doing (Lean, Typical or Loaded), then toggle lists
on and off. A sticky bar tracks the running total &ndash; lists, rules, memory, and whether the selection still fits
the budget &ndash; and turns red before you find out the hard way.

## Why the defaults look like this

Built for a GL.iNet [Beryl AX (GL-MT3000)](https://www.gl-inet.com/en-de/products/gl-mt3000) with 512 MB of RAM, in
Poland. That is why the calculator opens at 512 MB and a Typical load, giving a 233 MB budget, with 19 lists
preselected including `POL: CERT Polska List of malicious domains` and `POL: Polish filters for Pi-hole`.

Treat it as a worked example, not a prescription: change the selectors to match your own hardware, and swap the
regional lists for your own region.

## The design system

Light and dark are built on a hybrid of the two platform design systems: Material 3's token architecture &ndash; tonal
ramps, semantic roles, state layers, an elevation and shape scale &ndash; carrying Apple's semantic layering, which is
where the label and fill tiers, the grouped surface model and the translucent sticky bars come from.

Three layers, all in `styles/tokens.css`:

| Layer         | What it holds                                                                                                                                            |
|---------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Reference** | Six tonal ramps at Material 3's tone steps, derived in OKLCH from an indigo source (`#5457D6`). Components never touch these.                            |
| **Semantic**  | Roles that say what a colour is *for* &ndash; `--primary`, `--label-2`, `--surface-container`, `--state-hover`. Declared once each, with `light-dark()`. |
| **Scales**    | Spacing on a 4dp grid, Apple's Dynamic Type steps, shape, elevation, motion, z-index &ndash; all in `rem`, so the layout survives text-only zoom.        |

The split between opaque roles and translucent tiers is functional: anything that must hit a contrast ratio is an
opaque role, and anything that must composite over unknown pixels &ndash; fills, separators, state layers &ndash; is
alpha. Every `on-X` / `X` pair is verified rather than assumed.

The page honours `prefers-color-scheme`, `prefers-contrast`, `prefers-reduced-motion`, `prefers-reduced-transparency`
and `forced-colors`.

## Notes

No build step and no dependencies &ndash; open `index.html` in a browser. `package.json` holds script aliases and
nothing else: no `dependencies`, no lockfile, nothing to install before the page runs. The page loads no third-party
resources at all, so it works with the network unplugged. Type is the platform's own UI font, which is what both
design systems ask for and costs nothing to download. List sizes and resolver policies are a researched snapshot
rather than a live feed, so verify anything that matters to you against the operator's own page.

Current for **AdGuard Home v0.107.79** (18 August 2026). Blocklist sizes counted on 31 August 2026.
Both facts are maintained by scripts &ndash; see below.

`dev/` holds checks, not page code, and nothing in it is loaded by the page.

```
npm run update   # re-count the lists, restamp the version, then run check
npm run check    # lint + contrast + links; changes nothing
```

`update` rewrites the counts, memory and dates in `index.html` and this file, then verifies them. It is idempotent,
and it never invents editorial copy &ndash; a list added, renamed or retired upstream is reported for you to write.
Review what it did with `git diff`.

The rest is only for working on the page itself:

| Script                 | What it does                                                         | Network |
|------------------------|----------------------------------------------------------------------|---------|
| `npm run dev:lint`     | CSS syntax, dead tokens, stray literals, markup, derived row numbers | no      |
| `npm run dev:contrast` | WCAG ratios for every token pair, both themes                        | no      |
| `npm run dev:links`    | every `href` resolves; fails on 404/410 only, not on bot filters     | yes     |
| `npm run dev:shots`    | headless Chrome renders into `dev/shots/` (needs Chrome and bash)    | no      |
| `npm run dev:serve`    | serves the project at `http://localhost:8080`                        | no      |

Plus `node dev/make-ramps.js` to regenerate the tonal ramps and `node dev/css-order.js` to prove the five stylesheets
still cascade the same. The two refresh scripts run alone as well, and print what they would change unless given
`--write`.

`refresh-counts.js` streams all 64 lists (~120 MB) and counts rules as the bytes arrive; **nothing is written to
disk**, so there is no cache to go stale and no blocklist to commit by accident. The page cannot do this live: no rule
count is published anywhere, so the only way to learn one is to download the whole list &ndash; roughly 40 MB gzipped
on every page load, to correct a drift that measured 0.39% at its worst.

`dev/kitchen-sink.html` shows every component in every state, `dev/row-states.html` puts every table row background
side by side, and `dev/contrast.html` audits real computed values. Reach those three through `npm run dev:serve`:
over `file://` Chrome makes `cssRules` throw, so they discover zero tokens and look broken when they are not. The
page itself opens straight from disk.

---

*Code created by AI under the direction and review of the developer.*
