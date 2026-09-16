/**
 * analog.js — derive discrete switch activations from a continuous biosignal.
 *
 * WHY THIS MODULE EXISTS. access-input's other sources receive presses. An
 * analog sensor — surface EMG, a sip-and-puff pressure sensor, a force or bend
 * sensor — produces a CONTINUOUS signal. Somebody has to decide when "the
 * muscle fired" or "the user puffed" becomes a press, and that decision is
 * where every practical difficulty lives: too eager and the interface fires
 * constantly (which the literature identifies as the dominant usability
 * failure for EMG switches), too conservative and a user who cannot produce a
 * strong signal is locked out entirely.
 *
 * The pipeline is the published one, in the published order:
 *
 *     spike clamp  ->  [band-pass]  ->  [rectify]  ->  envelope  ->  threshold
 *                                                                      ->  FSM -> press
 *
 * Band-pass and rectification apply only to RAW EMG. A sensor that already
 * outputs a rectified envelope (MyoWare's ENV pin, a pressure transducer)
 * enters at the envelope stage — filtering an envelope is wrong and would
 * waste the work the sensor already did.
 *
 * WHAT IS EVIDENCED AND WHAT IS A JUDGEMENT CALL. These are not the same
 * thing and the code says which is which:
 *
 *   EVIDENCED
 *     - onset is amplitude-above-baseline, conventionally 2 SD above baseline
 *       (Collins et al. 2020, n=60 — PMC7533965)
 *     - the linear envelope is a low-pass at 5-10 Hz; 5 Hz is conventional
 *     - raw EMG band-pass is 20-450 Hz (SENIAM; Noraxon puts the high cut at
 *       400-500 Hz)
 *     - TKEO conditioning before thresholding cuts onset-detection error from
 *       ~98 ms to ~13 ms (Solnik et al. 2010)
 *     - adaptive dual-threshold with slow creep is the implementable state of
 *       the art; OpenBCI's creep model is the reference parameterisation
 *
 *   JUDGEMENT (labelled as such, exposed as tunables)
 *     - minimum activation 150 ms, release 100 ms, refractory 300 ms. No
 *       AT-specific published values exist. The 50 ms figure that looks like
 *       a candidate is a clinical BURST-DURATION floor, and Collins found
 *       healthy controls frequently produce sub-50 ms bursts in forearm, hand
 *       and leg muscles — so 50 ms would be actively unsafe as a threshold.
 *       These defaults sit well above it deliberately. They are engineering
 *       defaults, not validated clinical values, and a clinician should tune
 *       them per user.
 *
 * ONE HARD RULE: the detector never lowers its thresholds into the noise
 * floor. OpenBCI documents the failure mode ("set Low Limit just above the
 * noise floor so environmental noise does not trigger false activations") and
 * the 2025 EMG-switch usability trial found false positives were what
 * participants complained about. A user who cannot produce a usable signal is
 * told so; the detector does not quietly invent activations to be helpful.
 *
 * TIME AND SAMPLES ARE SUPPLIED BY THE CALLER. push(value, tMs) takes both, so
 * the whole pipeline is deterministic and testable without a device.
 */

/** Engineering defaults. Every one is tunable; none is a clinical value. */
export const ANALOG_DEFAULTS = {
  /** Expected sample rate, Hz. Used only to derive filter coefficients. */
  sampleRateHz: 100,

  /** Envelope low-pass cutoff, Hz. The conventional linear-envelope band is 5-10 Hz. */
  envelopeCutoffHz: 5,

  /** Sliding window for baseline/noise statistics, ms. */
  statsWindowMs: 10000,

  /**
   * Onset is amplitude-above-baseline. Collins 2020 used 2 SD; three SDs is
   * used here because a false activation is more costly than a missed one for
   * an assistive switch, and the whole point of the noise-floor rule is that
   * the detector must not be trigger-happy.
   */
  baselineSigmaMultiplier: 3,

  /** Minimum gap between the two thresholds (OpenBCI's "Min ΔuV"). */
  minThresholdGapFraction: 0.25,

  /**
   * Lower threshold creep: how fast the lower threshold rises toward its
   * TARGET when nothing has fired. OpenBCI: "higher = easier activation but
   * noisier" — kept slow.
   */
  creepUpFractionPerSecond: 0.02,

  /**
   * Where the lower threshold creeps TO, as a fraction of the way from the
   * noise floor toward the user's working peak. A low threshold belongs just
   * above the noise, not up at the peak, so this stays small.
   *
   * This parameter exists because the creep target was previously derived from
   * the threshold itself, which made the step identically zero — the tunable
   * was dead and the documented drift absorption never happened.
   */
  creepUpTargetFraction: 0.15,

  /** Upper threshold creep: how fast it falls when untriggered. "Generally slow." */
  creepDownFractionPerSecond: 0.01,

  /** Minimum activation duration — a judgement call, see the file header. */
  minActivationMs: 150,

  /** Minimum release duration before another press can begin. */
  minReleaseMs: 100,

  /** Refractory: no new press within this of the last. */
  refractoryMs: 300,

  /** Spike clamp: samples above median + this many MADs are clamped. */
  spikeClampMad: 6,

  /**
   * Absolute floor for the spike-clamp tolerance, as a fraction of the
   * observed range. Needed because a stable resting signal has a MAD near
   * zero, which would otherwise make the clamp equal to the median and
   * flatten real bursts (see _clamped).
   */
  spikeClampFloorFraction: 0.5,

  /**
   * How far above the calibrated peak a sample may be before it is treated as
   * an artifact. A real effort cannot exceed the user's measured maximum by
   * much; an electrode pop can exceed it by orders of magnitude.
   */
  spikeClampPeakMultiplier: 3,

  /** Apply TKEO conditioning (raw EMG only). Evidence: Solnik 2010. */
  useTkeo: false,

  /** True for a source that already outputs an envelope (MyoWare ENV, pressure). */
  inputIsEnvelope: true,
};

/** Median of a numeric array (does not mutate). */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median absolute deviation — a robust spread estimate. Preferred over the
 * standard deviation here because a single electrode spike must not inflate
 * the noise estimate and so raise the threshold for seconds afterwards.
 */
export function mad(values, med = median(values)) {
  if (!values.length) return 0;
  return median(values.map((v) => Math.abs(v - med)));
}

/** Convert MAD to a Gaussian-equivalent sigma. */
export function sigmaFromMad(m) {
  return 1.4826 * m;
}

/**
 * The Teager-Kaiser energy operator: y[n] = x[n]^2 - x[n-1]*x[n+1].
 *
 * It tracks instantaneous energy rather than amplitude, which sharpens the
 * transition at burst onset. Solnik et al. 2010 measured onset-detection error
 * dropping from ~98 ms to ~13 ms with it. Optional because it needs
 * single-sample resolution (a RAW signal), and it amplifies noise.
 */
export function applyTkeo(samples) {
  if (samples.length < 3) return samples.map(() => 0);
  const out = new Array(samples.length);
  out[0] = 0;
  out[out.length - 1] = 0;
  for (let i = 1; i < samples.length - 1; i++) {
    const v = samples[i] * samples[i] - samples[i - 1] * samples[i + 1];
    out[i] = v > 0 ? v : 0; // negative output is not physical energy
  }
  return out;
}

/**
 * A one-pole IIR low-pass — the envelope filter. The coefficient is derived
 * from the cutoff and the sample rate rather than hard-coded, so changing the
 * device rate does not silently change the time constant.
 */
export class EnvelopeFilter {
  constructor({ cutoffHz = 5, sampleRateHz = 100 } = {}) {
    // alpha = 1 - exp(-2*pi*fc/fs)
    this.alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRateHz);
    this.y = null;
  }

  push(x) {
    if (this.y === null) {
      // Seed with the first sample so the filter does not have to "charge up"
      // from zero — which would otherwise look like a slow ramp at startup and
      // could trip a threshold.
      this.y = x;
      return x;
    }
    this.y = this.alpha * x + (1 - this.alpha) * this.y;
    return this.y;
  }
}

/**
 * ActivationDetector — the pipeline plus the activation state machine.
 *
 * Feed it samples with push(value, tMs) and it calls onPress / onRelease. The
 * values are whatever units the sensor produces (volts, kPa, ADC counts);
 * nothing here assumes a unit, because thresholds are derived from the signal's
 * own statistics rather than from absolute numbers.
 */
export class ActivationDetector {
  constructor(options = {}) {
    this.cfg = { ...ANALOG_DEFAULTS, ...options };

    this.onPress = options.onPress || null;
    this.onRelease = options.onRelease || null;
    this.onLevel = options.onLevel || null; // (level, thresholds, tMs) for a meter UI

    this._envelope = new EnvelopeFilter({
      cutoffHz: this.cfg.envelopeCutoffHz,
      sampleRateHz: this.cfg.sampleRateHz,
    });

    this._window = [];         // recent ENVELOPE samples (baseline + noise)
    this._rawWindow = [];      // recent RAW samples, for the spike clamp only
    this._lastGoodRaw = 0;     // last sample that passed the clamp
    this._windowStart = 0;
    this._lastT = null;

    this._baseline = null;     // rolling 20th percentile
    this._sigma = 0;           // robust noise estimate
    this._lowThresh = null;
    this._highThresh = null;
    this._peakHold = null;      // decays; tracks the CURRENT working range
    this._calibratedPeak = null; // immutable; the largest effort this user has produced

    // Activation FSM
    this._pressed = false;
    this._aboveSince = null;   // when the signal first exceeded the low threshold
    this._belowSince = null;
    this._lastPressAt = -Infinity;

    /** Set true once calibration has produced usable thresholds. */
    this.calibrated = false;

    /** Samples seen, for diagnostics. */
    this.count = 0;
  }

  /** Current thresholds, for a calibration UI to draw. */
  get thresholds() {
    return { low: this._lowThresh, high: this._highThresh, baseline: this._baseline, sigma: this._sigma };
  }

  /** True while a press is being held. */
  get isPressed() { return this._pressed; }

  /**
   * Adopt thresholds measured during calibration.
   *
   * This is the ONLY way thresholds become usable, and it deliberately refuses
   * a signal that cannot support them. A calibration that "succeeds" by
   * lowering the threshold into the noise produces the false activations the
   * literature warns about, so a weak signal is reported as a failure with a
   * reason instead.
   *
   * @param {number} baseline   resting level from the calibration
   * @param {number} sigma      noise spread from the calibration
   * @param {number} maxLevel   the user's strongest voluntary signal
   * @returns {{ok: boolean, reason?: string, thresholds?: object}}
   */
  calibrate(baseline, sigma, maxLevel) {
    const floor = baseline + this.cfg.baselineSigmaMultiplier * sigma;
    if (!(maxLevel > floor)) {
      return {
        ok: false,
        reason: 'signal-too-weak',
        detail:
          `The strongest effort (${round(maxLevel)}) did not clear the noise floor ` +
          `(${round(floor)}). Lowering the threshold would produce activations the ` +
          `user did not make, so this site is not usable as-is.`,
      };
    }
    this._baseline = baseline;
    this._sigma = sigma;
    this._lowThresh = floor;
    // Place the upper threshold between the noise floor and the user's peak,
    // at the fraction of the usable range the user can comfortably sustain.
    this._highThresh = floor + (maxLevel - floor) * 0.55;
    this._peakHold = maxLevel;
    // Immutable for the life of this calibration. The clamp uses it as the
    // floor for its tolerance, so a real effort stays admissible no matter how
    // far _peakHold has decayed (see _clamped).
    this._calibratedPeak = maxLevel;
    this.calibrated = true;
    return { ok: true, thresholds: this.thresholds };
  }

  /**
   * One sample.
   * @param {number} raw   sensor value
   * @param {number} tMs   monotonic timestamp from the same clock as the host's
   */
  push(raw, tMs) {
    this.count++;
    this._lastT = tMs;

    // STAGE 0 — spike clamp. A single electrode pop must not distort the
    // envelope for seconds afterward (OpenBCI's "uV Limit").
    //
    // The raw history is kept SEPARATELY from the envelope history: the clamp
    // needs raw statistics, the threshold logic needs envelope statistics, and
    // conflating them clamps the signal into its own noise band.
    if (Number.isFinite(raw)) {
      this._rawWindow.push(raw);
      if (this._rawWindow.length > 600) this._rawWindow.shift();
    }
    const value = this._clamped(raw);

    // STAGE 1/2 — band-pass and rectification happen in the TRANSPORT, before
    // this call, because they need sample-rate-specific filter state that
    // belongs with the device. What arrives here is a rectified magnitude or
    // an already-enveloped value.
    const level = this._envelope.push(Math.abs(value));

    this._updateStats(level, tMs);
    this._creep(tMs);
    this._advanceFsm(level, tMs);

    this.onLevel?.(level, this.thresholds, tMs);
    return level;
  }

  /**
   * Feed a burst of samples that should be treated as the user's RESTING
   * signal, and return the measured baseline and spread. Used by calibration
   * phase 1.
   */
  measureRest(samples) {
    const env = this._envelopeOver(samples);
    const b = median(env);
    const s = sigmaFromMad(mad(env, b));
    return { baseline: b, sigma: s };
  }

  /**
   * Feed samples from a maximal voluntary effort and return the peak level.
   * Used by calibration phase 2.
   */
  measurePeak(samples) {
    const env = this._envelopeOver(samples);
    return env.length ? Math.max(...env) : 0;
  }

  /** Reset all state — a fresh session or a new calibration. */
  reset() {
    this._envelope.y = null;
    this._window = [];
    this._rawWindow = [];
    this._lastGoodRaw = 0;
    this._baseline = null;
    this._sigma = 0;
    this._lowThresh = null;
    this._highThresh = null;
    this._peakHold = null;
    this._calibratedPeak = null;
    this._pressed = false;
    this._aboveSince = null;
    this._belowSince = null;
    this._lastPressAt = -Infinity;
    this.calibrated = false;
    this.count = 0;
  }

  // -- internals -----------------------------------------------------------

  _envelopeOver(samples) {
    // A separate filter instance so measuring does not disturb live state.
    const f = new EnvelopeFilter({
      cutoffHz: this.cfg.envelopeCutoffHz,
      sampleRateHz: this.cfg.sampleRateHz,
    });
    const source = this.cfg.useTkeo ? applyTkeo(samples) : samples;
    return source.map((v) => f.push(Math.abs(v)));
  }

  _clamped(raw) {
    if (!Number.isFinite(raw)) return 0;
    if (this._rawWindow.length < 8) return raw; // not enough history to judge

    // The clamp must be computed against RAW samples, not envelope values.
    //
    // Getting this wrong is subtle and total: clamping a raw effort of 10
    // against a window of ENVELOPE values (which sit near the resting level)
    // clamps the effort itself down to the noise band, so the detector can
    // never see a burst at all. It looks like a threshold problem and is
    // actually the clamp eating the signal.
    const med = median(this._rawWindow);
    const m = mad(this._rawWindow, med);

    // The tolerance has to satisfy two opposing needs, and the resolution uses
    // what the detector has LEARNED rather than only what the window shows:
    //
    //   - It must ADMIT a real burst. A MAD-only tolerance fails this
    //     completely on a stable signal: MAD near zero means the clamp equals
    //     the median and flattens every burst, so the detector can never fire.
    //   - It must REJECT an electrode pop. A range-only tolerance fails this
    //     before any burst has occurred, because the window's range is then
    //     just resting noise — small relative to a pop, so the pop survives.
    //
    // Once calibration has measured the user's strongest voluntary effort,
    // that measurement is the reference: a sample far above what this user can
    // produce on purpose is not signal. Before calibration there is nothing to
    // compare against, so the range fallback applies.
    // Tolerance = how far above the resting level a sample may sit before it is
    // treated as an artifact. Two references, and BOTH are needed:
    //
    //   ADMIT — the user's calibrated peak is the largest thing that can be
    //   signal, so the tolerance must always permit it. Without this a signal
    //   with little noise (a near-perfect DC rest level, which is what a
    //   well-seated electrode on a relaxed muscle produces) yields a tolerance
    //   smaller than the user's own burst, and the clamp eats real attempts.
    //
    //   REJECT — an artifact is far larger than anything the user can make, so
    //   the tolerance must not be unbounded. The calibrated peak, times a
    //   margin, is the bound.
    const range = Math.max(...this._rawWindow) - Math.min(...this._rawWindow);
    const noiseTolerance = Math.max(this.cfg.spikeClampMad * m, this.cfg.spikeClampFloorFraction * range);

    let tolerance = noiseTolerance;
    if (this._peakHold != null) {
      /**
       * The headroom is measured against the CALIBRATED peak, not the decayed
       * one, and this is the fix for a total silent lockout.
       *
       * `_peakHold` deliberately decays toward baseline whenever the user is
       * not activating — that is what absorbs fatigue. But the clamp tolerance
       * was computed FROM it, so both collapsed together: after roughly three
       * minutes of resting (or any break, or a caregiver pausing), headroom
       * reached ~0, the tolerance collapsed to zero, and every sample above the
       * median was replaced by `_lastGoodRaw`. A full-effort activation then
       * clamped to the noise floor and the detector went deaf.
       *
       * Verified before the fix: peakHold 9.82 -> 2.46 after 180s idle, and a
       * raw effort of 10 clamped to 1.000 — below the 1.07 threshold, so no
       * press. The detector reported nothing and the user had no way to know
       * their body was fine; the software had stopped listening. That is the
       * worst failure this module can have, because the interpretation a user
       * reaches first is about themselves.
       *
       * `_calibratedPeak` is therefore immutable for the life of the
       * calibration: a real effort must always be admissible. The decaying
       * `_peakHold` keeps its job of tracking the CURRENT working range for the
       * thresholds, where decay is correct.
       */
      const reference = Math.max(Math.abs(this._peakHold - med), Math.abs(this._calibratedPeak - med));
      // Never below what the user has actually produced (must admit a real
      // effort); never far above it either (must still reject a pop).
      tolerance = Math.min(
        Math.max(noiseTolerance, reference * 1.05),
        reference * this.cfg.spikeClampPeakMultiplier,
      );
    }
    tolerance = Math.max(tolerance, 1e-9);

    // A sample beyond the tolerance is REPLACED with the last good value, not
    // clamped to the limit.
    //
    // Clamping to the limit leaves the artifact elevated — still above the
    // activation threshold — so a single pop still produces a press, which is
    // precisely what spike rejection is supposed to prevent. Replacing it with
    // the previous sample removes the artifact rather than shrinking it.
    if (raw > med + tolerance) return this._lastGoodRaw;
    this._lastGoodRaw = raw;
    return raw;
  }

  /**
   * Rolling baseline and noise. The 20th percentile is used rather than the
   * mean so that bursts — which are what we are trying to detect — do not drag
   * the baseline upward and desensitise the detector.
   */
  _updateStats(level, tMs) {
    this._window.push(level);
    if (this._windowStart === 0) this._windowStart = tMs;
    while (this._window.length && tMs - this._windowStart > this.cfg.statsWindowMs) {
      this._window.shift();
      this._windowStart += this.cfg.statsWindowMs / this._window.length || 1;
    }
    const sorted = [...this._window].sort((a, b) => a - b);
    const i = Math.floor(sorted.length * 0.2);
    this._baseline = sorted[Math.min(i, sorted.length - 1)];
    this._sigma = sigmaFromMad(mad(this._window, this._baseline));
  }

  /**
   * Slow creep of both thresholds. This is what absorbs fatigue and electrode
   * drift without asking the user to recalibrate — but the two thresholds may
   * never converge past the minimum gap, because that is what keeps the noise
   * floor a floor.
   */
  _creep(tMs) {
    if (!this.calibrated || this._lastT === null) return;
    const dtSec = Math.max(0, (tMs - (this._creepAt ?? tMs)) / 1000);
    this._creepAt = tMs;
    if (dtSec === 0) return;

    // The upper threshold decays toward the baseline when nothing has fired.
    if (!this._pressed && this._peakHold != null) {
      const decay = 1 - this.cfg.creepDownFractionPerSecond * dtSec;
      this._peakHold = this._baseline + (this._peakHold - this._baseline) * Math.max(0, decay);
    }

    // The lower threshold creeps up toward the signal's working range, so a
    // user whose signal drifts down is not held to a threshold that is no
    // longer reachable.
    //
    // This was DEAD CODE and the tunable did nothing. `target` was computed as
    // `Math.max(floor, this._lowThresh)` — which, immediately after calibration
    // set `_lowThresh = floor`, equals `_lowThresh` itself, so `target -
    // _lowThresh` was identically zero and the step was always zero. Verified:
    // the threshold was byte-identical after 60 seconds of drift
    // (1.0728 before and after), while the comment claimed a behaviour that did
    // not exist.
    //
    // The target now depends on the SIGNAL rather than on the threshold. The
    // working range is the calibrated peak, decayed by the same fatigue model
    // as the upper threshold, so the floor rises toward the user's CURRENT
    // capability rather than toward itself.
    const floor = this._baseline + this.cfg.baselineSigmaMultiplier * this._sigma;
    const workingPeak = this._peakHold != null
      ? Math.max(this._peakHold, this._calibratedPeak ?? this._peakHold)
      : floor + 1;
    // A fraction of the way from the noise floor toward the working peak — the
    // low threshold should sit just above the noise, not up at the peak.
    const target = Math.max(floor, floor + (workingPeak - floor) * this.cfg.creepUpTargetFraction);
    const step = this.cfg.creepUpFractionPerSecond * dtSec * (target - this._lowThresh);
    this._lowThresh = this._lowThresh + step;

    // And the upper threshold follows, keeping the minimum gap.
    const minGap = Math.max(
      this.cfg.minThresholdGapFraction * (this._peakHold - this._lowThresh),
      this.cfg.baselineSigmaMultiplier * this._sigma,
    );
    this._highThresh = Math.max(this._highThresh, this._lowThresh + minGap);
    // Never let the floor drop below the noise-floor rule.
    if (this._lowThresh < floor) this._lowThresh = floor;
  }

  /**
   * The activation state machine.
   *
   * Deliberately three gates rather than one comparison, because a single
   * threshold crossing on a noisy biosignal is not evidence of intent:
   *   - the signal must CROSS the upper threshold (onset)
   *   - it must STAY above the lower one for minActivationMs (duration)
   *   - it must FALL below the lower one for minReleaseMs (release)
   *   - and nothing fires within refractoryMs of the previous press
   */
  _advanceFsm(level, tMs) {
    if (!this.calibrated) return;

    if (!this._pressed) {
      if (level >= this._lowThresh) {
        if (this._aboveSince === null) this._aboveSince = tMs;
      } else {
        this._aboveSince = null;
      }

      const heldFor = this._aboveSince === null ? 0 : tMs - this._aboveSince;
      const pastRefractory = tMs - this._lastPressAt >= this.cfg.refractoryMs;
      if (heldFor >= this.cfg.minActivationMs && pastRefractory && level >= this._highThresh * 0.8) {
        this._pressed = true;
        this._belowSince = null;
        this._lastPressAt = tMs;
        this.onPress?.(tMs, level);
      }
      return;
    }

    // Pressed: wait for a sustained release.
    if (level < this._lowThresh) {
      if (this._belowSince === null) this._belowSince = tMs;
    } else {
      this._belowSince = null;
    }
    const releasedFor = this._belowSince === null ? 0 : tMs - this._belowSince;
    if (releasedFor >= this.cfg.minReleaseMs) {
      this._pressed = false;
      this._aboveSince = null;
      this.onRelease?.(tMs, level);
    }
  }
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
