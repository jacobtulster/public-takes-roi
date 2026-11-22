#!/usr/bin/env python3
"""Grade open public-% picks from ESPN finals and rewrite data/picks.json."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PICKS_PATH = ROOT / "data" / "picks.json"

ESPN_SPORT = {
    "NCAAF": "football/college-football",
    "CFB": "football/college-football",
    "COLLEGE FOOTBALL": "football/college-football",
    "NFL": "football/nfl",
    "NBA": "basketball/nba",
    "NCAAB": "basketball/mens-college-basketball",
    "CBB": "basketball/mens-college-basketball",
    "COLLEGE BASKETBALL": "basketball/mens-college-basketball",
    "NHL": "hockey/nhl",
    "MLB": "baseball/mlb",
    "WNBA": "basketball/wnba",
}

UA = {"User-Agent": "public-takes-roi-grader/1.0"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _get_json(url: str) -> dict[str, Any] | None:
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"  fetch fail {url}: {exc}")
        return None


def american_profit(result: str, price: float | None) -> float:
    r = str(result or "").upper()
    if r == "P":
        return 0.0
    if r == "L":
        return -1.0
    try:
        p = float(price) if price is not None else -110.0
    except (TypeError, ValueError):
        p = -110.0
    if p == 0:
        p = -110.0
    if p > 0:
        return round(p / 100.0, 4)
    return round(100.0 / abs(p), 4)


def grade_spread(side: str, line: float, away: float, home: float) -> str | None:
    try:
        a = float(away)
        h = float(home)
        ln = float(line)
    except (TypeError, ValueError):
        return None
    # `line` is the points applied to the take side (dogs positive, favs negative).
    if str(side).lower() == "away":
        margin = a + ln - h
    else:
        margin = h + ln - a
    if abs(margin) < 1e-9:
        return "P"
    return "W" if margin > 0 else "L"


def grade_moneyline(side: str, away: float, home: float) -> str | None:
    try:
        a = float(away)
        h = float(home)
    except (TypeError, ValueError):
        return None
    if a == h:
        return "P"
    pick_away = str(side).lower() == "away"
    won = (a > h) if pick_away else (h > a)
    return "W" if won else "L"


def sport_path(pick: dict[str, Any]) -> str | None:
    sport = str(pick.get("sport") or "").upper().strip()
    if sport in ESPN_SPORT:
        return ESPN_SPORT[sport]
    league = str(pick.get("league") or "").upper()
    # Prefer longer keys first so "COLLEGE FOOTBALL" wins over bare "FOOTBALL".
    for key, path in sorted(ESPN_SPORT.items(), key=lambda kv: -len(kv[0])):
        if key == sport or key in league:
            return path
    # OddsLogic sometimes labels CFB only in the league banner.
    if "COLLEGE FOOTBALL" in league or "NCAAF" in league or league.startswith("CFB"):
        return ESPN_SPORT["NCAAF"]
    if "COLLEGE BASKETBALL" in league or "NCAAB" in league or "CBB" in league:
        return ESPN_SPORT["NCAAB"]
    return None


def parse_summary(payload: dict[str, Any]) -> dict[str, Any] | None:
    header = payload.get("header") or {}
    comps = header.get("competitions") or payload.get("competitions") or []
    if not comps:
        return None
    comp = comps[0]
    status = ((comp.get("status") or {}).get("type") or {})
    if not (status.get("completed") or str(status.get("name") or "").upper() == "STATUS_FINAL"):
        return None
    competitors = comp.get("competitors") or []
    home = next((c for c in competitors if c.get("homeAway") == "home"), None)
    away = next((c for c in competitors if c.get("homeAway") == "away"), None)
    if not home or not away:
        return None
    try:
        return {
            "awayScore": float(away.get("score")),
            "homeScore": float(home.get("score")),
            "detail": status.get("detail") or status.get("description") or "Final",
        }
    except (TypeError, ValueError):
        return None


def fetch_final(pick: dict[str, Any], cache: dict[str, dict[str, Any] | None]) -> dict[str, Any] | None:
    event_id = str(pick.get("espnEventId") or "").strip()
    path = sport_path(pick)
    if not event_id or not path:
        return None
    key = f"{path}|{event_id}"
    if key not in cache:
        url = f"https://site.api.espn.com/apis/site/v2/sports/{path}/summary?event={event_id}"
        payload = _get_json(url)
        cache[key] = parse_summary(payload) if payload else None
        time.sleep(0.15)
    return cache[key]


def grade_pick(pick: dict[str, Any], score: dict[str, Any]) -> bool:
    market = str(pick.get("market") or "spread").lower()
    side = pick.get("takeSide") or pick.get("side")
    away = score["awayScore"]
    home = score["homeScore"]
    if market in {"ml", "moneyline", "h2h"}:
        result = grade_moneyline(side, away, home)
    else:
        result = grade_spread(side, pick.get("line"), away, home)
    if not result:
        return False
    pick["result"] = result
    pick["profit"] = american_profit(result, pick.get("price"))
    pick["awayScore"] = away
    pick["homeScore"] = home
    pick["gradedAt"] = _now_iso()
    pick["gradeSource"] = "espn"
    pick["gradeDetail"] = score.get("detail")
    return True


def main() -> int:
    if not PICKS_PATH.exists():
        print(f"Missing {PICKS_PATH}")
        return 1
    store = json.loads(PICKS_PATH.read_text(encoding="utf-8"))
    picks = store.get("picks") if isinstance(store, dict) else store
    if not isinstance(picks, list):
        print("No picks list found")
        return 1

    cache: dict[str, dict[str, Any] | None] = {}
    graded = 0
    open_n = 0
    for pick in picks:
        if not isinstance(pick, dict):
            continue
        if str(pick.get("result") or "").upper() in {"W", "L", "P"}:
            continue
        open_n += 1
        score = fetch_final(pick, cache)
        if not score:
            continue
        if grade_pick(pick, score):
            graded += 1
            print(
                f"  graded {pick.get('away')} @ {pick.get('home')} "
                f"{pick.get('takeTeam')} → {pick.get('result')} "
                f"({pick.get('awayScore')}-{pick.get('homeScore')})"
            )

    payload = {
        "updatedAt": _now_iso(),
        "picks": picks,
    }
    PICKS_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Graded {graded}/{open_n} open picks → {PICKS_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
