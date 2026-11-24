# Public % Takes — ROI dashboard

Live: https://jacobtulster.github.io/public-takes-roi/

OddsLogic public-% recommendations with interactive ROI equity (green above zero / red below), bucket cards, and pick history.

Data: [`data/picks.json`](./data/picks.json) — synced from the Pinny userscript via GitHub Contents API.

Matchups are deduped by `game# + away@home + role + side + market`.

## ATS vs moneyline

The dashboard keeps **two separate books**:

- **ATS** — spread / puck-line / run-line takes (`market: "spread"`)
- **Moneyline** — ML takes only (`market: "ml"`)

ROI cards, equity curves, and the picks table never mix the two. Switch with the ATS / Moneyline tabs.

When OddsLogic logs both a spread and an ML take on the same game, both rows are kept (different `pickKey` / `market`).

## Grading

Open picks are settled automatically from **ESPN only** (never OddsLogic scores) by [`scripts/grade_picks.py`](./scripts/grade_picks.py) and by live ESPN grading in the browser.

- Spreads (ATS): take-side points (`line`) vs final score → W / L / P, profit from American `price`
- Moneylines: winner vs take side → W / L / P (ties push), profit from American `price`
- GitHub Action [`.github/workflows/grade.yml`](./.github/workflows/grade.yml) runs every 5 minutes and on push / manual dispatch
- Team aliases cover OddsLogic ↔ ESPN naming (e.g. `Mississippi` → `Ole Miss`)

```bash
python scripts/grade_picks.py
```

## 4casters liquidity (in the picks table)

Open picks show 4casters columns inline:

- **4C #** — rank by open interest (+ OI $)
- **Maker $** — resting $ each side (green = heavy side)
- **Top 3** — best three resting prices/sizes per side

Snapshot: [`scripts/fetch_4casters_liquidity.py`](./scripts/fetch_4casters_liquidity.py) via [`.github/workflows/liquidity.yml`](./.github/workflows/liquidity.yml) every 15 minutes → [`data/liquidity.json`](./data/liquidity.json). Requires repo secret `FOURCASTERS_TOKEN`.
