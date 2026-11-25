#!/usr/bin/env python3
"""Grade open public-% picks from ESPN scoreboard finals and rewrite data/picks.json.

Discovery is ESPN-only (scoreboard + optional summary by event id). Never uses OddsLogic.
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

ROOT = Path(__file__).resolve().parents[1]
PICKS_PATH = ROOT / "data" / "picks.json"

ESPN_SPORT: dict[str, dict[str, str]] = {
    "NCAAF": {"path": "football/college-football", "q": "&groups=80&limit=400"},
    "CFB": {"path": "football/college-football", "q": "&groups=80&limit=400"},
    "COLLEGE FOOTBALL": {"path": "football/college-football", "q": "&groups=80&limit=400"},
    "NFL": {"path": "football/nfl", "q": ""},
    "NBA": {"path": "basketball/nba", "q": ""},
    "NCAAB": {"path": "basketball/mens-college-basketball", "q": "&groups=50&limit=400"},
    "CBB": {"path": "basketball/mens-college-basketball", "q": "&groups=50&limit=400"},
    "COLLEGE BASKETBALL": {
        "path": "basketball/mens-college-basketball",
        "q": "&groups=50&limit=400",
    },
    "NHL": {"path": "hockey/nhl", "q": ""},
    "MLB": {"path": "baseball/mlb", "q": ""},
    "WNBA": {"path": "basketball/wnba", "q": ""},
}

ALIASES = {
    "n y giants": "new york giants",
    "ny giants": "new york giants",
    "n y jets": "new york jets",
    "ny jets": "new york jets",
    "l a clippers": "los angeles clippers",
    "la clippers": "los angeles clippers",
    "l a lakers": "los angeles lakers",
    "la lakers": "los angeles lakers",
    "ut martin": "tennessee martin",
    "tennessee martin": "tennessee martin",
    "cs fullerton": "cal state fullerton",
    "ul lafayette": "louisiana",
    "miami ohio": "miami oh",
    "illinois chicago": "uic",
    "rhode island sc": "rhode island",
    "middle tennessee st": "middle tennessee",
    "unc greensboro": "north carolina greensboro",
    "northern iowa": "northern iowa",
    # OddsLogic "Mississippi" ↔ ESPN "Ole Miss"
    "mississippi": "ole miss",
    "ole miss": "ole miss",
    "olemiss": "ole miss",
    # Short ESPN board names ↔ OddsLogic full names
    "appalachian state": "app state",
    "app state": "app state",
    "ipfw": "purdue fort wayne",
    "fort wayne": "purdue fort wayne",
    "se missouri state": "southeast missouri",
    "se missouri": "southeast missouri",
    "southeast missouri state": "southeast missouri",
    "umkc": "kansas city",
    "kansas city": "kansas city",
    "kennesaw state": "kennesaw",
    "florida atlantic": "florida atlantic",
    "fau": "florida atlantic",
    "vmi": "vmi",
    "virginia military": "vmi",
    "elon university": "elon",
    "tarleton state": "tarleton",
    "weber state": "weber state",
    "coastal carolina": "coastal carolina",
}

# Dropped when comparing short ESPN labels like "App State" ↔ "Appalachian State"
_FILLER = {"state", "university", "univ", "college", "tech", "the"}

UA = {"User-Agent": "public-takes-roi-grader/1.1 (+espn-scoreboard)"}


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


def sport_conf(pick: dict[str, Any]) -> dict[str, str] | None:
    sport = str(pick.get("sport") or "").upper().strip()
    if sport in ESPN_SPORT:
        return ESPN_SPORT[sport]
    league = str(pick.get("league") or "").upper()
    for key, conf in sorted(ESPN_SPORT.items(), key=lambda kv: -len(kv[0])):
        if key == sport or key in league:
            return conf
    if "COLLEGE FOOTBALL" in league or "NCAAF" in league or league.startswith("CFB"):
        return ESPN_SPORT["NCAAF"]
    if "COLLEGE BASKETBALL" in league or "NCAAB" in league or "CBB" in league:
        return ESPN_SPORT["NCAAB"]
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


def _tokens(s: str) -> list[str]:
    raw = canon(s)
    raw = ALIASES.get(raw, raw)
    return [t for t in raw.split() if len(t) > 1 and t not in {"vs", "at", "and"}]


def name_hit(needles: str, keys: list[str]) -> bool:
    """Match OddsLogic team string to ESPN team key list (short names OK)."""
    need = _tokens(needles)
    if not need:
        return False
    keyed = [ALIASES.get(k, k) for k in keys]
    hay = " ".join(keyed)
    hay_c = "".join(hay.split())
    needle_c = compact(needles)
    if needle_c and needle_c in hay_c:
        return True
    if hay_c and hay_c in needle_c and len(hay_c) >= 4:
        return True
    hits = 0
    for tok in need:
        if tok in hay or tok in hay_c:
            hits += 1
    if hits >= min(2, len(need)) or (len(need) == 1 and hits == 1):
        return True

    # Soft: ESPN short label tokens align as prefixes ("app" ↔ "appalachian")
    for key in keyed:
        kt_all = _tokens(key)
        if not kt_all:
            continue
        kt = [t for t in kt_all if t not in _FILLER] or kt_all
        ok = True
        for tok in kt:
            aligned = False
            for nt in need:
                if nt == tok:
                    aligned = True
                    break
                if len(tok) >= 3 and (nt.startswith(tok) or tok.startswith(nt)):
                    aligned = True
                    break
                if len(tok) >= 3 and tok in needle_c:
                    aligned = True
                    break
            if not aligned:
                ok = False
                break
        if ok:
            return True
    return False


def ymds_for_pick(pick: dict[str, Any]) -> list[str]:
    out: list[str] = []

    def push_dt(dt: datetime) -> None:
        for delta in (-1, 0, 1):
            d = dt + timedelta(days=delta)
            out.append(f"{d.year:04d}{d.month:02d}{d.day:02d}")

    for key in ("startAt", "loggedAt"):
        raw = pick.get(key)
        if not raw:
            continue
        try:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except ValueError:
            continue
        push_dt(dt.astimezone(timezone.utc))
        # US evening tips land on the prior ESPN calendar day vs UTC.
        try:
            eastern = timezone(timedelta(hours=-5))
            push_dt(dt.astimezone(eastern))
        except Exception:
            pass

    push_dt(datetime.now(timezone.utc))
    seen: set[str] = set()
    res: list[str] = []
    for ymd in out:
        if ymd not in seen:
            seen.add(ymd)
            res.append(ymd)
    return res


def parse_final_event(ev: dict[str, Any]) -> dict[str, Any] | None:
    comps = ev.get("competitions") or []
    if not comps:
        return None
    comp = comps[0]
    status = ((comp.get("status") or {}).get("type") or {})
    name = str(status.get("name") or status.get("description") or "").upper()
    completed = bool(status.get("completed")) or name in {
        "STATUS_FINAL",
        "STATUS_FULL_TIME",
    }
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
            "eventId": str(ev.get("id") or ""),
            "awayName": ((away.get("team") or {}).get("displayName") or ""),
            "homeName": ((home.get("team") or {}).get("displayName") or ""),
            "awayKeys": team_keys(away.get("team")),
            "homeKeys": team_keys(home.get("team")),
            "detail": status.get("detail") or status.get("description") or "Final",
        }
    except (TypeError, ValueError):
        return None


def parse_summary(payload: dict[str, Any]) -> dict[str, Any] | None:
    header = payload.get("header") or {}
    comps = header.get("competitions") or payload.get("competitions") or []
    if not comps:
        return None
    fake_ev = {"id": header.get("id") or payload.get("id"), "competitions": comps}
    return parse_final_event(fake_ev)


def fetch_board(
    conf: dict[str, str], ymd: str, cache: dict[str, Any]
) -> list[dict[str, Any]]:
    key = f"board|{conf['path']}|{ymd}"
    if key in cache:
        return cache[key]
    url = (
        "https://site.api.espn.com/apis/site/v2/sports/"
        f"{conf['path']}/scoreboard?dates={urllib.parse.quote(ymd)}{conf.get('q') or ''}"
    )
    payload = _get_json(url)
    time.sleep(0.12)
    events = (payload or {}).get("events") or []
    finals = []
    for ev in events:
        parsed = parse_final_event(ev)
        if parsed:
            finals.append(parsed)
    cache[key] = finals
    return finals


def find_final(
    pick: dict[str, Any], cache: dict[str, Any]
) -> dict[str, Any] | None:
    conf = sport_conf(pick)
    if not conf:
        return None

    event_id = str(pick.get("espnEventId") or "").strip()
    if event_id:
        key = f"sum|{conf['path']}|{event_id}"
        if key not in cache:
            url = (
                "https://site.api.espn.com/apis/site/v2/sports/"
                f"{conf['path']}/summary?event={urllib.parse.quote(event_id)}"
            )
            payload = _get_json(url)
            time.sleep(0.12)
            cache[key] = parse_summary(payload) if payload else None
        hit = cache[key]
        if hit:
            hit = dict(hit)
            hit["eventId"] = event_id
            return hit

    away = str(pick.get("away") or "")
    home = str(pick.get("home") or "")
    for ymd in ymds_for_pick(pick):
        for fin in fetch_board(conf, ymd, cache):
            fwd = name_hit(away, fin["awayKeys"]) and name_hit(home, fin["homeKeys"])
            rev = name_hit(away, fin["homeKeys"]) and name_hit(home, fin["awayKeys"])
            if not fwd and not rev:
                continue
            if rev and not fwd:
                return {
                    "awayScore": fin["homeScore"],
                    "homeScore": fin["awayScore"],
                    "eventId": fin["eventId"],
                    "awayName": fin["homeName"],
                    "homeName": fin["awayName"],
                    "detail": fin["detail"],
                }
            return {
                "awayScore": fin["awayScore"],
                "homeScore": fin["homeScore"],
                "eventId": fin["eventId"],
                "awayName": fin["awayName"],
                "homeName": fin["homeName"],
                "detail": fin["detail"],
            }
    return None


def grade_pick(pick: dict[str, Any], score: dict[str, Any]) -> bool:
    market = str(pick.get("market") or "spread").lower()
    side = pick.get("takeSide") or pick.get("side")
    away = score["awayScore"]
    home = score["homeScore"]
    if market in {"ml", "moneyline", "h2h"}:
        result = grade_moneyline(side, away, home)
    else:
        if pick.get("line") is None or pick.get("line") == "":
            return False
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
    if score.get("eventId"):
        pick["espnEventId"] = str(score["eventId"])
    if score.get("awayName"):
        pick["espnAway"] = score["awayName"]
    if score.get("homeName"):
        pick["espnHome"] = score["homeName"]
    return True


def pick_ready_to_grade(pick: dict[str, Any]) -> bool:
    """Skip games that clearly have not started yet."""
    raw = pick.get("startAt")
    if not raw:
        return True
    try:
        start = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return True
    return start <= datetime.now(timezone.utc) + timedelta(minutes=5)


def main() -> int:
    if not PICKS_PATH.exists():
        print(f"Missing {PICKS_PATH}")
        return 1
    store = json.loads(PICKS_PATH.read_text(encoding="utf-8"))
    picks = store.get("picks") if isinstance(store, dict) else store
    if not isinstance(picks, list):
        print("No picks list found")
        return 1

    cache: dict[str, Any] = {}
    graded = 0
    open_n = 0
    for pick in picks:
        if not isinstance(pick, dict):
            continue
        if str(pick.get("result") or "").upper() in {"W", "L", "P"}:
            continue
        open_n += 1
        if not pick_ready_to_grade(pick):
            continue
        score = find_final(pick, cache)
        if not score:
            continue
        if grade_pick(pick, score):
            graded += 1
            print(
                f"  graded {pick.get('away')} @ {pick.get('home')} "
                f"{pick.get('takeTeam')} → {pick.get('result')} "
                f"({pick.get('awayScore')}-{pick.get('homeScore')}) "
                f"[espn {pick.get('espnEventId')}]"
            )

    print(f"Graded {graded}/{open_n} open picks → {PICKS_PATH}")
    if graded <= 0:
        # Avoid noop updatedAt-only commits that race the OddsLogic sync push
        return 0
    payload = {
        "updatedAt": _now_iso(),
        "picks": picks,
    }
    PICKS_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
