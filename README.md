# Public % Takes — ROI dashboard

Live: https://jacobtulster.github.io/public-takes-roi/

OddsLogic public-% recommendations with interactive ROI equity (green above zero / red below), bucket cards, and pick history.

Data: [`data/picks.json`](./data/picks.json) — synced from the Pinny userscript via GitHub Contents API.

Matchups are deduped by `game# + away@home + role + side + market`.

## Grading

Open picks are settled automatically from ESPN finals (NCAAF / CFB, NCAAB, NFL, NBA, NHL, MLB, WNBA) by [`scripts/grade_picks.py`](./scripts/grade_picks.py).

- Spreads: take-side points (`line`) vs final score → W / L / P, profit from American `price`
- Moneylines: winner vs take side
- GitHub Action [`.github/workflows/grade.yml`](./.github/workflows/grade.yml) runs every 30 minutes and on manual dispatch

```bash
python scripts/grade_picks.py
```
