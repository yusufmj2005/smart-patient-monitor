/* Doctor's patient list: every registered patient with their latest vitals, live. */
import {
  auth, db, onAuthStateChanged, signOut, ref, onValue,
  loadAccount, setAuthNotice, isPermissionError, accountErrorText,
} from './firebase.js';

const $ = (sel) => document.querySelector(sel);

const DEFAULT_TH = { hrMin: 50, hrMax: 120, spo2Min: 92, tempMin: 35.0, tempMax: 38.0, engMin: 40 };
const LIVE_MS = 15000;

let th = DEFAULT_TH;
try {
  th = Object.assign({}, DEFAULT_TH, JSON.parse(localStorage.getItem('pm.th') || '{}'));
} catch {}

let patients = {};
let latest = {};
let started = false;

function gateError(text) {
  const gate = $('#authGate');
  if (!gate) return;
  $('#authGateMsg').textContent = text;
  $('#authGateActions').hidden = false;
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace('login.html');
    return;
  }
  if (started) return;
  let acct;
  try {
    acct = await loadAccount(user);
  } catch (e) {
    gateError(accountErrorText(e));
    return;
  }
  if (!acct.profile) {
    location.replace('login.html');
    return;
  }
  if (acct.profile.role !== 'doctor') {
    location.replace('index.html');
    return;
  }
  if (!acct.verifiedDoctor) {
    setAuthNotice({ code: 'not-verified' });
    await signOut(auth);
    return;
  }
  started = true;
  $('#acctName').textContent = acct.profile.name || user.email;
  $('#authGate').remove();
  subscribe();
});

$('#btnSignOut').addEventListener('click', async () => {
  setAuthNotice({ code: 'signed-out' });
  await signOut(auth);
});

function subscribe() {
  const onErr = (e) => {
    $('#emptyNote').hidden = false;
    $('#emptyNote').textContent = isPermissionError(e)
      ? 'Access denied by the database rules. Make sure the latest database.rules.json is published.'
      : 'Could not load patients: ' + e.message;
  };
  onValue(ref(db, 'patients'), (snap) => {
    patients = snap.val() || {};
    render();
  }, onErr);
  onValue(ref(db, 'latest'), (snap) => {
    latest = snap.val() || {};
    render();
  }, onErr);
  setInterval(render, 5000); // keep "last reading" ages fresh
}

// ---------- Rendering ----------

function statusOf(l, now) {
  if (!l || typeof l.ts !== 'number') return { key: 'none', label: 'No data', rank: 3 };
  const live = now - l.ts <= LIVE_MS;
  const bad = (l.hr != null && (l.hr < th.hrMin || l.hr > th.hrMax))
    || (l.spo2 != null && l.spo2 < th.spo2Min)
    || (l.temp != null && (l.temp < th.tempMin || l.temp > th.tempMax))
    || l.fall;
  const critical = (l.hr != null && (l.hr <= th.hrMin - 10 || l.hr >= th.hrMax + 20))
    || (l.spo2 != null && l.spo2 < th.spo2Min - 4)
    || (l.temp != null && l.temp >= th.tempMax + 1.5)
    || l.fall;
  if (live && critical) return { key: 'critical', label: 'Critical', rank: 0, live };
  if (live && bad) return { key: 'warning', label: 'Attention', rank: 1, live };
  if (live) return { key: 'live', label: 'Live', rank: 2, live };
  return { key: 'offline', label: 'Offline', rank: 3, live };
}

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(Date.now() - ms).toLocaleDateString();
}

const cell = (text, cls) => {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
};

function vitalCell(value, fmt, out, cls) {
  const td = cell(value == null ? '—' : fmt(value), 'num' + (cls ? ' ' + cls : ''));
  if (value != null && out) td.classList.add('out');
  return td;
}

function render() {
  const now = Date.now();
  const q = $('#search').value.trim().toLowerCase();
  const list = Object.entries(patients)
    .map(([id, p]) => ({ id, p: p || {}, l: latest[id], st: statusOf(latest[id], now) }))
    .filter(({ p }) => !q || (p.name || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q))
    .sort((a, b) => a.st.rank - b.st.rank || (a.p.name || '').localeCompare(b.p.name || ''));

  const all = Object.keys(patients).map((id) => statusOf(latest[id], now));
  $('#sumTotal').textContent = all.length;
  $('#sumLive').textContent = all.filter((s) => s.live).length;
  $('#sumAttn').textContent = all.filter((s) => s.key === 'warning' || s.key === 'critical').length;

  const rows = list.map(({ id, p, l, st }) => {
    const tr = document.createElement('tr');
    tr.dataset.href = 'index.html?patient=' + encodeURIComponent(id);
    if (!st.live) tr.classList.add('stale');

    const nameTd = document.createElement('td');
    const a = document.createElement('a');
    a.href = tr.dataset.href;
    a.className = 'pname';
    a.textContent = p.name || 'Unnamed patient';
    const sub = document.createElement('span');
    sub.className = 'psub';
    sub.textContent = p.email || '';
    nameTd.append(a, sub);
    tr.append(nameTd);

    tr.append(cell([p.age != null ? `${p.age} y` : null, p.gender].filter(Boolean).join(' · ') || '—', 'c-demo'));
    tr.append(vitalCell(l && l.hr, (v) => `${v} bpm`, l && (l.hr < th.hrMin || l.hr > th.hrMax)));
    tr.append(vitalCell(l && l.spo2, (v) => `${v}%`, l && l.spo2 < th.spo2Min));
    tr.append(vitalCell(l && l.temp, (v) => `${v.toFixed(1)} °C`, l && (l.temp < th.tempMin || l.temp > th.tempMax), 'c-temp'));
    tr.append(vitalCell(l && l.eng, (v) => `${v}/100`, l && l.eng < th.engMin, 'c-eng'));
    tr.append(cell(l && l.ts ? ago(now - l.ts) : 'Never', 'c-seen'));

    const stTd = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = 'status-chip ' + st.key;
    chip.textContent = st.label;
    stTd.append(chip);
    tr.append(stTd);
    return tr;
  });

  $('#rows').replaceChildren(...rows);
  const empty = $('#emptyNote');
  if (!Object.keys(patients).length) {
    empty.hidden = false;
    empty.textContent = 'No patients yet. Patients appear here after they create an account on the sign-in page.';
  } else if (!list.length) {
    empty.hidden = false;
    empty.textContent = 'No patients match your search.';
  } else {
    empty.hidden = true;
  }
}

$('#search').addEventListener('input', render);

// Whole row is clickable; the name link keeps keyboard / middle-click behaviour.
$('#rows').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const tr = e.target.closest('tr[data-href]');
  if (tr) location.href = tr.dataset.href;
});
