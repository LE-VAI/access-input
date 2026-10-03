/**
 * focus.test.mjs — the speak-on-focus contract.
 *
 * onFocus is a speech trigger, and speech is the most intrusive feedback an
 * interface can give: a ring that paints during a glance is noise, a voice
 * that speaks during a glance is unusable. So the behaviours that matter are
 * mostly about SILENCE:
 *   - a glance that never passes lock-on says nothing
 *   - a grace-window slip does not repeat what was already said
 *   - activation, a held spent target, and repeat fires do not re-announce
 *   - every onFocus is ended by exactly one onBlur, so a host can always
 *     cancel or replace speech
 * And for switch users, the opposite: every scan step IS announced (auditory
 * scanning), because a scan step is a deliberate move.
 *
 * Every test drives an explicit clock (see dwell.test.mjs for why).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DwellEngine } from '../src/dwell.js';
import { ExternalSource, SwitchSource, SignalBridge } from '../src/sources.js';
import { accessibleName, targetLabel, TARGET_ATTR } from '../src/words.js';

/** Record focus and blur in ONE ordered stream, so pairing is checkable. */
function harness(options = {}) {
  const events = { stream: [], activations: [] };
  const engine = new DwellEngine({
    dwellMs: 400,
    lockOnMs: 150,
    graceMs: 100,
    ...options,
    onFocus: (id, label, info) => events.stream.push({ type: 'focus', id, label, ...info }),
    onBlur: (id, info) => events.stream.push({ type: 'blur', id, ...info }),
    onActivate: (id) => events.activations.push(id),
  });
  events.focuses = () => events.stream.filter((e) => e.type === 'focus');
  events.blurs = () => events.stream.filter((e) => e.type === 'blur');
  return { engine, events };
}

const FRAME_MS = 16;
function advance(engine, fromMs, toMs, step = FRAME_MS) {
  for (let t = fromMs; t <= toMs; t += step) engine.hold(t);
  if ((toMs - fromMs) % step !== 0) engine.hold(toMs);
}

/** Every focus is ended by one blur with the same seq before the next focus. */
function assertPaired(stream) {
  let open = null;
  for (const e of stream) {
    if (e.type === 'focus') {
      assert.equal(open, null, `focus ${e.id} arrived while ${open?.id} was still open`);
      open = e;
    } else {
      assert.ok(open, `blur ${e.id} with no open focus`);
      assert.equal(e.id, open.id, 'a blur names the focus it ends');
      assert.equal(e.seq, open.seq, 'and carries the same seq');
      open = null;
    }
  }
}

// -- dwell: when focus is acquired ------------------------------------------

test('a glance that never passes lock-on does NOT fire onFocus', () => {
  // The whole reason the hook waits for lock-on. A gaze sweep crosses several
  // words a second; speaking each one would make the page unusable.
  const { engine, events } = harness();
  engine.enter('w1', 0);
  advance(engine, 0, 100);      // 100ms < 150ms lock-on
  engine.leave(100);
  engine.tick(300);             // grace expires: the glance is over
  assert.equal(events.focuses().length, 0, 'a glance must not be spoken');
  assert.equal(events.blurs().length, 0, 'and there is nothing to retract');
});

test('a sweep across several targets says nothing at all', () => {
  const { engine, events } = harness();
  let t = 0;
  for (const id of ['w1', 'w2', 'w3', 'w4']) {
    engine.enter(id, t);        // straight from one to the next
    advance(engine, t, t + 80);
    t += 96;
  }
  engine.leave(t);
  engine.tick(t + 200);
  assert.equal(events.focuses().length, 0);
});

test('passing lock-on fires onFocus exactly once, at the lock-on → dwell transition', () => {
  const { engine, events } = harness();
  engine.enter('w1', 0);
  assert.equal(events.focuses().length, 0, 'entry alone is not acquisition');
  advance(engine, 0, 140);
  assert.equal(events.focuses().length, 0, 'still in lock-on');
  advance(engine, 140, 176);
  assert.equal(events.focuses().length, 1, 'lock-on passed: focus acquired');
  assert.equal(engine.phase, 'dwell');
  const f = events.focuses()[0];
  assert.equal(f.id, 'w1');
  assert.equal(f.via, 'dwell');
  assert.equal(f.label, 'w1', 'no DOM here, so the label falls back to the id');
  assert.ok(Number.isFinite(f.tMs) && f.tMs >= 150, 'stamped with the acquisition time');
  assert.equal(engine.focused, 'w1');
});

test('a grace-window slip that returns does NOT re-fire onFocus', () => {
  const { engine, events } = harness({ graceMs: 200 });
  engine.enter('w1', 0);
  advance(engine, 0, 400);      // locked on and part-way through the dwell
  assert.equal(events.focuses().length, 1);
  engine.leave(400);            // tremor slip
  engine.tick(480);             // still inside the 200ms grace window
  engine.enter('w1', 500);      // back on target: progress resumes
  advance(engine, 500, 700);
  assert.equal(events.focuses().length, 1, 'a forgiven slip must not repeat the label');
  assert.equal(events.blurs().length, 0, 'and the focus never ended');
  assert.equal(events.activations.length, 1, 'the dwell still completed');
});

test('activation, a held spent target, and re-entry without departure do not re-announce', () => {
  const { engine, events } = harness();
  engine.enter('w1', 0);
  advance(engine, 0, 700);      // lock-on + dwell → fires
  assert.equal(events.activations.length, 1);
  advance(engine, 700, 2000);   // still held: spent
  engine.enter('w1', 2010);     // a jittery stream re-reports the same target
  advance(engine, 2010, 2500);
  assert.equal(events.focuses().length, 1, 'one landing, one announcement');
  assert.equal(engine.focused, 'w1', 'the visit — and its focus — continue');
});

test('repeat targets re-fire on their interval without re-announcing', () => {
  const { engine, events } = harness({ repeatIntervalMs: 300 });
  engine.setRepeatTargets(['volume-up']);
  engine.enter('volume-up', 0);
  advance(engine, 0, 1600);
  assert.ok(events.activations.length >= 3, 'the target repeated');
  assert.equal(events.focuses().length, 1, 'but was announced once');
});

test('with leaveToRearm off, fresh dwell cycles on a held target do not re-announce', () => {
  // A host that gates repeats itself gets a new dwell every cycle while the
  // signal rests. That is still ONE visit: the user has not moved.
  const { engine, events } = harness({ leaveToRearm: false, lockoutMs: 0 });
  for (let t = 0; t <= 2000; t += FRAME_MS) {
    engine.enter('w1', t);      // a continuous source re-reports each frame
    engine.hold(t);
  }
  assert.ok(events.activations.length >= 2, 'the target fired more than once');
  assert.equal(events.focuses().length, 1, 'the label was spoken once');
});

test('leaving past the grace window fires onBlur with the same seq; returning re-acquires', () => {
  const { engine, events } = harness();
  engine.enter('w1', 0);
  advance(engine, 0, 300);
  engine.leave(300);
  engine.tick(450);             // grace expired
  assert.equal(events.blurs().length, 1);
  const [f] = events.focuses();
  const [b] = events.blurs();
  assert.equal(b.id, 'w1');
  assert.equal(b.seq, f.seq, 'the blur names the announcement it ends');
  assert.equal(b.reason, 'left');
  assert.equal(engine.focused, null);

  // A deliberate return is a new visit: it must pass lock-on again.
  engine.enter('w1', 600);
  advance(engine, 600, 700);
  assert.equal(events.focuses().length, 1, 'not before lock-on');
  advance(engine, 700, 800);
  assert.equal(events.focuses().length, 2);
  assert.ok(events.focuses()[1].seq > f.seq, 'a new acquisition gets a new seq');
});

test('moving to another target blurs the old one at once; the new one waits for lock-on', () => {
  const { engine, events } = harness();
  engine.enter('w1', 0);
  advance(engine, 0, 300);
  engine.enter('w2', 300);      // straight to a neighbour
  assert.deepEqual(events.blurs().map((b) => [b.id, b.reason]), [['w1', 'replaced']],
    'the host can cancel w1 the moment the signal moves');
  advance(engine, 300, 400);
  assert.equal(events.focuses().length, 1, 'w2 is not spoken during its lock-on');
  advance(engine, 400, 500);
  assert.deepEqual(events.focuses().map((f) => f.id), ['w1', 'w2']);
  assertPaired(events.stream);
});

test('lockOnMs: 0 means every entry is an acquisition (the host turned the gate off)', () => {
  const { engine, events } = harness({ lockOnMs: 0 });
  engine.enter('w1', 0);
  assert.equal(events.focuses().length, 1);
  assert.equal(events.focuses()[0].via, 'dwell');
});

test('pause, explicit cancel, and a clock gap each end the focus with a reason', () => {
  const run = (end) => {
    const { engine, events } = harness();
    engine.enter('w1', 0);
    advance(engine, 0, 300);
    assert.equal(events.focuses().length, 1);
    end(engine);
    assert.equal(engine.focused, null);
    assertPaired(events.stream);
    return events.blurs()[0].reason;
  };
  assert.equal(run((e) => e.pause()), 'paused');
  assert.equal(run((e) => e.cancel('escape')), 'escape');
  assert.equal(run((e) => e.hold(10_300)), 'clock-gap',
    'a hidden tab must not leave a stale target described');
});

test('a paused engine announces nothing', () => {
  const { engine, events } = harness();
  engine.pause();
  engine.enter('w1', 0);
  advance(engine, 0, 600);
  engine.focus('cell-1', 700);
  assert.equal(events.focuses().length, 0);
});

test('focus and blur stay strictly paired across a messy session', () => {
  const { engine, events } = harness({ graceMs: 60 });
  let t = 0;
  const step = (ms) => { advance(engine, t, t + ms); t += ms; };
  engine.enter('a', t); step(300);
  engine.leave(t); engine.tick(t + 30); engine.enter('a', t + 40); t += 40; step(200);
  engine.enter('b', t); step(80);           // glance at b
  engine.enter('c', t); step(700);          // c fires
  engine.leave(t); engine.tick(t + 100); t += 100;
  engine.enter('d', t); step(250);
  engine.hold(t + 5000); t += 5000;         // clock gap
  engine.enter('e', t); step(300);
  engine.cancel('escape');
  assertPaired(events.stream);
  assert.deepEqual(events.focuses().map((f) => f.id), ['a', 'c', 'd', 'e']);
});

// -- direct sources: auditory scanning --------------------------------------

/** A fake DOM root: N targets, no real elements needed. */
function fakeRoot(ids) {
  return {
    querySelectorAll: () => ids.map((id) => ({
      getAttribute: (k) => (k === TARGET_ATTR ? id : null),
    })),
  };
}

test('SCAN: every highlight step fires onFocus, blurring the previous one', () => {
  const { engine, events } = harness();
  const src = new SwitchSource({ now: () => 1000 });
  src.attach(fakeRoot(['yes', 'no', 'more']));
  new SignalBridge({ source: src, dwell: engine, mode: 'direct' });
  src._active = true;
  src._advance(0);
  src._advance(1100);
  src._advance(2200);
  src._advance(3300);           // wraps to 'yes'
  assert.deepEqual(events.focuses().map((f) => f.id), ['yes', 'no', 'more', 'yes']);
  assert.ok(events.focuses().every((f) => f.via === 'direct'));
  assert.deepEqual(events.blurs().map((b) => b.reason), ['replaced', 'replaced', 'replaced']);
  assertPaired(events.stream);
  assert.equal(engine.target, null, 'a scan never starts a dwell');
});

test('SCAN: the first step is announced at once — there is no lock-on for a scan', () => {
  const { engine, events } = harness({ lockOnMs: 400 });
  const src = new SwitchSource({ now: () => 0 });
  src.attach(fakeRoot(['a', 'b']));
  new SignalBridge({ source: src, dwell: engine, mode: 'direct' });
  src._active = true;
  src._advance(0);
  assert.equal(events.focuses().length, 1, 'a scan step is deliberate, so no gate');
  assert.equal(events.focuses()[0].tMs, 0, "stamped with the source's time");
});

test('SCAN: re-reporting the focused target says nothing new', () => {
  const { engine, events } = harness();
  const src = new ExternalSource({ now: () => 0 });
  new SignalBridge({ source: src, dwell: engine }); // auto: ExternalSource is direct
  src.start();
  src.focus('w5', 0);
  src.focus('w5', 20);
  src.focus('w5', 40);
  assert.equal(events.focuses().length, 1);
  src.focus(null, 60);
  assert.deepEqual(events.blurs().map((b) => b.reason), ['left'],
    'focus going nowhere is a blur, not a focus');
});

test('SCAN: stopping the bridge or cancelling ends the announced focus', () => {
  const { engine, events } = harness();
  const src = new SwitchSource({ now: () => 0 });
  src.attach(fakeRoot(['a', 'b']));
  const bridge = new SignalBridge({ source: src, dwell: engine, mode: 'direct' });
  src._active = true;
  src._advance(0);
  bridge.stop();
  assert.deepEqual(events.blurs().map((b) => b.reason), ['stopped'],
    'stopping the input must not leave the host speaking for a dead source');
});

test('SCAN: a press does not re-announce the target it selects', () => {
  const { engine, events } = harness();
  const src = new SwitchSource({ debounceMs: 0, accidentalPressMs: 0, now: () => 0 });
  src.attach(fakeRoot(['a', 'b']));
  new SignalBridge({ source: src, dwell: engine, mode: 'direct' });
  src._active = true;
  src.press(0);                 // first press advances to 'a'
  src.press(500);               // selects 'a'
  assert.equal(events.focuses().length, 1);
});

test('the bridge leaves a host onFocus on the engine intact and gated per event', () => {
  // The bridge chains onto engine callbacks; it must chain onto focus too,
  // not replace the host's handler.
  const { engine, events } = harness();
  const src = new ExternalSource({ now: () => 0 });
  new SignalBridge({ source: src, dwell: engine, mode: 'dwell' });
  src.start();
  src.focus('w1', 0);
  advance(engine, 0, 200);
  assert.equal(events.focuses().length, 1, 'the host handler survived the bridge');
  assert.equal(events.focuses()[0].via, 'dwell', 'a continuous source still dwells');
});

// -- consent ----------------------------------------------------------------

function fakeGate(granted) {
  return {
    _granted: granted,
    isGranted() { return this._granted; },
    withdraw() { this._granted = false; },
  };
}

test('CONSENT: a withheld grant means nothing is spoken, in either mode', () => {
  const { engine, events } = harness();
  const scan = new SwitchSource({ now: () => 0 });
  scan.attach(fakeRoot(['a', 'b']));
  new SignalBridge({ source: scan, dwell: engine, mode: 'direct', consent: fakeGate(false) });
  scan._active = true;
  scan._advance(0);
  scan._advance(1000);

  const ext = new ExternalSource({ now: () => 0 });
  const second = harness();
  new SignalBridge({ source: ext, dwell: second.engine, mode: 'dwell', consent: fakeGate(false) });
  ext.start();
  ext.focus('w1', 0);
  advance(second.engine, 0, 400);

  assert.equal(events.focuses().length, 0, 'a scan step is still reading the signal');
  assert.equal(second.events.focuses().length, 0);
});

test('CONSENT: withdrawal mid-lock-on blocks the announcement and sends no orphan blur', () => {
  // The announcement comes from hold() — the host's heartbeat — not from a
  // source event, so the bridge must gate the callback itself.
  const { engine, events } = harness();
  const gate = fakeGate(true);
  const src = new ExternalSource({ now: () => 0 });
  new SignalBridge({ source: src, dwell: engine, mode: 'dwell', consent: gate });
  src.start();
  src.focus('w1', 0);
  advance(engine, 0, 100);      // in lock-on
  gate.withdraw();
  advance(engine, 100, 400);    // lock-on would complete here
  assert.equal(events.focuses().length, 0, 'no speech after consent was withdrawn');
  assert.equal(events.blurs().length, 0, 'and no retraction of something never said');
  assert.equal(engine.focused, null, 'the withdrawal cancelled the attempt');
});

// -- labels -----------------------------------------------------------------

/** Minimal element stub: attributes, text, and a root to resolve ids in. */
function el(attrs = {}, text = '', byId = {}) {
  const root = { getElementById: (id) => byId[id] ?? null };
  return {
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    textContent: text,
    getRootNode: () => root,
  };
}

test('LABEL: aria-label wins over everything else', () => {
  const node = el({ 'aria-label': ' Say yes ', 'aria-labelledby': 'x' }, 'Yes',
    { x: { textContent: 'ignored' } });
  assert.equal(accessibleName(node), 'Say yes');
});

test('LABEL: aria-labelledby is next, joining every referenced element', () => {
  const node = el({ 'aria-labelledby': 'a  b' }, 'fallback text',
    { a: { textContent: 'Volume' }, b: { textContent: '\n  up ' } });
  assert.equal(accessibleName(node), 'Volume up');
});

test('LABEL: then the trimmed text, with markup whitespace collapsed', () => {
  assert.equal(accessibleName(el({}, '\n    More\n    please  ')), 'More please');
  assert.equal(accessibleName(el({ 'aria-labelledby': 'missing' }, ' Stop ')), 'Stop',
    'a dangling aria-labelledby falls through to the text');
});

test('LABEL: targetLabel finds the element by id, or falls back to String(id)', () => {
  const cell = { ...el({ 'aria-label': 'Yes, please' }), getAttribute: (k) =>
    ({ [TARGET_ATTR]: 'yes', 'aria-label': 'Yes, please' })[k] ?? null };
  const root = { querySelectorAll: () => [cell] };
  assert.equal(targetLabel('yes', root), 'Yes, please');
  assert.equal(targetLabel('no', root), 'no', 'no such target: the id');
  assert.equal(targetLabel(42, null), '42', 'no DOM at all: the id as a string');
});

test('LABEL: ids with quotes and brackets resolve without selector escaping', () => {
  const id = 'say "hi" [now]';
  const node = { getAttribute: (k) => (k === TARGET_ATTR ? id : null), textContent: 'Hi' };
  assert.equal(targetLabel(id, { querySelectorAll: () => [node] }), 'Hi');
});

test('LABEL: the default resolver reads the document when there is one', () => {
  const cell = {
    getAttribute: (k) => (k === TARGET_ATTR ? 'stop' : null),
    textContent: '  Stop  ',
    getRootNode: () => ({}),
  };
  const saved = globalThis.document;
  globalThis.document = { querySelectorAll: () => [cell] };
  try {
    const { engine, events } = harness({ lockOnMs: 0 });
    engine.enter('stop', 0);
    assert.equal(events.focuses()[0].label, 'Stop');
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  }
});

test('LABEL: a custom labelOf is used, and a broken one cannot break the engine', () => {
  const custom = harness({ lockOnMs: 0, labelOf: (id) => `Option ${id}` });
  custom.engine.enter('3', 0);
  assert.equal(custom.events.focuses()[0].label, 'Option 3');

  const broken = harness({ lockOnMs: 0, labelOf: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => broken.engine.enter('w9', 0));
  assert.equal(broken.events.focuses()[0].label, 'w9', 'a throwing resolver falls back to the id');
  advance(broken.engine, 0, 450);
  assert.equal(broken.events.activations.length, 1, 'and activation still works');

  const empty = harness({ lockOnMs: 0, labelOf: () => '   ' });
  empty.engine.enter('w2', 0);
  assert.equal(empty.events.focuses()[0].label, 'w2', 'a label is never empty');
});

test('LABEL: the resolver is not called when nobody listens for focus', () => {
  let calls = 0;
  const engine = new DwellEngine({ lockOnMs: 0, labelOf: () => { calls++; return 'x'; } });
  engine.enter('w1', 0);
  engine.focus('w2', 10);
  assert.equal(calls, 0, 'an engine nobody asked to speak should not read the DOM');
  assert.equal(engine.focused, 'w2', 'focus is still tracked');

  // Attaching a bridge must not change that: it has no handler to gate.
  const src = new ExternalSource({ now: () => 0 });
  new SignalBridge({ source: src, dwell: engine });
  src.start();
  src.focus('w3', 20);
  assert.equal(calls, 0, 'a bridge with nothing to gate adds no label lookups');
  assert.equal(engine.focused, 'w3');
});
