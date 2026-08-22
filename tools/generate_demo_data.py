#!/usr/bin/env python3
"""
generate_demo_data.py — synthesize web/data/demo.json directly, so the web
app has something to show before you've run parse_fit.py on your own race.
No FIT/GPX files are written or read — `fitparse` can only read FIT, not
write it, and the point of this fixture is the JSON shape parse_fit.py
produces, not a round-trip through the binary format.

The scenario matches the real one this tool was built for: six riders in a
breakaway, "You" take a long pull on the front around minutes 18-24, burn a
lot more power than everyone else, blow up, and get dropped soon after. Two
riders have no power meter (GPS + HR only) and one has GPS only, to exercise
the "some people didn't have a powermeter" fallback paths. One rider's clock
("Priya") is recorded 7 seconds behind the rest, purely so the demo also
shows off suggest_time_offset() — imported straight from parse_fit.py —
recovering that automatically, the same way it would for a real race.

Usage:
    python3 tools/generate_demo_data.py
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from parse_fit import suggest_time_offset  # same alignment algorithm the real pipeline uses

START_EPOCH = int(datetime(2026, 6, 14, 13, 30, 0, tzinfo=timezone.utc).timestamp())
DURATION_MIN = 45


def course_latlon(frac: float) -> tuple[float, float]:
    """A gently winding out-and-back-ish course so the route panel has some
    shape. frac is 0..1 through the ride (index-based, same for every rider,
    which is also what makes the elevation curve below line up across
    riders early in the race — the assumption suggest_time_offset() relies
    on)."""
    lat0, lon0 = 45.5231, -122.6765
    angle = frac * 2.3 * math.pi
    r = 0.045 + 0.01 * math.sin(frac * 6.0)
    return lat0 + r * math.sin(angle), lon0 + r * (1 - math.cos(angle)) * 1.4


RIDERS = [
    # id,        name,          power_meter, hr_sensor, base_watts, base_hr
    ("you",      "You",          True,  True,  260, 148),
    ("alex",     "Alex",         True,  True,  245, 142),
    ("jordan",   "Jordan",       True,  True,  238, 140),
    ("sam",      "Sam",          True,  False, 250, None),
    ("priya",    "Priya",        False, True,  None, 145),
    ("devon",    "Devon",        False, False, None, None),
]


def build_rider_series(seed: int, base_watts, base_hr, has_power: bool, has_hr: bool):
    rng = random.Random(seed)
    n = DURATION_MIN * 60
    watts, hr, cad, speed = [], [], [], []
    pull_start, pull_end = 18 * 60, 24 * 60  # the segment "you" drag everyone
    blowup_end = 30 * 60
    for t in range(n):
        w = base_watts or 0
        h = base_hr or 0
        if seed == 0:  # "you": the pull, then the blow-up
            if pull_start <= t < pull_end:
                w = base_watts + 145 + 20 * math.sin(t / 25)
                h = min(188, base_hr + 34 + (t - pull_start) / 6)
            elif pull_end <= t < blowup_end:
                frac = (t - pull_end) / (blowup_end - pull_end)
                w = base_watts + 145 - 210 * frac
                h = max(base_hr + 6, 182 - 25 * frac)
            elif t >= blowup_end:
                w = base_watts - 35 + 15 * math.sin(t / 40)
                h = base_hr - 8 + 6 * math.sin(t / 50)
            else:
                w = base_watts + 12 * math.sin(t / 30)
                h = base_hr + 4 * math.sin(t / 40)
        else:  # the group: drafting behind during the pull (lower watts), then
               # surging past once "you" crack (their own dig for the counter)
            if pull_start <= t < pull_end:
                draft_factor = 0.62 + 0.05 * math.sin(t / 20 + seed)
                w = (base_watts or 0) * draft_factor + 10
                h = (base_hr or 0) * 0.94 if base_hr else 0
            elif pull_end <= t < pull_end + 90:
                w = (base_watts or 0) + 60 + 15 * math.sin(t / 10 + seed)
                h = min(185, (base_hr or 0) + 22) if base_hr else 0
            else:
                w = (base_watts or 0) + 8 * math.sin(t / 35 + seed)
                h = (base_hr or 0) + 5 * math.sin(t / 45 + seed) if base_hr else 0

        w = max(0, w + rng.uniform(-9, 9)) if has_power else None
        h = max(0, h + rng.uniform(-2, 2)) if has_hr else None
        c = max(0, 85 + rng.uniform(-6, 6) + (10 if w and w > 300 else 0))
        sp = 8.5 + (0.012 * (w or 220)) + rng.uniform(-0.3, 0.3)  # crude m/s model

        watts.append(round(w, 1) if w is not None else None)
        hr.append(round(h, 1) if h is not None else None)
        cad.append(round(c, 1))
        speed.append(round(max(2.0, sp), 2))
    return watts, hr, cad, speed


def build_rider(idx: int, rid: str, name: str, has_power: bool, has_hr: bool, base_w, base_h, clock_offset_s: int) -> dict:
    watts, hr, cad, speed = build_rider_series(idx, base_w, base_h, has_power, has_hr)
    n = len(watts)
    lat, lon, ele, dist_m = [], [], [], []
    cum = 0.0
    for i in range(n):
        frac = i / n
        la, lo = course_latlon(frac)
        lat.append(round(la, 6))
        lon.append(round(lo, 6))
        ele.append(round(45 + 12 * math.sin(frac * 6.0), 1))
        cum += speed[i]
        dist_m.append(round(cum, 1))

    return {
        "id": rid,
        "name": name,
        "file": f"{rid}.fit",
        "t0": START_EPOCH + clock_offset_s,
        "n": n,
        "hasPower": has_power,
        "hasHR": has_hr,
        "hasCadence": True,
        "distanceM": dist_m[-1],
        "durationS": n - 1,
        "power": watts if has_power else None,
        "hr": hr if has_hr else None,
        "cad": cad,
        "ele": ele,
        "speed": speed,
        "distM": dist_m,
        "lat": lat,
        "lon": lon,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "web" / "data" / "demo.json")
    ap.add_argument("--align-window", type=int, default=1200)
    ap.add_argument("--align-max-lag", type=int, default=50400)
    args = ap.parse_args()

    riders = []
    for idx, (rid, name, has_power, has_hr, base_w, base_h) in enumerate(RIDERS):
        offset = -7 if rid == "priya" else 0
        riders.append(build_rider(idx, rid, name, has_power, has_hr, base_w, base_h, offset))

    reference = riders[0]
    reference["suggestedOffsetS"] = 0
    reference["offsetConfidence"] = None
    for r in riders[1:]:
        lag, corr = suggest_time_offset(reference, r, window_s=args.align_window, max_lag_s=args.align_max_lag)
        r["suggestedOffsetS"] = lag if lag is not None else 0
        r["offsetConfidence"] = corr
        print(f"  {r['name']}: suggest {r['suggestedOffsetS']:+d}s (correlation {corr})")

    bundle = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "maxGapS": 30.0,
        "referenceRiderId": reference["id"],
        "riders": riders,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(bundle, separators=(",", ":")))
    print(f"Wrote {len(riders)} rider(s) to {args.out}")


if __name__ == "__main__":
    main()
