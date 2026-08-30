#!/usr/bin/env bash
#
# Render the page in both themes with headless Chrome and write PNGs to dev/shots/.
# The contrast gate proves the numbers; this is for the things only an eye can judge -
# whether the zebra is too loud, whether hover reads, whether a card looks like a card.
#
#   bash dev/shots.sh
#
# Two things about headless that cost an afternoon and are worth writing down:
#
#   Scrolling to a region does not work. The scroll lands (verified), but Chrome captures
#   before it has painted the newly exposed tiles of a 21,000px document, so the shot
#   comes back as bare page background. Regions are therefore ISOLATED instead: every
#   other top-level block is hidden, which puts the target at the top of a short page.
#
#   Setting data-theme in the markup is not enough. script.js restores the stored theme
#   on load and overwrites it, so localStorage is stubbed to return a fixed value.
#
# :hover cannot be captured at all. dev/row-states.html paints the same declarations the
# real rules use, so the state colours can still be compared side by side.
set -e
cd "$(dirname "$0")/.."
# Under Git Bash $PWD is an MSYS path (/e/Development/...). Pasted into a file:// URL it
# becomes file:////e/... which the browser cannot resolve, so every shot silently comes
# back as the same "file not found" page - identical bytes, and easy to mistake for a
# working script. cygpath gives the browser something it understands.
if command -v cygpath >/dev/null 2>&1; then
  SRC="$(cygpath -m "$PWD")"
else
  SRC="$PWD"
fi
OUT="$SRC/dev/shots"
mkdir -p "$OUT"

CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
if [ ! -x "$CHROME" ]; then
  for c in "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
           "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
           "$(command -v google-chrome || true)" "$(command -v chromium || true)"; do
    [ -n "$c" ] && [ -x "$c" ] && CHROME="$c" && break
  done
fi
[ -x "$CHROME" ] || { echo "No Chrome found. Set CHROME=/path/to/chrome"; exit 2; }
echo "browser: $CHROME"

# No --user-data-dir here. A fresh profile per shot sounds tidy, but Chrome spends its
# startup budget creating one and captures before the deferred script that themes and
# isolates the region has run - so every region shot came back in the same theme. The
# duplicate check at the bottom is what actually guards against stale output.
render () { # out-name file width height
  [ -s "$2" ] || { echo "  SKIP $1 - $2 missing or empty"; return 1; }
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --virtual-time-budget=8000 --window-size="$3,$4" \
    --screenshot="$OUT/$1.png" "file:///$2" >/dev/null 2>&1
  # Chrome exits 0 even when it renders an error page, so check the result is plausible.
  local sz
  sz=$(wc -c <"$OUT/$1.png" 2>/dev/null || echo 0)
  if [ "$sz" -lt 3000 ]; then echo "  WARN $1.png is only ${sz}B - likely an error page"; fi
  echo "  dev/shots/$1.png"
}

# --- regions of the real page ---------------------------------------------------
region () { # name theme selector width height
  python - "$SRC" "$2" "$3" "$1" <<'PY'
import io,sys
src,theme,sel=sys.argv[1],sys.argv[2],sys.argv[3]
head = "<style>html{scroll-behavior:auto !important}</style>"
# The theme is forced AFTER script.js has run, not before: script.js restores the stored
# preference on load and writes data-theme itself, so anything set earlier - in the
# markup, or by stubbing localStorage - is overwritten a moment later.
#
# It is set synchronously here rather than inside the deferred callback below, because
# --screenshot can capture before a load handler's timer fires. script.js is a classic
# blocking script, so by this point it has already run and this override is the last word.
tail=("<script>document.documentElement.setAttribute('data-theme',%r);</script>"
      "<script>window.addEventListener('load',function(){setTimeout(function(){"
      "var t=document.querySelector(%r);if(!t){document.body.innerHTML='<h1>selector not found</h1>';return;}"
      # Hide siblings at EVERY level from .page-main down to the target, not just the
      # top one - otherwise isolating a table leaves its whole section in frame.
      "var k=t;"
      "while(k&&k.parentElement){"
      "  [].forEach.call(k.parentElement.children,function(c){if(c!==k)c.style.display='none';});"
      "  if(k.parentElement.classList.contains('page-main'))break;"
      "  k=k.parentElement;"
      "}"
      "},400);});</script>") % (theme, sel)
s=io.open(src+'/index.html',encoding='utf-8').read()
s=s.replace('</head>',head+'</head>',1).replace('</body>',tail+'</body>',1)
# Written to the repo ROOT, not dev/: index.html's stylesheet hrefs are relative,
# so a copy inside dev/ resolves them to dev/styles/... and loads no CSS at all -
# which renders an unstyled page that looks identical in every theme.
io.open(src+'/__shot_'+sys.argv[4]+'.html','w',encoding='utf-8').write(s)
PY
  render "$1" "$SRC/__shot_$1.html" "$4" "$5"
}

# --- a standalone harness page in both themes -----------------------------------
harness () { # name file width height
  for T in light dark; do
    sed "s|data-theme=\"auto\"|data-theme=\"$T\"|" "$SRC/dev/$2" > "$SRC/dev/__shot_$1-$T.html"
    render "$1-$T" "$SRC/dev/__shot_$1-$T.html" "$3" "$4"
  done
}

echo "rendering:"
harness rows   row-states.html   1000 1120
harness sink   kitchen-sink.html 1200 3400
region  budget-light light '.budget'                        1280 620
region  budget-dark  dark  '.budget'                        1280 620
region  lists-light  light 'table[data-cols^="Status"]'     1280 700
region  lists-dark   dark  'table[data-cols^="Status"]'     1280 700
# The four blocklist tables are otherwise indistinguishable to a selector - they share a
# class and a data-cols. Only the <h3> above each carries an id, so :has() reaches the
# table through the group that contains that heading.
region  other-light  light '.grp:has(#lists-other) table'     1280 900
region  sec-light    light '.grp:has(#lists-security) table'  1280 900
region  memory-light light 'table[data-cols^="Device RAM"]' 1280 980
region  mobile-light light 'table[data-cols^="Status"]'      420 900
region  resolv-light light 'table[data-cols^="Resolver"]'   1280 620
region  resolv-dark  dark  'table[data-cols^="Resolver"]'   1280 620
region  footer-light light 'footer'                          1280 420
region  footer-dark  dark  'footer'                          1280 420

rm -f "$SRC"/__shot_*.html "$SRC"/dev/__shot_*.html

# Two identical renders in a light/dark pair means the cache defeated the run.
echo
dupes=$(md5sum "$OUT"/*.png | awk '{print $1}' | sort | uniq -d | wc -l)
if [ "$dupes" -gt 0 ]; then
  echo "WARNING: $dupes duplicate render(s) - a stale cache is being served"
  exit 1
fi
echo "all renders distinct"
