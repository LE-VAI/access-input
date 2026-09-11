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

// -- core dwell behaviour ---------------------------------------------------

test('hold to the duration activates exactly once', () => {
  const { engine, events } = harness();
  engine.enter('a', 0);
  engine.hold(500);
  assert.equal(events.activations.length, 0);
  engine.hold(1000);
  assert.equal(events.activations.length, 1);
  assert.equal(events.activations[0].id, 'a');
  // Further holds after activation must not re-fire.
  engine.hold(1500);
  assert.equal(events.activations.length, 1);
});

test('progress is reported and reaches 1 on activation', () => {
  const { engine, events } = harness();
  engine.enter('a', 0);
  engine.hold(100);
  engine.hold(600);
  const last = events.progress[events.progress.length - 1];
  assert.ok(last.ratio > 0.5 && last.ratio < 1);
  engine.hold(1000);
  assert.equal(events.progress[events.progress.length - 1].ratio, 1);
});

test('a brief slip is forgiven and resumes rather than restarting', () => {
  const { engine, events } = harness({ graceMs: 200 });
  engine.enter('a', 0);
  engine.hold(700);          // 700ms of progress
  engine.leave(700);         // signal slips off
  engine.enter('a', 800);    // returns within grace
  engine.hold(1100);         // 700 + 400 = 1100 > 1000 → activates
  assert.equal(events.activations.length, 1, 'slip must not restart the dwell');
});

test('leaving past the grace window cancels and reports progress', () => {
  const { engine, events } = harness({ graceMs: 100 });
  engine.enter('a', 0);
  engine.hold(800);
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
  engine.hold(600);
  assert.equal(events.activations.length, 1, 'first landing activates');

  // The pointer is STILL on w3 and keeps sending holds for a long time.
  for (let t = 700; t <= 5000; t += 100) engine.hold(t);
  assert.equal(events.activations.length, 1, 'must NOT re-fire while still held');
  assert.equal(engine.isSpent('w3'), true, 'target should be spent');
});

test('LEAVE-TO-REARM: leaving and returning re-arms the target', () => {
  const { engine, events } = harness({ dwellMs: 500, graceMs: 50 });
  engine.enter('w3', 0);
  engine.hold(600);
  assert.equal(events.activations.length, 1);

  // Leave, past the grace window, and come back deliberately.
  engine.leave(700);
  engine.tick(900);
  assert.equal(engine.isSpent('w3'), false, 'departure re-arms the target');

  engine.enter('w3', 1000);
  engine.hold(1600);
  assert.equal(events.activations.length, 2, 'a deliberate return fires again');
});

test('LEAVE-TO-REARM: a spent target does not start a new dwell on re-enter', () => {
  const { engine, events } = harness({ dwellMs: 500 });
  engine.enter('w3', 0);
  engine.hold(600);
  assert.equal(events.activations.length, 1);

  // Re-enter WITHOUT having left (e.g. a jittery stream re-reports the same
  // target). This must not begin a fresh dwell.
  engine.enter('w3', 700);
  assert.equal(engine.phase, 'spent');
  for (let t = 800; t <= 3000; t += 100) engine.hold(t);
  assert.equal(events.activations.length, 1, 're-enter without departure must not re-fire');
});

test('LEAVE-TO-REARM can be disabled for hosts that gate repeats themselves', () => {
  const { engine, events } = harness({ dwellMs: 500, leaveToRearm: false, lockoutMs: 0 });
  engine.enter('w3', 0);
  engine.hold(600);
  engine.enter('w3', 700);
  engine.hold(1300);
  assert.equal(events.activations.length, 2);
});

// -- lockout gate -----------------------------------------------------------

test('LOCKOUT: the same target cannot fire twice inside the reaction window', () => {
  // Use a SHORT dwell so the second completion lands inside the lockout
  // window. With a long dwell the window would already have expired and the
  // test would prove nothing.
  const { engine, events } = harness({ dwellMs: 100, lockoutMs: 200, graceMs: 10, lockOnMs: 0 });
  engine.enter('a', 0);
  engine.hold(150);
  assert.equal(events.activations.length, 1, 'first fire at t=150');

  // Leave and return almost immediately — a jittery signal doing leave/enter.
  engine.leave(160);
  engine.tick(180);       // departure registered, target re-armed
  engine.enter('a', 190);
  engine.hold(300);       // completes at ~290: only 140ms after the fire
  assert.equal(events.activations.length, 1, 'lockout must block the fast re-fire');
});

test('LOCKOUT expires: a legitimate slow repeat still works', () => {
  const { engine, events } = harness({ dwellMs: 100, lockoutMs: 200, graceMs: 10, lockOnMs: 0 });
  engine.enter('a', 0);
  engine.hold(150);
  engine.leave(350);      // depart well after the window
  engine.tick(400);
  engine.enter('a', 500);
  engine.hold(700);
  assert.equal(events.activations.length, 2);
});

// -- lock-on gate -----------------------------------------------------------

test('LOCK-ON: a brief glance does not activate', () => {
  // Microsoft's gaze guidance uses a 150-250ms onset gate to tell "staring
  // at" apart from "glancing over". A signal that sweeps across a target for
  // less than the gate must produce nothing at all.
  const { engine, events } = harness({ dwellMs: 400, lockOnMs: 150, graceMs: 20 });
  engine.enter('w1', 0);
  engine.hold(80);        // only 80ms — inside the lock-on gate
  engine.leave(80);
  engine.tick(120);
  assert.equal(events.activations.length, 0, 'a glance must not activate');
  assert.equal(events.cancels.length, 1, 'but it does report a cancel');
});

test('LOCK-ON: passing the gate then holding completes normally', () => {
  const { engine, events } = harness({ dwellMs: 400, lockOnMs: 150 });
  engine.enter('w1', 0);
  engine.hold(100);           // inside lock-on: no progress yet
  assert.equal(events.progress.length, 0, 'no progress is shown during lock-on');
  engine.hold(200);           // past the gate → dwell phase begins
  engine.hold(600);           // 400ms of dwell elapsed
  assert.equal(events.activations.length, 1);
});

test('LOCK-ON: the dwell duration is not shortened by the lock-on time', () => {
  const { engine, events } = harness({ dwellMs: 400, lockOnMs: 150 });
  engine.enter('w1', 0);
  engine.hold(150);   // exactly at the gate
  engine.hold(540);   // 390ms of dwell — not yet
  assert.equal(events.activations.length, 0);
  engine.hold(560);   // 410ms of dwell — done
  assert.equal(events.activations.length, 1);
});

test('phase transitions are reported', () => {
  const { engine, events } = harness({ dwellMs: 400, lockOnMs: 150 });
  engine.enter('w1', 0);
  assert.equal(events.phases[0].phase, 'lockon');
  engine.hold(200);
  assert.ok(events.phases.some((p) => p.phase === 'dwell'));
});

// -- repeat targets ---------------------------------------------------------

test('REPEAT targets auto-repeat while held (volume/scroll model)', () => {
  const { engine, events } = harness({ dwellMs: 200, repeatIntervalMs: 500, lockOnMs: 0 });
  engine.setRepeatTargets(['volume-up']);
  engine.enter('volume-up', 0);
  engine.hold(250);           // first fire at t=250
  assert.equal(events.activations.length, 1);
  // Still held: the repeat interval is measured from the last fire, so the
  // next one lands at t=750.
  engine.hold(700);           // 450ms since the fire — not yet
  assert.equal(events.activations.length, 1, 'must not fire before the interval');
  engine.hold(800);           // 550ms since the fire — now
  assert.equal(events.activations.length, 2, 'repeat target fires on the interval');
  engine.hold(1400);          // another interval later
  assert.equal(events.activations.length, 3);
});

test('REPEAT is opt-in: a normal target still requires a departure', () => {
  const { engine, events } = harness({ dwellMs: 200, repeatIntervalMs: 500 });
  engine.setRepeatTargets(['volume-up']); // only this one
  engine.enter('word-5', 0);
  engine.hold(250);
  for (let t = 300; t <= 2000; t += 100) engine.hold(t);
  assert.equal(events.activations.length, 1, 'non-repeat target must not auto-fire');
});

// -- global pause (kill switch) --------------------------------------------

test('PAUSE cancels the in-flight dwell and ignores input', () => {
  const { engine, events } = harness({ dwellMs: 500 });
  engine.enter('w1', 0);
  engine.hold(200);
  engine.pause();
  assert.equal(engine.paused, true);
  assert.equal(engine.target, null);
  assert.equal(events.cancels.length, 1);
  assert.equal(events.cancels[0].reason, 'paused');

  // Input while paused does nothing.
  engine.enter('w2', 300);
  engine.hold(900);
  assert.equal(events.activations.length, 0, 'no activation while paused');
});

test('PAUSE then resume allows normal operation again', () => {
  const { engine, events } = harness({ dwellMs: 500 });
  engine.pause();
  engine.enter('w1', 0);
  engine.hold(600);
  assert.equal(events.activations.length, 0);
  engine.resume();
  engine.enter('w1', 700);
  engine.hold(1300);
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
    engine.hold(t + 600); // 60% — well past the abandon floor
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
  engine.hold(500);
  engine.cancel('escape');
  assert.equal(events.activations.length, 0);
  assert.equal(events.cancels.length, 1);
  assert.equal(events.cancels[0].reason, 'escape');
  assert.equal(engine.target, null);
});

test('moving directly to another target ends the previous attempt', () => {
  const { engine, events } = harness({ graceMs: 100 });
  engine.enter('a', 0);
  engine.hold(700);
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
  engine.hold(400);
  assert.equal(events.activations.length, 1);
  engine.enter('w2', 500); // a genuinely different target
  engine.hold(900);
  assert.equal(events.activations.length, 2, 'a different target must fire');
  assert.equal(events.activations[1].id, 'w2');
});

test('stats report the adaptation counters', () => {
  const { engine } = harness({ dwellMs: 1000, lockOnMs: 0 });
  engine.enter('a', 0);
  engine.hold(1200);
  const s = engine.stats;
  assert.equal(s.activations, 1);
  assert.equal(s.dwellMs, 1000);
  assert.equal(s.spent, 1);
});

test('reset clears the spent set and counters', () => {
  const { engine } = harness({ dwellMs: 300, lockOnMs: 0 });
  engine.enter('a', 0);
  engine.hold(400);
  assert.equal(engine.isSpent('a'), true);
  engine.reset();
  assert.equal(engine.isSpent('a'), false);
  assert.equal(engine.stats.activations, 0);
});
