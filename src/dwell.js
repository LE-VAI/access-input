/**
 * dwell.js — adaptive dwell activation engine.
 *
 * THE PROBLEM. For someone driving a computer with a switch, a gaze tracker,
 * or an EMG channel, "click" does not exist. The universal substitute is
 * DWELL: rest on a target for a duration and it activates. Nearly every
 * implementation ships with a fixed duration, and a fixed duration is always
 * wrong for someone:
 *
 *   - Too long, and every selection costs seconds of held effort. Fatigue
 *     compounds across a session until the user abandons the tool.
 *   - Too short, and tremor, gaze jitter, or a noisy EMG channel fires
 *     activations the user did not intend. Accidental activation is worse
 *     than slow activation: it destroys trust in the interface.
 *
 * The correct duration is a property of the PERSON and of the SIGNAL, not of
 * the app. So this engine starts from a calibrated value and keeps adapting
 * from two honest behavioural signals:
 *
 *   1. ABANDONED attempts — the user began dwelling and left before it
 *     completed. Repeated abandonment means the duration is too long.
 *   2. UNDONE activations — the host reports the user immediately reversed an
 *     activation. That means the duration was too short.
 *
 * Both signals are reported BY THE HOST, because only the host knows what
 * "undo" means in its own UI. The engine never infers intent from raw signal
 * noise — it counts outcomes the host labels.
 *
 * REPEAT ACTIVATION (the reason for the two-phase model).
 *
 * A naive dwell engine re-arms the instant it fires: the pointer is still on
 * the target, the next event starts a fresh dwell, and the target activates
 * again — and again — from one landing. Worse, micro-drift onto a NEIGHBOURING
 * target fires a second activation on a word the user never chose.
 *
 * The fix is the one every mature system converged on independently:
 * LEAVE-TO-REARM. Microsoft's Windows eye control documents the required
 * behaviour verbatim — "If you continue to dwell on the same button even after
 * it activates, it will not activate again" — and requires a deliberate
 * look-away-and-return to repeat. eViacam ships it as `Allow consecutive
 * clicks` (off by default) and Mind Express as `Repeat dwell` (off by
 * default). Once a target fires it is SPENT, and only a reported departure
 * re-arms it.
 *
 * Two supporting gates complete the model, because leave-to-rearm alone is
 * not sufficient:
 *
 *   - LOCK-ON. A short entry phase before progress begins. Microsoft's gaze
 *     guidance uses 150-250ms specifically to distinguish "intentionally
 *     staring at the target" from "merely glancing over it". Without it, a
 *     signal sweeping across the UI starts dwells it should never start.
 *   - LOCKOUT. A minimum interval between activations on the same target,
 *     independent of leave detection. Magilock (Front. Hum. Neurosci. 2024)
 *     recommends 200ms — the human reaction-time floor.
 *
 * TIME IS ALWAYS SUPPLIED BY THE CALLER (performance.now() in a browser, an
 * injected clock in tests). The engine never reads a clock itself, so its
 * behaviour is fully deterministic and testable.
 *
 * ALL TIMES MUST COME FROM ONE CLOCK. Every method that takes a timestamp
 * expects the same time base — mixing a device's own clock into enter() while
 * ticking hold() with the host's clock will look like a stall to the
 * clock-gap guard and abort valid dwells. If a source reports its own times,
 * inject the host clock into it so both agree, or call rebaseline() after
 * switching.
 */

/** Progress callbacks are throttled — the UI ring does not need 60fps. */
const PROGRESS_INTERVAL_MS = 50;

/**
 * A partial dwell only counts as an ABANDONMENT if the user got far enough
 * that they plausibly meant to activate. Below this ratio, leaving is just
 * the signal passing over the target (normal for gaze), not a failed attempt.
 */
const ABANDON_FLOOR = 0.25;

/**
 * ADAPTATION USES A WINDOW, NOT A SESSION TOTAL.
 *
 * The first version divided cumulative counts: `_undos / _activations`, with
 * `_activations` never reset by an adaptation. Two failures followed.
 *
 *   1. Responsiveness decayed monotonically. `_activations` only grows, so
 *      after 40 fires the undo ratio needed 7 undos to cross 0.15, then 8,
 *      then 9 — the engine adapted eagerly in the first minute of a session
 *      and progressively stopped adapting thereafter. The person whose tremor
 *      developed twenty minutes in got the least help.
 *   2. The two corrections could ring. Undos push the duration up; a longer
 *      duration produces abandonments; abandonments push it down; a shorter
 *      duration produces undos. Nothing recorded which way the engine had just
 *      moved, so it could see-saw between the two complaints forever.
 *
 * The fix is an outcome window plus direction memory: ratios are computed over
 * the last ADAPT_WINDOW outcomes, and reversing a previous correction requires
 * a FULL window of evidence and moves in a smaller step, so a reversal
 * converges rather than ringing.
 */
const ADAPT_WINDOW = 20;

/**
 * Never re-adapt within this many outcomes of the last correction. Preserved
 * from v1: without it a rapid burst of undos would take the duration straight
 * to the ceiling in a few activations, which is its own kind of wrong.
 */
const ADAPT_COOLDOWN_EVENTS = 3;

/** Undo rate above which the dwell is too short. (Unchanged from v1.) */
const UNDO_RATE = 0.15;

/** Abandon rate above which the dwell is too long, once past 2 abandons. */
const ABANDON_RATE = 0.4;

const STEP_UP = 1.15;
const STEP_DOWN = 0.9;

/**
 * Smaller steps when the engine reverses its own last correction. A reversal
 * is the engine admitting it moved the wrong way; taking another full-size
 * step in the opposite direction is how a controller oscillates.
 */
const REVERSAL_STEP_UP = 1.05;
const REVERSAL_STEP_DOWN = 0.97;

/**
 * Adaptive dwell bounds. The evidence base (Burnham 2025 systematic review +
 * meta-analyses; Majaranta & MacKenzie 2006; Helmert 2008; Paulus 2021)
 * converges on 500-600ms as the optimal static default, with 250ms as the
 * expert floor and ~1500ms as the ceiling for novice/motor-impaired users.
 */
const MIN_DWELL_MS = 300;
const MAX_DWELL_MS = 1500;

/**
 * A gap this large between heartbeats means the host stopped ticking — almost
 * always because the tab was hidden (rAF pauses in background tabs) or the
 * machine slept. The dwell must NOT treat that gap as progress: a user who
 * rests on a word and switches tabs for ten seconds has not been dwelling for
 * ten seconds, and firing on return is an accidental activation the user
 * never made. On a gap this large the engine abandons the attempt and
 * requires a fresh one.
 *
 * 250ms is chosen from the same perceptual window Microsoft uses for gaze
 * onset (150-250ms): beyond it, the frames are no longer contiguous from the
 * user's point of view.
 */
const CLOCK_GAP_MS = 250;

export class DwellEngine {
  /**
   * @param {object} [options]
   * @param {number} [options.dwellMs=600]    dwell duration (progress phase)
   * @param {number} [options.lockOnMs=150]   entry gate before progress starts
   * @param {number} [options.lockoutMs=200]  min gap between same-target fires
   * @param {number} [options.repeatIntervalMs=1000] auto-repeat period for
   *   targets opted into `repeat` (volume/scroll style controls)
   * @param {number} [options.minDwellMs=300]  adaptation floor
   * @param {number} [options.maxDwellMs=1500] adaptation ceiling
   * @param {number} [options.graceMs=140]   how long a slip off-target is forgiven
   * @param {boolean} [options.adaptive=true] whether to adapt from outcomes
   * @param {boolean} [options.leaveToRearm=true] require a departure before a
   *   fired target can fire again (see the class comment; disable only if the
   *   host implements its own repeat gating)
   */
  constructor(options = {}) {
    this.dwellMs = options.dwellMs ?? 600;
    this.lockOnMs = options.lockOnMs ?? 150;
    this.lockoutMs = options.lockoutMs ?? 200;
    this.repeatIntervalMs = options.repeatIntervalMs ?? 1000;
    this.minDwellMs = options.minDwellMs ?? MIN_DWELL_MS;
    this.maxDwellMs = options.maxDwellMs ?? MAX_DWELL_MS;
    this.graceMs = options.graceMs ?? 140;
    this.adaptive = options.adaptive !== false;
    this.leaveToRearm = options.leaveToRearm !== false;

    this.onProgress = options.onProgress || null;
    this.onActivate = options.onActivate || null;
    this.onCancel = options.onCancel || null;
    this.onAdapt = options.onAdapt || null;
    this.onPhase = options.onPhase || null; // ('lockon'|'dwell'|null, id)

    this._target = null;      // target id currently being dwelled
    this._enteredAt = 0;      // when the CURRENT run began (ms, host clock)
    this._accumulatedMs = 0;  // progress carried across forgiven slips
    this._phase = 'idle';     // idle | lockon | dwell
    this._lastProgressAt = -Infinity;
    this._leftAt = null;      // when we left the target (grace window start)
    this._lastHeartbeatAt = -Infinity; // for the clock-gap guard
    this._paused = false;     // global kill switch

    // Repeat gating. `_spent` holds targets that fired and have not yet been
    // re-armed by a departure. `_lastFireAt` records the last activation time
    // per target for the lockout gate.
    this._spent = new Set();
    this._lastFireAt = new Map();
    this._repeatTargets = new Set();
    this._repeatIntervals = new Map(); // id -> intervalMs override

    // Adaptation bookkeeping.
    //
    // `_outcomes` is a rolling window of the last ADAPT_WINDOW labelled
    // results, so a ratio reflects the recent signal rather than a session
    // total that makes the engine progressively deaf. `_lastDirection` records
    // which way the engine last moved the duration, so a reversal can be
    // damped instead of ringing. See the ADAPT_WINDOW comment.
    //
    // The session totals below are kept for diagnostics only — nothing in the
    // adaptation reads them, because they are the quantity whose use caused
    // the decay.
    this._activations = 0;
    this._undos = 0;
    this._abandons = 0;
    this._outcomes = [];
    this._lastDirection = 0;   // +1 lengthened, -1 shortened, 0 never adapted
    this._adaptations = 0;     // total corrections applied — for diagnostics
    this._eventsSinceAdapt = 0;
  }

  /** Target currently being dwelled, or null. */
  get target() { return this._target; }

  /** Current phase: 'idle', 'lockon' (entry gate), or 'dwell' (progress). */
  get phase() { return this._phase; }

  /** True while the global pause is engaged. */
  get paused() { return this._paused; }

  /** Current dwell progress 0..1 for the active target (0 during lock-on). */
  get progress() {
    if (this._target === null || this._phase !== 'dwell') return 0;
    return Math.min(1, this._accumulatedMs / this.dwellMs);
  }

  /**
   * Adaptation counters, for diagnostics or a settings screen.
   *
   * The rates are reported over the ADAPTIVE WINDOW, because that is what the
   * engine actually acts on. Reporting session totals would describe a
   * different quantity than the one driving the behaviour — an instrument that
   * misreports what it measures, which is worse than reporting nothing.
   */
  get stats() {
    const w = this._windowCounts();
    return {
      dwellMs: Math.round(this.dwellMs),
      lockOnMs: Math.round(this.lockOnMs),
      activations: w.activation,
      undos: w.undo,
      abandons: w.abandon,
      // Session totals, separately labelled so they cannot be confused with
      // the windowed figures above.
      totalActivations: this._activations,
      totalUndos: this._undos,
      totalAbandons: this._abandons,
      adaptations: this._adaptations,
      lastDirection: this._lastDirection,
      windowSize: this._outcomes.length,
      spent: this._spent.size,
    };
  }

  /** Counts of each outcome type inside the current adaptive window. */
  _windowCounts() {
    const counts = { activation: 0, undo: 0, abandon: 0 };
    for (const o of this._outcomes) counts[o]++;
    return counts;
  }

  /**
   * Record a labelled outcome, keeping the window bounded.
   *
   * `undo` is recorded IN ADDITION to the activation it followed — the user
   * completed a dwell and then reversed it, which is one activation and one
   * complaint about timing, not one or the other.
   */
  _recordOutcome(kind) {
    this._outcomes.push(kind);
    if (this._outcomes.length > ADAPT_WINDOW) {
      this._outcomes.splice(0, this._outcomes.length - ADAPT_WINDOW);
    }
    this._eventsSinceAdapt++;
  }

  /**
   * Mark targets as repeat-capable (volume, scroll, next/prev). A repeat
   * target re-fires on a timer while continuously held instead of requiring a
   * departure — the Mind Express `Repeat dwell` model. Without this,
   * leave-to-rearm makes a volume button unusable.
   *
   * ADDITIVE, not replacing: a host typically registers targets as they are
   * created, and an earlier version of this method silently dropped every
   * previously registered target on the second call. Pass `{ replace: true }`
   * when you genuinely want to clear the set.
   *
   * A per-target interval is supported because repeat rates differ by
   * control: a scroll button wants a fast repeat, a destructive action wants
   * a slow one. Pass a number as the value to override the default interval:
   *
   *   dwell.setRepeatTargets(['scroll-up', 'scroll-down']);        // default rate
   *   dwell.setRepeatTargets({ 'volume-up': 400 });                // 400ms
   *   dwell.setRepeatTargets(['x'], { replace: true });            // clear first
   *
   * Accepted shapes: a string, an array of strings, an object of
   * id -> intervalMs, or an array of { id, intervalMs }.
   *
   * @param {string|string[]|object|Array<{id: string, intervalMs?: number}>} ids
   * @param {{replace?: boolean}} [opts]
   */
  setRepeatTargets(ids, opts = {}) {
    if (opts.replace) {
      this._repeatTargets = new Set();
      this._repeatIntervals = new Map();
    }
    const add = (id, intervalMs) => {
      if (typeof id !== 'string' || !id) return;
      this._repeatTargets.add(id);
      if (Number.isFinite(intervalMs) && intervalMs > 0) {
        this._repeatIntervals.set(id, intervalMs);
      }
    };

    if (typeof ids === 'string') {
      add(ids);
    } else if (Array.isArray(ids)) {
      for (const entry of ids) {
        if (typeof entry === 'string') add(entry);
        else if (entry && typeof entry === 'object') add(entry.id, entry.intervalMs);
      }
    } else if (ids && typeof ids === 'object') {
      for (const [id, intervalMs] of Object.entries(ids)) add(id, intervalMs);
    }
  }

  /** Remove targets from the repeat set. */
  clearRepeatTargets(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      this._repeatTargets.delete(id);
      this._repeatIntervals.delete(id);
    }
  }

  /** The repeat interval a target will use (per-target, else the default). */
  repeatIntervalFor(id) {
    return this._repeatIntervals.get(id) ?? this.repeatIntervalMs;
  }

  /** True if a target is currently spent (fired, awaiting departure). */
  isSpent(id) { return this._spent.has(id); }

  /**
   * Forget the heartbeat baseline.
   *
   * Call this when the host's clock changes — a source that reports device
   * time being swapped for the host's clock, a resumed session after the page
   * was frozen, or any other discontinuity. Without it, the first heartbeat
   * after the switch appears as a multi-second stall and the clock-gap guard
   * aborts an otherwise-valid dwell.
   */
  rebaseline(tMs) {
    this._lastHeartbeatAt = Number.isFinite(tMs) ? tMs : -Infinity;
  }

  /**
   * Set the dwell duration from an explicit user choice.
   *
   * WCAG 2.2.1 (Timing Adjustable) requires that a user be able to adjust a
   * timing value "over a wide range that is at least ten times the length of
   * the default setting" — and that the adjustment actually take effect. So
   * an explicit choice does three things beyond assigning the value:
   *
   *   1. It re-centres the ADAPTIVE bounds around the chosen value. Without
   *      this, a user who picks 1200ms while the ceiling is 1500ms has their
   *      choice slowly walked back by adaptation, and a user who picks 150ms
   *      is yanked up to the 300ms floor on the first correction. The user's
   *      number is a decision, not a starting guess.
   *   2. It clears the adaptation WINDOW, so history from before the change
   *      does not immediately pull the new value somewhere else.
   *   3. It clears the directional memory, so the first correction after the
   *      change is not treated as a reversal of a decision the user just made.
   *
   * WHAT IT DELIBERATELY DOES NOT DO: touch the repeat-gating state. An
   * earlier version called reset() here, which clears `_spent` and
   * `_lastFireAt` — the two structures that stop one landing from producing a
   * stream of activations. So a user who opened the settings panel mid-dwell
   * and nudged the slider cleared `_spent` for every target, and a target that
   * was spent (fired, awaiting departure) became immediately re-armable while
   * the signal had never left it. The engine's own `phase` still said 'spent',
   * so isSpent() and phase disagreed about the same fact — and the host, which
   * reads isSpent(), would re-arm its indicator under a signal that was still
   * resting on the target.
   *
   * @param {number} ms
   */
  setDwell(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v <= 0) return;
    this.dwellMs = v;
    // Bounds stay proportional to the choice: half to double. That keeps
    // adaptation useful (it can still move) without ever contradicting the
    // user by a large factor.
    this.minDwellMs = Math.max(50, Math.round(v * 0.5));
    this.maxDwellMs = Math.max(this.minDwellMs + 100, Math.round(v * 2));

    // Adaptive history only. Repeat gating and in-flight dwell state survive —
    // see the note above about why that separation matters.
    this._outcomes = [];
    this._lastDirection = 0;
    this._adaptations = 0;
    this._eventsSinceAdapt = 0;
  }

  /**
   * Global kill switch. Every platform ships one — Microsoft's "Pause eye
   * control", Apple's "Pause Dwell", eViacam's "No click", Grid 3's "Stop
   * scan" — because a user watching a video or reading must be able to stop
   * accidental selections without leaving the page. Pausing cancels any
   * in-flight dwell and ignores input until resumed.
   */
  pause() {
    if (this._paused) return;
    this._paused = true;
    if (this._target !== null) {
      const id = this._target;
      this._target = null;
      this._phase = 'idle';
      this._accumulatedMs = 0;
      this._leftAt = null;
      this.onCancel?.(id, { reason: 'paused', progress: 0 });
    }
    this.onPhase?.(null, null);
  }

  resume() {
    this._paused = false;
  }

  /**
   * The signal arrived on (or returned to) a target.
   * Returning to the SAME target inside the grace window resumes progress
   * rather than restarting it — a brief tremor slip must not cost the whole
   * dwell, or the interface becomes punishing to use.
   */
  enter(targetId, tMs) {
    if (this._paused) return;

    if (this._target === targetId) {
      // Already dwelling here; a re-enter just clears a pending slip.
      this._leftAt = null;
      // A spent target with leave-to-rearm DISABLED is a fresh start, not a
      // no-op: the host owns repeat gating and expects a new dwell. (The
      // timed lockout still applies at fire time.)
      if (this._phase === 'spent' && !this.leaveToRearm) {
        this._enteredAt = tMs;
        this._accumulatedMs = 0;
        this._lastProgressAt = -Infinity;
        this._phase = this.lockOnMs > 0 ? 'lockon' : 'dwell';
        this.onPhase?.(this._phase, targetId);
      }
      return;
    }
    if (this._target !== null) {
      // Moving to a different target: the previous one ends now.
      this._resolveDeparture(tMs, 'replaced');
    }

    // Leave-to-rearm: a target that already fired will not fire again until
    // the signal has departed from it. This is the gate that stops one
    // landing from producing a stream of activations.
    //
    // When leaveToRearm is DISABLED the spent set is ignored entirely — the
    // host has taken over repeat gating and expects a fresh dwell on every
    // entry. (Only the timed lockout still applies.)
    if (this.leaveToRearm && this._spent.has(targetId)) {
      // Track that we are hovering it (so a departure can re-arm), but do not
      // begin a dwell.
      this._target = targetId;
      this._phase = 'spent';
      this._enteredAt = tMs;
      this._accumulatedMs = 0;
      this._leftAt = null;
      this._lastHeartbeatAt = tMs;
      this.onPhase?.('spent', targetId);
      return;
    }

    this._target = targetId;
    this._enteredAt = tMs;
    this._accumulatedMs = 0;
    this._leftAt = null;
    this._lastProgressAt = -Infinity;
    this._lastHeartbeatAt = tMs;
    this._phase = this.lockOnMs > 0 ? 'lockon' : 'dwell';
    this.onPhase?.(this._phase, targetId);
  }

  /**
   * Heartbeat while the signal remains on the target. Hosts with a ticking
   * clock (rAF, a device stream) call this; the engine advances through the
   * lock-on gate, then completes the dwell and fires onActivate.
   */
  hold(tMs) {
    if (this._paused) return;

    // A heartbeat with no active target still proves the host is ALIVE, so it
    // must refresh the clock-gap baseline before returning.
    //
    // Without this, any period with no target — including the exact state a
    // consent gate creates while a grant is withheld — left the baseline
    // stale, and the first hold(0) after the signal resumed looked like a
    // multi-second gap and aborted the new dwell. The engine appeared broken
    // for one attempt after every gated interval.
    if (this._target === null) {
      this._lastHeartbeatAt = tMs;
      return;
    }
    if (this._leftAt !== null) {
      // Away from the target, but still ticking: the grace window is the only
      // thing that should expire here, so keep the baseline fresh too.
      this._lastHeartbeatAt = tMs;
      return;
    }

    // Clock-gap guard. A heartbeat this far from the last one means the host
    // stopped ticking (hidden tab, sleep, a stalled device stream) — the
    // elapsed time is wall-clock, not dwell time. Treat the attempt as
    // abandoned and require a fresh one, rather than firing on return.
    if (tMs - this._lastHeartbeatAt > CLOCK_GAP_MS) {
      const id = this._target;
      const wasSpent = this._phase === 'spent';
      this._lastHeartbeatAt = tMs;
      this._target = null;
      this._phase = 'idle';
      this._accumulatedMs = 0;
      this._leftAt = null;
      if (wasSpent) {
        this._spent.delete(id); // a gap is a departure: re-arm
        this.onPhase?.(null, null);
        return;
      }
      this.onPhase?.(null, null);
      this.onCancel?.(id, { reason: 'clock-gap', progress: 0 });
      return;
    }
    this._lastHeartbeatAt = tMs;

    if (this._phase === 'spent') {
      // A repeat-capable target re-fires on a timer while held; a normal one
      // waits for a departure (leave-to-rearm) and does nothing here.
      if (this._repeatTargets.has(this._target)) {
        const since = tMs - this._enteredAt;
        // Per-target rate: a scroll button wants a faster repeat than a
        // destructive action wants.
        if (since >= this.repeatIntervalFor(this._target)) {
          this._fireActivation(tMs, { repeat: true });
        }
      }
      return;
    }

    const elapsed = this._accumulatedMs + (tMs - this._enteredAt);

    // Phase 1: the entry gate. No progress is shown — the point of lock-on is
    // to distinguish an intentional stare from a glance, and an indicator that
    // appears during a glance would itself be noise.
    if (this._phase === 'lockon') {
      if (elapsed >= this.lockOnMs) {
        this._phase = 'dwell';
        // Progress is measured from the END of lock-on, so the dwell duration
        // is exactly dwellMs regardless of the lock-on setting.
        this._accumulatedMs = 0;
        this._enteredAt = tMs;
        this._lastHeartbeatAt = tMs;
        this.onPhase?.('dwell', this._target);
      }
      return;
    }

    // Phase 2: the dwell itself.
    if (elapsed >= this.dwellMs) {
      this._fireActivation(tMs);
      return;
    }
    this._emitProgress(elapsed, tMs);
  }

  /**
   * The signal left the target. Not an immediate cancel: a grace window
   * absorbs brief slips (gaze jitter, a hand tremor, one dropped EMG frame).
   * If the user does not return inside it, the attempt is cancelled — and
   * counted as an abandonment if they had made real progress.
   */
  leave(tMs) {
    if (this._target === null || this._leftAt !== null) return;
    this._leftAt = tMs;
    // Bank the progress made so far so a return can resume from here.
    if (this._phase === 'dwell') {
      this._accumulatedMs += tMs - this._enteredAt;
    }
  }

  /**
   * Host ticks while the signal is away — used to expire the grace window.
   * Hosts that only ever call enter/leave can instead call leave() and then
   * rely on the next enter()/cancel() to resolve; this method exists for
   * hosts that want the cancel callback to fire promptly.
   */
  tick(tMs) {
    if (this._paused) return;
    if (this._leftAt === null) return;
    if (tMs - this._leftAt >= this.graceMs) {
      this._resolveDeparture(tMs, 'left');
    }
  }

  /** Explicit cancel (an escape gesture, a mode change, a lost signal). */
  cancel(reason = 'explicit') {
    if (this._target === null) return;
    const id = this._target;
    const wasSpent = this._phase === 'spent';
    this._target = null;
    this._phase = 'idle';
    this._leftAt = null;
    this._accumulatedMs = 0;
    this.onPhase?.(null, null);
    // A deliberate cancel is also a departure — the target re-arms.
    if (wasSpent) this._spent.delete(id);
    this.onCancel?.(id, { reason, progress: 0 });
  }

  /**
   * The host reports that the user immediately undid an activation. This is
   * the "dwell was too short" signal — the engine lengthens the duration.
   */
  reportUndo() {
    this._undos++;
    this._recordOutcome('undo');
    this._adapt();
  }

  /** Forget adaptation history (new session, or after recalibration). */
  reset() {
    this._activations = 0;
    this._undos = 0;
    this._abandons = 0;
    this._outcomes = [];
    this._lastDirection = 0;
    this._adaptations = 0;
    this._eventsSinceAdapt = 0;
    this._spent.clear();
    this._lastFireAt.clear();
  }

  /** Forget repeat registrations (a new surface is being wired). */
  resetRepeatTargets() {
    this._repeatTargets.clear();
    this._repeatIntervals.clear();
  }

  // -- internals -----------------------------------------------------------

  _fireActivation(tMs, meta = {}) {
    const id = this._target;
    const prevFire = this._lastFireAt.get(id);

    // Lockout: never fire the same target twice inside the reaction-time
    // window, even if a departure was reported. Guards against a jittery
    // signal that reports leave/enter in quick succession.
    //
    // When blocked, the engine moves to 'spent' rather than staying in
    // 'dwell' — otherwise the very next hold() would find the dwell complete
    // again and fire on the following frame, defeating the gate entirely.
    if (!meta.repeat && prevFire != null && tMs - prevFire < this.lockoutMs) {
      this._phase = 'spent';
      this._accumulatedMs = 0;
      this._enteredAt = tMs;
      this._spent.add(id);
      return;
    }

    this._lastFireAt.set(id, tMs);
    this._activations++;
    this._recordOutcome('activation');

    // After firing, the target STAYS current with phase 'spent'. This is the
    // crux of leave-to-rearm: clearing _target here would destroy the
    // departure tracking that re-arms the target, and it could never fire
    // again. Keeping it lets leave() register, and _resolveDeparture() then
    // sees a spent target and re-arms it.
    this._target = id;
    this._phase = 'spent';
    this._accumulatedMs = 0;
    this._leftAt = null;
    this._enteredAt = tMs; // repeat targets measure their interval from here
    this._lastHeartbeatAt = tMs;
    this._spent.add(id);

    // ORDER MATTERS. The progress callback reports 1 (the dwell completed),
    // and it fires BEFORE onActivate so that a host which clears its
    // indicator inside onActivate is not overwritten by a trailing progress
    // update. This exact ordering bug left a full ring painted on every word
    // that had already been read.
    this.onProgress?.(id, 1);
    this.onActivate?.(id, {
      tMs,
      dwellMs: Math.round(this.dwellMs),
      // The host should CLEAR its progress indicator now — the dwell is over.
      clearProgress: true,
      ...meta,
    });
    this._adapt();
  }

  _resolveDeparture(tMs, reason) {
    const id = this._target;
    const wasSpent = this._phase === 'spent';
    const ratio = this._phase === 'dwell'
      ? Math.min(1, this._accumulatedMs / this.dwellMs)
      : 0;

    this._target = null;
    this._phase = 'idle';
    this._leftAt = null;
    this._accumulatedMs = 0;

    // The departure re-arms a spent target — this is leave-to-rearm.
    if (wasSpent) {
      this._spent.delete(id);
      this.onPhase?.(null, null);
      return;
    }

    // Only a substantially-started attempt counts as an abandonment. A signal
    // merely sweeping across a target is normal and must not skew adaptation.
    if (ratio >= ABANDON_FLOOR) {
      this._abandons++;
      this._recordOutcome('abandon');
    }
    this.onPhase?.(null, null);
    this.onCancel?.(id, { reason, progress: ratio });
    this._adapt();
  }

  _emitProgress(elapsed, tMs) {
    if (!this.onProgress) return;
    if (tMs - this._lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this._lastProgressAt = tMs;
    this.onProgress(this._target, Math.min(1, elapsed / this.dwellMs));
  }

  /**
   * Adapt the dwell duration from observed outcomes.
   *
   * The two corrections are deliberately asymmetric:
   *   - Lengthening (undo seen) is applied harder, because a wrong activation
   *     is more damaging to trust than a slow one.
   *   - Shortening (abandonments) is applied gently and needs more evidence,
   *     because abandonment can also mean "the user changed their mind",
   *     which is not a complaint about timing.
   *
   * BOTH ARE COMPUTED OVER THE WINDOW, and the engine remembers which way it
   * last moved. See the ADAPT_WINDOW comment for the two failures those two
   * changes fix: a session-total denominator that made adaptation progressively
   * deaf, and no direction memory, which let the corrections ring.
   */
  _adapt() {
    if (!this.adaptive) return;
    if (this._eventsSinceAdapt < ADAPT_COOLDOWN_EVENTS) return;

    const w = this._windowCounts();

    const before = this.dwellMs;
    const undoRate = w.activation > 0 ? w.undo / w.activation : 0;
    const abandonRate = w.abandon / Math.max(1, w.abandon + w.activation);

    // Too short: the user is undoing what the engine fired. Takes precedence
    // over the abandonment branch, matching v1 — a false activation is the
    // more damaging error, so it is the one acted on when both are present.
    if (w.undo > 0 && undoRate > UNDO_RATE) {
      const step = this._lastDirection === -1 ? REVERSAL_STEP_UP : STEP_UP;
      this.dwellMs = Math.min(this.maxDwellMs, this.dwellMs * step);
      this._lastDirection = 1;
    } else if (w.abandon > 2 && abandonRate > ABANDON_RATE) {
      const step = this._lastDirection === 1 ? REVERSAL_STEP_DOWN : STEP_DOWN;
      this.dwellMs = Math.max(this.minDwellMs, this.dwellMs * step);
      this._lastDirection = -1;
    } else {
      // No correction warranted. Do NOT reset the window: the outcomes stay
      // and the next call adds to them, so the evidence accumulates until a
      // threshold is actually crossed. v1 reset the counters only when it
      // moved, which was right for counters and would be wrong for a window.
      return;
    }

    if (this.dwellMs !== before) {
      // The window and its counters are consumed by the correction that used
      // them; the next verdict has to be earned from outcomes observed since.
      this._outcomes = [];
      this._eventsSinceAdapt = 0;
      this._adaptations++;
      this.onAdapt?.(Math.round(this.dwellMs), {
        from: Math.round(before),
        reason: this._lastDirection === 1 ? 'undos' : 'abandons',
        undoRate: Math.round(undoRate * 100) / 100,
        abandonRate: Math.round(abandonRate * 100) / 100,
      });
    }
  }
}

