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
  let chart;
  let activeCard = 'all';
  let activeMarket = 'spread'; // ATS book by default; ML is a separate ledger

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

  function fmtRoi(agg) {
    if (!agg.graded) return '—';
    const roi = (agg.profit / agg.graded) * 100;
    return (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
  }

  function fmtU(n) {
    if (!Number.isFinite(n)) return '—';
    return (n >= 0 ? '+' : '') + n.toFixed(2) + 'u';
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
      const cls = a.profit > 0 ? 'pos' : a.profit < 0 ? 'neg' : '';
      return (
        `<button type="button" class="card${activeCard === b.key ? ' is-active' : ''}" data-bucket="${b.key}">` +
        `<div class="k">${b.label}</div>` +
        `<div class="v ${cls}">${fmtRoi(a)}</div>` +
        `<div class="s">${a.graded}/${a.n} graded · ${fmtU(a.profit)}</div>` +
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
                return `${t.team} · ${t.result} ${t.profit >= 0 ? '+' : ''}${t.profit.toFixed(2)}u → ${t.cum >= 0 ? '+' : ''}${t.cum.toFixed(2)}u`;
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
              text: 'Cumulative units',
              color: '#93a0bb',
            },
            ticks: {
              color: '#c5d0e6',
              font: { size: mobile ? 12 : 11 },
              maxTicksLimit: mobile ? 5 : 8,
            },
            grid: { color: 'rgba(42,54,80,0.45)' },
            grace: '8%',
          },
        },
      },
    });
  }

  function matchesFilter(pick) {
    if (marketOf(pick) !== activeMarket) return false;
    const bucket = $('#filter-bucket').value;
    const result = $('#filter-result').value;
    const q = ($('#filter-q').value || '').trim().toLowerCase();
    if (bucket === 'fav' || bucket === 'dog') {
      if (!bucketKeysFor(pick).includes(bucket)) return false;
    } else if (bucket && !bucketKeysFor(pick).includes(bucket)) return false;
    const r = String(pick.result || '').toUpperCase();
    if (result === 'open' && (r === 'W' || r === 'L' || r === 'P')) return false;
    if (result && result !== 'open' && r !== result) return false;
    if (q) {
      const hay = [pick.away, pick.home, pick.takeTeam, pick.league, pick.sport, pick.bucket, pick.market]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  const ET = 'America/New_York';

  const MONTHS = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };

  function fmtEtTime(ms) {
    return new Date(ms).toLocaleTimeString('en-US', {
      timeZone: ET,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }

  function fmtEtDay(ms) {
    return new Date(ms).toLocaleDateString('en-US', {
      timeZone: ET,
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
  }

  function fmtEtDateTime(ms) {
    return new Date(ms).toLocaleString('en-US', {
      timeZone: ET,
      month: 'numeric',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }

  /** Convert America/New_York wall clock → UTC epoch ms. */
  function etWallToMs(year, month, day, hour, minute) {
    const want = Date.UTC(year, month, day, hour, minute);
    let guess = want;
    for (let i = 0; i < 3; i++) {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: ET,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
          .formatToParts(new Date(guess))
          .filter((p) => p.type !== 'literal')
          .map((p) => [p.type, p.value])
      );
      const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute)
      );
      guess += want - asUtc;
    }
    return guess;
  }

  /** Resolve tip epoch: kickMs, else league day + kick (ET / UTC heuristics). */
  function parseKickMs(p) {
    if (p && p.kickMs != null && Number.isFinite(Number(p.kickMs))) {
      const n = Number(p.kickMs);
      if (n > 1e11 && n < 1e15) return n;
    }

    const kick = String((p && p.kick) || '').trim();
    const league = String((p && p.league) || '');
    const dayMatch = league.match(
      /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/i
    );
    if (!dayMatch || !kick) return null;

    let hours = null;
    let minutes = null;
    let asUtc = false;
    const ampm = kick.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)(?:\s*[A-Z]{2,5})?$/i);
    if (ampm) {
      hours = Number(ampm[1]) % 12;
      if (/pm/i.test(ampm[3])) hours += 12;
      minutes = Number(ampm[2]);
      asUtc = false; // already a civil clock — treat as Eastern
    } else {
      const hm = kick.match(/^(\d{1,2}):(\d{2})$/);
      if (hm) {
        hours = Number(hm[1]);
        minutes = Number(hm[2]);
        // Bare HH:MM from OddsLogic is UTC
        asUtc = true;
      }
    }
    if (hours == null || minutes == null) return null;

    const month = MONTHS[String(dayMatch[1]).toLowerCase()];
    const day = Number(dayMatch[2]);
    if (month == null || !Number.isFinite(day)) return null;

    const anchor = p.loggedAt ? new Date(p.loggedAt) : new Date();
    let year = anchor.getUTCFullYear();
    const anchorMonth = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'numeric' }).format(anchor)
    ) - 1;
    if (month === 0 && anchorMonth === 11) year += 1;
    if (month === 11 && anchorMonth === 0) year -= 1;

    const ms = asUtc
      ? Date.UTC(year, month, day, hours, minutes, 0, 0)
      : etWallToMs(year, month, day, hours, minutes);
    return Number.isFinite(ms) ? ms : null;
  }

  /** 0 = upcoming, 1 = live / started (ungraded), 2 = graded / ended. */
  function pickTimeBucket(p, now) {
    const r = String((p && p.result) || '').toUpperCase();
    if (r === 'W' || r === 'L' || r === 'P') return 2;
    const ms = parseKickMs(p);
    if (ms == null) return 1;
    return ms > now ? 0 : 1;
  }

  function comparePicksByStart(a, b, now) {
    const ba = pickTimeBucket(a, now);
    const bb = pickTimeBucket(b, now);
    if (ba !== bb) return ba - bb;
    const ma = parseKickMs(a);
    const mb = parseKickMs(b);
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

  /** Game start in US Eastern. */
  function fmtGameStart(p) {
    const ms = parseKickMs(p);
    if (ms != null) {
      return { main: fmtEtTime(ms), sub: fmtEtDay(ms) };
    }
    const kick = String((p && p.kick) || '').trim();
    if (kick) {
      return {
        main: /EST|EDT/i.test(kick) ? kick : kick + ' ET',
        sub: '',
      };
    }
    if (p && p.loggedAt) {
      return { main: fmtEtDateTime(new Date(p.loggedAt).getTime()), sub: 'logged' };
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
      .sort((a, b) => comparePicksByStart(a, b, now));
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
        const profit =
          r === 'W' || r === 'L' || r === 'P'
            ? fmtU(Number(p.profit) || (r === 'L' ? -1 : 0))
            : '—';
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
          `<td class="col-pick"><span class="pill ${rolePill}">${escapeHtml(role || '—')}</span> ${escapeHtml(p.takeTeam || p.takeSide || '')}<div class="meta lean-mobile">${lean}</div></td>` +
          `<td class="col-book"><span class="pill ${mktPill}">${marketLabel(mkt)}</span><div class="meta">${lean}</div></td>` +
          `<td class="col-line">${escapeHtml(line)}<div class="meta">${escapeHtml(src)}</div></td>` +
          `<td class="col-result"><span class="pill ${resPill}">${r || 'OPEN'}</span><div class="meta profit-inline">${profit}</div>${p.gradeSource ? `<div class="meta grade-src">${escapeHtml(p.gradeSource)}</div>` : ''}</td>` +
          `<td class="col-profit">${profit}</td>` +
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

  function renderAll() {
    const marketPicks = picksForMarket(activeMarket);
    const aggs = summarize(marketPicks);
    const updated = store.updatedAt
      ? 'Updated ' + fmtEtDateTime(new Date(store.updatedAt).getTime())
      : marketPicks.length
        ? `${marketPicks.length} ${marketLabel(activeMarket)} picks`
        : 'No data yet';
    $('#updated-at').textContent = updated;
    const bookHint = $('#book-hint');
    if (bookHint) {
      bookHint.textContent = activeMarket === 'ml' ? 'ML book · separate from ATS' : 'ATS book · separate from ML';
    }
    const chartTitle = $('#chart-title');
    if (chartTitle) chartTitle.textContent = `${marketLabel(activeMarket)} ROI equity`;
    const picksTitle = $('#picks-title');
    if (picksTitle) picksTitle.textContent = `${marketLabel(activeMarket)} picks`;
    renderMarketTabs();
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

  async function loadRemote() {
    const url = './data/picks.json?t=' + Date.now();
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    store = normalizeStore(await res.json());
    renderAll();
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
  ['filter-bucket', 'filter-result', 'filter-q'].forEach((id) => {
    $('#' + id).addEventListener('input', renderTable);
    $('#' + id).addEventListener('change', renderTable);
  });

  loadRemote().catch(() => {
    store = { updatedAt: null, picks: [] };
    renderAll();
  });

  setInterval(() => {
    loadRemote().catch(() => {});
  }, 60000);

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
