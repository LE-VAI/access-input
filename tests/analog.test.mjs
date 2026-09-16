/**
 * analog.test.mjs — the biosignal pipeline and its activation state machine.
 *
 * These tests exist because the constants in this module are the difference
 * between an assistive switch that helps someone and one that fires while they
 * are resting. The literature is clear that false activations are the dominant
 * usability failure for EMG switches, so most of what follows is about the
 * detector REFUSING to fire:
 *
 *   - noise must not produce activations
 *   - a brief spike must not produce an activation
 *   - a weak signal must be REPORTED, not rescued by lowering the threshold
 *   - and a genuine sustained effort must fire, exactly once
 *
 * Everything is deterministic: samples and timestamps are supplied by the test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActivationDetector,
  EnvelopeFilter,
  applyTkeo,
  median,
  mad,
  sigmaFromMad,
  ANALOG_DEFAULTS,
} from '../src/analog.js';

// -- statistics helpers -----------------------------------------------------

test('median handles odd, even, and empty input', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test('mad is robust to a single outlier where stdev is not', () => {
  const clean = [10, 10, 10, 10, 10, 11, 9, 10];
  const spiked = [...clean.slice(0, 7), 9999];
  // The MAD barely moves — which is the whole point: one electrode pop must
  // not inflate the noise estimate and desensitise the detector for seconds.
  assert.ok(mad(spiked) < 5, `mad inflated to ${mad(spiked)}`);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const stdev = Math.sqrt(mean(clean.map((v) => (v - mean(clean)) ** 2)));
  const stdevSpiked = Math.sqrt(mean(spiked.map((v) => (v - mean(spiked)) ** 2)));
  assert.ok(stdevSpiked > stdev * 10, 'the outlier should wreck a stdev');
});

test('sigmaFromMad converts to a Gaussian-equivalent sigma', () => {
  assert.ok(Math.abs(sigmaFromMad(1) - 1.4826) < 1e-9);
});

// -- envelope filter --------------------------------------------------------

test('the envelope filter seeds from its first sample, not from zero', () => {
  // Charging up from zero would look like a slow ramp at startup and could
  // trip a threshold on a signal that was never quiet.
  const f = new EnvelopeFilter({ cutoffHz: 5, sampleRateHz: 100 });
  const out = f.push(7);
  assert.equal(out, 7, 'first output equals the first input');
});

test('the envelope coefficient follows cutoff and sample rate', () => {
  // alpha = 1 - exp(-2*pi*fc/fs); at 5 Hz / 100 Hz that is ~0.2695
  const f = new EnvelopeFilter({ cutoffHz: 5, sampleRateHz: 100 });
  assert.ok(Math.abs(f.alpha - 0.2695) < 0.001, `alpha=${f.alpha}`);
  // A faster sample rate at the same cutoff is a slower filter in samples.
  const g = new EnvelopeFilter({ cutoffHz: 5, sampleRateHz: 1000 });
  assert.ok(g.alpha < f.alpha, 'higher sample rate gives a smaller per-sample step');
});

test('the envelope smooths a step rather than following it instantly', () => {
  const f = new EnvelopeFilter({ cutoffHz: 5, sampleRateHz: 100 });
  f.push(0);
  const afterOne = f.push(1);
  assert.ok(afterOne < 0.35, `one sample should not reach the target: ${afterOne}`);
  let v = afterOne;
  for (let i = 0; i < 40; i++) v = f.push(1);
  assert.ok(v > 0.9, `should approach the target after ~40 samples: ${v}`);
});

// -- TKEO -------------------------------------------------------------------

test('TKEO sharpens a burst onset and ignores flat signal', () => {
  const flat = Array(20).fill(5);
  const flatOut = applyTkeo(flat);
  assert.ok(flatOut.every((v) => Math.abs(v) < 1e-9), 'a constant signal has zero energy');

  // An onset step should produce a spike in energy at the transition.
  const ramp = [...Array(10).fill(0), ...Array(10).fill(5)];
  const out = applyTkeo(ramp);
  const peak = Math.max(...out);
  assert.ok(peak > 0, 'the transition has energy');
  assert.ok(out[9] > 0 || out[10] > 0, 'the energy sits at the boundary');
});

test('TKEO never returns negative energy', () => {
  const noisy = [1, -3, 5, -2, 4, -6, 2];
  assert.ok(applyTkeo(noisy).every((v) => v >= 0));
});

// -- calibration: the refusal path -----------------------------------------

/**
 * Build a detector and calibrate it against a synthetic resting signal and a
 * synthetic effort, mirroring what a real calibration flow would do.
 */
function calibratedDetector({ restAmp = 1, noiseAmp = 0.1, peakAmp = 10, options = {} } = {}) {
  const det = new ActivationDetector({ sampleRateHz: 100, ...options });
  const rest = [];
  for (let i = 0; i < 300; i++) {
    // Deterministic pseudo-noise so the test is reproducible.
    const n = Math.sin(i * 12.9898) * 43758.5453;
    rest.push(restAmp + (n - Math.floor(n) - 0.5) * noiseAmp * 2);
  }
  const effort = [];
  for (let i = 0; i < 150; i++) effort.push(peakAmp);
  const result = det.calibrate(det.measureRest(rest).baseline, det.measureRest(rest).sigma, det.measurePeak(effort));
  return { det, result };
}

test('calibration SUCCEEDS when the effort clears the noise floor', () => {
  const { det, result } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`);
  assert.ok(det.calibrated);
  assert.ok(det.thresholds.low > 1, 'the low threshold sits above the resting level');
  assert.ok(det.thresholds.high > det.thresholds.low, 'high above low');
});

test('calibration REFUSES a signal too weak to clear the noise floor', () => {
  // The important failure. Rescuing this by lowering the threshold is what
  // produces activations the user did not make.
  const { det, result } = calibratedDetector({ restAmp: 5, noiseAmp: 2, peakAmp: 5.5 });
  assert.equal(result.ok, false, 'a weak signal must not calibrate');
  assert.equal(result.reason, 'signal-too-weak');
  assert.ok(/noise floor/i.test(result.detail), 'the reason explains the noise floor');
  assert.equal(det.calibrated, false, 'and the detector stays uncalibrated');
});

test('an uncalibrated detector never fires, whatever the signal', () => {
  const fired = [];
  const det = new ActivationDetector({ sampleRateHz: 100 });
  det.onPress = () => fired.push(1);
  for (let i = 0; i < 200; i++) det.push(100, i * 10); // a huge constant signal
  assert.equal(fired.length, 0, 'no calibration means no activations at all');
});

// -- the activation state machine ------------------------------------------

test('NOISE alone produces no activations', () => {
  // The single most important test in this file.
  const fired = [];
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.2, peakAmp: 10 });
  det.onPress = () => fired.push(1);
  let t = 0;
  for (let i = 0; i < 2000; i++) {
    const n = Math.sin(i * 78.233) * 43758.5453;
    const noise = 1 + (n - Math.floor(n) - 0.5) * 0.2 * 2;
    det.push(noise, (t += 10)); // 20 seconds of resting signal
  }
  assert.equal(fired.length, 0, `noise fired ${fired.length} times`);
});

test('a SUSTAINED effort fires exactly one press', () => {
  const fired = [];
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  det.onPress = (tMs) => fired.push(tMs);
  let t = 0;
  // Settle on rest.
  for (let i = 0; i < 200; i++) det.push(1, (t += 10));
  // One second of effort.
  for (let i = 0; i < 100; i++) det.push(10, (t += 10));
  assert.equal(fired.length, 1, `expected one press, got ${fired.length}`);
});

test('effort shorter than minActivationMs does NOT fire', () => {
  // A brief spike is not intent. minActivationMs is a judgement-call default
  // (no AT-specific published value exists) and sits well above the 50 ms
  // clinical burst floor, which healthy controls routinely breach.
  const fired = [];
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  det.onPress = () => fired.push(1);
  let t = 0;
  for (let i = 0; i < 200; i++) det.push(1, (t += 10));
  for (let i = 0; i < 8; i++) det.push(10, (t += 10)); // 80 ms — under 150 ms
  for (let i = 0; i < 200; i++) det.push(1, (t += 10));
  assert.equal(fired.length, 0, 'a sub-threshold-effort spike must not fire');
});

test('a press is not re-fired within the refractory period', () => {
  const fired = [];
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  det.onPress = () => fired.push(1);
  let t = 0;
  for (let i = 0; i < 200; i++) det.push(1, (t += 10));
  // Two efforts separated by less than the refractory window.
  for (let i = 0; i < 40; i++) det.push(10, (t += 10)); // press
  for (let i = 0; i < 5; i++) det.push(1, (t += 10));   // brief release
  for (let i = 0; i < 40; i++) det.push(10, (t += 10)); // second effort, too soon
  assert.equal(fired.length, 1, `refractory should suppress the second: ${fired.length}`);
});

test('two efforts separated by a real release fire twice', () => {
  const fired = [];
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  det.onPress = () => fired.push(1);
  let t = 0;
  for (let i = 0; i < 200; i++) det.push(1, (t += 10));
  for (let i = 0; i < 40; i++) det.push(10, (t += 10));  // press one
  for (let i = 0; i < 100; i++) det.push(1, (t += 10));  // long release
  for (let i = 0; i < 40; i++) det.push(10, (t += 10));  // press two
  assert.equal(fired.length, 2, `expected two presses, got ${fired.length}`);
});

test('release is reported when the effort ends', () => {
  const released = [];
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  det.onRelease = () => released.push(1);
  let t = 0;
  for (let i = 0; i < 200; i++) det.push(1, (t += 10));
  for (let i = 0; i < 40; i++) det.push(10, (t += 10));
  assert.equal(released.length, 0, 'still pressed');
  for (let i = 0; i < 60; i++) det.push(1, (t += 10));
  assert.equal(released.length, 1, 'released after the signal falls');
});

// -- CRITICAL: the idle-gap lockout ----------------------------------------

test('CRITICAL: an idle gap must NOT lock the detector out', () => {
  // The worst failure this module can have, because the user reads it as their
  // own body failing rather than the software.
  //
  // The spike clamp's tolerance was computed from `_peakHold`, which decays
  // toward baseline whenever the user is not activating. Both collapsed
  // together: after ~3 minutes of resting, headroom reached zero, the tolerance
  // collapsed, and every effort was replaced by the last good sample. Verified
  // before the fix — peakHold 9.82 -> 2.46 after 180s, and a raw effort of 10
  // clamped to 1.000, below the 1.07 threshold. No press, no error, nothing.
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  let t = 0;
  for (let i = 0; i < 200; i++) det.push(1, (t += 10));

  // Three minutes of rest — a break, a conversation, a caregiver's pause.
  for (let i = 0; i < 18000; i++) det.push(1, (t += 10));

  // The user's normal effort.
  const fired = [];
  det.onPress = () => fired.push(1);
  for (let i = 0; i < 100; i++) det.push(10, (t += 10));

  assert.equal(fired.length, 1,
    'a real effort after a rest must still activate — silence here means the user ' +
    'concludes their body stopped working');
});

test('_peakHold still decays — the clamp fix must not disable fatigue adaptation', () => {
  // The fix must be surgical: the clamp stops depending on the decayed value,
  // but the decay itself is what absorbs fatigue and must remain.
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  let t = 0;
  for (let i = 0; i < 200; i++) det.push(1, (t += 10));
  const peakBefore = det._peakHold;
  for (let i = 0; i < 6000; i++) det.push(1, (t += 10)); // 60s rest
  assert.ok(det._peakHold < peakBefore, 'peakHold must still decay — that is the fatigue model');
  assert.equal(det._calibratedPeak, 10, 'but the calibrated peak is immutable');
});

// -- robustness -------------------------------------------------------------

test('a single huge spike does not fire and does not poison the baseline', () => {
  const fired = [];
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  det.onPress = () => fired.push(1);
  const before = det.thresholds.low;
  let t = 0;
  for (let i = 0; i < 200; i++) det.push(1, (t += 10));
  det.push(9999, (t += 10)); // electrode pop
  for (let i = 0; i < 60; i++) det.push(1, (t += 10));
  assert.equal(fired.length, 0, 'a spike is not an activation');
  // The threshold should be essentially unchanged — the spike clamp plus the
  // robust statistics are what prevent a pop from desensitising the detector.
  assert.ok(det.thresholds.low < before * 3, `threshold drifted to ${det.thresholds.low} from ${before}`);
});

test('non-finite samples are ignored rather than corrupting state', () => {
  const fired = [];
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  det.onPress = () => fired.push(1);
  let t = 0;
  for (let i = 0; i < 100; i++) det.push(1, (t += 10));
  det.push(NaN, (t += 10));
  det.push(Infinity, (t += 10));
  det.push(-Infinity, (t += 10));
  for (let i = 0; i < 100; i++) det.push(1, (t += 10));
  assert.equal(fired.length, 0, 'garbage samples must not fire');
  assert.ok(Number.isFinite(det.thresholds.low), 'thresholds stay finite');
});

test('the creep adapts the floor upward but never below the noise rule', () => {
  // Simulates fatigue/drift: the resting level rises over a long session. The
  // floor should follow it (so the user is not held to an unreachable
  // threshold) but must never fall below baseline + k*sigma.
  const { det } = calibratedDetector({ restAmp: 1, noiseAmp: 0.1, peakAmp: 10 });
  let t = 0;
  for (let i = 0; i < 6000; i++) det.push(3, (t += 10)); // 60 s at a raised rest level
  const { low, baseline, sigma } = det.thresholds;
  const floor = baseline + ANALOG_DEFAULTS.baselineSigmaMultiplier * sigma;
  assert.ok(low >= floor - 1e-9, `floor violated: low=${low} floor=${floor}`);
});

test('reset clears calibration and state', () => {
  const { det } = calibratedDetector();
  assert.equal(det.calibrated, true);
  det.reset();
  assert.equal(det.calibrated, false);
  assert.equal(det.thresholds.low, null);
  assert.equal(det.count, 0);
});

test('defaults are exported so a clinician can tune without forking', () => {
  // Every gate is a named, documented default — and the ones with no published
  // AT value must be identifiable as judgement calls.
  assert.equal(typeof ANALOG_DEFAULTS.minActivationMs, 'number');
  assert.equal(typeof ANALOG_DEFAULTS.refractoryMs, 'number');
  assert.equal(typeof ANALOG_DEFAULTS.baselineSigmaMultiplier, 'number');
  assert.ok(ANALOG_DEFAULTS.minActivationMs > 50,
    'the activation floor must sit above the clinical 50ms burst figure');
});
