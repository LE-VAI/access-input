/**
 * measure.js — outcome classification and session accounting for activation
 * measurements.
 *
 * WHY THIS IS SEPARATE FROM THE DETECTOR. `ActivationDetector` answers "did the
 * signal cross?" and nothing more, which is correct — a detector that guessed
 * intent would be inventing exactly the thing it is supposed to measure. But
 * "did it cross" is not "did the user mean it", and the difference is the whole
 * measurement problem. See docs/MEASUREMENT-PROTOCOL.md §2.1.
 *
 * THE THREE OUTCOMES. A two-way split (fired / did not fire) is unsound,
 * because it has no place to put the largest and most interesting category:
 *
 *   - TRUE ACTIVATION  — crossed, and an independent witness confirms intent
 *                        (speech energy, a host-confirmed action, a reported
 *                        use). Or, absent a witness, held long enough to be
 *                        credited as deliberate.
 *   - AMBIGUOUS        — crossed, and nothing confirms intent. This is either
 *                        a false activation or an abandoned attempt, and the
 *                        signal alone does not say which.
 *   - NOT AN EPISODE   — never crossed. Not counted, in either direction.
 *
 * `AccessOutcomeCounter` does that accounting and reports the ambiguous count
 * ALONGSIDE the rate, never folded into it. A rate that hides its ambiguous
 * middle is a number whose movement a reader cannot interpret — and the field's
 * existing instruments have no such category at all, which is the specific
 * reason per-hour rates get dismissed as unmeasurable.
 *
 * WHAT THIS DOES NOT DO. It does not decide intent. It records which evidence
 * exists and classifies according to stated parameters. Any threshold it uses
 * is in the config and is echoed in `report()`, so a reader can see how much of
 * the number came from the signal and how much from the choice.
 *
 * ZERO DEPENDENCIES, like everything in this package.
 */

/**
 * How an activation ended, as the HOST observes it. The host is the only party
 * that knows what "undo" means in its own interface, so it reports these —
 * the classifier never infers them.
 *
 * @typedef {'confirmed'|'undone'|'unknown'} Witness
 */

/**
 * The classification of one activation.
 * @typedef {'true'|'ambiguous'|'false'} ActivationOutcome
 */

export const OUTCOMES = {
  TRUE: 'true',
  AMBIGUOUS: 'ambiguous',
  FALSE: 'false',
};

/** The two denominators a rate can be reported against. */
export const DENOMINATORS = {
  /** Armed: the signal was live and could fire. */
  ARMED: 'armed',
  /** Active: the user was working at selection. */
  ACTIVE: 'active',
};

/**
 * Default thresholds for the classifier.
 *
 * These are ENGINEERING VALUES with no published counterpart — the whole point
 * of the protocol is that no validated per-hour figure exists to calibrate
 * against. Stated here, echoed in every report, and overridable, because a
 * hidden threshold is how a measurement becomes an opinion.
 */
export const MEASURE_DEFAULTS = {
  /** Held at least this long → credited as intentional absent a witness. */
  intentionalHoldMs: 400,

  /**
   * Minimum exposure, in ms, before a per-hour rate is allowed to be expressed.
   *
   * A rate extrapolated from seconds is not a measurement. A 25-second session
   * reporting "0 false activations per hour" says nothing at all — and worse, it
   * says it in the same units as a real measurement, so a reader comparing two
   * devices could treat an untested one as perfect. Fifteen minutes is not a
   * validated figure either (nothing in this field is — that is the premise of
   * the whole protocol); it is the point below which the extrapolation is
   * obviously meaningless rather than merely unvalidated.
   *
   * Below it, `report()` returns `rateWithheld: true` and the CLI refuses to
   * print a per-hour figure. The counts are still reported — the observations
   * happened — but the rate is not claimed.
   */
  minExposureMs: 900000,
  /**
   * Held at most this long and then reversed → strongly reads as a spurious
   * trigger rather than a change of mind, because there was barely an
   * activation to change one's mind about.
   *
   * WHAT THIS THRESHOLD CANNOT DO FOR DWELL. A dwell activation cannot complete
   * in under `lockOnMs + dwellMs` — 750ms with the library's defaults — because
   * the signal must clear lock-on and then accumulate the full dwell before
   * anything fires. So a COMPLETED dwell is never "brief" in this sense, and
   * every undone dwell activation lands in `ambiguous` rather than `false`.
   *
   * That is correct behaviour, not a limitation to paper over: a dwell that
   * fired means the user rested on a target for 750ms, which is real evidence
   * of intent that a sub-threshold twitch does not carry. This split
   * discriminates for DIRECT sources (switch, keyboard, an EMG trigger), where
   * an activation can genuinely be momentary.
   *
   * Recorded because it was found by building the conformance scenario: the
   * first "brief misfire" step held 790ms and could not have been briefer, and
   * the resulting `false: 0` looked like a bug until the arithmetic was checked.
   */
  spuriousHoldMs: 250,
  /** An undo inside this window of the activation counts as evidence about it. */
  undoWindowMs: 1500,
};

/**
 * Classify one activation from the evidence available.
 *
 * Exported because a host may want to log the verdict per event; the counter
 * below uses it internally.
 *
 * @param {object} ev
 * @param {number} ev.tMs              when it fired (host clock)
 * @param {number} [ev.heldMs]          how long the signal was above threshold
 * @param {Witness} [ev.witness]        what the host observed afterwards
 * @param {number} [ev.undoAtMs]        when the undo was reported, if any
 * @param {object} [cfg]                overrides; see MEASURE_DEFAULTS
 * @returns {{outcome: ActivationOutcome, basis: string}}
 */
export function classifyActivation(ev, cfg = {}) {
  const c = { ...MEASURE_DEFAULTS, ...cfg };
  const held = Number.isFinite(ev.heldMs) ? ev.heldMs : null;
  const witness = ev.witness ?? 'unknown';

  // A host confirmation is the strongest evidence available and overrides
  // everything else: the host knows whether it used the activation.
  if (witness === 'confirmed') {
    return { outcome: OUTCOMES.TRUE, basis: 'host confirmed the activation was used' };
  }

  // An undo INSIDE the window is evidence about the trigger. Outside it, the
  // user changed their mind about the action, not about the activation.
  if (witness === 'undone') {
    const inWindow = !Number.isFinite(ev.tMs) || !Number.isFinite(ev.undoAtMs)
      ? true
      : (ev.undoAtMs - ev.tMs) <= c.undoWindowMs;
    if (!inWindow) {
      return {
        outcome: OUTCOMES.TRUE,
        basis: `undo came ${Math.round(ev.undoAtMs - ev.tMs)}ms later, past the ` +
               `${c.undoWindowMs}ms window — a change of mind about the action, not the trigger`,
      };
    }
    // In-window undo. A brief activation reversed immediately is the classic
    // spurious trigger; a long hold that was reversed is more likely a
    // deliberate press the user thought better of.
    if (held !== null && held <= c.spuriousHoldMs) {
      return { outcome: OUTCOMES.FALSE, basis: `reversed within ${c.undoWindowMs}ms after a ${held}ms hold` };
    }
    return {
      outcome: OUTCOMES.AMBIGUOUS,
      basis: `reversed within ${c.undoWindowMs}ms after a ${held === null ? 'unknown' : held + 'ms'} hold — ` +
             'either spurious or an abandoned attempt',
    };
  }

  // No witness. Fall back to duration, and say that is what we did.
  if (held !== null && held >= c.intentionalHoldMs) {
    return {
      outcome: OUTCOMES.TRUE,
      basis: `held ${held}ms (≥ ${c.intentionalHoldMs}ms) with no witness — credited as intentional by duration`,
    };
  }
  return {
    outcome: OUTCOMES.AMBIGUOUS,
    basis: held === null
      ? 'no witness and no duration reported — cannot distinguish'
      : `held ${held}ms with no witness — below the ${c.intentionalHoldMs}ms duration credit`,
  };
}

/**
 * Session accounting for activation measurements.
 *
 * Feed it what happened; ask it for the number. The rate is computed against a
 * denominator the caller chooses and NAMES, because "per hour of use" is
 * ambiguous in a way that changes the answer by a factor of two — an hour of
 * watching a video with the switch armed and an hour of selection work are
 * different exposures, and one figure hides that.
 *
 *   const counter = new AccessOutcomeCounter({ sessionId: 'day-1' });
 *   counter.armed();                       // the device became live
 *   counter.activation({ tMs, heldMs, witness });  // per firing
 *   counter.undo(tMs);                     // if the host sees one
 *   counter.disarm({ activeMs });          // the device stopped
 *   counter.report({ denominator: DENOMINATORS.ARMED });
 */
export class AccessOutcomeCounter {
  /**
   * @param {object} [options]
   * @param {string} [options.sessionId]
   * @param {number} [options.intentionalHoldMs]
   * @param {number} [options.spuriousHoldMs]
   * @param {number} [options.undoWindowMs]
   * @param {() => number} [options.now] clock, for auto-stamping
   */
  constructor(options = {}) {
    this.sessionId = options.sessionId ?? null;
    this.cfg = {
      intentionalHoldMs: options.intentionalHoldMs ?? MEASURE_DEFAULTS.intentionalHoldMs,
      spuriousHoldMs: options.spuriousHoldMs ?? MEASURE_DEFAULTS.spuriousHoldMs,
      undoWindowMs: options.undoWindowMs ?? MEASURE_DEFAULTS.undoWindowMs,
      minExposureMs: options.minExposureMs ?? MEASURE_DEFAULTS.minExposureMs,
    };
    this._now = options.now ?? (() => 0);

    /** Every classified activation, in order — the record, not just the total. */
    this.activations = [];

    /** Armed / active wall-clock, in ms. Both denominators are tracked. */
    this.armedMs = 0;
    this.activeMs = 0;

    /** The open armed interval, if any. */
    this._armedSince = null;

    /** Undos reported but not yet matched to an activation. */
    this._pendingUndo = null;

    /**
     * Set when the host supplies NO independent witness for anything.
     *
     * This matters more than it looks. Without a witness, every verdict comes
     * from `intentionalHoldMs` — a stated parameter — so the whole rate is a
     * function of one number we chose. `report()` says so plainly rather than
     * presenting a parameterised guess as a measurement. That distinction is
     * the reason this class exists instead of a bare counter.
     */
    this.witnessed = false;
  }

  /** The device became live — the signal can now fire. */
  armed(tMs = this._now()) {
    if (this._armedSince !== null) return;
    this._armedSince = tMs;
  }

  /** The device stopped being live. `activeMs` records work done while armed. */
  disarm(tMs = this._now(), meta = {}) {
    if (this._armedSince !== null) {
      this.armedMs += Math.max(0, tMs - this._armedSince);
      this._armedSince = null;
    }
    if (Number.isFinite(meta.activeMs)) this.activeMs += Math.max(0, meta.activeMs);
  }

  /** Add active-use time directly, for hosts that meter it separately. */
  activeDuration(ms) {
    if (Number.isFinite(ms) && ms > 0) this.activeMs += ms;
  }

  /**
   * Record an activation.
   *
   * @param {object} ev
   * @param {number} [ev.tMs]
   * @param {number} [ev.heldMs]
   * @param {Witness} [ev.witness]
   * @returns {object} the recorded entry, including its classification
   */
  activation(ev = {}) {
    const tMs = Number.isFinite(ev.tMs) ? ev.tMs : this._now();
    const witness = ev.witness ?? (this._pendingUndo !== null ? 'undone' : 'unknown');
    if (witness !== 'unknown') this.witnessed = true;

    // Attach a pending undo if one arrived before its activation (hosts report
    // in whatever order their UI observes).
    const undoAtMs = witness === 'undone'
      ? (Number.isFinite(ev.undoAtMs) ? ev.undoAtMs : (this._pendingUndo ?? tMs))
      : undefined;
    if (witness === 'undone') this._pendingUndo = null;

    const verdict = classifyActivation(
      { tMs, heldMs: ev.heldMs, witness, undoAtMs },
      this.cfg,
    );

    const entry = {
      tMs,
      heldMs: Number.isFinite(ev.heldMs) ? ev.heldMs : null,
      witness,
      outcome: verdict.outcome,
      basis: verdict.basis,
    };
    this.activations.push(entry);
    return entry;
  }

  /** The host observed an undo. Matched to the most recent activation. */
  undo(tMs = this._now()) {
    this.witnessed = true;
    const last = this.activations[this.activations.length - 1];
    // Only reclassify when the undo is plausibly ABOUT that activation.
    if (last && !Number.isFinite(last.undoAtMs) && tMs - last.tMs <= this.cfg.undoWindowMs) {
      last.witness = 'undone';
      last.undoAtMs = tMs;
      const verdict = classifyActivation(
        { tMs: last.tMs, heldMs: last.heldMs, witness: 'undone', undoAtMs: tMs },
        this.cfg,
      );
      last.outcome = verdict.outcome;
      last.basis = verdict.basis;
      return last;
    }
    this._pendingUndo = tMs;
    return null;
  }

  /** The host confirms an activation was used. Strongest evidence available. */
  confirm(tMs = this._now()) {
    this.witnessed = true;
    const last = this.activations[this.activations.length - 1];
    if (last && last.witness === 'unknown') {
      last.witness = 'confirmed';
      const verdict = classifyActivation({ tMs: last.tMs, heldMs: last.heldMs, witness: 'confirmed' }, this.cfg);
      last.outcome = verdict.outcome;
      last.basis = verdict.basis;
      return last;
    }
    return null;
  }

  /** Counts by outcome. */
  counts() {
    const c = { true: 0, ambiguous: 0, false: 0, total: 0 };
    for (const a of this.activations) {
      c[a.outcome]++;
      c.total++;
    }
    return c;
  }

  /**
   * The rate, with everything needed to interpret it.
   *
   * `falsePerHour` is null when the denominator is zero — an absent
   * denominator is not a rate of zero, and returning 0 would read as "no
   * misfires" when it means "no measurement".
   *
   * @param {object} [options]
   * @param {'armed'|'active'} [options.denominator='armed']
   */
  report(options = {}) {
    const denominator = options.denominator ?? DENOMINATORS.ARMED;
    const ms = denominator === DENOMINATORS.ACTIVE ? this.activeMs : this.armedMs;
    const hours = ms > 0 ? ms / 3600000 : 0;
    const c = this.counts();

    /**
     * A rate needs enough exposure to mean anything. Below the floor the
     * per-hour figures are withheld rather than extrapolated — see
     * MEASURE_DEFAULTS.minExposureMs.
     */
    const tooShort = ms < this.cfg.minExposureMs;
    const rateOf = (n) => (hours > 0 && !tooShort ? Math.round((n / hours) * 10) / 10 : null);

    return {
      sessionId: this.sessionId,
      denominator,
      denominatorMs: ms,
      denominatorHours: Math.round(hours * 1000) / 1000,

      /**
       * True when the exposure was too short for a per-hour figure. Reported so
       * a caller cannot mistake a withheld rate for a measured one — and so the
       * CLI can say WHY it is not printing a number.
       */
      rateWithheld: tooShort,
      minExposureMs: this.cfg.minExposureMs,

      // THE NUMBER. False activations per hour, against the named denominator.
      // Null when there was no exposure OR too little of it.
      falsePerHour: rateOf(c.false),

      // The ambiguous middle, reported SEPARATELY and never folded in — see the
      // module header. A reader must be able to see how much of the evidence
      // was decided by a parameter rather than by the signal.
      ambiguousPerHour: rateOf(c.ambiguous),
      truePerHour: rateOf(c.true),

      counts: c,

      /**
       * Whether ANY independent witness backed these verdicts.
       *
       * False means every classification came from intentionalHoldMs, so the
       * rate measures our parameter as much as the device. Reported rather
       * than buried, because a caller who omits the witness should be told
       * what they got, not left to assume it is a measurement.
       */
      witnessed: this.witnessed,

      /** The parameters that decided any duration-based verdict. */
      parameters: { ...this.cfg },

      /** Per-activation record, so a reader can audit the classification. */
      activations: this.activations.map((a) => ({ ...a })),
    };
  }

  /** Serialise for the shared reporting schema (see MEASUREMENT-PROTOCOL.md §3.4). */
  toJSON(options = {}) {
    const r = this.report(options);
    return {
      schema: 'activation-measure/1',
      ...r,
    };
  }
}
