'use strict';

// ---------- State ----------
let currentSearchId = null;
let pollTimer = null;
let trendChart = null;
let allFlights = [];
let sortState = { col: 'price', dir: 'asc' };

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
  setDefaultDates();
  bindTabs();
  bindSearchForm();
  bindSwap();
  bindTableSort();
  bindTableFilter();
  bindAlertForm();
});

function setDefaultDates() {
  const today = new Date();
  const twoWeeks = new Date(today);
  twoWeeks.setDate(today.getDate() + 14);
  document.getElementById('date_from').value = fmtDate(today);
  document.getElementById('date_to').value = fmtDate(twoWeeks);
}

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

// ---------- Tabs ----------
function bindTabs() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'history') loadHistory();
      if (btn.dataset.tab === 'alerts') loadAlerts();
    });
  });
}

// ---------- Swap ----------
function bindSwap() {
  document.getElementById('swap-btn').addEventListener('click', () => {
    const from = document.getElementById('from_airport');
    const to = document.getElementById('to_airport');
    [from.value, to.value] = [to.value, from.value];
  });
}

// ---------- Search ----------
function bindSearchForm() {
  document.getElementById('search-form').addEventListener('submit', async e => {
    e.preventDefault();
    await startSearch();
  });
}

async function startSearch() {
  const btn = document.getElementById('search-btn');
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Searching…';
  btn.querySelector('.spinner').classList.remove('hidden');

  stopPolling();
  hide('results-section');

  const payload = {
    from_airport: document.getElementById('from_airport').value.trim(),
    to_airport: document.getElementById('to_airport').value.trim(),
    date_from: document.getElementById('date_from').value,
    date_to: document.getElementById('date_to').value,
    seat_class: document.getElementById('seat_class').value,
    currency: document.getElementById('currency').value,
  };

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Search failed');

    currentSearchId = data.search_id;
    showProgress();
    updateProgress(0, data.total_dates, 'Starting search…');
    startPolling();

  } catch (err) {
    alert('Error: ' + err.message);
    resetSearchBtn();
  }
}

function resetSearchBtn() {
  const btn = document.getElementById('search-btn');
  btn.disabled = false;
  btn.querySelector('.btn-text').textContent = 'Search Flights';
  btn.querySelector('.spinner').classList.add('hidden');
}

// ---------- Polling ----------
function startPolling() {
  pollTimer = setInterval(pollStatus, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollStatus() {
  if (!currentSearchId) return;
  try {
    const res = await fetch(`/api/search/${currentSearchId}/status`);
    const data = await res.json();

    updateProgress(data.completed_dates, data.total_dates,
      `Scraped ${data.completed_dates} / ${data.total_dates} dates`);

    if (data.status === 'done' || data.status === 'error') {
      stopPolling();
      resetSearchBtn();
      if (data.status === 'done') {
        await loadResults(currentSearchId);
      } else {
        alert('Search error: ' + (data.error_message || 'Unknown error'));
        hideProgress();
      }
    }
  } catch (err) {
    // network hiccup, keep polling
  }
}

// ---------- Progress ----------
function showProgress() {
  show('progress-section');
}
function hideProgress() {
  hide('progress-section');
}
function updateProgress(done, total, label) {
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-pct').textContent = pct + '%';
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-detail').textContent =
    `${done} of ${total} dates scraped`;
}

// ---------- Results ----------
async function loadResults(searchId) {
  const res = await fetch(`/api/search/${searchId}/results`);
  const data = await res.json();

  hideProgress();
  allFlights = data.flights || [];

  renderStats(data);
  renderTrendChart(data.trend || [], data.currency_symbol || data.flights[0]?.currency || 'USD');
  renderCalendar(data.calendar || {}, data.date_from, data.date_to, data.min_price, data.max_price);
  renderTable();
  show('results-section');
}

// ---------- Stats ----------
function renderStats(data) {
  const currency = data.flights[0]?.currency || 'USD';
  const stats = [
    { label: 'Cheapest', value: data.min_price != null ? fmtPrice(data.min_price, currency) : '—', cls: 'green' },
    { label: 'Most Expensive', value: data.max_price != null ? fmtPrice(data.max_price, currency) : '—', cls: 'red' },
    { label: 'Routes Found', value: data.total_results, cls: '' },
    { label: 'Dates Searched', value: (data.trend || []).length, cls: '' },
  ];
  document.getElementById('stats-row').innerHTML = stats.map(s => `
    <div class="stat-card">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value ${s.cls}">${s.value}</div>
    </div>
  `).join('');
}

// ---------- Trend Chart ----------
function renderTrendChart(trend, currency) {
  const ctx = document.getElementById('trend-chart').getContext('2d');
  if (trendChart) trendChart.destroy();

  const labels = trend.map(t => t.date);
  const prices = trend.map(t => t.price);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);

  const backgroundColors = prices.map(p => {
    if (p === minP) return 'rgba(34,197,94,0.7)';
    if (p === maxP) return 'rgba(239,68,68,0.7)';
    return 'rgba(79,142,247,0.5)';
  });

  trendChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Cheapest Price',
        data: prices,
        backgroundColor: backgroundColors,
        borderRadius: 4,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ' ' + fmtPrice(ctx.parsed.y, currency),
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#7c82a0',
            maxRotation: 45,
            font: { size: 11 },
            callback: (val, i) => labels[i].slice(5), // MM-DD
          },
          grid: { color: 'rgba(46,51,73,0.5)' },
        },
        y: {
          ticks: {
            color: '#7c82a0',
            font: { size: 11 },
            callback: val => fmtPrice(val, currency),
          },
          grid: { color: 'rgba(46,51,73,0.5)' },
        }
      }
    }
  });
}

// ---------- Calendar ----------
function renderCalendar(calData, dateFrom, dateTo, minPrice, maxPrice) {
  const el = document.getElementById('price-calendar');
  if (!Object.keys(calData).length) {
    el.innerHTML = '<p class="empty-state"><p>No data available.</p></p>';
    return;
  }

  // Determine range from the data keys
  const dates = Object.keys(calData).sort();
  const start = new Date(dates[0] + 'T00:00:00');
  const end = new Date(dates[dates.length - 1] + 'T00:00:00');

  const currency = allFlights[0]?.currency || 'USD';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let html = '<div class="calendar-grid">';
  // Day headers
  days.forEach(d => { html += `<div class="cal-header">${d}</div>`; });

  // Empty cells before first day
  const startDow = start.getDay();
  for (let i = 0; i < startDow; i++) html += '<div class="cal-cell cal-empty"></div>';

  // Cells for each date
  const current = new Date(start);
  while (current <= end) {
    const key = fmtDate(current);
    const price = calData[key];
    let cls = 'cal-cell';
    let priceLabel = '—';
    if (price != null) {
      priceLabel = fmtPrice(price, currency);
      const range = maxPrice - minPrice;
      if (range === 0 || price === minPrice) cls += ' price-cheapest';
      else if (price === maxPrice) cls += ' price-expensive';
      else if ((price - minPrice) / range < 0.33) cls += ' price-cheapest';
      else if ((price - minPrice) / range > 0.66) cls += ' price-expensive';
      else cls += ' price-mid';
    } else {
      cls += ' no-data';
      priceLabel = 'N/A';
    }
    html += `<div class="${cls}" title="${key}">
      <div class="cal-date">${current.getDate()}</div>
      <div class="cal-price">${priceLabel}</div>
    </div>`;
    current.setDate(current.getDate() + 1);
  }

  html += '</div>';
  el.innerHTML = html;
}

// ---------- Table ----------
function bindTableSort() {
  document.querySelectorAll('#flights-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortState.col === col) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.col = col;
        sortState.dir = 'asc';
      }
      document.querySelectorAll('#flights-table th').forEach(t => {
        t.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderTable();
    });
  });
}

function bindTableFilter() {
  document.getElementById('table-filter').addEventListener('input', renderTable);
  document.getElementById('stops-filter').addEventListener('change', renderTable);
}

function renderTable() {
  const filterText = document.getElementById('table-filter').value.toLowerCase();
  const stopsFilter = document.getElementById('stops-filter').value;

  let flights = [...allFlights];

  // Filter
  if (filterText) {
    flights = flights.filter(f => f.airlines.toLowerCase().includes(filterText));
  }
  if (stopsFilter !== '') {
    const maxStops = parseInt(stopsFilter, 10);
    flights = flights.filter(f => f.stops <= maxStops);
  }

  // Sort
  flights.sort((a, b) => {
    let va = a[sortState.col];
    let vb = b[sortState.col];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va == null) va = '';
    if (vb == null) vb = '';
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sortState.dir === 'asc' ? cmp : -cmp;
  });

  const minPrice = flights.length ? Math.min(...flights.map(f => f.price)) : 0;
  const maxPrice = flights.length ? Math.max(...flights.map(f => f.price)) : 0;
  const currency = flights[0]?.currency || 'USD';

  const tbody = document.getElementById('flights-tbody');
  if (!flights.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:32px">No flights match your filters.</td></tr>';
    return;
  }

  tbody.innerHTML = flights.map(f => {
    const isCheapest = f.price === minPrice;
    const isExpensive = f.price === maxPrice && minPrice !== maxPrice;
    const rowCls = isCheapest ? 'row-cheapest' : isExpensive ? 'row-expensive' : '';
    const stopsCls = f.stops === 0 ? 'stops-direct' : f.stops === 1 ? 'stops-one' : 'stops-multi';
    const stopsLabel = f.stops === 0 ? 'Direct' : f.stops === 1 ? '1 Stop' : `${f.stops} Stops`;
    const dur = fmtDuration(f.duration_minutes);

    return `<tr class="${rowCls}">
      <td>${f.flight_date}</td>
      <td>${esc(f.airlines)}</td>
      <td>${f.departure_time || '—'}</td>
      <td>${f.arrival_time || '—'}</td>
      <td class="duration-text">${dur}</td>
      <td><span class="stops-badge ${stopsCls}">${stopsLabel}</span></td>
      <td class="price-cell">${fmtPrice(f.price, currency)}</td>
    </tr>`;
  }).join('');
}

// ---------- History ----------
async function loadHistory() {
  const el = document.getElementById('history-list');
  el.innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
  const res = await fetch('/api/searches');
  const data = await res.json();
  if (!data.length) {
    el.innerHTML = emptyState('No search history yet. Run your first search!');
    return;
  }
  el.innerHTML = data.map(j => `
    <div class="history-item" onclick="loadHistoryItem(${j.id})">
      <div>
        <div class="history-route">${j.from_airport} → ${j.to_airport}</div>
        <div class="history-dates">${j.date_from} to ${j.date_to}</div>
      </div>
      <div class="history-dates">${j.created_at.split('T')[0]}</div>
      <div class="history-status">
        <span class="status-badge status-${j.status}">${j.status}</span>
      </div>
    </div>
  `).join('');
}

async function loadHistoryItem(id) {
  // Switch to search tab and load results
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('[data-tab="search"]').classList.add('active');
  document.getElementById('tab-search').classList.add('active');

  currentSearchId = id;
  await loadResults(id);
}

// ---------- Alerts ----------
function bindAlertForm() {
  document.getElementById('alert-form').addEventListener('submit', async e => {
    e.preventDefault();
    const payload = {
      from_airport: document.getElementById('alert_from').value.trim(),
      to_airport: document.getElementById('alert_to').value.trim(),
      threshold_price: parseInt(document.getElementById('alert_threshold').value, 10),
      label: document.getElementById('alert_label').value.trim() || null,
    };
    const res = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      e.target.reset();
      loadAlerts();
    }
  });
}

async function loadAlerts() {
  const el = document.getElementById('alerts-list');
  el.innerHTML = '<p style="color:var(--text-muted)">Loading…</p>';
  const res = await fetch('/api/alerts');
  const data = await res.json();
  if (!data.length) {
    el.innerHTML = emptyState('No alerts yet. Create one above to get notified when prices drop!');
    return;
  }
  el.innerHTML = data.map(a => {
    const triggered = a.triggered;
    return `
    <div class="alert-item ${triggered ? 'triggered' : ''}">
      <div>
        <div class="alert-route">${a.from_airport} → ${a.to_airport}</div>
        <div style="font-size:12px;color:var(--text-muted)">${a.label || ''}</div>
        ${triggered ? `<div style="font-size:12px;margin-top:4px">Found <strong>$${a.triggered_price}</strong> on ${a.triggered_date}</div>` : ''}
      </div>
      <div class="alert-threshold">Under $${a.threshold_price}</div>
      ${triggered ? '<span class="alert-triggered-badge">✓ Triggered</span>' : ''}
      <div class="alert-actions">
        ${triggered ? `<button class="btn btn-sm" onclick="resetAlert(${a.id})" title="Reset">↺ Reset</button>` : ''}
        <button class="btn btn-sm btn-danger" onclick="deleteAlert(${a.id})">Delete</button>
      </div>
    </div>`;
  }).join('');
}

async function deleteAlert(id) {
  await fetch(`/api/alerts/${id}`, { method: 'DELETE' });
  loadAlerts();
}

async function resetAlert(id) {
  await fetch(`/api/alerts/${id}/reset`, { method: 'PUT' });
  loadAlerts();
}

// ---------- Helpers ----------
function fmtPrice(price, currency) {
  if (price == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0
  }).format(price);
}

function fmtDuration(mins) {
  if (!mins) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }

function emptyState(msg) {
  return `<div class="empty-state">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    <p>${msg}</p>
  </div>`;
}
