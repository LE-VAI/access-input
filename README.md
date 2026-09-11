# access-input

**The input-abstraction layer for assistive access.** Switch, gaze, EMG, head-pointer, keyboard — and one day EEG — all reduce to the same three events. This package is the seam between whatever signal a person can produce and whatever interface they need to drive.

Zero dependencies. MIT. Runs in the browser, testable in Node.

**[Try the live demo →](https://le-vai.github.io/access-input/demo/)**

https://raw.githubusercontent.com/LE-VAI/access-input/main/docs/assets/demo.mp4

*(53s — dwell activation on a reading surface, then single-switch scanning and keyboard access on the same interface. [Download the MP4](docs/assets/demo.mp4) if it doesn't play inline.)*

```bash
npm install access-input
```

```js
import { DwellEngine, SignalBridge, SwitchSource } from 'access-input';

const dwell = new DwellEngine({ dwellMs: 600 });
const source = new SwitchSource({ keys: [' '], autoScan: true });
new SignalBridge({ source, dwell, mode: 'direct', onActivate: (id) => choose(id) });
```

## Why this exists

Every access method that replaces a mouse click reduces to three events:

| Event | Meaning | Produced by |
|---|---|---|
| **FOCUS** | "the pointer is on target X" | gaze position, head-pointer, mouse, a scan highlight |
| **SELECT** | "the user chose X" | a switch press, a sip-puff, a dwell completing, a blink |
| **CANCEL** | "the user backed out" | an escape gesture, an undo |

An app built against those three events works for **every** access method without knowing which one is in use. That is the whole idea.

It matters because the assistive-input ecosystem is a graveyard of single-purpose apps: a scanning keyboard that only accepts switches, a gaze app that only accepts one tracker. Each re-implements the same plumbing, and none can accept a new input without a rewrite. This layer is the missing seam.

## The dwell problem, and what this does about it

For someone using a switch, a gaze tracker, or an EMG channel, "click" does not exist. The universal substitute is **dwell**: rest on a target and it activates. Almost every implementation ships a *fixed* duration, and a fixed duration is always wrong for someone — too long and every selection costs seconds of held effort until fatigue wins; too short and tremor or gaze jitter fires activations the user did not intend, which is worse, because it destroys trust in the interface.

`DwellEngine` starts from a calibrated value and adapts from two honest behavioural signals that **the host reports**, because only the host knows what "undo" means in its own UI:

- **Abandoned attempts** — the user began dwelling and left before completion. Repeated abandonment means the duration is too long.
- **Undone activations** — the host reports the user immediately reversed an activation. That means it was too short.

The corrections are deliberately asymmetric: lengthening is applied harder (a wrong activation is more damaging than a slow one), and shortening needs more evidence (abandonment can just mean the user changed their mind). The engine never infers intent from raw signal noise — it counts outcomes the host labels.

Two details that make it usable rather than merely correct:

- **Grace window.** A brief slip off-target (gaze jitter, a tremor, one dropped EMG frame) does not restart the dwell — progress resumes. Restarting on every slip makes an interface punishing.
- **Sweep rejection.** A signal merely passing across a target is normal for gaze and is not counted as a failed attempt, so it cannot skew the adaptation.

## Making content addressable

An input layer is only useful if there is a target to land on. Screen readers have the accessibility tree; a dwell engine has nothing unless the words are individually addressable. `tagWords` turns a block of prose into addressable words **without changing how it looks or reads**:

```js
import { tagWords } from 'access-input/words.js';

tagWords(document.getElementById('article'));  // every word becomes a dwell target
```

It wraps each word in an inline `<span>` carrying `data-dwell-target`, and never alters, collapses, or re-orders the text. That property is load-bearing: a component that tokenizes the same content (`<read-along>` does) computes its offsets from `textContent`, so if wrapping changed a single character every highlight would land on the wrong word. The wrapping is purely additive — same characters, same order, more nodes.

`splitWords(text)` gives you the word records with source offsets if you want to build targets yourself, and `untagWords(el)` restores the original DOM.

## Sources

| Source | Capabilities | Notes |
|---|---|---|
| `PointerSource` | continuous | Mouse/touch. The access method everyone already has, so it is also the fallback. |
| `KeyboardSource` | direct | Arrows/Tab to move, Enter to select. |
| `SwitchSource` | direct | One binary switch on any key, optional auto-scan. |
| `ExternalSource` | continuous + direct | **The escape hatch.** Any device that can reach the page drives the host by calling `focus()`, `select()`, `cancel()`. |

`SignalBridge` wires a source to a `DwellEngine` and your handler. The one rule that matters: a **continuous** source dwells (position → dwell → activate); a **direct** source does not (its select already happened). Dwelling on a switch press would be nonsense. A host that knows its actual device can override with `mode: 'dwell' | 'direct'`, because the host knows the hardware and the class only knows the category.

## Why `ExternalSource` is the whole BCI story

The thesis behind this package is that **the BCI software layer is accessibility software**, and that the useful thing to build is the timing/sync/input substrate rather than electrodes. `ExternalSource` is that claim made concrete: an EEG pipeline that can decide "focus" and "select" plugs in here **unchanged**, with no EEG-specific code in this package at all. The same is true of a BLE switch, a serial sip-puff sensor, or an eye-gaze bridge.

That design is not an accident of laziness — it is what the 2026 landscape forces:

- **BrainFlow has no browser binding.** Its JS package is Node-only FFI (`koffi`) and was ~9 months behind core as of Sep 2026. It is the best *native* EEG library and a dead end in a browser.
- **Web Bluetooth is permanently Chromium-only** (Firefox WONTFIX, Safari no-plan). Web Serial is better — Chrome/Edge/Opera and Firefox 151+ (May 2026) — but still not Safari.
- **The input-side ecosystem is mostly abandoned.** WebGazer.js ended official maintenance Feb 2026 with no successor found; the small JS switch-scan engines last saw commits in 2016–17. The live web options (Asterics AAC, Cboard) are AGPL/GPL, which cannot be embedded in a permissive substrate.

So the durable contribution is the layer that outlives any particular device.

## read-along adapter

`ReadAlongInputHost` drives a [`<read-along>`](https://github.com/LE-VAI/read-along) element with any source. It tags each word as a dwell target and routes activations to word-level seek, so "rest on a word" reads from there — the gesture a pointer user gets from clicking, expressed in whatever signal the person actually has.

```js
import { ReadAlongInputHost } from 'access-input/read-along.js';
import { SwitchSource } from 'access-input/sources.js';

const host = new ReadAlongInputHost(document.querySelector('read-along'), {
  source: new SwitchSource({ keys: [' '], autoScan: true }),
});
await host.start();
```

## Demo

```bash
python -m http.server 8795
# open http://127.0.0.1:8795/demo/
```

The demo switches live between pointer-dwell, single-switch auto-scan, and keyboard, over both a reading surface and a plain four-cell grid — to show the input layer does not care what the content is. Watch the amber ring fill as you rest on a word: that fill is the dwell, and the word activates when it completes.

## Tests

```bash
npm test
```

31 tests, zero dependencies, `node:test`. The dwell engine takes an **injected clock** everywhere, so every timing assertion is about logic rather than wall-clock behaviour.

## API

```js
new DwellEngine({
  dwellMs,          // 600  — evidence-based default (Burnham 2025 meta-analysis)
  lockOnMs,         // 150  — entry gate; a glance shorter than this never dwells
  lockoutMs,        // 200  — min gap between two fires on the same target
  repeatIntervalMs, // 1000 — auto-repeat period for `repeat` targets
  minDwellMs, maxDwellMs,   // adaptive bounds (300 / 1500)
  graceMs,          // 140  — slip forgiveness
  adaptive,         // true
  leaveToRearm,     // true — a fired target must be LEFT before it can fire again
  onProgress, onActivate, onCancel, onAdapt, onPhase,
})
  .enter(targetId, tMs)   // signal arrived (or returned) on a target
  .hold(tMs)              // heartbeat while on target
  .leave(tMs)             // signal left; grace window begins
  .tick(tMs)              // host heartbeat to expire the grace window
  .cancel(reason)         // explicit cancel
  .pause() / .resume()    // global kill switch (all platforms ship one)
  .setRepeatTargets(ids)  // opt targets into timed auto-repeat
  .reportUndo()           // host: the user undid the last activation
  .isSpent(id)            // has this target fired and not yet been re-armed?
  .phase                  // 'idle' | 'lockon' | 'dwell' | 'spent'
  .stats                  // { dwellMs, lockOnMs, activations, undos, abandons, spent }
```

Time is always supplied by the caller (`performance.now()` in a browser, an injected clock in tests) — the engine never reads a clock itself, so its behaviour is fully deterministic.

### words

```js
splitWords(text)        // [{ text, start, end, index }]
tagWords(el, opts)      // wrap words as dwell targets; returns the word list
untagWords(el)          // restore the original DOM
```

## License

MIT.
