(function () {
  var root = document.documentElement,
    seg = document.getElementById("theme");
  // The stored theme is applied by a small inline script in <head>, before first paint.
  // This only keeps the segmented control in sync and handles later changes, so it must
  // not write to storage on load - that would persist "auto" for someone who never chose.
  function apply(t, persist) {
    root.setAttribute("data-theme", t);
    seg.querySelectorAll("button").forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.t === t ? "true" : "false");
    });
    if (!persist) return;
    try {
      localStorage.setItem("agh-theme", t);
    } catch (e) {}
  }
  var saved = "auto";
  try {
    saved = localStorage.getItem("agh-theme") || "auto";
  } catch (e) {}
  apply(saved, false);
  seg.addEventListener("click", function (e) {
    var b = e.target.closest("button");
    if (b) apply(b.dataset.t, true);
  });

  document.querySelectorAll("table[data-cols]").forEach(function (t) {
    var L = t.dataset.cols.split("|");
    t.querySelectorAll("tbody tr").forEach(function (tr) {
      tr.querySelectorAll("td").forEach(function (td, i) {
        td.setAttribute("data-l", L[i] || "");
      });
    });
  });

  // Below 900px the tables are re-laid out as cards by overriding `display`, which drops
  // table semantics from the accessibility tree in several engines - rows and cells stop
  // being announced as such. Restating the roles puts them back. On desktop they simply
  // repeat what the elements already mean, so this is safe to apply everywhere.
  document.querySelectorAll("table").forEach(function (t) {
    t.setAttribute("role", "table");
    t.querySelectorAll("thead,tbody").forEach(function (g) {
      g.setAttribute("role", "rowgroup");
    });
    t.querySelectorAll("tr").forEach(function (r) {
      r.setAttribute("role", "row");
    });
    t.querySelectorAll("th").forEach(function (c) {
      c.setAttribute("role", "columnheader");
    });
    t.querySelectorAll("td").forEach(function (c) {
      c.setAttribute("role", "cell");
    });
  });

  function cellVal(tr, k, num) {
    if (k === "st") {
      var i = tr.querySelector("input");
      return i && i.checked ? 0 : 1;
    }
    var v = tr.dataset[k];
    return num ? parseFloat(v || 0) : (v || "").toString();
  }
  // One implementation, three callers: the header click, the keyboard, and the mobile
  // sort bar below. `up` means descending, matching the .up class the arrows key off.
  function sortTable(t, th, up) {
    var k = th.dataset.k,
      num = th.hasAttribute("data-num"),
      tb = t.querySelector("tbody"),
      dir = up ? -1 : 1;
    t.querySelectorAll("th[data-k]").forEach(function (o) {
      o.classList.remove("act", "up");
      o.setAttribute("aria-sort", "none");
    });
    th.classList.add("act");
    if (up) th.classList.add("up");
    th.setAttribute("aria-sort", up ? "descending" : "ascending");
    [].slice
      .call(tb.rows)
      .sort(function (a, b) {
        var x = cellVal(a, k, num),
          y = cellVal(b, k, num);
        var d = num ? x - y : x < y ? -1 : x > y ? 1 : 0;
        if (d) return d * dir;
        return (+a.dataset.i || 0) - (+b.dataset.i || 0);
      })
      .forEach(function (r) {
        tb.appendChild(r);
      });
    if (t.__syncSortBar) t.__syncSortBar();
  }

  document.querySelectorAll("table").forEach(function (t) {
    var heads = [].slice.call(t.querySelectorAll("th[data-k]"));
    if (!heads.length) return;

    heads.forEach(function (th) {
      // Sorting was mouse-only: a <th> is not focusable, so there was no way to reach it
      // from the keyboard at all. The header keeps role="columnheader" and gains
      // aria-sort, which is the pattern screen readers announce - role="button" here
      // would trade one wrong answer for another.
      th.setAttribute("tabindex", "0");
      th.setAttribute("aria-sort", "none");
      th.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        th.click();
      });
      th.addEventListener("click", function () {
        sortTable(t, th, th.classList.contains("act") && !th.classList.contains("up"));
      });
    });

    /*
      Below 900px the header row is hidden to turn rows into cards, which took sorting
      with it - on exactly the four blocklist tables where sorting by rules or memory is
      the whole point. This adds a column picker and a direction toggle that drive the
      same sortTable() the headers do. The <select> is deliberately built before the
      dropdown code further down runs, so it gets the same styled listbox as the rest of
      the page rather than a bare native control.
    */
    var bar = document.createElement("div");
    bar.className = "sortbar";

    var label = document.createElement("label");
    label.className = "sortbar-l";
    label.appendChild(document.createTextNode("Sort by "));
    var sel = document.createElement("select");
    heads.forEach(function (th, i) {
      var o = document.createElement("option");
      o.value = String(i);
      o.textContent = (th.textContent || "").trim() || "Column " + (i + 1);
      sel.appendChild(o);
    });
    label.appendChild(sel);

    var dirBtn = document.createElement("button");
    dirBtn.type = "button";
    dirBtn.className = "sortbar-dir";

    bar.appendChild(label);
    bar.appendChild(dirBtn);

    var host = t.closest(".wrap");
    if (host && host.parentNode) host.parentNode.insertBefore(bar, host);

    t.__syncSortBar = function () {
      var active = t.querySelector("th[data-k].act");
      var i = active ? heads.indexOf(active) : 0;
      if (i < 0) i = 0;
      sel.value = String(i);
      // After the dropdown pass below runs, the select's parent is the .dd wrapper and
      // carries __sync, which repaints the styled button label.
      if (sel.parentNode && sel.parentNode.__sync) sel.parentNode.__sync();
      var desc = active ? active.classList.contains("up") : false;
      dirBtn.textContent = desc ? "↓" : "↑";
      dirBtn.setAttribute("aria-label", desc ? "Sorted descending. Switch to ascending" : "Sorted ascending. Switch to descending");
    };

    sel.addEventListener("change", function () {
      var th = heads[+sel.value];
      if (th) sortTable(t, th, t.querySelector("th[data-k].act.up") ? true : false);
    });
    dirBtn.addEventListener("click", function () {
      var active = t.querySelector("th[data-k].act") || heads[+sel.value] || heads[0];
      sortTable(t, active, !active.classList.contains("up"));
    });

    t.__syncSortBar();
  });

  // replace native selects with a styled dropdown
  document.querySelectorAll("select").forEach(function (sel) {
    var dd = document.createElement("span");
    dd.className = "dd";
    sel.parentNode.insertBefore(dd, sel);
    dd.appendChild(sel);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dd-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    var menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.setAttribute("role", "listbox");
    [].forEach.call(sel.options, function (o) {
      var it = document.createElement("div");
      it.className = "dd-opt";
      it.setAttribute("role", "option");
      it.textContent = o.textContent;
      it.dataset.v = o.value;
      it.addEventListener("click", function () {
        sel.value = o.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        close();
        sync();
      });
      menu.appendChild(it);
    });
    dd.appendChild(btn);
    dd.appendChild(menu);
    function sync() {
      btn.textContent = sel.options[sel.selectedIndex].textContent;
      menu.querySelectorAll(".dd-opt").forEach(function (it) {
        it.setAttribute("aria-selected", it.dataset.v === sel.value ? "true" : "false");
      });
    }
    function close() {
      dd.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var was = dd.classList.contains("open");
      document.querySelectorAll(".dd.open").forEach(function (o) {
        o.classList.remove("open");
      });
      if (!was) {
        dd.classList.add("open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
    sel.addEventListener("change", sync);
    dd.__sync = sync;
    sync();
  });
  document.addEventListener("click", function () {
    document.querySelectorAll(".dd.open").forEach(function (o) {
      o.classList.remove("open");
    });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape")
      document.querySelectorAll(".dd.open").forEach(function (o) {
        o.classList.remove("open");
      });
  });
  function syncAllDD() {
    document.querySelectorAll(".dd").forEach(function (d) {
      if (d.__sync) d.__sync();
    });
  }

  var BUD = {
    128: [37, 17, 0],
    256: [118, 83, 48],
    512: [278, 233, 175],
    1024: [621, 556, 456],
    2048: [1313, 1223, 1083],
    4096: [2716, 2586, 2386],
    8192: [null, null, null],
  };
  var dev = document.getElementById("dev"),
    dev2 = document.getElementById("dev2"),
    prof = document.getElementById("prof"),
    prof2 = document.getElementById("prof2"),
    bar = document.getElementById("bar"),
    fill = document.getElementById("fill"),
    vd = document.getElementById("verdict");
  function calc() {
    var n = 0,
      r = 0,
      m = 0;
    document.querySelectorAll(".grp tbody tr[data-rules]").forEach(function (tr) {
      var on = tr.querySelector("input").checked;
      tr.classList.toggle("on", on);
      if (on) {
        n++;
        r += +tr.dataset.rules;
        m += +tr.dataset.ram;
      }
    });
    var budget = BUD[dev.value][+prof.value];
    document.getElementById("s-lists").textContent = n;
    document.getElementById("s-rules").textContent = r.toLocaleString("en-US").replace(/,/g, " ");
    document.getElementById("s-ram").innerHTML = Math.round(m) + "<i> MB</i>";
    bar.classList.remove("unl");
    document.body.classList.remove("over");
    var cap = document.getElementById("s-cap");
    if (budget === null) {
      bar.classList.add("unl");
      bar.classList.remove("over");
      vd.classList.remove("bad");
      cap.textContent = "used";
      vd.textContent = "everything fits";
      return;
    }
    cap.textContent = "of " + budget + " MB";
    if (budget <= 0) {
      fill.style.width = "100%";
      bar.classList.add("over");
      vd.classList.add("bad");
      document.body.classList.add("over");
      cap.textContent = "no budget";
      vd.textContent = "won't run";
      return;
    }
    var over = m > budget;
    fill.style.width = Math.min(100, (m / budget) * 100) + "%";
    bar.classList.toggle("over", over);
    vd.classList.toggle("bad", over);
    document.body.classList.toggle("over", over);
    vd.textContent = over ? "does not fit" : m > budget * 0.8 ? "tight" : "fits";
  }
  // click any address or command to copy it
  document.querySelectorAll("code").forEach(function (el) {
    el.setAttribute("role", "button");
    // role="button" without a tab stop is a promise the element cannot keep, so make it
    // genuinely reachable and operable rather than only clickable.
    el.setAttribute("tabindex", "0");
    el.title = "Click to copy";
    function copy(e) {
      e.stopPropagation();
      var txt = el.textContent;
      var done = function () {
        el.classList.add("copied");
        setTimeout(function () {
          el.classList.remove("copied");
        }, 1100);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done, function () {
          fallback(txt, done);
        });
      } else fallback(txt, done);
    }
    el.addEventListener("click", copy);
    el.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault(); // Space would otherwise scroll the page
      copy(e);
    });
  });
  function fallback(txt, cb) {
    var ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      cb();
    } catch (e) {}
    document.body.removeChild(ta);
  }

  /*
    Align each option with its description.

    This stays in JS. CSS subgrid looks like the right answer but cannot express it: the
    two columns are separate <td> elements, so making their .orow children share a row
    track would mean turning the <tr> into a grid - which breaks the column alignment the
    rest of the table depends on - and would still need the row count, which varies per
    row and cannot be derived in CSS.

    What has changed is the cost. Reads and writes are now batched into two passes, so
    the browser lays out once instead of thrashing between measure and mutate for every
    element, and a ResizeObserver replaces the debounced resize listener plus the
    document.fonts.ready callback that used to leave rows misaligned until fonts settled.
  */
  var pairRows = [].slice.call(document.querySelectorAll("tr[data-pair]"));
  function pair() {
    var wide = !window.matchMedia("(max-width:900px)").matches;
    var work = [];

    // pass 1: clear every override, so measurement sees natural heights
    pairRows.forEach(function (tr) {
      var L = tr.querySelectorAll(".c-opt .orow"),
        R = tr.querySelectorAll(".c-tx .orow");
      for (var i = 0; i < L.length; i++) {
        L[i].style.minHeight = "";
        if (R[i]) R[i].style.minHeight = "";
      }
      if (wide) work.push([L, R]);
    });
    if (!work.length) return;

    // pass 2: read every height (one layout), then pass 3: write them all back
    var heights = work.map(function (p) {
      var L = p[0],
        R = p[1],
        h = [];
      for (var i = 0; i < L.length; i++) h.push(R[i] ? Math.max(L[i].offsetHeight, R[i].offsetHeight) : 0);
      return h;
    });
    work.forEach(function (p, n) {
      var L = p[0],
        R = p[1];
      for (var i = 0; i < L.length; i++) {
        if (!R[i]) continue;
        L[i].style.minHeight = heights[n][i] + "px";
        R[i].style.minHeight = heights[n][i] + "px";
      }
    });
  }
  pair();
  if (window.ResizeObserver && pairRows.length) {
    /*
      Observe the document element, not the tables. pair() writes min-height *into* the
      tables, so observing them would feed its own output back in: clear -> resize ->
      callback -> write -> resize -> callback, forever. The width gate makes that
      impossible - only a genuine width change does any work.
    */
    var lastW = document.documentElement.clientWidth;
    var pending = 0;
    new ResizeObserver(function () {
      var w = document.documentElement.clientWidth;
      if (w === lastW || pending) return;
      lastW = w;
      pending = requestAnimationFrame(function () {
        pending = 0;
        pair();
      });
    }).observe(document.documentElement);
  } else {
    window.addEventListener("resize", function () {
      clearTimeout(window.__p);
      window.__p = setTimeout(pair, 120);
    });
  }
  // Font metrics arrive after first paint and change heights without changing width, so
  // this is needed regardless of which path above is taken.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(pair);

  dev2.addEventListener("change", function () {
    dev.value = dev2.value;
    syncAllDD();
  });
  dev.addEventListener("change", function () {
    dev2.value = dev.value;
    syncAllDD();
  });
  prof2.addEventListener("change", function () {
    prof.value = prof2.value;
    syncAllDD();
  });
  prof.addEventListener("change", function () {
    prof2.value = prof.value;
    syncAllDD();
  });
  document.querySelectorAll("tbody tr[data-rules]").forEach(function (tr) {
    var cb = tr.querySelector('input[type="checkbox"]');
    if (!cb) return;
    // Name the control. Without this a screen reader announces 58 bare "checkbox"es.
    var nm = tr.querySelector(".nm");
    if (nm && !cb.getAttribute("aria-label")) cb.setAttribute("aria-label", nm.textContent.trim());
    tr.addEventListener("click", function (e) {
      // Leave the label and the checkbox to handle themselves: clicking either already
      // toggles natively, and the change listener below recalculates. Flipping it here
      // too would cancel the native toggle out - which is exactly what made keyboard
      // activation a silent no-op, since Space also dispatches a click that bubbles here.
      if (e.target.closest("a, label, input")) return;
      cb.checked = !cb.checked;
      calc();
    });
  });
  document.addEventListener("change", function (e) {
    if (e.target.matches("#dev,#dev2,#prof,#prof2")) calc();
    else if (e.target.matches('tbody tr[data-rules] input[type="checkbox"]')) calc();
  });
  calc();

  /*
    Sticky chrome.

    The old --navh publication is gone. It existed because the nav wrapped to a second
    line at narrow widths, so its height was not knowable in CSS; the nav is now a single
    scrollable row, which makes --nav-h a plain token and the measuring unnecessary.

    What CSS still cannot express is whether a sticky element is currently pinned - there
    is no :stuck selector. A 1px sentinel just above each bar answers it: once the
    sentinel has scrolled behind the bar's resting position, the bar must be pinned. One
    IntersectionObserver per bar replaces a scroll handler that called getComputedStyle
    and getBoundingClientRect on every single frame.
  */
  var navwrap = document.querySelector(".navwrap"),
    budget = document.querySelector(".budget");

  var pinObservers = [];
  function watchPinned(bar) {
    if (!bar) return;
    var sentinel = bar.previousElementSibling;
    if (!sentinel || !sentinel.classList.contains("stuck-sentinel")) {
      sentinel = document.createElement("div");
      sentinel.className = "stuck-sentinel";
      sentinel.setAttribute("aria-hidden", "true");
      bar.parentNode.insertBefore(sentinel, bar);
    }
    // Read the resting offset once, here, rather than on every scroll event.
    var top = parseFloat(getComputedStyle(bar).top) || 0;
    var io = new IntersectionObserver(
      function (entries) {
        bar.classList.toggle("stuck", !entries[0].isIntersecting);
      },
      { rootMargin: -(top + 1) + "px 0px 0px 0px" }
    );
    io.observe(sentinel);
    pinObservers.push(io);
  }
  function setupPinned() {
    // The resting offsets change at the 900px breakpoint, so rebuild rather than
    // recompute inside the callback.
    pinObservers.forEach(function (o) {
      o.disconnect();
    });
    pinObservers = [];
    watchPinned(navwrap);
    watchPinned(budget);
  }

  /*
    Scroll spy.

    The target list used to be derived from `.nav a` hrefs, which meant adding a second
    set of links would silently break it. The contract is now an explicit data-spy
    attribute naming the target id, so every list of links - the pill nav, the wide-screen
    sidebar - participates on equal terms and highlights together.
  */
  var spyGroups = {};
  [].slice.call(document.querySelectorAll("[data-spy]")).forEach(function (a) {
    var id = a.getAttribute("data-spy"),
      el = document.getElementById(id);
    if (!el) return;
    if (!spyGroups[id]) spyGroups[id] = { el: el, links: [] };
    spyGroups[id].links.push(a);
  });
  var spyOrder = Object.keys(spyGroups).sort(function (x, y) {
    var rel = spyGroups[x].el.compareDocumentPosition(spyGroups[y].el);
    return rel & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });

  /*
    A target becomes current when you have scrolled to where clicking its link would put
    it - which is its own scroll-margin-top, not a single number for the whole page.

    One global offset was wrong because the two kinds of target do not share one. A <section>
    clears the nav (--sticky-top + --nav-h + --space-24); a blocklist <h3> has to clear the
    meter as well (--meter-top + --meter-h + --space-16), which is nearly twice as far. The
    old probe used the nav figure for both, so clicking a blocklist heading scrolled it into
    place and left the PREVIOUS entry highlighted - the heading had landed below a threshold
    it could never cross.

    Read from computed style rather than recalculated here, so the number is the one the
    browser will actually use, and so redefining a token at a breakpoint moves the scroll,
    the anchor and the highlight together. Measured once, not per scroll event:
    getComputedStyle forces layout, and this runs on every frame of a scroll.
  */
  function measureChrome() {
    spyOrder.forEach(function (id) {
      var m = parseFloat(getComputedStyle(spyGroups[id].el).scrollMarginTop);
      spyGroups[id].margin = isNaN(m) ? 0 : m;
    });
  }

  function spy() {
    if (!spyOrder.length) return;
    var y = window.pageYOffset,
      active = spyOrder[0];
    for (var i = 0; i < spyOrder.length; i++) {
      var g = spyGroups[spyOrder[i]];
      // +1 absorbs sub-pixel rounding, so landing exactly on the boundary counts as
      // arrived rather than one pixel short.
      if (g.el.getBoundingClientRect().top + y - g.margin <= y + 1) active = spyOrder[i];
    }
    spyOrder.forEach(function (id) {
      var on = id === active;
      spyGroups[id].links.forEach(function (a) {
        a.classList.toggle("act", on);
        if (a.hasAttribute("aria-current") || on) a.setAttribute("aria-current", on ? "true" : "false");
      });
    });
  }

  var spyTicking = false;
  function onScroll() {
    if (spyTicking) return;
    spyTicking = true;
    requestAnimationFrame(function () {
      spyTicking = false;
      spy();
    });
  }

  if (window.IntersectionObserver) setupPinned();
  measureChrome();
  spy();
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", function () {
    measureChrome();
    if (window.IntersectionObserver) setupPinned();
    spy();
  });
})();
