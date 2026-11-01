/* Monitor page side of Firebase: auth guard, patient context, cloud history and sync.

   Who sees what:
     patient  -> always their own record (their uid is the patient id)
     doctor   -> the patient chosen on patients.html (index.html?patient=<uid>)

   Data flow:
     - Readings recorded on THIS computer (USB / demo) arrive from app.js as `pm:sample`
       and are written to /latest/{pid} and /vitals/{pid}. Alerts they trigger are written
       to /alerts/{pid}.
     - When this computer is not recording, the page shows the patient's readings from the
       cloud: the last hour of history, then new readings live as they're uploaded elsewhere.
     - The alert panel always shows the shared /alerts/{pid} list, so an acknowledgement by
       the doctor is visible to the patient and vice versa. */

import {
  auth, db, onAuthStateChanged, signOut, ref, get, set, push, update, onValue, onChildAdded,
  query, orderByChild, startAt, limitToLast, loadAccount, setAuthNotice, isPermissionError, accountErrorText,
} from './firebase.js';

const $ = (sel) => document.querySelector(sel);
const HISTORY_MS = 60 * 60 * 1000;
const EVENT_RULES = new Set(['fall', 'link']); // one-off alerts that never "resolve"

let user = null;
let acct = null;
let pid = null;
let online = false;
let pending = 0;
let lastError = null;
let syncOn = readPref();
const alertKeys = new Map(); // local alert id -> cloud key
let lastSeenWrite = 0;

function readPref() {
  try {
    return localStorage.getItem('pm.cloudSync') !== 'false';
  } catch {
    return true;
  }
}

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));

function gateError(text) {
  if (!document.getElementById('authGate')) return;
  $('#authGateMsg').textContent = text;
  $('#authGateActions').hidden = false;
}

// ---------- Auth guard + context ----------

onAuthStateChanged(auth, async (u) => {
  if (!u) {
    location.replace('login.html');
    return;
  }
  if (user) return;

  let a;
  try {
    a = await loadAccount(u);
  } catch (e) {
    gateError(accountErrorText(e));
    return;
  }
  if (!a.profile) {
    location.replace('login.html'); // login page finishes the account setup
    return;
  }

  let target;
  if (a.profile.role === 'doctor') {
    if (!a.verifiedDoctor) {
      setAuthNotice({ code: 'not-verified' });
      await signOut(auth);
      return;
    }
    target = new URLSearchParams(location.search).get('patient');
    if (!target) {
      location.replace('patients.html');
      return;
    }
  } else {
    target = u.uid;
  }

  let patient;
  try {
    const snap = await get(ref(db, `patients/${target}`));
    patient = snap.val();
  } catch (e) {
    gateError(isPermissionError(e) ? 'You do not have access to this patient.' : 'Could not load the patient: ' + e.message);
    return;
  }
  if (!patient) {
    if (a.profile.role === 'doctor') location.replace('patients.html');
    else {
      setAuthNotice({ code: 'no-patient' });
      await signOut(auth);
    }
    return;
  }

  user = u;
  acct = a;
  pid = target;

  // Guarded: an outdated cached index.html may not have the navigation links yet.
  const navPatients = $('#navPatients'), navAnalysis = $('#navAnalysis');
  if (navPatients && a.profile.role === 'doctor') navPatients.hidden = false;
  if (navAnalysis) navAnalysis.href = `analysis.html?patient=${encodeURIComponent(pid)}`;
  $('#acctEmail').textContent = a.profile.name || u.email;
  $('#acctRole').textContent = a.profile.role === 'doctor' ? 'Doctor' : 'Patient';
  $('#account').hidden = false;
  $('#syncOpt').hidden = false;
  window.PM.setContext({ role: a.profile.role, patient: { id: pid, ...patient } });

  await startStreams();
  document.getElementById('authGate')?.remove();
  renderStatus();
});

$('#btnSignOut').addEventListener('click', async () => {
  setAuthNotice({ code: 'signed-out' });
  await signOut(auth);
});

// ---------- Reading the patient's cloud data ----------

async function startStreams() {
  const since = Date.now() - HISTORY_MS;

  // If the patient hasn't recorded in the last hour, still show their most recent reading.
  try {
    const l = (await get(ref(db, `latest/${pid}`))).val();
    if (l && typeof l.ts === 'number' && l.ts < since) window.PM.ingestRemote(l);
  } catch {}

  // Last hour of history, then every new reading as it's uploaded.
  onChildAdded(
    query(ref(db, `vitals/${pid}`), orderByChild('ts'), startAt(since)),
    (snap) => window.PM.ingestRemote(snap.val()),
    (e) => fail(e),
  );

  // Shared alert list (newest 100).
  let first = true;
  const known = new Set();
  onValue(
    query(ref(db, `alerts/${pid}`), orderByChild('at'), limitToLast(100)),
    (snap) => {
      const list = [];
      snap.forEach((c) => {
        const v = c.val() || {};
        list.push({ ...v, id: c.key, event: EVENT_RULES.has(v.rule) });
      });
      list.sort((a, b) => b.at - a.at);
      if (!first) for (const e of list) if (!known.has(e.id)) window.PM.alertArrived(e);
      list.forEach((e) => known.add(e.id));
      first = false;
      window.PM.setCloudAlerts(list);
    },
    (e) => fail(e),
  );
}

// ---------- Connection status ----------

onValue(ref(db, '.info/connected'), (snap) => {
  online = snap.val() === true;
  renderStatus();
});

function renderStatus() {
  const pill = $('#cloudStatus');
  let st, txt, title = '';
  if (lastError) {
    st = 'err';
    txt = 'Cloud · error';
    title = lastError;
  } else if (!online) {
    st = 'wait';
    txt = pending ? `Cloud · offline (${pending} queued)` : 'Cloud · offline';
  } else if (!syncOn) {
    st = 'off';
    txt = 'Cloud · upload paused';
  } else {
    st = 'live';
    txt = 'Cloud · synced';
  }
  pill.dataset.state = st;
  pill.title = title;
  pill.querySelector('.txt').textContent = txt;
}

function fail(e) {
  lastError = isPermissionError(e)
    ? 'Permission denied: make sure the latest database.rules.json is published.'
    : e.message;
  console.warn('Cloud error:', e);
  renderStatus();
}

function track(promise) {
  pending++;
  promise
    .then(() => {
      lastError = null;
    })
    .catch(fail)
    .finally(() => {
      pending--;
      renderStatus();
    });
}

// ---------- Uploading readings recorded on this computer ----------

const syncBox = $('#optSync');
syncBox.checked = syncOn;
syncBox.addEventListener('change', () => {
  syncOn = syncBox.checked;
  try {
    localStorage.setItem('pm.cloudSync', String(syncOn));
  } catch {}
  renderStatus();
});

window.addEventListener('pm:sample', (e) => {
  if (!user || !syncOn) return;
  const { sample: s, source } = e.detail;
  const rec = clean({
    ts: s.ts, hr: s.hr, spo2: s.spo2, temp: s.temp, motion: s.motion, steps: s.steps,
    finger: s.finger, fall: s.fall, eng: s.eng, demo: source === 'demo' ? true : null,
  });
  track(set(ref(db, `latest/${pid}`), rec));
  track(push(ref(db, `vitals/${pid}`), rec));
  if (s.ts - lastSeenWrite > 60000) {
    lastSeenWrite = s.ts;
    track(update(ref(db, `patients/${pid}`), { lastSeen: s.ts }));
  }
});

window.addEventListener('pm:alert', (e) => {
  if (!user || !syncOn) return;
  const { entry } = e.detail;
  const r = push(ref(db, `alerts/${pid}`));
  alertKeys.set(entry.id, r.key);
  track(set(r, clean({
    rule: entry.rule, severity: entry.severity, message: entry.message, at: entry.at,
    resolvedAt: entry.resolvedAt, acked: false, recordedBy: acct.profile.role,
  })));
});

window.addEventListener('pm:alert-update', (e) => {
  if (!user) return;
  const { entry } = e.detail;
  const key = alertKeys.get(entry.id);
  if (!key) return;
  // Only resolve/escalate here; acknowledgements come from the shared list via pm:ack.
  track(update(ref(db, `alerts/${pid}/${key}`), clean({ resolvedAt: entry.resolvedAt, escalated: entry.escalated || null })));
});

window.addEventListener('pm:ack', (e) => {
  if (!user) return;
  const by = `${acct.profile.name || user.email} (${acct.profile.role})`;
  const now = Date.now();
  for (const key of e.detail.keys) {
    track(update(ref(db, `alerts/${pid}/${key}`), { acked: true, ackedBy: by, ackedAt: now }));
  }
});
