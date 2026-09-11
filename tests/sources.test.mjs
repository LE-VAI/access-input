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
