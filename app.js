(() => {
  const BUCKETS = [
    { key: 'all', label: 'All' },
    { key: 'fav', label: 'Favs' },
    { key: 'dog', label: 'Dogs' },
    { key: 'fav_favorable', label: 'Fav + favbl' },
    { key: 'dog_favorable', label: 'Dog + favbl' },
    { key: 'fav_not_favorable', label: 'Fav + not' },
    { key: 'dog_not_favorable', label: 'Dog + not' },
  ];

  let store = { updatedAt: null, picks: [] };
  let liqStore = { updatedAt: null, games: [], error: null };
  let novigStore = { updatedAt: null, games: [], error: null };
  /** Fade-heavy disparity ledger (4C / Novig top-3 ≥ 2× → bet light). */
  let trustStore = {
    updatedAt: null,
    summary: { all: null, '4c': null, novig: null },
    signals: [],
  };
  let chart;
  let activeCard = 'all';
  let activeMarket = 'spread'; // ATS book by default; ML is a separate ledger
  /** Table sort: 'start' | 'rank' | 'novigRank' | 'combinedRank'. */
  let tableSort = { key: 'start', dir: 'asc' };
  /** Which liquidity columns to show: both | 4c | novig */
  let liqVenue = 'both';
  /** '' | 'good_fav' | 'good_dog' */
  let signalFilter = '';

  const $ = (sel) => document.querySelector(sel);

  function marketOf(pick) {
    const m = String(pick.market || '').toLowerCase();
    if (m === 'ml' || m === 'moneyline' || m === 'h2h') return 'ml';
    return 'spread';
  }

  function marketLabel(m) {
    return m === 'ml' ? 'Moneyline' : 'ATS';
  }

  function picksForMarket(market) {
    return (store.picks || []).filter((p) => marketOf(p) === market);
  }

  function bucketKeysFor(pick) {
    const role = String(pick.takeRole || '').toUpperCase();
    const oc = String(pick.ocLean || '').toLowerCase();
    const bucket = String(pick.bucket || '');
    const keys = ['all'];
    if (role === 'FAV') keys.push('fav');
    if (role === 'DOG') keys.push('dog');
    if (bucket && BUCKETS.some((b) => b.key === bucket)) keys.push(bucket);
    else {
      const fav = oc === 'favorable';
      if (role === 'FAV') keys.push(fav ? 'fav_favorable' : 'fav_not_favorable');
      if (role === 'DOG') keys.push(fav ? 'dog_favorable' : 'dog_not_favorable');
    }
    return keys;
  }

  function emptyAgg() {
    return { n: 0, graded: 0, w: 0, l: 0, p: 0, profit: 0 };
  }

  function summarize(picks) {
    const out = {};
    BUCKETS.forEach((b) => (out[b.key] = emptyAgg()));
    picks.forEach((pick) => {
      const keys = bucketKeysFor(pick);
      const result = String(pick.result || '').toUpperCase();
      const profit = Number(pick.profit);
      keys.forEach((k) => {
        const a = out[k];
        if (!a) return;
        a.n++;
        if (result === 'W') {
          a.w++;
          a.graded++;
          a.profit += Number.isFinite(profit) ? profit : 0;
        } else if (result === 'L') {
          a.l++;
          a.graded++;
          a.profit += Number.isFinite(profit) ? profit : -1;
        } else if (result === 'P') {
          a.p++;
          a.graded++;
        }
      });
    });
    return out;
  }

  /** 1 unit = $100 flat stake. */
  const UNIT_DOLLARS = 100;

  function fmtDollars(units) {
    if (!Number.isFinite(units)) return '—';
    const dollars = units * UNIT_DOLLARS;
    const sign = dollars > 0 ? '+' : dollars < 0 ? '-' : '';
    const abs = Math.abs(dollars);
    const body =
      Math.abs(abs - Math.round(abs)) < 0.005
        ? Math.round(abs).toLocaleString('en-US')
        : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return sign + '$' + body;
  }

  /** W-P-L as wins-pushes-losses. */
  function fmtRecord(agg) {
    if (!agg || !agg.graded) return '0-0-0';
    return `${agg.w || 0}-${agg.p || 0}-${agg.l || 0}`;
  }

  function dollarClass(units) {
    if (!Number.isFinite(units) || units === 0) return '';
    return units > 0 ? 'pos' : 'neg';
  }

  /** Calendar day in America/New_York as YYYY-MM-DD. */
  function etDateKey(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(d);
      const y = parts.find((p) => p.type === 'year').value;
      const m = parts.find((p) => p.type === 'month').value;
      const day = parts.find((p) => p.type === 'day').value;
      return `${y}-${m}-${day}`;
    } catch (_) {
      return d.toISOString().slice(0, 10);
    }
  }

  function shiftEtDayKey(dayKey, deltaDays) {
    const bits = String(dayKey || '')
      .split('-')
      .map(Number);
    if (bits.length !== 3 || bits.some((n) => !Number.isFinite(n))) return '';
    const dt = new Date(Date.UTC(bits[0], bits[1] - 1, bits[2]));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return (
      dt.getUTCFullYear() +
      '-' +
      String(dt.getUTCMonth() + 1).padStart(2, '0') +
      '-' +
      String(dt.getUTCDate()).padStart(2, '0')
    );
  }

  function etYesterdayKey() {
    return shiftEtDayKey(etDateKey(Date.now()), -1);
  }

  /** Monday (ET) of the current week as YYYY-MM-DD. */
  function etWeekStartKey() {
    const today = etDateKey(Date.now());
    const bits = today.split('-').map(Number);
    if (bits.length !== 3 || bits.some((n) => !Number.isFinite(n))) return '';
    const dt = new Date(Date.UTC(bits[0], bits[1] - 1, bits[2], 12, 0, 0));
    // getUTCDay: 0=Sun … 1=Mon — shift back to Monday
    const dow = dt.getUTCDay();
    const back = dow === 0 ? 6 : dow - 1;
    dt.setUTCDate(dt.getUTCDate() - back);
    return (
      dt.getUTCFullYear() +
      '-' +
      String(dt.getUTCMonth() + 1).padStart(2, '0') +
      '-' +
      String(dt.getUTCDate()).padStart(2, '0')
    );
  }

  /** Slate day for a pick — start time preferred (ET game day). */
  function pickEtDayKey(pick) {
    const iso = (pick && (pick.startAt || pick.gradedAt || pick.loggedAt)) || '';
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return '';
    return etDateKey(ms);
  }

  function summarizeDay(picks, dayKey) {
    const a = emptyAgg();
    (picks || []).forEach((pick) => {
      if (pickEtDayKey(pick) !== dayKey) return;
      const result = String(pick.result || '').toUpperCase();
      const profit = Number(pick.profit);
      a.n++;
      if (result === 'W') {
        a.w++;
        a.graded++;
        a.profit += Number.isFinite(profit) ? profit : 0;
      } else if (result === 'L') {
        a.l++;
        a.graded++;
        a.profit += Number.isFinite(profit) ? profit : -1;
      } else if (result === 'P') {
        a.p++;
        a.graded++;
      }
    });
    return a;
  }

  function summarizeRange(picks, startKey, endKeyInclusive) {
    const a = emptyAgg();
    if (!startKey || !endKeyInclusive) return a;
    (picks || []).forEach((pick) => {
      const day = pickEtDayKey(pick);
      if (!day || day < startKey || day > endKeyInclusive) return;
      const result = String(pick.result || '').toUpperCase();
      const profit = Number(pick.profit);
      a.n++;
      if (result === 'W') {
        a.w++;
        a.graded++;
        a.profit += Number.isFinite(profit) ? profit : 0;
      } else if (result === 'L') {
        a.l++;
        a.graded++;
        a.profit += Number.isFinite(profit) ? profit : -1;
      } else if (result === 'P') {
        a.p++;
        a.graded++;
      }
    });
    return a;
  }

  /** Always-visible Today / Yesterday / Week W-P-L + $ for the active book. */
  function renderDayStats() {
    const root = $('#day-stats');
    if (!root) return;
    const picks = picksForMarket(activeMarket);
    const todayKey = etDateKey(Date.now());
    const yestKey = etYesterdayKey();
    const weekStart = etWeekStartKey();
    const today = summarizeDay(picks, todayKey);
    const yest = summarizeDay(picks, yestKey);
    const week = summarizeRange(picks, weekStart, todayKey);
    const paint = (prefix, agg) => {
      const rec = root.querySelector(`#${prefix}-record`);
      const dol = root.querySelector(`#${prefix}-dollars`);
      if (rec) rec.textContent = fmtRecord(agg);
      if (dol) {
        dol.textContent = agg.graded ? fmtDollars(agg.profit) : '$0';
        dol.className = 'day-dollars' + (dollarClass(agg.profit) ? ' ' + dollarClass(agg.profit) : '');
      }
    };
    paint('day-today', today);
    paint('day-yest', yest);
    paint('day-week', week);
    root.title =
      `${marketLabel(activeMarket)} · Today ${fmtRecord(today)} ${fmtDollars(today.profit)}` +
      ` · Yesterday ${fmtRecord(yest)} ${fmtDollars(yest.profit)}` +
      ` · Week ${fmtRecord(week)} ${fmtDollars(week.profit)} (Mon–Sun ET)`;
  }

  function trustAgg(venue) {
    const raw =
      (trustStore.summary && trustStore.summary[venue]) ||
      { w: 0, p: 0, l: 0, graded: 0, open: 0, profit: 0, record: '0-0-0' };
    return {
      w: Number(raw.w) || 0,
      p: Number(raw.p) || 0,
      l: Number(raw.l) || 0,
      graded: Number(raw.graded) || 0,
      open: Number(raw.open) || 0,
      profit: Number(raw.profit) || 0,
      record: raw.record || '0-0-0',
    };
  }

  /** 4C / NV fade-disparity W-P-L (bet light when top-3 $ ≥ 2×). */
  function renderTrustStats() {
    const root = $('#trust-stats');
    if (!root) return;
    const paint = (prefix, venue) => {
      const agg = trustAgg(venue);
      const rec = document.querySelector(`#${prefix}-record`);
      const dol = document.querySelector(`#${prefix}-dollars`);
      const openEl = document.querySelector(`#${prefix}-open`);
      if (rec) rec.textContent = agg.record || fmtRecord(agg);
      if (dol) {
        dol.textContent = agg.graded ? fmtDollars(agg.profit) : '$0';
        dol.className = 'day-dollars' + (dollarClass(agg.profit) ? ' ' + dollarClass(agg.profit) : '');
      }
      if (openEl) openEl.textContent = `${agg.open || 0} open`;
    };
    paint('trust-4c', '4c');
    paint('trust-nv', 'novig');
    const a4 = trustAgg('4c');
    const an = trustAgg('novig');
    root.title =
      `Fade big money (top-3 $ ≥2×) → bet light @ $100/u` +
      ` · 4C fade big money ${a4.record} ${fmtDollars(a4.profit)} (${a4.open} open)` +
      ` · NV fade big money ${an.record} ${fmtDollars(an.profit)} (${an.open} open)`;
  }

  /** Prefer frozen stamp; else live combined+favorable check. */
  function isGoodSignalPick(pick, kind) {
    const snap = pick && pick.liqSnap;
    if (snap && typeof snap === 'object') {
      if (kind === 'good_fav' && snap.goodFav === true) return true;
      if (kind === 'good_dog' && snap.goodDog === true) return true;
      // Older stamps: derive from agrees + bucket
      if (snap.liqAgreesTake === true) {
        if (kind === 'good_fav' && bucketKeysFor(pick).includes('fav_favorable')) return true;
        if (kind === 'good_dog' && bucketKeysFor(pick).includes('dog_favorable')) return true;
      }
      if (snap.frozen) return false;
    }
    if (kind === 'good_fav') {
      return bucketKeysFor(pick).includes('fav_favorable') && combinedHeavyOnOtherSide(pick);
    }
    if (kind === 'good_dog') {
      return bucketKeysFor(pick).includes('dog_favorable') && combinedHeavyOnOtherSide(pick);
    }
    return false;
  }

  function summarizeSignalPicks(kind) {
    const a = emptyAgg();
    picksForMarket(activeMarket).forEach((pick) => {
      if (!isGoodSignalPick(pick, kind)) return;
      const result = String(pick.result || '').toUpperCase();
      const profit = Number(pick.profit);
      a.n++;
      if (result === 'W') {
        a.w++;
        a.graded++;
        a.profit += Number.isFinite(profit) ? profit : 0;
      } else if (result === 'L') {
        a.l++;
        a.graded++;
        a.profit += Number.isFinite(profit) ? profit : -1;
      } else if (result === 'P') {
        a.p++;
        a.graded++;
      } else {
        a.open = (a.open || 0) + 1;
      }
    });
    a.open = a.open || 0;
    return a;
  }

  function renderGoodSignalStats() {
    const root = $('#good-signal-stats');
    if (!root) return;
    const paint = (prefix, kind) => {
      const agg = summarizeSignalPicks(kind);
      const rec = document.querySelector(`#${prefix}-record`);
      const dol = document.querySelector(`#${prefix}-dollars`);
      const openEl = document.querySelector(`#${prefix}-open`);
      if (rec) rec.textContent = fmtRecord(agg);
      if (dol) {
        dol.textContent = agg.graded ? fmtDollars(agg.profit) : '$0';
        dol.className = 'day-dollars' + (dollarClass(agg.profit) ? ' ' + dollarClass(agg.profit) : '');
      }
      if (openEl) openEl.textContent = `${agg.open || 0} open`;
    };
    paint('good-fav', 'good_fav');
    paint('good-dog', 'good_dog');
    const gf = summarizeSignalPicks('good_fav');
    const gd = summarizeSignalPicks('good_dog');
    root.title =
      `Good fav / dog · favorable + combined heavy on other side` +
      ` · fav ${fmtRecord(gf)} ${fmtDollars(gf.profit)} (${gf.open} open)` +
      ` · dog ${fmtRecord(gd)} ${fmtDollars(gd.profit)} (${gd.open} open)`;
  }

  /**
   * Dogs where public take + book both lean dog (liqSnap.liqAgreesTake),
   * split by median combined top-3 $ into hi vs lo liquidity.
   */
  function renderDogLiqStats() {
    const root = $('#dog-liq-stats');
    if (!root) return;
    const dogs = picksForMarket(activeMarket).filter((p) => {
      if (String(p.takeRole || '').toUpperCase() !== 'DOG') return false;
      const snap = p.liqSnap;
      return snap && typeof snap === 'object' && snap.liqAgreesTake === true;
    });
    const graded = dogs.filter((p) => {
      const r = String(p.result || '').toUpperCase();
      return r === 'W' || r === 'L' || r === 'P';
    });
    const empty = emptyAgg();
    const paint = (prefix, agg) => {
      const rec = document.querySelector(`#${prefix}-record`);
      const dol = document.querySelector(`#${prefix}-dollars`);
      const nEl = document.querySelector(`#${prefix}-n`);
      if (rec) rec.textContent = fmtRecord(agg);
      if (dol) {
        dol.textContent = agg.graded ? fmtDollars(agg.profit) : '$0';
        dol.className = 'day-dollars' + (dollarClass(agg.profit) ? ' ' + dollarClass(agg.profit) : '');
      }
      if (nEl) nEl.textContent = `n=${agg.graded || 0}`;
    };
    if (graded.length < 2) {
      paint('dog-hi-liq', empty);
      paint('dog-lo-liq', empty);
      root.title =
        `Need ≥2 graded dogs where book also leans dog (stamped liqSnap). Have ${graded.length}.`;
      return;
    }
    const sorted = graded
      .slice()
      .sort((a, b) => Number(a.liqSnap.combinedTop3 || 0) - Number(b.liqSnap.combinedTop3 || 0));
    const mid = Math.floor(sorted.length / 2);
    const lo = sorted.slice(0, mid);
    const hi = sorted.slice(mid);
    const toAgg = (list) => {
      const a = emptyAgg();
      list.forEach((p) => {
        const r = String(p.result || '').toUpperCase();
        const profit = Number(p.profit);
        a.n++;
        if (r === 'W') {
          a.w++;
          a.graded++;
          a.profit += Number.isFinite(profit) ? profit : 0;
        } else if (r === 'L') {
          a.l++;
          a.graded++;
          a.profit += Number.isFinite(profit) ? profit : -1;
        } else if (r === 'P') {
          a.p++;
          a.graded++;
        }
      });
      return a;
    };
    const hiA = toAgg(hi);
    const loA = toAgg(lo);
    paint('dog-hi-liq', hiA);
    paint('dog-lo-liq', loA);
    const med = Number(sorted[mid] && sorted[mid].liqSnap && sorted[mid].liqSnap.combinedTop3) || 0;
    root.title =
      `ATS dogs · public dog + book leans dog · split at median combined top-3 $${med.toLocaleString()}` +
      ` · hi ${fmtRecord(hiA)} ${fmtDollars(hiA.profit)}` +
      ` · lo ${fmtRecord(loA)} ${fmtDollars(loA.profit)}`;
  }

  function renderMarketTabs() {
    const root = $('#market-tabs');
    if (!root) return;
    const counts = {
      spread: picksForMarket('spread').length,
      ml: picksForMarket('ml').length,
    };
    root.innerHTML = [
      { key: 'spread', label: 'ATS' },
      { key: 'ml', label: 'Moneyline' },
    ]
      .map((tab) => {
        const on = activeMarket === tab.key ? ' is-active' : '';
        return (
          `<button type="button" class="market-tab${on}" data-market="${tab.key}">` +
          `${tab.label}<span class="market-count">${counts[tab.key]}</span>` +
          `</button>`
        );
      })
      .join('');
    root.querySelectorAll('[data-market]').forEach((el) => {
      el.addEventListener('click', () => {
        activeMarket = el.getAttribute('data-market');
        activeCard = 'all';
        const chartSel = $('#chart-bucket');
        if (chartSel) chartSel.value = 'all';
        renderAll();
      });
    });
  }

  function renderCards(aggs) {
    const root = $('#summary-cards');
    root.innerHTML = BUCKETS.map((b) => {
      const a = aggs[b.key];
      const cls = dollarClass(a.profit);
      return (
        `<button type="button" class="card${activeCard === b.key ? ' is-active' : ''}" data-bucket="${b.key}">` +
        `<div class="k">${b.label}</div>` +
        `<div class="v ${cls}">${a.graded ? fmtDollars(a.profit) : '—'}</div>` +
        `<div class="s">${fmtRecord(a)} W-P-L · ${a.graded}/${a.n} graded</div>` +
        `</button>`
      );
    }).join('');
    root.querySelectorAll('[data-bucket]').forEach((el) => {
      el.addEventListener('click', () => {
        activeCard = el.getAttribute('data-bucket');
        $('#chart-bucket').value = activeCard;
        renderCards(aggs);
        renderChart();
      });
    });
  }

  function gradedChrono(bucket) {
    return picksForMarket(activeMarket)
      .filter((p) => {
        const r = String(p.result || '').toUpperCase();
        if (r !== 'W' && r !== 'L' && r !== 'P') return false;
        if (!bucket || bucket === 'all') return true;
        return bucketKeysFor(p).includes(bucket);
      })
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.gradedAt || a.loggedAt || 0).getTime() || 0;
        const tb = new Date(b.gradedAt || b.loggedAt || 0).getTime() || 0;
        if (ta !== tb) return ta - tb;
        return String(a.pickKey || '').localeCompare(String(b.pickKey || ''));
      });
  }

  function equitySeries(bucket) {
    const rows = gradedChrono(bucket);
    let cum = 0;
    const labels = [];
    const cumArr = [];
    const pos = [];
    const neg = [];
    const tips = [];
    rows.forEach((p, i) => {
      const profit =
        String(p.result).toUpperCase() === 'L'
          ? Number.isFinite(Number(p.profit))
            ? Number(p.profit)
            : -1
          : Number(p.profit) || 0;
      cum += profit;
      labels.push(String(i + 1));
      cumArr.push(Math.round(cum * 10000) / 10000);
      pos.push(cum > 0 ? Math.round(cum * 10000) / 10000 : 0);
      neg.push(cum < 0 ? Math.round(cum * 10000) / 10000 : 0);
      tips.push({
        matchup: `${p.away || '?'} @ ${p.home || '?'}`,
        team: p.takeTeam || p.takeSide,
        result: p.result,
        profit,
        cum,
        market: marketLabel(marketOf(p)),
      });
    });
    return { labels, cumArr, pos, neg, tips };
  }

  function isMobileChart() {
    return window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
  }

  function renderChart() {
    const bucket = $('#chart-bucket').value || 'all';
    const { labels, cumArr, pos, neg, tips } = equitySeries(bucket);
    const ctx = $('#equity-chart');
    if (chart) chart.destroy();
    const mobile = isMobileChart();
    const emptyTitle = `No graded ${marketLabel(activeMarket)} picks yet`;
    if (!labels.length) {
      chart = new Chart(ctx, {
        type: 'line',
        data: { labels: ['—'], datasets: [] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            title: { display: true, text: emptyTitle, color: '#93a0bb', font: { size: mobile ? 13 : 12 } },
          },
        },
      });
      return;
    }
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Above 0',
            data: pos,
            borderColor: 'rgba(61,214,140,0.15)',
            backgroundColor: 'rgba(61, 214, 140, 0.32)',
            fill: 'origin',
            pointRadius: 0,
            tension: 0.15,
            order: 2,
          },
          {
            label: 'Below 0',
            data: neg,
            borderColor: 'rgba(255,107,107,0.15)',
            backgroundColor: 'rgba(255, 107, 107, 0.32)',
            fill: 'origin',
            pointRadius: 0,
            tension: 0.15,
            order: 2,
          },
          {
            label: 'Equity',
            data: cumArr,
            borderColor: '#5ec8ff',
            backgroundColor: 'transparent',
            fill: false,
            pointRadius: mobile ? 4 : 3,
            pointHoverRadius: mobile ? 6 : 5,
            tension: 0.15,
            borderWidth: mobile ? 2.5 : 2,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: mobile ? { padding: { top: 4, right: 6, bottom: 2, left: 2 } } : {},
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            titleFont: { size: mobile ? 13 : 12 },
            bodyFont: { size: mobile ? 13 : 12 },
            padding: mobile ? 10 : 8,
            callbacks: {
              title(items) {
                const i = items[0] && items[0].dataIndex;
                const t = tips[i];
                return t ? t.matchup : '';
              },
              label(item) {
                if (item.dataset.label !== 'Equity') return null;
                const t = tips[item.dataIndex];
                if (!t) return '';
                return `${t.team} · ${t.result} ${fmtDollars(t.profit)} → ${fmtDollars(t.cum)}`;
              },
            },
          },
        },
        scales: {
          x: {
            title: {
              display: !mobile,
              text: `Graded ${marketLabel(activeMarket)} #`,
              color: '#93a0bb',
            },
            ticks: {
              color: '#93a0bb',
              font: { size: mobile ? 11 : 11 },
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: mobile ? 6 : 12,
            },
            grid: { color: 'rgba(42,54,80,0.45)' },
          },
          y: {
            title: {
              display: !mobile,
              text: 'Cumulative $ ($100 = 1u)',
              color: '#93a0bb',
            },
            ticks: {
              color: '#c5d0e6',
              font: { size: mobile ? 12 : 11 },
              maxTicksLimit: mobile ? 5 : 8,
              callback(v) {
                return fmtDollars(Number(v));
              },
            },
            grid: { color: 'rgba(42,54,80,0.45)' },
            grace: '8%',
          },
        },
      },
    });
  }

  /** Combined book heavy on the opposite side of the pick (needs both 4C+NV). */
  function combinedHeavyOnOtherSide(pick) {
    const c = combinedSideSums(pick);
    if (!c || !c.heavy) return false;
    const take = String(pick.takeSide || '').toLowerCase();
    if (take !== 'away' && take !== 'home') return false;
    return c.heavy !== take;
  }

  function matchesSignalFilter(pick) {
    if (!signalFilter) return true;
    if (signalFilter === 'good_fav' || signalFilter === 'good_dog') {
      return isGoodSignalPick(pick, signalFilter);
    }
    return true;
  }

  function matchesFilter(pick) {
    if (marketOf(pick) !== activeMarket) return false;
    const bucket = $('#filter-bucket').value;
    const result = $('#filter-result').value;
    if (bucket === 'fav' || bucket === 'dog') {
      if (!bucketKeysFor(pick).includes(bucket)) return false;
    } else if (bucket && !bucketKeysFor(pick).includes(bucket)) return false;
    const r = String(pick.result || '').toUpperCase();
    if (result === 'open' && (r === 'W' || r === 'L' || r === 'P')) return false;
    if (result && result !== 'open' && r !== result) return false;
    return true;
  }

  function syncSignalFilterTabs() {
    document.querySelectorAll('#signal-filter-tabs .liq-venue-tab').forEach((btn) => {
      const v = btn.getAttribute('data-signal') || '';
      btn.classList.toggle('is-active', v === signalFilter);
    });
  }

  /**
   * Absolute tip ms. Prefer startAt (UTC ISO from OddsLogic via userscript).
   * Never reinterpret kick wall-clock as UTC — kick is logger-local and would
   * double-shift when the PC is already on EST.
   */
  function parseStartMs(p) {
    const iso = String((p && p.startAt) || '').trim();
    if (iso) {
      const t = Date.parse(iso);
      if (Number.isFinite(t)) return t;
    }
    return null;
  }

  /** 0 = upcoming, 1 = live / started (ungraded), 2 = graded / ended. */
  function pickTimeBucket(p, now) {
    const r = String((p && p.result) || '').toUpperCase();
    if (r === 'W' || r === 'L' || r === 'P') return 2;
    const ms = parseStartMs(p);
    if (ms == null) return 1;
    return ms > now ? 0 : 1;
  }

  function comparePicksByStart(a, b, now) {
    const ba = pickTimeBucket(a, now);
    const bb = pickTimeBucket(b, now);
    if (ba !== bb) return ba - bb;
    const ma = parseStartMs(a);
    const mb = parseStartMs(b);
    if (ba === 0) {
      // Upcoming: closest tip first
      return (ma != null ? ma : Infinity) - (mb != null ? mb : Infinity);
    }
    if (ba === 1) {
      // Live / awaiting grade: most recently started first
      return (mb != null ? mb : -Infinity) - (ma != null ? ma : -Infinity);
    }
    // Ended: newest grade first
    return String(b.gradedAt || b.loggedAt || '').localeCompare(String(a.gradedAt || a.loggedAt || ''));
  }

  function pickLiqRank(pick, venue) {
    const hit = findLiquidityGame(pick, venue === 'novig' ? novigStore : liqStore);
    if (!hit || hit.game == null || hit.game.rank == null) return null;
    const n = Number(hit.game.rank);
    return Number.isFinite(n) ? n : null;
  }

  /** Main-line top-3 $ ratio for a venue (same math as the cell badge). */
  function pickLiqRatio(pick, venue) {
    if (venue === 'combined') {
      const c = combinedSideSums(pick);
      return c ? c.ratio : null;
    }
    const sides = venueSideSums(pick, venue === 'novig' ? novigStore : liqStore);
    if (!sides || sides.awaySum + sides.homeSum <= 0) return null;
    return sides.ratio;
  }

  function combinedSideSums(pick) {
    const a4 = venueSideSums(pick, liqStore);
    const an = venueSideSums(pick, novigStore);
    // Require both venues with real top-3 $ — one-sided is not a combined ratio.
    const has4 = a4 && a4.awaySum + a4.homeSum > 0;
    const hasN = an && an.awaySum + an.homeSum > 0;
    if (!has4 || !hasN) return null;
    const awaySum = a4.awaySum + an.awaySum;
    const homeSum = a4.homeSum + an.homeSum;
    if (awaySum + homeSum <= 0) return null;
    const { ratio, heavy } = top3Ratio(awaySum, homeSum);
    return {
      awaySum,
      homeSum,
      ratio,
      heavy,
      awayLabel: a4.awayLabel || pick.away || 'Away',
      homeLabel: a4.homeLabel || pick.home || 'Home',
      r4: a4.ratio,
      rN: an.ratio,
      heavy4: a4.heavy,
      heavyN: an.heavy,
    };
  }

  function comparePicksForTable(a, b, now) {
    return comparePicksByStart(a, b, now);
  }

  function syncSortHeaders() {
    document.querySelectorAll('th.th-sort').forEach((th) => {
      const key = th.getAttribute('data-sort');
      const on = key === tableSort.key;
      th.classList.toggle('is-sorted', on);
      th.classList.toggle('is-asc', on && tableSort.dir === 'asc');
      th.classList.toggle('is-desc', on && tableSort.dir === 'desc');
      th.setAttribute('aria-sort', on ? (tableSort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }

  /** Game start shown in Eastern Time when startAt exists; else kick as logged. */
  function fmtGameStart(p) {
    const ms = parseStartMs(p);
    if (ms != null) {
      const d = new Date(ms);
      const timeLabel = d.toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      });
      const day = d.toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      return { main: timeLabel, sub: day };
    }
    // Legacy rows (no startAt): show kick as captured on the logger PC — no TZ guess.
    const kick = String((p && p.kick) || '').trim();
    const league = String((p && p.league) || '');
    const dayMatch = league.match(
      /\b((Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+[A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?)/i
    );
    if (kick) {
      return {
        main: kick,
        sub: (dayMatch ? dayMatch[1] : '') + (dayMatch ? ' · as logged' : 'as logged'),
      };
    }
    if (p && p.loggedAt) {
      return { main: new Date(p.loggedAt).toLocaleString(), sub: 'logged' };
    }
    return { main: '—', sub: '' };
  }

  /** Bucket meta with glowing "favorable" (green fav / orange dog). */
  function fmtLeanMeta(p) {
    const bucket = escapeHtml(p.bucket || '');
    const oc = String(p.ocLean || '').toLowerCase();
    if (!oc || oc === 'none') return bucket;
    if (oc === 'favorable') {
      const role = String(p.takeRole || '').toUpperCase();
      const glow = role === 'DOG' ? 'lean-glow lean-glow-dog' : 'lean-glow lean-glow-fav';
      return `${bucket}${bucket ? ' · ' : ''}<span class="${glow}">favorable</span>`;
    }
    return `${bucket}${bucket ? ' · ' : ''}${escapeHtml(p.ocLean)}`;
  }

  function renderTable() {
    const body = $('#picks-body');
    const now = Date.now();
    const rows = store.picks
      .slice()
      .filter(matchesFilter)
      .sort((a, b) => comparePicksForTable(a, b, now));
    syncSortHeaders();
    $('#picks-empty').hidden = rows.length > 0;
    const empty = $('#picks-empty');
    if (empty) {
      empty.textContent =
        activeMarket === 'ml'
          ? 'No moneyline takes yet — ML is tracked separately from ATS when OddsLogic logs an ML take.'
          : 'No ATS picks yet — configure the OddsLogic userscript sync, then refresh.';
    }
    body.innerHTML = rows
      .map((p) => {
        const r = String(p.result || '').toUpperCase();
        const role = String(p.takeRole || '').toUpperCase();
        const rolePill = role === 'DOG' ? 'pill-dog' : 'pill-fav';
        const resPill =
          r === 'W' ? 'pill-w' : r === 'L' ? 'pill-l' : r === 'P' ? 'pill-p' : 'pill-open';
        const mkt = marketOf(p);
        const mktPill = mkt === 'ml' ? 'pill-ml' : 'pill-ats';
        const line = fmtMarketLine(p);
        const start = fmtGameStart(p);
        const profitUnits =
          r === 'W' || r === 'L' || r === 'P'
            ? Number(p.profit) || (r === 'L' ? -1 : 0)
            : null;
        const profit =
          profitUnits == null ? '—' : `<span class="${dollarClass(profitUnits)}">${fmtDollars(profitUnits)}</span>`;
        const src =
          p.lineSource === 'espn'
            ? p.lineBook
              ? `ESPN · ${p.lineBook}`
              : 'ESPN'
            : p.lineSource || p.lineBook || '';
        const lean = fmtLeanMeta(p);
        return (
          `<tr>` +
          `<td class="col-start">${escapeHtml(start.main)}${start.sub ? `<div class="meta">${escapeHtml(start.sub)}</div>` : ''}</td>` +
          `<td class="col-matchup">${escapeHtml(p.away || '?')} @ ${escapeHtml(p.home || '?')}<div class="meta">${escapeHtml(p.league || p.sport || '')}</div></td>` +
          `<td class="col-pick"><span class="pill ${rolePill}">${escapeHtml(role || '—')}</span> ${escapeHtml(p.takeTeam || p.takeSide || '')}` +
          `<div class="meta pick-sub"><span class="pill ${mktPill}">${marketLabel(mkt)}</span> · ${lean}</div></td>` +
          `<td class="col-line">${escapeHtml(line)}${src ? `<div class="meta">${escapeHtml(src)}</div>` : ''}</td>` +
          `<td class="col-result"><span class="pill ${resPill}">${r || 'OPEN'}</span>` +
          `<div class="meta profit-inline">${profit}</div>` +
          `${p.gradeSource ? `<div class="meta grade-src">${escapeHtml(p.gradeSource)}</div>` : ''}</td>` +
          `</tr>`
        );
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtSigned(n) {
    if (n == null || n === '' || Number.isNaN(Number(n))) return null;
    const v = Number(n);
    return (v > 0 ? '+' : '') + String(v);
  }

  function fmtMarketLine(p) {
    if (marketOf(p) === 'spread') {
      const line = fmtSigned(p.line);
      if (line == null) return '—';
      const juice = fmtSigned(p.price);
      return juice != null ? `${line} (${juice})` : line;
    }
    const ml = fmtSigned(p.price != null ? p.price : p.line);
    return ml != null ? ml : '—';
  }

  function fmtUsd(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return (
      '$' +
      Math.round(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
    );
  }

  function fmtUsdCompact(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(abs >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
    if (abs >= 1e4) return '$' + (v / 1e3).toFixed(abs >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return fmtUsd(v);
  }

  function shortTeamLabel(name) {
    const s = String(name || '').trim();
    if (!s) return '—';
    if (s.length <= 14) return s;
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 1];
    return s.slice(0, 12) + '…';
  }

  function fmtOddsShort(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + String(v);
  }

  function liqCanon(s) {
    let t = String(s || '')
      .toLowerCase()
      .replace(/[\u2018\u2019']/g, '')
      .replace(/&/g, ' and ')
      .replace(/\./g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(university|univ|the|saint|st)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const aliases = {
      mississippi: 'ole miss',
      'ole miss': 'ole miss',
      'l a clippers': 'los angeles clippers',
      'la clippers': 'los angeles clippers',
      'l a lakers': 'los angeles lakers',
      'la lakers': 'los angeles lakers',
      'ut martin': 'tennessee martin',
    };
    if (aliases[t]) t = aliases[t];
    return t;
  }

  function liqNameHit(a, b) {
    const left = liqCanon(a);
    const right = liqCanon(b);
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.indexOf(right) >= 0 || right.indexOf(left) >= 0) return true;
    const lt = left.split(' ').filter((x) => x.length > 1);
    const rt = right.split(' ').filter((x) => x.length > 1);
    if (!lt.length || !rt.length) return false;
    let hits = 0;
    for (let i = 0; i < lt.length; i++) {
      if (rt.indexOf(lt[i]) >= 0) hits++;
    }
    return hits >= Math.min(2, lt.length, rt.length);
  }

  function findLiquidityGame(pick, venueStore) {
    const games = (venueStore && venueStore.games) || [];
    if (!pick || !games.length) return null;
    const away = pick.away || '';
    const home = pick.home || '';
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      if (!g) continue;
      const fwd = liqNameHit(away, g.away) && liqNameHit(home, g.home);
      const rev = liqNameHit(away, g.home) && liqNameHit(home, g.away);
      if (fwd || rev) return { game: g, flipped: !fwd && rev };
    }
    return null;
  }

  function isNhlOrMlb(pick, game) {
    const blob = [
      pick && pick.sport,
      pick && pick.league,
      game && game.sport,
      game && game.league,
      game && game.eventName,
    ]
      .filter(Boolean)
      .join(' ')
      .toUpperCase();
    return /\bNHL\b/.test(blob) || /\bMLB\b/.test(blob) || /HOCKEY/.test(blob) || /\bBASEBALL\b/.test(blob);
  }

  /** +1.5 priced between +100 and -145 (inclusive). */
  function plus15InJuiceBand(line, top3) {
    if (Math.abs(Number(line) - 1.5) > 0.05) return false;
    const rows = Array.isArray(top3) ? top3 : [];
    for (let i = 0; i < rows.length; i++) {
      const odds = Number(rows[i] && rows[i].odds);
      if (Number.isFinite(odds) && odds >= -145 && odds <= 100) return true;
    }
    return false;
  }

  function spreadHasPlus15Band(sp) {
    if (!sp || typeof sp !== 'object') return false;
    return (
      plus15InJuiceBand(sp.awayLine, sp.awayTop3) || plus15InJuiceBand(sp.homeLine, sp.homeTop3)
    );
  }

  /**
   * Liquidity book for disparity:
   * NHL/MLB → ML, unless +1.5 is +100…-145 then use that spread.
   * Else → match the pick market (ATS prefers spread).
   */
  function bookForPick(pick, game) {
    if (!game) return null;
    const sp = game.spread;
    const ml = game.moneyline;
    if (isNhlOrMlb(pick, game)) {
      if (spreadHasPlus15Band(sp)) return sp;
      if (ml && sumTop3Sizes(ml.awayTop3) + sumTop3Sizes(ml.homeTop3) > 0) return ml;
      return ml || sp || null;
    }
    if (marketOf(pick) === 'ml') return ml || null;
    const spTot = sp ? Number(sp.awayTotal || 0) + Number(sp.homeTotal || 0) : 0;
    if (spTot > 0) return sp;
    return ml || sp || null;
  }

  function venueSideSums(pick, venueStore) {
    const hit = findLiquidityGame(pick, venueStore);
    if (!hit || !hit.game) return null;
    const book = bookForPick(pick, hit.game);
    if (!book) return null;
    let awayTop = book.awayTop3;
    let homeTop = book.homeTop3;
    let awayLine = book.awayLine;
    let homeLine = book.homeLine;
    let awayLabel = hit.game.away || 'Away';
    let homeLabel = hit.game.home || 'Home';
    if (hit.flipped) {
      const tt = awayTop;
      awayTop = homeTop;
      homeTop = tt;
      const tl = awayLabel;
      awayLabel = homeLabel;
      homeLabel = tl;
      const ln = awayLine;
      awayLine = homeLine;
      homeLine = ln;
    }
    return {
      awaySum: sumTop3Sizes(awayTop),
      homeSum: sumTop3Sizes(homeTop),
      awayLabel,
      homeLabel,
      ratio: top3Ratio(sumTop3Sizes(awayTop), sumTop3Sizes(homeTop)).ratio,
      heavy: top3Ratio(sumTop3Sizes(awayTop), sumTop3Sizes(homeTop)).heavy,
    };
  }

  function fmtSpreadLine(n) {
    if (n == null || n === '' || Number.isNaN(Number(n))) return '';
    const v = Number(n);
    if (v > 0) return '+' + v;
    return String(v);
  }

  function sumTop3Sizes(levels) {
    const rows = Array.isArray(levels) ? levels : [];
    let tot = 0;
    for (let i = 0; i < rows.length; i++) {
      const v = Number(rows[i] && rows[i].size);
      if (Number.isFinite(v) && v > 0) tot += v;
    }
    return tot;
  }

  function top3Ratio(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi <= 0) return { ratio: 1, heavy: null };
    if (lo <= 0) return { ratio: hi > 0 ? 99 : 1, heavy: a >= b ? 'away' : 'home' };
    return {
      ratio: hi / lo,
      heavy: a > b ? 'away' : b > a ? 'home' : null,
    };
  }

  /** Only highlight at 2×+ side disparity (no color under that). */
  function ratioTier(ratio) {
    if (ratio >= 3) return 'hot';
    if (ratio >= 2) return 'warm';
    return '';
  }

  function renderTop3Levels(levels, oppLevels) {
    const rows = Array.isArray(levels) ? levels : [];
    const opp = Array.isArray(oppLevels) ? oppLevels : [];
    if (!rows.length) return '<div class="meta">—</div>';
    return (
      `<div class="liq-top3">` +
      rows
        .map((lv, i) => {
          const size = Number(lv && lv.size) || 0;
          const oppSize = Number(opp[i] && opp[i].size) || 0;
          // Highlight this raw price row when its $ is ≥2× the matching row on the other side
          let beat = '';
          if (size > 0 && (oppSize <= 0 || size / oppSize >= 2)) {
            const rowRatio = oppSize > 0 ? size / oppSize : 99;
            const rowTier = ratioTier(rowRatio);
            if (rowTier) beat = ` is-skew-level liq-level-${rowTier}`;
          }
          return (
            `<div class="liq-level${beat}"><span class="odds">${fmtOddsShort(lv.odds)}</span>` +
            `<span class="size">${fmtUsd(lv.size)}</span></div>`
          );
        })
        .join('') +
      `</div>`
    );
  }

  function renderPickLiquidityCells(pick, venueStore, colClass) {
    const cls = colClass || 'col-4c';
    const hit = findLiquidityGame(pick, venueStore);
    if (!hit) {
      return {
        rowClass: '',
        cells: `<td class="col-liq ${cls}"><span class="meta">—</span></td>`,
      };
    }
    const g = hit.game;
    const book = bookForPick(pick, g) || {};
    let awayTop = book.awayTop3;
    let homeTop = book.homeTop3;
    let awayLine = book.awayLine;
    let homeLine = book.homeLine;
    let awayLabel = g.away || 'Away';
    let homeLabel = g.home || 'Home';
    if (hit.flipped) {
      const tt = awayTop;
      awayTop = homeTop;
      homeTop = tt;
      const tl = awayLabel;
      awayLabel = homeLabel;
      homeLabel = tl;
      const ln = awayLine;
      awayLine = homeLine;
      homeLine = ln;
    }
    const awaySum = sumTop3Sizes(awayTop);
    const homeSum = sumTop3Sizes(homeTop);
    const { ratio, heavy } = top3Ratio(awaySum, homeSum);
    const tier = ratioTier(ratio);
    const heavyName = heavy === 'away' ? shortTeamLabel(awayLabel) : heavy === 'home' ? shortTeamLabel(homeLabel) : '';
    const nhlMlb = isNhlOrMlb(pick, g);
    const bookNote = nhlMlb
      ? spreadHasPlus15Band(g.spread)
        ? ' · +1.5'
        : ' · ML'
      : '';
    const awayHead =
      escapeHtml(shortTeamLabel(awayLabel)) +
      (awayLine != null && awayLine !== '' ? ` ${fmtSpreadLine(awayLine)}` : '');
    const homeHead =
      escapeHtml(shortTeamLabel(homeLabel)) +
      (homeLine != null && homeLine !== '' ? ` ${fmtSpreadLine(homeLine)}` : '');
    const ratioHtml =
      awaySum + homeSum > 0
        ? `<div class="liq-ratio ${tier ? `liq-ratio-${tier}` : 'liq-ratio-flat'}" title="Ratio of summed top-3 $ at main line${bookNote}">${ratio.toFixed(1)}×${
            heavyName ? ' ' + escapeHtml(heavyName) : ''
          }</div>`
        : '';
    // Color # only for top-10 OI (1–3 hot, 4–10 warm) — not by book skew.
    const rankNum = g.rank != null ? Number(g.rank) : NaN;
    let rankCls = 'liq-rank';
    if (Number.isFinite(rankNum) && rankNum >= 1 && rankNum <= 10) {
      rankCls = rankNum <= 3 ? 'liq-rank liq-rank-hot' : 'liq-rank liq-rank-warm';
    }
    const awayWrap = heavy === 'away' && tier ? `liq-side-wrap is-heavy liq-sum-${tier}` : 'liq-side-wrap';
    const homeWrap = heavy === 'home' && tier ? `liq-side-wrap is-heavy liq-sum-${tier}` : 'liq-side-wrap';
    return {
      rowClass: tier ? 'liq-row-skew' : '',
      cells:
        `<td class="col-liq ${cls}">` +
        `<div class="liq-headrow"><span class="${rankCls}">#${g.rank != null ? g.rank : '—'}</span>` +
        `<span class="meta">${fmtUsdCompact(g.openInterest)}${bookNote ? `<span class="meta">${bookNote}</span>` : ''}</span></div>` +
        `<div class="liq-top-pair">` +
        `<div class="${awayWrap}"><div class="meta">${awayHead}</div>${renderTop3Levels(awayTop, homeTop)}</div>` +
        `<div class="${homeWrap}"><div class="meta">${homeHead}</div>${renderTop3Levels(homeTop, awayTop)}</div>` +
        `</div>${ratioHtml}</td>`,
    };
  }

  /** Combined 4C+NV top-3 $ ratio — only when both venues have books. */
  function renderCombinedRatioCell(pick) {
    const a4 = venueSideSums(pick, liqStore);
    const an = venueSideSums(pick, novigStore);
    const has4 = a4 && a4.awaySum + a4.homeSum > 0;
    const hasN = an && an.awaySum + an.homeSum > 0;
    const c = combinedSideSums(pick);
    if (!c) {
      let why = '—';
      if (has4 && !hasN) why = '4C only';
      else if (!has4 && hasN) why = 'NV only';
      return {
        rowClass: '',
        cells: `<td class="col-liq col-combined"><span class="meta" title="Combined ratio needs both 4C and NV">${why}</span></td>`,
      };
    }
    const tier = ratioTier(c.ratio);
    const heavyName =
      c.heavy === 'away'
        ? shortTeamLabel(c.awayLabel)
        : c.heavy === 'home'
          ? shortTeamLabel(c.homeLabel)
          : '';
    const parts = [];
    if (c.r4 != null) parts.push(`4C ${c.r4.toFixed(1)}×`);
    if (c.rN != null) parts.push(`NV ${c.rN.toFixed(1)}×`);
    return {
      rowClass: tier ? 'liq-row-skew' : '',
      cells:
        `<td class="col-liq col-combined">` +
        `<div class="liq-ratio ${tier ? `liq-ratio-${tier}` : 'liq-ratio-flat'}" title="4C+NV summed top-3 $ ratio">${c.ratio.toFixed(1)}×${
          heavyName ? ' ' + escapeHtml(heavyName) : ''
        }</div>` +
        (parts.length
          ? `<div class="liq-combined-meta meta">${parts.map(escapeHtml).join(' · ')}</div>`
          : '') +
        `<div class="meta">${fmtUsdCompact(c.awaySum)} / ${fmtUsdCompact(c.homeSum)}</div>` +
        `</td>`,
    };
  }

  function syncLiqVenue() {
    const table = document.querySelector('.picks-table');
    if (table) {
      table.classList.remove('liq-venue-both', 'liq-venue-4c', 'liq-venue-novig');
      table.classList.add('liq-venue-' + liqVenue);
    }
    document.querySelectorAll('.liq-venue-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-venue') === liqVenue);
    });
  }

  function renderAll() {
    const marketPicks = picksForMarket(activeMarket);
    const aggs = summarize(marketPicks);
    const updated = store.updatedAt
      ? 'Updated ' + new Date(store.updatedAt).toLocaleString()
      : marketPicks.length
        ? `${marketPicks.length} ${marketLabel(activeMarket)} picks`
        : 'No data yet';
    $('#updated-at').textContent = updated;
    const bookHint = $('#book-hint');
    if (bookHint) {
      bookHint.textContent = activeMarket === 'ml' ? 'ML book · separate from ATS' : 'ATS book · separate from ML';
    }
    const chartTitle = $('#chart-title');
    if (chartTitle) chartTitle.textContent = `${marketLabel(activeMarket)} $ equity`;
    const picksTitle = $('#picks-title');
    if (picksTitle) picksTitle.textContent = `${marketLabel(activeMarket)} picks`;
    renderMarketTabs();
    renderDayStats();
    renderCards(aggs);
    renderChart();
    renderTable();
  }

  function normalizeStore(raw) {
    if (!raw || typeof raw !== 'object') return { updatedAt: null, picks: [] };
    if (Array.isArray(raw)) return { updatedAt: null, picks: raw };
    return {
      updatedAt: raw.updatedAt || null,
      picks: Array.isArray(raw.picks) ? raw.picks : [],
    };
  }

  // ——— ESPN live grade (browser) — settle open picks as soon as ESPN marks FINAL ———
  const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports';
  const ESPN_SPORT = {
    NFL: { path: 'football/nfl', q: '' },
    NCAAF: { path: 'football/college-football', q: '&groups=80&limit=400' },
    CFB: { path: 'football/college-football', q: '&groups=80&limit=400' },
    NBA: { path: 'basketball/nba', q: '' },
    NCAAB: { path: 'basketball/mens-college-basketball', q: '&groups=50&limit=400' },
    CBB: { path: 'basketball/mens-college-basketball', q: '&groups=50&limit=400' },
    NHL: { path: 'hockey/nhl', q: '' },
    MLB: { path: 'baseball/mlb', q: '' },
    WNBA: { path: 'basketball/wnba', q: '' },
  };
  const ESPN_ALIASES = {
    'n y giants': 'new york giants',
    'ny giants': 'new york giants',
    'n y jets': 'new york jets',
    'l a clippers': 'los angeles clippers',
    'la clippers': 'los angeles clippers',
    'l a lakers': 'los angeles lakers',
    'la lakers': 'los angeles lakers',
    'ut martin': 'tennessee martin',
    'cs fullerton': 'cal state fullerton',
    'ul lafayette': 'louisiana',
    'miami ohio': 'miami oh',
    'illinois chicago': 'uic',
    'middle tennessee st': 'middle tennessee',
    'unc greensboro': 'north carolina greensboro',
    mississippi: 'ole miss',
    'ole miss': 'ole miss',
    olemiss: 'ole miss',
    'appalachian state': 'app state',
    'app state': 'app state',
    ipfw: 'purdue fort wayne',
    'fort wayne': 'purdue fort wayne',
    'se missouri state': 'southeast missouri',
    'se missouri': 'southeast missouri',
    'southeast missouri state': 'southeast missouri',
    umkc: 'kansas city',
    'kansas city': 'kansas city',
    'kennesaw state': 'kennesaw',
    'elon university': 'elon',
    'tarleton state': 'tarleton',
    vmi: 'vmi',
    'virginia military': 'vmi',
  };
  const ESPN_FILLER = { state: 1, university: 1, univ: 1, college: 1, tech: 1, the: 1 };
  const _espnBoardCache = Object.create(null);
  let _espnGradeInFlight = false;

  function espnCanon(s) {
    let t = String(s || '')
      .toLowerCase()
      .replace(/[\u2018\u2019']/g, '')
      .replace(/&/g, ' and ')
      .replace(/\./g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(university|univ|the|saint|st)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (ESPN_ALIASES[t]) t = ESPN_ALIASES[t];
    return t;
  }

  function espnCompact(s) {
    return espnCanon(s).replace(/\s+/g, '');
  }

  function espnTeamKeys(team) {
    if (!team) return [];
    return [
      team.shortDisplayName,
      team.location,
      team.displayName,
      team.name,
      team.abbreviation,
      team.nickname,
    ]
      .filter(Boolean)
      .map(espnCanon);
  }

  function espnNameHit(needles, keys) {
    let raw = espnCanon(needles);
    const need = raw.split(' ').filter((t) => t.length > 1 && t !== 'vs' && t !== 'at' && t !== 'and');
    if (!need.length) return false;
    const keyed = (keys || []).map((k) => ESPN_ALIASES[k] || k);
    const hay = keyed.join(' ');
    const hayC = espnCompact(hay);
    const needleC = espnCompact(raw);
    if (needleC && hayC.indexOf(needleC) >= 0) return true;
    if (hayC && needleC.indexOf(hayC) >= 0 && hayC.length >= 4) return true;
    let hits = 0;
    for (let i = 0; i < need.length; i++) {
      if (hay.indexOf(need[i]) >= 0 || hayC.indexOf(need[i]) >= 0) hits++;
    }
    if (hits >= Math.min(2, need.length) || (need.length === 1 && hits === 1)) return true;
    // Soft: ESPN short labels ("App State") ↔ full OL names ("Appalachian State")
    for (let k = 0; k < keyed.length; k++) {
      const ktAll = String(keyed[k] || '')
        .split(' ')
        .filter((t) => t.length > 1 && t !== 'vs' && t !== 'at' && t !== 'and');
      if (!ktAll.length) continue;
      const kt = ktAll.filter((t) => !ESPN_FILLER[t]);
      const use = kt.length ? kt : ktAll;
      let ok = true;
      for (let i = 0; i < use.length; i++) {
        const tok = use[i];
        let aligned = false;
        for (let j = 0; j < need.length; j++) {
          const nt = need[j];
          if (nt === tok || (tok.length >= 3 && (nt.indexOf(tok) === 0 || tok.indexOf(nt) === 0))) {
            aligned = true;
            break;
          }
          if (tok.length >= 3 && needleC.indexOf(tok) >= 0) {
            aligned = true;
            break;
          }
        }
        if (!aligned) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  function sportConfOf(pick) {
    const sport = String(pick.sport || '').toUpperCase().trim();
    if (ESPN_SPORT[sport]) return ESPN_SPORT[sport];
    const league = String(pick.league || '').toUpperCase();
    const keys = Object.keys(ESPN_SPORT).sort((a, b) => b.length - a.length);
    for (let i = 0; i < keys.length; i++) {
      if (league.indexOf(keys[i]) >= 0) return ESPN_SPORT[keys[i]];
    }
    if (/COLLEGE FOOTBALL|NCAAF|^CFB/.test(league)) return ESPN_SPORT.NCAAF;
    if (/COLLEGE BASKETBALL|NCAAB|CBB/.test(league)) return ESPN_SPORT.NCAAB;
    return null;
  }

  function ymdsForPick(pick) {
    const out = [];
    const pushIso = (iso) => {
      if (!iso) return;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return;
      const fmt = (x) =>
        '' +
        x.getUTCFullYear() +
        String(x.getUTCMonth() + 1).padStart(2, '0') +
        String(x.getUTCDate()).padStart(2, '0');
      out.push(fmt(d), fmt(new Date(d.getTime() - 86400000)), fmt(new Date(d.getTime() + 86400000)));
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(d);
        const y = parts.find((p) => p.type === 'year').value;
        const m = parts.find((p) => p.type === 'month').value;
        const day = parts.find((p) => p.type === 'day').value;
        const et = '' + y + m + day;
        out.push(et);
        const etDate = new Date(Date.UTC(Number(y), Number(m) - 1, Number(day)));
        out.push(fmt(new Date(etDate.getTime() - 86400000)), fmt(new Date(etDate.getTime() + 86400000)));
      } catch (_) {
        /* ignore */
      }
    };
    pushIso(pick.startAt);
    pushIso(pick.loggedAt);
    pushIso(new Date().toISOString());
    const seen = Object.create(null);
    const res = [];
    for (let i = 0; i < out.length; i++) {
      if (!seen[out[i]]) {
        seen[out[i]] = 1;
        res.push(out[i]);
      }
    }
    return res;
  }

  function profitFromResult(result, american) {
    if (result === 'P') return 0;
    if (result === 'L') return -1;
    let a = Number(american);
    if (!Number.isFinite(a) || a === 0) a = -110;
    if (a > 0) return Math.round((a / 100) * 10000) / 10000;
    return Math.round((100 / Math.abs(a)) * 10000) / 10000;
  }

  function gradeTakeResult(pick, awayScore, homeScore) {
    const a = Number(awayScore);
    const h = Number(homeScore);
    if (!Number.isFinite(a) || !Number.isFinite(h)) return null;
    const pickIsAway = String(pick.takeSide || pick.side || '').toLowerCase() === 'away';
    const pickScore = pickIsAway ? a : h;
    const oppScore = pickIsAway ? h : a;
    if (marketOf(pick) === 'spread') {
      const line = Number(pick.line);
      if (!Number.isFinite(line)) return null;
      const margin = pickScore + line - oppScore;
      if (margin > 0) return 'W';
      if (margin < 0) return 'L';
      return 'P';
    }
    if (pickScore > oppScore) return 'W';
    if (pickScore < oppScore) return 'L';
    return 'P';
  }

  function parseEspnFinal(ev) {
    const comp = (ev && ev.competitions && ev.competitions[0]) || null;
    if (!comp) return null;
    const st = (comp.status && comp.status.type) || {};
    const name = String(st.name || st.description || '').toUpperCase();
    const completed =
      st.completed === true || name === 'STATUS_FINAL' || name === 'STATUS_FULL_TIME';
    if (!completed) return null;
    const teams = comp.competitors || [];
    let away = null;
    let home = null;
    for (let i = 0; i < teams.length; i++) {
      const t = teams[i];
      if (!t) continue;
      if (t.homeAway === 'away') away = t;
      if (t.homeAway === 'home') home = t;
    }
    if (!away || !home) return null;
    const as = Number(away.score);
    const hs = Number(home.score);
    if (!Number.isFinite(as) || !Number.isFinite(hs)) return null;
    return {
      away: as,
      home: hs,
      eventId: String(ev.id || ''),
      awayName: (away.team && away.team.displayName) || '',
      homeName: (home.team && home.team.displayName) || '',
      awayKeys: espnTeamKeys(away.team),
      homeKeys: espnTeamKeys(home.team),
      detail: st.detail || st.description || 'Final',
    };
  }

  async function fetchEspnBoard(conf, ymd) {
    const key = conf.path + '|' + ymd;
    const hit = _espnBoardCache[key];
    if (hit && Date.now() - hit.at < 45000) return hit.data;
    const url = ESPN_SITE + '/' + conf.path + '/scoreboard?dates=' + ymd + (conf.q || '');
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      _espnBoardCache[key] = { at: Date.now(), data: null };
      return null;
    }
    const data = await res.json();
    _espnBoardCache[key] = { at: Date.now(), data: data };
    return data;
  }

  async function findEspnFinal(pick) {
    const conf = sportConfOf(pick);
    if (!conf) return null;
    const away = String(pick.away || '');
    const home = String(pick.home || '');
    const ymds = ymdsForPick(pick);
    for (let i = 0; i < ymds.length; i++) {
      const board = await fetchEspnBoard(conf, ymds[i]);
      const events = (board && board.events) || [];
      for (let j = 0; j < events.length; j++) {
        const parsed = parseEspnFinal(events[j]);
        if (!parsed) continue;
        const fwd = espnNameHit(away, parsed.awayKeys) && espnNameHit(home, parsed.homeKeys);
        const rev = espnNameHit(away, parsed.homeKeys) && espnNameHit(home, parsed.awayKeys);
        if (!fwd && !rev) continue;
        if (rev && !fwd) {
          return {
            away: parsed.home,
            home: parsed.away,
            eventId: parsed.eventId,
            awayName: parsed.homeName,
            homeName: parsed.awayName,
            detail: parsed.detail,
          };
        }
        return parsed;
      }
    }
    return null;
  }

  function isOpenPick(pick) {
    const r = String((pick && pick.result) || '').toUpperCase();
    return r !== 'W' && r !== 'L' && r !== 'P';
  }

  function applyEspnGrade(pick, fin) {
    if (marketOf(pick) === 'spread' && (pick.line == null || pick.line === '')) return false;
    const result = gradeTakeResult(pick, fin.away, fin.home);
    if (!result) return false;
    pick.result = result;
    pick.profit = profitFromResult(result, pick.price);
    pick.awayScore = fin.away;
    pick.homeScore = fin.home;
    pick.gradedAt = new Date().toISOString();
    pick.gradeSource = 'espn';
    pick.gradeDetail = fin.detail || 'Final';
    if (fin.eventId) pick.espnEventId = fin.eventId;
    if (fin.awayName) pick.espnAway = fin.awayName;
    if (fin.homeName) pick.espnHome = fin.homeName;
    return true;
  }

  async function gradeOpenPicksFromEspn() {
    if (_espnGradeInFlight || !store || !Array.isArray(store.picks)) return 0;
    _espnGradeInFlight = true;
    let graded = 0;
    try {
      const now = Date.now();
      const open = store.picks.filter((p) => {
        if (!p || !isOpenPick(p)) return false;
        const start = parseStartMs(p);
        if (start != null && start > now + 5 * 60 * 1000) return false;
        return !!sportConfOf(p);
      });
      for (let i = 0; i < open.length; i++) {
        const pick = open[i];
        try {
          const fin = await findEspnFinal(pick);
          if (!fin) continue;
          if (applyEspnGrade(pick, fin)) graded++;
        } catch (_) {
          /* keep going */
        }
      }
      if (graded) {
        store.updatedAt = new Date().toISOString();
        renderAll();
      }
    } finally {
      _espnGradeInFlight = false;
    }
    return graded;
  }

  function applyLiquidityPayload(raw, venue) {
    if (!raw || typeof raw !== 'object') return;
    const next = {
      updatedAt: raw.updatedAt || null,
      games: Array.isArray(raw.games) ? raw.games : [],
      error: raw.error || null,
    };
    if (venue === 'novig') novigStore = next;
    else liqStore = next;
    if (store && store.picks && store.picks.length) renderAll();
  }

  async function loadLiquidityRemote() {
    const stamp = Date.now();
    try {
      const res = await fetch('./data/liquidity.json?t=' + stamp, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applyLiquidityPayload(await res.json(), '4c');
    } catch (_) {
      liqStore = {
        updatedAt: null,
        games: [],
        error: 'liquidity.json not loaded yet',
      };
    }
    try {
      const res = await fetch('./data/novig_liquidity.json?t=' + stamp, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      applyLiquidityPayload(await res.json(), 'novig');
    } catch (_) {
      novigStore = {
        updatedAt: null,
        games: [],
        error: 'novig_liquidity.json not loaded yet',
      };
    }
  }

  async function loadTrustRemote() {
    const stamp = Date.now();
    try {
      const res = await fetch('./data/liq_trust.json?t=' + stamp, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = await res.json();
      trustStore = {
        updatedAt: raw && raw.updatedAt ? raw.updatedAt : null,
        summary: (raw && raw.summary) || { all: null, '4c': null, novig: null },
        signals: Array.isArray(raw && raw.signals) ? raw.signals : [],
      };
      renderTrustStats();
    } catch (_) {
      trustStore = {
        updatedAt: null,
        summary: { all: null, '4c': null, novig: null },
        signals: [],
      };
      renderTrustStats();
    }
  }

  async function loadRemote() {
    const url = './data/picks.json?t=' + Date.now();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    store = normalizeStore(await res.json());
    renderAll();
    // Grade finals immediately from ESPN (do not wait for OddsLogic / GH Action).
    gradeOpenPicksFromEspn().catch(() => {});
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'picks.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        store = normalizeStore(JSON.parse(String(reader.result || '{}')));
        renderAll();
      } catch (e) {
        alert('Invalid JSON: ' + (e && e.message));
      }
    };
    reader.readAsText(file);
  }

  $('#btn-refresh').addEventListener('click', () => {
    loadRemote().catch((e) => alert('Refresh failed: ' + (e && e.message)));
  });
  $('#btn-export').addEventListener('click', exportJson);
  $('#file-import').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importFile(f);
    e.target.value = '';
  });
  $('#chart-bucket').addEventListener('change', () => {
    activeCard = $('#chart-bucket').value;
    renderAll();
  });
  ['filter-bucket', 'filter-result'].forEach((id) => {
    $('#' + id).addEventListener('input', () => {
      renderTable();
    });
    $('#' + id).addEventListener('change', () => {
      renderTable();
    });
  });

  document.querySelectorAll('th.th-sort').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.getAttribute('data-sort');
      if (!key) return;
      if (tableSort.key === key) {
        tableSort.dir = tableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        tableSort.key = key;
        // 4C/NV: highest top-3 $ ratio first. Start: upcoming-first.
        tableSort.dir = key === 'rank' || key === 'novigRank' || key === 'combinedRank' ? 'desc' : 'asc';
      }
      renderTable();
    });
  });

  loadRemote().catch(() => {
    store = { updatedAt: null, picks: [] };
    renderAll();
  });

  // Persist poll + ESPN settle — every 30s so UI flips as soon as ESPN is FINAL.
  setInterval(() => {
    loadRemote().catch(() => {});
  }, 30000);
  setInterval(() => {
    gradeOpenPicksFromEspn().catch(() => {});
  }, 20000);

  let _chartMqTimer = 0;
  if (window.matchMedia) {
    const mq = window.matchMedia('(max-width: 720px)');
    const onMq = () => {
      if (_chartMqTimer) clearTimeout(_chartMqTimer);
      _chartMqTimer = setTimeout(() => {
        _chartMqTimer = 0;
        if (store && store.picks) renderChart();
      }, 120);
    };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  }
})();
