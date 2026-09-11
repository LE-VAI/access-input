/**
 * dwell.test.mjs — the dwell engine's contract.
 *
 * Every test drives an explicit clock, so these assertions are about the
 * engine's LOGIC, not about wall-clock timing. The behaviours that matter
 * for a person using this: a slip must not cost the whole dwell, a completed
 * dwell must fire exactly once, and the adaptation must move in the right
 * direction for the right reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DwellEngine } from '../src/dwell.js';

/** Collect callbacks into arrays for assertion. */
function harness(options = {}) {
  const events = { activations: [], cancels: [], adapts: [], progress: [] };
  const engine = new DwellEngine({
    dwellMs: 1000,
    ...options,
    onActivate: (id, meta) => events.activations.push({ id, ...meta }),
    onCancel: (id, meta) => events.cancels.push({ id, ...meta }),
    onAdapt: (ms, meta) => events.adapts.push({ ms, ...meta }),
    onProgress: (id, ratio) => events.progress.push({ id, ratio }),
  });
  return { engine, events };
}

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

test('a sweep across a target does not count as an abandoned attempt', () => {
  // Gaze passing over a word is normal; it must not skew adaptation.
  const { engine, events } = harness({ adaptive: true, dwellMs: 1000 });
  for (let i = 0; i < 6; i++) {
    engine.enter(`w${i}`, i * 100);
    engine.leave(i * 100 + 50); // only 5% progress
    engine.tick(i * 100 + 300);
  }
  assert.equal(events.adapts.length, 0, 'shallow sweeps must not adapt the dwell');
});

test('repeated abandonments shorten the dwell (too-long signal)', () => {
  const { engine, events } = harness({ dwellMs: 1000, graceMs: 10 });
  // Six deep-but-unfinished attempts.
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
  const { engine, events } = harness({ dwellMs: 500, adaptive: true });
  // Four completed activations, three of them immediately undone.
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
  const { engine } = harness({ dwellMs: 400, minDwellMs: 350, adaptive: true });
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
  const { engine, events } = harness({ dwellMs: 1000, adaptive: false });
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

test('stats report the adaptation counters', () => {
  const { engine } = harness({ dwellMs: 1000 });
  engine.enter('a', 0);
  engine.hold(1200);
  const s = engine.stats;
  assert.equal(s.activations, 1);
  assert.equal(s.dwellMs, 1000);
});
