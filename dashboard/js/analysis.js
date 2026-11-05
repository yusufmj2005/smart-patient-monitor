/* Analysis & reports page.

   Data sources:
     cloud    the patient's history in Firebase (/vitals/{pid}, /alerts/{pid}) for the chosen dates
     csv      files exported by the dashboard (or similar), imported in the browser; nothing is uploaded
     session  the monitor tab's current session, handed over with "Analyze this session"

   Everything below the filter row (analysis and report) is computed from the same slice of
   records, so the numbers always agree. */

import {
  VITALS, loadThresholds, importCSV, mergeRecords, analyze, byDay, downsample,
  insights, overall, nextSteps, fmt, withUnit, rangeText, STATUS_TEXT, dayKey,
} from './analysis-data.js?v=20261105';
import { lineChart, dailyRange, dailyColumns, rangeBar } from './analysis-charts.js?v=20261105';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const params = new URLSearchParams(location.search);
const DAY = 864e5;

const state = {
  fb: null,            // firebase module when signed in
  role: null,          // 'doctor' | 'patient' | null (offline)
  account: null,
  pid: null,           // cloud patient id
  patient: null,       // cloud patient profile
  patients: {},        // doctor: all patients
  source: null,        // 'cloud' | 'csv' | 'session'
  cloud: { records: [], alerts: [], key: '' },
  csv: [],
  csvFiles: [],
  session: null,       // { patient, records }
  from: 0,
  to: 0,
  th: loadThresholds(),
  records: [],         // current slice
  view: 'analysis',
};

// ---------------------------------------------------------------------------
// Helpers

const h = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
};

const STATUS_ICON = { good: '✓', watch: '!', concern: '!', none: '–', info: 'i' };
const statusChip = (level, text = STATUS_TEXT[level]) =>
  h('span', { class: `st-chip st-${level}` }, h('span', { class: 'st-icon', 'aria-hidden': 'true', text: STATUS_ICON[level] }), text);

const insightItems = (a, sameDay) => insights(a, state.th, sameDay).map((i) =>
  h('li', { class: `st-${i.level}` },
    h('span', { class: 'st-icon', 'aria-hidden': 'true', text: STATUS_ICON[i.level] }),
    h('span', {}, h('b', { text: `${i.label}: ` }), i.text)));

/* "What to do next" under the verdict; empty string when there is nothing to do. */
function nextStepsBlock(a) {
  const steps = nextSteps(a);
  if (!steps.length) return '';
  return h('div', { class: 'an-next' },
    h('b', { text: 'What to do next' }),
    h('ul', {}, ...steps.map((t) => h('li', { text: t }))));
}

const toDateInput = (ts) => dayKey(ts);
const fromDateInput = (v) => {
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

const EVENT_NAME = {
  hr: { high: 'High heart rate', low: 'Low heart rate' },
  spo2: { low: 'Low blood oxygen', high: 'High blood oxygen' },
  temp: { high: 'High temperature', low: 'Low temperature' },
  fall: { fall: 'Possible fall' },
};

function setNote(text, isError = false) {
  const n = $('#loadNote');
  n.textContent = text || '';
  n.classList.toggle('err', isError);
}

// ---------------------------------------------------------------------------
// Start-up: offline (CSV / session) or signed in (cloud too)

function loadSessionHandover() {
  try {
    const raw = sessionStorage.getItem('pm.analysisSession');
    if (!raw) return null;
    const d = JSON.parse(raw);
    const records = d.records.map(([ts, hr, spo2, temp, motion, steps, finger, fall, eng]) =>
      ({ ts, hr, spo2, temp, motion, steps, finger, fall, eng }));
    return records.length ? { patient: d.patient || {}, records } : null;
  } catch {
    return null;
  }
}

async function start() {
  state.session = loadSessionHandover();

  if (!window.CLOUD_ENABLED) return ready(null);

  const gate = $('#authGate');
  gate.hidden = false;
  const gateError = (text) => {
    $('#authGateMsg').textContent = text;
    $('#authGateActions').hidden = false;
  };
  $('#btnOffline').addEventListener('click', () => {
    gate.remove();
    ready(null);
  });
  const timer = setTimeout(() => {
    if (document.body.contains(gate) && $('#authGateActions').hidden) gateError('Could not reach Firebase. Check your internet connection.');
  }, 10000);

  let fb;
  try {
    fb = await import('./firebase.js');
  } catch {
    clearTimeout(timer);
    return gateError('Could not load Firebase. Check your internet connection.');
  }
  let started = false;
  fb.onAuthStateChanged(fb.auth, async (u) => {
    if (!u) return location.replace('login.html');
    if (started) return;
    let acct;
    try {
      acct = await fb.loadAccount(u);
    } catch (e) {
      clearTimeout(timer);
      return gateError(fb.accountErrorText(e));
    }
    if (!acct.profile) return location.replace('login.html');
    if (acct.profile.role === 'doctor' && !acct.verifiedDoctor) {
      fb.setAuthNotice({ code: 'not-verified' });
      return fb.signOut(fb.auth);
    }
    started = true;
    clearTimeout(timer);
    state.fb = fb;
    state.account = acct;
    state.role = acct.profile.role;

    $('#account').hidden = false;
    $('#acctRole').textContent = state.role === 'doctor' ? 'Doctor' : 'Patient';
    $('#acctName').textContent = acct.profile.name || u.email;
    $('#btnSignOut').addEventListener('click', async () => {
      fb.setAuthNotice({ code: 'signed-out' });
      await fb.signOut(fb.auth);
    });

    try {
      if (state.role === 'doctor') {
        $('#navPatients').hidden = false;
        const snap = await fb.get(fb.ref(fb.db, 'patients'));
        state.patients = snap.val() || {};
        state.pid = params.get('patient') && state.patients[params.get('patient')] ? params.get('patient') : Object.keys(state.patients)[0] || null;
      } else {
        state.pid = u.uid;
        state.patients = { [u.uid]: (await fb.get(fb.ref(fb.db, `patients/${u.uid}`))).val() || { name: acct.profile.name } };
      }
    } catch (e) {
      return gateError(fb.accountErrorText(e));
    }
    gate.remove();
    ready(u);
  });
}

function ready(user) {
  // Data source options
  const src = $('#srcSel');
  const opts = [];
  if (user && state.pid) opts.push(['cloud', state.role === 'doctor' ? 'Patient history (cloud)' : 'My history (cloud)']);
  opts.push(['csv', 'Imported CSV file']);
  if (state.session) opts.push(['session', 'Session from the monitor']);
  src.replaceChildren(...opts.map(([v, t]) => h('option', { value: v, text: t })));
  const wanted = params.get('source');
  state.source = opts.some(([v]) => v === wanted) ? wanted : opts[0][0];
  src.value = state.source;

  // Patient picker (doctors)
  if (state.role === 'doctor') {
    const sel = $('#patientSel');
    const list = Object.entries(state.patients).sort((a, b) => (a[1]?.name || '').localeCompare(b[1]?.name || ''));
    sel.replaceChildren(...list.map(([id, p]) => h('option', { value: id, text: p?.name || 'Unnamed patient' })));
    if (state.pid) sel.value = state.pid;
    if (!list.length) setNote('No patients have registered yet. You can still import a CSV file.');
  }
  updateNav();
  wireControls();
  switchSource(state.source, true);
}

function updateNav() {
  $('#navMonitor').href = state.role === 'doctor' && state.pid ? `index.html?patient=${encodeURIComponent(state.pid)}` : 'index.html';
}

// ---------------------------------------------------------------------------
// Controls

function wireControls() {
  $('#srcSel').addEventListener('change', (e) => switchSource(e.target.value));
  $('#patientSel').addEventListener('change', (e) => {
    state.pid = e.target.value;
    state.cloud.key = '';
    const u = new URL(location.href);
    u.searchParams.set('patient', state.pid);
    history.replaceState(null, '', u);
    updateNav();
    defaultCloudRange().then(load);
  });
  $('#presetSel').addEventListener('click', (e) => {
    const p = e.target.dataset && e.target.dataset.preset;
    if (p) applyPreset(p);
  });
  for (const id of ['fromDate', 'toDate']) {
    $('#' + id).addEventListener('change', () => {
      const f = $('#fromDate').value, t = $('#toDate').value;
      if (!f || !t) return;
      let from = fromDateInput(f), to = fromDateInput(t) + DAY - 1;
      if (from > to) [from, to] = [startOfDay(to), from + DAY - 1];
      setRange(from, to, null);
      load();
    });
  }

  // CSV import
  const drop = $('#dropZone'), input = $('#fileInput');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    importFiles([...input.files]);
    input.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    importFiles([...e.dataTransfer.files]);
  });
  $('#btnClearCsv').addEventListener('click', () => {
    state.csv = [];
    state.csvFiles = [];
    updateImportInfo();
    load();
  });
  $('#csvName').addEventListener('input', () => state.view === 'report' && renderReport());

  // Tabs
  $('#tabAnalysis').addEventListener('click', () => setView('analysis'));
  $('#tabReport').addEventListener('click', () => setView('report'));
  $('#reportMode').addEventListener('change', renderReport);
  $('#btnPrint').addEventListener('click', () => {
    if (state.view !== 'report') setView('report');
    window.print();
  });

  window.addEventListener('storage', (e) => {
    if (e.key === 'pm.th') {
      state.th = loadThresholds();
      render();
    }
  });
}

function setView(v) {
  state.view = v;
  $('#tabAnalysis').setAttribute('aria-selected', String(v === 'analysis'));
  $('#tabReport').setAttribute('aria-selected', String(v === 'report'));
  $('#viewAnalysis').hidden = v !== 'analysis';
  $('#viewReport').hidden = v !== 'report';
  if (v === 'report') renderReport();
  else render();
}

async function switchSource(src, initial = false) {
  state.source = src;
  $('#csvBox').hidden = src !== 'csv';
  $('#patientWrap').hidden = !(src === 'cloud' && state.role === 'doctor');
  $('#presetAll').hidden = src === 'cloud';
  if (src === 'cloud') {
    await defaultCloudRange();
  } else {
    const recs = src === 'csv' ? state.csv : state.session ? state.session.records : [];
    if (recs.length) applyPreset('all', false);
    else applyPreset('today', false);
  }
  if (src === 'csv') updateImportInfo();
  if (!initial || src !== 'cloud' || state.pid) load();
}

function setRange(from, to, preset) {
  state.from = from;
  state.to = to;
  $('#fromDate').value = toDateInput(from);
  $('#toDate').value = toDateInput(to);
  $$('#presetSel button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === preset)));
}

function applyPreset(p, reload = true) {
  const today = startOfDay(Date.now());
  if (p === 'today') setRange(today, today + DAY - 1, p);
  else if (p === 'yesterday') setRange(today - DAY, today - 1, p);
  else if (p === '7' || p === '30') setRange(today - (Number(p) - 1) * DAY, today + DAY - 1, p);
  else if (p === 'all') {
    const recs = sourceRecords();
    if (!recs.length) return setNote('Nothing to show yet: import a CSV file first.');
    setRange(startOfDay(recs[0].ts), startOfDay(recs[recs.length - 1].ts) + DAY - 1, p);
  }
  if (reload) load();
}

/* Cloud: open on the most recent day that has readings (or today). */
async function defaultCloudRange() {
  let ts = null;
  if (state.fb && state.pid) {
    try {
      const l = (await state.fb.get(state.fb.ref(state.fb.db, `latest/${state.pid}`))).val();
      if (l && typeof l.ts === 'number') ts = l.ts;
    } catch {}
  }
  const day = startOfDay(ts || Date.now());
  setRange(day, day + DAY - 1, day === startOfDay(Date.now()) ? 'today' : null);
}

const sourceRecords = () =>
  state.source === 'csv' ? state.csv : state.source === 'session' ? state.session?.records || [] : state.cloud.records;

// ---------------------------------------------------------------------------
// Loading

async function importFiles(files) {
  const csvs = files.filter((f) => /\.csv$/i.test(f.name) || f.type === 'text/csv');
  if (!csvs.length) return setNote('Please choose .csv files.', true);
  const problems = [];
  for (const f of csvs) {
    if (f.size > 50 * 1024 * 1024) {
      problems.push(`${f.name}: larger than 50 MB`);
      continue;
    }
    const res = importCSV(await f.text());
    if (res.error) {
      problems.push(`${f.name}: ${res.error}`);
      continue;
    }
    state.csv = mergeRecords(state.csv, res.records);
    state.csvFiles.push({ name: f.name, count: res.records.length, skipped: res.skipped, found: res.found });
    if (res.patientId && !$('#csvName').value) $('#csvName').value = res.patientId;
  }
  updateImportInfo();
  if (problems.length) setNote('Not imported: ' + problems.join(' · '), true);
  else setNote('');
  if (state.csv.length) applyPreset('all');
}

function updateImportInfo() {
  const info = $('#importInfo');
  $('#btnClearCsv').hidden = !state.csv.length;
  if (!state.csv.length) {
    info.textContent = 'No file imported yet.';
    return;
  }
  const first = state.csv[0].ts, last = state.csv[state.csv.length - 1].ts;
  const files = state.csvFiles.map((f) => f.name).join(', ');
  info.replaceChildren(
    h('b', { text: `${fmt.num(state.csv.length)} readings` }),
    ` from ${fmt.dateTime(first)} to ${fmt.dateTime(last)}`,
    h('br'),
    h('span', { class: 'muted', text: files }),
  );
}

async function load() {
  setNote('');
  if (state.source === 'cloud') {
    if (!state.pid) {
      state.records = [];
      return render();
    }
    const key = `${state.pid}|${state.from}|${state.to}`;
    if (state.cloud.key !== key) {
      document.body.classList.add('an-loading');
      try {
        const { db, ref, get, query, orderByChild, startAt, endAt } = state.fb;
        const [vs, as] = await Promise.all([
          get(query(ref(db, `vitals/${state.pid}`), orderByChild('ts'), startAt(state.from), endAt(state.to))),
          get(query(ref(db, `alerts/${state.pid}`), orderByChild('at'), startAt(state.from), endAt(state.to))).catch(() => null),
        ]);
        const recs = [];
        vs.forEach((c) => {
          const v = c.val() || {};
          if (typeof v.ts === 'number') {
            recs.push({
              ts: v.ts, hr: v.hr ?? null, spo2: v.spo2 ?? null, temp: v.temp ?? null, motion: v.motion ?? null,
              steps: v.steps ?? null, finger: v.finger ?? null, fall: v.fall ?? 0, eng: v.eng ?? null,
            });
          }
        });
        recs.sort((a, b) => a.ts - b.ts);
        const alerts = [];
        if (as) as.forEach((c) => { alerts.push({ id: c.key, ...c.val() }); });
        state.cloud = { records: recs, alerts: alerts.sort((a, b) => a.at - b.at), key };
      } catch (e) {
        state.cloud = { records: [], alerts: [], key: '' };
        setNote(state.fb.isPermissionError(e) ? 'Access denied by the database rules.' : 'Could not load data: ' + e.message, true);
      } finally {
        document.body.classList.remove('an-loading');
      }
    }
    state.records = state.cloud.records;
  } else {
    state.records = sourceRecords().filter((r) => r.ts >= state.from && r.ts <= state.to);
  }
  if (state.source === 'cloud' && state.records.length >= 200000) setNote('Very long period: showing the first 200,000 readings.');
  render();
}

// ---------------------------------------------------------------------------
// Analysis view

function render() {
  if (state.view === 'report') return renderReport();
  const recs = state.records;
  const empty = $('#anEmpty'), content = $('#anContent');
  if (!recs.length) {
    content.hidden = true;
    empty.hidden = false;
    empty.replaceChildren(...emptyMessage());
    return;
  }
  empty.hidden = true;
  content.hidden = false;

  const a = analyze(recs, state.th);
  const days = byDay(recs, state.th);
  const sameDay = days.length === 1;

  // Verdict
  const v = overall(a);
  $('#verdict').className = `an-verdict st-${v.level}`;
  $('#verdict').replaceChildren(
    statusChip(v.level, v.level === 'good' ? 'All normal' : STATUS_TEXT[v.level]),
    h('span', { class: 'an-verdict-text', text: v.text }),
    h('span', { class: 'muted small', text: `${fmt.num(a.count)} readings · ${fmt.dur(a.measuredMs)} recorded · ${periodText(sameDay)}` }),
    nextStepsBlock(a),
  );

  // Stat tiles
  const tiles = [];
  for (const s of Object.values(a.vitals)) {
    tiles.push(h('div', { class: 'an-tile' },
      h('span', { class: 'an-tile-label' }, h('i', { class: 'an-swatch', style: `--c: var(${s.def.colorVar})` }), s.def.label),
      h('span', { class: 'an-tile-value', text: s.n ? withUnit(s.mean, s.def) : '—' }),
      h('span', { class: 'an-tile-sub', text: s.n ? `Average. Lowest ${withUnit(s.min.v, s.def)}, highest ${withUnit(s.max.v, s.def)}` : 'No readings' }),
      h('span', { class: 'an-tile-sub', text: `Normal: ${rangeText(s.def, state.th)}` }),
      statusChip(s.n ? s.status : 'none'),
    ));
  }
  tiles.push(h('div', { class: 'an-tile' },
    h('span', { class: 'an-tile-label' }, h('i', { class: 'an-swatch', style: '--c: var(--c-motion)' }), 'Steps'),
    h('span', { class: 'an-tile-value', text: a.steps != null ? fmt.num(a.steps) : '—' }),
    h('span', { class: 'an-tile-sub', text: a.activePct != null ? `Moving ${fmt.num(a.activePct)}% of the time` : 'No movement data' }),
  ));
  tiles.push(h('div', { class: 'an-tile' },
    h('span', { class: 'an-tile-label', text: 'Engagement score' }),
    h('span', { class: 'an-tile-value', text: a.engagement != null ? `${fmt.num(a.engagement)}/100` : '—' }),
    h('span', { class: 'an-tile-sub', text: a.wornPct != null ? `Sensor worn ${fmt.num(a.wornPct)}% of the time` : '' }),
    a.engagement != null ? statusChip(a.engagementLevel === 'good' ? 'good' : a.engagementLevel === 'moderate' ? 'watch' : 'concern',
      { good: 'Good', moderate: 'Moderate', low: 'Low' }[a.engagementLevel]) : null,
  ));
  $('#tiles').replaceChildren(...tiles);

  // Insights
  $('#insights').replaceChildren(...insightItems(a, sameDay));

  // Time in range
  $('#tirList').replaceChildren(...Object.values(a.vitals).map((s) => {
    const row = h('div', { class: 'tir-row' },
      h('div', { class: 'tir-head' }, h('b', { text: s.def.label }), h('span', { class: 'muted small', text: `normal: ${rangeText(s.def, state.th)}` })));
    const box = h('div');
    row.append(box);
    if (s.n) rangeBar(box, { pctLow: s.pctLow, pctNormal: s.pctNormal, pctHigh: s.pctHigh, hasHigh: s.def.hi(state.th) != null, label: s.def.short });
    else box.append(h('p', { class: 'muted small', text: 'No readings' }));
    return row;
  }));

  // Trends
  renderTrends($('#trends'), recs, 200, true);

  // Day by day
  renderDaily(days);

  // Events
  renderEvents($('#eventsTable'), a, sameDay);
  $('#eventsNote').textContent = a.events.length
    ? 'Episodes shorter than 10 seconds are not listed.'
    : 'No out-of-range episodes (of 10 seconds or longer) in this period.';
}

function emptyMessage() {
  if (state.source === 'csv' && !state.csv.length) {
    return [h('h2', { text: 'Import a CSV file to analyse it' }),
      h('p', { class: 'muted', text: 'Use "Export data (CSV)" on the monitor page, then drop the file in the box above. Several files can be combined.' })];
  }
  if (state.source === 'cloud' && !state.pid) {
    return [h('h2', { text: 'No patient selected' }), h('p', { class: 'muted', text: 'Patients appear here after they create an account.' })];
  }
  return [h('h2', { text: 'No readings in this period' }),
    h('p', { class: 'muted', text: state.source === 'cloud'
      ? 'Readings are saved while the monitor is connected to the device (or in Demo mode). Try "7 days" or "30 days".'
      : 'Choose a different period, or "All".' })];
}

function periodText(sameDay) {
  return sameDay || startOfDay(state.from) === startOfDay(state.to)
    ? fmt.date(state.from)
    : `${fmt.date(state.from)} – ${fmt.date(state.to)}`;
}

const TREND_DEFS = [
  ...Object.values(VITALS),
  { key: 'motion', short: 'Movement', label: 'Movement', unit: 'g', decimals: 2, colorVar: '--c-motion',
    axis: { min: 0, max: 0.2, step: 0.05 }, explain: 'How much the patient moved (0 = still). Above about 0.05 g counts as active.' },
];

function renderTrends(host, recs, height, withExplain, from = state.from, to = state.to) {
  host.replaceChildren(...TREND_DEFS.map((def) => {
    const ds = downsample(recs, def.key, 700);
    const chart = h('div', { class: 'an-chart' });
    const block = h('div', { class: 'an-trend' },
      h('div', { class: 'an-trend-head' },
        h('span', { class: 'an-trend-title' }, h('i', { class: 'an-line-key', style: `--c: var(${def.colorVar})` }), def.label, h('em', { text: def.unit })),
        withExplain ? h('span', { class: 'muted small', text: def.explain }) : null),
      chart);
    queueMicrotask(() => lineChart(chart, {
      points: ds.points, bucketed: ds.bucketed, gapMs: ds.gapMs, from, to,
      band: def.lo ? [def.lo(state.th), def.hi(state.th)] : null,
      colorVar: def.colorVar, unit: def.unit, decimals: def.decimals, axis: def.axis, height, label: def.short,
    }));
    return block;
  }));
}

function dayRows(days) {
  return days.map(({ day, a }) => ({ day, label: fmt.day(day), a }));
}

function renderDaily(days) {
  const charts = $('#dailyCharts');
  const rows = dayRows(days);
  if (days.length >= 2) {
    $('#dailyHint').textContent = 'Bar = lowest to highest that day · dot = average';
    charts.hidden = false;
    const blocks = Object.values(VITALS).map((def) => {
      const c = h('div', { class: 'an-chart' });
      queueMicrotask(() => dailyRange(c, {
        days: rows.map((r) => {
          const s = r.a.vitals[def.key];
          return { key: r.day, label: r.label, mean: s.n ? s.mean : null, min: s.n ? s.min.v : null, max: s.n ? s.max.v : null };
        }),
        band: [def.lo(state.th), def.hi(state.th)], colorVar: def.colorVar, unit: def.unit, decimals: def.decimals, axis: def.axis, label: def.short,
      }));
      return h('div', { class: 'an-trend' },
        h('div', { class: 'an-trend-head' }, h('span', { class: 'an-trend-title' }, h('i', { class: 'an-swatch', style: `--c: var(${def.colorVar})` }), def.short, h('em', { text: def.unit }))), c);
    });
    const sc = h('div', { class: 'an-chart' });
    queueMicrotask(() => dailyColumns(sc, { days: rows.map((r) => ({ label: r.label, value: r.a.steps })), colorVar: '--c-motion', unit: 'steps', label: 'Steps' }));
    blocks.push(h('div', { class: 'an-trend' },
      h('div', { class: 'an-trend-head' }, h('span', { class: 'an-trend-title' }, h('i', { class: 'an-swatch', style: '--c: var(--c-motion)' }), 'Steps per day')), sc));
    charts.replaceChildren(...blocks);
  } else {
    charts.hidden = true;
    charts.replaceChildren();
    $('#dailyHint').textContent = 'Choose a longer period (e.g. 7 days) to compare days';
  }
  fillDailyTable($('#dailyTable'), rows);
}

function fillDailyTable(table, rows) {
  const v = (s, which) => (s.n ? withUnit(which === 'mean' ? s.mean : s[which].v, s.def) : '—');
  table.replaceChildren(
    h('thead', {}, h('tr', {},
      ...['Date', 'Recorded', 'Heart rate: average (range)', 'SpO₂: average (lowest)', 'Temperature: average (highest)', 'Steps', 'Engagement', 'Events', 'Status']
        .map((t, i) => h('th', { class: i && i < 8 ? 'num' : null, scope: 'col', text: t })))),
    h('tbody', {}, ...rows.map(({ label, a }) => {
      const hr = a.vitals.hr, sp = a.vitals.spo2, tp = a.vitals.temp;
      const ov = overall(a);
      return h('tr', {},
        h('th', { scope: 'row', text: label }),
        h('td', { class: 'num', text: fmt.dur(a.measuredMs) }),
        h('td', { class: 'num', text: hr.n ? `${v(hr, 'mean')} (${fmt.num(hr.min.v)}–${fmt.num(hr.max.v)})` : '—' }),
        h('td', { class: 'num', text: sp.n ? `${v(sp, 'mean')} (${v(sp, 'min')})` : '—' }),
        h('td', { class: 'num', text: tp.n ? `${v(tp, 'mean')} (${v(tp, 'max')})` : '—' }),
        h('td', { class: 'num', text: a.steps != null ? fmt.num(a.steps) : '—' }),
        h('td', { class: 'num', text: a.engagement != null ? fmt.num(a.engagement) : '—' }),
        h('td', { class: 'num', text: String(a.events.length) }),
        h('td', {}, statusChip(ov.level, ov.level === 'good' ? 'Normal' : STATUS_TEXT[ov.level])),
      );
    })),
  );
}

function renderEvents(table, a, sameDay) {
  const when = (ts) => (sameDay ? fmt.time(ts) : fmt.dateTime(ts));
  if (!a.events.length) {
    table.replaceChildren();
    return;
  }
  table.replaceChildren(
    h('thead', {}, h('tr', {}, ...['When', 'What', 'How long', 'Worst value', 'Severity'].map((t, i) => h('th', { scope: 'col', class: i === 2 || i === 3 ? 'num' : null, text: t })))),
    h('tbody', {}, ...a.events.map((e) => {
      const def = VITALS[e.vital];
      return h('tr', {},
        h('td', { text: when(e.start) }),
        h('td', { text: EVENT_NAME[e.vital][e.kind] }),
        h('td', { class: 'num', text: e.kind === 'fall' ? '—' : fmt.dur(e.end - e.start) }),
        h('td', { class: 'num', text: def ? withUnit(e.worst, def) : e.count > 1 ? `${e.count} signals` : '—' }),
        h('td', {}, statusChip(e.critical ? 'concern' : 'watch', e.critical ? 'Serious' : 'Mild')),
      );
    })),
  );
}

// ---------------------------------------------------------------------------
// Report (printable)

function patientInfo() {
  if (state.source === 'cloud' && state.pid) {
    const p = state.patients[state.pid] || {};
    return { name: p.name || 'Unnamed patient', details: [p.age != null ? `${p.age} years` : null, p.gender, p.email].filter(Boolean).join(' · ') };
  }
  if (state.source === 'session' && state.session) {
    const p = state.session.patient || {};
    return { name: p.name || p.id || 'Patient', details: p.id && p.name ? `ID ${p.id}` : '' };
  }
  return { name: $('#csvName').value.trim() || 'Patient', details: state.csvFiles.length ? `Imported from ${state.csvFiles.map((f) => f.name).join(', ')}` : '' };
}

const SOURCE_TEXT = { cloud: 'Cloud history (Firebase)', csv: 'Imported CSV file', session: 'Monitor session' };

function renderReport() {
  const wrap = $('#reportWrap');
  const recs = state.records;
  if (!recs.length) {
    wrap.replaceChildren(h('div', { class: 'panel an-emptystate' }, ...emptyMessage()));
    return;
  }
  const mode = $('#reportMode').value;
  if (mode === 'daily') {
    const days = byDay(recs, state.th);
    wrap.replaceChildren(...days.map(({ day }, i) => {
      const from = fromDateInput(day);
      const list = recs.filter((r) => r.ts >= from && r.ts < from + DAY);
      return reportPage(list, from, from + DAY - 1, `Daily vitals report · day ${i + 1} of ${days.length}`);
    }));
  } else {
    wrap.replaceChildren(reportPage(recs, state.from, state.to, 'Vitals report'));
  }
}

function reportPage(recs, from, to, title) {
  const a = analyze(recs, state.th);
  const days = byDay(recs, state.th);
  const sameDay = days.length === 1;
  const p = patientInfo();
  const v = overall(a);
  const period = startOfDay(from) === startOfDay(to) ? fmt.date(from) : `${fmt.date(from)} – ${fmt.date(to)}`;

  const meta = [
    ['Patient', p.name],
    ['Details', p.details || '—'],
    ['Period', period],
    ['Data source', SOURCE_TEXT[state.source]],
    ['Readings', `${fmt.num(a.count)} (${fmt.dur(a.measuredMs)} recorded, ${sameDay ? `${fmt.time(a.first)}–${fmt.time(a.last)}` : `${fmt.dateTime(a.first)} – ${fmt.dateTime(a.last)}, on ${days.length} days`})`],
    ['Sensor worn', a.wornPct != null ? `${fmt.num(a.wornPct)}% of the recorded time` : '—'],
  ];

  const keyRows = Object.values(a.vitals).map((s) => h('tr', {},
    h('th', { scope: 'row', text: s.def.label }),
    h('td', { class: 'num', text: s.n ? withUnit(s.mean, s.def) : '—' }),
    h('td', { class: 'num', text: s.n ? withUnit(s.min.v, s.def) : '—' }),
    h('td', { class: 'num', text: s.n ? withUnit(s.max.v, s.def) : '—' }),
    h('td', { class: 'num', text: s.n ? `${fmt.num(s.p10, s.def.decimals)}–${withUnit(s.p90, s.def)}` : '—' }),
    h('td', { class: 'num', text: rangeText(s.def, state.th) }),
    h('td', { class: 'num', text: s.n ? `${fmt.num(s.pctNormal)}%` : '—' }),
    h('td', {}, statusChip(s.n ? s.status : 'none')),
  ));
  keyRows.push(h('tr', {},
    h('th', { scope: 'row', text: 'Steps' }),
    h('td', { class: 'num', text: a.steps != null ? fmt.num(a.steps) : '—' }),
    h('td', { colspan: 5, class: 'muted', text: a.activePct != null ? `Moving ${fmt.num(a.activePct)}% of the recorded time` : 'No movement data' }),
    h('td', {}),
  ));
  if (a.engagement != null) {
    keyRows.push(h('tr', {},
      h('th', { scope: 'row', text: 'Engagement score' }),
      h('td', { class: 'num', text: `${fmt.num(a.engagement)}/100` }),
      h('td', { colspan: 5, class: 'muted', text: 'Combines sensor wear, activity, vitals in range and data continuity' }),
      h('td', {}, statusChip(a.engagementLevel === 'good' ? 'good' : a.engagementLevel === 'moderate' ? 'watch' : 'concern', { good: 'Good', moderate: 'Moderate', low: 'Low' }[a.engagementLevel])),
    ));
  }

  const trends = h('div', { class: 'rep-trends' });
  renderTrends(trends, recs, 150, false, from, to);  // this page's own period

  const eventsTable = h('table', { class: 'an-table' });
  renderEvents(eventsTable, a, sameDay);

  const sections = [
    h('header', { class: 'rep-head' },
      h('div', { class: 'rep-brand' },
        h('svg', {}),
        h('div', {}, h('h2', { text: title }), h('p', { class: 'muted small', text: `Generated ${new Date().toLocaleString()} · Smart Patient Monitor` }))),
      h('div', { class: 'rep-patient' }, h('b', { text: p.name }), h('span', { class: 'muted small', text: period }))),
    h('table', { class: 'rep-meta' }, h('tbody', {}, ...meta.map(([k, val]) => h('tr', {}, h('th', { scope: 'row', text: k }), h('td', { text: val }))))),
    h('section', { class: 'rep-section' },
      h('h3', { text: 'Summary' }),
      h('div', { class: `an-verdict st-${v.level}` }, statusChip(v.level, v.level === 'good' ? 'All normal' : STATUS_TEXT[v.level]), h('span', { class: 'an-verdict-text', text: v.text }), nextStepsBlock(a)),
      h('ul', { class: 'insights' }, ...insightItems(a, sameDay))),
    h('section', { class: 'rep-section' },
      h('h3', { text: 'Key measurements' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'an-table' },
        h('thead', {}, h('tr', {}, ...['Measure', 'Average', 'Lowest', 'Highest', 'Typical (10–90%)', 'Normal range', 'Time in range', 'Status']
          .map((t, i) => h('th', { scope: 'col', class: i && i < 7 ? 'num' : null, text: t })))),
        h('tbody', {}, ...keyRows)))),
    h('section', { class: 'rep-section rep-break-ok' },
      h('h3', { text: 'Trends' }),
      h('p', { class: 'muted small', text: 'Shaded band = normal range. Dashed line = gap between recordings.' }),
      trends),
  ];
  if (!sameDay) {
    const t = h('table', { class: 'an-table' });
    fillDailyTable(t, dayRows(days));
    sections.push(h('section', { class: 'rep-section' }, h('h3', { text: 'Day by day' }), h('div', { class: 'table-wrap' }, t)));
  }
  sections.push(h('section', { class: 'rep-section' },
    h('h3', { text: 'Events to review' }),
    a.events.length ? h('div', { class: 'table-wrap' }, eventsTable) : h('p', { class: 'muted', text: 'No out-of-range episodes (of 10 seconds or longer) in this period.' })));

  if (state.source === 'cloud') {
    const alerts = state.cloud.alerts.filter((x) => x.at >= from && x.at <= to);
    sections.push(h('section', { class: 'rep-section' },
      h('h3', { text: 'Alerts raised by the monitor' }),
      alerts.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'an-table' },
            h('thead', {}, h('tr', {}, ...['When', 'Alert', 'Severity', 'Resolved', 'Acknowledged by'].map((x) => h('th', { scope: 'col', text: x })))),
            h('tbody', {}, ...alerts.map((x) => h('tr', {},
              h('td', { text: sameDay ? fmt.time(x.at) : fmt.dateTime(x.at) }),
              h('td', { text: x.message || x.rule }),
              h('td', {}, statusChip(x.severity === 'critical' ? 'concern' : 'watch', x.severity === 'critical' ? 'Critical' : 'Warning')),
              h('td', { text: x.resolvedAt ? fmt.time(x.resolvedAt) : x.rule === 'fall' || x.rule === 'link' ? '—' : 'No' }),
              h('td', { text: x.ackedBy || '—' }))))))
        : h('p', { class: 'muted', text: 'No alerts in this period.' })));
  }

  sections.push(h('footer', { class: 'rep-foot muted small' },
    h('p', { text: `Normal ranges used: heart rate ${rangeText(VITALS.hr, state.th)}, SpO₂ ${rangeText(VITALS.spo2, state.th)}, temperature ${rangeText(VITALS.temp, state.th)}. They follow the alert thresholds set on the monitor page.` }),
    h('p', { text: 'Readings come from low-cost wearable sensors (student prototype) and are not a medical diagnosis. Discuss any concerns with a doctor.' })));

  const page = h('article', { class: 'report' }, ...sections);
  // Brand mark (SVG must be created in the SVG namespace)
  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('viewBox', '0 0 24 24');
  mark.setAttribute('class', 'brand-mark');
  mark.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3 12h4l2-5 4 10 2-5h6');
  mark.append(path);
  page.querySelector('.rep-brand > svg').replaceWith(mark);
  return page;
}

// Print layout changes the width: redraw charts at their printed size.
window.addEventListener('beforeprint', () => document.body.classList.add('printing'));
window.addEventListener('afterprint', () => document.body.classList.remove('printing'));

start();
