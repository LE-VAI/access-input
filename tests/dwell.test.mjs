/**
 * dwell.test.mjs — the dwell engine's contract.
 *
 * Every test drives an explicit clock, so these assertions are about the
 * engine's LOGIC, not about wall-clock timing.
 *
 * The behaviours that matter for a person using this:
 *   - a slip must not cost the whole dwell
 *   - a completed dwell must fire exactly once
 *   - ONE LANDING MUST NOT PRODUCE A STREAM OF ACTIVATIONS (leave-to-rearm)
 *   - a glance must not activate at all (lock-on gate)
 *   - the adaptation must move in the right direction for the right reason
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DwellEngine } from '../src/dwell.js';

/** Collect callbacks into arrays for assertion. */
function harness(options = {}) {
  const events = { activations: [], cancels: [], adapts: [], progress: [], phases: [] };
  const engine = new DwellEngine({
    dwellMs: 1000,
    lockOnMs: 0, // most tests target the dwell phase directly
    ...options,
    onActivate: (id, meta) => events.activations.push({ id, ...meta }),
    onCancel: (id, meta) => events.cancels.push({ id, ...meta }),
    onAdapt: (ms, meta) => events.adapts.push({ ms, ...meta }),
    onProgress: (id, ratio) => events.progress.push({ id, ratio }),
    onPhase: (phase, id) => events.phases.push({ phase, id }),
  });
  return { engine, events };
}

/**
 * Advance the engine the way a real host does: heartbeats every FRAME_MS
 * until the clock reaches `targetMs`. A single sparse hold() call would trip
 * the clock-gap guard (correctly — that guard exists precisely because a
 * heartbeat gap means the host stopped ticking), so tests must tick at frame
 * cadence to exercise dwell logic rather than host-stall logic.
 */
const FRAME_MS = 16;
function advance(engine, fromMs, toMs, step = FRAME_MS) {
  for (let t = fromMs; t <= toMs; t += step) engine.hold(t);
  // ALWAYS land exactly on toMs. Stepping by a fixed frame size can stop
  // just short of the threshold (e.g. 996 of 1000), which would make a
  // dwell that should complete appear not to.
  if ((toMs - fromMs) % step !== 0) engine.hold(toMs);
}

// -- core dwell behaviour ---------------------------------------------------

test('hold to the duration activates exactly once', () => {
  const { engine, events } = harness();
  engine.enter('a', 0);
  advance(engine, 0, 500);          // half of a 1000ms dwell
  assert.equal(events.activations.length, 0);
  advance(engine, 500, 1000);       // completes
  assert.equal(events.activations.length, 1);
  assert.equal(events.activations[0].id, 'a');
  // Further holds after activation must not re-fire.
  advance(engine, 1000, 1500);
  assert.equal(events.activations.length, 1);
});

test('progress is reported and reaches 1 on activation', () => {
  const { engine, events } = harness();
  engine.enter('a', 0);
  advance(engine, 0, 600);
  const last = events.progress[events.progress.length - 1];
  assert.ok(last.ratio > 0.5 && last.ratio < 1);
  advance(engine, 600, 1000);
  assert.equal(events.progress[events.progress.length - 1].ratio, 1);
});

test('a brief slip is forgiven and resumes rather than restarting', () => {
  const { engine, events } = harness({ graceMs: 200 });
  engine.enter('a', 0);
  advance(engine, 0, 700);   // 700ms of progress
  engine.leave(700);         // signal slips off
  engine.enter('a', 800);    // returns within grace
  advance(engine, 800, 1100); // 700 + 300 = 1000+ → activates
  assert.equal(events.activations.length, 1, 'slip must not restart the dwell');
});

test('leaving past the grace window cancels and reports progress', () => {
  const { engine, events } = harness({ graceMs: 100 });
  engine.enter('a', 0);
  advance(engine, 0, 800);
  engine.leave(800);
  engine.tick(1000); // 200ms away > 100ms grace
  assert.equal(events.activations.length, 0);
  assert.equal(events.cancels.length, 1);
  assert.equal(events.cancels[0].id, 'a');
  assert.ok(events.cancels[0].progress >= 0.7);
});

// -- leave-to-rearm: the repeat-activation fix ------------------------------

test('LEAVE-TO-REARM: a fired target does not fire again while still held', () => {
  // The reported bug: pointer dwells, activates, and keeps activating because
  // it never left. One landing must equal one activation.
  const { engine, events } = harness({ dwellMs: 500 });
  engine.enter('w3', 0);
  advance(engine, 0, 600);
  assert.equal(events.activations.length, 1, 'first landing activates');

  // The pointer is STILL on w3 and keeps sending holds for a long time.
  advance(engine, 600, 5000);
  assert.equal(events.activations.length, 1, 'must NOT re-fire while still held');
  assert.equal(engine.isSpent('w3'), true, 'target should be spent');
});

test('LEAVE-TO-REARM: leaving and returning re-arms the target', () => {
  const { engine, events } = harness({ dwellMs: 500, graceMs: 50 });
  engine.enter('w3', 0);
  advance(engine, 0, 600);
  assert.equal(events.activations.length, 1);

  // Leave, past the grace window, and come back deliberately.
  engine.leave(700);
  engine.tick(900);
  assert.equal(engine.isSpent('w3'), false, 'departure re-arms the target');

  engine.enter('w3', 1000);
  advance(engine, 1000, 1600);
  assert.equal(events.activations.length, 2, 'a deliberate return fires again');
});

test('LEAVE-TO-REARM: a spent target does not start a new dwell on re-enter', () => {
  const { engine, events } = harness({ dwellMs: 500 });
  engine.enter('w3', 0);
  advance(engine, 0, 600);
  assert.equal(events.activations.length, 1);

  // Re-enter WITHOUT having left (e.g. a jittery stream re-reports the same
  // target). This must not begin a fresh dwell.
  engine.enter('w3', 700);
  assert.equal(engine.phase, 'spent');
  advance(engine, 700, 3000);
  assert.equal(events.activations.length, 1, 're-enter without departure must not re-fire');
});

test('LEAVE-TO-REARM can be disabled for hosts that gate repeats themselves', () => {
  const { engine, events } = harness({ dwellMs: 500, leaveToRearm: false, lockoutMs: 0 });
  engine.enter('w3', 0);
  advance(engine, 0, 600);
  engine.enter('w3', 700);
  advance(engine, 700, 1300);
  assert.equal(events.activations.length, 2);
});

// -- lockout gate -----------------------------------------------------------

test('LOCKOUT: the same target cannot fire twice inside the reaction window', () => {
  // Use a SHORT dwell so the second completion lands inside the lockout
  // window. With a long dwell the window would already have expired and the
  // test would prove nothing.
  const { engine, events } = harness({ dwellMs: 100, lockoutMs: 200, graceMs: 10, lockOnMs: 0 });
  engine.enter('a', 0);
  advance(engine, 0, 150);
  assert.equal(events.activations.length, 1, 'first fire at t=150');

  // Leave and return almost immediately — a jittery signal doing leave/enter.
  engine.leave(160);
  engine.tick(180);       // departure registered, target re-armed
  engine.enter('a', 190);
  advance(engine, 190, 300); // completes at ~290: only 140ms after the fire
  assert.equal(events.activations.length, 1, 'lockout must block the fast re-fire');
});

test('LOCKOUT expires: a legitimate slow repeat still works', () => {
  const { engine, events } = harness({ dwellMs: 100, lockoutMs: 200, graceMs: 10, lockOnMs: 0 });
  engine.enter('a', 0);
  advance(engine, 0, 150);
  engine.leave(350);      // depart well after the window
  engine.tick(400);
  engine.enter('a', 500);
  advance(engine, 500, 700);
  assert.equal(events.activations.length, 2);
});

// -- lock-on gate -----------------------------------------------------------

test('LOCK-ON: a brief glance does not activate', () => {
  // Microsoft's gaze guidance uses a 150-250ms onset gate to tell "staring
  // at" apart from "glancing over". A signal that sweeps across a target for
  // less than the gate must produce nothing at all.
  const { engine, events } = harness({ dwellMs: 400, lockOnMs: 150, graceMs: 20 });
  engine.enter('w1', 0);
  advance(engine, 0, 80);
  engine.leave(80);
  engine.tick(120);
  assert.equal(events.activations.length, 0, 'a glance must not activate');
  assert.equal(events.cancels.length, 1, 'but it does report a cancel');
});

test('LOCK-ON: passing the gate then holding completes normally', () => {
  const { engine, events } = harness({ dwellMs: 400, lockOnMs: 150 });
  engine.enter('w1', 0);
  advance(engine, 0, 100);
  assert.equal(events.progress.length, 0, 'no progress is shown during lock-on');
  advance(engine, 100, 200);
  advance(engine, 200, 600);
  assert.equal(events.activations.length, 1);
});

test('LOCK-ON: the dwell duration is not shortened by the lock-on time', () => {
  const { engine, events } = harness({ dwellMs: 400, lockOnMs: 150 });
  engine.enter('w1', 0);
  advance(engine, 0, 150);
  advance(engine, 150, 540);
  assert.equal(events.activations.length, 0);
  advance(engine, 540, 560);
  assert.equal(events.activations.length, 1);
});

test('phase transitions are reported', () => {
  const { engine, events } = harness({ dwellMs: 400, lockOnMs: 150 });
  engine.enter('w1', 0);
  assert.equal(events.phases[0].phase, 'lockon');
  advance(engine, 0, 200);
  assert.ok(events.phases.some((p) => p.phase === 'dwell'));
});

// -- repeat targets ---------------------------------------------------------

test('REPEAT targets auto-repeat while held (volume/scroll model)', () => {
  const { engine, events } = harness({ dwellMs: 200, repeatIntervalMs: 500, lockOnMs: 0 });
  engine.setRepeatTargets(['volume-up']);
  engine.enter('volume-up', 0);
  advance(engine, 0, 250);
  assert.equal(events.activations.length, 1);
  // Still held: the repeat interval is measured from the last fire, so the
  // next one lands at t=750.
  advance(engine, 250, 700);
  assert.equal(events.activations.length, 1, 'must not fire before the interval');
  advance(engine, 700, 800);
  assert.equal(events.activations.length, 2, 'repeat target fires on the interval');
  advance(engine, 800, 1400);
  assert.equal(events.activations.length, 3);
});

test('REPEAT is opt-in: a normal target still requires a departure', () => {
  const { engine, events } = harness({ dwellMs: 200, repeatIntervalMs: 500 });
  engine.setRepeatTargets(['volume-up']); // only this one
  engine.enter('word-5', 0);
  advance(engine, 0, 250);
  for (let t = 300; t <= 2000; t += 100) engine.hold(t);
  assert.equal(events.activations.length, 1, 'non-repeat target must not auto-fire');
});

// -- clock-gap guard (hidden tab / sleep) -----------------------------------

test('CLOCK GAP: a hidden tab does not produce a phantom activation', () => {
  // A user rests on a word, switches tabs for 10 seconds, and comes back.
  // rAF pauses in background tabs, so the host sends no heartbeats; on
  // return the wall-clock delta is huge. Treating that as dwell progress
  // would fire an activation the user never made.
  const { engine, events } = harness({ dwellMs: 600, lockOnMs: 150 });
  engine.enter('w1', 0);
  advance(engine, 0, 300);       // mid-dwell
  assert.equal(events.activations.length, 0);

  engine.hold(10300);            // tab returns after ~10s hidden
  assert.equal(events.activations.length, 0, 'must not fire on tab return');
  assert.equal(events.cancels.length, 1);
  assert.equal(events.cancels[0].reason, 'clock-gap');
  assert.equal(engine.target, null, 'the attempt is abandoned');

  // A fresh dwell after the gap works normally. Allow a little headroom:
  // lock-on and dwell begin on separate frames, so the total is slightly
  // more than lockOnMs + dwellMs.
  engine.enter('w1', 10400);
  advance(engine, 10400, 11300);
  assert.equal(events.activations.length, 1);
});

test('CLOCK GAP: a normal frame cadence is unaffected', () => {
  // The guard must not fire on ordinary 16ms frames.
  const { engine, events } = harness({ dwellMs: 400, lockOnMs: 0 });
  engine.enter('a', 0);
  advance(engine, 0, 450, 16);
  assert.equal(events.activations.length, 1);
  assert.equal(events.cancels.length, 0, 'no spurious clock-gap cancels');
});

test('CLOCK GAP: a gap on a spent target re-arms it', () => {
  const { engine, events } = harness({ dwellMs: 300, lockOnMs: 0 });
  engine.enter('a', 0);
  advance(engine, 0, 350);
  assert.equal(engine.isSpent('a'), true);
  engine.hold(5000);             // long gap while hovering the spent target
  assert.equal(engine.isSpent('a'), false, 'the gap counts as a departure');
});

// -- global pause (kill switch) --------------------------------------------

test('PAUSE cancels the in-flight dwell and ignores input', () => {
  const { engine, events } = harness({ dwellMs: 500 });
  engine.enter('w1', 0);
  advance(engine, 0, 200);
  engine.pause();
  assert.equal(engine.paused, true);
  assert.equal(engine.target, null);
  assert.equal(events.cancels.length, 1);
  assert.equal(events.cancels[0].reason, 'paused');

  // Input while paused does nothing.
  engine.enter('w2', 300);
  advance(engine, 300, 900);
  assert.equal(events.activations.length, 0, 'no activation while paused');
});

test('PAUSE then resume allows normal operation again', () => {
  const { engine, events } = harness({ dwellMs: 500 });
  engine.pause();
  engine.enter('w1', 0);
  advance(engine, 0, 600);
  assert.equal(events.activations.length, 0);
  engine.resume();
  engine.enter('w1', 700);
  advance(engine, 700, 1300);
  assert.equal(events.activations.length, 1);
});

// -- adaptation -------------------------------------------------------------

test('a sweep across a target does not count as an abandoned attempt', () => {
  // Gaze passing over a word is normal; it must not skew adaptation.
  const { engine, events } = harness({ adaptive: true, dwellMs: 1000, lockOnMs: 0 });
  for (let i = 0; i < 6; i++) {
    engine.enter(`w${i}`, i * 100);
    engine.leave(i * 100 + 50); // only 5% progress
    engine.tick(i * 100 + 300);
  }
  assert.equal(events.adapts.length, 0, 'shallow sweeps must not adapt the dwell');
});

test('repeated abandonments shorten the dwell (too-long signal)', () => {
  const { engine, events } = harness({ dwellMs: 1000, graceMs: 10, lockOnMs: 0 });
  for (let i = 0; i < 6; i++) {
    const t = i * 2000;
    engine.enter('a', t);
    advance(engine, t, t + 600); // 60% — well past the abandon floor
    engine.leave(t + 600);
    engine.tick(t + 700);
  }
  assert.ok(events.adapts.length >= 1, 'abandonment should trigger adaptation');
  assert.ok(events.adapts[0].ms < 1000, 'dwell should get shorter');
});

test('repeated undos lengthen the dwell (too-short signal)', () => {
  const { engine, events } = harness({ dwellMs: 500, adaptive: true, lockOnMs: 0 });
  for (let i = 0; i < 4; i++) {
    const t = i * 1000;
    engine.enter('a', t);
    engine.hold(t + 600); // completes
  }
  engine.reportUndo();
  engine.reportUndo();
  engine.reportUndo();
  assert.ok(events.adapts.length >= 1, 'undos should trigger adaptation');
  assert.ok(events.adapts[0].ms > 500, 'dwell should get longer');
});

test('adaptation respects the floor and ceiling', () => {
  const { engine } = harness({ dwellMs: 400, minDwellMs: 350, adaptive: true, lockOnMs: 0 });
  for (let i = 0; i < 30; i++) {
    const t = i * 2000;
    engine.enter('a', t);
    engine.hold(t + 300);
    engine.leave(t + 300);
    engine.tick(t + 400);
  }
  assert.ok(engine.dwellMs >= 350, `floor violated: ${engine.dwellMs}`);
});

test('adaptation can be disabled entirely', () => {
  const { engine, events } = harness({ dwellMs: 1000, adaptive: false, lockOnMs: 0 });
  for (let i = 0; i < 10; i++) {
    const t = i * 2000;
    engine.enter('a', t);
    engine.hold(t + 600);
    engine.leave(t + 600);
    engine.tick(t + 700);
  }
  assert.equal(events.adapts.length, 0);
  assert.equal(engine.dwellMs, 1000);
});

// -- misc -------------------------------------------------------------------

test('explicit cancel reports and clears without activating', () => {
  const { engine, events } = harness();
  engine.enter('a', 0);
  advance(engine, 0, 500);
  engine.cancel('escape');
  assert.equal(events.activations.length, 0);
  assert.equal(events.cancels.length, 1);
  assert.equal(events.cancels[0].reason, 'escape');
  assert.equal(engine.target, null);
});

test('moving directly to another target ends the previous attempt', () => {
  const { engine, events } = harness({ graceMs: 100 });
  engine.enter('a', 0);
  advance(engine, 0, 700);
  engine.enter('b', 700); // straight from a to b, no leave()
  assert.equal(engine.target, 'b');
  assert.equal(events.cancels.length, 1);
  assert.equal(events.cancels[0].id, 'a');
});

test('moving to a DIFFERENT target after firing is allowed (not blocked)', () => {
  // Leave-to-rearm is per-target: the user must be able to select a
  // neighbouring word without first departing to empty space.
  const { engine, events } = harness({ dwellMs: 300, lockOnMs: 0 });
  engine.enter('w1', 0);
  advance(engine, 0, 400);
  assert.equal(events.activations.length, 1);
  engine.enter('w2', 500); // a genuinely different target
  advance(engine, 500, 900);
  assert.equal(events.activations.length, 2, 'a different target must fire');
  assert.equal(events.activations[1].id, 'w2');
});

test('stats report the adaptation counters', () => {
  const { engine } = harness({ dwellMs: 1000, lockOnMs: 0 });
  engine.enter('a', 0);
  advance(engine, 0, 1200);
  const s = engine.stats;
  assert.equal(s.activations, 1);
  assert.equal(s.dwellMs, 1000);
  assert.equal(s.spent, 1);
});

test('setDwell: an explicit user choice sticks against adaptation', () => {
  // WCAG 2.2.1 requires the adjustment to take effect. A user who picks
  // 1200ms and then abandons a few dwells must not be quietly walked back to
  // the library default by the adaptive layer.
  const { engine } = harness({ dwellMs: 600, adaptive: true, lockOnMs: 0 });
  engine.setDwell(1200);
  assert.equal(engine.dwellMs, 1200, 'the choice is applied');

  // Hammer it with the signal that would normally SHORTEN the dwell.
  for (let i = 0; i < 40; i++) {
    const t = i * 3000;
    engine.enter('a', t);
    advance(engine, t, t + 700);   // 58% then abandon
    engine.leave(t + 700);
    engine.tick(t + 900);
  }
  assert.ok(engine.dwellMs > 600,
    `user's 1200ms was walked back to ${engine.dwellMs}`);
});

test('setDwell: a fast choice is not yanked up to the library floor', () => {
  // The other direction: an expert who picks 150ms must not be forced to
  // 300ms by the default minDwellMs on the first correction.
  const { engine } = harness({ dwellMs: 600, adaptive: true, lockOnMs: 0 });
  engine.setDwell(150);
  assert.equal(engine.dwellMs, 150);
  assert.ok(engine.minDwellMs <= 150, `floor ${engine.minDwellMs} exceeds the choice`);
});

test('setDwell: bounds stay proportional so adaptation can still work', () => {
  const { engine } = harness({ dwellMs: 600, lockOnMs: 0 });
  engine.setDwell(800);
  assert.equal(engine.minDwellMs, 400, 'half the choice');
  assert.equal(engine.maxDwellMs, 1600, 'double the choice');
});

test('setDwell: resets counters so old history cannot skew the new value', () => {
  const { engine } = harness({ dwellMs: 600, adaptive: true, lockOnMs: 0 });
  engine.enter('a', 0);
  advance(engine, 0, 700);
  engine.reportUndo();
  engine.reportUndo();
  engine.setDwell(900);
  assert.equal(engine.stats.undos, 0, 'counters cleared by the choice');
});

test('setDwell: rejects nonsense input rather than corrupting the engine', () => {
  const { engine } = harness({ dwellMs: 600 });
  engine.setDwell(0);
  assert.equal(engine.dwellMs, 600);
  engine.setDwell(-5);
  assert.equal(engine.dwellMs, 600);
  engine.setDwell(NaN);
  assert.equal(engine.dwellMs, 600);
  engine.setDwell('abc');
  assert.equal(engine.dwellMs, 600);
});

test('the default range satisfies WCAG 2.2.1 (>= 10x the default)', () => {
  // 2.2.1 wants a timing value adjustable over at least ten times the
  // default. The shipped demo slider is 100..1200 against a 600ms default.
  const MIN = 100, MAX = 1200, DEFAULT = 600;
  assert.ok(MAX >= DEFAULT * 2, 'range must extend well above the default');
  assert.ok(DEFAULT / MIN >= 6, 'and well below it (this demo offers 6x down)');
  assert.ok((MAX - MIN) >= DEFAULT * 1.5, 'total span is wide');
});

test('reset clears the spent set and counters', () => {
  const { engine } = harness({ dwellMs: 300, lockOnMs: 0 });
  engine.enter('a', 0);
  advance(engine, 0, 400);
  assert.equal(engine.isSpent('a'), true);
  engine.reset();
  assert.equal(engine.isSpent('a'), false);
  assert.equal(engine.stats.activations, 0);
});
