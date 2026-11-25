#!/usr/bin/env python3
"""Track W/L of fading exchange liquidity disparities (4casters + Novig).

Strategy (matches the board highlight): when main-line top-3 $ ratio is ≥ 2×,
bet the *light* side (e.g. 14.5× Stanford → take Colorado +4).
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# scripts/liq_trust.py → repo root; local mirror may sit beside data/
_HERE = Path(__file__).resolve().parent
ROOT = _HERE.parent if _HERE.name == "scripts" else _HERE
TRUST_PATH = ROOT / "data" / "liq_trust.json"
LIQ_4C = ROOT / "data" / "liquidity.json"
LIQ_NV = ROOT / "data" / "novig_liquidity.json"

MIN_RATIO = 2.0
UA = {"User-Agent": "public-takes-liq-trust/1.0"}

ESPN_SPORT = {
    "NFL": {"path": "football/nfl", "q": ""},
    "NCAAF": {"path": "football/college-football", "q": "&groups=80&limit=400"},
    "CFB": {"path": "football/college-football", "q": "&groups=80&limit=400"},
    "NBA": {"path": "basketball/nba", "q": ""},
    "NCAAB": {"path": "basketball/mens-college-basketball", "q": "&groups=50&limit=400"},
    "CBB": {"path": "basketball/mens-college-basketball", "q": "&groups=50&limit=400"},
    "NHL": {"path": "hockey/nhl", "q": ""},
    "MLB": {"path": "baseball/mlb", "q": ""},
    "WNBA": {"path": "basketball/wnba", "q": ""},
}

ALIASES = {
    "n y giants": "new york giants",
    "ny giants": "new york giants",
    "appalachian state": "app state",
    "app state": "app state",
    "ipfw": "purdue fort wayne",
    "se missouri state": "southeast missouri",
    "umkc": "kansas city",
    "illinois chicago": "uic",
    "miami ohio": "miami oh",
    "cs fullerton": "cal state fullerton",
    "ul lafayette": "louisiana",
    "ut martin": "tennessee martin",
    "mississippi": "ole miss",
    "ole miss": "ole miss",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _get_json(url: str) -> dict[str, Any] | None:
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"  fetch fail {url}: {exc}")
        return None


def canon(s: str) -> str:
    t = str(s or "").lower()
    t = t.replace("\u2018", "").replace("\u2019", "").replace("'", "")
    t = t.replace("&", " and ").replace(".", " ")
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = re.sub(r"\b(university|univ|the|saint|st)\b", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return ALIASES.get(t, t)


def compact(s: str) -> str:
    return canon(s).replace(" ", "")


def slug_team(s: str) -> str:
    return compact(s) or "team"


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def top3_sum(levels: list[Any] | None) -> float:
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


def top3_ratio(away_top: list[Any] | None, home_top: list[Any] | None) -> tuple[float, str | None]:
    a = top3_sum(away_top)
    b = top3_sum(home_top)
    if a + b <= 0:
        return 1.0, None
    lo = min(a, b)
    hi = max(a, b)
    if lo <= 0:
        return (99.0 if hi > 0 else 1.0), ("away" if a >= b else "home")
    return hi / lo, ("away" if a > b else "home" if b > a else None)


def best_price(levels: list[Any] | None) -> float | None:
    for row in levels or []:
        if not isinstance(row, dict):
            continue
        try:
            return float(row.get("odds"))
        except (TypeError, ValueError):
            continue
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


def sport_conf(league: str, sport: str) -> dict[str, str] | None:
    blob = f"{sport} {league}".upper()
    for key, conf in sorted(ESPN_SPORT.items(), key=lambda kv: -len(kv[0])):
        if key in blob:
            return conf
    if "COLLEGE FOOTBALL" in blob or "NCAAF" in blob:
        return ESPN_SPORT["NCAAF"]
    if "COLLEGE BASKETBALL" in blob or "NCAAB" in blob:
        return ESPN_SPORT["NCAAB"]
    return None


def team_keys(team: dict[str, Any] | None) -> list[str]:
    if not team:
        return []
    return [
        canon(x)
        for x in (
            team.get("shortDisplayName"),
            team.get("location"),
            team.get("displayName"),
            team.get("name"),
            team.get("abbreviation"),
            team.get("nickname"),
        )
        if x
    ]


def name_hit(needles: str, keys: list[str]) -> bool:
    raw = canon(needles)
    need = [t for t in raw.split() if len(t) > 1 and t not in {"vs", "at", "and"}]
    if not need:
        return False
    hay = " ".join(ALIASES.get(k, k) for k in keys)
    hay_c = compact(hay)
    needle_c = compact(raw)
    if needle_c and needle_c in hay_c:
        return True
    if hay_c and hay_c in needle_c and len(hay_c) >= 4:
        return True
    hits = sum(1 for tok in need if tok in hay or tok in hay_c)
    if hits >= min(2, len(need)) or (len(need) == 1 and hits == 1):
        return True
    filler = {"state", "university", "univ", "college", "tech", "the"}
    for key in keys:
        kt_all = [t for t in canon(key).split() if len(t) > 1]
        kt = [t for t in kt_all if t not in filler] or kt_all
        if not kt:
            continue
        ok = True
        for tok in kt:
            aligned = any(
                nt == tok or (len(tok) >= 3 and (nt.startswith(tok) or tok.startswith(nt))) or (len(tok) >= 3 and tok in needle_c)
                for nt in need
            )
            if not aligned:
                ok = False
                break
        if ok:
            return True
    return False


def ymds_for(start: str | None) -> list[str]:
    out: list[str] = []

    def push(dt: datetime) -> None:
        for d in (-1, 0, 1):
            x = dt + timedelta(days=d)
            out.append(f"{x.year:04d}{x.month:02d}{x.day:02d}")

    if start:
        try:
            dt = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
            push(dt.astimezone(timezone.utc))
            push(dt.astimezone(timezone(timedelta(hours=-5))))
        except ValueError:
            pass
    push(_now())
    seen: set[str] = set()
    res: list[str] = []
    for y in out:
        if y not in seen:
            seen.add(y)
            res.append(y)
    return res


def parse_final(ev: dict[str, Any]) -> dict[str, Any] | None:
    comps = ev.get("competitions") or []
    if not comps:
        return None
    comp = comps[0]
    status = ((comp.get("status") or {}).get("type") or {})
    name = str(status.get("name") or "").upper()
    completed = bool(status.get("completed")) or name in {"STATUS_FINAL", "STATUS_FULL_TIME"}
    if not completed:
        return None
    competitors = comp.get("competitors") or []
    away = next((c for c in competitors if c.get("homeAway") == "away"), None)
    home = next((c for c in competitors if c.get("homeAway") == "home"), None)
    if not away or not home:
        return None
    try:
        return {
            "awayScore": float(away.get("score")),
            "homeScore": float(home.get("score")),
            "awayKeys": team_keys(away.get("team")),
            "homeKeys": team_keys(home.get("team")),
            "eventId": str(ev.get("id") or ""),
        }
    except (TypeError, ValueError):
        return None


def find_final(sig: dict[str, Any], cache: dict[str, Any]) -> dict[str, Any] | None:
    conf = sport_conf(str(sig.get("league") or ""), str(sig.get("sport") or ""))
    if not conf:
        return None
    away = str(sig.get("away") or "")
    home = str(sig.get("home") or "")
    for ymd in ymds_for(sig.get("start")):
        key = f"board|{conf['path']}|{ymd}"
        if key not in cache:
            url = (
                "https://site.api.espn.com/apis/site/v2/sports/"
                f"{conf['path']}/scoreboard?dates={urllib.parse.quote(ymd)}{conf.get('q') or ''}"
            )
            payload = _get_json(url)
            time.sleep(0.1)
            finals = []
            for ev in (payload or {}).get("events") or []:
                parsed = parse_final(ev)
                if parsed:
                    finals.append(parsed)
            cache[key] = finals
        for fin in cache[key]:
            fwd = name_hit(away, fin["awayKeys"]) and name_hit(home, fin["homeKeys"])
            rev = name_hit(away, fin["homeKeys"]) and name_hit(home, fin["awayKeys"])
            if not fwd and not rev:
                continue
            if rev and not fwd:
                return {"awayScore": fin["homeScore"], "homeScore": fin["awayScore"], "eventId": fin["eventId"]}
            return {"awayScore": fin["awayScore"], "homeScore": fin["homeScore"], "eventId": fin["eventId"]}
    return None


def signal_id(venue: str, away: str, home: str, start: str | None, market: str) -> str:
    day = ""
    if start:
        try:
            day = datetime.fromisoformat(str(start).replace("Z", "+00:00")).strftime("%Y%m%d")
        except ValueError:
            day = str(start)[:10]
    return f"{venue}|{slug_team(away)}_at_{slug_team(home)}|{day}|{market}"


def is_nhl_or_mlb(game: dict[str, Any]) -> bool:
    blob = f"{game.get('sport') or ''} {game.get('league') or ''} {game.get('eventName') or ''}".upper()
    return "NHL" in blob or "MLB" in blob or "HOCKEY" in blob or "BASEBALL" in blob


def plus15_in_band(line: Any, top3: list[Any] | None) -> bool:
    try:
        if abs(float(line) - 1.5) > 0.05:
            return False
    except (TypeError, ValueError):
        return False
    for row in top3 or []:
        if not isinstance(row, dict):
            continue
        try:
            odds = float(row.get("odds"))
        except (TypeError, ValueError):
            continue
        if -145 <= odds <= 100:
            return True
    return False


def spread_has_plus15_band(sp: dict[str, Any] | None) -> bool:
    if not isinstance(sp, dict):
        return False
    return plus15_in_band(sp.get("awayLine"), sp.get("awayTop3")) or plus15_in_band(
        sp.get("homeLine"), sp.get("homeTop3")
    )


def pick_liquidity_book(game: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """NHL/MLB → ML unless +1.5 is +100…-145; else prefer spread then ML."""
    sp = game.get("spread") if isinstance(game.get("spread"), dict) else None
    ml = game.get("moneyline") if isinstance(game.get("moneyline"), dict) else None
    if is_nhl_or_mlb(game):
        if spread_has_plus15_band(sp):
            return sp, "spread"
        if ml and top3_sum(ml.get("awayTop3")) + top3_sum(ml.get("homeTop3")) > 0:
            return ml, "ml"
        return (ml or sp), ("ml" if ml else "spread" if sp else "spread")
    if sp and top3_sum(sp.get("awayTop3")) + top3_sum(sp.get("homeTop3")) > 0:
        return sp, "spread"
    if ml and top3_sum(ml.get("awayTop3")) + top3_sum(ml.get("homeTop3")) > 0:
        return ml, "ml"
    return None, "spread"


def extract_signal(game: dict[str, Any], venue: str) -> dict[str, Any] | None:
    """Build a light-side fade signal from a liquidity game row."""
    away = str(game.get("away") or "").strip()
    home = str(game.get("home") or "").strip()
    if not away or not home:
        return None

    book, market = pick_liquidity_book(game)
    if not book:
        return None

    ratio, heavy = top3_ratio(book.get("awayTop3"), book.get("homeTop3"))
    if heavy is None or ratio < MIN_RATIO:
        return None
    light = "home" if heavy == "away" else "away"
    take_team = away if light == "away" else home
    heavy_team = home if heavy == "home" else away
    line = book.get("awayLine") if light == "away" else book.get("homeLine")
    if market == "ml":
        line = None
    light_top = book.get("awayTop3") if light == "away" else book.get("homeTop3")
    price = best_price(light_top)
    if market == "ml" and price is None:
        return None
    if market == "spread" and (line is None or line == ""):
        return None

    return {
        "id": signal_id(venue, away, home, game.get("start"), market),
        "venue": venue,
        "league": game.get("league") or "",
        "sport": game.get("sport") or "",
        "away": away,
        "home": home,
        "start": game.get("start"),
        "market": market,
        "heavySide": heavy,
        "lightSide": light,
        "heavyTeam": heavy_team,
        "takeTeam": take_team,
        "takeSide": light,
        "line": line,
        "price": price if price is not None else -110,
        "ratio": round(float(ratio), 2),
        "rank": game.get("rank"),
        "openInterest": game.get("openInterest"),
        "snappedAt": _now_iso(),
        "result": None,
        "profit": None,
        "gradedAt": None,
        "gradeSource": None,
    }


def upsert_from_file(path: Path, venue: str, by_id: dict[str, dict[str, Any]]) -> int:
    payload = load_json(path)
    games = payload.get("games") if isinstance(payload, dict) else None
    if not isinstance(games, list):
        return 0
    n = 0
    now = _now()
    for game in games:
        if not isinstance(game, dict):
            continue
        sig = extract_signal(game, venue)
        if not sig:
            continue
        # Don't refresh after tip-off
        start_raw = sig.get("start")
        if start_raw:
            try:
                start = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
                if start <= now:
                    # keep existing open signal frozen; only insert if new
                    prev = by_id.get(sig["id"])
                    if prev and str(prev.get("result") or "").upper() in {"W", "L", "P"}:
                        continue
                    if prev and not prev.get("result"):
                        continue
                    # past tip with no prior signal — skip (can't fair-snapshot late)
                    continue
            except ValueError:
                pass

        prev = by_id.get(sig["id"])
        if prev and str(prev.get("result") or "").upper() in {"W", "L", "P"}:
            continue
        if prev and not prev.get("result"):
            # refresh live open signal
            for k in (
                "ratio",
                "line",
                "price",
                "rank",
                "openInterest",
                "heavyTeam",
                "takeTeam",
                "heavySide",
                "lightSide",
                "takeSide",
                "snappedAt",
                "start",
            ):
                if sig.get(k) is not None:
                    prev[k] = sig[k]
            n += 1
            continue
        by_id[sig["id"]] = sig
        n += 1
    return n


def grade_open(signals: list[dict[str, Any]]) -> int:
    cache: dict[str, Any] = {}
    graded = 0
    for sig in signals:
        if str(sig.get("result") or "").upper() in {"W", "L", "P"}:
            continue
        # Only grade after tip
        start_raw = sig.get("start")
        if start_raw:
            try:
                start = datetime.fromisoformat(str(start_raw).replace("Z", "+00:00"))
                if start > _now() + timedelta(minutes=5):
                    continue
            except ValueError:
                pass
        score = find_final(sig, cache)
        if not score:
            continue
        market = str(sig.get("market") or "spread").lower()
        if market == "spread":
            result = grade_spread(sig.get("takeSide"), sig.get("line"), score["awayScore"], score["homeScore"])
        else:
            result = grade_moneyline(sig.get("takeSide"), score["awayScore"], score["homeScore"])
        if not result:
            continue
        sig["result"] = result
        sig["profit"] = american_profit(result, sig.get("price"))
        sig["awayScore"] = score["awayScore"]
        sig["homeScore"] = score["homeScore"]
        sig["gradedAt"] = _now_iso()
        sig["gradeSource"] = "espn"
        if score.get("eventId"):
            sig["espnEventId"] = score["eventId"]
        graded += 1
        print(
            f"  {sig.get('venue')} fade {sig.get('takeTeam')} "
            f"({sig.get('away')} @ {sig.get('home')}) → {result} "
            f"r={sig.get('ratio')}× vs {sig.get('heavyTeam')}"
        )
    return graded


def summarize(signals: list[dict[str, Any]], venue: str | None = None) -> dict[str, Any]:
    w = l = p = 0
    profit = 0.0
    open_n = 0
    for sig in signals:
        if venue and sig.get("venue") != venue:
            continue
        r = str(sig.get("result") or "").upper()
        if r == "W":
            w += 1
            profit += float(sig.get("profit") or 0)
        elif r == "L":
            l += 1
            profit += float(sig.get("profit") or -1)
        elif r == "P":
            p += 1
        else:
            open_n += 1
    return {
        "w": w,
        "p": p,
        "l": l,
        "graded": w + p + l,
        "open": open_n,
        "profit": round(profit, 4),
        "record": f"{w}-{p}-{l}",
    }


def main() -> int:
    store = load_json(TRUST_PATH)
    signals = store.get("signals") if isinstance(store, dict) else None
    if not isinstance(signals, list):
        signals = []
    by_id = {str(s.get("id")): s for s in signals if isinstance(s, dict) and s.get("id")}

    n4 = upsert_from_file(LIQ_4C, "4c", by_id)
    nn = upsert_from_file(LIQ_NV, "novig", by_id)
    merged = list(by_id.values())
    graded = grade_open(merged)

    # Stable sort: newest snap first
    merged.sort(key=lambda s: str(s.get("snappedAt") or ""), reverse=True)

    payload = {
        "updatedAt": _now_iso(),
        "minRatio": MIN_RATIO,
        "strategy": "fade_heavy_top3",
        "note": "Bet light side when main-line top-3 $ ratio ≥ 2× (same as board highlight).",
        "summary": {
            "all": summarize(merged),
            "4c": summarize(merged, "4c"),
            "novig": summarize(merged, "novig"),
        },
        "signals": merged,
    }
    TRUST_PATH.parent.mkdir(parents=True, exist_ok=True)
    TRUST_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"liq_trust: upserted 4c={n4} novig={nn} graded={graded} "
        f"total={len(merged)} → {TRUST_PATH}"
    )
    print("  4c", payload["summary"]["4c"])
    print("  nv", payload["summary"]["novig"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
