// Race analysis — vanilla JS + D3 (scales/axes/drag only; all rendering is
// hand-built SVG/canvas so it stays readable without a build step).
//
// One source of truth for every metric: parse_fit.py only parses + resamples
// to 1Hz. Every average / Normalized Power / sort / table number below is
// computed here, from the same per-second arrays, for whatever time window
// is currently selected — so the KPI row, the table, and the row heatmap
// can never disagree with each other. Smoothing (see SMOOTH_STEPS) only
// touches what's drawn on screen — the row heatmap, the hover readout, the
// detail chart — never the table/KPI stats, so "how hard was I working" and
// "what does this line look like" can't silently drift apart just because
// someone dragged the smoothing slider.

(() => {
  "use strict";

  const ROW_H = 34;
  const ROW_GAP = 2;
  const NP_WINDOW = 30;
  const SMOOTH_STEPS = [1, 3, 5, 10, 30, 60, 300];
  // Same defaults as parse_fit.py's --align-window / --align-max-lag, so a
  // client-side re-align (see "clock alignment" below) behaves the same way
  // the parser did when it computed the baked-in suggestion.
  const ALIGN_WINDOW_S = 1200;
  const ALIGN_MAX_LAG_S = 50400;

  const els = {
    subtitle: document.getElementById("raceSubtitle"),
    banner: document.getElementById("dataBanner"),
    meSelect: document.getElementById("meSelect"),
    alignSelect: document.getElementById("alignSelect"),
    metricToggle: document.getElementById("metricToggle"),
    speedUnitToggle: document.getElementById("speedUnitToggle"),
    sortToggle: document.getElementById("sortToggle"),
    smoothSlider: document.getElementById("smoothSlider"),
    smoothValue: document.getElementById("smoothValue"),
    timelineSvg: document.getElementById("timelineSvg"),
    presetFull: document.getElementById("presetFull"),
    kpiRow: document.getElementById("kpiRow"),
    rowsHeading: document.getElementById("rowsHeading"),
    rowsLegend: document.getElementById("rowsLegend"),
    rowsReadoutTime: document.getElementById("rowsReadoutTime"),
    rowsLabels: document.getElementById("rowsLabels"),
    rowsCanvas: document.getElementById("rowsCanvas"),
    rowsCrosshair: document.getElementById("rowsCrosshair"),
    rowsReadout: document.getElementById("rowsReadout"),
    summaryTbody: document.getElementById("summaryTbody"),
    riderPicker: document.getElementById("riderPicker"),
    detailLegend: document.getElementById("detailLegend"),
    detailSvg: document.getElementById("detailSvg"),
    detailTooltip: document.getElementById("detailTooltip"),
    routeCanvas: document.getElementById("routeCanvas"),
  };

  // speed's fmt/unit read state.speedUnit at call time (not baked in here) so
  // flipping the km/h/mph toggle updates every reader — KPI tiles, table,
  // row hover readout, detail chart — without needing to touch this object.
  const METRIC_META = {
    power: { label: "Power", unit: "W", field: "power", fmt: (v) => (v == null ? "–" : Math.round(v).toLocaleString()) },
    hr: { label: "Heart rate", unit: "bpm", field: "hr", fmt: (v) => (v == null ? "–" : Math.round(v).toString()) },
    speed: { label: "Speed", field: "speed", fmt: (v) => (v == null ? "–" : (state.speedUnit === "mph" ? v * 2.23694 : v * 3.6).toFixed(1)) },
  };
  function metricUnit(metric) { return metric === "speed" ? (state.speedUnit === "mph" ? "mph" : "km/h") : METRIC_META[metric].unit; }

  const state = {
    dataKey: null,
    generatedAt: null,
    riders: [],
    domainStart: 0,
    domainEnd: 0,
    selection: [0, 0],
    metric: "power",
    sort: "selection",
    customOrder: [],
    smoothS: 1,
    speedUnit: "kmh",
    meId: null,
    alignRefId: null,
    detailPicks: [],
    detailPicksAuto: true,
  };

  let lastHoverEpoch = null;
  let routeHoverEpoch = null;

  // ---------- persistence ----------
  // Namespaced by generatedAt (parse_fit.py stamps a fresh one on every run)
  // as well as the data path, so rerunning the parser on new/corrected FIT
  // files starts with a clean slate instead of silently reapplying a "you"
  // pick made against a previous, different riders.json. Clock offsets
  // aren't stored here (or anywhere client-side) — parse_fit.py's
  // auto-alignment is the only source for those now, see effectiveT0().
  function storageKey() { return `gpxRace:${state.dataKey}:${state.generatedAt || ""}`; }
  function loadPersisted() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) return {};
      return JSON.parse(raw);
    } catch { return {}; }
  }
  function savePersisted() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify({ meId: state.meId, speedUnit: state.speedUnit }));
    } catch { /* ignore (private browsing etc.) */ }
  }

  // ---------- data loading ----------
  async function loadData(path) {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  function updateSubtitle() {
    const lowConf = state.riders.filter((r) => r.offsetConfidence != null && r.offsetConfidence < 0.5);
    const lowConfNote = lowConf.length
      ? ` · ⚠ low-confidence clock alignment for ${lowConf.map((r) => r.name).join(", ")} — check that a shared feature (a hill, a corner) lines up in the row/route panels`
      : "";
    els.subtitle.textContent = `${state.riders.length} riders · ${fmtClock(state.domainStart)}–${fmtClock(state.domainEnd)} · generated ${state.generatedAt ? new Date(state.generatedAt).toLocaleString() : "?"}${lowConfNote}`;
  }

  async function boot(path) {
    let bundle, usedDemo = false;
    try {
      bundle = await loadData(path);
    } catch (e) {
      if (path !== "data/demo.json") {
        try {
          bundle = await loadData("data/demo.json");
          usedDemo = true;
        } catch (e2) {
          els.subtitle.textContent = "Couldn't load any data. Run parse_fit.py, or serve web/ over http:// (not file://).";
          return;
        }
      } else {
        els.subtitle.textContent = "Couldn't load demo data either — check the console.";
        console.error(e);
        return;
      }
    }
    state.dataKey = usedDemo ? "data/demo.json" : path;
    state.generatedAt = bundle.generatedAt || "";
    state.riders = bundle.riders || [];
    if (!state.riders.length) {
      els.subtitle.textContent = "No riders in this file.";
      return;
    }
    smoothCache.clear();

    const persisted = loadPersisted();
    // No CLI flag decides "who is you" anymore (it was fiddly and easy to
    // typo against a filename) — default to parse_fit.py's alignment
    // reference rider, or the first file, and let a saved pick override it.
    state.meId = persisted.meId
      || (state.riders.find((r) => r.id === bundle.referenceRiderId) || {}).id
      || state.riders[0].id;
    // The alignment reference starts as whichever rider parse_fit.py used
    // (its suggestedOffsetS values already reflect that choice) — picking a
    // different one from the "Align clocks to" dropdown recomputes offsets
    // client-side, see realignTo().
    state.alignRefId = (state.riders.find((r) => r.id === bundle.referenceRiderId) || {}).id || state.riders[0].id;
    state.customOrder = state.riders.map((r) => r.id);
    state.sort = "selection";
    setSortButton("selection");
    setSpeedUnitButton(persisted.speedUnit === "mph" ? "mph" : "kmh");

    if (usedDemo) {
      els.banner.hidden = false;
      els.banner.textContent = `Showing demo data (data/demo.json) — data/riders.json wasn't found. Run: python3 parse_fit.py --input ./fit --output web/data/riders.json`;
    } else {
      els.banner.hidden = true;
    }

    computeDomain();
    state.selection = [state.domainStart, state.domainEnd];
    updateSubtitle();

    buildMeSelect();
    buildAlignSelect();
    buildRiderPicker();
    autoPickDetailRiders();
    initTimeline();
    initDetailChart();
    renderAll();
  }

  // parse_fit.py's cross-correlated suggestion is the only clock correction
  // applied — there's no manual per-rider offset screen to fight with (see
  // README "Time alignment").
  function effectiveT0(rider) { return rider.t0 + (rider.suggestedOffsetS || 0); }
  function effectiveT1(rider) { return effectiveT0(rider) + rider.n - 1; }

  function computeDomain() {
    let lo = Infinity, hi = -Infinity;
    for (const r of state.riders) {
      lo = Math.min(lo, effectiveT0(r));
      hi = Math.max(hi, effectiveT1(r));
    }
    state.domainStart = lo;
    state.domainEnd = hi;
  }

  // ---------- display-time smoothing ----------
  // A simple centered box filter, null-aware (a gap stays a gap rather than
  // getting dragged toward zero), computed via prefix sums so an N-second
  // window costs O(1) per point instead of O(N). Cached per rider/field/
  // window since the row heatmap, the hover readout, and the detail chart
  // all read the same smoothed array on every frame while dragging the
  // timeline. This only feeds what's drawn — see the header comment for why
  // table/KPI stats deliberately read the raw arrays instead.
  const smoothCache = new Map();
  function boxSmooth(arr, windowS) {
    const n = arr.length;
    const half = Math.floor(windowS / 2);
    const sums = new Float64Array(n + 1);
    const counts = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      sums[i + 1] = sums[i] + (v == null ? 0 : v);
      counts[i + 1] = counts[i] + (v == null ? 0 : 1);
    }
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
      const c = counts[hi + 1] - counts[lo];
      out[i] = c > 0 ? (sums[hi + 1] - sums[lo]) / c : null;
    }
    return out;
  }
  function smoothedArray(rider, field) {
    const arr = rider[field];
    if (!arr) return null;
    const w = state.smoothS;
    if (w <= 1) return arr;
    const key = `${rider.id}:${field}:${w}`;
    let cached = smoothCache.get(key);
    if (!cached) {
      cached = boxSmooth(arr, w);
      smoothCache.set(key, cached);
    }
    return cached;
  }

  // ---------- value access ----------
  function valueAt(rider, field, epoch) {
    const arr = smoothedArray(rider, field);
    if (!arr) return null;
    const idx = Math.round(epoch - effectiveT0(rider));
    if (idx < 0 || idx >= arr.length) return null;
    const v = arr[idx];
    return v === null || v === undefined ? null : v;
  }

  function sliceRange(rider, field, startEpoch, endEpoch) {
    const arr = rider[field];
    if (!arr) return [];
    const t0eff = effectiveT0(rider);
    const lo = Math.max(0, Math.ceil(startEpoch - t0eff));
    const hi = Math.min(arr.length - 1, Math.floor(endEpoch - t0eff));
    if (hi < lo) return [];
    return arr.slice(lo, hi + 1);
  }

  function mean(vals) {
    let s = 0, n = 0;
    for (const v of vals) if (v !== null && v !== undefined) { s += v; n++; }
    return n ? s / n : null;
  }
  function maxOf(vals) {
    let m = null;
    for (const v of vals) if (v !== null && v !== undefined && (m === null || v > m)) m = v;
    return m;
  }

  function normalizedPower(vals) {
    if (vals.length < NP_WINDOW) return null;
    const dq = [];
    let sum = 0, cnt = 0;
    const rollAvgs = [];
    for (const v of vals) {
      dq.push(v);
      if (v !== null && v !== undefined) { sum += v; cnt++; }
      if (dq.length > NP_WINDOW) {
        const old = dq.shift();
        if (old !== null && old !== undefined) { sum -= old; cnt--; }
      }
      if (dq.length === NP_WINDOW && cnt >= NP_WINDOW * 0.5) {
        rollAvgs.push(sum / cnt);
      }
    }
    if (!rollAvgs.length) return null;
    let fourth = 0;
    for (const a of rollAvgs) fourth += a ** 4;
    fourth /= rollAvgs.length;
    return Math.pow(fourth, 0.25);
  }

  function windowStats(rider, startEpoch, endEpoch) {
    const power = rider.hasPower ? sliceRange(rider, "power", startEpoch, endEpoch) : [];
    const hr = rider.hasHR ? sliceRange(rider, "hr", startEpoch, endEpoch) : [];
    const speed = sliceRange(rider, "speed", startEpoch, endEpoch);
    const avgPower = rider.hasPower ? mean(power) : null;
    const np = rider.hasPower ? normalizedPower(power) : null;
    const vi = avgPower && np ? np / avgPower : null;
    const avgHr = rider.hasHR ? mean(hr) : null;
    const maxHr = rider.hasHR ? maxOf(hr) : null;
    const avgSpeed = mean(speed);
    return { avgPower, np, vi, avgHr, maxHr, avgSpeed };
  }

  // ---------- formatting ----------
  function fmtClock(epoch) {
    const d = new Date(epoch * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  }
  function fmtWatts(v) { return v == null ? "–" : `${Math.round(v)} W`; }
  function fmtHr(v) { return v == null ? "–" : `${Math.round(v)} bpm`; }
  function fmtSpeed(v) {
    if (v == null) return "–";
    const val = state.speedUnit === "mph" ? v * 2.23694 : v * 3.6;
    return `${val.toFixed(1)} ${state.speedUnit === "mph" ? "mph" : "km/h"}`;
  }
  function riderName(r) { return r.name; }

  // ---------- sequential color ramps, one hue per metric ----------
  // Each is a 13-step light->dark ramp (same L trajectory as the dataviz
  // skill's documented blue ramp, rotated to a different hue via OKLCH so
  // all three stay equally legible) so the row heatmap's hue tells you
  // which metric you're looking at, on top of the usual light=low/dark=high
  // magnitude read: speed keeps the palette's own blue, power takes the
  // violet categorical anchor (purple), HR takes the red anchor (its light
  // end reads as pink, its dark end as red — matches "red/pink" either way).
  const SEQ_RAMP_COLORS = {
    speed: ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"],
    power: ["#dbddfc", "#cbccf7", "#babbf5", "#aaaaf0", "#9a99ed", "#8b88e8", "#7c75e6", "#6f66d7", "#625abf", "#564dab", "#4a4295", "#3e3681", "#322c6b"],
    hr: ["#fed4d0", "#fac0ba", "#f8aaa3", "#f2958e", "#ee7e77", "#e76762", "#e24a48", "#d2383a", "#bb3032", "#a72528", "#911e22", "#7e1519", "#681014"],
  };
  const seqStops = Array.from({ length: 13 }, (_, i) => i / 12);
  const seqScales = Object.fromEntries(
    Object.entries(SEQ_RAMP_COLORS).map(([metric, colors]) => [
      metric,
      d3.scaleLinear().domain(seqStops).range(colors).interpolate(d3.interpolateRgb).clamp(true),
    ])
  );
  function seqColorsFor(metric) { return SEQ_RAMP_COLORS[metric]; }

  function colorForValue(v, domainMax, metric = state.metric) {
    if (v === null || v === undefined || domainMax <= 0) return null;
    return seqScales[metric](Math.max(0, Math.min(1, v / domainMax)));
  }

  // ---------- "you are" picker ----------
  function buildMeSelect() {
    els.meSelect.innerHTML = "";
    for (const r of state.riders) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      opt.selected = r.id === state.meId;
      els.meSelect.appendChild(opt);
    }
  }
  els.meSelect.addEventListener("change", () => {
    state.meId = els.meSelect.value;
    savePersisted();
    buildRiderPicker();
    autoPickDetailRiders();
    renderAll();
  });

  // ---------- client-side clock alignment ----------
  // A JS port of parse_fit.py's suggest_time_offset() cross-correlation, so
  // picking a different "Align clocks to" reference recomputes everyone
  // else's offset live, from the same per-rider `ele` arrays already in
  // riders.json — no re-parse needed. Kept numerically identical to the
  // Python version (same windowing, same coarse-then-refine lag search) so
  // switching references in the browser can't disagree with what
  // parse_fit.py would have printed for the same reference.
  function movingAverageJS(vals, window) {
    const n = vals.length;
    const half = Math.floor(window / 2);
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
        const v = vals[j];
        if (v != null) { sum += v; cnt++; }
      }
      out[i] = cnt ? sum / cnt : null;
    }
    return out;
  }
  function epochMapJS(rider, windowS, smoothWindow) {
    const vals = (rider.ele || []).slice(0, windowS);
    const smoothed = movingAverageJS(vals, smoothWindow);
    const map = new Map();
    for (let i = 0; i < smoothed.length; i++) {
      if (smoothed[i] != null) map.set(rider.t0 + i, smoothed[i]);
    }
    return map;
  }
  function correlationAtLagJS(refMap, otherMap, lag, minOverlap = 90) {
    const xs = [], ys = [];
    for (const [t, rv] of refMap) {
      const ov = otherMap.get(t - lag);
      if (ov == null) continue;
      xs.push(rv);
      ys.push(ov);
    }
    const n = xs.length;
    if (n < minOverlap) return null;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    if (sxx <= 0 || syy <= 0) return null;
    return sxy / Math.sqrt(sxx * syy);
  }
  function suggestTimeOffsetJS(refRider, otherRider, windowS, maxLagS, coarseStepS = 15) {
    const refMap = epochMapJS(refRider, windowS, 7);
    const otherMap = epochMapJS(otherRider, windowS, 7);
    if (refMap.size < 90 || otherMap.size < 90) return { lag: null, corr: null };

    let bestLag = null, bestCorr = -2;
    for (let lag = -maxLagS; lag <= maxLagS; lag += coarseStepS) {
      const corr = correlationAtLagJS(refMap, otherMap, lag);
      if (corr != null && corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    if (bestLag == null) return { lag: null, corr: null };
    for (let lag = bestLag - coarseStepS; lag <= bestLag + coarseStepS; lag++) {
      const corr = correlationAtLagJS(refMap, otherMap, lag);
      if (corr != null && corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    return { lag: bestLag, corr: Math.round(bestCorr * 1000) / 1000 };
  }

  function buildAlignSelect() {
    els.alignSelect.innerHTML = "";
    for (const r of state.riders) {
      if (!r.ele || !r.ele.some((v) => v != null)) continue; // no elevation stream to correlate on
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      opt.selected = r.id === state.alignRefId;
      els.alignSelect.appendChild(opt);
    }
  }

  function realignTo(refId) {
    const reference = state.riders.find((r) => r.id === refId);
    if (!reference) return;
    state.alignRefId = refId;
    reference.suggestedOffsetS = 0;
    reference.offsetConfidence = null;
    for (const r of state.riders) {
      if (r.id === refId) continue;
      const { lag, corr } = suggestTimeOffsetJS(reference, r, ALIGN_WINDOW_S, ALIGN_MAX_LAG_S);
      r.suggestedOffsetS = lag;
      r.offsetConfidence = corr;
    }
    computeDomain();
    updateTimelineDomain();
    // Offsets can shift by a lot (that's the whole point of re-aligning) —
    // a stale selection window could land outside the new domain, so reset
    // it rather than clamp it somewhere that no longer means anything.
    state.selection = [state.domainStart, state.domainEnd];
    updateSubtitle();
    drawTimeline();
    renderAll();
  }
  els.alignSelect.addEventListener("change", () => realignTo(els.alignSelect.value));

  // ---------- metric / sort toggles ----------
  function wireSegmented(container, attr, onChange) {
    container.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        container.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        onChange(btn.dataset[attr]);
      });
    });
  }
  wireSegmented(els.metricToggle, "metric", (m) => { state.metric = m; renderAll(); });
  wireSegmented(els.sortToggle, "sort", (s) => { state.sort = s; renderRows(); });
  wireSegmented(els.speedUnitToggle, "unit", (u) => { state.speedUnit = u; savePersisted(); renderAll(); });

  function setSortButton(key) {
    state.sort = key;
    els.sortToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.sort === key));
  }
  function setSpeedUnitButton(key) {
    state.speedUnit = key;
    els.speedUnitToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.unit === key));
  }

  function smoothLabel(s) { return s === 1 ? "1s (raw)" : s < 60 ? `${s}s` : `${s / 60}m`; }
  {
    const ticks = document.getElementById("smoothTicks");
    SMOOTH_STEPS.forEach((_, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      ticks.appendChild(opt);
    });
  }
  els.smoothSlider.addEventListener("input", () => {
    state.smoothS = SMOOTH_STEPS[+els.smoothSlider.value];
    els.smoothValue.textContent = smoothLabel(state.smoothS);
    renderRows();
    renderDetail();
  });

  // ---------- timeline (drag-select) ----------
  let timelineScale;
  function initTimeline() {
    updateTimelineDomain();
    drawTimeline();
    window.addEventListener("resize", drawTimeline);
  }
  function updateTimelineDomain() {
    // scaleTime (not scaleUtc) so tick placement matches the local-time
    // labels below — d3.scaleUtc()'s "nice round number" tick rounding
    // uses UTC calendar boundaries, which would only matter here if the
    // viewer's UTC offset weren't a whole number of hours, but the format
    // mismatch (UTC ticks vs. fmtClock()'s local-time everything-else) is
    // real: a viewer anywhere off UTC would see an axis tick disagree with
    // the readout right next to it by their UTC offset.
    timelineScale = d3.scaleTime()
      .domain([new Date(state.domainStart * 1000), new Date(state.domainEnd * 1000)])
      .range([0, 1]); // range set for real in drawTimeline (needs width)
  }

  function timelineWidth() {
    return Math.max(240, els.timelineSvg.clientWidth || els.timelineSvg.parentElement.clientWidth);
  }

  function drawTimeline() {
    const svg = d3.select(els.timelineSvg);
    svg.selectAll("*").remove();
    const w = timelineWidth();
    const h = 44;
    // No label-gutter margin needed here — the SVG's own flex parent
    // (.timeline-strip-plot) is already offset by matching spacer divs on
    // either side (see style.css), so this track already starts exactly
    // under the row heatmap's plot area without duplicating that width here.
    // No time-axis ticks either — the heatmap directly below already has
    // its own axis on the shared time scale, so a second row of the same
    // labels here would just repeat it.
    const margin = { left: 6, right: 6 };
    els.timelineSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    timelineScale.range([margin.left, w - margin.right]);

    const trackY = 10, trackH = 24;
    svg.append("rect")
      .attr("x", margin.left).attr("y", trackY).attr("width", w - margin.left - margin.right).attr("height", trackH)
      .attr("rx", 4).attr("fill", "var(--seq-100)");

    // Click-to-recenter catcher — appended BEFORE the selection/handles so it
    // sits underneath them in SVG paint order and never steals their drag
    // events (an SVG rect with fill="transparent" is still hit-testable, so
    // paint order here doubles as event z-order).
    function clampEpoch(x) {
      const t = timelineScale.invert(x);
      const e = Math.floor(t.getTime() / 1000);
      return Math.max(state.domainStart, Math.min(state.domainEnd, e));
    }
    svg.append("rect")
      .attr("x", margin.left).attr("y", trackY).attr("width", w - margin.left - margin.right).attr("height", trackH)
      .attr("fill", "transparent").style("cursor", "crosshair")
      .on("click", (event) => {
        const [mx] = d3.pointer(event);
        const t = clampEpoch(mx);
        const span = Math.max(10, state.selection[1] - state.selection[0]);
        let newStart = Math.max(state.domainStart, Math.min(state.domainEnd - span, t - span / 2));
        state.selection = [newStart, newStart + span];
        positionsFromSelection();
        renderAll();
      });

    const sel = svg.append("rect")
      .attr("class", "selection")
      .attr("y", trackY).attr("height", trackH)
      .attr("fill", "var(--accent)").attr("fill-opacity", 0.28)
      .attr("stroke", "var(--accent)");

    const handleW = 8;
    const startHandle = svg.append("rect").attr("class", "handle-start").attr("y", trackY - 3).attr("width", handleW).attr("height", trackH + 6).attr("rx", 2).attr("fill", "var(--accent)").style("cursor", "ew-resize");
    const endHandle = svg.append("rect").attr("class", "handle-end").attr("y", trackY - 3).attr("width", handleW).attr("height", trackH + 6).attr("rx", 2).attr("fill", "var(--accent)").style("cursor", "ew-resize");

    function positionsFromSelection() {
      const x0 = timelineScale(new Date(state.selection[0] * 1000));
      const x1 = timelineScale(new Date(state.selection[1] * 1000));
      sel.attr("x", x0).attr("width", Math.max(1, x1 - x0));
      startHandle.attr("x", x0 - handleW / 2);
      endHandle.attr("x", x1 - handleW / 2);
    }
    positionsFromSelection();

    const dragStart = d3.drag().on("drag", (event) => {
      state.selection[0] = Math.min(clampEpoch(event.x), state.selection[1] - 5);
      positionsFromSelection();
      throttledRenderAll();
    });
    const dragEnd = d3.drag().on("drag", (event) => {
      state.selection[1] = Math.max(clampEpoch(event.x), state.selection[0] + 5);
      positionsFromSelection();
      throttledRenderAll();
    });
    const dragBody = d3.drag().on("drag", (event) => {
      const span = state.selection[1] - state.selection[0];
      const t = timelineScale.invert(event.x);
      let newStart = Math.floor(t.getTime() / 1000) - span / 2;
      newStart = Math.max(state.domainStart, Math.min(state.domainEnd - span, newStart));
      state.selection = [newStart, newStart + span];
      positionsFromSelection();
      throttledRenderAll();
    });

    startHandle.call(dragStart);
    endHandle.call(dragEnd);
    sel.style("cursor", "grab").call(dragBody);
  }

  let renderTimer = null;
  function throttledRenderAll() {
    if (renderTimer) return;
    renderTimer = requestAnimationFrame(() => { renderTimer = null; renderAll(); });
  }

  // "Full race" button, and double-clicking either the heatmap or the
  // timeline scrubber itself — two ways to the same reset since a button is
  // discoverable and a double-click is fast once you know it's there.
  function resetSelectionToFullRace() {
    state.selection = [state.domainStart, state.domainEnd];
    drawTimeline();
    renderAll();
  }
  els.presetFull.addEventListener("click", resetSelectionToFullRace);
  els.rowsCanvas.addEventListener("dblclick", resetSelectionToFullRace);
  els.timelineSvg.addEventListener("dblclick", resetSelectionToFullRace);

  // ---------- rider picker (detail chart) ----------
  function buildRiderPicker() {
    els.riderPicker.innerHTML = "";
    for (const r of state.riders) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "rider-chip";
      chip.dataset.id = r.id;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = "var(--text-muted)";
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(riderName(r) + (r.id === state.meId ? " (you)" : "")));
      chip.addEventListener("click", () => toggleDetailPick(r.id));
      els.riderPicker.appendChild(chip);
    }
  }

  // No cap on how many riders can be overlaid — was hard-limited to 4, which
  // meant "compare the whole field" needed opening the summary table instead
  // of the chart built for exactly that. seriesColorFor() below handles any
  // rider count.
  function toggleDetailPick(id) {
    state.detailPicksAuto = false;
    const i = state.detailPicks.indexOf(id);
    if (i >= 0) {
      state.detailPicks.splice(i, 1);
    } else {
      state.detailPicks.push(id);
    }
    renderDetail();
    renderRiderPickerState();
  }

  function autoPickDetailRiders() {
    const stats = state.riders.map((r) => ({ id: r.id, s: windowStats(r, state.selection[0], state.selection[1]) }));
    const metricKey = state.metric === "power" ? "avgPower" : state.metric === "hr" ? "avgHr" : "avgSpeed";
    const others = stats.filter((x) => x.id !== state.meId && x.s[metricKey] != null)
      .sort((a, b) => b.s[metricKey] - a.s[metricKey])
      .slice(0, 3)
      .map((x) => x.id);
    // Auto-pick still defaults to a legible "you + top 3" — the cap that's
    // gone is on what you can add by hand, not on what starts selected.
    const picks = [state.meId, ...others].filter((id) => state.riders.some((r) => r.id === id));
    state.detailPicks = [...new Set(picks)];
  }

  function renderRiderPickerState() {
    const nodes = els.riderPicker.querySelectorAll(".rider-chip");
    nodes.forEach((chip) => {
      const id = chip.dataset.id;
      const idx = state.detailPicks.indexOf(id);
      chip.classList.toggle("selected", idx >= 0);
      const dot = chip.querySelector(".dot");
      dot.style.background = idx >= 0 ? seriesColorFor(id) : "var(--text-muted)";
    });
  }

  // "You" always gets the accent blue; the curated series-2/3/4 trio covers
  // the next three. Beyond that (now that overlaying isn't capped at 4),
  // colors are generated via golden-angle hue stepping — 137.508° apart
  // stays well-distributed for any number of additional riders without
  // needing to know the total count in advance, starting away from the
  // palette's own blue so an unbounded pick never reads as "you" by accident.
  function seriesColorFor(id) {
    if (id === state.meId) return "var(--series-1)";
    const idx = state.detailPicks.filter((x) => x !== state.meId).indexOf(id);
    const curated = ["var(--series-2)", "var(--series-3)", "var(--series-4)"];
    if (idx >= 0 && idx < curated.length) return curated[idx];
    const hue = (20 + (idx - curated.length) * 137.508) % 360;
    return `hsl(${hue.toFixed(0)}, 68%, 55%)`;
  }

  // ---------- KPI row ----------
  function renderKpis() {
    const meRider = state.riders.find((r) => r.id === state.meId);
    const metricKey = state.metric === "power" ? "avgPower" : state.metric === "hr" ? "avgHr" : "avgSpeed";
    const fmt = state.metric === "power" ? fmtWatts : state.metric === "hr" ? fmtHr : fmtSpeed;
    const label = METRIC_META[state.metric].label;

    const all = state.riders.map((r) => ({ r, s: windowStats(r, state.selection[0], state.selection[1]) }));
    const withMetric = all.filter((x) => x.s[metricKey] != null);
    withMetric.sort((a, b) => b.s[metricKey] - a.s[metricKey]);

    const meEntry = all.find((x) => x.r.id === state.meId);
    const meVal = meEntry ? meEntry.s[metricKey] : null;
    const meRank = withMetric.findIndex((x) => x.r.id === state.meId) + 1;
    const next = withMetric.find((x) => x.r.id !== state.meId);
    const gap = meVal != null && next ? meVal - next.s[metricKey] : null;

    const tiles = [
      { label: `Your avg ${label.toLowerCase()} (selection)`, value: meVal != null ? fmt(meVal) : "–", sub: meRank ? `rank ${meRank} of ${withMetric.length}` : "", accent: true },
      { label: `Next highest`, value: next ? fmt(next.s[metricKey]) : "–", sub: next ? riderName(next.r) : "" },
      { label: `Gap`, value: gap != null ? `${gap >= 0 ? "+" : ""}${fmt === fmtSpeed ? fmtSpeed(Math.abs(gap)) : fmt(Math.abs(gap)).replace("-", "")}` : "–", sub: gap != null ? (gap >= 0 ? "you were higher" : "you were lower") : "" },
      { label: `Selection length`, value: fmtDur(state.selection[1] - state.selection[0]), sub: `${fmtClock(state.selection[0])}–${fmtClock(state.selection[1])}` },
    ];

    els.kpiRow.innerHTML = "";
    for (const t of tiles) {
      const tile = document.createElement("div");
      tile.className = "kpi-tile";
      const l = document.createElement("div"); l.className = "kpi-label"; l.textContent = t.label;
      const v = document.createElement("div"); v.className = "kpi-value" + (t.accent ? " accent" : ""); v.textContent = t.value;
      const s = document.createElement("div"); s.className = "kpi-sub"; s.textContent = t.sub || "";
      tile.append(l, v, s);
      els.kpiRow.appendChild(tile);
    }
  }

  // ---------- rows heatmap ----------
  function rowOrder() {
    if (state.sort === "custom") {
      const byId = new Map(state.riders.map((r) => [r.id, r]));
      const ordered = state.customOrder.filter((id) => byId.has(id));
      // any rider missing from customOrder (e.g. freshly loaded data) rides along at the end
      for (const r of state.riders) if (!ordered.includes(r.id)) ordered.push(r.id);
      return ordered.map((id) => ({ r: byId.get(id), s: windowStats(byId.get(id), state.selection[0], state.selection[1]) }));
    }

    const key = state.metric === "power" ? "avgPower" : state.metric === "hr" ? "avgHr" : "avgSpeed";
    const withStats = state.riders.map((r) => ({ r, s: windowStats(r, state.selection[0], state.selection[1]) }));
    if (state.sort === "name") {
      withStats.sort((a, b) => a.r.name.localeCompare(b.r.name));
    } else {
      withStats.sort((a, b) => {
        const av = a.s[key], bv = b.s[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return bv - av;
      });
    }
    return withStats;
  }

  function domainMaxForMetric() {
    const field = METRIC_META[state.metric].field;
    let vals = [];
    for (const r of state.riders) {
      const arr = r[field];
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 5) if (arr[i] != null) vals.push(arr[i]);
    }
    if (!vals.length) return 1;
    vals.sort((a, b) => a - b);
    const p95 = vals[Math.floor(vals.length * 0.95)];
    return state.metric === "speed" ? p95 : Math.max(p95, 1);
  }

  // Rider name labels live as real DOM elements (not baked into the canvas)
  // specifically so they can be native HTML5 drag targets — dragging one
  // reorders state.customOrder and switches to the "custom" sort, live, as
  // you drag (see the dragover handler below).
  let dragRiderId = null;
  function buildRowLabels(rows) {
    els.rowsLabels.innerHTML = "";
    rows.forEach(({ r }) => {
      const row = document.createElement("div");
      row.className = "row-label" + (r.id === state.meId ? " me" : "");
      row.draggable = true;
      row.dataset.id = r.id;

      const grip = document.createElement("span");
      grip.className = "grip";
      grip.textContent = "⋮⋮";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = riderName(r) + (r.id === state.meId ? " ★" : "");
      row.append(grip, name);

      row.addEventListener("dragstart", (e) => {
        if (state.sort !== "custom") {
          state.customOrder = rowOrder().map((x) => x.r.id);
          setSortButton("custom");
        }
        dragRiderId = r.id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", r.id);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        dragRiderId = null;
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (!dragRiderId || dragRiderId === r.id) return;
        const from = state.customOrder.indexOf(dragRiderId);
        const to = state.customOrder.indexOf(r.id);
        if (from === -1 || to === -1 || from === to) return;
        state.customOrder.splice(from, 1);
        state.customOrder.splice(to, 0, dragRiderId);
        throttledRenderRows();
      });
      row.addEventListener("drop", (e) => e.preventDefault());

      els.rowsLabels.appendChild(row);
    });
  }

  let routeRenderTimer = null;
  function throttledRenderRoute() {
    if (routeRenderTimer) return;
    routeRenderTimer = requestAnimationFrame(() => { routeRenderTimer = null; renderRoute(); });
  }

  let rowsRenderTimer = null;
  function throttledRenderRows() {
    if (rowsRenderTimer) return;
    rowsRenderTimer = requestAnimationFrame(() => { rowsRenderTimer = null; renderRows(); });
  }

  function renderRows() {
    const canvas = els.rowsCanvas;
    const wrap = canvas.parentElement;
    const cssW = Math.max(240, wrap.clientWidth);
    const rows = rowOrder();
    const cssH = rows.length * (ROW_H + ROW_GAP) + 28;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const cssVar = (name) => css.getPropertyValue(name).trim();

    ctx.clearRect(0, 0, cssW, cssH);
    const plotX0 = 0, plotX1 = cssW - 2;
    const plotW = plotX1 - plotX0;
    const domainMax = domainMaxForMetric();
    const field = METRIC_META[state.metric].field;
    const t0 = state.domainStart, t1 = state.domainEnd, span = Math.max(1, t1 - t0);

    const metricColors = seqColorsFor(state.metric);
    els.rowsHeading.textContent = `${METRIC_META[state.metric].label}, row by row`;
    els.rowsLegend.innerHTML = "";
    const legendLo = document.createElement("span"); legendLo.className = "legend-item";
    legendLo.innerHTML = `<span class="legend-swatch cell" style="background:${metricColors[1]}"></span>low`;
    const legendHi = document.createElement("span"); legendHi.className = "legend-item";
    legendHi.innerHTML = `<span class="legend-swatch cell" style="background:${metricColors[metricColors.length - 2]}"></span>high (~p95)`;
    const legendNa = document.createElement("span"); legendNa.className = "legend-item";
    legendNa.innerHTML = `<span class="legend-swatch cell" style="background:${cssVar("--seq-nodata")}"></span>no data`;
    els.rowsLegend.append(legendLo, legendHi, legendNa);

    buildRowLabels(rows);

    rows.forEach((entry, rowIdx) => {
      const { r } = entry;
      const y = rowIdx * (ROW_H + ROW_GAP);

      // hasn't got this metric at all
      const hasMetric = field === "power" ? r.hasPower : field === "hr" ? r.hasHR : true;
      if (!hasMetric) {
        ctx.fillStyle = cssVar("--seq-nodata");
        for (let x = plotX0; x < plotX1; x += 10) ctx.fillRect(x, y, 6, ROW_H);
        ctx.fillStyle = cssVar("--text-muted");
        ctx.font = "11px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText("no sensor", plotX0 + 8, y + ROW_H / 2);
        return;
      }

      // draw one column per pixel (sampled) for speed
      const arr = smoothedArray(r, field);
      const teff0 = effectiveT0(r);
      for (let px = 0; px < plotW; px++) {
        const t = t0 + (px / plotW) * span;
        const idx = Math.round(t - teff0);
        const v = idx >= 0 && idx < arr.length ? arr[idx] : null;
        const color = colorForValue(v, domainMax);
        ctx.fillStyle = color || cssVar("--seq-nodata");
        ctx.fillRect(plotX0 + px, y, 1.2, ROW_H);
      }
    });

    // selection overlay
    const selX0 = plotX0 + ((state.selection[0] - t0) / span) * plotW;
    const selX1 = plotX0 + ((state.selection[1] - t0) / span) * plotW;
    ctx.save();
    ctx.strokeStyle = cssVar("--accent");
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(selX0, 0); ctx.lineTo(selX0, cssH - 20); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(selX1, 0); ctx.lineTo(selX1, cssH - 20); ctx.stroke();
    ctx.restore();

    // axis ticks
    ctx.fillStyle = cssVar("--text-muted");
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "top";
    const tickScale = d3.scaleTime().domain([new Date(t0 * 1000), new Date(t1 * 1000)]).range([plotX0, plotX1]);
    const ticks = tickScale.ticks(Math.max(3, Math.floor(plotW / 110)));
    const fmtTick = d3.timeFormat("%H:%M:%S");
    for (const tk of ticks) {
      const x = tickScale(tk);
      ctx.strokeStyle = cssVar("--gridline");
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH - 20); ctx.stroke();
      ctx.fillText(fmtTick(tk), x + 2, cssH - 16);
    }

    canvas.__rows = rows;
    canvas.__plotX0 = plotX0; canvas.__plotX1 = plotX1; canvas.__t0 = t0; canvas.__span = span;
    canvas.__domainMax = domainMax;

    updateRowsReadout(lastHoverEpoch);
  }

  // Hover readout — a small pane to the right of the heatmap, one cell per
  // row so its value sits right next to the row it describes instead of a
  // floating box you have to glance away to read. With no active hover
  // (epoch == null) it falls back to each rider's average over the current
  // selection instead of a blank dash, so the pane is never just empty —
  // hovering only sharpens what's already there from instant-average to
  // instant-exact. rows entries already carry {r, s} from rowOrder()'s own
  // windowStats() call, so the average case is free — no recomputation.
  function updateRowsReadout(epoch) {
    els.rowsReadoutTime.textContent = epoch == null ? "avg for selection · hover to inspect" : fmtClock(epoch);
    const rows = els.rowsCanvas.__rows;
    els.rowsReadout.innerHTML = "";
    if (!rows) return;
    const field = METRIC_META[state.metric].field;
    const fmt = METRIC_META[state.metric].fmt;
    const unit = metricUnit(state.metric);
    const statKey = state.metric === "power" ? "avgPower" : state.metric === "hr" ? "avgHr" : "avgSpeed";
    for (const { r, s } of rows) {
      const v = epoch != null ? valueAt(r, field, epoch) : s[statKey];
      const cell = document.createElement("div");
      cell.className = "rows-readout-cell" + (v == null ? " empty" : "");
      cell.textContent = v == null ? "–" : `${fmt(v)} ${unit}`;
      els.rowsReadout.appendChild(cell);
    }
  }

  function hoverEpochFromEvent(event) {
    const canvas = els.rowsCanvas;
    if (!canvas.__rows) return null;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < canvas.__plotX0 || x > canvas.__plotX1) return null;
    return { t: Math.round(canvas.__t0 + ((x - canvas.__plotX0) / (canvas.__plotX1 - canvas.__plotX0)) * canvas.__span), x };
  }

  // Same x->epoch mapping as hoverEpochFromEvent, but clamped to the domain
  // instead of returning null past the edges — a drag naturally overshoots
  // the canvas bounds, and should keep extending the selection to the start
  // or end of the race rather than just stop responding.
  function clampedEpochFromClientX(clientX) {
    const canvas = els.rowsCanvas;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(canvas.__plotX0, Math.min(canvas.__plotX1, clientX - rect.left));
    const t = Math.round(canvas.__t0 + ((x - canvas.__plotX0) / (canvas.__plotX1 - canvas.__plotX0)) * canvas.__span);
    return Math.max(state.domainStart, Math.min(state.domainEnd, t));
  }

  // Drag-to-select directly on the heatmap, in addition to the timeline
  // scrubber below it — same state.selection, so either one moves both.
  // mousemove/mouseup are on window (not the canvas) so a drag that ends
  // outside the canvas still finishes cleanly instead of getting stuck.
  let rowsDragAnchor = null;
  els.rowsCanvas.addEventListener("mousedown", (event) => {
    if (!els.rowsCanvas.__rows) return;
    rowsDragAnchor = clampedEpochFromClientX(event.clientX);
    event.preventDefault(); // don't let the browser try to text-select the page while dragging
  });
  window.addEventListener("mousemove", (event) => {
    if (rowsDragAnchor == null) return;
    const t = clampedEpochFromClientX(event.clientX);
    const a = Math.min(rowsDragAnchor, t), b = Math.max(rowsDragAnchor, t);
    state.selection = [a, Math.max(a + 5, b)];
    drawTimeline();
    throttledRenderAll();
  });
  window.addEventListener("mouseup", () => { rowsDragAnchor = null; });

  els.rowsCanvas.addEventListener("mousemove", (event) => {
    const hit = hoverEpochFromEvent(event);
    if (!hit) {
      els.rowsCrosshair.hidden = true;
      lastHoverEpoch = null;
      routeHoverEpoch = null;
      updateRowsReadout(null);
      throttledRenderRoute();
      return;
    }
    lastHoverEpoch = hit.t;
    routeHoverEpoch = hit.t;
    els.rowsCrosshair.hidden = false;
    els.rowsCrosshair.style.left = `${hit.x}px`;
    updateRowsReadout(hit.t);
    throttledRenderRoute();
  });
  els.rowsCanvas.addEventListener("mouseleave", () => {
    els.rowsCrosshair.hidden = true;
    lastHoverEpoch = null;
    routeHoverEpoch = null;
    updateRowsReadout(null);
    throttledRenderRoute();
  });

  // ---------- summary table ----------
  let tableSortKey = "avgPower", tableSortDir = -1;
  document.querySelectorAll("#summaryTable th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (tableSortKey === key) tableSortDir *= -1; else { tableSortKey = key; tableSortDir = -1; }
      renderTable();
    });
  });

  function renderTable() {
    const rows = state.riders.map((r) => ({ r, s: windowStats(r, state.selection[0], state.selection[1]) }));
    rows.sort((a, b) => {
      if (tableSortKey === "name") return tableSortDir * a.r.name.localeCompare(b.r.name) * -1;
      const av = a.s[tableSortKey], bv = b.s[tableSortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return tableSortDir * (bv - av);
    });

    els.summaryTbody.innerHTML = "";
    for (const { r, s } of rows) {
      const tr = document.createElement("tr");
      if (r.id === state.meId) tr.classList.add("me");
      const cell = (val, na) => {
        const td = document.createElement("td");
        if (na) td.className = "na";
        td.textContent = val;
        return td;
      };
      const nameTd = document.createElement("td");
      nameTd.textContent = riderName(r);
      tr.appendChild(nameTd);
      tr.appendChild(cell(s.avgPower != null ? fmtWatts(s.avgPower) : "–", s.avgPower == null));
      tr.appendChild(cell(s.np != null ? fmtWatts(s.np) : "–", s.np == null));
      tr.appendChild(cell(s.vi != null ? s.vi.toFixed(2) : "–", s.vi == null));
      tr.appendChild(cell(s.avgHr != null ? fmtHr(s.avgHr) : "–", s.avgHr == null));
      tr.appendChild(cell(s.maxHr != null ? fmtHr(s.maxHr) : "–", s.maxHr == null));
      tr.appendChild(cell(fmtSpeed(s.avgSpeed), s.avgSpeed == null));
      els.summaryTbody.appendChild(tr);
    }
  }

  // ---------- detail chart ----------
  let detailX, detailY;
  function initDetailChart() { window.addEventListener("resize", renderDetail); }

  function renderDetail() {
    renderRiderPickerState();
    const svg = d3.select(els.detailSvg);
    svg.selectAll("*").remove();
    const w = Math.max(320, els.detailSvg.clientWidth || els.detailSvg.parentElement.clientWidth);
    const h = 260;
    els.detailSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const margin = { left: 58, right: 20, top: 12, bottom: 40 };

    const field = METRIC_META[state.metric].field;
    const [s0, s1] = state.selection;
    detailX = d3.scaleTime().domain([new Date(s0 * 1000), new Date(s1 * 1000)]).range([margin.left, w - margin.right]);

    const picks = state.detailPicks.map((id) => state.riders.find((r) => r.id === id)).filter(Boolean);
    let yMax = 1, yMin = 0;
    const series = picks.map((r) => {
      const t0eff = effectiveT0(r);
      const arr = smoothedArray(r, field) || [];
      const pts = [];
      for (let t = s0; t <= s1; t++) {
        const idx = Math.round(t - t0eff);
        const v = idx >= 0 && idx < arr.length ? arr[idx] : null;
        if (v != null) { yMax = Math.max(yMax, v); yMin = Math.min(yMin, v); }
        pts.push({ t, v });
      }
      return { r, pts };
    });
    yMin = Math.min(0, yMin);
    detailY = d3.scaleLinear().domain([yMin, yMax * 1.08]).range([h - margin.bottom, margin.top]);

    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${h - margin.bottom})`)
      .call(d3.axisBottom(detailX).ticks(Math.max(3, Math.floor(w / 110))).tickFormat(d3.timeFormat("%H:%M:%S")));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(detailY).ticks(5));

    svg.append("text").attr("class", "axis-title")
      .attr("x", margin.left + (w - margin.left - margin.right) / 2).attr("y", h - 4)
      .attr("text-anchor", "middle").text("Time");
    svg.append("text").attr("class", "axis-title")
      .attr("transform", "rotate(-90)")
      .attr("x", -(margin.top + (h - margin.bottom - margin.top) / 2)).attr("y", 14)
      .attr("text-anchor", "middle").text(`${METRIC_META[state.metric].label} (${metricUnit(state.metric)})`);

    const line = d3.line().defined((d) => d.v != null).x((d) => detailX(new Date(d.t * 1000))).y((d) => detailY(d.v)).curve(d3.curveMonotoneX);

    els.detailLegend.innerHTML = "";
    const labelCandidates = [];
    series.forEach((s) => {
      const color = seriesColorFor(s.r.id);
      svg.append("path").datum(s.pts).attr("fill", "none").attr("stroke", color).attr("stroke-width", 1.25)
        .attr("stroke-linejoin", "round").attr("stroke-linecap", "round").attr("d", line);

      const last = [...s.pts].reverse().find((d) => d.v != null);
      if (last) {
        const cx = detailX(new Date(last.t * 1000)), cy = detailY(last.v);
        svg.append("circle").attr("cx", cx).attr("cy", cy).attr("r", 4)
          .attr("fill", color).attr("stroke", "var(--surface-1)").attr("stroke-width", 2);
        labelCandidates.push({ s, last, cx, cy, color });
      }
      const item = document.createElement("span");
      item.className = "legend-item";
      const sw = document.createElement("span"); sw.className = "legend-swatch"; sw.style.background = color;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(riderName(s.r)));
      els.detailLegend.appendChild(item);
    });

    // Direct end-labels, with collision avoidance: converging lines land
    // labels on top of each other (see marks-and-anatomy.md — "when
    // end-labels collide, don't stack them"). "You" is the point of this
    // chart, so it always gets a label; the rest label only if they clear
    // a minimum vertical gap from labels already placed. Anyone skipped is
    // still reachable via the legend swatch and the hover tooltip.
    const MIN_LABEL_GAP = 15;
    const placed = [];
    const priority = [...labelCandidates].sort((a, b) => (a.s.r.id === state.meId ? -1 : b.s.r.id === state.meId ? 1 : a.cy - b.cy));
    for (const c of priority) {
      if (placed.some((p) => Math.abs(p.cy - c.cy) < MIN_LABEL_GAP)) continue;
      placed.push(c);
      svg.append("text").attr("x", c.cx - 6).attr("y", c.cy - 8)
        .attr("text-anchor", "end").attr("font-size", 11).attr("fill", "var(--text-secondary)")
        .text(`${riderName(c.s.r)} ${METRIC_META[state.metric].fmt(c.last.v)}${metricUnit(state.metric)}`);
    }

    // crosshair + tooltip
    const hit = svg.append("rect").attr("x", margin.left).attr("y", margin.top)
      .attr("width", Math.max(0, w - margin.left - margin.right)).attr("height", Math.max(0, h - margin.top - margin.bottom))
      .attr("fill", "transparent");
    const crosshair = svg.append("line").attr("class", "crosshair").attr("y1", margin.top).attr("y2", h - margin.bottom).style("display", "none");

    hit.on("mousemove", (event) => {
      const [mx] = d3.pointer(event);
      const t = Math.round(detailX.invert(mx).getTime() / 1000);
      crosshair.attr("x1", detailX(new Date(t * 1000))).attr("x2", detailX(new Date(t * 1000))).style("display", null);
      const tt = els.detailTooltip;
      tt.innerHTML = "";
      const timeEl = document.createElement("div"); timeEl.className = "tt-time"; timeEl.textContent = fmtClock(t);
      tt.appendChild(timeEl);
      const rowsAtT = series.map((s) => ({ r: s.r, v: valueAt(s.r, field, t) })).sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity));
      for (const { r, v } of rowsAtT) {
        const row = document.createElement("div"); row.className = "tt-row";
        const key = document.createElement("span"); key.className = "tt-key"; key.style.background = seriesColorFor(r.id);
        const name = document.createElement("span"); name.className = "tt-name" + (r.id === state.meId ? " me" : ""); name.textContent = riderName(r);
        const val = document.createElement("span"); val.className = "tt-val"; val.textContent = v == null ? "–" : `${METRIC_META[state.metric].fmt(v)} ${metricUnit(state.metric)}`;
        row.append(key, name, val);
        tt.appendChild(row);
      }
      tt.hidden = false;
      const wrapRect = els.detailSvg.getBoundingClientRect();
      let left = event.clientX - wrapRect.left + 14;
      if (left + 190 > wrapRect.width) left = event.clientX - wrapRect.left - 190 - 10;
      tt.style.left = `${left}px`;
      tt.style.top = `${event.clientY - wrapRect.top - 10}px`;
    }).on("mouseleave", () => { crosshair.style("display", "none"); els.detailTooltip.hidden = true; });
  }

  // ---------- route ----------
  function renderRoute() {
    const canvas = els.routeCanvas;
    const wrap = canvas.parentElement;
    // Route's card is a fixed, deliberately narrow column (see .top-grid in
    // style.css) so the panel reads as small/square rather than stretching
    // to match the heatmap's width — floor is lower than the old 320 so it
    // actually fits that column instead of forcing an overflow.
    const cssW = Math.max(200, wrap.clientWidth);
    const cssH = 260;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    canvas.style.width = cssW + "px"; canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const me = state.riders.find((r) => r.id === state.meId);
    if (!me || !me.lat || !me.lon) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted");
      ctx.fillText("No GPS track available for the selected rider.", 12, 20);
      return;
    }
    const lats = me.lat.filter((v) => v != null), lons = me.lon.filter((v) => v != null);
    if (!lats.length) return;
    const latMid = (Math.min(...lats) + Math.max(...lats)) / 2;
    const cos = Math.cos((latMid * Math.PI) / 180);
    const lonScale = cos;
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons) * lonScale, maxLon = Math.max(...lons) * lonScale;
    const pad = 20;
    const spanLat = Math.max(1e-6, maxLat - minLat);
    const spanLon = Math.max(1e-6, maxLon - minLon);
    const scale = Math.min((cssW - pad * 2) / spanLon, (cssH - pad * 2) / spanLat);
    const toXY = (lat, lon) => {
      const x = pad + ((lon * lonScale) - minLon) * scale;
      const y = cssH - pad - (lat - minLat) * scale;
      return [x, y];
    };

    const css = getComputedStyle(document.documentElement);
    ctx.strokeStyle = css.getPropertyValue("--baseline");
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < me.lat.length; i++) {
      if (me.lat[i] == null || me.lon[i] == null) { started = false; continue; }
      const [x, y] = toXY(me.lat[i], me.lon[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();

    const t0eff = effectiveT0(me);
    ctx.strokeStyle = css.getPropertyValue("--accent");
    ctx.lineWidth = 4;
    ctx.beginPath();
    started = false;
    const lo = Math.max(0, Math.floor(state.selection[0] - t0eff));
    const hi = Math.min(me.lat.length - 1, Math.ceil(state.selection[1] - t0eff));
    for (let i = lo; i <= hi; i++) {
      if (me.lat[i] == null || me.lon[i] == null) { started = false; continue; }
      const [x, y] = toXY(me.lat[i], me.lon[i]);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();

    // Hovering the row heatmap sets routeHoverEpoch — mirror that instant
    // as a marker here, so "where was I on the course when I was putting
    // out that many watts" is a glance at the map, not a mental note of a
    // clock time to go find. Always "me"'s position (the route only ever
    // draws one rider's track), regardless of which row the mouse is over.
    if (routeHoverEpoch != null) {
      const idx = Math.round(routeHoverEpoch - t0eff);
      if (idx >= 0 && idx < me.lat.length && me.lat[idx] != null && me.lon[idx] != null) {
        const [x, y] = toXY(me.lat[idx], me.lon[idx]);
        const accentColor = css.getPropertyValue("--accent");
        ctx.save();
        ctx.fillStyle = accentColor;
        ctx.globalAlpha = 0.25;
        ctx.beginPath(); ctx.arc(x, y, 10, 0, 2 * Math.PI); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill();
        ctx.strokeStyle = css.getPropertyValue("--surface-1");
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // ---------- orchestration ----------
  function renderAll() {
    renderKpis();
    renderRows();
    renderTable();
    if (state.detailPicksAuto) autoPickDetailRiders();
    renderDetail();
    renderRoute();
  }

  // No data-source picker anymore — boot() already falls back to the demo
  // automatically if data/riders.json isn't there, which was the entire
  // reason a manual selector existed.
  boot("data/riders.json");
})();
