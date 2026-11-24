#!/usr/bin/env python3
"""Snapshot Novig orderbooks (keyless public API) → data/novig_liquidity.json.

Mirrors the 4casters liquidity shape: rank by open interest, main-line spread
top-3 resting levels per side, moneyline book, imbalance ratio.

No account / API key — uses /v3/public/catalog/*.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "data" / "novig_liquidity.json"

LEAGUES = ["NCAAB", "NBA", "NFL", "NCAAF", "NHL", "WNBA"]
API = "https://api.novig.com"
UA = {"User-Agent": "public-takes-roi-novig/1.0", "Accept": "application/json"}

# Public edge is IP-throttled; keep polite.
BOOK_SLEEP_S = 0.35
PAGE_SLEEP_S = 0.1
# Full depth books only for the heaviest games (catalog BBO fills the rest).
MAX_BOOK_FETCHES = 80
BOOK_RETRIES = 4


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _get_json(
    path: str,
    params: dict[str, Any] | None = None,
    *,
    retries: int = 1,
) -> dict[str, Any] | list[Any] | None:
    qs = ""
    if params:
        qs = "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = API + path + qs
    last_exc: Exception | None = None
    for attempt in range(max(1, retries)):
        req = urllib.request.Request(url, headers=UA)
        try:
            with urllib.request.urlopen(req, timeout=45) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_exc = exc
            if exc.code == 429 and attempt + 1 < retries:
                wait = 2.0
                try:
                    wait = float(exc.headers.get("Retry-After") or wait)
                except (TypeError, ValueError):
                    wait = 2.0
                wait = min(max(wait, 1.0), 20.0)
                print(f"  429 backoff {wait:.1f}s {path}")
                time.sleep(wait)
                continue
            print(f"  fetch fail {url}: {exc}")
            return None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_exc = exc
            print(f"  fetch fail {url}: {exc}")
            return None
    if last_exc:
        print(f"  fetch fail {url}: {last_exc}")
    return None


def et_ymd(dt: datetime) -> str:
    eastern = timezone(timedelta(hours=-5))
    local = dt.astimezone(eastern)
    return f"{local.year:04d}-{local.month:02d}-{local.day:02d}"


def ms_to_iso(ms: Any) -> str | None:
    try:
        v = int(ms)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(v / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def canon(s: str) -> str:
    t = (
        str(s or "")
        .lower()
        .replace("'", "")
        .replace("&", " and ")
        .replace(".", " ")
    )
    t = re.sub(r"[^a-z0-9]+", " ", t)
    t = re.sub(r"\b(university|univ|the|saint|st)\b", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def name_hit(a: str, b: str) -> bool:
    left, right = canon(a), canon(b)
    if not left or not right:
        return False
    if left == right:
        return True
    if left in right or right in left:
        return True
    lt = [x for x in left.split() if len(x) > 1]
    rt = [x for x in right.split() if len(x) > 1]
    if not lt or not rt:
        return False
    hits = sum(1 for x in lt if x in rt)
    return hits >= min(2, len(lt), len(rt))


def abbr_hit(label: str, team: str) -> bool:
    """Match Novig short tags (OKC, MIN, BOS) to full team names."""
    tag = re.sub(r"[^A-Za-z]", "", str(label or "")).upper()
    if len(tag) < 2 or len(tag) > 4:
        return False
    words = re.findall(r"[A-Za-z]+", team or "")
    if not words:
        return False
    initials = "".join(w[0] for w in words).upper()
    if tag == initials:
        return True
    # Minnesota → MIN, Boston → BOS, etc.
    if words[0].upper().startswith(tag):
        return True
    if words[-1].upper().startswith(tag):
        return True
    # Oklahoma City → OKC-ish: first two letters of first word + first of last
    if len(words) >= 2:
        guess = (words[0][:2] + words[-1][0]).upper()
        if tag == guess:
            return True
        guess2 = (words[0][0] + words[1][0] + words[-1][0]).upper()
        if tag == guess2:
            return True
    return False


def split_event_desc(desc: str) -> tuple[str, str]:
    text = str(desc or "").strip()
    if " @ " in text:
        a, h = text.split(" @ ", 1)
        return a.strip(), h.strip()
    if " vs " in text.lower():
        parts = re.split(r"\s+vs\.?\s+", text, maxsplit=1, flags=re.I)
        if len(parts) == 2:
            return parts[0].strip(), parts[1].strip()
    return "", ""


def parse_line_token(name: str) -> float | None:
    m = re.search(r"([+-]?\d+(?:\.\d+)?)\s*$", str(name or "").strip())
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def strip_line_label(name: str) -> str:
    return re.sub(r"\s*[+-]?\d+(?:\.\d+)?\s*$", "", str(name or "")).strip()


def prob_to_american(p: float) -> float | int | None:
    if p <= 0 or p >= 1:
        return None
    if p >= 0.5:
        a = -100.0 * p / (1.0 - p)
    else:
        a = 100.0 * (1.0 - p) / p
    # Half-cent style when needed; else int
    rounded = round(a * 2) / 2
    if abs(rounded - round(rounded)) < 1e-9:
        return int(round(rounded))
    return rounded


def qty_to_usd(qty: Any, price: Any = None) -> float:
    """Novig qty is minimum currency units ($0.01 face). Size ≈ face dollars."""
    try:
        q = float(qty)
    except (TypeError, ValueError):
        return 0.0
    if q <= 0:
        return 0.0
    return round(q / 100.0, 2)


def page_items(path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    after = None
    for _ in range(40):
        q = dict(params)
        if after:
            q["after"] = after
        payload = _get_json(path, q)
        time.sleep(PAGE_SLEEP_S)
        if not isinstance(payload, dict):
            break
        items = payload.get("items")
        if not isinstance(items, list):
            break
        for row in items:
            if isinstance(row, dict):
                out.append(row)
        after = payload.get("next")
        if not after:
            break
    return out


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


def top_levels_from_orders(orders: list[Any] | None, n: int = 3) -> list[dict[str, Any]]:
    """Collapse resting bids → top-n price levels (best price first)."""
    buckets: dict[str, float] = {}
    order_list = [o for o in (orders or []) if isinstance(o, dict)]
    # API already best-first; preserve first-seen price order
    price_order: list[str] = []
    for od in order_list:
        raw_p = od.get("price")
        try:
            p = float(raw_p)
        except (TypeError, ValueError):
            continue
        key = str(raw_p)
        size = qty_to_usd(od.get("qty"), p)
        if size <= 0:
            continue
        if key not in buckets:
            buckets[key] = 0.0
            price_order.append(key)
        buckets[key] = round(buckets[key] + size, 2)

    levels: list[dict[str, Any]] = []
    for key in price_order:
        if len(levels) >= n:
            break
        p = float(key)
        am = prob_to_american(p)
        if am is None:
            continue
        levels.append({"odds": am, "size": buckets[key], "prob": p})
    return levels


def side_total(levels: list[dict[str, Any]]) -> float:
    return round(sum(float(x.get("size") or 0) for x in levels), 2)


def even_book_score(market: dict[str, Any]) -> float:
    """Higher = closer to a two-way main line (both bids near 50¢)."""
    bids: list[float] = []
    for o in market.get("outcomes") or []:
        if not isinstance(o, dict):
            continue
        b = (o.get("bid") or {}).get("price")
        try:
            bids.append(float(b))
        except (TypeError, ValueError):
            pass
    if len(bids) < 2:
        return -1.0
    return min(bids) - abs(bids[0] - bids[1]) * 0.5


def pick_main_spread(spreads: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not spreads:
        return None
    ranked = sorted(spreads, key=even_book_score, reverse=True)
    best = ranked[0]
    if even_book_score(best) >= 0.15:
        return best
    # Fallback: most open interest among reasonably two-sided books
    def oi(m: dict[str, Any]) -> float:
        try:
            return float(m.get("openInterest") or 0) + float(m.get("volume") or 0) * 0.01
        except (TypeError, ValueError):
            return 0.0

    two_way = [m for m in spreads if even_book_score(m) >= 0.05]
    pool = two_way or spreads
    return max(pool, key=oi)


def assign_spread_outcomes(
    market: dict[str, Any], away: str, home: str
) -> tuple[dict[str, Any] | None, dict[str, Any] | None, float | None, float | None]:
    outs = [o for o in (market.get("outcomes") or []) if isinstance(o, dict)]
    strike = None
    try:
        strike = float(market.get("strike"))
    except (TypeError, ValueError):
        strike = None
    home_line = strike
    away_line = -strike if strike is not None else None

    away_o = home_o = None
    for o in outs:
        line = parse_line_token(o.get("name") or "")
        if line is None:
            continue
        if away_line is not None and abs(line - away_line) < 1e-6:
            away_o = o
        elif home_line is not None and abs(line - home_line) < 1e-6:
            home_o = o

    if away_o is None or home_o is None:
        for o in outs:
            label = strip_line_label(o.get("name") or "")
            if away_o is None and (name_hit(label, away) or abbr_hit(label, away)):
                away_o = o
            elif home_o is None and (name_hit(label, home) or abbr_hit(label, home)):
                home_o = o

    if away_o is None and home_o is not None and len(outs) == 2:
        away_o = outs[0] if outs[1] is home_o else outs[1]
    if home_o is None and away_o is not None and len(outs) == 2:
        home_o = outs[0] if outs[1] is away_o else outs[1]

    # Prefer lines from outcome names when strike missing
    if away_o and away_line is None:
        away_line = parse_line_token(away_o.get("name") or "")
    if home_o and home_line is None:
        home_line = parse_line_token(home_o.get("name") or "")
    return away_o, home_o, away_line, home_line


def assign_ml_outcomes(
    market: dict[str, Any], away: str, home: str
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    outs = [o for o in (market.get("outcomes") or []) if isinstance(o, dict)]
    away_o = home_o = None
    for o in outs:
        label = strip_line_label(o.get("name") or "")
        if away_o is None and (name_hit(label, away) or abbr_hit(label, away)):
            away_o = o
        elif home_o is None and (name_hit(label, home) or abbr_hit(label, home)):
            home_o = o
    if away_o is None and home_o is not None and len(outs) == 2:
        away_o = outs[0] if outs[1] is home_o else outs[1]
    if home_o is None and away_o is not None and len(outs) == 2:
        home_o = outs[0] if outs[1] is away_o else outs[1]
    if away_o is None and home_o is None and len(outs) >= 2:
        away_o, home_o = outs[0], outs[1]
    return away_o, home_o


def fetch_book(market_id: str, depth: int = 5) -> dict[str, Any] | None:
    if not market_id:
        return None
    payload = _get_json(
        f"/v3/public/catalog/markets/{market_id}/book",
        {"depth": depth},
        retries=BOOK_RETRIES,
    )
    time.sleep(BOOK_SLEEP_S)
    return payload if isinstance(payload, dict) else None


def load_priority_matchups() -> set[tuple[str, str]]:
    """Open picks from picks.json — prefer deep books for these games."""
    path = ROOT / "data" / "picks.json"
    out: set[tuple[str, str]] = set()
    if not path.exists():
        return out
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return out
    picks = raw.get("picks") if isinstance(raw, dict) else raw
    if not isinstance(picks, list):
        return out
    for p in picks:
        if not isinstance(p, dict):
            continue
        r = str(p.get("result") or "").upper()
        if r in {"W", "L", "P"}:
            continue
        a, h = canon(p.get("away") or ""), canon(p.get("home") or "")
        if a and h:
            out.add((a, h))
    return out


def summarize_from_book(
    book: dict[str, Any] | None,
    away_o: dict[str, Any] | None,
    home_o: dict[str, Any] | None,
    *,
    away_line: float | None = None,
    home_line: float | None = None,
) -> dict[str, Any]:
    orders = (book or {}).get("orders") if isinstance(book, dict) else {}
    if not isinstance(orders, dict):
        orders = {}
    away_orders = orders.get((away_o or {}).get("outcomeId") or "") if away_o else []
    home_orders = orders.get((home_o or {}).get("outcomeId") or "") if home_o else []
    away_top = top_levels_from_orders(away_orders if isinstance(away_orders, list) else [], 3)
    home_top = top_levels_from_orders(home_orders if isinstance(home_orders, list) else [], 3)
    # Fallback to catalog BBO when book empty
    if not away_top and away_o and isinstance(away_o.get("bid"), dict):
        p = away_o["bid"].get("price")
        try:
            pf = float(p)
            am = prob_to_american(pf)
            sz = qty_to_usd(away_o["bid"].get("qty"), pf)
            if am is not None and sz > 0:
                away_top = [{"odds": am, "size": sz, "prob": pf}]
        except (TypeError, ValueError):
            pass
    if not home_top and home_o and isinstance(home_o.get("bid"), dict):
        p = home_o["bid"].get("price")
        try:
            pf = float(p)
            am = prob_to_american(pf)
            sz = qty_to_usd(home_o["bid"].get("qty"), pf)
            if am is not None and sz > 0:
                home_top = [{"odds": am, "size": sz, "prob": pf}]
        except (TypeError, ValueError):
            pass
    away_tot = side_total(away_top)
    home_tot = side_total(home_top)
    out: dict[str, Any] = {
        "awayTotal": away_tot,
        "homeTotal": home_tot,
        "awayTop3": [{"odds": x["odds"], "size": x["size"]} for x in away_top],
        "homeTop3": [{"odds": x["odds"], "size": x["size"]} for x in home_top],
        "imbalance": imbalance(away_tot, home_tot),
    }
    if away_line is not None:
        out["awayLine"] = away_line
    if home_line is not None:
        out["homeLine"] = home_line
    return out


def window_ms() -> tuple[int, int]:
    now = _now()
    after = int((now - timedelta(hours=6)).timestamp() * 1000)
    before = int((now + timedelta(hours=30)).timestamp() * 1000)
    return after, before


def main() -> int:
    after, before = window_ms()
    today = et_ymd(_now())
    print(f"Novig public snapshot  window={after}..{before}  et={today}")

    events_by_id: dict[str, dict[str, Any]] = {}
    markets_by_event: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for league in LEAGUES:
        print(f"league {league}")
        for ev in page_items(
            "/v3/public/catalog/events",
            {
                "league": league,
                "startsAfter": after,
                "startsBefore": before,
                "limit": 500,
            },
        ):
            eid = str(ev.get("eventId") or "")
            if eid:
                events_by_id[eid] = ev
        for m in page_items(
            "/v3/public/catalog/markets",
            {
                "league": league,
                "marketType": "SPREAD,MONEY",
                "startsAfter": after,
                "startsBefore": before,
                "limit": 500,
            },
        ):
            if str(m.get("status") or "") != "OPEN":
                continue
            eid = str(m.get("eventId") or "")
            if eid:
                markets_by_event[eid].append(m)

    priority = load_priority_matchups()
    print(f"priority open matchups from picks.json: {len(priority)}")

    # Pass 1 — shape every event from catalog BBO (no book calls).
    staged: list[dict[str, Any]] = []
    for eid, mkts in markets_by_event.items():
        ev = events_by_id.get(eid) or {}
        away, home = split_event_desc(str(ev.get("description") or ""))
        if not away or not home:
            away = away or "Away"
            home = home or "Home"

        spreads = [m for m in mkts if m.get("marketType") == "SPREAD"]
        moneys = [m for m in mkts if m.get("marketType") == "MONEY"]
        main_sp = pick_main_spread(spreads)
        main_ml = None
        if moneys:
            main_ml = max(
                moneys,
                key=lambda m: float(m.get("openInterest") or 0)
                + float(m.get("volume") or 0) * 0.01,
            )
        if not main_sp and not main_ml:
            continue

        league = str(ev.get("league") or "")
        start = ms_to_iso(ev.get("startsTs") or (main_sp or main_ml or {}).get("startsTs"))
        live = str(ev.get("status") or "") == "OPEN_INGAME"

        sp_ao = sp_ho = None
        sp_al = sp_hl = None
        ml_ao = ml_ho = None
        sp_summary = {
            "awayTotal": 0.0,
            "homeTotal": 0.0,
            "awayTop3": [],
            "homeTop3": [],
            "imbalance": imbalance(0, 0),
        }
        ml_summary = {
            "awayTotal": 0.0,
            "homeTotal": 0.0,
            "awayTop3": [],
            "homeTop3": [],
            "imbalance": imbalance(0, 0),
        }
        oi = 0.0
        volume = 0.0

        if main_sp:
            sp_ao, sp_ho, sp_al, sp_hl = assign_spread_outcomes(main_sp, away, home)
            sp_summary = summarize_from_book(None, sp_ao, sp_ho, away_line=sp_al, home_line=sp_hl)
            try:
                oi += float(main_sp.get("openInterest") or 0)
                volume += float(main_sp.get("volume") or 0)
            except (TypeError, ValueError):
                pass
            if (away == "Away" or home == "Home") and sp_ao and sp_ho:
                away = strip_line_label(sp_ao.get("name") or "") or away
                home = strip_line_label(sp_ho.get("name") or "") or home

        if main_ml:
            ml_ao, ml_ho = assign_ml_outcomes(main_ml, away, home)
            ml_summary = summarize_from_book(None, ml_ao, ml_ho)
            try:
                oi += float(main_ml.get("openInterest") or 0)
                volume += float(main_ml.get("volume") or 0)
            except (TypeError, ValueError):
                pass

        if oi <= 0:
            oi = (
                sp_summary["awayTotal"]
                + sp_summary["homeTotal"]
                + ml_summary["awayTotal"]
                + ml_summary["homeTotal"]
            )

        is_priority = (canon(away), canon(home)) in priority or (canon(home), canon(away)) in priority
        staged.append(
            {
                "eid": eid,
                "ev": ev,
                "away": away,
                "home": home,
                "league": league,
                "start": start,
                "live": live,
                "oi": oi,
                "volume": volume,
                "main_sp": main_sp,
                "main_ml": main_ml,
                "sp_ao": sp_ao,
                "sp_ho": sp_ho,
                "sp_al": sp_al,
                "sp_hl": sp_hl,
                "ml_ao": ml_ao,
                "ml_ho": ml_ho,
                "sp_summary": sp_summary,
                "ml_summary": ml_summary,
                "priority": is_priority,
            }
        )

    staged.sort(key=lambda g: (not g["priority"], -float(g["oi"] or 0), str(g["start"] or "")))

    # Pass 2 — deep books for priority + top OI (spread first; ML if budget left).
    book_budget = MAX_BOOK_FETCHES
    print(f"deep book budget: {book_budget}")
    for g in staged:
        if book_budget <= 0:
            break
        if g["main_sp"] and book_budget > 0:
            book = fetch_book(str(g["main_sp"].get("marketId") or ""))
            if book:
                g["sp_summary"] = summarize_from_book(
                    book, g["sp_ao"], g["sp_ho"], away_line=g["sp_al"], home_line=g["sp_hl"]
                )
            book_budget -= 1
        # Skip ML book unless this is a priority game and we still have budget
        if g["priority"] and g["main_ml"] and book_budget > 0:
            book = fetch_book(str(g["main_ml"].get("marketId") or ""))
            if book:
                g["ml_summary"] = summarize_from_book(book, g["ml_ao"], g["ml_ho"])
            book_budget -= 1

    rows: list[dict[str, Any]] = []
    for g in staged:
        sp_summary = g["sp_summary"]
        ml_summary = g["ml_summary"]
        oi = float(g["oi"] or 0)
        if oi <= 0:
            oi = (
                sp_summary["awayTotal"]
                + sp_summary["homeTotal"]
                + ml_summary["awayTotal"]
                + ml_summary["homeTotal"]
            )
        primary = sp_summary if (sp_summary["awayTotal"] + sp_summary["homeTotal"]) > 0 else ml_summary
        rows.append(
            {
                "id": g["eid"],
                "league": g["league"],
                "sport": str((g["ev"] or {}).get("sport") or ""),
                "start": g["start"],
                "live": g["live"],
                "away": g["away"],
                "home": g["home"],
                "eventName": (g["ev"] or {}).get("description") or f"{g['away']} @ {g['home']}",
                "openInterest": round(oi, 2),
                "matchedVolume": round(float(g["volume"] or 0), 2),
                "moneyline": ml_summary,
                "spread": sp_summary,
                "heavySide": (primary.get("imbalance") or {}).get("heavy"),
                "heavyMarket": "spread" if primary is sp_summary else "moneyline",
                "heavyRatio": (primary.get("imbalance") or {}).get("ratio"),
                "novigSpreadMarketId": (g["main_sp"] or {}).get("marketId"),
                "novigMoneyMarketId": (g["main_ml"] or {}).get("marketId"),
            }
        )

    rows.sort(key=lambda g: (-float(g.get("openInterest") or 0), str(g.get("start") or "")))
    for i, g in enumerate(rows, start=1):
        g["rank"] = i

    payload = {
        "updatedAt": _now_iso(),
        "asOfEtDate": today,
        "source": "novig-public",
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
