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
 */

/** Progress callbacks are throttled — the UI ring does not need 60fps. */
const PROGRESS_INTERVAL_MS = 50;

/**
 * A partial dwell only counts as an ABANDONMENT if the user got far enough
 * that they plausibly meant to activate. Below this ratio, leaving is just
 * the signal passing over the target (normal for gaze), not a failed attempt.
 */
const ABANDON_FLOOR = 0.25;

/** Hysteresis: never re-adapt within this many events of the last change. */
const ADAPT_COOLDOWN_EVENTS = 3;

/**
 * Adaptive dwell bounds. The evidence base (Burnham 2025 systematic review +
 * meta-analyses; Majaranta & MacKenzie 2006; Helmert 2008; Paulus 2021)
 * converges on 500-600ms as the optimal static default, with 250ms as the
 * expert floor and ~1500ms as the ceiling for novice/motor-impaired users.
 */
const MIN_DWELL_MS = 300;
const MAX_DWELL_MS = 1500;

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
    this._paused = false;     // global kill switch

    // Repeat gating. `_spent` holds targets that fired and have not yet been
    // re-armed by a departure. `_lastFireAt` records the last activation time
    // per target for the lockout gate.
    this._spent = new Set();
    this._lastFireAt = new Map();
    this._repeatTargets = new Set();

    // Adaptation bookkeeping
    this._activations = 0;
    this._undos = 0;
    this._abandons = 0;
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

  /** Adaptation counters, for diagnostics or a settings screen. */
  get stats() {
    return {
      dwellMs: Math.round(this.dwellMs),
      lockOnMs: Math.round(this.lockOnMs),
      activations: this._activations,
      undos: this._undos,
      abandons: this._abandons,
      spent: this._spent.size,
    };
  }

  /**
   * Mark targets as repeat-capable (volume, scroll, next/prev). A repeat
   * target re-fires on a timer while continuously held instead of requiring a
   * departure — the Mind Express `Repeat dwell` model. Without this,
   * leave-to-rearm makes a volume button unusable.
   * @param {string|string[]} ids
   */
  setRepeatTargets(ids) {
    this._repeatTargets = new Set(Array.isArray(ids) ? ids : [ids]);
  }

  /** True if a target is currently spent (fired, awaiting departure). */
  isSpent(id) { return this._spent.has(id); }

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
      this.onPhase?.('spent', targetId);
      return;
    }

    this._target = targetId;
    this._enteredAt = tMs;
    this._accumulatedMs = 0;
    this._leftAt = null;
    this._lastProgressAt = -Infinity;
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
    if (this._target === null || this._leftAt !== null) return;
    if (this._phase === 'spent') {
      // A repeat-capable target re-fires on a timer while held; a normal one
      // waits for a departure (leave-to-rearm) and does nothing here.
      if (this._repeatTargets.has(this._target)) {
        const since = tMs - this._enteredAt;
        if (since >= this.repeatIntervalMs) {
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
    this._eventsSinceAdapt++;
    this._adapt();
  }

  /** Forget adaptation counters (new session, or after recalibration). */
  reset() {
    this._activations = 0;
    this._undos = 0;
    this._abandons = 0;
    this._eventsSinceAdapt = 0;
    this._spent.clear();
    this._lastFireAt.clear();
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
    this._eventsSinceAdapt++;

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
      this._eventsSinceAdapt++;
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
   */
  _adapt() {
    if (!this.adaptive) return;
    if (this._eventsSinceAdapt < ADAPT_COOLDOWN_EVENTS) return;

    const before = this.dwellMs;

    // Too short: the user is undoing what the engine fired.
    if (this._undos > 0 && this._undos / Math.max(1, this._activations) > 0.15) {
      this.dwellMs = Math.min(this.maxDwellMs, this.dwellMs * 1.15);
    } else if (
      // Too long: repeated abandoned attempts outnumber completions.
      this._abandons > 2 &&
      this._abandons / Math.max(1, this._abandons + this._activations) > 0.4
    ) {
      this.dwellMs = Math.max(this.minDwellMs, this.dwellMs * 0.9);
    }

    if (this.dwellMs !== before) {
      this._eventsSinceAdapt = 0;
      this._undos = 0;
      this._abandons = 0;
      this.onAdapt?.(Math.round(this.dwellMs), { from: Math.round(before) });
    }
  }
}
