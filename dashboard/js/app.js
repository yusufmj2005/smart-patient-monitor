/* Dashboard controller: connection, data ingest, rendering, export. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const DEFAULT_TH = { hrMin: 50, hrMax: 120, spo2Min: 92, tempMin: 35.0, tempMax: 38.0, engMin: 40 };
  const MAX_SAMPLES = 6 * 3600;   // 6 h at 1 Hz
  const LIVE_MS = 3000;           // data newer than this counts as "live"
  const CONSOLE_LINES = 300;

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('pm.' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('pm.' + key, JSON.stringify(value));
      } catch {}
    },
  };

  const state = {
    samples: [],
    source: null,        // 'usb' | 'demo' | null
    chip: null,
    device: null,
    sensors: null,
    lastRx: 0,
    sessionStart: null,
    eng: null,
    windowMs: store.get('windowMs', 300000),
    th: Object.assign({}, DEFAULT_TH, store.get('th', {})),
    sound: store.get('sound', false),
    notify: store.get('notify', false),
    ctx: null,           // cloud context set by cloud.js: { role, patient: { id, name, age, gender } }
    cloudAlerts: null,   // alert list from the cloud (replaces the local log when set)
  };

  // ---------- Connection ----------

  const usbSupported = SerialLink.supported();
  const link = usbSupported ? new SerialLink({ onLine: handleLine, onClose: onLinkClosed }) : null;
  const sim = new Simulator(handleLine);

  async function connectUsb() {
    if (state.source === 'usb') return disconnect();
    if (state.source) await disconnect();
    try {
      const { chip } = await link.connect(Number($('#baud').value));
      state.chip = chip;
      setSource('usb');
      sys(`Connected via ${chip} at ${$('#baud').value} baud. Waiting for data…`);
    } catch (e) {
      if (e.name === 'NotFoundError') return; // user closed the port chooser
      const hint = e.name === 'NetworkError' || e.name === 'InvalidStateError'
        ? ' The port may be in use: close the Arduino IDE Serial Monitor and try again.'
        : '';
      sys('Could not open port: ' + e.message + hint, 'err');
      openConsole();
    }
  }

  function startDemo() {
    if (state.source === 'demo') return disconnect();
    const go = () => {
      setSource('demo');
      sys('Demo mode started (simulated ESP8266 data).');
      sim.start();
    };
    state.source ? disconnect().then(go) : go();
  }

  async function disconnect() {
    const was = state.source;
    if (was === 'demo') {
      sim.stop();
      setSource(null);
      sys('Demo mode stopped.');
    } else if (was === 'usb') {
      await link.disconnect(); // triggers onLinkClosed(true)
    }
  }

  function onLinkClosed(userInitiated) {
    setSource(null);
    if (userInitiated) {
      sys('Disconnected.');
    } else {
      sys('Device disconnected (USB unplugged or reset).', 'err');
      alerts.push({ rule: 'link', severity: 'warning', message: 'Device disconnected from USB' });
    }
  }

  function setSource(src) {
    if (!src && state.source) alerts.resolve('signal'); // stopped on purpose: "no data" no longer applies
    state.source = src;
    state.helloSeen = false;
    state.restarts = 0;
    state.junkLines = 0;
    state.baudHinted = false;
    if (!src) {
      state.chip = null;
    } else {
      state.lastRx = Date.now(); // grace period before "no data" alert
    }
    $('#btnConnect').textContent = src === 'usb' ? 'Disconnect' : 'Connect USB';
    $('#btnConnect').classList.toggle('primary', src !== 'usb');
    $('#btnDemo').textContent = src === 'demo' ? 'Stop demo' : 'Demo mode';
    $('#btnDemo').classList.toggle('active', src === 'demo');
    $('#demoBar').hidden = src !== 'demo';
    $('#cmdInput').disabled = src !== 'usb';
    renderStatus(Date.now());
    renderDevice();
  }

  // ---------- Ingest ----------

  function handleLine(line) {
    consoleLine(line, 'rx');
    if (line[0] !== '{') {
      // ESP8266 boot messages are normal, but a steady stream of unreadable lines means the speed is wrong.
      state.junkLines = (state.junkLines || 0) + 1;
      if (state.source === 'usb' && !state.helloSeen && !state.baudHinted && state.junkLines >= 4) {
        state.baudHinted = true;
        sys(`Data is arriving but can't be read, so the baud rate is probably wrong. `
          + `Disconnect, set the speed to 115200 (what the firmware uses) and connect again.`, 'err');
        openConsole();
      }
      return;
    }
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    state.lastRx = Date.now();
    if (d.type === 'hello') {
      // A second start-up message in one connection means the board rebooted by itself.
      if (state.helloSeen && state.source === 'usb') {
        state.restarts = (state.restarts || 0) + 1;
        sys(`The board restarted (${state.restarts}×). Repeated restarts usually mean a power problem `
          + '(short or loose 3V3/GND wire, sensor drawing too much current) or a sensor holding the I²C bus. '
          + 'Unplug the sensors one at a time to find which one causes it.', 'err');
        openConsole();
      }
      state.helloSeen = true;
      state.device = d.device + (d.fw ? ` · fw ${d.fw}` : '');
      state.sensors = d.sensors || null;
      renderDevice();
    } else if (d.type === 'data') {
      ingest(d);
    } else if (d.type === 'scan') {
      const names = { '0x57': 'pulse sensor', '0x68': 'MPU6050', '0x69': 'MPU6050 (AD0 not grounded)' };
      const found = (d.found || []).map((a) => (names[a] ? `${a} ${names[a]}` : a));
      sys(`I²C scan, ${d.pins}: ${found.length ? found.join(', ') : 'no devices answer'}`);
      openConsole();
    } else if (d.type === 'info' && d.msg) {
      sys('Device: ' + d.msg);
    } else if (d.type === 'error' && d.msg) {
      sys('Device: ' + d.msg, 'err');
      openConsole();
    }
  }

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  /* remote = the reading came from the cloud (recorded by another session), not from this device. */
  function ingest(d, remote = false) {
    const last = state.samples[state.samples.length - 1];
    const s = {
      ts: remote ? d.ts : Date.now(),
      hr: num(d.hr),
      spo2: num(d.spo2),
      temp: num(d.temp),
      motion: num(d.motion),
      steps: num(d.steps),
      finger: d.finger ? 1 : 0,
      fall: d.fall ? 1 : 0,
      eng: remote ? num(d.eng) : null,
    };
    if (remote && (typeof s.ts !== 'number' || (last && s.ts <= last.ts))) return; // duplicate / out of order
    if (!state.sessionStart) state.sessionStart = s.ts;
    state.samples.push(s);
    if (state.samples.length > MAX_SAMPLES) state.samples.splice(0, state.samples.length - MAX_SAMPLES);

    if (!remote) {
      // Computed here too (not only in the render) so alerts keep working while the tab is in the background.
      state.eng = Engagement.compute(state.samples, s.ts, state.th);
      s.eng = state.eng.score;
      // Falls are one-shot flags, so they're alerted on arrival rather than on the 1 Hz rule tick.
      if (s.fall) alerts.push({ rule: 'fall', severity: 'critical', message: 'Possible fall detected' });
      emit('pm:sample', { sample: s, patient: patient(), source: state.source });
    }
    scheduleRender();
  }

  /* Cloud history can deliver thousands of readings at once, so rendering is batched per frame. */
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const s = state.samples[state.samples.length - 1];
      if (!s) return;
      state.eng = Engagement.compute(state.samples, s.ts, state.th);
      renderVitals(s);
      renderEngagement();
      renderCharts(Date.now());
      renderStatus(Date.now());
    });
  }

  function latestFresh(now) {
    const s = state.samples[state.samples.length - 1];
    return s && now - s.ts <= LIVE_MS ? s : null;
  }

  // ---------- Alerts ----------

  let audioCtx = null;
  function beep(severity) {
    if (!state.sound) return;
    try {
      audioCtx = audioCtx || new AudioContext();
      const pattern = severity === 'critical' ? [0, 0.22, 0.44] : [0];
      for (const at of pattern) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = severity === 'critical' ? 880 : 620;
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime + at);
        gain.gain.exponentialRampToValueAtTime(0.2, audioCtx.currentTime + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + at + 0.18);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + at);
        osc.stop(audioCtx.currentTime + at + 0.2);
      }
    } catch {}
  }

  function notify(entry) {
    if (!state.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    const who = $('#patientName').value.trim() || 'Patient';
    try {
      new Notification(`${entry.severity === 'critical' ? 'CRITICAL' : 'Warning'}: ${who}`, { body: entry.message, tag: entry.rule });
    } catch {}
  }

  const alerts = new AlertEngine({
    onRaise: (entry) => {
      beep(entry.severity);
      notify(entry);
      sys(`ALERT [${entry.severity}] ${entry.message}`, entry.severity === 'critical' ? 'err' : 'sys');
      emit('pm:alert', { entry, patient: patient() });
    },
    onUpdate: (entry) => emit('pm:alert-update', { entry }),
    onChange: renderAlerts,
  });

  // ---------- Events for optional modules (cloud.js syncs these to Firebase) ----------

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function patient() {
    if (state.ctx) return { id: state.ctx.patient.id, name: state.ctx.patient.name || '' };
    return { id: $('#patientId').value.trim(), name: $('#patientName').value.trim() };
  }

  /* Alerts shown in the panel: the shared cloud list when signed in, otherwise this session's log. */
  const alertList = () => state.cloudAlerts || alerts.log;

  /* API used by cloud.js (loaded later as an ES module). */
  window.PM = {
    setContext(ctx) {
      state.ctx = ctx;
      const p = ctx.patient;
      $('#patientLocal').hidden = true;
      $('#patientCtx').hidden = false;
      $('#backLink').hidden = ctx.role !== 'doctor';
      $('#ctxName').textContent = ctx.role === 'patient' ? 'My monitor' : p.name || 'Patient';
      $('#ctxMeta').textContent = ctx.role === 'patient'
        ? p.name || ''
        : [p.age != null ? `${p.age} y` : null, p.gender, p.email].filter(Boolean).join(' · ');
      document.title = (ctx.role === 'patient' ? 'My monitor' : p.name || 'Patient') + ' · Patient Monitor';
      baseTitle = document.title;
      renderAlerts();
    },
    ingestRemote(rec) {
      if (state.source) return; // this device is recording; its own readings are already shown
      ingest(rec, true);
    },
    setCloudAlerts(list) {
      state.cloudAlerts = list;
      renderAlerts();
    },
    alertArrived(entry) {
      if (state.source) return; // raised by this device: already beeped
      beep(entry.severity);
      notify(entry);
    },
  };

  // ---------- Rendering ----------

  const charts = {
    hr: new TimeChart($('#c-hr'), { min: 40, max: 140, step: 20, colorVar: '--c-hr' }),
    spo2: new TimeChart($('#c-spo2'), { min: 90, max: 100, step: 2, colorVar: '--c-spo2' }),
    temp: new TimeChart($('#c-temp'), { min: 35, max: 38.5, step: 0.5, decimals: 1, colorVar: '--c-temp' }),
    motion: new TimeChart($('#c-motion'), { min: 0, max: 0.2, step: 0.05, decimals: 2, colorVar: '--c-motion' }),
  };

  function applyBands() {
    const th = state.th;
    charts.hr.o.band = [th.hrMin, th.hrMax];
    charts.spo2.o.band = [th.spo2Min, 100];
    charts.temp.o.band = [th.tempMin, th.tempMax];
  }

  function renderCharts(now) {
    const from = now - state.windowMs;
    const arr = state.samples;
    let lo = 0, hi = arr.length;
    while (lo < hi) { // first sample inside the window
      const mid = (lo + hi) >> 1;
      if (arr[mid].ts < from) lo = mid + 1;
      else hi = mid;
    }
    const slice = arr.slice(lo);
    for (const key of Object.keys(charts)) {
      charts[key].setData(slice.map((s) => ({ t: s.ts, v: s[key] })), from, now);
    }
  }

  function levelFor(value, lo, hi, critLo, critHi) {
    if (value == null) return 'idle';
    if ((critLo != null && value <= critLo) || (critHi != null && value >= critHi)) return 'critical';
    if ((lo != null && value < lo) || (hi != null && value > hi)) return 'warning';
    return 'ok';
  }

  function setTile(id, value, text, level, flag, sub) {
    const tile = $('#tile-' + id);
    tile.dataset.state = level;
    tile.querySelector('.flag').textContent = flag;
    if (value) $(value).textContent = text;
    $('#s-' + id).textContent = sub;
  }

  const flagText = (level, value, lo) =>
    level === 'ok' ? 'Normal' : level === 'idle' ? '' : value < lo ? 'Low' : 'High';

  function renderVitals(s) {
    const th = state.th;
    const noFinger = !s.finger;

    let lv = levelFor(s.hr, th.hrMin, th.hrMax, th.hrMin - 10, th.hrMax + 20);
    setTile('hr', '#v-hr', s.hr ?? '--', lv, flagText(lv, s.hr, th.hrMin),
      noFinger ? 'Place finger on the sensor' : s.hr == null ? 'Measuring…' : `Normal ${th.hrMin}–${th.hrMax} bpm`);

    lv = levelFor(s.spo2, th.spo2Min, null, th.spo2Min - 4, null);
    setTile('spo2', '#v-spo2', s.spo2 ?? '--', lv, flagText(lv, s.spo2, th.spo2Min),
      noFinger ? 'Place finger on the sensor' : s.spo2 == null ? 'Measuring…' : `Normal ≥ ${th.spo2Min}%`);

    lv = levelFor(s.temp, th.tempMin, th.tempMax, null, th.tempMax + 1.5);
    setTile('temp', '#v-temp', s.temp == null ? '--' : s.temp.toFixed(1), lv, flagText(lv, s.temp, th.tempMin),
      s.temp == null ? 'No reading — check LM35 wiring' : `Normal ${th.tempMin.toFixed(1)}–${th.tempMax.toFixed(1)} °C`);

    const m = s.motion;
    const label = m == null ? '' : m < 0.03 ? 'Resting' : m < 0.1 ? 'Light activity' : 'Active';
    const actLevel = s.fall ? 'critical' : m == null ? 'idle' : 'ok';
    setTile('act', '#v-steps', s.steps ?? '--', actLevel, s.fall ? 'Fall' : label,
      m == null ? 'No reading — check MPU6050 wiring' : `Movement ${m.toFixed(3)} g`);
  }

  function renderEngagement() {
    const e = state.eng;
    const ring = $('#engRing');
    const arc = $('#engArc');
    const C = 326.73;
    if (!e || e.score == null) {
      ring.dataset.level = 'none';
      arc.style.strokeDashoffset = C;
      $('#engScore').textContent = '--';
      $('#engLevel').textContent = e ? `Collecting ${e.collected}/${e.needed}` : 'Waiting';
      $$('#engParts li').forEach((li) => {
        li.querySelector('b').textContent = '--';
        li.querySelector('s').style.width = '0';
      });
      return;
    }
    ring.dataset.level = e.level;
    arc.style.strokeDashoffset = C * (1 - e.score / 100);
    $('#engScore').textContent = e.score;
    $('#engLevel').textContent = { good: 'Good', moderate: 'Moderate', low: 'Low' }[e.level];
    $$('#engParts li').forEach((li) => {
      const pct = Math.round(e.parts[li.dataset.k] * 100);
      li.querySelector('b').textContent = pct + '%';
      li.querySelector('s').style.width = pct + '%';
    });
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let baseTitle = document.title;

  function renderAlerts() {
    const list = $('#alertList');
    const items = alertList().slice(0, 100);
    list.replaceChildren(...items.map((e) => {
      const li = document.createElement('li');
      li.className = e.acked ? 'acked' : '';
      const status = e.event ? ''
        : e.escalated ? ' · escalated'
        : e.resolvedAt ? ` · resolved ${timeFmt.format(e.resolvedAt)}`
        : ' · <span class="active">active</span>';
      li.innerHTML = `
        <span class="sev ${e.severity}" title="${e.severity}"></span>
        <span class="alert-msg"></span>
        ${e.acked ? '<span></span>' : `<button class="btn ghost small" data-ack="${e.id}" type="button">Ack</button>`}
        <span class="alert-meta">${timeFmt.format(e.at)}${status}</span>`;
      li.querySelector('.alert-msg').textContent = e.message;
      return li;
    }));
    $('#alertEmpty').hidden = items.length > 0;
    const n = alertList().filter((e) => !e.acked).length;
    $('#alertBadge').hidden = n === 0;
    $('#alertBadge').textContent = n;
    document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
  }

  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }

  function renderStatus(now) {
    const pill = $('#connStatus');
    const last = state.samples[state.samples.length - 1];
    let st = 'off', txt = 'Disconnected';
    if (state.source) {
      const live = now - state.lastRx <= LIVE_MS && last && now - last.ts <= LIVE_MS;
      const name = state.source === 'demo' ? 'Demo' : state.chip || 'USB';
      st = live ? 'live' : 'wait';
      txt = live ? `Live · ${name}` : `${name} · waiting for data`;
    } else if (state.ctx) {
      // Viewing cloud data recorded elsewhere (e.g. a doctor watching a patient at home).
      if (!last) txt = 'No readings yet';
      else if (now - last.ts <= 10000) (st = 'live'), (txt = 'Live · cloud');
      else txt = `Last reading ${ago(now - last.ts)}`;
    }
    pill.dataset.state = st;
    pill.querySelector('.txt').textContent = txt;
    // Dim the tiles when they show old values.
    $('.vitals').classList.toggle('stale', !!last && now - last.ts > 30000);
  }

  function renderDevice() {
    $('#devName').textContent = state.source ? (state.device || (state.source === 'usb' ? state.chip : 'Simulator')) : state.device ? state.device + ' (offline)' : '—';
    const box = $('#devSensors');
    if (!state.sensors) {
      box.textContent = '—';
      return;
    }
    const names = { max30100: 'MAX30100', max30102: 'MAX30102', mpu6050: 'MPU6050', lm35: 'LM35' };
    // The LM35 is analog, so the board can't detect it: judge it by whether recent readings have a temperature.
    const recent = state.source ? state.samples.slice(-5) : [];
    const lm35Silent = recent.length >= 3 && recent.every((s) => s.temp == null);

    box.replaceChildren(...Object.entries(names).filter(([k]) => k in state.sensors).map(([k, label]) => {
      const el = document.createElement('span');
      const silent = k === 'lm35' && lm35Silent;
      const on = state.sensors[k] !== false && !silent;
      el.className = 'sensor-chip ' + (on ? 'on' : 'off');
      el.textContent = label + (silent ? ' no reading' : on ? '' : ' missing');
      return el;
    }));
  }

  function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return (h ? h + ':' : '') + pad(m) + ':' + pad(s % 60);
  }

  function renderSession(now) {
    $('#sessDur').textContent = state.sessionStart ? fmtDuration(now - state.sessionStart) : '—';
    $('#sessCount').textContent = state.samples.length.toLocaleString();
  }

  // ---------- Serial console ----------

  const consoleEl = $('#console');
  function consoleLine(text, kind) {
    const div = document.createElement('div');
    if (kind !== 'rx') div.className = kind;
    div.textContent = (kind === 'tx' ? '> ' : '') + text;
    const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 24;
    consoleEl.appendChild(div);
    while (consoleEl.childElementCount > CONSOLE_LINES) consoleEl.firstChild.remove();
    if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  const sys = (text, kind = 'sys') => consoleLine(`[${timeFmt.format(Date.now())}] ${text}`, kind);
  const openConsole = () => ($('#consolePanel').open = true);

  // ---------- Export ----------

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const fileStem = () => {
    const p = patient();
    const id = ((state.ctx ? p.name : p.id) || 'patient').replace(/[^\w-]+/g, '_');
    return `${id}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  };

  function exportData() {
    if (!state.samples.length) return sys('Nothing to export yet.');
    const head = ['timestamp', 'patient_id', 'heart_rate_bpm', 'spo2_pct', 'temp_c', 'motion_g', 'steps', 'finger_on', 'fall', 'engagement_score'];
    const pid = patient().id;
    const rows = state.samples.map((s) =>
      [new Date(s.ts).toISOString(), pid, s.hr, s.spo2, s.temp, s.motion, s.steps, s.finger, s.fall, s.eng].map(csvCell).join(','));
    download(`${fileStem()}_vitals.csv`, head.join(',') + '\n' + rows.join('\n') + '\n');
  }

  function exportAlerts() {
    const log = alertList();
    if (!log.length) return sys('No alerts to export.');
    const head = ['raised_at', 'severity', 'rule', 'message', 'resolved_at', 'acknowledged'];
    const rows = log.slice().reverse().map((e) =>
      [new Date(e.at).toISOString(), e.severity, e.rule, e.message, e.resolvedAt ? new Date(e.resolvedAt).toISOString() : '', e.acked ? 1 : 0]
        .map(csvCell).join(','));
    download(`${fileStem()}_alerts.csv`, head.join(',') + '\n' + rows.join('\n') + '\n');
  }

  function clearSession() {
    if (!confirm('Clear all recorded data and alerts for this session?')) return;
    state.samples = [];
    state.sessionStart = null;
    state.eng = null;
    alerts.reset();
    renderVitals({ hr: null, spo2: null, temp: null, motion: null, steps: null, finger: 1, fall: 0 });
    $$('.sub').forEach((el) => (el.textContent = ''));
    renderEngagement();
    renderCharts(Date.now());
    renderSession(Date.now());
  }

  // ---------- Settings ----------

  function fillThresholdForm() {
    const form = $('#thForm');
    for (const k of Object.keys(DEFAULT_TH)) form.elements[k].value = state.th[k];
  }

  $('#thForm').addEventListener('change', (e) => {
    const k = e.target.name;
    const v = parseFloat(e.target.value);
    if (!(k in DEFAULT_TH)) return;
    if (!Number.isFinite(v)) {
      e.target.value = state.th[k];
      return;
    }
    state.th[k] = v;
    store.set('th', state.th);
    applyBands();
    refreshAll();
  });

  $('#btnThReset').addEventListener('click', () => {
    state.th = Object.assign({}, DEFAULT_TH);
    store.set('th', state.th);
    fillThresholdForm();
    applyBands();
    refreshAll();
  });

  function refreshAll() {
    const now = Date.now();
    const last = state.samples[state.samples.length - 1];
    if (last) {
      state.eng = Engagement.compute(state.samples, last.ts, state.th);
      renderVitals(last);
    }
    renderEngagement();
    renderCharts(now);
  }

  // ---------- Wiring ----------

  if (!usbSupported) {
    $('#unsupported').hidden = false;
    $('#btnConnect').disabled = true;
    $('#baud').disabled = true;
  } else if (/Firefox\//.test(navigator.userAgent)) {
    $('#firefoxNote').hidden = false; // Web Serial in Firefox is new; the dashboard is tested in Chromium browsers
  }

  $('#btnConnect').addEventListener('click', connectUsb);
  $('#btnDemo').addEventListener('click', startDemo);

  $('#demoBar').addEventListener('click', (e) => {
    const kind = e.target.dataset && e.target.dataset.scenario;
    if (!kind) return;
    sim.inject(kind);
    sys(kind === 'normal' ? 'Demo: back to normal.' : `Demo: simulating ${SCENARIOS[kind].label.toLowerCase()}.`);
  });

  $('#windowSel').addEventListener('click', (e) => {
    const ms = Number(e.target.dataset.win);
    if (!ms) return;
    state.windowMs = ms;
    store.set('windowMs', ms);
    $$('#windowSel button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.win) === ms)));
    renderCharts(Date.now());
  });
  $$('#windowSel button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.win) === state.windowMs)));

  // With cloud login, acknowledgements go to the shared alert record (cloud.js), visible to doctor and patient.
  $('#alertList').addEventListener('click', (e) => {
    const id = e.target.dataset.ack;
    if (!id) return;
    if (state.cloudAlerts) emit('pm:ack', { keys: [id] });
    else alerts.ack(Number(id));
  });
  $('#btnAckAll').addEventListener('click', () => {
    if (state.cloudAlerts) emit('pm:ack', { keys: state.cloudAlerts.filter((a) => !a.acked).map((a) => a.id) });
    else alerts.ackAll();
  });

  $('#optSound').checked = state.sound;
  $('#optSound').addEventListener('change', (e) => {
    state.sound = e.target.checked;
    store.set('sound', state.sound);
    if (state.sound) beep('warning'); // also unlocks audio playback
  });

  $('#optNotify').checked = state.notify && 'Notification' in window && Notification.permission === 'granted';
  $('#optNotify').addEventListener('change', async (e) => {
    if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') e.target.checked = false;
    }
    state.notify = e.target.checked;
    store.set('notify', state.notify);
  });

  for (const id of ['patientName', 'patientId']) {
    const el = $('#' + id);
    el.value = store.get(id, '');
    el.addEventListener('input', () => store.set(id, el.value));
  }

  $('#cmdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#cmdInput');
    const cmd = input.value.trim();
    if (!cmd || state.source !== 'usb') return;
    consoleLine(cmd, 'tx');
    input.value = '';
    try {
      await link.send(cmd);
    } catch (err) {
      sys('Send failed: ' + err.message, 'err');
    }
  });

  $('#btnExport').addEventListener('click', exportData);
  $('#btnExportAlerts').addEventListener('click', exportAlerts);
  $('#btnClear').addEventListener('click', clearSession);

  window.addEventListener('beforeunload', (e) => {
    // Warn before stopping a live recording, or losing an unsaved offline session.
    if (state.source || (!state.ctx && state.samples.length > 60)) e.preventDefault();
    else return;
    if (state.source === 'usb') link.disconnect();
  });

  // Redraw charts when the colour scheme flips.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderCharts(Date.now()));

  // 1 Hz housekeeping: alerts, status, moving time axis.
  setInterval(() => {
    const now = Date.now();
    // Alerts are raised only by the session that records the data (USB/demo). Viewers see
    // those alerts through the cloud, so evaluating here too would create duplicates.
    if (state.source) {
      alerts.evaluate({
        s: latestFresh(now),
        eng: state.eng,
        th: state.th,
        sensors: state.sensors,
        connected: true,
        lastRx: state.lastRx,
        now,
      });
    }
    renderStatus(now);
    renderSession(now);
    if (state.source) renderDevice(); // keeps the LM35 "no reading" check current
    if (state.samples.length) renderCharts(now);
  }, 1000);

  fillThresholdForm();
  applyBands();
  setSource(null);
  renderEngagement();
  renderAlerts();
  renderCharts(Date.now());
  sys(usbSupported
    ? 'Ready. Plug in the NodeMCU and click "Connect USB", or try Demo mode.'
    : 'Web Serial is not available in this browser. Use Chrome or Edge for USB; Demo mode works here.');
})();
