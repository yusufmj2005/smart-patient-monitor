/* Vitals analysis: CSV import, statistics, out-of-range episodes, day-by-day summaries
   and plain-language insights. Pure functions (no DOM), shared by the analysis view and
   the printable report.

   A record is { ts, hr, spo2, temp, motion, steps, finger, fall, eng } — the same shape
   the dashboard uploads to Firebase and exports as CSV. Missing values are null. */

export const DEFAULT_TH = { hrMin: 50, hrMax: 120, spo2Min: 92, tempMin: 35.0, tempMax: 38.0, engMin: 40 };

/* Same thresholds the monitor uses (saved by its "Alert thresholds" panel). */
export function loadThresholds() {
  try {
    return Object.assign({}, DEFAULT_TH, JSON.parse(localStorage.getItem('pm.th') || '{}'));
  } catch {
    return Object.assign({}, DEFAULT_TH);
  }
}

export const ACTIVE_G = 0.05;

/* The vitals that have a normal range. lo/hi = normal range, critLo/critHi = clearly abnormal. */
export const VITALS = {
  hr: {
    key: 'hr', label: 'Heart rate', short: 'Heart rate', unit: 'bpm', decimals: 0, colorVar: '--c-hr',
    lo: (th) => th.hrMin, hi: (th) => th.hrMax,
    critLo: (th) => th.hrMin - 10, critHi: (th) => th.hrMax + 20,
    axis: { min: 40, max: 140, step: 20 },
    explain: 'How many times the heart beats per minute. At rest, 60–100 bpm is typical for adults.',
  },
  spo2: {
    key: 'spo2', label: 'Blood oxygen (SpO₂)', short: 'SpO₂', unit: '%', decimals: 0, colorVar: '--c-spo2',
    lo: (th) => th.spo2Min, hi: () => null,
    critLo: (th) => th.spo2Min - 4, critHi: () => null,
    axis: { min: 90, max: 100, step: 2 },
    explain: 'How much oxygen the blood is carrying. 95–100% is normal; below 92% needs attention.',
  },
  temp: {
    key: 'temp', label: 'Temperature', short: 'Temperature', unit: '°C', decimals: 1, colorVar: '--c-temp',
    lo: (th) => th.tempMin, hi: (th) => th.tempMax,
    critLo: () => null, critHi: (th) => th.tempMax + 1.5,
    axis: { min: 35, max: 38.5, step: 0.5 },
    explain: 'Skin temperature measured by the sensor. About 36–37.5 °C is normal; 38 °C or more suggests a fever.',
  },
};

// ---------------------------------------------------------------------------
// CSV import

/* RFC 4180-style parser: quoted fields, escaped quotes, CRLF/LF, BOM. */
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const sep = guessSeparator(text);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = []; field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/* Comma, semicolon (European Excel) or tab: whichever splits the header line most. */
function guessSeparator(text) {
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  let best = ',', bestN = 0;
  for (const ch of [',', ';', '\t']) {
    const n = first.split(ch).length - 1;
    if (n > bestN) { best = ch; bestN = n; }
  }
  return best;
}

/* Accepted column names (after lower-casing and turning spaces/dashes into _). */
const COLUMN_ALIASES = {
  ts: ['timestamp', 'time', 'datetime', 'date_time', 'date', 'ts', 'recorded_at', 'time_stamp'],
  hr: ['heart_rate_bpm', 'heart_rate', 'heartrate', 'hr', 'bpm', 'pulse', 'pulse_rate'],
  spo2: ['spo2_pct', 'spo2', 'sp02', 'spo2_%', 'oxygen', 'o2', 'oxygen_saturation'],
  temp: ['temp_c', 'temperature_c', 'temperature', 'temp', 'body_temp', 'body_temperature'],
  motion: ['motion_g', 'motion', 'movement', 'movement_g'],
  steps: ['steps', 'step_count'],
  finger: ['finger_on', 'finger', 'worn', 'sensor_worn'],
  fall: ['fall', 'fall_detected', 'falls'],
  eng: ['engagement_score', 'engagement', 'eng', 'score'],
  pid: ['patient_id', 'patient', 'pid', 'patient_name'],
};

const normHeader = (h) => h.trim().toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^\w%]/g, '');

/* Parses a timestamp cell: ISO text, "YYYY-MM-DD HH:MM[:SS]", "DD/MM/YYYY HH:MM[:SS]", or epoch (s or ms). */
export function parseTime(v) {
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1e12) return Math.round(n);        // epoch ms
    if (n > 1e9) return Math.round(n * 1000);  // epoch seconds
    return null;
  }
  const dmy = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) {
    const [, d, m, y, hh = 0, mm = 0, ss = 0] = dmy;
    const t = new Date(+y, +m - 1, +d, +hh, +mm, +ss).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s);
  return Number.isFinite(t) ? t : null;
}

const toNum = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || /^(null|nan|na|n\/a|-)$/i.test(s)) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/* Converts CSV text into records. Returns { records, patientId, found, skipped } or { error }. */
export function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { error: 'The file has no data rows.' };
  const headers = rows[0].map(normHeader);
  const col = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = headers.findIndex((h) => aliases.includes(h));
    if (idx >= 0) col[field] = idx;
  }
  if (col.ts == null) return { error: 'No time column found. Expected a column named "timestamp" (or time / date).' };
  const vitalCols = ['hr', 'spo2', 'temp', 'motion', 'steps'].filter((f) => col[f] != null);
  if (!vitalCols.length) return { error: 'No vitals columns found. Expected e.g. heart_rate_bpm, spo2_pct, temp_c.' };

  const records = [];
  let skipped = 0, patientId = null;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const ts = parseTime(row[col.ts]);
    if (ts == null) { skipped++; continue; }
    const get = (f) => (col[f] == null ? null : toNum(row[col[f]]));
    records.push({
      ts,
      hr: get('hr'), spo2: get('spo2'), temp: get('temp'), motion: get('motion'), steps: get('steps'),
      finger: col.finger == null ? null : get('finger') ? 1 : 0,
      fall: get('fall') ? 1 : 0,
      eng: get('eng'),
    });
    if (!patientId && col.pid != null && row[col.pid]) patientId = String(row[col.pid]).trim();
  }
  if (!records.length) return { error: 'No rows with a readable time were found.' };
  records.sort((a, b) => a.ts - b.ts);
  return { records, patientId, found: Object.keys(col).filter((f) => f !== 'pid'), skipped };
}

/* Merges record lists, sorted by time, dropping exact-time duplicates. */
export function mergeRecords(...lists) {
  const all = lists.flat().sort((a, b) => a.ts - b.ts);
  return all.filter((r, i) => i === 0 || r.ts !== all[i - 1].ts);
}

// ---------------------------------------------------------------------------
// Statistics

/* Each reading stands for the time until the next one, capped so gaps between
   recording sessions don't count as measured time. */
function weights(recs) {
  const gaps = [];
  for (let i = 1; i < recs.length && gaps.length < 500; i++) gaps.push(recs[i].ts - recs[i - 1].ts);
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[gaps.length >> 1] : 1000;
  const cap = Math.max(5000, median * 3);
  const w = new Array(recs.length);
  for (let i = 0; i < recs.length; i++) {
    const next = recs[i + 1];
    w[i] = next ? Math.min(Math.max(next.ts - recs[i].ts, 0), cap) : Math.min(median, cap);
  }
  return { w, cap };
}

const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

function classify(def, th, v) {
  const lo = def.lo(th), hi = def.hi(th);
  if (lo != null && v < lo) return 'low';
  if (hi != null && v > hi) return 'high';
  return 'normal';
}

/* Out-of-range episodes for one vital: consecutive out-of-range readings (same side),
   at least minMs long. */
function findEpisodes(recs, w, cap, def, th, minMs = 10000) {
  const out = [];
  let cur = null;
  const close = () => {
    if (cur && cur.end - cur.start >= minMs) out.push(cur);
    cur = null;
  };
  for (let i = 0; i < recs.length; i++) {
    const v = recs[i][def.key];
    if (v == null) continue;
    const kind = classify(def, th, v);
    if (kind === 'normal') { close(); continue; }
    if (cur && (cur.kind !== kind || recs[i].ts - cur.end > cap)) close();
    if (!cur) cur = { vital: def.key, kind, start: recs[i].ts, end: recs[i].ts, worst: v, worstTs: recs[i].ts };
    cur.end = recs[i].ts + w[i];
    if ((kind === 'high' && v > cur.worst) || (kind === 'low' && v < cur.worst)) {
      cur.worst = v;
      cur.worstTs = recs[i].ts;
    }
  }
  close();
  for (const e of out) {
    const cl = def.critLo(th), ch = def.critHi(th);
    e.critical = (e.kind === 'low' && cl != null && e.worst <= cl) || (e.kind === 'high' && ch != null && e.worst >= ch);
  }
  return out;
}

function vitalStats(recs, w, cap, def, th) {
  const vals = [];
  let wTotal = 0, wLow = 0, wHigh = 0, sum = 0;
  let min = null, max = null;
  for (let i = 0; i < recs.length; i++) {
    const v = recs[i][def.key];
    if (v == null) continue;
    vals.push(v);
    sum += v;
    wTotal += w[i];
    const kind = classify(def, th, v);
    if (kind === 'low') wLow += w[i];
    else if (kind === 'high') wHigh += w[i];
    if (!min || v < min.v) min = { v, ts: recs[i].ts };
    if (!max || v > max.v) max = { v, ts: recs[i].ts };
  }
  if (!vals.length) return { def, n: 0 };
  vals.sort((a, b) => a - b);
  const episodes = findEpisodes(recs, w, cap, def, th);
  const pctLow = (wLow / wTotal) * 100;
  const pctHigh = (wHigh / wTotal) * 100;
  const pctNormal = 100 - pctLow - pctHigh;
  const status = episodes.some((e) => e.critical) || pctNormal < 75 ? 'concern'
    : pctNormal < 95 || episodes.length ? 'watch' : 'good';
  return {
    def, n: vals.length, measuredMs: wTotal,
    mean: sum / vals.length, min, max,
    p10: percentile(vals, 0.1), p50: percentile(vals, 0.5), p90: percentile(vals, 0.9),
    pctLow, pctNormal, pctHigh, msLow: wLow, msHigh: wHigh,
    episodes, status,
  };
}

/* Steps from a cumulative counter that restarts at 0 when the device restarts. */
function countSteps(recs) {
  let total = 0, prev = null, any = false;
  for (const r of recs) {
    if (r.steps == null) continue;
    any = true;
    if (prev != null) total += r.steps >= prev ? r.steps - prev : r.steps;
    prev = r.steps;
  }
  return any ? Math.round(total) : null;
}

/* Full analysis of a set of records (already filtered to the period). */
export function analyze(recs, th) {
  if (!recs.length) return { empty: true };
  const { w, cap } = weights(recs);
  const vitals = {};
  for (const key of Object.keys(VITALS)) vitals[key] = vitalStats(recs, w, cap, VITALS[key], th);

  let measuredMs = 0, wornMs = 0, wornKnownMs = 0, activeMs = 0, motionMs = 0, engSum = 0, engN = 0;
  const falls = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    measuredMs += w[i];
    if (r.finger != null) {
      wornKnownMs += w[i];
      if (r.finger) wornMs += w[i];
    }
    if (r.motion != null) {
      motionMs += w[i];
      if (r.motion >= ACTIVE_G) activeMs += w[i];
    }
    if (r.eng != null) { engSum += r.eng; engN++; }
    if (r.fall) falls.push({ vital: 'fall', kind: 'fall', start: r.ts, end: r.ts, critical: true });
  }

  const engagement = engN ? engSum / engN : null;
  return {
    empty: false,
    count: recs.length,
    first: recs[0].ts,
    last: recs[recs.length - 1].ts,
    measuredMs,
    wornPct: wornKnownMs ? (wornMs / wornKnownMs) * 100 : null,
    activePct: motionMs ? (activeMs / motionMs) * 100 : null,
    steps: countSteps(recs),
    engagement,
    engagementLevel: engagement == null ? null : engagement >= 70 ? 'good' : engagement >= th.engMin ? 'moderate' : 'low',
    vitals,
    falls,
    events: [...Object.values(vitals).flatMap((v) => v.episodes || []), ...falls].sort((a, b) => a.start - b.start),
  };
}

/* Local calendar date key, e.g. "2026-10-11". */
export const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* One analysis per calendar day that has data. */
export function byDay(recs, th) {
  const groups = new Map();
  for (const r of recs) {
    const k = dayKey(r.ts);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([day, list]) => ({ day, a: analyze(list, th) }));
}

/* Evenly thins a series to at most maxPoints buckets, keeping each bucket's mean/min/max. */
export function downsample(recs, key, maxPoints = 600) {
  const pts = [];
  for (const r of recs) if (r[key] != null) pts.push({ t: r.ts, v: r[key] });
  if (pts.length <= maxPoints) return { points: pts, bucketed: false };
  const t0 = pts[0].t, span = pts[pts.length - 1].t - t0 || 1;
  const size = span / maxPoints;
  const out = [];
  let b = null;
  for (const p of pts) {
    const idx = Math.min(maxPoints - 1, Math.floor((p.t - t0) / size));
    if (!b || b.idx !== idx) {
      if (b) out.push({ t: b.tSum / b.n, v: b.sum / b.n, min: b.min, max: b.max });
      b = { idx, n: 0, sum: 0, tSum: 0, min: p.v, max: p.v };
    }
    b.n++; b.sum += p.v; b.tSum += p.t;
    if (p.v < b.min) b.min = p.v;
    if (p.v > b.max) b.max = p.v;
  }
  if (b) out.push({ t: b.tSum / b.n, v: b.sum / b.n, min: b.min, max: b.max });
  return { points: out, bucketed: true, gapMs: size * 3 };
}

// ---------------------------------------------------------------------------
// Plain-language summaries

export const fmt = {
  num: (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })),
  dur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  },
  time: (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  dateTime: (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  date: (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
  day: (key) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  },
};

/* "72 bpm", "97%", "36.8 °C" */
export const withUnit = (v, def) => (v == null ? '—' : fmt.num(v, def.decimals) + (def.unit === '%' ? '%' : ' ' + def.unit));

export const STATUS_TEXT = { good: 'Normal', watch: 'Some readings outside range', concern: 'Needs attention', none: 'No data' };

const rangeText = (def, th) => {
  const lo = def.lo(th), hi = def.hi(th);
  return hi == null ? `${withUnit(lo, def)} or more` : `${fmt.num(lo, def.decimals)}–${withUnit(hi, def)}`;
};
export { rangeText };

/* Plain-language findings: [{ level: 'good'|'watch'|'concern'|'info', text }]. */
export function insights(a, th, sameDay) {
  if (a.empty) return [];
  const when = (ts) => (sameDay ? fmt.time(ts) : fmt.dateTime(ts));
  const out = [];

  for (const s of Object.values(a.vitals)) {
    const def = s.def;
    if (!s.n) {
      out.push({ level: 'info', text: `No ${def.short.toLowerCase()} readings in this period.` });
      continue;
    }
    let text = `${def.short} averaged ${withUnit(s.mean, def)} and was in the normal range (${rangeText(def, th)}) ${fmt.num(s.pctNormal)}% of the time.`;
    const highs = s.episodes.filter((e) => e.kind === 'high');
    const lows = s.episodes.filter((e) => e.kind === 'low');
    if (highs.length) {
      const total = highs.reduce((t, e) => t + e.end - e.start, 0);
      text += ` It was high for ${fmt.dur(total)} in ${highs.length} episode${highs.length > 1 ? 's' : ''}, highest ${withUnit(s.max.v, def)} at ${when(s.max.ts)}.`;
    }
    if (lows.length) {
      const total = lows.reduce((t, e) => t + e.end - e.start, 0);
      text += ` It was low for ${fmt.dur(total)} in ${lows.length} episode${lows.length > 1 ? 's' : ''}, lowest ${withUnit(s.min.v, def)} at ${when(s.min.ts)}.`;
    }
    out.push({ level: s.status, text });
  }

  if (a.falls.length) {
    out.push({ level: 'concern', text: `${a.falls.length} possible fall${a.falls.length > 1 ? 's were' : ' was'} detected (${a.falls.map((f) => when(f.start)).join(', ')}).` });
  }
  if (a.steps != null) {
    out.push({ level: 'info', text: `${fmt.num(a.steps)} steps were counted; the patient was moving ${fmt.num(a.activePct)}% of the recorded time.` });
  }
  if (a.engagement != null) {
    const lvl = { good: 'good', moderate: 'moderate', low: 'low' }[a.engagementLevel];
    out.push({
      level: a.engagementLevel === 'good' ? 'good' : a.engagementLevel === 'moderate' ? 'watch' : 'concern',
      text: `Average engagement score was ${fmt.num(a.engagement)} out of 100 (${lvl}).`,
    });
  }
  if (a.wornPct != null && a.wornPct < 80) {
    out.push({ level: 'watch', text: `The sensor was worn only ${fmt.num(a.wornPct)}% of the recorded time, so some readings are missing.` });
  }
  return out;
}

/* One-sentence overall verdict for the top of the report. */
export function overall(a) {
  if (a.empty) return { level: 'none', text: 'No readings in this period.' };
  const st = Object.values(a.vitals).filter((s) => s.n).map((s) => s.status);
  if (a.falls.length || st.includes('concern')) return { level: 'concern', text: 'Some readings need attention. See the details below.' };
  if (st.includes('watch')) return { level: 'watch', text: 'Mostly normal, with some readings outside the normal range.' };
  if (!st.length) return { level: 'none', text: 'No vital-sign readings in this period.' };
  return { level: 'good', text: 'All measured vital signs stayed in the normal range.' };
}
