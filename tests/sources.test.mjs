/**
 * sources.test.mjs — source capabilities + bridge wiring + switch/keyboard QoL.
 *
 * The load-bearing rules:
 *   - a CONTINUOUS source dwells, a DIRECT source does not
 *   - the bridge CHAINS onto engine callbacks (it used to clobber them)
 *   - a switch scan PAUSES after a selection
 *   - presses are DEBOUNCED (bounce + accidental press)
 *   - a held key moves focus ONCE (no auto-repeat for assistive targets)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  InputSource,
  ExternalSource,
  SwitchSource,
  SignalBridge,
} from '../src/sources.js';
import { DwellEngine } from '../src/dwell.js';

/**
 * Advance a dwell engine at frame cadence. A single sparse hold() call trips
 * the clock-gap guard — correctly, since a heartbeat gap means the host
 * stopped ticking — so source tests must tick the way a real host does.
 */
function advance(dwell, fromMs, toMs, step = 16) {
  for (let t = fromMs; t <= toMs; t += step) dwell.hold(t);
  if ((toMs - fromMs) % step !== 0) dwell.hold(toMs);
}

// -- capabilities + bridge --------------------------------------------------

test('ExternalSource declares continuous + direct capabilities', () => {
  const src = new ExternalSource();
  assert.equal(src.capabilities.continuous, true);
  assert.equal(src.capabilities.direct, true);
});

test('a continuous-only source drives dwell; its select is not used', () => {
  const events = [];
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 1000, lockOnMs: 0 });
  new SignalBridge({
    source: src,
    dwell,
    mode: 'dwell', // a gaze tracker: position only, no select of its own
    onActivate: (id, meta) => events.push({ id, via: meta.via }),
  });
  src.start();
  src.focus('w3', 0);
  assert.equal(dwell.target, 'w3', 'a continuous source must start a dwell');
  advance(dwell, 0, 1200);
  assert.equal(events.length, 1);
  assert.equal(events[0].via, 'dwell');
});

test('a direct source activates on select without dwelling', () => {
  const events = [];
  const src = new SwitchSource({ keys: [' '] });
  const dwell = new DwellEngine({ dwellMs: 1000 });
  new SignalBridge({
    source: src,
    dwell,
    onActivate: (id, meta) => events.push({ id, via: meta.via }),
  });
  src.start();
  src.onSelect?.('w7', 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].via, 'direct', 'a switch press must not require dwell');
});

test('bridge reports focus changes only when the target actually changes', () => {
  const focused = [];
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 1000 });
  new SignalBridge({
    source: src,
    dwell,
    onFocus: (id) => focused.push(id),
  });
  src.start();
  src.focus('w1', 0);
  src.focus('w1', 10);
  src.focus('w2', 20);
  assert.deepEqual(focused, ['w1', 'w2']);
});

test('source cancel cancels the dwell and reports through the bridge', () => {
  const cancels = [];
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 1000 });
  new SignalBridge({
    source: src,
    dwell,
    onCancel: (_id, meta) => cancels.push(meta.reason),
  });
  src.start();
  src.cancel('escape');
  assert.deepEqual(cancels, ['escape']);
  assert.equal(dwell.target, null);
});

test('stopping the bridge stops the source and clears the dwell', () => {
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 1000 });
  const bridge = new SignalBridge({ source: src, dwell });
  src.start();
  dwell.enter('w1', 0);
  assert.equal(dwell.target, 'w1');
  bridge.stop();
  assert.equal(src.active, false);
  assert.equal(dwell.target, null);
});

test('InputSource base class documents an inactive default', () => {
  const s = new InputSource();
  assert.equal(s.active, false);
  assert.equal(s.capabilities.direct, false);
  assert.equal(s.capabilities.continuous, false);
});

test('a direct source that also reports focus does not dwell', () => {
  const events = [];
  const src = new ExternalSource(); // declares both continuous and direct
  const dwell = new DwellEngine({ dwellMs: 1000 });
  new SignalBridge({
    source: src,
    dwell,
    onActivate: (id, meta) => events.push({ id, via: meta.via }),
  });
  src.start();
  src.focus('w5', 0);
  assert.equal(dwell.target, null, 'direct sources must not start a dwell');
  src.select('w5');
  assert.equal(events.length, 1);
  assert.equal(events[0].via, 'direct');
});

test('the bridge chains onto engine callbacks instead of clobbering them', () => {
  // Regression: the bridge used to OVERWRITE dwell.onProgress/onActivate,
  // silently discarding any handler the host had configured. That shipped a
  // dwell ring that never painted.
  const hostProgress = [];
  const bridgeProgress = [];
  const src = new ExternalSource();
  const dwell = new DwellEngine({
    dwellMs: 1000,
    lockOnMs: 0,
    onProgress: (id, ratio) => hostProgress.push(ratio),
  });
  new SignalBridge({
    source: src,
    dwell,
    mode: 'dwell',
    onProgress: (id, ratio) => bridgeProgress.push(ratio),
  });
  src.start();
  src.focus('w1', 0);
  advance(dwell, 0, 400);
  assert.ok(hostProgress.length > 0, 'the host handler must still fire');
  assert.ok(bridgeProgress.length > 0, 'the bridge handler must also fire');
});

test('the bridge chains onto engine cancel handlers too', () => {
  const hostCancels = [];
  const src = new ExternalSource();
  const dwell = new DwellEngine({
    dwellMs: 1000,
    onCancel: (id) => hostCancels.push(id),
  });
  new SignalBridge({ source: src, dwell });
  src.start();
  dwell.enter('w9', 0);
  dwell.cancel('escape');
  assert.deepEqual(hostCancels, ['w9'], 'host cancel handler must survive the bridge');
});

// -- consent gate -----------------------------------------------------------

/** A minimal gate stand-in — duck-typed, exactly as the bridge consumes it. */
function fakeGate(granted = false) {
  return {
    _granted: granted,
    isGranted() { return this._granted; },
    grant() { this._granted = true; },
    withdraw() { this._granted = false; },
  };
}

test('CONSENT: no gate configured means the bridge works normally', () => {
  const events = [];
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 300, lockOnMs: 0 });
  new SignalBridge({ source: src, dwell, mode: 'dwell',
    onActivate: (id) => events.push(id) });
  src.start();
  src.focus('w1', 0);
  advance(dwell, 0, 400);
  assert.deepEqual(events, ['w1'], 'a pointer user has nothing to consent to');
});

test('CONSENT: a refused gate blocks activation entirely', () => {
  const events = [];
  const gate = fakeGate(false);
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 300, lockOnMs: 0 });
  new SignalBridge({ source: src, dwell, mode: 'dwell', consent: gate,
    onActivate: (id) => events.push(id) });
  src.start();
  src.focus('w1', 0);
  advance(dwell, 0, 400);
  assert.equal(events.length, 0, 'no consent means no reading of the signal');
});

test('CONSENT: granting mid-session lets the signal through', () => {
  const events = [];
  const gate = fakeGate(false);
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 300, lockOnMs: 0 });
  new SignalBridge({ source: src, dwell, mode: 'dwell', consent: gate,
    onActivate: (id) => events.push(id) });
  src.start();

  src.focus('w1', 0);
  advance(dwell, 0, 200);
  assert.equal(events.length, 0);

  gate.grant();
  src.focus('w2', 200);
  advance(dwell, 200, 600);
  assert.deepEqual(events, ['w2'], 'after the grant it works');
});

test('CONSENT: WITHDRAWING mid-dwell cancels the in-flight activation', () => {
  // The failure this prevents: turning consent off and still getting the
  // selection you had already started.
  const events = [];
  const gate = fakeGate(true);
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 600, lockOnMs: 0 });
  new SignalBridge({ source: src, dwell, mode: 'dwell', consent: gate,
    onActivate: (id) => events.push(id) });
  src.start();

  src.focus('w1', 0);
  advance(dwell, 0, 300);   // half-way through the dwell
  gate.withdraw();          // user turns it off now
  advance(dwell, 300, 800); // the dwell would have completed here
  assert.equal(events.length, 0, 'a withdrawn grant must stop the activation');
});

test('CONSENT: withdrawing then re-granting works normally again', async () => {
  const events = [];
  const gate = fakeGate(true);
  // ONE clock, shared by the source and the engine. ExternalSource stamps
  // focus events with its own clock; the engine's heartbeats use another. If
  // they differ, the clock-gap guard sees a stall and aborts valid dwells.
  // Real hosts satisfy this by construction (everything is performance.now());
  // this test wires both to the same mutable time.
  let clock = 0;
  const src = new ExternalSource({ now: () => clock });
  const dwell = new DwellEngine({ dwellMs: 300, lockOnMs: 0 });
  new SignalBridge({ source: src, dwell, mode: 'dwell', consent: gate,
    onActivate: (id) => events.push(id) });
  src.start();

  const run = (from, to) => {
    for (let t = from; t <= to; t += 16) { clock = t; dwell.hold(t); }
    clock = to;
  };

  clock = 0; src.focus('w1');
  run(0, 400);
  assert.equal(events.length, 1);

  gate.withdraw();
  clock = 500; src.focus('w2');
  run(500, 950);   // heartbeats continue while withdrawn, as a real host's would
  assert.equal(events.length, 1, 'nothing while withdrawn');

  // After a withdrawal the source is STOPPED at the hardware boundary, so
  // re-granting alone must not silently resume acquisition of a body signal.
  // The host restarts it deliberately.
  const stoppedByWithdrawal = !src.active;
  assert.equal(stoppedByWithdrawal, true,
    'withdrawal must stop the source, not merely stop acting on it');

  gate.grant();
  await src.start();          // the deliberate re-acquisition
  clock = 1000; src.focus('w3');
  run(1000, 1400);
  assert.equal(events.length, 2, 'after restarting, re-granting works normally');
});

test('CONSENT: a direct source is gated too', () => {
  const events = [];
  const gate = fakeGate(false);
  const src = new SwitchSource({ keys: [' '] });
  const dwell = new DwellEngine({ dwellMs: 300 });
  new SignalBridge({ source: src, dwell, consent: gate,
    onActivate: (id) => events.push(id) });
  src.start();
  src.onSelect?.('w1', 0);
  assert.equal(events.length, 0, 'a switch press is still reading the signal');
});

test('CONSENT: cancel is NOT gated — backing out must always work', () => {
  const cancels = [];
  const gate = fakeGate(false);
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 300 });
  new SignalBridge({ source: src, dwell, consent: gate,
    onCancel: (_id, meta) => cancels.push(meta.reason) });
  src.start();
  src.cancel('escape');
  assert.deepEqual(cancels, ['escape'],
    'a user leaving must never be blocked, including to escape consent');
});

test('CONSENT: a BROKEN gate fails closed, not open', () => {
  // A gate that throws must mean "no consent". A broken gate that reads as
  // permission is worse than having no gate at all.
  const events = [];
  const brokenGate = { isGranted() { throw new Error('gate is broken'); } };
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 300, lockOnMs: 0 });
  new SignalBridge({ source: src, dwell, mode: 'dwell', consent: brokenGate,
    onActivate: (id) => events.push(id) });
  src.start();
  src.focus('w1', 0);
  advance(dwell, 0, 400);
  assert.equal(events.length, 0, 'a throwing gate must not admit the signal');
});

test('CONSENT: a gate missing isGranted also fails closed', () => {
  const events = [];
  const malformed = { grant() {} }; // no isGranted
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 300, lockOnMs: 0 });
  new SignalBridge({ source: src, dwell, mode: 'dwell', consent: malformed,
    onActivate: (id) => events.push(id) });
  src.start();
  src.focus('w1', 0);
  advance(dwell, 0, 400);
  assert.equal(events.length, 0, 'a malformed gate must not admit the signal');
});

test('CONSENT: a custom purpose name is honored', () => {
  const asked = [];
  const gate = { isGranted: (p) => { asked.push(p); return false; } };
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 300 });
  new SignalBridge({ source: src, dwell, consent: gate,
    consentPurpose: 'process_locally' });
  src.start();
  src.focus('w1', 0);
  assert.ok(asked.includes('process_locally'),
    'the bridge asks about the purpose it was told to');
});

test('CONSENT: a refused gate prevents the DEVICE from opening', () => {
  // The gate previously only stopped the bridge from FORWARDING events. The
  // serial port still opened and the biosignal was still being read — the
  // difference between "we will not act on it" and "we will not read it".
  let startCalls = 0;
  const blocked = [];
  const src = {
    _active: false,
    capabilities: { continuous: false, direct: true, targets: false, twoAxis: false },
    onFocus: null, onSelect: null, onCancel: null,
    async start() { startCalls++; this._active = true; },
    stop() { this._active = false; },
  };
  const gate = fakeGate(false);
  const dwell = new DwellEngine({ dwellMs: 300 });
  const bridge = new SignalBridge({ source: src, dwell, consent: gate,
    onBlocked: (r) => blocked.push(r) });

  return bridge.start().then((started) => {
    assert.equal(started, false, 'start() must report that it was refused');
    assert.equal(startCalls, 0, 'the device must not be opened at all');
    assert.deepEqual(blocked, ['consent'], 'and the host is told why');
  });
});

test('CONSENT: withdrawal stops the source at the hardware boundary', () => {
  let stopped = false;
  const lost = [];
  const src = {
    _active: true,
    capabilities: { continuous: false, direct: true, targets: false, twoAxis: false },
    onFocus: null, onSelect: null, onCancel: null,
    async start() { this._active = true; },
    stop() { stopped = true; this._active = false; },
  };
  const gate = fakeGate(true);
  const dwell = new DwellEngine({ dwellMs: 300 });
  const bridge = new SignalBridge({ source: src, dwell, consent: gate, mode: 'direct',
    onConsentLost: () => lost.push(1) });
  bridge.stop = () => {};   // isolate: we are testing the gate, not teardown
  bridge._consentWasGranted = true;

  gate.withdraw();
  const allowed = bridge._consentAllows();
  assert.equal(allowed, false);
  assert.equal(stopped, true, 'the device must stop being read');
  assert.deepEqual(lost, [1], 'and the host is notified');
});

test('CONSENT: a source that throws on stop() does not break the gate', () => {
  const src = {
    _active: true,
    capabilities: { continuous: false, direct: true, targets: false, twoAxis: false },
    onFocus: null, onSelect: null, onCancel: null,
    async start() {}, stop() { throw new Error('device is wedged'); },
  };
  const gate = fakeGate(true);
  const dwell = new DwellEngine({ dwellMs: 300 });
  const bridge = new SignalBridge({ source: src, dwell, consent: gate });
  bridge._consentWasGranted = true;
  gate.withdraw();
  assert.doesNotThrow(() => bridge._consentAllows(),
    'a wedged device must not take the consent check down with it');
});

// -- switch behaviour -------------------------------------------------------

/** A fake DOM root for switch tests: N targets, no real elements needed. */
function fakeRoot(ids) {
  return {
    querySelectorAll: () => ids.map((id) => ({
      getAttribute: (k) => (k === 'data-dwell-target' ? id : null),
    })),
  };
}

test('SWITCH: the scan pauses after a selection', () => {
  // A scan that keeps running through a selection means the next press lands
  // on a target the user never saw highlighted.
  const selects = [];
  const src = new SwitchSource({ keys: [' '], autoScan: true, scanMs: 50, debounceMs: 0, accidentalPressMs: 0, now: () => 1000 });
  src.attach(fakeRoot(['a', 'b', 'c']));
  src.onSelect = (id) => selects.push(id);
  src._active = true;

  src.press(0);      // index -1 → first press advances to 'a'
  src.press(10);     // selects 'a'
  assert.deepEqual(selects, ['a']);
  assert.equal(src.scanning, false, 'scan must stop after a selection');
  assert.equal(src._scanPaused, true);
});

test('SWITCH: a press while paused resumes rather than selecting again', () => {
  const selects = [];
  // autoScan OFF for this test: we are testing the press semantics, and a
  // live interval would keep the process alive past the assertions.
  const src = new SwitchSource({ keys: [' '], autoScan: true, scanMs: 50, debounceMs: 0, accidentalPressMs: 0, now: () => 1000 });
  src.attach(fakeRoot(['a', 'b']));
  src.onSelect = (id) => selects.push(id);
  src._active = true;
  src._scanPaused = true; // simulate a scan that stopped after a selection
  src.press(0);           // a press while paused must RESUME, not select
  assert.equal(selects.length, 0, 'resume must not select');
  assert.equal(src._scanPaused, false, 'the press resumed the scan');
  src.stop();
});

test('SWITCH: presses are debounced (bounce produces one action)', () => {
  const src = new SwitchSource({ keys: [' '], debounceMs: 50, accidentalPressMs: 0, now: () => 1000 });
  src.attach(fakeRoot(['a', 'b', 'c']));
  src._active = true;
  src.press(0);    // advances to 'a'
  src.press(10);   // 10ms later — bounce, ignored
  src.press(20);   // still bouncing, ignored
  assert.equal(src._index, 0, 'bounce must not advance the scan');
});

test('SWITCH: a press right after a selection is treated as accidental', () => {
  const selects = [];
  const src = new SwitchSource({ keys: [' '], debounceMs: 0, accidentalPressMs: 400, now: () => 1000 });
  src.attach(fakeRoot(['a', 'b', 'c']));
  src.onSelect = (id) => selects.push(id);
  src._active = true;
  src.press(0);     // advance to 'a'
  src.press(10);    // select 'a'
  assert.equal(selects.length, 1);
  src.press(50);    // 40ms later — inside the accidental window
  assert.equal(selects.length, 1, 'accidental double-press must not select');
  assert.equal(src._index, 0, 'and must not advance either');
});

test('SWITCH: reverse scanning is supported', () => {
  const focus = [];
  const src = new SwitchSource({ reverse: true, now: () => 1000 });
  src.attach(fakeRoot(['a', 'b', 'c']));
  src.onFocus = (id) => focus.push(id);
  src._active = true;
  src._index = 2;
  src._advance(0);
  assert.equal(focus[0], 'b', 'reverse scan goes backwards');
});

test('SWITCH: maxCycles stops the scan after the configured passes', () => {
  const src = new SwitchSource({ autoScan: true, scanMs: 50, maxCycles: 2, now: () => 1000 });
  src.attach(fakeRoot(['a', 'b']));
  src._active = true;
  src._startTimer(50);
  // Two full passes of 2 items each = 4 advances to reach the cap.
  for (let i = 0; i < 5; i++) src._advance(i);
  assert.equal(src.scanning, false, 'scan must stop at the cycle cap');
});

test('SWITCH: row-column groups targets into rows by position', () => {
  // Three rows of three. The grouping is by vertical centre, so markup does
  // not need to declare rows — layout decides them.
  const rows = [
    [0, 0], [1, 0], [2, 0],       // row 0: same y
    [0, 1], [1, 1], [2, 1],       // row 1
    [0, 2], [1, 2], [2, 2],       // row 2
  ];
  const els = rows.map(([x, y], i) => ({
    getAttribute: () => `t${i}`,
    getBoundingClientRect: () => ({ top: y * 100, height: 40, left: x * 100 }),
  }));
  const src = new SwitchSource({ scanPattern: 'row-column', now: () => 1000 });
  src.attach({ querySelectorAll: () => els });
  const grouped = src._rows();
  assert.equal(grouped.length, 3, 'three visual rows expected');
  assert.equal(grouped[0].length, 3, 'each row holds three items');
});

test('SWITCH: row-column degrades to linear with a single row', () => {
  const els = [0, 1, 2].map((i) => ({
    getAttribute: () => `t${i}`,
    getBoundingClientRect: () => ({ top: 0, height: 40, left: i * 100 }),
  }));
  const focus = [];
  const src = new SwitchSource({ scanPattern: 'row-column', now: () => 1000 });
  src.attach({ querySelectorAll: () => els });
  src.onFocus = (id) => focus.push(id);
  src._active = true;
  src._advance(0); src._advance(1); src._advance(2);
  assert.deepEqual(focus, ['t0', 't1', 't2'], 'single row scans linearly');
});

test('SWITCH: row-column press chooses a row, then an item', () => {
  // Two rows of two.
  const rows = [[0, 0], [1, 0], [0, 1], [1, 1]];
  const els = rows.map(([x, y], i) => ({
    getAttribute: () => `t${i}`,
    getBoundingClientRect: () => ({ top: y * 100, height: 40, left: x * 100 }),
  }));
  const selects = [];
  const src = new SwitchSource({ scanPattern: 'row-column', debounceMs: 0, accidentalPressMs: 0, now: () => 1000 });
  src.attach({ querySelectorAll: () => els });
  src.onSelect = (id) => selects.push(id);
  src._active = true;

  src._advance(0);              // row phase → row 0
  assert.equal(src._phase, 'row');
  src.press(10);                // press chooses row 0 → item phase
  assert.equal(src._phase, 'item', 'press in row phase selects the ROW');
  assert.equal(selects.length, 0, 'no item selected yet');
  src.press(200);               // press in item phase selects the item
  assert.equal(selects.length, 1);
  assert.equal(src._phase, 'row', 'returns to row phase after a selection');
});

test('SWITCH: pauseScan and resumeScan control the timer', () => {
  const states = [];
  const src = new SwitchSource({ autoScan: true, scanMs: 50, now: () => 1000, onScanState: (r) => states.push(r) });
  src.attach(fakeRoot(['a', 'b']));
  src._active = true;
  src._startTimer(50);
  assert.equal(src.scanning, true);
  src.pauseScan();
  assert.equal(src.scanning, false, 'paused: the timer is released');
  // resumeScan re-arms only while the source is active and autoScan is on.
  src.resumeScan();
  assert.equal(src.scanning, true);
  src.stop();
  assert.equal(src.scanning, false, 'stop releases the timer');
  assert.deepEqual(states, [false, true]);
});
