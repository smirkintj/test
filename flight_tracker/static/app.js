'use strict';

// ── State ──
let currentMode = 'oneway';
let currentJobId = null;
let pollTimer = null;
let trendChart = null;
let allFlights = [];
let sortState = { col: 'price', dir: 'asc' };
let budgetLimit = 0;

// ── Boot ──
document.addEventListener('DOMContentLoaded', () => {
  setDefaultDates();
  bindModes();
  bindSwaps();
  bindForms();
  bindTableSort();
  bindTableFilter();
  bindAlertForm();
  loadHistoryPreview();
  loadAlerts();
});

// ── Dates ──
function setDefaultDates() {
  const today = isoDate(new Date());
  const twoWeeks = isoDate(addDays(new Date(), 14));
  const oneMonth = isoDate(addDays(new Date(), 30));
  setVal('ow-datefrom', today);
  setVal('ow-dateto', twoWeeks);
  setVal('bw-searchfrom', today);
  setVal('bw-searchto', oneMonth);
  setVal('cmp-datefrom', today);
  setVal('cmp-dateto', twoWeeks);
}

// ── Mode switching ──
function bindModes() {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentMode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.search-form').forEach(f => f.classList.add('hidden'));
      document.getElementById('form-' + currentMode).classList.remove('hidden');
      hideAllResults();
    });
  });
}

function hideAllResults() {
  ['results-oneway', 'results-bestwindow', 'results-compare', 'progress-card'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
}

// ── Swaps ──
function bindSwaps() {
  document.querySelectorAll('.swap-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = document.getElementById(btn.dataset.a);
      const b = document.getElementById(btn.dataset.b);
      if (a && b) [a.value, b.value] = [b.value, a.value];
    });
  });
}

// ── Forms ──
function bindForms() {
  document.getElementById('form-oneway').addEventListener('submit', e => { e.preventDefault(); startOneWay(); });
  document.getElementById('form-bestwindow').addEventListener('submit', e => { e.preventDefault(); startBestWindow(); });
  document.getElementById('form-compare').addEventListener('submit', e => { e.preventDefault(); startCompare(); });
}

// ── One-Way Search ──
async function startOneWay() {
  budgetLimit = parseInt(getVal('ow-budget')) || 0;
  const payload = {
    from_airport: getVal('ow-from'),
    to_airport: getVal('ow-to'),
    date_from: getVal('ow-datefrom'),
    date_to: getVal('ow-dateto'),
    seat_class: getVal('ow-seat'),
    currency: 'USD',
  };
  await startJob('/api/search', payload, 'oneway');
}

// ── Best Window ──
async function startBestWindow() {
  const payload = {
    from_airport: getVal('bw-from'),
    to_airport: getVal('bw-to'),
    search_from: getVal('bw-searchfrom'),
    search_to: getVal('bw-searchto'),
    trip_days: parseInt(getVal('bw-nights')) || 7,
    seat_class: getVal('bw-seat'),
    currency: 'USD',
  };
  await startJob('/api/best-window', payload, 'bestwindow');
}

// ── Compare ──
async function startCompare() {
  const tos = [...document.querySelectorAll('.cmp-to')]
    .map(i => i.value.trim().toUpperCase())
    .filter(Boolean);
  const payload = {
    from_airport: getVal('cmp-from'),
    to_airports: tos,
    date_from: getVal('cmp-datefrom'),
    date_to: getVal('cmp-dateto'),
    seat_class: getVal('cmp-seat'),
    currency: 'USD',
  };
  await startJob('/api/compare', payload, 'compare');
}

// ── Generic job starter ──
async function startJob(endpoint, payload, mode) {
  stopPolling();
  hideAllResults();
  setSearchBtnState(true);

  try {
    const res = await post(endpoint, payload);
    currentJobId = res.search_id;
    showProgress();
    updateProgress(0, res.total_dates || res.windows_to_check || 1, 'Starting…');
    startPolling(mode);
  } catch (err) {
    alert('Error: ' + err.message);
    setSearchBtnState(false);
  }
}

function setSearchBtnState(loading) {
  document.querySelectorAll('.search-btn').forEach(btn => {
    btn.disabled = loading;
    btn.textContent = loading ? 'Searching…' : btn.dataset.original || btn.textContent;
  });
}

// ── Polling ──
function startPolling(mode) {
  const statusUrl = {
    oneway:     `/api/search/${currentJobId}/status`,
    bestwindow: `/api/best-window/${currentJobId}/status`,
    compare:    `/api/compare/${currentJobId}/status`,
  }[mode];

  pollTimer = setInterval(async () => {
    try {
      const data = await get(statusUrl);
      updateProgress(data.completed_dates, data.total_dates, `${data.completed_dates} / ${data.total_dates} done`);
      if (data.status === 'done' || data.status === 'error') {
        stopPolling();
        setSearchBtnState(false);
        hideProgress();
        if (data.status === 'done') await loadResults(mode);
        else alert('Search failed: ' + (data.error_message || 'Unknown error'));
      }
    } catch {}
  }, 2000);
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ── Progress ──
function showProgress() { show('progress-card'); }
function hideProgress() { hide('progress-card'); }
function updateProgress(done, total, label) {
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-pct').textContent = pct + '%';
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-sub').textContent = `Prices from Google Flights — not airline direct`;
}

// ── Load results ──
async function loadResults(mode) {
  const urls = {
    oneway:     `/api/search/${currentJobId}/results`,
    bestwindow: `/api/best-window/${currentJobId}/results`,
    compare:    `/api/compare/${currentJobId}/results`,
  };
  const data = await get(urls[mode]);

  if (mode === 'oneway')     renderOneWayResults(data);
  if (mode === 'bestwindow') renderBestWindowResults(data);
  if (mode === 'compare')    renderCompareResults(data);

  loadHistoryPreview();
}

// ── One-Way Results ──
function renderOneWayResults(data) {
  allFlights = data.flights || [];
  show('results-oneway');

  // Stats
  const cur = allFlights[0]?.currency || 'USD';
  document.getElementById('ow-stats').innerHTML = [
    { label: 'Cheapest', value: data.min_price != null ? fmt(data.min_price, cur) : '—', cls: 'green', note: 'via Google Flights' },
    { label: 'Most Expensive', value: data.max_price != null ? fmt(data.max_price, cur) : '—', cls: 'red', note: 'via Google Flights' },
    { label: 'Flights Found', value: data.total_results, cls: '', note: '' },
    { label: 'Dates Searched', value: (data.trend || []).length, cls: '', note: '' },
  ].map(s => `
    <div class="stat">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value ${s.cls}">${s.value}</div>
      ${s.note ? `<div class="stat-note">${s.note}</div>` : ''}
    </div>`).join('');

  // Share button
  document.getElementById('share-btn').onclick = () =>
    window.open(`/api/share/${currentJobId}`, '_blank');

  renderTrendChart(data.trend || [], cur);
  renderCalendar(data.calendar || {}, data.min_price, data.max_price, cur);
  renderTable();
  loadInsights(data.from_airport, data.to_airport);
}

// ── Trend Chart ──
function renderTrendChart(trend, currency) {
  const ctx = document.getElementById('trend-chart').getContext('2d');
  if (trendChart) trendChart.destroy();
  if (!trend.length) return;

  const labels = trend.map(t => t.date.slice(5));
  const prices = trend.map(t => t.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);

  trendChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: prices,
        backgroundColor: prices.map(p =>
          p === minP ? 'rgba(34,197,94,.8)' : p === maxP ? 'rgba(239,68,68,.7)' : 'rgba(79,142,247,.55)'
        ),
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ' ' + fmt(c.parsed.y, currency) + ' · Google Flights' } }
      },
      scales: {
        x: { ticks: { color: '#6b7094', font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(37,40,57,.6)' } },
        y: { ticks: { color: '#6b7094', font: { size: 10 }, callback: v => fmt(v, currency) }, grid: { color: 'rgba(37,40,57,.6)' } }
      }
    }
  });
}

// ── Calendar ──
function renderCalendar(cal, minP, maxP, currency) {
  const el = document.getElementById('calendar');
  const dates = Object.keys(cal).sort();
  if (!dates.length) { el.innerHTML = '<p class="empty">No data</p>'; return; }

  const start = new Date(dates[0] + 'T00:00:00');
  const end = new Date(dates[dates.length - 1] + 'T00:00:00');
  const range = maxP - minP || 1;
  const days = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  let html = '<div class="cal-grid">';
  days.forEach(d => { html += `<div class="cal-head">${d}</div>`; });
  for (let i = 0; i < start.getDay(); i++) html += '<div class="cal-cell empty"></div>';

  const cur = new Date(start);
  while (cur <= end) {
    const key = isoDate(cur);
    const price = cal[key];
    let cls = 'cal-cell';
    let priceHtml = '<div class="cal-price">—</div>';
    if (price != null) {
      const ratio = (price - minP) / range;
      cls += ratio <= 0.33 ? ' cheap' : ratio >= 0.67 ? ' pricey' : '';
      priceHtml = `<div class="cal-price">${fmt(price, currency)}</div>`;
    } else {
      cls += ' nodata';
    }
    html += `<div class="${cls}"><div class="cal-date">${cur.getDate()}</div>${priceHtml}</div>`;
    cur.setDate(cur.getDate() + 1);
  }
  html += '</div>';
  el.innerHTML = html;
}

// ── Table ──
function bindTableSort() {
  document.querySelectorAll('thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      sortState.dir = sortState.col === col && sortState.dir === 'asc' ? 'desc' : 'asc';
      sortState.col = col;
      document.querySelectorAll('thead th').forEach(t => t.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderTable();
    });
  });
}

function bindTableFilter() {
  document.getElementById('airline-filter').addEventListener('input', renderTable);
  document.getElementById('stops-filter').addEventListener('change', renderTable);
}

function renderTable() {
  const airlineQ = document.getElementById('airline-filter').value.toLowerCase();
  const stopsQ = document.getElementById('stops-filter').value;

  let list = allFlights.filter(f => {
    if (airlineQ && !f.airlines.toLowerCase().includes(airlineQ)) return false;
    if (stopsQ !== '' && f.stops > parseInt(stopsQ)) return false;
    if (budgetLimit > 0 && f.price > budgetLimit) return false;
    return true;
  });

  list.sort((a, b) => {
    let va = a[sortState.col], vb = b[sortState.col];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sortState.dir === 'asc' ? cmp : -cmp;
  });

  const minP = list.length ? Math.min(...list.map(f => f.price)) : 0;
  const maxP = list.length ? Math.max(...list.map(f => f.price)) : 0;
  const cur = list[0]?.currency || 'USD';

  document.getElementById('filtered-count').textContent = list.length ? `· ${list.length} flights` : '';

  const tbody = document.getElementById('flights-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No flights match filters.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(f => {
    const cheap = f.price === minP;
    const pricey = f.price === maxP && minP !== maxP;
    const rowCls = cheap ? 'row-cheap' : pricey ? 'row-pricey' : '';
    const stopsCls = f.stops === 0 ? 'stops-direct' : f.stops === 1 ? 'stops-one' : 'stops-multi';
    const stopsLabel = f.stops === 0 ? 'Direct' : f.stops === 1 ? '1 Stop' : `${f.stops} Stops`;
    return `<tr class="${rowCls}">
      <td>${f.flight_date}</td>
      <td>${esc(f.airlines)}</td>
      <td>${f.departure_time || '—'}</td>
      <td>${f.arrival_time || '—'}</td>
      <td style="color:var(--muted)">${fmtDur(f.duration_minutes)}</td>
      <td><span class="stops-badge ${stopsCls}">${stopsLabel}</span></td>
      <td class="price-cell">${fmt(f.price, cur)}</td>
    </tr>`;
  }).join('');
}

// ── Best Window Results ──
function renderBestWindowResults(data) {
  show('results-bestwindow');
  const el = document.getElementById('windows-list');
  const windows = data.windows || [];
  if (!windows.length) { el.innerHTML = '<p class="empty">No windows found. Try expanding the date range.</p>'; return; }

  el.innerHTML = '<div class="window-list">' + windows.map((w, i) => `
    <div class="window-item ${i === 0 ? 'best' : ''}">
      <div class="window-rank">#${i + 1}</div>
      <div class="window-dates">
        <strong>${w.depart_date} → ${w.return_date}</strong>
        <div class="window-airlines">${esc(w.outbound_airline || '')} · ${esc(w.return_airline || '')}</div>
        <div class="window-source">Google Flights</div>
      </div>
      <div class="window-prices">
        <div class="window-total">$${w.total_price.toLocaleString()}</div>
        <div class="window-breakdown">Out $${w.outbound_price} + Back $${w.return_price}</div>
      </div>
    </div>`).join('') + '</div>';
}

// ── Compare Results ──
function renderCompareResults(data) {
  show('results-compare');
  const el = document.getElementById('compare-list');
  const dests = data.destinations || [];
  if (!dests.length) { el.innerHTML = '<p class="empty">No results found. Try a wider date range.</p>'; return; }

  el.innerHTML = '<div class="dest-grid">' + dests.map((d, i) => `
    <div class="dest-card ${i === 0 ? 'dest-cheapest' : ''}">
      ${i === 0 ? '<div class="dest-badge">Cheapest ✓</div>' : ''}
      <div class="dest-code">${d.to_airport}</div>
      <div class="dest-airline">${esc(d.airline)} · ${d.cheapest_date}</div>
      <div class="dest-price">$${d.cheapest_price.toLocaleString()}</div>
      <div class="dest-date">${d.currency}</div>
      <div class="dest-source">📊 Google Flights · verify before booking</div>
      <div class="dest-btns">
        <a class="dest-btn dest-btn-trip" href="${d.trip_com_url}" target="_blank">Trip.com</a>
        <a class="dest-btn dest-btn-gf" href="${d.gf_url}" target="_blank">Google</a>
      </div>
    </div>`).join('') + '</div>';
}

// ── Price Intelligence ──
async function loadInsights(from, to) {
  const insightsCard = document.getElementById('insights-card');
  const insightsBody = document.getElementById('insights-body');
  try {
    const data = await get(`/api/insights/${from}/${to}`);
    if (data.insufficient_data) {
      insightsCard.style.display = 'none';
      return;
    }
    insightsCard.style.display = '';

    const maxAvg = Math.max(...(data.by_day_of_week || []).map(d => d.avg_price), 1);
    const dayBars = (data.by_day_of_week || []).map(d => {
      const h = Math.round((d.avg_price / maxAvg) * 52) + 8;
      const isCheap = d.day === data.cheapest_day;
      return `<div class="day-bar-wrap">
        <div class="day-bar ${isCheap ? 'cheapest' : ''}" style="height:${h}px" title="${d.day}: $${d.avg_price}"></div>
        <div class="day-name">${d.day}</div>
      </div>`;
    }).join('');

    insightsBody.innerHTML = `
      <div class="insights-grid">
        <div class="insight-block">
          <div class="insight-label">Cheapest day to fly</div>
          <div class="insight-highlight">${data.cheapest_day || '—'}</div>
          <div class="insight-sub">Based on ${data.data_points} price points</div>
          <div class="day-bars">${dayBars}</div>
        </div>
        <div class="insight-block">
          <div class="insight-label">Best time to book</div>
          <div class="insight-highlight">${data.best_booking_weeks_ahead != null ? data.best_booking_weeks_ahead + ' weeks out' : '—'}</div>
          <div class="insight-sub">Avg price: $${data.overall_avg} · Min: $${data.overall_min} · Max: $${data.overall_max}</div>
        </div>
      </div>`;
  } catch {
    insightsCard.style.display = 'none';
  }
}

// ── Alerts ──
function bindAlertForm() {
  document.getElementById('alert-form').addEventListener('submit', async e => {
    e.preventDefault();
    await post('/api/alerts', {
      from_airport: getVal('al-from').toUpperCase(),
      to_airport: getVal('al-to').toUpperCase(),
      threshold_price: parseInt(getVal('al-threshold')),
      label: getVal('al-label') || null,
    });
    e.target.reset();
    loadAlerts();
  });
}

async function loadAlerts() {
  const el = document.getElementById('alerts-list');
  try {
    const alerts = await get('/api/alerts');
    if (!alerts.length) { el.innerHTML = '<p class="empty">No alerts yet.</p>'; return; }
    el.innerHTML = alerts.map(a => `
      <div class="alert-item ${a.triggered ? 'triggered' : ''}">
        <div>
          <div class="alert-route">${a.from_airport} → ${a.to_airport}</div>
          <div style="font-size:11px;color:var(--muted)">${a.label || ''}</div>
          ${a.triggered ? `<div class="alert-triggered">✓ Found $${a.triggered_price} on ${a.triggered_date}</div>` : ''}
        </div>
        <div class="alert-price">Under $${a.threshold_price}</div>
        <div class="alert-actions">
          ${a.triggered ? `<button class="btn-sm" onclick="resetAlert(${a.id})">Reset</button>` : ''}
          <button class="btn-sm btn-del" onclick="deleteAlert(${a.id})">Delete</button>
        </div>
      </div>`).join('');
  } catch { el.innerHTML = ''; }
}

async function deleteAlert(id) { await fetch(`/api/alerts/${id}`, { method: 'DELETE' }); loadAlerts(); }
async function resetAlert(id) { await fetch(`/api/alerts/${id}/reset`, { method: 'PUT' }); loadAlerts(); }

// ── History ──
async function loadHistoryPreview() {
  const el = document.getElementById('history-list');
  try {
    const jobs = await get('/api/searches');
    if (!jobs.length) { el.innerHTML = '<p class="empty">No searches yet.</p>'; return; }
    el.innerHTML = jobs.slice(0, 10).map(j => `
      <div class="history-item" onclick="reloadJob(${j.id}, '${j.search_type}')">
        <div>
          <div class="history-route">${j.from_airport} → ${j.to_airport}</div>
          <div class="history-meta">${j.date_from} to ${j.date_to} · ${j.search_type}</div>
        </div>
        <div class="history-status">
          <span class="status-badge s-${j.status}">${j.status}</span>
        </div>
      </div>`).join('');
  } catch { el.innerHTML = ''; }
}

async function reloadJob(id, type) {
  currentJobId = id;
  const mode = type === 'best-window' ? 'bestwindow' : type === 'compare' ? 'compare' : 'oneway';
  await loadResults(mode);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Utils ──
async function get(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}

function isoDate(d) { return d.toISOString().split('T')[0]; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function getVal(id) { return document.getElementById(id)?.value?.trim() || ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }
function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(price, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(price);
}
function fmtDur(mins) {
  if (!mins) return '—';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
