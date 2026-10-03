/**
 * persist.test.mjs — opt-in calibration persistence.
 *
 * A calibrated dwell is worth keeping: a person whose duration settled at
 * 820ms should not be dropped back to 600ms on every reload and re-earn it
 * through a string of undos. But storage is also where trust is easiest to
 * lose, so the contract is mostly about what the engine REFUSES to do:
 *   - touch storage at all unless the host passed `persist`
 *   - trust what it reads (validate, then clamp to the engine's bounds)
 *   - break when storage is absent, full, or throwing
 *   - write when it only read
 *
 * Every test injects its own storage, so nothing here reads or writes a real
 * localStorage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DwellEngine } from '../src/dwell.js';

const KEY = 'test:dwell';

/** An in-memory Storage that records every call, so "no writes" is checkable. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    data,
    getItem(k) { calls.push(['getItem', k]); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { calls.push(['setItem', k, v]); data.set(k, String(v)); },
    removeItem(k) { calls.push(['removeItem', k]); data.delete(k); },
    writes() { return calls.filter(([m]) => m !== 'getItem'); },
  };
}

/** Storage whose every method throws — a sandboxed iframe, blocked site data. */
function throwingStorage() {
  const boom = () => { throw new Error('SecurityError: storage is disabled'); };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

function advance(engine, fromMs, toMs, step = 16) {
  for (let t = fromMs; t <= toMs; t += step) engine.hold(t);
  if ((toMs - fromMs) % step !== 0) engine.hold(toMs);
}

/** Drive a real lengthening correction: completed dwells, then undos. */
function lengthen(engine) {
  for (let i = 0; i < 4; i++) {
    const t = i * 2000;
    engine.enter(`w${i}`, t);
    advance(engine, t, t + engine.dwellMs + 100);
    engine.leave(t + engine.dwellMs + 100);
    engine.tick(t + engine.dwellMs + 300);
  }
  engine.reportUndo();
  engine.reportUndo();
  engine.reportUndo();
}

const stored = (storage) => JSON.parse(storage.data.get(KEY));

// -- round trip ---------------------------------------------------------------

test('ROUND TRIP: an adapted duration is restored by the next engine', () => {
  const storage = memoryStorage();
  const first = new DwellEngine({ dwellMs: 600, lockOnMs: 0, graceMs: 10, persist: KEY, storage });
  lengthen(first);
  assert.ok(first.dwellMs > 600, 'the engine really adapted');

  const record = stored(storage);
  assert.deepEqual(Object.keys(record).sort(), ['dwellMs', 'v'],
    'only the duration and a schema version are stored');
  assert.equal(record.v, 1);
  assert.equal(record.dwellMs, Math.round(first.dwellMs));

  const second = new DwellEngine({ dwellMs: 600, persist: KEY, storage });
  assert.equal(second.dwellMs, Math.round(first.dwellMs), 'the reload keeps the calibration');
});

test('ROUND TRIP: an explicit setDwell choice is stored', () => {
  const storage = memoryStorage();
  const engine = new DwellEngine({ persist: KEY, storage });
  engine.setDwell(900);
  assert.equal(stored(storage).dwellMs, 900);
  assert.equal(new DwellEngine({ persist: KEY, storage }).dwellMs, 900);
});

test('ROUND TRIP: loading only reads — it never writes', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ v: 1, dwellMs: 820 }) });
  const engine = new DwellEngine({ persist: KEY, storage });
  assert.equal(engine.dwellMs, 820);
  assert.deepEqual(storage.writes(), [], 'an engine that only read leaves storage as it found it');
});

test('ROUND TRIP: restoring keeps the adaptive bounds the host configured', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ v: 1, dwellMs: 820 }) });
  const engine = new DwellEngine({ minDwellMs: 400, maxDwellMs: 1200, persist: KEY, storage });
  assert.equal(engine.minDwellMs, 400);
  assert.equal(engine.maxDwellMs, 1200);
});

// -- trust: clamp and validate ------------------------------------------------

test('CLAMP: a stored value below the floor is raised to it', () => {
  // A 20ms dwell is a stream of activations the user never made. Whatever is
  // in storage — tampered, corrupted, left by an older build — must not be
  // able to produce one.
  const storage = memoryStorage({ [KEY]: JSON.stringify({ v: 1, dwellMs: 20 }) });
  const engine = new DwellEngine({ minDwellMs: 300, maxDwellMs: 1500, persist: KEY, storage });
  assert.equal(engine.dwellMs, 300);
});

test('CLAMP: a stored value above the ceiling is lowered to it', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ v: 1, dwellMs: 60_000 }) });
  const engine = new DwellEngine({ minDwellMs: 300, maxDwellMs: 1500, persist: KEY, storage });
  assert.equal(engine.dwellMs, 1500);
});

test('CORRUPT: anything that is not a valid record is ignored', () => {
  const cases = [
    'not json at all',
    '{"v":1,"dwellMs":',              // truncated write
    'null',
    '42',
    '"820"',
    '[820]',
    JSON.stringify({ dwellMs: 820 }), // no version
    JSON.stringify({ v: 2, dwellMs: 820 }), // a future schema
    JSON.stringify({ v: '1', dwellMs: 820 }),
    JSON.stringify({ v: 1, dwellMs: '820' }),
    JSON.stringify({ v: 1, dwellMs: -5 }),
    JSON.stringify({ v: 1, dwellMs: 0 }),
    JSON.stringify({ v: 1, dwellMs: null }),
    JSON.stringify({ v: 1 }),
    '{"v":1,"dwellMs":1e999}',        // parses to Infinity
  ];
  for (const raw of cases) {
    const storage = memoryStorage({ [KEY]: raw });
    let engine;
    assert.doesNotThrow(() => { engine = new DwellEngine({ dwellMs: 640, persist: KEY, storage }); },
      `must not throw on ${raw}`);
    assert.equal(engine.dwellMs, 640, `must start from the configured value for ${raw}`);
    assert.deepEqual(storage.writes(), [], `and must not touch storage for ${raw}`);
  }
});

// -- absent and hostile storage -------------------------------------------------

test('ABSENT: storage: null makes persistence a quiet no-op', () => {
  const engine = new DwellEngine({ dwellMs: 600, lockOnMs: 0, graceMs: 10, persist: KEY, storage: null });
  assert.doesNotThrow(() => lengthen(engine));
  assert.doesNotThrow(() => engine.setDwell(700));
  assert.doesNotThrow(() => engine.resetCalibration());
  assert.equal(engine.dwellMs, 600);
});

test('ABSENT: no localStorage in the environment is not an error', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
  try {
    const engine = new DwellEngine({ dwellMs: 600, persist: KEY });
    assert.doesNotThrow(() => engine.setDwell(700));
    assert.equal(engine.dwellMs, 700, 'the session works; it just is not remembered');
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete globalThis.localStorage;
  }
});

test('THROWING: merely looking up localStorage may throw, and must be survived', () => {
  // In a sandboxed iframe or with site data blocked, READING the
  // `localStorage` property throws a SecurityError before any method is
  // called.
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    get() { throw new Error('SecurityError: access denied'); },
    configurable: true,
  });
  try {
    let engine;
    assert.doesNotThrow(() => { engine = new DwellEngine({ dwellMs: 600, persist: KEY }); });
    assert.doesNotThrow(() => engine.setDwell(700));
    assert.doesNotThrow(() => engine.resetCalibration());
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete globalThis.localStorage;
  }
});

test('THROWING: a storage whose every method throws cannot break the engine', () => {
  let engine;
  assert.doesNotThrow(() => {
    engine = new DwellEngine({ dwellMs: 600, lockOnMs: 0, graceMs: 10, persist: KEY,
      storage: throwingStorage() });
  });
  assert.equal(engine.dwellMs, 600);
  assert.doesNotThrow(() => lengthen(engine), 'adaptation still runs when the save fails');
  assert.ok(engine.dwellMs > 600, 'and still adapts');
  assert.doesNotThrow(() => engine.setDwell(800));
  assert.doesNotThrow(() => engine.resetCalibration());
});

test('THROWING: a full storage (quota exceeded) does not stop adaptation', () => {
  const storage = memoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const engine = new DwellEngine({ dwellMs: 600, lockOnMs: 0, graceMs: 10, persist: KEY, storage });
  assert.doesNotThrow(() => lengthen(engine));
  assert.ok(engine.dwellMs > 600);
});

// -- no writes without `persist` -----------------------------------------------

test('OFF BY DEFAULT: without persist, storage is never touched — not even read', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ v: 1, dwellMs: 900 }) });
  const engine = new DwellEngine({ dwellMs: 600, lockOnMs: 0, graceMs: 10, storage });
  assert.equal(engine.dwellMs, 600, 'a stored value is not applied without a key');
  lengthen(engine);
  engine.setDwell(750);
  engine.resetCalibration();
  assert.deepEqual(storage.calls, [], 'zero calls of any kind');
});

test('OFF BY DEFAULT: an empty or non-string persist key counts as off', () => {
  for (const persist of ['', 0, true, {}, null]) {
    const storage = memoryStorage();
    const engine = new DwellEngine({ persist, storage });
    engine.setDwell(700);
    assert.deepEqual(storage.calls, [], `persist: ${JSON.stringify(persist)} must not write`);
  }
});

test('OFF BY DEFAULT: without persist, a real localStorage is never looked up', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let touched = 0;
  Object.defineProperty(globalThis, 'localStorage', {
    get() { touched++; return memoryStorage(); },
    configurable: true,
  });
  try {
    const engine = new DwellEngine({ dwellMs: 600 });
    engine.setDwell(700);
    engine.resetCalibration();
    assert.equal(touched, 0);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete globalThis.localStorage;
  }
});

// -- resetCalibration ------------------------------------------------------------

test('RESET: clears the stored record and restores the configured duration and bounds', () => {
  const storage = memoryStorage();
  const engine = new DwellEngine({ dwellMs: 600, minDwellMs: 300, maxDwellMs: 1500,
    persist: KEY, storage });
  engine.setDwell(1200);        // re-centres the bounds to 600..2400
  assert.equal(engine.maxDwellMs, 2400);
  assert.ok(storage.data.has(KEY));

  engine.resetCalibration();
  assert.equal(engine.dwellMs, 600);
  assert.equal(engine.minDwellMs, 300);
  assert.equal(engine.maxDwellMs, 1500);
  assert.equal(storage.data.has(KEY), false, 'the device no longer holds it');
  assert.equal(new DwellEngine({ dwellMs: 600, persist: KEY, storage }).dwellMs, 600,
    'and the next engine starts fresh');
});

test('RESET: returns to the CONFIGURED value, not to the restored one', () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ v: 1, dwellMs: 1100 }) });
  const engine = new DwellEngine({ dwellMs: 650, persist: KEY, storage });
  assert.equal(engine.dwellMs, 1100);
  engine.resetCalibration();
  assert.equal(engine.dwellMs, 650);
});

test('RESET: clears adaptive history so old outcomes cannot pull it straight back', () => {
  const engine = new DwellEngine({ dwellMs: 600, lockOnMs: 0, graceMs: 10 });
  lengthen(engine);
  engine.resetCalibration();
  assert.equal(engine.stats.windowSize, 0);
  assert.equal(engine.stats.lastDirection, 0);
  assert.equal(engine.dwellMs, 600);
});

test('RESET: does not re-arm a target that already fired (same rule as setDwell)', () => {
  const engine = new DwellEngine({ dwellMs: 400, lockOnMs: 0 });
  engine.enter('vol', 0);
  advance(engine, 0, 500);
  assert.equal(engine.isSpent('vol'), true);
  engine.resetCalibration();
  assert.equal(engine.isSpent('vol'), true, 'a settings action must not re-arm a held target');
  advance(engine, 500, 1500);
  assert.equal(engine.stats.totalActivations, 1, 'one landing is still one activation');
});

test('RESET: works without persist, and never writes', () => {
  const storage = memoryStorage();
  const engine = new DwellEngine({ dwellMs: 600, storage });
  engine.setDwell(900);
  engine.resetCalibration();
  assert.equal(engine.dwellMs, 600);
  assert.deepEqual(storage.calls, []);
});
