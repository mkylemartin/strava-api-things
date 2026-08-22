# strava-api-things

training management tools

## Race FIT comparison

A local tool for comparing FIT files exported by several riders from the
same race — average speed, power, Normalized Power, heart rate, all
time-synced on one clock — plus a "riders as rows" power heatmap built
specifically to answer one question: *when you took that pull on the
front, was everyone behind you actually working less hard?*

Two pieces:

- **`parse_fit.py`** — parses a folder of `.fit` files into
  `web/data/riders.json`. Needs one package (`pip install -r
  requirements.txt`).
- **`web/`** — a static page (vanilla JS + [D3](https://d3js.org) for
  scales/axes, vendored locally so it works offline) that loads that JSON
  and renders everything interactively. No build step, no server-side
  code — it never sends your ride data anywhere.

**Why FIT only.** This tool used to also read GPX, which has no official
field for cycling power and stores time as a hand-formatted string that
has to correctly declare "this is UTC" — a real bug in this project's own
test data (a "declared UTC but actually local time" export, and separately
a browser exporter that truncated a start time to midnight) turned out to
be exactly that declaration going wrong, by hours. FIT stores time as a raw
UTC seconds-since-epoch integer, so it can't have that *string-parsing*
version of the bug — there's no formatted text to misread. It's not full
immunity, though (see "Time alignment" below for a real FIT-era example of
the same symptom from a different cause). FIT also carries the device's
own measured distance rather than a GPS-only haversine estimate, and uses
one standardized field name per stream instead of per-vendor tag-guessing.
Given that, supporting GPX too was mostly adding surface area to guard
against a format worth just not using — Garmin Connect, Wahoo, and most
platforms export `.fit` directly; if you're going through Sauce for
Strava, its export panel offers FIT alongside GPX/TCX — take the FIT one.

### Quick start

```bash
pip install -r requirements.txt
python3 parse_fit.py --input ./fit --output web/data/riders.json
cd web && python3 -m http.server 8000
# open http://localhost:8000
```

Pick "you" from the **You are** dropdown in the Setup card near the top —
it's remembered in the browser, so you only do it once per race file.
There's no `--me` flag; a CLI flag you have to match against a filename by
substring was more fiddly than a dropdown for something you only set once.

If `web/data/riders.json` doesn't exist yet, the page automatically falls
back to `web/data/demo.json` — a synthetic 6-rider race (regenerate it with
`python3 tools/generate_demo_data.py`) so you can see how the tool tells
the story before pointing it at your own files. There's no data-source
picker in the UI; drop your real `riders.json` in and reload once you have
one.

### Getting FIT files with power/HR out of Garmin, Strava, etc.

Garmin Connect → activity → **⋯ → Export** gives you a `.fit` file directly
with power/HR intact if the recording had them. Strava's own GPX export
strips power, so prefer each rider's own watch/app export — or a tool like
Sauce for Strava's export panel (offers FIT/TCX/GPX; take FIT) — over a
re-download from Strava if you can get it. GPS-only riders and riders
without a power meter still work fine; their rows just show HR (or GPS
speed) with power reported as "no sensor" rather than zero.

### Time alignment — why riders end up offset, and the fix

"Everyone started their head units around the same time" only guarantees
the *button press* was close together — it says nothing about whether each
device's clock was actually correct when it started recording. Two causes,
and FIT only rules out one of them:

1. **A device with a misconfigured timezone.** FIT's timestamp field is a
   raw UTC epoch integer, which rules out a *file* misreading "is this
   local or UTC" — but it can't rule out the *device itself* computing that
   integer from a wrong timezone setting in the first place, which produces
   the identical symptom: a whole, suspiciously-round number of hours off.
   This turned out not to be hypothetical: testing against a real 10-rider
   field, 9 of the 10 FIT files needed a **+7.00h** correction relative to
   the 10th, at a correlation of 0.998-0.999 — not remotely ambiguous, just
   outside the ±4h range this tool originally shipped assuming FIT closed
   this off entirely. It didn't. (You can usually tell which file is honest
   by plausibility, same as the old GPX bug: a race that "started" at 1am
   local time is the mislabeled one, not the 8:15am file next to it.)
2. **A device that didn't have GPS lock at power-on.** Watches/head units
   without cell connectivity set their clock from the GPS signal; a cold
   start recording before that fix can carry a stale internal-battery clock
   for a while, producing an odd, non-round offset instead.

Dragging an offset slider by eye tops out at maybe 5-10-second precision
and doesn't scale past a handful of riders, so `parse_fit.py` finds each
rider's offset automatically instead: it cross-correlates each rider's
**elevation-vs-time** curve (smoothed) against a reference rider's over the
first `--align-window` seconds of the race (default 20 min — the part of
the race where the field is still together, so elevation-vs-time is close
to a pure time-shifted copy of the same curve across riders) and keeps the
shift with the strongest correlation. The search range defaults to
**±14 hours** (`--align-max-lag`) — wide enough to catch cause #1 above,
which is real, without searching a full day the way GPX's midnight-
truncation bug once required.

The web app applies this correction automatically. **There's no manual
offset screen** — once the auto-alignment reliably solves real-world FIT
data (which is what motivated dropping the old "clock-offset correction"
panel), a slider that mostly just duplicated what the algorithm already
got right was more surface area than value. If a rider's suggestion comes
back low-confidence (weak or no elevation match — flat course, too much
noise, not enough overlap), the page says so in the subtitle at the top.

`parse_fit.py` picks whichever file sorts first alphabetically as the
reference every other rider is aligned against, which is an accident of
filenames, not a considered choice — if that file's own elevation track is
poor (a flat course, an indoor-trainer ride with a synthetic elevation
stream) every other rider's alignment quality suffers, since they're all
correlated against it. Fix it from the browser: the **Align clocks to**
dropdown in the Setup section re-runs the same cross-correlation
client-side against whichever rider you pick, live, no re-parse needed —
it's a JS port of `suggest_time_offset()` operating on the elevation
streams already in `riders.json`. Add `--no-align` to skip the
auto-suggestion step entirely and start everyone at 0.

Run `parse_fit.py` as usual and it prints what it found — this is the real
10-rider field mentioned above, not a hypothetical:

```
Aligning clocks against 'Aidan San Ardo Rr' (first 1200s of each recording, ±50400s search)...
  Aiden Morning Ride: suggest -8s (correlation 1.00 — strong)
  Angel San Ardo Rr Cat 4: suggest +249s (correlation 1.00 — strong)
  Kyle San Ardo Rr Cat 4: suggest -25201s (correlation 1.00 — strong)
  ...
```

`Kyle`'s -25201s (-7.00h) is cause #1 above, caught only because the
search range is wide enough to reach it — at the old ±4h default this
rider came back "not enough overlapping elevation data to align," which
looked like a data problem rather than the search just never trying the
right lag.

### What the page shows

The page is laid out in the order you'd actually use it. Top row: pick how
you're looking at the data (left) next to the one panel worth seeing before
you've even selected anything, your route (right — the map is the most
immediately legible thing on the page, so it's the first thing you see, not
the last). Below that: setup, touched once per session. Then the main loop —
select a segment, read the numbers, look at the pattern — repeated as many
times as you want.

- **View controls** — pick the metric (power/HR/speed), **km/h or mph**
  for every speed shown on the page, and a **smoothing** slider
  (1s/3s/5s/10s/30s/1m/5m) that box-smooths what's drawn in the row
  heatmap, the hover readout, and the detail chart. Smoothing is
  display-only — the KPI tiles, the summary table, and Normalized Power
  always read the raw recorded data, so a smoothed-for-legibility view can
  never quietly change what "you did 310W for 6 minutes" means.
- **Route** — your GPS track with the selected window highlighted, to place
  the segment on the actual course.
- **Setup** — hover the **?** for what each control does. **You are** picks
  which rider is highlighted, whose "avg power" the KPI tiles show, and
  whose GPS track the route panel draws; it's remembered in the browser.
  **Align clocks to** is the escape hatch for the rare case a rider's row
  looks shifted from everyone else's (see "Time alignment" above) — you
  shouldn't need it otherwise.
- **Power, row by row** — everything about the current selection lives in
  this one card, top to bottom in the order you'd use it. Hover the **?**
  next to the heading for the full explanation; the short version:
  - **"Full race"** resets the selection to everything; **double-clicking
    the heatmap (or the timeline strip below the card)** does the same —
    two ways to the same reset, since a button is discoverable and a
    double-click is fast once you know it's there.
  - **KPI tiles** — your average for the selected metric, the
    next-highest rider, and the gap between you, so "I did 116 more watts
    than anyone else for 8 minutes" is a number, not an impression, right
    where the selection that produced it lives.
  - **Sort rows by**, then the heatmap itself: one horizontal strip per
    rider on the shared race clock, darker = more watts (or the chosen
    metric). Each metric has its own hue — power purple, heart rate
    red/pink, speed blue. "Selected window" sorts by average value inside
    your selection, so during your pull your row lands on top and visibly
    darker than the ones under it — look straight down the column at any
    instant to compare everyone. **Drag a rider's name** to reorder rows
    by hand (switches to "Custom" sort). **Hover the chart** to read each
    rider's exact value at that instant in the readout pane on the right;
    with nothing hovered, that same pane shows each rider's *average over
    the current selection* instead of going blank, so there's always a
    number there, not just when your mouse happens to be over the chart.
    Riders with no power meter show as a hatched "no sensor" row instead
    of being hidden, so the row order and comparison stay honest about
    who's measured and who isn't.
- **Timeline** — a thin scrubber directly below the heatmap, deliberately
  its own card rather than nested inside: the heatmap already marks the
  current selection with dashed guide lines, so keeping the draggable
  control physically separate means dragging it never visually competes
  with the data it's selecting. Its track is exactly as wide as the
  heatmap's plot area (not the full card) so the two line up pixel for
  pixel. Drag the handles or the selection itself; double-click to reset
  to the full race.
- **Selected-window comparison table** — average power, Normalized Power
  (standard 30s-rolling⁴ method), variability index, average/max HR,
  average speed, all recomputed live for whatever window is selected, from
  raw (unsmoothed) data; sort any column by clicking its header.
- **Detail comparison** — an overlay line chart, at the bottom of the page.
  Pick any number of riders to overlay from the chips (no cap — compare the
  whole field if you want); colors cycle through a curated trio then a
  generated sequence for anyone beyond that, so it scales to any field
  size. Axis labels included, for the "here's exactly where I cracked" view.

### Data model / how the numbers are computed

`parse_fit.py` only parses and resamples — it converts each rider's
recorded points to a uniform 1 Hz series aligned to real UTC epoch
seconds (not "seconds since start"), which is what lets riders line up
on one shared clock regardless of when their watch was started. Gaps in
recording longer than 30s (a stoplight, a paused watch) are left as
`null` rather than interpolated across, so the row heatmap can show "no
data" instead of inventing a flat line.

Every metric — average, Normalized Power, VI, sorting, the KPI numbers —
is computed **client-side in `web/app.js`**, from those same per-second
arrays, for whatever window is currently selected. There's deliberately
only one implementation of each metric, so the KPI tiles, the table, and
the row heatmap can never disagree with each other just because the
brush moved.

### Inspiration / prior art

Built after looking at a few existing GPX/ride-analysis tools:

- [msimms/ActivityAnalyzer](https://github.com/msimms/ActivityAnalyzer) —
  browser-side GPX/TCX/FIT analysis, interval detection.
- [gerritnowald/Garmin_analysis](https://github.com/gerritnowald/Garmin_analysis) —
  gpxpy + pandas, syncing multiple activities on the same route.
- [royceschultz/Cycling-Power-Calculator](https://github.com/royceschultz/Cycling-Power-Calculator) —
  Plotly-based GPX/FIT power visualization.
- The Normalized Power algorithm (30s rolling average, ⁴th power, mean,
  ⁴th root) is Coggan/TrainingPeaks' standard method.
- The "riders as synced rows" idea is closest in spirit to Strava's own
  **Flyby** feature (multiple riders' positions synced in time on one
  map) — this applies the same time-sync idea to a power heatmap instead
  of a map, which is the view that actually proves a pacing mistake.

### Repo layout

```
parse_fit.py              parses ./fit/*.fit -> web/data/riders.json
requirements.txt          fitparse
tools/generate_demo_data.py generates web/data/demo.json directly (no FIT files involved)
web/
  index.html
  style.css
  app.js
  lib/d3.v7.min.js        vendored D3 (ISC license) — no CDN dependency
  data/demo.json           committed demo dataset
  data/riders.json         your data — gitignored, generated locally
```

### Known limitations / open questions

- **Drag-to-reorder rows, and the "?" help tooltips, are hover/mouse
  patterns** — neither works on touch devices (drag-and-drop needs a real
  drag gesture; a tooltip needs a hover state touch doesn't have). This is
  a desktop-oriented local tool, so that's probably fine — flag it if you
  need this from a tablet/phone. The help tooltips are keyboard-focusable
  (tab to the "?", it shows the same as hovering) even though they're not
  touch-friendly.
- **`parse_fit.py` still picks the alignment reference alphabetically**,
  but that's no longer the whole story — the **Align clocks to** dropdown
  lets you re-run the correlation against any rider from the browser, live
  (see "Time alignment" above). No `--reference` flag needed.
- **Custom row order isn't persisted** — it resets on reload/re-parse, unlike
  the "you" pick. Seemed like the right default (a "you" pick is a fact
  about the race; a row order is a fact about what you're looking at right
  now) but easy to revisit if it's annoying in practice.
- **A low-confidence alignment is reported, not manually nudge-able, in the
  UI** — by design (see "Time alignment" above); the fix is picking a
  different, more reliable reference from the "Align clocks to" dropdown
  (or widening `--align-max-lag` and re-running the parser) rather than a
  two-second nudge on that one rider. Worth watching if low-confidence
  riders turn out to be common in practice, not just in the two real bugs
  that originally motivated this feature.
