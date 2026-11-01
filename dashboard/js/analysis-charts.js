/* SVG charts for the analysis page and the printable report.
   SVG (not canvas) so charts stay sharp when printed / saved as PDF.

   - lineChart:     one vital over time, normal range shaded, crosshair + tooltip
   - dailyRange:    per-day lowest–highest bar with the day's average as a dot
   - dailyColumns:  per-day totals (steps) as columns from zero
   - rangeBar:      share of time below / in / above the normal range

   Colours come from CSS variables, so charts follow light/dark mode and the
   report's always-light "paper" style. */

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

/* Re-draws when the container changes width. */
function mount(host, draw) {
  host.classList.add('viz');
  if (host._ro) host._ro.disconnect();
  let lastW = 0;
  host._ro = new ResizeObserver(() => {
    if (host.clientWidth && host.clientWidth !== lastW) {
      lastW = host.clientWidth;
      draw();
    }
  });
  host._ro.observe(host);
  lastW = host.clientWidth;
  draw();
}

function tooltip(host) {
  let tip = host.querySelector(':scope > .viz-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.hidden = true;
    host.appendChild(tip);
  }
  return {
    show(x, y, lines) {
      tip.replaceChildren(...lines.map(([text, cls]) => {
        const d = document.createElement('div');
        if (cls) d.className = cls;
        d.textContent = text;
        return d;
      }));
      tip.hidden = false;
      const w = tip.offsetWidth, hw = host.clientWidth;
      tip.style.left = Math.max(0, Math.min(hw - w, x - w / 2)) + 'px';
      tip.style.top = Math.max(0, y - tip.offsetHeight - 12) + 'px';
    },
    hide() { tip.hidden = true; },
  };
}

function emptyNote(host, text) {
  if (host._ro) host._ro.disconnect();
  const p = document.createElement('p');
  p.className = 'viz-empty';
  p.textContent = text;
  host.replaceChildren(p);
}

/* Nice y-range: expand the default axis to the data, snapped to whole steps, ≤ 5 intervals. */
function yScale(axis, values, band) {
  let lo = axis.min, hi = axis.max;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (band) {
    if (band[0] != null) lo = Math.min(lo, band[0]);
    if (band[1] != null) hi = Math.max(hi, band[1]);
  }
  const step = axis.step;
  lo = Math.floor(lo / step + 1e-9) * step;
  hi = Math.ceil(hi / step - 1e-9) * step;
  const n = Math.max(1, Math.round((hi - lo) / step));
  const stride = Math.ceil(n / 5);
  const ticks = Math.ceil(n / stride);
  hi = lo + ticks * stride * step;
  return { lo, hi, tickStep: stride * step, ticks };
}

/* Time-axis ticks at round intervals, at most one per ~90 px. */
const TIME_STEPS = [60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 864e5, 2 * 864e5, 7 * 864e5];

function timeTicks(t0, t1, width) {
  const maxTicks = Math.max(2, Math.floor(width / 90));
  const step = TIME_STEPS.find((s) => (t1 - t0) / s <= maxTicks) || 30 * 864e5;
  const ticks = [];
  const start = new Date(t0);
  if (step >= 864e5) start.setHours(0, 0, 0, 0);
  else start.setMinutes(Math.floor(start.getMinutes() / Math.max(1, step / 60e3)) * Math.max(1, step / 60e3), 0, 0);
  if (step >= 3600e3 && step < 864e5) start.setMinutes(0, 0, 0);
  for (let t = start.getTime(); t <= t1; t += step) if (t >= t0) ticks.push(t);
  const multiDay = new Date(t0).toDateString() !== new Date(t1).toDateString();
  const label = (t) => {
    const d = new Date(t);
    if (step >= 864e5) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    if (multiDay && d.getHours() === 0 && d.getMinutes() === 0) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };
  return ticks.map((t) => ({ t, label: label(t) }));
}

const fmtVal = (v, decimals, unit) => Number(v).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + (unit === '%' ? '%' : ' ' + unit);

const fmtWhen = (t, multiDay) => new Date(t).toLocaleString(undefined, multiDay
  ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
  : { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} host
 * @param {{points:{t:number,v:number,min?:number,max?:number}[], bucketed?:boolean, gapMs?:number,
 *          from:number, to:number, band?:[number,number|null], colorVar:string, unit:string,
 *          decimals:number, axis:{min:number,max:number,step:number}, height?:number, label:string}} o
 */
export function lineChart(host, o) {
  if (!o.points.length) return emptyNote(host, `No ${o.label.toLowerCase()} readings in this period.`);
  host.replaceChildren();
  const tip = tooltip(host);
  const multiDay = new Date(o.from).toDateString() !== new Date(o.to - 1).toDateString();
  const gapMs = o.gapMs || 15000;

  mount(host, () => {
    const W = host.clientWidth, H = o.height || 200;
    if (!W) return;  // hidden (e.g. other tab): drawn when it becomes visible
    const pad = { l: 44, r: 14, t: 12, b: 28 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    // Zoom the time axis to where the data is, inside the selected period.
    const t0 = Math.max(o.from, o.points[0].t), t1 = Math.min(o.to, o.points[o.points.length - 1].t);
    const span = Math.max(t1 - t0, 60e3);
    const values = o.points.flatMap((p) => (p.min != null ? [p.min, p.max] : [p.v]));
    const ys = yScale(o.axis, values, o.band);
    const x = (t) => pad.l + ((t - t0) / span) * pw;
    const y = (v) => pad.t + (1 - (v - ys.lo) / (ys.hi - ys.lo)) * ph;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', tabindex: 0,
      'aria-label': `${o.label} over time. Use the arrow keys to read values.` });
    svg.style.display = 'block';

    // Normal range
    if (o.band) {
      const top = y(o.band[1] == null ? ys.hi : Math.min(o.band[1], ys.hi));
      const bottom = y(Math.max(o.band[0], ys.lo));
      if (bottom > top) svgEl('rect', { x: pad.l, y: top, width: pw, height: bottom - top, class: 'viz-band' }, svg);
    }

    // Grid + y labels
    for (let i = 0; i <= ys.ticks; i++) {
      const v = ys.lo + i * ys.tickStep;
      const yy = Math.round(y(v)) + 0.5;
      svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: 'viz-grid' }, svg);
      const t = svgEl('text', { x: pad.l - 8, y: yy, class: 'viz-axis', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg);
      t.textContent = v.toFixed(o.decimals && ys.tickStep < 1 ? 1 : 0);
    }
    // X labels
    for (const tk of timeTicks(t0, t1, pw)) {
      const t = svgEl('text', { x: x(tk.t), y: H - 8, class: 'viz-axis', 'text-anchor': 'middle' }, svg);
      t.textContent = tk.label;
    }

    // Segments split at gaps (no line across time with no readings)
    const segments = [];
    let seg = [];
    for (let i = 0; i < o.points.length; i++) {
      const p = o.points[i];
      if (seg.length && p.t - seg[seg.length - 1].t > gapMs) {
        segments.push(seg);
        seg = [];
      }
      seg.push(p);
    }
    if (seg.length) segments.push(seg);

    const g = svgEl('g', { style: `color: var(${o.colorVar})` }, svg);
    for (const s of segments) {
      if (o.bucketed) {  // min–max envelope behind the average line
        const top = s.map((p) => `${x(p.t)},${y(p.max)}`);
        const bottom = s.slice().reverse().map((p) => `${x(p.t)},${y(p.min)}`);
        svgEl('polygon', { points: top.concat(bottom).join(' '), class: 'viz-envelope' }, g);
      }
      if (s.length === 1) svgEl('circle', { cx: x(s[0].t), cy: y(s[0].v), r: 2, class: 'viz-pointfill' }, g);
      else svgEl('polyline', { points: s.map((p) => `${x(p.t)},${y(p.v)}`).join(' '), class: 'viz-line' }, g);
    }
    const last = o.points[o.points.length - 1];
    svgEl('circle', { cx: x(last.t), cy: y(last.v), r: 4, class: 'viz-dot' }, g);

    // Crosshair + tooltip
    const cross = svgEl('line', { y1: pad.t, y2: pad.t + ph, class: 'viz-cross', visibility: 'hidden' }, svg);
    const hdot = svgEl('circle', { r: 4, class: 'viz-dot', visibility: 'hidden', style: `color: var(${o.colorVar})` }, svg);
    let idx = -1;
    const showAt = (i) => {
      idx = Math.max(0, Math.min(o.points.length - 1, i));
      const p = o.points[idx];
      const px = x(p.t), py = y(p.v);
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.setAttribute('visibility', 'visible');
      hdot.setAttribute('cx', px);
      hdot.setAttribute('cy', py);
      hdot.setAttribute('visibility', 'visible');
      const lines = [[fmtVal(p.v, o.decimals, o.unit) + (p.min != null && p.max !== p.min ? ' avg' : ''), 'viz-tip-value']];
      if (p.min != null && p.max !== p.min) lines.push([`range ${fmtVal(p.min, o.decimals, o.unit)} – ${fmtVal(p.max, o.decimals, o.unit)}`, 'viz-tip-sub']);
      lines.push([fmtWhen(p.t, multiDay), 'viz-tip-sub']);
      tip.show((px / W) * host.clientWidth, (py / H) * H, lines);
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      hdot.setAttribute('visibility', 'hidden');
      tip.hide();
    };
    const nearest = (t) => {
      let lo = 0, hi = o.points.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (o.points[mid].t < t) lo = mid + 1;
        else hi = mid;
      }
      return lo > 0 && t - o.points[lo - 1].t < o.points[lo].t - t ? lo - 1 : lo;
    };
    const hit = svgEl('rect', { x: pad.l, y: pad.t, width: pw, height: ph, fill: 'transparent' }, svg);
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * W;
      showAt(nearest(t0 + ((sx - pad.l) / pw) * span));
    });
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowRight') showAt((idx < 0 ? 0 : idx) + step);
      else if (e.key === 'ArrowLeft') showAt((idx < 0 ? o.points.length - 1 : idx) - step);
      else if (e.key === 'Escape') hide();
      else return;
      e.preventDefault();
    });

    host.querySelector(':scope > svg')?.remove();
    host.prepend(svg);
  });
}

/**
 * Per-day lowest–highest bar with the average as a dot, normal range shaded.
 * @param {{days:{key:string,label:string,mean:number,min:number,max:number}[], band?:[number,number|null],
 *          colorVar:string, unit:string, decimals:number, axis:object, label:string, height?:number}} o
 */
export function dailyRange(host, o) {
  const days = o.days.filter((d) => d.mean != null);
  if (!days.length) return emptyNote(host, `No ${o.label.toLowerCase()} readings in this period.`);
  host.replaceChildren();
  const tip = tooltip(host);

  mount(host, () => {
    const W = host.clientWidth, H = o.height || 200;
    if (!W) return;
    const pad = { l: 44, r: 14, t: 18, b: 28 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const ys = yScale(o.axis, days.flatMap((d) => [d.min, d.max]), o.band);
    const y = (v) => pad.t + (1 - (v - ys.lo) / (ys.hi - ys.lo)) * ph;
    const slot = pw / o.days.length;
    const cx = (i) => pad.l + slot * (i + 0.5);

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': `${o.label} per day: lowest, average and highest.` });
    svg.style.display = 'block';
    if (o.band) {
      const top = y(o.band[1] == null ? ys.hi : Math.min(o.band[1], ys.hi));
      const bottom = y(Math.max(o.band[0], ys.lo));
      if (bottom > top) svgEl('rect', { x: pad.l, y: top, width: pw, height: bottom - top, class: 'viz-band' }, svg);
    }
    for (let i = 0; i <= ys.ticks; i++) {
      const v = ys.lo + i * ys.tickStep;
      const yy = Math.round(y(v)) + 0.5;
      svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: 'viz-grid' }, svg);
      const t = svgEl('text', { x: pad.l - 8, y: yy, class: 'viz-axis', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg);
      t.textContent = v.toFixed(o.decimals && ys.tickStep < 1 ? 1 : 0);
    }
    const labelEvery = Math.ceil(o.days.length / Math.max(1, Math.floor(pw / 70)));
    const showValues = o.days.length <= 10 && slot >= 44;
    const g = svgEl('g', { style: `color: var(${o.colorVar})` }, svg);
    o.days.forEach((d, i) => {
      if (i % labelEvery === 0) {
        const t = svgEl('text', { x: cx(i), y: H - 8, class: 'viz-axis', 'text-anchor': 'middle' }, svg);
        t.textContent = d.label;
      }
      if (d.mean == null) return;
      const top = y(d.max), bottom = y(d.min);
      svgEl('rect', { x: cx(i) - 3, y: top, width: 6, height: Math.max(2, bottom - top), rx: 3, class: 'viz-range' }, g);
      svgEl('circle', { cx: cx(i), cy: y(d.mean), r: 5, class: 'viz-dot' }, g);
      if (showValues) {
        const t = svgEl('text', { x: cx(i), y: top - 6, class: 'viz-value', 'text-anchor': 'middle' }, svg);
        t.textContent = Number(d.mean).toFixed(o.decimals);
      }
      const hit = svgEl('rect', { x: cx(i) - slot / 2, y: pad.t, width: slot, height: ph, fill: 'transparent', tabindex: 0 }, svg);
      const show = () => tip.show((cx(i) / W) * host.clientWidth, (top / H) * H, [
        [`${fmtVal(d.mean, o.decimals, o.unit)} average`, 'viz-tip-value'],
        [`${fmtVal(d.min, o.decimals, o.unit)} – ${fmtVal(d.max, o.decimals, o.unit)}`, 'viz-tip-sub'],
        [d.label, 'viz-tip-sub'],
      ]);
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', () => tip.hide());
      hit.addEventListener('blur', () => tip.hide());
    });
    host.querySelector(':scope > svg')?.remove();
    host.prepend(svg);
  });
}

/** Per-day totals as columns from zero (e.g. steps). */
export function dailyColumns(host, o) {
  if (!o.days.some((d) => d.value != null)) return emptyNote(host, `No ${o.label.toLowerCase()} in this period.`);
  host.replaceChildren();
  const tip = tooltip(host);

  mount(host, () => {
    const W = host.clientWidth, H = o.height || 180;
    if (!W) return;
    const pad = { l: 52, r: 14, t: 20, b: 28 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const maxV = Math.max(1, ...o.days.map((d) => d.value || 0));
    const mag = Math.pow(10, Math.floor(Math.log10(maxV)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => maxV / s <= 4) || mag * 10;
    const top = Math.ceil(maxV / step) * step;
    const y = (v) => pad.t + (1 - v / top) * ph;
    const slot = pw / o.days.length;
    const bw = Math.min(24, slot * 0.6);

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': `${o.label} per day.` });
    svg.style.display = 'block';
    for (let v = 0; v <= top + 1e-9; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      svgEl('line', { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy, class: 'viz-grid' }, svg);
      const t = svgEl('text', { x: pad.l - 8, y: yy, class: 'viz-axis', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, svg);
      t.textContent = Math.round(v).toLocaleString();
    }
    const labelEvery = Math.ceil(o.days.length / Math.max(1, Math.floor(pw / 70)));
    const g = svgEl('g', { style: `color: var(${o.colorVar})` }, svg);
    o.days.forEach((d, i) => {
      const cx = pad.l + slot * (i + 0.5);
      if (i % labelEvery === 0) {
        const t = svgEl('text', { x: cx, y: H - 8, class: 'viz-axis', 'text-anchor': 'middle' }, svg);
        t.textContent = d.label;
      }
      if (!d.value) return;
      const yt = y(d.value), h = pad.t + ph - yt;
      // 4px rounded top, square at the baseline
      const r = Math.min(4, h, bw / 2);
      const x0 = cx - bw / 2, x1 = cx + bw / 2, yb = pad.t + ph;
      svgEl('path', { d: `M${x0},${yb} V${yt + r} Q${x0},${yt} ${x0 + r},${yt} H${x1 - r} Q${x1},${yt} ${x1},${yt + r} V${yb} Z`, class: 'viz-col' }, g);
      if (o.days.length <= 10) {
        const t = svgEl('text', { x: cx, y: yt - 6, class: 'viz-value', 'text-anchor': 'middle' }, svg);
        t.textContent = Math.round(d.value).toLocaleString();
      }
      const hit = svgEl('rect', { x: cx - slot / 2, y: pad.t, width: slot, height: ph, fill: 'transparent', tabindex: 0 }, svg);
      const show = () => tip.show((cx / W) * host.clientWidth, (yt / H) * H, [
        [`${Math.round(d.value).toLocaleString()} ${o.unit}`, 'viz-tip-value'],
        [d.label, 'viz-tip-sub'],
      ]);
      hit.addEventListener('pointerenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('pointerleave', () => tip.hide());
      hit.addEventListener('blur', () => tip.hide());
    });
    host.querySelector(':scope > svg')?.remove();
    host.prepend(svg);
  });
}

/** Share of time below / in / above the normal range, as one stacked bar plus a text readout. */
export function rangeBar(host, { pctLow, pctNormal, pctHigh, hasHigh = true, label }) {
  host.replaceChildren();
  host.classList.add('tir');
  const bar = document.createElement('div');
  bar.className = 'tir-bar';
  bar.setAttribute('role', 'img');
  const parts = [
    ['low', pctLow, 'Below normal'],
    ['normal', pctNormal, 'In normal range'],
    ['high', pctHigh, 'Above normal'],
  ].filter(([k]) => hasHigh || k !== 'high');
  const text = parts.map(([, p, name]) => `${Math.round(p)}% ${name.toLowerCase()}`).join(', ');
  bar.setAttribute('aria-label', `${label}: ${text}`);
  for (const [k, p, name] of parts) {
    if (p < 0.5) continue;
    const s = document.createElement('span');
    s.className = 'tir-seg ' + k;
    s.style.flexGrow = p;
    s.title = `${name}: ${Math.round(p)}%`;
    bar.appendChild(s);
  }
  const legend = document.createElement('div');
  legend.className = 'tir-legend';
  for (const [k, p, name] of parts) {
    const item = document.createElement('span');
    const key = document.createElement('i');
    key.className = 'tir-key ' + k;
    const b = document.createElement('b');
    b.textContent = `${Math.round(p)}%`;
    item.append(key, b, ' ' + name.toLowerCase());
    legend.appendChild(item);
  }
  host.append(bar, legend);
}
