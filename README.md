# Public % Takes — GitHub Pages dashboard

Interactive ROI tracker for OddsLogic public-% recommendations (fav / dog × favorable).

## One-time deploy

1. Create a **public** GitHub repo (e.g. `public-takes-roi`).
2. Copy everything in this `takes-dashboard/` folder to the repo root (or keep the folder and set Pages to `/takes-dashboard` — root is simplest).
3. Push to `main`.
4. Repo **Settings → Pages → Deploy from branch → `main` / `/ (root)`**.
5. Note your site URL: `https://<user>.github.io/<repo>/`

## Connect the userscript

In the Pinny panel on OddsLogic:

| Field | Example |
| --- | --- |
| Dashboard URL | `https://you.github.io/public-takes-roi/` |
| GitHub repo | `you/public-takes-roi` |
| Path | `data/picks.json` |
| Token | classic PAT with `repo` scope (or fine-grained: Contents read/write on that repo) |

Picks are stored locally in Tampermonkey, then pushed to `data/picks.json`. The Pages site reads that file and draws green/red equity charts.

## Deduping

Each pick is keyed by **game # + away@home + role + side + market**. Utah@TCU and Utah@Anaheim never collide; flickering on/off the same board does not re-log.
