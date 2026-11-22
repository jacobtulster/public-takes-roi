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

  const $ = (sel) => document.querySelector(sel);

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
    return store.picks
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
      });
    });
    return { labels, cumArr, pos, neg, tips };
  }

  function renderChart() {
    const bucket = $('#chart-bucket').value || 'all';
    const { labels, cumArr, pos, neg, tips } = equitySeries(bucket);
    const ctx = $('#equity-chart');
    if (chart) chart.destroy();
    if (!labels.length) {
      chart = new Chart(ctx, {
        type: 'line',
        data: { labels: ['—'], datasets: [] },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            title: { display: true, text: 'No graded picks yet', color: '#93a0bb' },
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
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.15,
            borderWidth: 2,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: '#93a0bb', filter: (item) => item.text === 'Equity' },
          },
          tooltip: {
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
            title: { display: true, text: 'Graded pick #', color: '#93a0bb' },
            ticks: { color: '#93a0bb' },
            grid: { color: 'rgba(42,54,80,0.45)' },
          },
          y: {
            title: { display: true, text: 'Cumulative units', color: '#93a0bb' },
            ticks: { color: '#93a0bb' },
            grid: { color: 'rgba(42,54,80,0.45)' },
            grace: '8%',
          },
        },
      },
    });
  }

  function matchesFilter(pick) {
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
      const hay = [pick.away, pick.home, pick.takeTeam, pick.league, pick.sport, pick.bucket]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderTable() {
    const body = $('#picks-body');
    const rows = store.picks
      .slice()
      .sort((a, b) => String(b.loggedAt || '').localeCompare(String(a.loggedAt || '')))
      .filter(matchesFilter);
    $('#picks-empty').hidden = rows.length > 0;
    body.innerHTML = rows
      .map((p) => {
        const r = String(p.result || '').toUpperCase();
        const role = String(p.takeRole || '').toUpperCase();
        const rolePill = role === 'DOG' ? 'pill-dog' : 'pill-fav';
        const resPill =
          r === 'W' ? 'pill-w' : r === 'L' ? 'pill-l' : r === 'P' ? 'pill-p' : 'pill-open';
        const line =
          p.market === 'spread'
            ? `${p.line != null ? p.line : '—'} (${p.price != null ? p.price : '—'})`
            : p.price != null
              ? String(p.price)
              : '—';
        const when = p.loggedAt ? new Date(p.loggedAt).toLocaleString() : '—';
        const profit =
          r === 'W' || r === 'L' || r === 'P'
            ? fmtU(Number(p.profit) || (r === 'L' ? -1 : 0))
            : '—';
        return (
          `<tr>` +
          `<td>${when}</td>` +
          `<td>${escapeHtml(p.away || '?')} @ ${escapeHtml(p.home || '?')}<div class="meta">${escapeHtml(p.league || p.sport || '')}</div></td>` +
          `<td><span class="pill ${rolePill}">${escapeHtml(role || '—')}</span> ${escapeHtml(p.takeTeam || p.takeSide || '')}</td>` +
          `<td>${escapeHtml(p.bucket || '')}<div class="meta">${escapeHtml(p.ocLean || '')}</div></td>` +
          `<td>${escapeHtml(line)}<div class="meta">${escapeHtml(p.lineSource || p.lineBook || '')}</div></td>` +
          `<td><span class="pill ${resPill}">${r || 'OPEN'}</span>${p.gradeSource ? `<div class="meta">${escapeHtml(p.gradeSource)}</div>` : ''}</td>` +
          `<td>${profit}</td>` +
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

  function renderAll() {
    const aggs = summarize(store.picks || []);
    const updated = store.updatedAt
      ? 'Updated ' + new Date(store.updatedAt).toLocaleString()
      : (store.picks || []).length
        ? `${store.picks.length} picks`
        : 'No data yet';
    $('#updated-at').textContent = updated;
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
})();
