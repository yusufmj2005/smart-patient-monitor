/* Dependency-free time-series chart drawn on <canvas>, so the dashboard works offline in the lab. */

class TimeChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{min:number, max:number, step:number, decimals?:number, colorVar:string,
   *          band?:[number, number]|null, gapMs?:number}} opts
   *   min/max: default y range (expanded to fit data, snapped to `step`)
   *   band: normal range, shaded behind the line
   *   gapMs: break the line when consecutive points are further apart than this
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.o = Object.assign({ decimals: 0, band: null, gapMs: 3000 }, opts);
    this.points = [];
    this.t0 = 0;
    this.t1 = 1;
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  setData(points, t0, t1) {
    this.points = points;
    this.t0 = t0;
    this.t1 = t1;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const color = (name) => css.getPropertyValue(name).trim();
    const { step, decimals, band } = this.o;

    let lo = this.o.min;
    let hi = this.o.max;
    for (const p of this.points) {
      if (p.v == null) continue;
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    // Snap the range to whole steps, then pick a tick stride (in steps) giving at most 5 intervals.
    lo = Math.floor(lo / step + 1e-9) * step;
    hi = Math.ceil(hi / step - 1e-9) * step;
    const nSteps = Math.max(1, Math.round((hi - lo) / step));
    const stride = Math.ceil(nSteps / 5);
    const ticks = Math.ceil(nSteps / stride);
    hi = lo + ticks * stride * step;

    const pad = { l: 38, r: 10, t: 8, b: 20 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const span = Math.max(this.t1 - this.t0, 1);
    const x = (t) => pad.l + ((t - this.t0) / span) * pw;
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ph;

    if (band) {
      const top = y(Math.min(band[1], hi));
      const bottom = y(Math.max(band[0], lo));
      if (bottom > top) {
        ctx.fillStyle = color('--band');
        ctx.fillRect(pad.l, top, pw, bottom - top);
      }
    }

    ctx.font = '11px ' + color('--font-ui');
    ctx.fillStyle = color('--muted');
    ctx.strokeStyle = color('--grid');
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= ticks; i++) {
      const v = lo + ((hi - lo) * i) / ticks;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      ctx.fillText(v.toFixed(decimals), pad.l - 6, yy);
    }

    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('−' + formatSpan(span), pad.l, h - pad.b + 5);
    ctx.textAlign = 'right';
    ctx.fillText('now', w - pad.r, h - pad.b + 5);

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t - 2, pw, ph + 4);
    ctx.clip();
    ctx.strokeStyle = color(this.o.colorVar);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let penDown = false;
    let prevT = null;
    let last = null;
    for (const p of this.points) {
      if (p.v == null || (prevT != null && p.t - prevT > this.o.gapMs)) penDown = false;
      prevT = p.t;
      if (p.v == null) continue;
      const X = x(p.t);
      const Y = y(p.v);
      if (penDown) ctx.lineTo(X, Y);
      else ctx.moveTo(X, Y);
      penDown = true;
      last = { X, Y };
    }
    ctx.stroke();
    if (last) {
      ctx.fillStyle = color(this.o.colorVar);
      ctx.beginPath();
      ctx.arc(last.X, last.Y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function formatSpan(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(s % 3600 ? 1 : 0) + 'h';
}
