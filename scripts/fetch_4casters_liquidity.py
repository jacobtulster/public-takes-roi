#!/usr/bin/env python3
"""Snapshot today's 4casters orderbooks → data/liquidity.json.

Ranks games by openInterest (resting maker liquidity). For each game, stores
top-3 price levels per side on moneyline + spread so the site can spot heavy
pending money on one side.

Auth: env FOURCASTERS_TOKEN (API key / session token from 4casters).
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "data" / "liquidity.json"

# Primary books we care about for public-% takes
LEAGUES = ["NCAAB", "NBA", "NFL", "NCAAF", "NHL", "WNBA"]

API = "https://api.4casters.io"
UA = {"User-Agent": "public-takes-roi-liquidity/1.0", "Accept": "application/json"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _token() -> str:
    return (os.environ.get("FOURCASTERS_TOKEN") or os.environ.get("FOURCASTERS_API_KEY") or "").strip()


def _get_json(url: str, token: str) -> dict[str, Any] | None:
    req = urllib.request.Request(
        url,
        headers={
            **UA,
            "Authorization": "Bearer " + token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"  fetch fail {url}: {exc}")
        return None


def et_ymd(dt: datetime) -> str:
    # Fixed -5 offset is fine for bucket labels; DST drift is acceptable for "today"
    eastern = timezone(timedelta(hours=-5))
    local = dt.astimezone(eastern)
    return f"{local.year:04d}-{local.month:02d}-{local.day:02d}"


def parse_start(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def participant_names(game: dict[str, Any]) -> tuple[str, str]:
    parts = game.get("participants") or []
    away = ""
    home = ""
    for p in parts:
        if not isinstance(p, dict):
            continue
        name = str(p.get("longName") or p.get("shortName") or "").strip()
        side = str(p.get("homeAway") or "").lower()
        if side == "away":
            away = name
        elif side == "home":
            home = name
    if not away and len(parts) >= 1 and isinstance(parts[0], dict):
        away = str(parts[0].get("longName") or parts[0].get("shortName") or "")
    if not home and len(parts) >= 2 and isinstance(parts[1], dict):
        home = str(parts[1].get("longName") or parts[1].get("shortName") or "")
    return away, home


def order_size(o: dict[str, Any]) -> float:
    """Resting $ still available — prefer sumUntaken (what takers can hit)."""
    for key in ("sumUntaken", "bet"):
        try:
            v = float(o.get(key))
            if v > 0:
                return v
        except (TypeError, ValueError):
            continue
    return 0.0


def parse_odds(raw: Any) -> float | None:
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def parse_spread(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def filter_orders_at_spread(orders: list[Any] | None, target: float | None) -> list[dict[str, Any]]:
    """Keep only resting offers at 4casters' main displayed line."""
    if target is None:
        return [o for o in (orders or []) if isinstance(o, dict)]
    out: list[dict[str, Any]] = []
    for raw in orders or []:
        if not isinstance(raw, dict):
            continue
        spr = parse_spread(raw.get("spread"))
        if spr is None:
            continue
        if abs(spr - target) < 1e-6:
            out.append(raw)
    return out


def top_price_levels(orders: list[Any] | None, n: int = 3) -> list[dict[str, Any]]:
    """Collapse book into top-n distinct prices (API already best-first)."""
    levels: list[dict[str, Any]] = []
    index: dict[float, int] = {}
    for raw in orders or []:
        if not isinstance(raw, dict):
            continue
        odds = parse_odds(raw.get("odds"))
        if odds is None:
            continue
        size = order_size(raw)
        if size <= 0:
            continue
        if odds in index:
            levels[index[odds]]["size"] = round(levels[index[odds]]["size"] + size, 2)
            continue
        if len(levels) >= n:
            continue
        index[odds] = len(levels)
        # Keep int when whole number so UI shows -112 not -112.0
        odds_out: float | int = int(odds) if float(odds).is_integer() else odds
        levels.append({"odds": odds_out, "size": round(size, 2)})
    return levels


def side_total(orders: list[Any] | None) -> float:
    return round(sum(order_size(o) for o in (orders or []) if isinstance(o, dict)), 2)


def imbalance(a: float, b: float) -> dict[str, Any]:
    total = a + b
    if total <= 0:
        return {"awayShare": 0.5, "homeShare": 0.5, "ratio": 1.0, "heavy": None}
    away_share = a / total
    home_share = b / total
    heavy = None
    if away_share >= 0.65 or (b > 0 and a / max(b, 1e-9) >= 2.0):
        heavy = "away"
    elif home_share >= 0.65 or (a > 0 and b / max(a, 1e-9) >= 2.0):
        heavy = "home"
    ratio = (max(a, b) / max(min(a, b), 1e-9)) if total else 1.0
    return {
        "awayShare": round(away_share, 4),
        "homeShare": round(home_share, 4),
        "ratio": round(ratio, 2),
        "heavy": heavy,
    }


def summarize_market(
    away_orders: list[Any] | None,
    home_orders: list[Any] | None,
    *,
    away_line: float | None = None,
    home_line: float | None = None,
) -> dict[str, Any]:
    away_tot = side_total(away_orders)
    home_tot = side_total(home_orders)
    out: dict[str, Any] = {
        "awayTotal": away_tot,
        "homeTotal": home_tot,
        "awayTop3": top_price_levels(away_orders, 3),
        "homeTop3": top_price_levels(home_orders, 3),
        "imbalance": imbalance(away_tot, home_tot),
    }
    if away_line is not None:
        out["awayLine"] = away_line
    if home_line is not None:
        out["homeLine"] = home_line
    return out


def keep_game(game: dict[str, Any], today_et: str) -> bool:
    if game.get("isSpecials"):
        return False
    if game.get("ended"):
        return False
    period = str(game.get("periodName") or "").strip().lower()
    if period and period not in {"full time", "ft", "game", ""}:
        # Skip 1H / quarters / props children
        if period not in {"full-time"}:
            return False
    start = parse_start(game.get("start"))
    if game.get("live"):
        return True
    if not start:
        return False
    # Today ET tip, or within the next ~18h window from now
    if et_ymd(start) == today_et:
        return True
    return start <= _now() + timedelta(hours=18)


def fetch_league(token: str, league: str) -> list[dict[str, Any]]:
    url = f"{API}/exchange/v2/getOrderbook?league={urllib.parse.quote(league)}"
    payload = _get_json(url, token)
    time.sleep(0.2)
    if not payload:
        return []
    data = payload.get("data") if isinstance(payload, dict) else None
    games = (data or {}).get("games") if isinstance(data, dict) else None
    if not isinstance(games, list):
        # Some payloads nest differently
        if isinstance(payload.get("games"), list):
            games = payload["games"]
        else:
            games = []
    return [g for g in games if isinstance(g, dict)]


def shape_game(game: dict[str, Any], league: str) -> dict[str, Any]:
    away, home = participant_names(game)
    ml = summarize_market(game.get("awayMoneylines"), game.get("homeMoneylines"))

    # Spread "the line" on 4casters = mainAwaySpread / mainHomeSpread (board default),
    # not every alternate offer. Top-3 prices are only at that main number.
    main_away = parse_spread(game.get("mainAwaySpread"))
    main_home = parse_spread(game.get("mainHomeSpread"))
    away_at_main = filter_orders_at_spread(game.get("awaySpreads"), main_away)
    home_at_main = filter_orders_at_spread(game.get("homeSpreads"), main_home)
    sp = summarize_market(
        away_at_main,
        home_at_main,
        away_line=main_away,
        home_line=main_home,
    )

    oi = 0.0
    try:
        oi = float(game.get("openInterest") or 0)
    except (TypeError, ValueError):
        oi = 0.0
    # Fallback OI from sides if API omits it
    if oi <= 0:
        oi = round(
            ml["awayTotal"] + ml["homeTotal"] + sp["awayTotal"] + sp["homeTotal"],
            2,
        )
    matched = 0.0
    try:
        matched = float(game.get("matchedVolume") or 0)
    except (TypeError, ValueError):
        matched = 0.0

    # Prefer spread imbalance for "maker money pending" when spreads exist; else ML
    primary = sp if (sp["awayTotal"] + sp["homeTotal"]) > 0 else ml
    return {
        "id": str(game.get("id") or ""),
        "league": str(game.get("league") or league),
        "sport": str(game.get("sport") or ""),
        "start": game.get("start"),
        "live": bool(game.get("live")),
        "away": away,
        "home": home,
        "eventName": game.get("eventName") or f"{away} @ {home}",
        "openInterest": round(oi, 2),
        "matchedVolume": round(matched, 2),
        "moneyline": ml,
        "spread": sp,
        "heavySide": (primary.get("imbalance") or {}).get("heavy"),
        "heavyMarket": "spread" if primary is sp else "moneyline",
        "heavyRatio": (primary.get("imbalance") or {}).get("ratio"),
    }


def main() -> int:
    token = _token()
    if not token:
        print("Missing FOURCASTERS_TOKEN — skip liquidity snapshot")
        # Keep prior file if present so the site doesn't go empty on misconfig
        if OUT_PATH.exists():
            return 0
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(
            json.dumps(
                {
                    "updatedAt": _now_iso(),
                    "error": "missing FOURCASTERS_TOKEN",
                    "games": [],
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        return 0

    today = et_ymd(_now())
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for league in LEAGUES:
        print(f"league {league}")
        for game in fetch_league(token, league):
            gid = str(game.get("id") or "")
            if not gid or gid in seen:
                continue
            if not keep_game(game, today):
                continue
            seen.add(gid)
            rows.append(shape_game(game, league))

    rows.sort(key=lambda g: (-float(g.get("openInterest") or 0), str(g.get("start") or "")))
    for i, g in enumerate(rows, start=1):
        g["rank"] = i

    payload = {
        "updatedAt": _now_iso(),
        "asOfEtDate": today,
        "source": "4casters",
        "games": rows,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(rows)} games → {OUT_PATH}")
    heavy = sum(1 for g in rows if g.get("heavySide"))
    print(f"  heavy-side flags: {heavy}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
