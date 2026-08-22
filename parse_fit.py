#!/usr/bin/env python3
"""
parse_fit.py — turn a folder of race-day .fit exports (one per rider) into a
single JSON bundle the web app in web/ can load.

FIT only. This tool used to also accept GPX, but FIT is strictly better for
this job: it stores time as a raw UTC seconds-since-epoch integer instead of
a hand-formatted string, so it can't have a *string-parsing* "declared UTC
but actually local time" bug, or a "start time truncated to midnight" bug —
both real bugs this project hit with real GPX exports before FIT support
existed. It's not full immunity, though: a device whose own clock/timezone
is misconfigured can still write a wrong-by-a-round-number-of-hours epoch
into a FIT file's timestamp field, because that's a bug in what the device
computed, not in how the file encodes it -- see suggest_time_offset()'s
docstring for a real example this tool's own test data hit. FIT also
carries the device's own measured distance/speed and one standardized field
name per stream, instead of needing per-vendor extension-tag guessing.
Garmin Connect, Wahoo, and most platforms export .fit directly; if you're
going through Sauce for Strava, its export panel offers FIT — take that one.

Needs `fitparse` (pip install -r requirements.txt).

WHAT IT COMPUTES
-----------------
- A per-rider 1 Hz resample of every stream, aligned to real UTC epoch
  seconds (not "seconds since start") so riders line up on a shared race
  clock in the browser. Resampling is gap-aware: gaps longer than
  --max-gap (default 30s — e.g. a stoplight, an aid-station stop, a paused
  recording) are left as null rather than interpolated or flat-filled, so
  the web app can render them as "no data" instead of inventing values.
- Cumulative distance from the device's own recorded distance field.
- A suggested clock-offset correction per rider (see suggest_time_offset()),
  found by cross-correlating each rider's elevation-vs-time curve against a
  reference rider over the first --align-window seconds of the race, and
  searching lags up to +/- --align-max-lag — see the README's "Time
  alignment" section for the real-world causes this catches. The web app
  applies this correction automatically; there's no manual per-rider offset
  screen to fight with, though the "Align clocks to" picker in the browser
  can re-run this same search against a different reference rider live.

Everything else (average power, Normalized Power, HR, sorting, the
selected-segment stats) is computed client-side in web/app.js from these
per-second arrays, so there's exactly one implementation of each metric —
you don't want the Python summary and the browser's live "select the pull
segment" recompute to ever disagree.

USAGE
-----
    python3 parse_fit.py --input ./fit --output web/data/riders.json
    python3 parse_fit.py --input ./fit --output web/data/riders.json --names names.json

    names.json (optional) maps filename stems to display names:
        { "kyle_race_export": "Kyle", "garmin_export_1234": "Alex" }

There's no --me flag: pick "you" from the web app's dropdown instead — it's
remembered in the browser, and unlike a CLI flag it's a single click instead
of re-running the parser if you picked the wrong rider.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_MAX_GAP = 30.0  # seconds; gaps longer than this are left null, not interpolated


def _require_fitparse():
    try:
        import fitparse  # noqa: F401
    except ImportError:
        print("parse_fit.py needs the 'fitparse' package: pip install -r requirements.txt", file=sys.stderr)
        sys.exit(1)


def parse_fit_file(path: Path) -> list[dict]:
    """Parses a FIT file's 'record' messages into point dicts: t/lat/lon/ele/
    hr/power/cad/speed_ext/dist_m, straight from the FIT profile's
    standardized field names — no tag-guessing needed."""
    import fitparse

    def first_present(vals: dict, *keys):
        for k in keys:
            v = vals.get(k)
            if v is not None:
                return v
        return None

    fit = fitparse.FitFile(str(path))
    points = []
    for msg in fit.get_messages("record"):
        vals = {f.name: f.value for f in msg}
        t = vals.get("timestamp")
        if t is None:
            continue
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)  # FIT timestamps are UTC by spec
        else:
            t = t.astimezone(timezone.utc)

        lat_semi = vals.get("position_lat")
        lon_semi = vals.get("position_long")
        point = {
            "t": t,
            "lat": lat_semi * (180 / 2**31) if lat_semi is not None else None,
            "lon": lon_semi * (180 / 2**31) if lon_semi is not None else None,
            "ele": first_present(vals, "enhanced_altitude", "altitude"),
            "hr": vals.get("heart_rate"),
            "power": vals.get("power"),
            "cad": vals.get("cadence"),
            "speed_ext": first_present(vals, "enhanced_speed", "speed"),
        }
        dist = vals.get("distance")
        if dist is not None:
            point["dist_m"] = float(dist)
        points.append(point)

    points.sort(key=lambda p: p["t"])
    deduped = []
    for p in points:
        if deduped and deduped[-1]["t"] == p["t"]:
            deduped[-1] = p
        else:
            deduped.append(p)
    return deduped


def add_distance(points: list[dict]) -> None:
    """Holds distance flat across any point missing the device's own dist_m
    (e.g. a brief GPS/sensor dropout) rather than crashing on a gap."""
    if "dist_m" not in points[0]:
        points[0]["dist_m"] = 0.0
    cum = points[0]["dist_m"]
    for i in range(1, len(points)):
        if "dist_m" in points[i]:
            cum = points[i]["dist_m"]
        else:
            points[i]["dist_m"] = cum


def resample_field(times: list[float], values: list[float | None], grid: range, max_gap: float) -> list[float | None]:
    """Two-pointer linear-interpolation resample onto a 1Hz integer-second grid.
    Gaps in the source longer than max_gap become null instead of being bridged."""
    pts_t = []
    pts_v = []
    for t, v in zip(times, values):
        if v is None:
            continue
        pts_t.append(t)
        pts_v.append(v)
    n = len(pts_t)
    out: list[float | None] = [None] * len(grid)
    if n == 0:
        return out
    j = 0
    for i, t in enumerate(grid):
        while j + 1 < n and pts_t[j + 1] <= t:
            j += 1
        if t < pts_t[0] or t > pts_t[-1]:
            continue
        if j + 1 >= n:
            out[i] = pts_v[j] if pts_t[j] == t else None
            continue
        t0, t1 = pts_t[j], pts_t[j + 1]
        if t1 - t0 > max_gap:
            continue
        if t1 == t0:
            out[i] = pts_v[j]
        else:
            frac = (t - t0) / (t1 - t0)
            out[i] = pts_v[j] + frac * (pts_v[j + 1] - pts_v[j])
    return out


def derive_speed(dist_1hz: list[float | None]) -> list[float | None]:
    """Central-difference speed (m/s) from a resampled cumulative-distance curve."""
    n = len(dist_1hz)
    out: list[float | None] = [None] * n
    for i in range(n):
        lo = i - 1 if i - 1 >= 0 else i
        hi = i + 1 if i + 1 < n else i
        if lo == hi or dist_1hz[lo] is None or dist_1hz[hi] is None:
            continue
        out[i] = (dist_1hz[hi] - dist_1hz[lo]) / (hi - lo)
    return out


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "rider"


def moving_average(vals: list[float | None], window: int) -> list[float | None]:
    n = len(vals)
    out: list[float | None] = [None] * n
    half = window // 2
    for i in range(n):
        chunk = [v for v in vals[max(0, i - half):min(n, i + half + 1)] if v is not None]
        out[i] = sum(chunk) / len(chunk) if chunk else None
    return out


def _epoch_map(rider: dict, field: str, window_s: int, smooth_window: int) -> dict[int, float]:
    vals = rider.get(field)
    if not vals:
        return {}
    smoothed = moving_average(vals[:window_s], smooth_window)
    t0 = rider["t0"]
    return {t0 + i: v for i, v in enumerate(smoothed) if v is not None}


def _correlation_at_lag(ref_map: dict[int, float], other_map: dict[int, float], lag: int, min_overlap: int = 90) -> float | None:
    xs, ys = [], []
    for t, rv in ref_map.items():
        ov = other_map.get(t - lag)
        if ov is None:
            continue
        xs.append(rv)
        ys.append(ov)
    n = len(xs)
    if n < min_overlap:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / math.sqrt(sxx * syy)


def suggest_time_offset(
    ref_rider: dict, other_rider: dict, window_s: int = 1200, max_lag_s: int = 50400, coarse_step_s: int = 15
) -> tuple[int | None, float | None]:
    """Find the clock offset (seconds, to add to `other_rider`'s recorded
    time) that best lines up its elevation-vs-time curve with the reference
    rider's, by trying candidate lags and keeping the one with the strongest
    correlation. Returns (offset_seconds, correlation) or (None, None) if
    there isn't enough overlapping elevation data to say anything.

    Elevation, not power/speed/HR, because it's the one stream nearly every
    GPS file has, and because early in a mass-start race the field is still
    together — everyone crests the same rollers within a second or two of
    each other — so elevation-vs-time is close to a pure time-shifted copy
    across riders before the group splits up. That's also why this only
    looks at the first `window_s` seconds of each rider's own recording
    (default 20 min): it's the part of the race where that assumption holds
    best.

    The search range defaults to +/-14 hours. An earlier version of this
    docstring argued FIT's raw epoch-integer timestamps ruled out
    hours-scale bugs entirely and narrowed this to +/-4h -- that reasoning
    was incomplete, and real race data caught it: FIT does rule out a
    *string-parsing* bug (something misreading "is this local or UTC"), but
    it can't rule out the *device* computing its "UTC" timestamp field from
    a locally-misconfigured timezone offset in the first place, which
    produces the identical symptom -- a whole, suspiciously-round number of
    hours off. In one real field of 10 FIT files, 9 needed a +7.00h
    correction relative to the 10th (confirmed at correlation ~0.998-0.999,
    nowhere near ambiguous); a +/-4h search never finds that, because it
    never even tries a lag that far out. Which file is "right" barely
    matters -- what matters is finding the lag that makes elevation curves
    line up, and +/-4h wasn't wide enough to try. If a rider you know was on
    the same road still comes back with no suggestion at +/-14h, widen
    --align-max-lag further before assuming the elevation match itself
    failed.
    """
    ref_map = _epoch_map(ref_rider, "ele", window_s, smooth_window=7)
    other_map = _epoch_map(other_rider, "ele", window_s, smooth_window=7)
    if len(ref_map) < 90 or len(other_map) < 90:
        return None, None

    best_lag, best_corr = None, -2.0
    for lag in range(-max_lag_s, max_lag_s + 1, coarse_step_s):
        corr = _correlation_at_lag(ref_map, other_map, lag)
        if corr is not None and corr > best_corr:
            best_corr, best_lag = corr, lag
    if best_lag is None:
        return None, None

    # refine to the exact second around the coarse-grid best
    for lag in range(best_lag - coarse_step_s, best_lag + coarse_step_s + 1):
        corr = _correlation_at_lag(ref_map, other_map, lag)
        if corr is not None and corr > best_corr:
            best_corr, best_lag = corr, lag
    return best_lag, round(best_corr, 3)


def build_rider(path: Path, names: dict) -> dict | None:
    points = parse_fit_file(path)
    if len(points) < 2:
        print(f"  skipping {path.name}: fewer than 2 timestamped records", file=sys.stderr)
        return None
    add_distance(points)

    t0_dt = points[0]["t"]
    t1_dt = points[-1]["t"]
    t0 = int(t0_dt.timestamp())
    t1 = int(t1_dt.timestamp())
    grid = range(t0, t1 + 1)
    times = [p["t"].timestamp() for p in points]

    fields = {}
    for key in ("hr", "power", "cad", "ele", "dist_m", "speed_ext"):
        vals = [p.get(key) for p in points]
        if any(v is not None for v in vals):
            fields[key] = resample_field(times, vals, grid, DEFAULT_MAX_GAP)

    lat = resample_field(times, [p["lat"] for p in points], grid, DEFAULT_MAX_GAP)
    lon = resample_field(times, [p["lon"] for p in points], grid, DEFAULT_MAX_GAP)

    if "speed_ext" in fields:
        speed = fields.pop("speed_ext")
    else:
        speed = derive_speed(fields.get("dist_m", resample_field(times, [p["dist_m"] for p in points], grid, DEFAULT_MAX_GAP)))

    stem = path.stem
    name = names.get(stem, stem.replace("_", " ").replace("-", " ").strip().title())
    rider_id = slugify(stem)

    def rnd(seq, digits):
        if seq is None:
            return None
        return [None if v is None else round(v, digits) for v in seq]

    n_power = sum(1 for v in fields.get("power", []) if v is not None)
    n_hr = sum(1 for v in fields.get("hr", []) if v is not None)

    return {
        "id": rider_id,
        "name": name,
        "file": path.name,
        "t0": t0,
        "n": len(grid),
        "hasPower": n_power > 0,
        "hasHR": n_hr > 0,
        "hasCadence": "cad" in fields,
        "distanceM": round(points[-1]["dist_m"], 1),
        "durationS": t1 - t0,
        "power": rnd(fields.get("power"), 1),
        "hr": rnd(fields.get("hr"), 1),
        "cad": rnd(fields.get("cad"), 1),
        "ele": rnd(fields.get("ele"), 1),
        "speed": rnd(speed, 3),
        "distM": rnd(fields.get("dist_m"), 1),
        "lat": rnd(lat, 6),
        "lon": rnd(lon, 6),
    }


def main() -> None:
    global DEFAULT_MAX_GAP
    _require_fitparse()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", "-i", required=True, type=Path, help="folder containing *.fit files")
    ap.add_argument("--output", "-o", required=True, type=Path, help="output JSON path, e.g. web/data/riders.json")
    ap.add_argument("--names", type=Path, default=None, help="optional JSON file mapping filename stem -> display name")
    ap.add_argument("--max-gap", type=float, default=DEFAULT_MAX_GAP, help="seconds; longer recording gaps are left null instead of bridged (default 30)")
    ap.add_argument("--align", action=argparse.BooleanOptionalAction, default=True,
                     help="auto-suggest each rider's clock-offset correction by cross-correlating elevation-vs-time against the reference rider (default: on; use --no-align to skip)")
    ap.add_argument("--align-window", type=int, default=1200, help="seconds of each rider's early recording to correlate on (default 1200 = 20 min)")
    ap.add_argument("--align-max-lag", type=int, default=50400, help="furthest offset to search in either direction, seconds (default 50400 = 14h — see suggest_time_offset() docstring: a device with a misconfigured timezone can still produce a whole-hours offset even on FIT)")
    args = ap.parse_args()
    DEFAULT_MAX_GAP = args.max_gap

    names = {}
    if args.names:
        names = json.loads(args.names.read_text())

    input_files = sorted(set(args.input.glob("*.fit")) | set(args.input.glob("*.FIT")))
    if not input_files:
        print(f"No .fit files found in {args.input}", file=sys.stderr)
        sys.exit(1)

    riders = []
    print(f"Parsing {len(input_files)} file(s) from {args.input}:")
    for path in input_files:
        print(f"  {path.name} ...", end=" ")
        rider = build_rider(path, names)
        if rider is None:
            continue
        riders.append(rider)
        flags = []
        if rider["hasPower"]:
            flags.append("power")
        if rider["hasHR"]:
            flags.append("hr")
        print(f"{rider['durationS']//60}min, {rider['distanceM']/1000:.1f}km [{', '.join(flags) or 'gps only'}]")

    if not riders:
        print("Nothing parseable — no output written.", file=sys.stderr)
        sys.exit(1)

    # The first file (alphabetically) anchors the clock-alignment search and
    # is the default "you" in the web app until you pick someone else there
    # — there's no --me flag; a single wrong file isn't worth a re-run for.
    reference_id = None
    if args.align and len(riders) > 1:
        reference = riders[0]
        reference_id = reference["id"]
        reference["suggestedOffsetS"] = 0
        reference["offsetConfidence"] = None
        print(f"\nAligning clocks against '{reference['name']}' (first {args.align_window}s of each recording, "
              f"±{args.align_max_lag}s search)...")
        for r in riders:
            if r["id"] == reference_id:
                continue
            lag, corr = suggest_time_offset(reference, r, window_s=args.align_window, max_lag_s=args.align_max_lag)
            r["suggestedOffsetS"] = lag
            r["offsetConfidence"] = corr
            if lag is None:
                print(f"  {r['name']}: not enough overlapping elevation data to align — leave at 0 or nudge by hand.")
            else:
                confidence = "low confidence, verify by eye" if corr < 0.5 else ("weak" if corr < 0.8 else "strong")
                print(f"  {r['name']}: suggest {lag:+d}s (correlation {corr:.2f} — {confidence})")
    else:
        reference_id = riders[0]["id"] if riders else None
        for r in riders:
            r["suggestedOffsetS"] = 0
            r["offsetConfidence"] = None

    bundle = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "maxGapS": DEFAULT_MAX_GAP,
        "referenceRiderId": reference_id,
        "riders": riders,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(bundle, separators=(",", ":")))
    size_kb = args.output.stat().st_size / 1024
    print(f"\nWrote {len(riders)} rider(s) to {args.output} ({size_kb:,.0f} KB)")
    print("Serve the web/ folder locally, e.g.:\n  cd web && python3 -m http.server 8000\nthen open http://localhost:8000")
    print("Pick \"you\" from the dropdown at the top of the page — it's remembered in the browser.")


if __name__ == "__main__":
    main()
