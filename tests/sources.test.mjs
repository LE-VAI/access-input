/**
 * sources.test.mjs — source capabilities + bridge wiring.
 *
 * The load-bearing rule: a CONTINUOUS source dwells, a DIRECT source does
 * not. Getting that wrong means either a switch user has to hold a press for
 * a second (nonsense — the press already happened) or a gaze user's
 * activations fire on every pass-over.
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

test('ExternalSource declares continuous + direct capabilities', () => {
  const src = new ExternalSource();
  assert.equal(src.capabilities.continuous, true);
  assert.equal(src.capabilities.direct, true);
});

test('a continuous-only source drives dwell; its select is not used', () => {
  const events = [];
  const src = new ExternalSource();
  const dwell = new DwellEngine({ dwellMs: 1000 });
  new SignalBridge({
    source: src,
    dwell,
    mode: 'dwell', // a gaze tracker: position only, no select of its own
    onActivate: (id, meta) => events.push({ id, via: meta.via }),
  });
  src.start();
  src.focus('w3', 0);
  assert.equal(dwell.target, 'w3', 'a continuous source must start a dwell');
  dwell.hold(1200);
  assert.equal(events.length, 1);
  assert.equal(events[0].via, 'dwell');
});

test('a direct source activates on select without dwelling', () => {
  const events = [];
  const src = new SwitchSource({ keys: [' '] });
  const dwell = new DwellEngine({ dwellMs: 1000 });
  const bridge = new SignalBridge({
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
  // A direct-capable source reports focus as telemetry without dwelling, so
  // start a dwell explicitly to prove stop() clears it.
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
  // An external device naming its target AND selecting: the select is the
  // choice, the focus is just telemetry. No dwell must start.
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
  dwell.hold(400);
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
