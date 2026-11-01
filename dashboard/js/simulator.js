/* Demo mode: emits the same JSON lines the ESP8266 firmware sends, so the whole
   pipeline (parsing, charts, engagement, alerts) can be shown without hardware. */

const SCENARIOS = {
  tachycardia: { label: 'Tachycardia', ms: 45000 },
  hypoxia: { label: 'Low SpO₂', ms: 45000 },
  fever: { label: 'Fever', ms: 90000 },
  fall: { label: 'Fall', ms: 20000 },
  remove: { label: 'Remove sensor', ms: 75000 },
};

class Simulator {
  constructor(onLine) {
    this.onLine = onLine;
    this.timer = null;
  }

  start() {
    this.t0 = Date.now();
    this.hr = 74;
    this.spo2 = 98;
    this.temp = 36.6;
    this.steps = 0;
    this.scenario = null;
    this.onLine(JSON.stringify({ type: 'hello', device: 'Simulator', fw: 'demo', sensors: { max30102: true, mpu6050: true, lm35: true } }));
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  inject(kind) {
    this.scenario = kind === 'normal' ? null : { kind, until: Date.now() + SCENARIOS[kind].ms, fired: false };
  }

  tick() {
    const now = Date.now();
    if (this.scenario && now > this.scenario.until) this.scenario = null;
    const sc = this.scenario ? this.scenario.kind : null;
    const sec = (now - this.t0) / 1000;
    const noise = (a) => (Math.random() - 0.5) * 2 * a;

    // Walks for ~25 s out of every 90 s; still during a fall scenario.
    const walking = sc !== 'fall' && sec % 90 < 25;
    const motion = walking ? 0.14 + noise(0.04) : 0.012 + Math.abs(noise(0.01));
    if (walking) this.steps += 1 + Math.round(Math.random());

    const hrTarget = sc === 'tachycardia' ? 138 : walking ? 96 : 74;
    const spo2Target = sc === 'hypoxia' ? 87 : 98;
    const tempTarget = sc === 'fever' ? 38.8 : 36.6;
    this.hr += (hrTarget - this.hr) * 0.15 + noise(1.5);
    this.spo2 += (spo2Target - this.spo2) * 0.2 + noise(0.4);
    this.temp += (tempTarget - this.temp) * 0.05 + noise(0.03);

    const finger = sc !== 'remove';
    let fall = 0;
    if (sc === 'fall' && !this.scenario.fired) {
      this.scenario.fired = true;
      fall = 1;
    }

    this.onLine(JSON.stringify({
      type: 'data',
      t: Math.round(now - this.t0),
      hr: finger ? Math.round(this.hr) : null,
      spo2: finger ? Math.min(100, Math.round(this.spo2)) : null,
      finger: finger ? 1 : 0,
      ir: finger ? 80000 + Math.round(noise(3000)) : 3000,
      temp: Math.round(this.temp * 10) / 10,
      motion: Math.round(motion * 1000) / 1000,
      steps: this.steps,
      fall,
    }));
  }
}
