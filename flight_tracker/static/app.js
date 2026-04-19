'use strict';

// ── State ──
let currentMode = 'oneway';
let currentJobId = null;
let pollTimer = null;
let trendChart = null;
let allFlights = [];
let sortCol = 'price', sortDir = 'asc';
let budgetLimit = 0;

const CURRENCY = 'MYR';

// ══════════════════════════════════════════
// DATE PICKER
// ══════════════════════════════════════════
const dpPopup   = document.getElementById('dp-popup');
const dpDays    = document.getElementById('dp-days');
const dpLabel   = document.getElementById('dp-month-label');
let dpViewing   = new Date();
let dpTarget    = null;   // { hiddenId, displayEl }
let dpMinDate   = null;

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function dpOpen(trigger) {
  const hiddenId  = trigger.dataset.hidden;
  const displayEl = trigger.querySelector('.dp-display');
  dpTarget = { hiddenId, displayEl };

  const existing = document.getElementById(hiddenId).value;
  dpViewing = existing ? new Date(existing + 'T00:00:00') : new Date();

  // Position popup below trigger
  const rect = trigger.getBoundingClientRect();
  dpPopup.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
  dpPopup.style.left = Math.min(rect.left, window.innerWidth - 296) + 'px';
  dpPopup.classList.add('open');
  trigger.classList.add('open');
  dpRender();
}

function dpClose() {
  dpPopup.classList.remove('open');
  document.querySelectorAll('.dp-trigger.open').forEach(t => t.classList.remove('open'));
  dpTarget = null;
}

function dpRender() {
  const y = dpViewing.getFullYear();
  const m = dpViewing.getMonth();
  dpLabel.textContent = `${MONTHS[m]} ${y}`;

  const firstDow = new Date(y, m, 1).getDay();
  const lastDay  = new Date(y, m + 1, 0).getDate();
  const today    = isoToday();
  const selected = dpTarget ? document.getElementById(dpTarget.hiddenId).value : '';

  let html = '';
  for (let i = 0; i < firstDow; i++) html += '<span class="dp-day dp-empty"></span>';
  for (let d = 1; d <= lastDay; d++) {
    const iso = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const past  = iso < today;
    const isMin = dpMinDate && iso < dpMinDate;
    let cls = 'dp-day';
    if (past || isMin)   cls += ' dp-disabled';
    if (iso === selected) cls += ' dp-selected';
    else if (iso === today) cls += ' dp-today';
    html += `<span class="${cls}" data-iso="${iso}">${d}</span>`;
  }
  dpDays.innerHTML = html;

  dpDays.querySelectorAll('.dp-day:not(.dp-disabled):not(.dp-empty)').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); dpSelect(el.dataset.iso); });
  });
}

function dpSelect(iso) {
  if (!dpTarget) return;
  document.getElementById(dpTarget.hiddenId).value = iso;
  const disp = dpTarget.displayEl;
  disp.textContent = fmtDateDisplay(iso);
  disp.classList.add('has-value');
  dpClose();
}

document.getElementById('dp-prev').addEventListener('click', e => {
  e.stopPropagation();
  dpViewing.setMonth(dpViewing.getMonth() - 1);
  dpRender();
});
document.getElementById('dp-next').addEventListener('click', e => {
  e.stopPropagation();
  dpViewing.setMonth(dpViewing.getMonth() + 1);
  dpRender();
});
document.addEventListener('click', e => {
  if (!dpPopup.contains(e.target) && !e.target.closest('.dp-trigger')) dpClose();
});

// Bind all dp-triggers
document.querySelectorAll('.dp-trigger').forEach(trigger => {
  trigger.addEventListener('click', e => { e.stopPropagation(); dpOpen(trigger); });
});


// ══════════════════════════════════════════
// AIRPORT AUTOCOMPLETE
// ══════════════════════════════════════════
function initAC(wrap) {
  const textInput  = wrap.querySelector('.ac-text');
  const hiddenId   = wrap.dataset.hidden;
  const hiddenInput = document.getElementById(hiddenId);
  const drop = wrap.querySelector('.ac-drop');
  let timer = null;

  textInput.addEventListener('input', () => {
    clearTimeout(timer);
    hiddenInput.value = '';  // clear code when user types
    const q = textInput.value.trim();
    if (q.length < 2) { drop.style.display = 'none'; return; }
    timer = setTimeout(() => fetchAC(q, drop, textInput, hiddenInput), 220);
  });

  textInput.addEventListener('focus', () => {
    const q = textInput.value.trim();
    if (q.length >= 2) fetchAC(q, drop, textInput, hiddenInput);
  });

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) drop.style.display = 'none';
  });
}

async function fetchAC(q, drop, textInput, hiddenInput) {
  try {
    const res  = await fetch(`/api/airports/search?q=${encodeURIComponent(q)}`);
    const list = await res.json();
    if (!list.length) { drop.style.display = 'none'; return; }
    drop.innerHTML = list.map(a =>
      `<div class="ac-option" data-code="${a.code}" data-name="${a.name}">
         <span class="ac-code">${a.code}</span>
         <span class="ac-name">${a.name}</span>
       </div>`
    ).join('');
    drop.style.display = 'block';
    drop.querySelectorAll('.ac-option').forEach(opt => {
      opt.addEventListener('mousedown', e => {
        e.preventDefault();
        textInput.value  = `${opt.dataset.code} — ${opt.dataset.name}`;
        hiddenInput.value = opt.dataset.code;
        drop.style.display = 'none';
      });
    });
  } catch {}
}

// helper to get airport code from an ac-wrap
function getCode(hiddenId) {
  const hidden = document.getElementById(hiddenId);
  if (hidden && hidden.value) return hidden.value.trim().toUpperCase();
  // fallback: try to parse the text input
  const wrap = document.querySelector(`[data-hidden="${hiddenId}"]`);
  if (wrap) {
    const txt = wrap.querySelector('.ac-text')?.value?.trim() || '';
    return txt.split('—')[0].trim().toUpperCase();
  }
  return '';
}

document.querySelectorAll('.ac-wrap').forEach(initAC);


// ══════════════════════════════════════════
// MODE SWITCHING
// ══════════════════════════════════════════
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.sform').forEach(f => f.classList.add('hidden'));
    document.getElementById('form-' + currentMode).classList.remove('hidden');
    hideResults();
  });
});

function hideResults() {
  ['results-oneway','results-bestwindow','results-compare','progress-card'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
}


// ══════════════════════════════════════════
// SWAP
// ══════════════════════════════════════════
document.querySelectorAll('.swap-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const aId = btn.dataset.a, bId = btn.dataset.b;
    const aHidden = document.getElementById(aId);
    const bHidden = document.getElementById(bId);
    const aWrap = document.querySelector(`[data-hidden="${aId}"]`);
    const bWrap = document.querySelector(`[data-hidden="${bId}"]`);
    const aText = aWrap?.querySelector('.ac-text');
    const bText = bWrap?.querySelector('.ac-text');
    if (aHidden && bHidden) [aHidden.value, bHidden.value] = [bHidden.value, aHidden.value];
    if (aText && bText)     [aText.value,   bText.value]   = [bText.value,   aText.value];
  });
});


// ══════════════════════════════════════════
// SEARCH HANDLERS
// ══════════════════════════════════════════
document.getElementById('btn-oneway').addEventListener('click', async () => {
  budgetLimit = parseInt(document.getElementById('ow-budget')?.value) || 0;
  await startJob('/api/search', {
    from_airport: getCode('ow-from'),
    to_airport:   getCode('ow-to'),
    date_from:    getHidden('ow-datefrom'),
    date_to:      getHidden('ow-dateto'),
    seat_class:   getVal('ow-seat'),
    currency:     CURRENCY,
  }, 'oneway');
});

document.getElementById('btn-bestwindow').addEventListener('click', async () => {
  await startJob('/api/best-window', {
    from_airport: getCode('bw-from'),
    to_airport:   getCode('bw-to'),
    search_from:  getHidden('bw-searchfrom'),
    search_to:    getHidden('bw-searchto'),
    trip_days:    parseInt(getVal('bw-nights')) || 7,
    seat_class:   getVal('bw-seat'),
    currency:     CURRENCY,
  }, 'bestwindow');
});

document.getElementById('btn-compare').addEventListener('click', async () => {
  const tos = [0, 1, 2].map(i => getCode(`cmp-to-${i}`)).filter(Boolean);
  await startJob('/api/compare', {
    from_airport: getCode('cmp-from'),
    to_airports:  tos,
    date_from:    getHidden('cmp-datefrom'),
    date_to:      getHidden('cmp-dateto'),
    seat_class:   getVal('cmp-seat'),
    currency:     CURRENCY,
  }, 'compare');
});

document.getElementById('btn-alert').addEventListener('click', async () => {
  const from = getCode('al-from'), to = getCode('al-to');
  const thresh = parseInt(getVal('al-threshold'));
  const label  = getVal('al-label');
  if (!from || !to || !thresh) { alert('Fill in From, To and threshold price.'); return; }
  await apiPost('/api/alerts', { from_airport: from, to_airport: to, threshold_price: thresh, label: label || null });
  document.getElementById('al-threshold').value = '';
  document.getElementById('al-label').value = '';
  loadAlerts();
});


// ══════════════════════════════════════════
// JOB LIFECYCLE
// ══════════════════════════════════════════
async function startJob(endpoint, payload, mode) {
  // Validate required fields
  if (mode === 'oneway') {
    if (!payload.from_airport || !payload.to_airport) { alert('Please select From and To airports.'); return; }
    if (!payload.date_from || !payload.date_to) { alert('Please select the date range.'); return; }
  }
  if (mode === 'bestwindow') {
    if (!payload.from_airport || !payload.to_airport) { alert('Please select From and To airports.'); return; }
    if (!payload.search_from || !payload.search_to) { alert('Please select the search date range.'); return; }
  }
  if (mode === 'compare') {
    if (!payload.from_airport || !payload.to_airports?.length) { alert('Please select From airport and at least one destination.'); return; }
    if (!payload.date_from || !payload.date_to) { alert('Please select the date range.'); return; }
  }

  stopPolling();
  hideResults();
  setBtnLoading(true);

  try {
    const data = await apiPost(endpoint, payload);
    currentJobId = data.search_id;
    show('progress-card');
    updateProgress(0, data.total_dates || data.windows_to_check || 1, 'Searching…');
    pollTimer = setInterval(() => pollStatus(mode), 2000);
  } catch (err) {
    alert('Error: ' + err.message);
    setBtnLoading(false);
  }
}

async function pollStatus(mode) {
  const urls = {
    oneway:     `/api/search/${currentJobId}/status`,
    bestwindow: `/api/best-window/${currentJobId}/status`,
    compare:    `/api/compare/${currentJobId}/status`,
  };
  try {
    const d = await apiFetch(urls[mode]);
    updateProgress(d.completed_dates, d.total_dates, `${d.completed_dates} / ${d.total_dates} dates done`);
    if (d.status === 'done' || d.status === 'error') {
      stopPolling();
      setBtnLoading(false);
      hide('progress-card');
      if (d.status === 'done') await loadResults(mode);
      else alert('Search failed: ' + (d.error_message || 'Unknown'));
    }
  } catch {}
}

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

function setBtnLoading(on) {
  ['btn-oneway','btn-bestwindow','btn-compare'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = on;
  });
}

function updateProgress(done, total, label) {
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';
  document.getElementById('progress-pct').textContent = pct + '%';
  document.getElementById('progress-label').textContent = label;
}


// ══════════════════════════════════════════
// RESULTS
// ══════════════════════════════════════════
async function loadResults(mode) {
  const urls = {
    oneway:     `/api/search/${currentJobId}/results`,
    bestwindow: `/api/best-window/${currentJobId}/results`,
    compare:    `/api/compare/${currentJobId}/results`,
  };
  const data = await apiFetch(urls[mode]);
  if (mode === 'oneway')     renderOneway(data);
  if (mode === 'bestwindow') renderBestWindow(data);
  if (mode === 'compare')    renderCompare(data);
  loadHistoryPreview();
}

// ── One-Way ──
function renderOneway(data) {
  allFlights = data.flights || [];
  show('results-oneway');

  // Stats
  document.getElementById('ow-stats').innerHTML = [
    { label: 'Cheapest', val: data.min_price != null ? fmtMYR(data.min_price) : '—', cls: 'green', note: 'Google Flights' },
    { label: 'Most Expensive', val: data.max_price != null ? fmtMYR(data.max_price) : '—', cls: 'red', note: 'Google Flights' },
    { label: 'Flights Found', val: data.total_results, cls: '', note: '' },
    { label: 'Dates Covered', val: (data.trend || []).length, cls: '', note: '' },
  ].map(s => `<div class="stat-box">
    <div class="stat-box-label">${s.label}</div>
    <div class="stat-box-value ${s.cls}">${s.val}</div>
    ${s.note ? `<div class="stat-box-note">${s.note}</div>` : ''}
  </div>`).join('');

  document.getElementById('share-btn').onclick = () => window.open(`/api/share/${currentJobId}`, '_blank');

  renderChart(data.trend || []);
  renderCalendar(data.calendar || {}, data.min_price, data.max_price);
  renderFlightList();
  loadInsights(data.from_airport, data.to_airport);
}

// ── Chart ──
function renderChart(trend) {
  const ctx = document.getElementById('trend-chart').getContext('2d');
  if (trendChart) trendChart.destroy();
  if (!trend.length) return;
  const labels = trend.map(t => t.date.slice(5));
  const prices = trend.map(t => t.price);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
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
        tooltip: { callbacks: { label: c => ' ' + fmtMYR(c.parsed.y) + ' · Google Flights' } }
      },
      scales: {
        x: { ticks: { color: '#5e6480', font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(37,40,57,.5)' } },
        y: { ticks: { color: '#5e6480', font: { size: 10 }, callback: v => fmtMYR(v) }, grid: { color: 'rgba(37,40,57,.5)' } }
      }
    }
  });
}

// ── Calendar ──
function renderCalendar(cal, minP, maxP) {
  const el = document.getElementById('calendar');
  const dates = Object.keys(cal).sort();
  if (!dates.length) { el.innerHTML = '<p class="empty-msg">No data</p>'; return; }
  const start = new Date(dates[0] + 'T00:00:00');
  const end   = new Date(dates[dates.length - 1] + 'T00:00:00');
  const range = (maxP - minP) || 1;
  const days  = ['Su','Mo','Tu','We','Th','Fr','Sa'];
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
      priceHtml = `<div class="cal-price">${fmtMYR(price)}</div>`;
    } else { cls += ' nodata'; }
    html += `<div class="${cls}"><div class="cal-date">${cur.getDate()}</div>${priceHtml}</div>`;
    cur.setDate(cur.getDate() + 1);
  }
  el.innerHTML = html + '</div>';
}

// ── Flight cards ──
function bindListControls() {
  document.getElementById('airline-filter').addEventListener('input', renderFlightList);
  document.getElementById('stops-filter').addEventListener('change', renderFlightList);
  document.getElementById('sort-select').addEventListener('change', e => {
    const [col, dir] = e.target.value.split('-');
    sortCol = col; sortDir = dir;
    renderFlightList();
  });
}

function renderFlightList() {
  const airlineQ = document.getElementById('airline-filter').value.toLowerCase();
  const stopsQ   = document.getElementById('stops-filter').value;

  let list = allFlights.filter(f => {
    if (airlineQ && !f.airlines.toLowerCase().includes(airlineQ)) return false;
    if (stopsQ !== '' && f.stops > parseInt(stopsQ)) return false;
    if (budgetLimit > 0 && f.price > budgetLimit) return false;
    return true;
  });

  list.sort((a, b) => {
    let va = a[sortCol], vb = b[sortCol];
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const minP = list.length ? Math.min(...list.map(f => f.price)) : 0;
  const maxP = list.length ? Math.max(...list.map(f => f.price)) : 0;

  document.getElementById('filtered-count').textContent = list.length ? `· ${list.length} flights` : '';

  const el = document.getElementById('flights-list');
  if (!list.length) { el.innerHTML = '<p class="empty-msg">No flights match filters.</p>'; return; }

  el.innerHTML = list.map(f => {
    const cheap  = f.price === minP;
    const pricey = f.price === maxP && minP !== maxP;
    const cls    = cheap ? 'fc-cheap' : pricey ? 'fc-pricey' : '';
    const stopsCls = f.stops === 0 ? 'direct' : f.stops === 1 ? 'one' : 'multi';
    const stopsLabel = f.stops === 0 ? 'Direct' : f.stops === 1 ? '1 Stop' : `${f.stops} Stops`;
    const letter = (f.airlines || '?')[0].toUpperCase();
    const badgeBg = airlineBadgeColor(f.airlines);

    return `<div class="flight-card ${cls}">
      <div class="fc-badge" style="background:${badgeBg}">${letter}</div>
      <div class="fc-route">
        <div class="fc-airline-name">${esc(f.airlines)} · ${f.flight_date}</div>
        <div class="fc-airports">
          <div>
            <div class="fc-code">${f.from_airport || '—'}</div>
            <div class="fc-time">${f.departure_time || '—'}</div>
          </div>
          <div class="fc-arrow-wrap">
            <div class="fc-dur">${fmtDur(f.duration_minutes)}</div>
            <div class="fc-line"></div>
          </div>
          <div>
            <div class="fc-code">${f.to_airport || '—'}</div>
            <div class="fc-time">${f.arrival_time || '—'}</div>
          </div>
        </div>
      </div>
      <div class="fc-meta">
        <div class="fc-date">${f.flight_date}</div>
        <span class="fc-stops ${stopsCls}">${stopsLabel}</span>
      </div>
      <div class="fc-price">
        <div class="fc-amount">${fmtMYR(f.price)}</div>
        <div class="fc-currency">MYR</div>
        <div class="fc-src">Google Flights</div>
      </div>
    </div>`;
  }).join('');
}

function airlineBadgeColor(name) {
  // Deterministic color from first char
  const colors = ['#1a3a5c','#2d1b4e','#1a4a2e','#4a2020','#1a3a4a','#3a2d1a'];
  const idx = (name || 'X').charCodeAt(0) % colors.length;
  return colors[idx];
}

// ── Best Window ──
function renderBestWindow(data) {
  show('results-bestwindow');
  const el = document.getElementById('windows-list');
  const windows = data.windows || [];
  if (!windows.length) { el.innerHTML = '<p class="empty-msg">No windows found. Try a wider date range.</p>'; return; }
  el.innerHTML = '<div class="win-list">' + windows.map((w, i) => `
    <div class="win-item ${i === 0 ? 'best' : ''}">
      <div class="win-rank">#${i + 1}</div>
      <div class="win-dates">
        <strong>✈ ${w.depart_date} &nbsp;→&nbsp; ${w.return_date}</strong>
        <div class="win-airlines">${esc(w.outbound_airline || '')} · ${esc(w.return_airline || '')}</div>
        <div class="win-src">Google Flights</div>
      </div>
      <div class="win-price">
        <div class="win-total">${fmtMYR(w.total_price)}</div>
        <div class="win-breakdown">Out ${fmtMYR(w.outbound_price)} + Back ${fmtMYR(w.return_price)}</div>
      </div>
    </div>`).join('') + '</div>';
}

// ── Compare ──
function renderCompare(data) {
  show('results-compare');
  const el = document.getElementById('compare-list');
  const dests = data.destinations || [];
  if (!dests.length) { el.innerHTML = '<p class="empty-msg">No results. Try a wider date range.</p>'; return; }
  el.innerHTML = '<div class="dest-grid">' + dests.map((d, i) => `
    <div class="dest-card ${i === 0 ? 'winner' : ''}">
      ${i === 0 ? '<div class="dest-winner-badge">Cheapest ✓</div>' : ''}
      <div class="dest-code">${d.to_airport}</div>
      <div class="dest-airline">${esc(d.airline)} · ${d.cheapest_date}</div>
      <div class="dest-price">${fmtMYR(d.cheapest_price)}</div>
      <div class="dest-src">Google Flights · verify before booking</div>
      <div class="dest-btns">
        <a class="dest-btn dest-btn-trip" href="${d.trip_com_url}" target="_blank">Trip.com</a>
        <a class="dest-btn dest-btn-gf"   href="${d.gf_url}"       target="_blank">Google</a>
      </div>
    </div>`).join('') + '</div>';
}

// ── Insights ──
async function loadInsights(from, to) {
  const card = document.getElementById('insights-card');
  const body = document.getElementById('insights-body');
  try {
    const data = await apiFetch(`/api/insights/${from}/${to}`);
    if (data.insufficient_data) { card.style.display = 'none'; return; }
    card.style.display = '';
    const maxAvg = Math.max(...(data.by_day_of_week || []).map(d => d.avg_price), 1);
    const bars = (data.by_day_of_week || []).map(d => {
      const h = Math.round((d.avg_price / maxAvg) * 48) + 8;
      return `<div class="day-bar-wrap">
        <div class="day-bar ${d.day === data.cheapest_day ? 'cheapest' : ''}" style="height:${h}px" title="${d.day}: ${fmtMYR(d.avg_price)}"></div>
        <div class="day-name">${d.day}</div>
      </div>`;
    }).join('');
    body.innerHTML = `<div class="insight-grid">
      <div>
        <div class="insight-label">Cheapest day to fly</div>
        <div class="insight-value">${data.cheapest_day || '—'}</div>
        <div class="insight-sub">From ${data.data_points} data points</div>
        <div class="day-bars">${bars}</div>
      </div>
      <div>
        <div class="insight-label">Best time to book</div>
        <div class="insight-value">${data.best_booking_weeks_ahead != null ? data.best_booking_weeks_ahead + ' weeks out' : '—'}</div>
        <div class="insight-sub">Avg ${fmtMYR(data.overall_avg)} · Min ${fmtMYR(data.overall_min)} · Max ${fmtMYR(data.overall_max)}</div>
      </div>
    </div>`;
  } catch { card.style.display = 'none'; }
}


// ══════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════
async function loadAlerts() {
  const el = document.getElementById('alerts-list');
  try {
    const list = await apiFetch('/api/alerts');
    if (!list.length) { el.innerHTML = '<p class="empty-msg">No alerts yet.</p>'; return; }
    el.innerHTML = list.map(a => `
      <div class="alert-row ${a.triggered ? 'triggered' : ''}">
        <div>
          <div class="alert-route">${a.from_airport} → ${a.to_airport}</div>
          <div style="font-size:11px;color:var(--muted)">${a.label || ''}</div>
          ${a.triggered ? `<div class="alert-triggered">✓ Found ${fmtMYR(a.triggered_price)} on ${a.triggered_date}</div>` : ''}
        </div>
        <div class="alert-price">Under ${fmtMYR(a.threshold_price)}</div>
        <div class="alert-actions">
          ${a.triggered ? `<button class="btn-xs" onclick="resetAlert(${a.id})">Reset</button>` : ''}
          <button class="btn-xs btn-xs-del" onclick="deleteAlert(${a.id})">Delete</button>
        </div>
      </div>`).join('');
  } catch { el.innerHTML = ''; }
}

async function deleteAlert(id) { await fetch(`/api/alerts/${id}`, { method: 'DELETE' }); loadAlerts(); }
async function resetAlert(id)  { await fetch(`/api/alerts/${id}/reset`, { method: 'PUT' }); loadAlerts(); }


// ══════════════════════════════════════════
// HISTORY
// ══════════════════════════════════════════
async function loadHistoryPreview() {
  const el = document.getElementById('history-list');
  try {
    const jobs = await apiFetch('/api/searches');
    if (!jobs.length) { el.innerHTML = '<p class="empty-msg">No searches yet.</p>'; return; }
    el.innerHTML = jobs.slice(0, 10).map(j => `
      <div class="history-row" onclick="reloadJob(${j.id},'${j.search_type}')">
        <div>
          <div class="history-route">${j.from_airport} → ${j.to_airport}</div>
          <div class="history-meta">${j.date_from} to ${j.date_to} · ${j.search_type}</div>
        </div>
        <div class="history-status">
          <span class="sbadge s-${j.status}">${j.status}</span>
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


// ══════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════
async function apiFetch(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Request failed');
  return data;
}

function fmtMYR(price) {
  if (price == null) return '—';
  return 'MYR ' + Math.round(price).toLocaleString('en-MY');
}
function fmtDur(mins) {
  if (!mins) return '—';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtDateDisplay(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function isoDate(d) { return d.toISOString().split('T')[0]; }
function isoToday() { return isoDate(new Date()); }
function getVal(id)    { return document.getElementById(id)?.value?.trim() || ''; }
function getHidden(id) { return document.getElementById(id)?.value || ''; }
function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }
function esc(s)   { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


// ══════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════
bindListControls();
loadAlerts();
loadHistoryPreview();
