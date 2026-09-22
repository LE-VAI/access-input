/**
 * measure.test.mjs — the three-outcome classifier and session accounting.
 *
 * The load-bearing rules, each of which is a way the number could lie:
 *   - a false activation is NOT the same as an abandoned attempt
 *   - an undo outside the window is a change of mind about the ACTION
 *   - a missing denominator is not a rate of zero
 *   - a report with no witness SAYS so; it does not present a parameter as a
 *     measurement
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AccessOutcomeCounter,
  classifyActivation,
  OUTCOMES,
  DENOMINATORS,
  MEASURE_DEFAULTS,
} from '../src/measure.js';

// -- classification ----------------------------------------------------------

test('a brief activation reversed immediately is FALSE, not ambiguous', () => {
  // The classic spurious trigger: barely crossed, straight back down, undone.
  const v = classifyActivation({ tMs: 1000, heldMs: 120, witness: 'undone', undoAtMs: 1400 });
  assert.equal(v.outcome, OUTCOMES.FALSE);
});

test('CRITICAL: a long hold that is undone is AMBIGUOUS, not false', () => {
  // A deliberate press the user thought better of. Counting this as a device
  // misfire would make the rate track the user's decision-making.
  const v = classifyActivation({ tMs: 1000, heldMs: 900, witness: 'undone', undoAtMs: 1500 });
  assert.equal(v.outcome, OUTCOMES.AMBIGUOUS,
    'an abandoned intentional attempt must not be scored against the device');
});

test('CRITICAL: an undo OUTSIDE the window is a change of mind about the action', () => {
  // Ten seconds later is a different claim entirely — it is about what was
  // done, not about the trigger. Scoring it as a misfire inflates the rate.
  const v = classifyActivation({ tMs: 0, heldMs: 100, witness: 'undone', undoAtMs: 10000 });
  assert.equal(v.outcome, OUTCOMES.TRUE);
  assert.match(v.basis, /change of mind/i);
});

test('a host confirmation is TRUE regardless of duration', () => {
  const v = classifyActivation({ tMs: 0, heldMs: 50, witness: 'confirmed' });
  assert.equal(v.outcome, OUTCOMES.TRUE, 'the host knows whether it used the activation');
});

test('with no witness, a long hold is credited by duration — and says so', () => {
  const v = classifyActivation({ tMs: 0, heldMs: 500 });
  assert.equal(v.outcome, OUTCOMES.TRUE);
  assert.match(v.basis, /credited as intentional by duration/,
    'the basis must admit that a parameter decided it');
});

test('with no witness, a short hold is AMBIGUOUS — never FALSE', () => {
  // Without an independent witness there is no evidence of intent either way,
  // so the honest verdict is uncertainty, not an accusation.
  const v = classifyActivation({ tMs: 0, heldMs: 100 });
  assert.equal(v.outcome, OUTCOMES.AMBIGUOUS);
  assert.match(v.basis, /cannot|below the/i);
});

test('the threshold is a stated parameter, not a hidden constant', () => {
  const strict = classifyActivation({ tMs: 0, heldMs: 500 }, { intentionalHoldMs: 800 });
  assert.equal(strict.outcome, OUTCOMES.AMBIGUOUS, 'a higher threshold reclassifies');
  const lenient = classifyActivation({ tMs: 0, heldMs: 500 }, { intentionalHoldMs: 300 });
  assert.equal(lenient.outcome, OUTCOMES.TRUE);
});

// -- accounting --------------------------------------------------------------

test('CRITICAL: no denominator is null, NOT zero', () => {
  // Zero would read as "no misfires". Null says "no measurement". Conflating
  // them is how an unmeasured device looks like a perfect one.
  const c = new AccessOutcomeCounter();
  c.activation({ tMs: 0, heldMs: 500 });
  const r = c.report();
  assert.equal(r.denominatorHours, 0);
  assert.equal(r.falsePerHour, null, 'an absent denominator must not become a rate of 0');
  assert.equal(c.report().counts.total, 1, 'but the activation was still recorded');
});

test('CRITICAL: the report says whether any independent witness backed it', () => {
  const blind = new AccessOutcomeCounter();
  blind.armed(0); blind.disarm(3600000);
  blind.activation({ tMs: 100, heldMs: 600 });
  assert.equal(blind.report().witnessed, false,
    'every verdict came from a parameter, and the report must say so');

  const seen = new AccessOutcomeCounter();
  seen.armed(0); seen.disarm(3600000);
  seen.activation({ tMs: 100, heldMs: 600, witness: 'confirmed' });
  assert.equal(seen.report().witnessed, true);
});

test('the rate is per hour of the NAMED denominator', () => {
  const c = new AccessOutcomeCounter({ sessionId: 'day-1' });
  c.armed(0);
  c.activeDuration(1800000);          // 30 min of actual work
  // 3 clear misfires
  for (let i = 0; i < 3; i++) {
    c.activation({ tMs: i * 1000, heldMs: 100, witness: 'undone', undoAtMs: i * 1000 + 200 });
  }
  c.disarm(3600000);                  // armed for a full hour

  const armed = c.report({ denominator: DENOMINATORS.ARMED });
  assert.equal(armed.denominatorHours, 1);
  assert.equal(armed.falsePerHour, 3, '3 misfires in 1 armed hour');

  const active = c.report({ denominator: DENOMINATORS.ACTIVE });
  assert.equal(active.denominatorHours, 0.5);
  assert.equal(active.falsePerHour, 6, 'the same 3 against half an hour of work');
});

test('the ambiguous middle is reported separately and never folded in', () => {
  const c = new AccessOutcomeCounter();
  c.armed(0); c.disarm(3600000);
  c.activation({ tMs: 0, heldMs: 100, witness: 'undone', undoAtMs: 100 });    // FALSE
  c.activation({ tMs: 5000, heldMs: 900, witness: 'undone', undoAtMs: 5200 }); // AMBIGUOUS
  c.activation({ tMs: 9000, heldMs: 800, witness: 'confirmed' });              // TRUE

  const r = c.report();
  assert.deepEqual(r.counts, { true: 1, ambiguous: 1, false: 1, total: 3 });
  assert.equal(r.falsePerHour, 1);
  assert.equal(r.ambiguousPerHour, 1, 'reported on its own line');
  assert.equal(r.truePerHour, 1);
  // The false count must NOT include the ambiguous one.
  assert.equal(r.counts.false, 1, 'ambiguous must not inflate the misfire count');
});

test('an undo arriving before its activation is still matched', () => {
  // Hosts report in whatever order their UI observes.
  const c = new AccessOutcomeCounter();
  c.armed(0); c.disarm(3600000);
  c.undo(1200);
  const e = c.activation({ tMs: 1000, heldMs: 100 });
  assert.equal(e.outcome, OUTCOMES.FALSE, 'the pending undo was attached');
});

test('undo() reclassifies the last activation in place', () => {
  const c = new AccessOutcomeCounter();
  c.armed(0); c.disarm(3600000);
  c.activation({ tMs: 1000, heldMs: 100 });
  assert.equal(c.activations[0].outcome, OUTCOMES.AMBIGUOUS, 'unknown until the undo arrives');
  c.undo(1300);
  assert.equal(c.activations[0].outcome, OUTCOMES.FALSE, 'the undo resolved it');
  assert.equal(c.report().counts.false, 1);
});

test('confirm() upgrades an unknown activation to true', () => {
  const c = new AccessOutcomeCounter();
  c.armed(0); c.disarm(3600000);
  c.activation({ tMs: 1000, heldMs: 80 });
  c.confirm(1100);
  assert.equal(c.report().counts.true, 1, 'the host saw it used');
  assert.equal(c.report().counts.ambiguous, 0);
});

test('armed time accumulates across multiple intervals', () => {
  const c = new AccessOutcomeCounter();
  c.armed(0);      c.disarm(600000);   // 10 min
  c.armed(900000); c.disarm(1500000);  // another 10 min
  assert.equal(c.report().denominatorHours, 0.333, '20 min total, rounded to 3dp');
});

test('re-arming without disarming does not double-count', () => {
  const c = new AccessOutcomeCounter();
  c.armed(0); c.armed(100); c.armed(200);   // hosts may be sloppy
  c.disarm(3600000);
  assert.equal(c.report().denominatorHours, 1, 'one hour, not three');
});

test('the report carries the parameters that decided duration verdicts', () => {
  const c = new AccessOutcomeCounter({ intentionalHoldMs: 650 });
  c.armed(0); c.disarm(3600000);
  c.activation({ tMs: 0, heldMs: 700 });
  const r = c.report();
  assert.equal(r.parameters.intentionalHoldMs, 650,
    'a reader can see how much of the number came from our choice');
  assert.equal(r.counts.true, 1, '700ms clears a 650ms threshold');
});

test('the per-activation record is auditable', () => {
  const c = new AccessOutcomeCounter();
  c.armed(0); c.disarm(3600000);
  c.activation({ tMs: 500, heldMs: 120, witness: 'undone', undoAtMs: 700 });
  const a = c.report().activations[0];
  assert.equal(a.tMs, 500);
  assert.equal(a.heldMs, 120);
  assert.equal(a.outcome, OUTCOMES.FALSE);
  assert.ok(a.basis, 'every verdict carries its reason');
});

test('toJSON emits a versioned schema for cross-implementation comparison', () => {
  const c = new AccessOutcomeCounter();
  c.armed(0); c.disarm(3600000);
  c.activation({ tMs: 0, heldMs: 100, witness: 'undone', undoAtMs: 100 });
  const j = c.toJSON();
  assert.equal(j.schema, 'activation-measure/1',
    'the version is what makes two implementations comparable');
  assert.equal(j.falsePerHour, 1);
});

test('defaults are exposed so a consumer can cite them', () => {
  assert.ok(MEASURE_DEFAULTS.intentionalHoldMs > 0);
  assert.ok(MEASURE_DEFAULTS.undoWindowMs > 0);
  assert.equal(DENOMINATORS.ARMED, 'armed');
  assert.equal(DENOMINATORS.ACTIVE, 'active');
});


test('active time accumulates from BOTH paths — so record it one way, not both', () => {
  // Both disarm({activeMs}) and activeDuration() ADD to the same accumulator.
  // That is correct for separate intervals and silently doubles for one, which
  // is a trap worth pinning so the behaviour is a decision rather than a
  // surprise. (It caught the protocol doc's own example while being written.)
  const onePath = new AccessOutcomeCounter();
  onePath.armed(0);
  onePath.disarm(3600000, { activeMs: 1800000 });
  assert.equal(onePath.report({ denominator: DENOMINATORS.ACTIVE }).denominatorHours, 0.5,
    'one path: half an hour of work');

  const bothPaths = new AccessOutcomeCounter();
  bothPaths.armed(0);
  bothPaths.activeDuration(1800000);
  bothPaths.disarm(3600000, { activeMs: 1800000 });
  assert.equal(bothPaths.report({ denominator: DENOMINATORS.ACTIVE }).denominatorHours, 1,
    'both paths: an hour — the caller said so twice');

  // Separate intervals are the case the addition exists for.
  const twoIntervals = new AccessOutcomeCounter();
  twoIntervals.armed(0);
  twoIntervals.disarm(600000, { activeMs: 300000 });    // 5 min work
  twoIntervals.armed(1200000);
  twoIntervals.disarm(1800000, { activeMs: 300000 });   // 5 min work
  assert.equal(twoIntervals.report({ denominator: DENOMINATORS.ACTIVE }).denominatorHours, 0.167,
    'two separate intervals sum correctly');
});
