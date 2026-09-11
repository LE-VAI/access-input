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
 *      completed. Repeated abandonment means the duration is too long.
 *   2. UNDONE activations — the host reports the user immediately reversed an
 *      activation. That means the duration was too short.
 *
 * Both signals are reported BY THE HOST, because only the host knows what
 * "undo" means in its own UI. The engine never infers intent from raw signal
 * noise — it counts outcomes the host labels. That keeps the adaptation
 * honest: it is reacting to real user corrections, not to a guess about
 * signal quality.
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

export class DwellEngine {
  /**
   * @param {object} [options]
   * @param {number} [options.dwellMs=900]   starting dwell duration
   * @param {number} [options.minDwellMs=350]  adaptation floor
   * @param {number} [options.maxDwellMs=3000] adaptation ceiling
   * @param {number} [options.graceMs=140]   how long a slip off-target is forgiven
   * @param {boolean} [options.adaptive=true] whether to adapt from outcomes
   */
  constructor(options = {}) {
    this.dwellMs = options.dwellMs ?? 900;
    this.minDwellMs = options.minDwellMs ?? 350;
    this.maxDwellMs = options.maxDwellMs ?? 3000;
    this.graceMs = options.graceMs ?? 140;
    this.adaptive = options.adaptive !== false;

    this.onProgress = options.onProgress || null;
    this.onActivate = options.onActivate || null;
    this.onCancel = options.onCancel || null;
    this.onAdapt = options.onAdapt || null;

    this._target = null;      // target id currently being dwelled
    this._startedAt = 0;      // when the CURRENT run began (ms, host clock)
    this._accumulatedMs = 0;  // progress carried across forgiven slips
    this._lastProgressAt = -Infinity;
    this._leftAt = null;      // when we left the target (grace window start)

    // Adaptation bookkeeping
    this._activations = 0;
    this._undos = 0;
    this._abandons = 0;
    this._eventsSinceAdapt = 0;
  }

  /** Target currently being dwelled, or null. */
  get target() { return this._target; }

  /** Current dwell progress 0..1 for the active target. */
  get progress() {
    if (this._target === null) return 0;
    return Math.min(1, this._accumulatedMs / this.dwellMs);
  }

  /** Adaptation counters, for diagnostics or a settings screen. */
  get stats() {
    return {
      dwellMs: Math.round(this.dwellMs),
      activations: this._activations,
      undos: this._undos,
      abandons: this._abandons,
    };
  }

  /**
   * The signal arrived on (or returned to) a target.
   * Returning to the SAME target inside the grace window resumes progress
   * rather than restarting it — a brief tremor slip must not cost the whole
   * dwell, or the interface becomes punishing to use.
   */
  enter(targetId, tMs) {
    if (this._target === targetId) {
      // Already dwelling here; a re-enter just clears a pending slip.
      this._leftAt = null;
      return;
    }
    if (this._target !== null && this._leftAt !== null && this._target === targetId) {
      // Unreachable given the check above, kept explicit for clarity.
      this._leftAt = null;
      return;
    }
    if (this._target !== null) {
      // Moving to a different target: the previous one ends now.
      this._resolveDeparture(tMs, 'replaced');
    }
    this._target = targetId;
    this._startedAt = tMs;
    this._accumulatedMs = 0;
    this._leftAt = null;
    this._lastProgressAt = -Infinity;
  }

  /**
   * Heartbeat while the signal remains on the target. Hosts with a ticking
   * clock (rAF, a device stream) call this; the engine completes the dwell
   * and fires onActivate when the duration is reached.
   */
  hold(tMs) {
    if (this._target === null || this._leftAt !== null) return;
    const elapsed = this._accumulatedMs + (tMs - this._startedAt);
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
    this._accumulatedMs += tMs - this._startedAt;
  }

  /**
   * Host ticks while the signal is away — used to expire the grace window.
   * Hosts that only ever call enter/leave can instead call leave() and then
   * rely on the next enter()/cancel() to resolve; this method exists for
   * hosts that want the cancel callback to fire promptly.
   */
  tick(tMs) {
    if (this._leftAt === null) return;
    if (tMs - this._leftAt >= this.graceMs) {
      this._resolveDeparture(tMs, 'left');
    }
  }

  /** Explicit cancel (an escape gesture, a mode change, a lost signal). */
  cancel(reason = 'explicit') {
    if (this._target === null) return;
    this._finishCancel(this._target, reason);
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
  }

  // -- internals -----------------------------------------------------------

  _fireActivation(tMs) {
    const id = this._target;
    this._target = null;
    this._accumulatedMs = 0;
    this._leftAt = null;
    this._activations++;
    this._eventsSinceAdapt++;
    this.onProgress?.(id, 1);
    this.onActivate?.(id, { tMs, dwellMs: Math.round(this.dwellMs) });
    this._adapt();
  }

  _resolveDeparture(tMs, reason) {
    const id = this._target;
    const ratio = Math.min(1, this._accumulatedMs / this.dwellMs);
    this._target = null;
    this._leftAt = null;
    this._accumulatedMs = 0;
    // Only a substantially-started attempt counts as an abandonment. A signal
    // merely sweeping across a target is normal and must not skew adaptation.
    if (ratio >= ABANDON_FLOOR) {
      this._abandons++;
      this._eventsSinceAdapt++;
    }
    this.onCancel?.(id, { reason, progress: ratio });
    this._adapt();
  }

  _finishCancel(id, reason) {
    this._target = null;
    this._leftAt = null;
    this._accumulatedMs = 0;
    this.onCancel?.(id, { reason, progress: 0 });
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
