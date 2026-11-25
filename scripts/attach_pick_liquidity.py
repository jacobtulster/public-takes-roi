#!/usr/bin/env python3
"""Stamp open picks with combined 4C+NV liquidity while still pre-tip.

Freezes the first pre-tip snapshot so we can later compare high vs low
liquidity dogs (and whether the book also leaned dog).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PICKS_PATH = ROOT / "data" / "picks.json"
LIQ_4C = ROOT / "data" / "liquidity.json"
LIQ_NV = ROOT / "data" / "novig_liquidity.json"

ALIASES = {
    "mississippi": "ole miss",
    "ole miss": "ole miss",
    "l a clippers": "los angeles clippers",
    "la clippers": "los angeles clippers",
    "l a lakers": "los angeles lakers",
    "la lakers": "los angeles lakers",
    "ut martin": "tennessee martin",
    "cs fullerton": "cal state fullerton",
    "ul lafayette": "louisiana",
    "ipfw": "purdue fort wayne",
    "se missouri state": "southeast missouri",
    "umkc": "kansas city",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def load(path: Path) -> Any:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def canon(s: str) -> str:
    t = str(s or "").lower().replace("'", "")
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = re.sub(r"\b(university|univ|the|saint|st)\b", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return ALIASES.get(t, t)


def name_hit(a: str, b: str) -> bool:
    left, right = canon(a), canon(b)
    if not left or not right:
        return False
    if left == right or left in right or right in left:
        return True
    lt = [x for x in left.split() if len(x) > 1]
    rt = [x for x in right.split() if len(x) > 1]
    if not lt or not rt:
        return False
    return sum(1 for x in lt if x in rt) >= min(2, len(lt), len(rt))


def top3_sum(levels: Any) -> float:
    tot = 0.0
    for row in levels or []:
        if not isinstance(row, dict):
            continue
        try:
            v = float(row.get("size") or 0)
        except (TypeError, ValueError):
            continue
        if v > 0:
            tot += v
    return tot


def is_nhl_mlb(blob: str) -> bool:
    u = blob.upper()
    return any(x in u for x in ("NHL", "MLB", "HOCKEY", "BASEBALL"))


def plus15(line: Any, top3: Any) -> bool:
    try:
        if abs(float(line) - 1.5) > 0.05:
            return False
    except (TypeError, ValueError):
        return False
    for row in top3 or []:
        if not isinstance(row, dict):
            continue
        try:
            o = float(row.get("odds"))
        except (TypeError, ValueError):
            continue
        if -145 <= o <= 100:
            return True
    return False


def book_for(game: dict[str, Any], market: str) -> dict[str, Any] | None:
    sp = game.get("spread") if isinstance(game.get("spread"), dict) else None
    ml = game.get("moneyline") if isinstance(game.get("moneyline"), dict) else None
    sport_blob = f"{game.get('sport') or ''} {game.get('league') or ''}"
    if is_nhl_mlb(sport_blob):
        if sp and (
            plus15(sp.get("awayLine"), sp.get("awayTop3"))
            or plus15(sp.get("homeLine"), sp.get("homeTop3"))
        ):
            return sp
        return ml or sp
    if market == "ml":
        return ml
    if sp and top3_sum(sp.get("awayTop3")) + top3_sum(sp.get("homeTop3")) > 0:
        return sp
    return ml or sp


def find_game(pick: dict[str, Any], games: list[Any]) -> tuple[dict[str, Any] | None, bool]:
    away, home = pick.get("away") or "", pick.get("home") or ""
    for g in games or []:
        if not isinstance(g, dict):
            continue
        fwd = name_hit(away, g.get("away")) and name_hit(home, g.get("home"))
        rev = name_hit(away, g.get("home")) and name_hit(home, g.get("away"))
        if fwd or rev:
            return g, (not fwd and rev)
    return None, False


def market_of(pick: dict[str, Any]) -> str:
    m = str(pick.get("market") or "").lower()
    return "ml" if m in ("ml", "moneyline", "h2h") else "spread"


def venue_sides(pick: dict[str, Any], games: list[Any]) -> dict[str, Any] | None:
    g, flipped = find_game(pick, games)
    if not g:
        return None
    book = book_for(g, market_of(pick))
    if not book:
        return None
    a = top3_sum(book.get("awayTop3"))
    h = top3_sum(book.get("homeTop3"))
    if flipped:
        a, h = h, a
    return {
        "away": a,
        "home": h,
        "oi": float(g.get("openInterest") or 0),
        "rank": g.get("rank"),
    }


def snapshot_for(pick: dict[str, Any], games4: list[Any], gamesN: list[Any]) -> dict[str, Any] | None:
    s4 = venue_sides(pick, games4)
    sN = venue_sides(pick, gamesN)
    # Combined stamp only when BOTH venues have top-3 $
    if not s4 or not sN:
        return None
    if s4["away"] + s4["home"] <= 0 or sN["away"] + sN["home"] <= 0:
        return None
    away = s4["away"] + sN["away"]
    home = s4["home"] + sN["home"]
    total = away + home
    if total <= 0:
        return None
    lo = min(away, home)
    ratio = (max(away, home) / lo) if lo > 0 else 99.0
    heavy = "away" if away > home else "home" if home > away else None
    take_side = str(pick.get("takeSide") or "").lower()
    agrees = bool(heavy and take_side in ("away", "home") and heavy != take_side)
    role = str(pick.get("takeRole") or "").upper()
    oc = str(pick.get("ocLean") or "").lower()
    bucket = str(pick.get("bucket") or "")
    favorable = oc == "favorable" or (
        "favorable" in bucket and "not_favorable" not in bucket
    )
    # Good fav: fav favorable + combined heavy on dog. Good dog: dog favorable + heavy on fav.
    good_fav = bool(agrees and favorable and role == "FAV")
    good_dog = bool(agrees and favorable and role == "DOG")
    return {
        "combinedTop3": round(total, 2),
        "combinedAwayTop3": round(away, 2),
        "combinedHomeTop3": round(home, 2),
        "combinedRatio": round(ratio, 2),
        "combinedHeavySide": heavy,
        "combinedOi": round(s4["oi"] + sN["oi"], 2),
        "liqAgreesTake": agrees,
        "goodFav": good_fav,
        "goodDog": good_dog,
        "fourcastersTop3": round(s4["away"] + s4["home"], 2),
        "novigTop3": round(sN["away"] + sN["home"], 2),
        "snappedAt": _now_iso(),
        "frozen": False,
    }


def parse_start(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def main() -> int:
    store = load(PICKS_PATH)
    picks = store.get("picks") if isinstance(store, dict) else None
    if not isinstance(picks, list):
        print("no picks")
        return 0
    games4 = (load(LIQ_4C) or {}).get("games") or []
    gamesN = (load(LIQ_NV) or {}).get("games") or []
    if not isinstance(games4, list):
        games4 = []
    if not isinstance(gamesN, list):
        gamesN = []

    now = _now()
    updated = 0
    frozen = 0
    for pick in picks:
        if not isinstance(pick, dict):
            continue
        existing = pick.get("liqSnap") if isinstance(pick.get("liqSnap"), dict) else None
        start = parse_start(pick.get("startAt"))
        tipped = bool(start and start <= now)

        if existing and existing.get("frozen"):
            # Backfill goodFav/goodDog on older frozen stamps
            if "goodFav" not in existing or "goodDog" not in existing:
                role = str(pick.get("takeRole") or "").upper()
                oc = str(pick.get("ocLean") or "").lower()
                bucket = str(pick.get("bucket") or "")
                favorable = oc == "favorable" or (
                    "favorable" in bucket and "not_favorable" not in bucket
                )
                agrees = bool(existing.get("liqAgreesTake"))
                existing["goodFav"] = bool(agrees and favorable and role == "FAV")
                existing["goodDog"] = bool(agrees and favorable and role == "DOG")
                pick["liqSnap"] = existing
                updated += 1
            continue
        if tipped and existing:
            existing["frozen"] = True
            role = str(pick.get("takeRole") or "").upper()
            oc = str(pick.get("ocLean") or "").lower()
            bucket = str(pick.get("bucket") or "")
            favorable = oc == "favorable" or (
                "favorable" in bucket and "not_favorable" not in bucket
            )
            agrees = bool(existing.get("liqAgreesTake"))
            existing["goodFav"] = bool(agrees and favorable and role == "FAV")
            existing["goodDog"] = bool(agrees and favorable and role == "DOG")
            pick["liqSnap"] = existing
            frozen += 1
            updated += 1
            continue
        if tipped and not existing:
            # too late to fair-stamp
            continue

        snap = snapshot_for(pick, games4, gamesN)
        if not snap:
            continue
        if existing and not existing.get("frozen"):
            # refresh live open stamp
            pick["liqSnap"] = snap
            updated += 1
        elif not existing:
            pick["liqSnap"] = snap
            updated += 1

    if isinstance(store, dict):
        store["liqSnapUpdatedAt"] = _now_iso()
        PICKS_PATH.write_text(json.dumps(store, indent=2) + "\n", encoding="utf-8")
    print(f"attach_pick_liquidity: updated={updated} newly_frozen={frozen}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
