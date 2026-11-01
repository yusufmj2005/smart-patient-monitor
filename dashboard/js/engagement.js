/* Patient engagement score (0-100), computed over a rolling window.

   This is a transparent, rule-based baseline so the dashboard works end to end today.
   The trained AI model (Objective 2) can replace Engagement.compute() later; the
   exported session CSV is the training data for it.

   Components and weights:
     wear        35%  share of samples with a finger on the MAX30102 (is the patient wearing it?)
     activity    25%  share of samples with movement >= ACTIVE_G, relative to ACTIVE_GOAL
     stability   25%  share of readings where every available vital is inside the normal range
     continuity  15%  samples received vs. expected (device kept on and connected)
*/

const Engagement = {
  WINDOW_MS: 10 * 60 * 1000,
  MIN_SAMPLES: 20,
  ACTIVE_G: 0.05,
  ACTIVE_GOAL: 0.3,
  WEIGHTS: { wear: 0.35, activity: 0.25, stability: 0.25, continuity: 0.15 },

  compute(samples, now, th) {
    const from = now - this.WINDOW_MS;
    let n = 0, worn = 0, active = 0, vitN = 0, vitOk = 0, first = now;
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i];
      if (s.ts < from) break;
      n++;
      first = s.ts;
      if (s.finger) worn++;
      if (s.motion != null && s.motion >= this.ACTIVE_G) active++;
      const ok = vitalsInRange(s, th);
      if (ok !== null) {
        vitN++;
        if (ok) vitOk++;
      }
    }
    if (n < this.MIN_SAMPLES) return { score: null, collected: n, needed: this.MIN_SAMPLES };

    const expected = (now - first) / 1000 + 1;
    const parts = {
      wear: worn / n,
      activity: Math.min(1, active / n / this.ACTIVE_GOAL),
      stability: vitN ? vitOk / vitN : 0,
      continuity: Math.min(1, n / expected),
    };
    let score = 0;
    for (const k in this.WEIGHTS) score += this.WEIGHTS[k] * parts[k];
    score = Math.round(score * 100);
    return { score, parts, level: score >= 70 ? 'good' : score >= th.engMin ? 'moderate' : 'low' };
  },
};

/* true = all present vitals in range, false = at least one out of range, null = no vitals present */
function vitalsInRange(s, th) {
  let any = false;
  if (s.hr != null) {
    any = true;
    if (s.hr < th.hrMin || s.hr > th.hrMax) return false;
  }
  if (s.spo2 != null) {
    any = true;
    if (s.spo2 < th.spo2Min) return false;
  }
  if (s.temp != null) {
    any = true;
    if (s.temp < th.tempMin || s.temp > th.tempMax) return false;
  }
  return any ? true : null;
}
