/* Alert engine: evaluates rules once per second and keeps an alert log.

   A rule must stay true for `holdMs` before it raises (debounce against sensor noise).
   It raises once, then stays quiet until it clears; a clear marks the entry resolved.
   If a raised alert gets worse (warning -> critical), a new entry is raised.
   One-off events (e.g. a fall) are pushed directly with push() and never "resolve".

   Email alerts to doctors (Objective 4) plug in through the onRaise callback. */

const ALERT_RULES = [
  {
    id: 'hr',
    holdMs: 5000,
    check: ({ s, th }) => {
      if (s.hr == null) return null;
      if (s.hr > th.hrMax) return { severity: s.hr >= th.hrMax + 20 ? 'critical' : 'warning', message: `High heart rate: ${s.hr} bpm` };
      if (s.hr < th.hrMin) return { severity: s.hr <= th.hrMin - 10 ? 'critical' : 'warning', message: `Low heart rate: ${s.hr} bpm` };
      return null;
    },
  },
  {
    id: 'spo2',
    holdMs: 5000,
    check: ({ s, th }) => {
      if (s.spo2 == null || s.spo2 >= th.spo2Min) return null;
      return { severity: s.spo2 < th.spo2Min - 4 ? 'critical' : 'warning', message: `Low SpO₂: ${s.spo2}%` };
    },
  },
  {
    id: 'temp',
    holdMs: 10000,
    check: ({ s, th }) => {
      if (s.temp == null) return null;
      if (s.temp >= th.tempMax) return { severity: s.temp >= th.tempMax + 1.5 ? 'critical' : 'warning', message: `High temperature: ${s.temp.toFixed(1)} °C` };
      if (s.temp <= th.tempMin) return { severity: 'warning', message: `Low temperature: ${s.temp.toFixed(1)} °C` };
      return null;
    },
  },
  {
    id: 'wear',
    holdMs: 60000,
    check: ({ s, sensors }) => {
      const pulseSensor = sensors ? sensors.max30102 ?? sensors.max30100 : undefined;
      if (pulseSensor === false) return null; // no pulse sensor fitted: can't tell if it's worn
      return s.finger ? null : { severity: 'warning', message: 'Sensor not worn for over a minute' };
    },
  },
  {
    id: 'engagement',
    holdMs: 60000,
    check: ({ eng, th }) => {
      if (!eng || eng.score == null || eng.score >= th.engMin) return null;
      return { severity: 'warning', message: `Low patient engagement: ${eng.score}/100` };
    },
  },
  {
    id: 'signal',
    holdMs: 2000,
    needsLinkOnly: true,
    check: ({ connected, now, lastRx }) =>
      connected && now - lastRx > 3000 ? { severity: 'warning', message: 'No data from device' } : null,
  },
];

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

class AlertEngine {
  constructor({ onRaise, onUpdate, onChange }) {
    this.onRaise = onRaise;
    this.onUpdate = onUpdate || (() => {}); // entry resolved, escalated or acknowledged
    this.onChange = onChange;
    this.state = {};
    this.log = [];
    this.seq = 0;
  }

  /* ctx: { s: latest fresh sample or null, eng, th, sensors, connected, now, lastRx } */
  evaluate(ctx) {
    let changed = false;
    for (const rule of ALERT_RULES) {
      // Vital-sign rules only run on fresh data so a dropped link doesn't "resolve" them.
      if (!rule.needsLinkOnly && !ctx.s) continue;
      const st = this.state[rule.id] || (this.state[rule.id] = { since: null, entry: null });
      const hit = rule.check(ctx);

      if (!hit) {
        st.since = null;
        if (st.entry) {
          st.entry.resolvedAt = ctx.now;
          this.onUpdate(st.entry);
          st.entry = null;
          changed = true;
        }
        continue;
      }

      if (st.since == null) st.since = ctx.now;
      if (ctx.now - st.since < rule.holdMs) continue;

      const escalated = st.entry && SEVERITY_RANK[hit.severity] > SEVERITY_RANK[st.entry.severity];
      if (!st.entry || escalated) {
        if (escalated) {
          st.entry.resolvedAt = ctx.now;
          st.entry.escalated = true;
          this.onUpdate(st.entry);
        }
        st.entry = this.push({ rule: rule.id, severity: hit.severity, message: hit.message, event: false }, ctx.now);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  push({ rule, severity, message, event = true }, now = Date.now()) {
    const entry = { id: ++this.seq, rule, severity, message, event, at: now, resolvedAt: null, acked: false };
    this.log.unshift(entry);
    if (this.log.length > 500) this.log.length = 500;
    this.onRaise(entry);
    this.onChange();
    return entry;
  }

  /* Marks an active rule-based alert as resolved, e.g. "No data from device" once the user disconnects. */
  resolve(ruleId, now = Date.now()) {
    const st = this.state[ruleId];
    if (!st || !st.entry) return;
    st.entry.resolvedAt = now;
    this.onUpdate(st.entry);
    st.entry = null;
    st.since = null;
    this.onChange();
  }

  ack(id) {
    const e = this.log.find((x) => x.id === id);
    if (e && !e.acked) {
      e.acked = true;
      this.onUpdate(e);
    }
    this.onChange();
  }

  ackAll() {
    for (const e of this.log) {
      if (e.acked) continue;
      e.acked = true;
      this.onUpdate(e);
    }
    this.onChange();
  }

  unacked() {
    return this.log.filter((e) => !e.acked).length;
  }

  reset() {
    this.state = {};
    this.log = [];
    this.onChange();
  }
}
