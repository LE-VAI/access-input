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

// -- repeat target registration ---------------------------------------------

test('setRepeatTargets is ADDITIVE, not replacing', () => {
  // Regression: a second call used to silently drop every previously
  // registered target, which is easy to hit when hosts register targets as
  // they are created.
  const { engine } = harness({ dwellMs: 100, lockOnMs: 0 });
  engine.setRepeatTargets(['volume-up']);
  engine.setRepeatTargets(['volume-down']);
  assert.equal(engine._repeatTargets.has('volume-up'), true, 'first call must survive');
  assert.equal(engine._repeatTargets.has('volume-down'), true);
});

test('setRepeatTargets accepts object and entry-list shapes', () => {
  const { engine } = harness({ lockOnMs: 0 });
  engine.setRepeatTargets({ 'vol-up': 400, 'vol-down': 400 });
  assert.equal(engine.repeatIntervalFor('vol-up'), 400);
  engine.setRepeatTargets([{ id: 'scroll', intervalMs: 250 }]);
  assert.equal(engine.repeatIntervalFor('scroll'), 250);
  engine.setRepeatTargets('single');
  assert.equal(engine._repeatTargets.has('single'), true);
});

test('per-target repeat interval overrides the default', () => {
  const { engine } = harness({ lockOnMs: 0 });
  engine.setRepeatTargets(['a']);
  engine.setRepeatTargets({ b: 200 });
  assert.equal(engine.repeatIntervalFor('a'), engine.repeatIntervalMs, 'a uses the default');
  assert.equal(engine.repeatIntervalFor('b'), 200, 'b uses its own');
});

test('a faster per-target interval actually fires sooner', () => {
  const { engine, events } = harness({ dwellMs: 100, repeatIntervalMs: 2000, lockOnMs: 0 });
  engine.setRepeatTargets({ fast: 300 });
  engine.enter('fast', 0);
  advance(engine, 0, 150);          // first fire
  assert.equal(events.activations.length, 1);
  // The DEFAULT is 2000ms, so only the per-target 300ms can explain a
  // second fire this soon.
  advance(engine, 150, 500);
  assert.equal(events.activations.length, 2, 'per-target interval was used');
});

test('clearRepeatTargets removes registrations', () => {
  const { engine } = harness({ lockOnMs: 0 });
  engine.setRepeatTargets(['x', 'y']);
  engine.clearRepeatTargets('x');
  assert.equal(engine._repeatTargets.has('x'), false);
  assert.equal(engine._repeatTargets.has('y'), true);
});

test('resetRepeatTargets clears everything', () => {
  const { engine } = harness({ lockOnMs: 0 });
  engine.setRepeatTargets(['x'], { replace: true });
  engine.resetRepeatTargets();
  assert.equal(engine._repeatTargets.size, 0);
  assert.equal(engine._repeatIntervals.size, 0);
});

test('setRepeatTargets with replace:true clears first', () => {
  const { engine } = harness({ lockOnMs: 0 });
  engine.setRepeatTargets(['old']);
  engine.setRepeatTargets(['new'], { replace: true });
  assert.equal(engine._repeatTargets.has('old'), false);
  assert.equal(engine._repeatTargets.has('new'), true);
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
  const { engine, events } = harness({ dwellMs: 500, adaptive: true, lockOnMs: 0, graceMs: 10 });
  // NOTE: this test previously called hold(t + 600) — a single 600ms jump,
  // which correctly trips the clock-gap guard, so NO activation ever fired.
  // It still passed, because the old adaptation divided by
  // Math.max(1, _activations): the denominator was fabricated and the undo
  // rate came out as 3.0 from zero completed dwells. It was asserting
  // arithmetic, not behaviour. advance() ticks at frame cadence the way a
  // real host does, so the engine sees the dwells it is being asked about.
  //
  // A FRESH target id per attempt, because leave-to-rearm correctly refuses to
  // restart a target that has already fired until the signal has departed it
  // AND the grace window has closed. Re-entering the same id would test the
  // repeat gate, not the adaptation.
  for (let i = 0; i < 4; i++) {
    const t = i * 1000;
    engine.enter(`w${i}`, t);
    advance(engine, t, t + 600); // completes a 500ms dwell
    engine.leave(t + 600);
    engine.tick(t + 700);
  }
  assert.equal(engine.stats.totalActivations, 4,
    'the dwells must actually have fired — otherwise this asserts nothing');
  engine.reportUndo();
  engine.reportUndo();
  engine.reportUndo();
  assert.ok(events.adapts.length >= 1, 'undos should trigger adaptation');
  assert.ok(events.adapts[0].ms > 500, 'dwell should get longer');
  assert.equal(events.adapts[0].reason, 'undos', 'and it says why it moved');
});

test('a zero-activation record cannot produce an undo rate', () => {
  // The specific arithmetic that let the test above pass on nothing: with no
  // completed dwells there is no denominator, so an undo rate is not a
  // measurable quantity. The engine must decline to adapt rather than divide
  // by a stand-in.
  const { engine, events } = harness({ dwellMs: 500, adaptive: true, lockOnMs: 0 });
  for (let i = 0; i < 6; i++) engine.reportUndo();
  assert.equal(events.adapts.length, 0,
    'undos with no activations to undo must not move the duration');
  assert.equal(engine.dwellMs, 500);
});

test('adaptation uses a WINDOW, so it does not go deaf over a long session', () => {
  // The v1 denominator was a session total that only grew, so the undo ratio
  // needed progressively more undos to cross its threshold. After 40 clean
  // activations a 15% undo rate required 7 undos, then 8, then 9 — the engine
  // adapted eagerly in the first minute and progressively stopped. A person
  // whose tremor developed twenty minutes in got the least help, which is
  // exactly backwards.
  //
  // The invariant the window buys: THE BURST NEEDED TO TRIGGER A CORRECTION IS
  // BOUNDED, and does not depend on how long the session has already run.
  const { engine, events } = harness({ dwellMs: 500, adaptive: true, lockOnMs: 0, graceMs: 10 });
  let t = 0;
  const completedDwells = (n, undos = 0) => {
    for (let i = 0; i < n; i++) {
      engine.enter(`w${t}`, t);
      advance(engine, t, t + 600);
      engine.leave(t + 600);
      engine.tick(t + 700);
      t += 1000;
    }
    for (let k = 0; k < undos; k++) engine.reportUndo();
  };

  // A long clean stretch first: 40 completed dwells, no complaints.
  for (let k = 0; k < 10; k++) completedDwells(4);
  const before = engine.dwellMs;
  assert.equal(engine.stats.totalActivations, 40, 'the session really did run');
  assert.equal(events.adapts.length, 0, 'no complaints, no correction');

  // Now the tremor starts. Four undos is the same bounded burst that would
  // trigger a correction in a fresh session. Under the v1 session-total
  // denominator these 4 undos against 44 activations read as 0.09 and
  // adaptation would never have fired at all.
  completedDwells(4, 4);
  assert.ok(events.adapts.length >= 1,
    'a bounded burst of undos must still be heard after a long clean session');
  assert.ok(engine.dwellMs > before, `expected lengthening, got ${engine.dwellMs}`);
  assert.equal(events.adapts[events.adapts.length - 1].reason, 'undos');

  // And the window is genuinely bounded rather than merely large: the history
  // that a decision is made from cannot exceed ADAPT_WINDOW outcomes.
  assert.ok(engine.stats.windowSize <= 20,
    `the evidence window must stay bounded, got ${engine.stats.windowSize}`);
});

test('the same burst triggers the same correction in a fresh session', () => {
  // The other half of the invariant: if the burst needed depended on session
  // length, this and the test above would disagree. Both must adapt.
  const { engine, events } = harness({ dwellMs: 500, adaptive: true, lockOnMs: 0, graceMs: 10 });
  let t = 0;
  for (let i = 0; i < 4; i++) {
    engine.enter(`w${t}`, t);
    advance(engine, t, t + 600);
    engine.leave(t + 600);
    engine.tick(t + 700);
    t += 1000;
  }
  for (let k = 0; k < 4; k++) engine.reportUndo();
  assert.ok(events.adapts.length >= 1, 'a fresh session adapts on the same burst');
  assert.equal(events.adapts[events.adapts.length - 1].reason, 'undos');
});

test('a direction reversal is damped, so the corrections do not ring', () => {
  // Undos push the duration up; a longer duration produces abandonments;
  // abandonments push it down; a shorter duration produces undos again.
  // v1 remembered nothing about which way it had just moved, so the two
  // complaints could see-saw indefinitely. A reversal now takes a smaller
  // step, so the pair of corrections converges instead of oscillating.
  const { engine, events } = harness({ dwellMs: 600, adaptive: true, lockOnMs: 0, graceMs: 10 });
  let t = 0;
  const lengthen = () => {
    for (let i = 0; i < 3; i++) {
      engine.enter(`a${t}`, t); advance(engine, t, t + 900);
      engine.leave(t + 900); engine.tick(t + 1000); t += 1200;
    }
    engine.reportUndo(); engine.reportUndo(); engine.reportUndo();
  };
  const shorten = () => {
    for (let i = 0; i < 4; i++) {
      engine.enter(`b${t}`, t); advance(engine, t, t + 400);
      engine.leave(t + 400); engine.tick(t + 500); t += 800;
    }
  };

  lengthen();
  const afterFirst = engine.dwellMs;
  assert.ok(afterFirst > 600, 'the first correction lengthens');
  const firstStep = afterFirst / 600;

  shorten();
  const afterReversal = engine.dwellMs;
  assert.ok(afterReversal < afterFirst, 'the reversal shortens');
  const reversalStep = afterReversal / afterFirst;

  assert.ok(reversalStep < firstStep,
    `a reversal must take a smaller step than the move it reverses ` +
    `(first ${firstStep.toFixed(3)}, reversal ${reversalStep.toFixed(3)})`);
  assert.equal(events.adapts[events.adapts.length - 1].reason, 'abandons');
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

test('CRITICAL: setDwell must NOT re-arm a target that already fired', () => {
  // setDwell() called reset(), which clears `_spent`. So a user who opened
  // the settings panel mid-dwell and nudged the slider cleared every spent
  // target: a target awaiting departure became immediately re-armable while
  // the signal had never left it. Worse, the engine's own phase stayed
  // 'spent', so isSpent() and phase disagreed about the same fact — and the
  // host reads isSpent() to decide whether to re-arm its indicator.
  const { engine, events } = harness({ dwellMs: 600, lockOnMs: 0, adaptive: true });
  engine.enter('vol', 0);
  advance(engine, 0, 700);
  assert.equal(engine.stats.totalActivations, 1, 'it fired');
  assert.equal(engine.isSpent('vol'), true, 'and is spent, awaiting departure');
  assert.equal(engine.phase, 'spent');

  engine.setDwell(800);

  assert.equal(engine.isSpent('vol'), true,
    'the explicit choice must not re-arm a spent target');
  assert.equal(engine.phase, 'spent', 'and the engine still agrees with itself');

  // Continuing to hold must not produce a second activation.
  advance(engine, 700, 1600);
  assert.equal(engine.stats.totalActivations, 1,
    'one landing must still mean one activation, settings panel or not');
});

test('CRITICAL: setDwell must NOT clear the lockout history', () => {
  // `_lastFireAt` is the reaction-time lockout — the gate that stops a jittery
  // signal reporting leave/enter in quick succession from double-firing. It is
  // a safety gate, not adaptation bookkeeping, so reconfiguration has no
  // business erasing it.
  const { engine } = harness({ dwellMs: 400, lockOnMs: 0, lockoutMs: 200 });
  engine.enter('a', 0);
  advance(engine, 0, 500);
  assert.equal(engine.stats.totalActivations, 1);

  engine.setDwell(400); // a no-op change, but a change
  engine.leave(600);
  engine.tick(700);      // departure re-arms

  // Re-enter 50ms after the last fire — inside the 200ms lockout.
  engine.enter('a', 550);
  advance(engine, 550, 1200);
  assert.equal(engine.stats.totalActivations, 1,
    'the lockout must survive a dwell change');
});

test('setDwell still leaves the engine usable afterwards', () => {
  // The fix must not over-correct into "setDwell freezes repeat forever":
  // a genuine departure after the change must still re-arm.
  const { engine } = harness({ dwellMs: 600, lockOnMs: 0, adaptive: true, graceMs: 10 });
  engine.enter('a', 0);
  advance(engine, 0, 700);
  assert.equal(engine.isSpent('a'), true);

  engine.setDwell(800);
  engine.leave(800);
  engine.tick(900); // grace expires -> departure -> re-arm
  assert.equal(engine.isSpent('a'), false,
    'a real departure after the change must still re-arm the target');

  engine.enter('a', 1000);
  advance(engine, 1000, 1900);
  assert.equal(engine.stats.totalActivations, 2, 'and it fires again');
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
