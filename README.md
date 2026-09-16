# access-input

**The input-abstraction layer for assistive access.** Switch, gaze, EMG, head-pointer, keyboard — and one day EEG — all reduce to the same three events. This package is the seam between whatever signal a person can produce and whatever interface they need to drive.

Zero dependencies. MIT. Runs in the browser, testable in Node.

**[Dwell & scan →](https://le-vai.github.io/access-input/demo/)** · **[Read-along integration →](https://le-vai.github.io/access-input/demo/read-along.html)** · **[Consent-gated full stack →](https://le-vai.github.io/access-input/demo/stack.html)** · **[Biosignal pipeline →](https://le-vai.github.io/access-input/demo/analog.html)**

*(The second demo is the whole point of this package: a person using a switch, gaze tracker, or EMG channel drives a real [`<read-along>`](https://github.com/LE-VAI/read-along) element. Rest on a word and the reading starts there. Neither library knows the other's internals — they compose through the published APIs.)*

https://raw.githubusercontent.com/LE-VAI/access-input/main/docs/assets/demo-readalong.mp4

*(33s — the amber dwell fill is the access layer; the blue karaoke highlight is the reading layer. Both running at once.)*

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
- **Clock-gap guard.** If the host stops ticking (a hidden tab, machine sleep, a stalled device stream), the gap is NOT counted as dwell progress — the attempt is abandoned. Without this, resting on a word, switching tabs for ten seconds, and returning fires an activation the user never made.

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
| `SwitchSource` | direct | One binary switch on any key, optional auto-scan, linear or row-column scanning. |
| `ExternalSource` | continuous + direct | **The escape hatch.** Any device that can reach the page drives the host by calling `focus()`, `select()`, `cancel()`. |

Switch scanning follows the AAC platform consensus: the scan **pauses after a selection** (so the next press is deliberate), presses are debounced against bounce and accidental double-press, the first item gets an orientation delay, and `scanPattern: 'row-column'` is available for grids — grouping targets into rows by *layout*, with no markup required to declare them.

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

## TypeScript

Ships hand-written types — no build step, no generated `dist/`. A custom element's public surface is a deliberate API, and types generated from source freeze implementation details (private fields, internal helper shapes) into a published contract that then cannot change without a breaking version.

```ts
import { DwellEngine, type CalibrationResult } from 'access-input';

const dwell = new DwellEngine({ dwellMs: 600, leaveToRearm: true });
dwell.setRepeatTargets({ 'volume-up': 400 });   // per-target rate is typed

const r: CalibrationResult = detector.calibrate(baseline, sigma, peak);
if (!r.ok) show(r.detail);   // `reason`/`detail` exist only on the failure branch
```

Verified by consuming them in a strict-mode project: correct usage compiles, and deliberate misuse (wrong option type, typo'd option name, missing argument, unknown property, malformed capability object) is caught.

## The full stack, running

[demo/stack.html](demo/stack.html) wires all three libraries together with nothing but their published CDNs — no build step, no shared internals:

```
neural-consent   decides whether the signal may be read
      ↓
access-input     turns the signal into a selection (dwell / scan / keys / external device)
      ↓
read-along       reads from the chosen word, and reports the position back
```

The gate is enforced by the input layer, so it bites in the right place: while consent is withheld the surface is visibly inert and dwelling on a word does nothing; grant it and the same gesture reads from that word; withdraw it mid-dwell and the activation in flight is cancelled.

Verified in a real browser: blocked (`0` activations), granted (`1` activation, the reader seeked to the chosen token), and mid-dwell withdrawal (`0` activations where `1` was expected).

## Analog biosignal input (EMG, sip-and-puff)

An analog sensor produces a *continuous* signal, not presses. `AnalogSwitchSource` derives them — rectify, envelope, adaptive threshold, activation state machine — and then behaves exactly like `SwitchSource`, so `SignalBridge` and everything downstream need no changes.

```js
import { AnalogSwitchSource, GamepadTransport } from 'access-input/analog-source.js';

const source = new AnalogSwitchSource({
  transport: new GamepadTransport({ mode: 'analog', axisIndex: 0 }),
});
await source.start();

// Calibrate, then adopt — or refuse a signal that cannot support thresholds.
const rest = await capture(300);
const effort = [await captureBurst(), await captureBurst(), await captureBurst()];
const result = source.calibrate(rest, effort);
if (!result.ok) showMessage(result.detail);   // "signal-too-weak" explains why
```

### The transport order is research-driven, and not what you would guess

**Gamepad first.** Origin Instruments' Breeze sip-and-puff switch has a documented "Joystick Plus" mode that publishes **raw analog pressure as a standard HID joystick axis** — sip negative, puff positive, ±4 kPa at the extremes. So the browser reads real sip-and-puff pressure from a shipping commercial device with no driver, no protocol and no chooser UI. The Xbox Adaptive Controller and Hori Flex arrive through the same path.

**Keyboard is already covered.** Most commercial USB switch interfaces (AbleNet Hitch 2, Blue2 FT, Origin Swifty in keyboard mode) present as HID keyboards emitting Enter or Space — so `KeyboardSource` handles them with no new code. Documented rather than rebuilt.

**Web Serial is the maker path.** No assistive switch vendor publishes a serial protocol (that set is empty), and no consumer EMG device in 2026 is browser-reachable with documented protocol. So `SerialTransport` defines a minimal one instead of pretending to adopt one: newline-delimited JSON, `{"t":ms,"v":value}`, with an optional `{"dev":…,"fs":hz}` hello.

### What the detector refuses to do

**It never lowers thresholds into the noise floor.** A user whose strongest effort cannot clear the noise floor is told so, with a reason — because the alternative produces activations they did not make, which the 2025 EMG-switch usability trial found to be the dominant complaint. The failure path is a first-class result, not an error to work around.

### Evidenced constants vs judgement calls

The code distinguishes them, and so does this README:

| Constant | Value | Basis |
|---|---|---|
| Onset criterion | amplitude above baseline | Collins 2020 (n=60) |
| Baseline multiplier | 3σ | Collins used 2σ; raised deliberately, because a false activation costs more than a miss here |
| Envelope cutoff | 5 Hz | conventional linear-envelope band is 5–10 Hz |
| Raw EMG band-pass | 20–450 Hz | SENIAM; Noraxon puts the high cut at 400–500 Hz |
| Spike conditioning | TKEO optional | Solnik 2010: onset error 13 ms vs 98 ms |
| Adaptive threshold | dual-threshold with slow creep | OpenBCI's model; the implementable state of the art |
| **Min activation 150 ms** | **judgement** | No AT-specific published value exists. The 50 ms figure that looks like a candidate is a clinical *burst-duration* floor, and healthy controls routinely breach it — so 150 ms is deliberately well above it. |
| **Release 100 ms, refractory 300 ms** | **judgement** | Same; expose and tune per user. |

All of them live in an exported `ANALOG_DEFAULTS` object so a clinician can tune without forking.

### What this is not

Not a medical device. Not for diagnosis, therapy, or any application where a missed or spurious activation could cause harm. It reads **muscle electrical activity or air pressure** — an indirect, noisy proxy for intent — and it is not a brain interface, so do not call it one. Both false activations and missed activations will occur; that is the nature of the signal, not a defect to be hidden. A switch assessment led by an occupational therapist or AAC clinician is the correct process, and this library is not a substitute for it.

## Consent gating (optional)

Reading a signal IS the processing act, so that is where consent has to bite. `SignalBridge` accepts an optional gate — duck-typed, because this package has zero dependencies, so it is an interface rather than an import:

```js
import { ConsentManager, PURPOSES } from 'neural-consent';

const consent = new ConsentManager({ storage: localStorage });
new SignalBridge({
  source, dwell,
  consent,                                   // anything with isGranted(id)
  consentPurpose: PURPOSES.ACQUIRE_SIGNAL.id,
  onActivate: (id) => choose(id),
});
```

Four properties make this a gate rather than a warning:

- **Per-event, not per-session.** Consent can be withdrawn while the tool runs, so the check runs on every focus, select, and activation. A withdrawal cancels any dwell already in progress.
- **Fails closed.** A gate that throws, or that lacks `isGranted`, means *no consent*. A broken gate must never be a permissive one.
- **Cancel is never gated.** A user backing out must always work — including when consent itself is what they are backing out of.
- **The clock must be shared.** If a source reports its own timestamps, inject the same clock the heartbeats use, or the engine's stall guard will read the mismatch as a gap. `rebaseline(t)` exists for switching clocks mid-session.

## The read-along integration

The adapter drives a real `<read-along>` element with any source — the composition the whole package exists to make possible:

```js
import { ReadAlongInputHost } from 'access-input/read-along.js';
import { SwitchSource, tagWords } from 'access-input';

// Tag the words first...
tagWords(document.querySelector('read-along'));
// ...then let read-along rebuild its highlight ranges against the new nodes.
// (It caches ranges from the text nodes present at prepare time; wrapping
// replaces those nodes, so a re-prepare keeps the karaoke highlight aligned.)
el._prepared = false;
el._prepare();

const host = new ReadAlongInputHost(el, {
  source: new SwitchSource({ keys: [' '], autoScan: true }),
});
await host.start();
```

An activation becomes a word-level seek; read-along's `activeToken` reports the reading position back, so a gaze or EEG layer can use it as feedback. Two independently published libraries, no shared internals.

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
  .setDwell(ms)           // authoritative user choice (WCAG 2.2.1)
  .pause() / .resume()    // global kill switch (all platforms ship one)
  .setRepeatTargets(ids)  // opt targets into timed auto-repeat (additive)
  .clearRepeatTargets(ids)      // remove specific registrations
  .repeatIntervalFor(id)        // the interval a target will use
  // Per-target rates, because controls differ:
  //   setRepeatTargets({ 'volume-up': 400 })  // 400ms, others keep the default
  // Registration is ADDITIVE, so targets can be added as a UI builds.
  .reportUndo()           // host: the user undid the last activation
  .isSpent(id)            // has this target fired and not yet been re-armed?
  .phase                  // 'idle' | 'lockon' | 'dwell' | 'spent'
  .stats                  // { dwellMs, lockOnMs, activations, undos, abandons, spent }
```

**Use `setDwell()` for user-facing controls, not a bare assignment.** An explicit choice re-centres the adaptive bounds around the chosen value (half to double) and resets the adaptation counters, so the user's number is treated as a decision rather than a starting guess. WCAG 2.2.1 requires a timing value be adjustable over at least ten times the default — and that the adjustment actually hold.

Time is always supplied by the caller (`performance.now()` in a browser, an injected clock in tests) — the engine never reads a clock itself, so its behaviour is fully deterministic.

### words

```js
splitWords(text)        // [{ text, start, end, index }]
tagWords(el, opts)      // wrap words as dwell targets; returns the word list
untagWords(el)          // restore the original DOM
```

## License

MIT.
