/**
 * sources.js — input source abstraction.
 *
 * Every access method a person might use reduces to the same three events:
 *
 *   FOCUS   — "the pointer is on target X"   (gaze position, mouse position,
 *                                              a scan highlight landing on X)
 *   SELECT  — "the user chose X"             (a switch press, a dwell
 *                                              completing, a blink)
 *   CANCEL  — "the user backed out"          (an escape gesture, an undo)
 *
 * A source that emits FOCUS continuously (gaze, mouse) drives the DwellEngine.
 * A source that emits SELECT directly (a single switch, a sip-puff) skips
 * dwell entirely — it already IS the selection. Both plug into the same
 * host API, so an app built against this layer works for every access method
 * without knowing which one is in use.
 *
 * WHY THIS FILE EXISTS. The assistive-input ecosystem is a graveyard of
 * single-purpose apps: a scanning keyboard that only takes switches, a gaze
 * app that only takes one tracker. Every one of them re-implements the same
 * plumbing, and none of them can accept a new input without a rewrite. This
 * layer is the missing seam.
 *
 * TIME IS ALWAYS SUPPLIED BY THE CALLER (see dwell.js for the same rule).
 */

/**
 * Base class documenting the contract. Sources emit focus/select/cancel and
 * report their capabilities; the host never assumes a capability that is not
 * declared.
 */
export class InputSource {
  constructor(options = {}) {
    this.onFocus = options.onFocus || null;   // (targetId|null, tMs)
    this.onSelect = options.onSelect || null; // (targetId|null, tMs)
    this.onCancel = options.onCancel || null; // (reason, tMs)
    this._active = false;
  }

  /**
   * Capabilities the host must respect.
   *   continuous — emits FOCUS as a position (dwell applies)
   *   direct     — emits SELECT itself (dwell is redundant)
   *   targets    — can address named targets (vs. next/previous only)
   *   twoAxis    — has an independent second axis (scan direction control)
   */
  static get capabilities() {
    return { continuous: false, direct: false, targets: false, twoAxis: false };
  }

  get capabilities() { return this.constructor.capabilities; }
  get active() { return this._active; }

  async start() { this._active = true; }
  stop() { this._active = false; }
}

/**
 * Guard for environments without a DOM (Node tests, SSR). Sources are
 * browser-facing, but they must be IMPORTABLE and startable anywhere so the
 * logic can be tested without a browser.
 */
const hasWindow = typeof window !== 'undefined';

/**
 * PointerSource — mouse, touch, or head-pointer. The reference implementation:
 * it is the access method everyone already has, so it is also the fallback
 * when no assistive source is present.
 *
 * TWO DESIGN DECISIONS worth stating, both from the high-frequency-input
 * literature and the mature eye-gaze systems:
 *
 *  1. Position is SAMPLED ONCE PER rAF FRAME, not acted on per event. A 120Hz
 *     eye tracker produces ~2 pointermove events per rendered frame; doing the
 *     hit-test in the handler wastes work and can thrash focus between targets
 *     that are 1px apart. The last position is stored and the hit-test runs at
 *     frame cadence. (Coalesced pointermove events also report the LAST
 *     position as their target, so the event stream cannot be used to see the
 *     path anyway.)
 *
 *  2. LEAVE IS SPATIAL, measured against a RADIUS around the target's centre,
 *     not the element's bounding box. Every mature system expresses jitter
 *     tolerance in pixels — eViacam's "dwell area", Mind Express's "jitter
 *     margin", OptiKey's separate lock-on and fixation radii. A bounding-box
 *     test re-arms the moment the pointer crosses a 1px gap between two words,
 *     which is exactly how one landing produces two activations on adjacent
 *     targets.
 */
export class PointerSource extends InputSource {
  static get capabilities() {
    return { continuous: true, direct: false, targets: true, twoAxis: true };
  }

  /**
   * @param {HTMLElement} root element whose [data-dwell-target] children are targets
   * @param {object} [options]
   * @param {Function} [options.now] clock, defaults to performance.now
   * @param {number} [options.leaveRadiusPx=24] how far the pointer must move
   *   from a target's centre before it counts as having left. 24px is the
   *   WCAG 2.5.8 target-size unit, so this is exactly one target unit of
   *   slack — enough to absorb tremor, small enough that moving to a
   *   neighbouring word is unambiguous.
   */
  constructor(root, options = {}) {
    super(options);
    this.root = root;
    this._now = options.now || (() => performance.now());
    this._leaveRadiusPx = options.leaveRadiusPx ?? 24;
    this._bound = false;
    this._handlers = {};
    this._x = null;          // latest pointer position (client coords)
    this._y = null;
    this._raf = 0;
    this._lastId = null;     // last target reported (to emit only on change)
    this._center = new Map(); // target id -> {x, y} centre, cached per frame
  }

  /** Nearest dwell target under a point, or null. */
  _targetAt(x, y) {
    const el = document.elementFromPoint?.(x, y);
    if (!el) return null;
    const target = el.closest?.('[data-dwell-target]');
    if (!target || !this.root.contains(target)) return null;
    return target.getAttribute('data-dwell-target');
  }

  /**
   * The current position is still "on" `id` if it is inside the target's box
   * OR within the leave radius of its centre. The radius is what makes a
   * 1-2px gap between adjacent words NOT count as a departure.
   */
  _stillOn(id, x, y) {
    const el = this.root?.querySelector?.(`[data-dwell-target="${id}"]`);
    if (!el) return false;
    const r = el.getBoundingClientRect?.();
    if (!r) return false;
    // Inside the box → definitely still on it.
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    // Outside the box but within the radius of the centre → still on it.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    return Math.hypot(dx, dy) <= this._leaveRadiusPx;
  }

  /** One hit-test per frame, using the latest sampled position. */
  _sample() {
    this._raf = 0;
    if (!this._active || this._x === null) return;
    const t = this._now();

    // Hysteresis: if we are currently on a target and the pointer has not
    // meaningfully left it, keep reporting that SAME target. This is what
    // makes micro-movement within a word a no-op instead of a re-focus.
    //
    // The repeat is deliberate: a continuous source must keep reporting its
    // position, because the dwell engine needs to know the signal is still
    // THERE (it re-enters on each report and holds while it continues). A
    // source that reported focus only on change would leave the engine with
    // no way to distinguish "still resting here" from "gone" — the dwell
    // would stall after one frame.
    if (this._lastId !== null && this._stillOn(this._lastId, this._x, this._y)) {
      this.onFocus?.(this._lastId, t);
      this._schedule();
      return;
    }

    const id = this._targetAt(this._x, this._y);
    this._lastId = id;
    this.onFocus?.(id, t);
    this._schedule();
  }

  _schedule() {
    if (this._raf) return;
    if (typeof requestAnimationFrame !== 'function') return;
    this._raf = requestAnimationFrame(() => this._sample());
  }

  async start() {
    if (this._bound || !this.root) return;
    this._bound = true;
    this._active = true;

    const move = (ev) => {
      if (!this._active) return;
      this._x = ev.clientX;
      this._y = ev.clientY;
      this._schedule();
    };
    const down = (ev) => {
      if (!this._active) return;
      const id = this._targetAt(ev.clientX, ev.clientY);
      // A click is a direct selection — no dwell required for a pointer user.
      if (id) this.onSelect?.(id, this._now());
    };
    const key = (ev) => {
      if (!this._active) return;
      if (ev.key === 'Escape') this.onCancel?.('escape', this._now());
    };

    this._handlers = { move, down, key };
    this.root.addEventListener('pointermove', move, { passive: true });
    this.root.addEventListener('pointerdown', down);
    if (hasWindow) window.addEventListener('keydown', key);
  }

  stop() {
    this._active = false;
    // Cancel any pending frame first — cleanup must not depend on _bound.
    if (this._raf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._raf);
    }
    this._raf = 0;
    if (!this._bound) return;
    const { move, down, key } = this._handlers;
    this.root?.removeEventListener('pointermove', move);
    this.root?.removeEventListener('pointerdown', down);
    if (hasWindow) window.removeEventListener('keydown', key);
    this._bound = false;
  }
}

/**
 * KeyboardSource — arrow/Tab navigation with Enter to select. The access
 * method for keyboard-only users and a testable stand-in for a switch:
 * every "switch" gesture is one key press.
 *
 * Targets are ordered by DOM position and focus is moved through them.
 */
export class KeyboardSource extends InputSource {
  static get capabilities() {
    return { continuous: false, direct: true, targets: true, twoAxis: false };
  }

  constructor(root, options = {}) {
    super(options);
    this.root = root;
    this._now = options.now || (() => performance.now());
    this._index = -1;
    this._bound = false;
    this._keysDown = new Set(); // see the repeat guard below
  }

  _targets() {
    if (!this.root) return [];
    return Array.from(this.root.querySelectorAll('[data-dwell-target]'));
  }

  _focusIndex(i, tMs) {
    const targets = this._targets();
    if (!targets.length) return;
    this._index = ((i % targets.length) + targets.length) % targets.length;
    const id = targets[this._index].getAttribute('data-dwell-target');
    this.onFocus?.(id, tMs);
  }

  async start() {
    if (this._bound || !this.root) return;
    this._bound = true;
    this._active = true;

    /**
     * KEY REPEAT IS SUPPRESSED BY DEFAULT. For an assistive target list a
     * held arrow key should move focus exactly once — auto-repeat is a
     * text-editing convention that actively harms users with motor
     * impairments, who cannot release a key quickly. (Grid 3 models a long
     * hold as a separate, opt-in gesture rather than a repeat.)
     *
     * The guard does not rely on `event.repeat` alone: on Windows and Linux,
     * when several keys are held, the most recently pressed key reports
     * `repeat: false` incorrectly. Tracking which keys are down catches that.
     */
    const isRepeat = (ev) => {
      if (ev.repeat) return true;
      if (this._keysDown.has(ev.key)) return true;
      this._keysDown.add(ev.key);
      return false;
    };
    const onUp = (ev) => this._keysDown.delete(ev.key);

    const handler = (ev) => {
      if (!this._active) return;
      const t = this._now();
      switch (ev.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'Tab':
          ev.preventDefault();
          if (isRepeat(ev)) return;
          this._focusIndex(this._index + 1, t);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          ev.preventDefault();
          if (isRepeat(ev)) return;
          // Wraparound: from the first item, left goes to the last. APG marks
          // this Optional and permits either behaviour; wrapping is chosen
          // here because a dead end costs an assistive user extra keystrokes.
          this._focusIndex(this._index <= 0 ? -1 : this._index - 1, t);
          break;
        case 'Home':
          ev.preventDefault();
          if (isRepeat(ev)) return;
          this._focusIndex(0, t);
          break;
        case 'End':
          ev.preventDefault();
          if (isRepeat(ev)) return;
          this._focusIndex(this._targets().length - 1, t);
          break;
        case 'Enter':
        case ' ':
          ev.preventDefault();
          // A held Enter/Space must not fire SELECT repeatedly.
          if (isRepeat(ev)) return;
          if (this._index >= 0) {
            const targets = this._targets();
            const id = targets[this._index]?.getAttribute('data-dwell-target');
            if (id) this.onSelect?.(id, t);
          }
          break;
        case 'Escape':
          this.onCancel?.('escape', t);
          break;
        default:
          break;
      }
    };
    this._handler = handler;
    this._handlerUp = onUp;
    if (hasWindow) {
      window.addEventListener('keydown', handler);
      window.addEventListener('keyup', onUp);
    }
  }

  stop() {
    this._active = false;
    this._keysDown.clear();
    if (!this._bound) return;
    if (hasWindow) {
      window.removeEventListener('keydown', this._handler);
      window.removeEventListener('keyup', this._handlerUp);
    }
    this._bound = false;
  }
}

/**
 * SwitchSource — a single binary switch driven by ANY key, a click, or an
 * external device event. One-switch access has exactly two gestures: advance
 * and select.
 *
 * Three behaviours here are not optional niceties — they are what separates a
 * usable single-switch interface from an exhausting one, and every mature AAC
 * system ships them:
 *
 *  1. THE SCAN PAUSES AFTER A SELECTION. A scan that keeps marching through a
 *     selection means the user's next press lands on a target they never saw
 *     highlighted. Grid 3, TouchChat and PRC-Saltillo all stop the scan on
 *     activation and require an explicit resume (PRC-Saltillo calls it
 *     "Auto Restart", and it is configurable precisely because the default is
 *     NOT to restart).
 *
 *  2. PRESSES ARE DEBOUNCED. Physical switches bounce, and a held key repeats.
 *     Grid 3 exposes `Ignore presses` (accidental) and `Ignore repeat presses`
 *     as two distinct settings; TouchChat's `Release Time` disables buttons
 *     for a period after each activation. Both gates are implemented here.
 *
 *  3. THE FIRST ITEM GETS EXTRA TIME. Android Switch Access documents a
 *     "Delay on first item" so the user can orient before the scan starts.
 *     Without it the scan is already moving before the user has looked at the
 *     screen.
 *
 * @param {object} [options]
 * @param {string[]} [options.keys=[' ']] keys that count as a press
 * @param {boolean} [options.autoScan=false] emit periodic advances on its own
 * @param {number} [options.scanMs=1000] auto-scan interval (Liberator's
 *   published default for a small grid; PRC-Saltillo allows 0.2-10s)
 * @param {number} [options.firstItemDelayMs=1000] extra pause on item 0
 * @param {number} [options.debounceMs=50] hardware-bounce floor
 * @param {number} [options.accidentalPressMs=400] ignore a second press this
 *   soon after one that already selected (prevents double-activation)
 * @param {boolean} [options.pauseScanOnSelect=true] stop the scan after a
 *   selection until the user presses again (or the host calls resumeScan())
 * @param {number} [options.maxCycles=0] stop after this many full passes
 *   (0 = scan forever); Android and Grid 3 both cap this
 * @param {boolean} [options.reverse=false] scan backwards
 */
export class SwitchSource extends InputSource {
  static get capabilities() {
    return { continuous: false, direct: true, targets: false, twoAxis: false };
  }

  constructor(options = {}) {
    super(options);
    this.keys = options.keys ?? [' '];
    this.autoScan = options.autoScan ?? false;
    this.scanMs = options.scanMs ?? 1000;
    this.firstItemDelayMs = options.firstItemDelayMs ?? 1000;
    this.debounceMs = options.debounceMs ?? 50;
    this.accidentalPressMs = options.accidentalPressMs ?? 400;
    this.pauseScanOnSelect = options.pauseScanOnSelect !== false;
    this.maxCycles = options.maxCycles ?? 0;
    this.reverse = options.reverse ?? false;
    this._now = options.now || (() => performance.now());
    this._index = -1;
    this._timer = null;
    this._bound = false;
    // Row-column state. The scan is a two-phase machine: 'row' walks rows,
    // 'item' walks the items inside the selected row. Linear scanning ignores
    // both and uses _index.
    this.scanPattern = options.scanPattern ?? 'linear';
    this._phase = 'row';
    this._rowIndex = -1;
    this._itemIndex = -1;
    this._lastPressAt = -Infinity;  // debounce
    this._lastSelectAt = -Infinity; // accidental-press gate
    this._cycles = 0;
    this._scanPaused = false;
    this.onScanState = options.onScanState || null; // (running: boolean)
  }

  _targets() {
    return this._root ? Array.from(this._root.querySelectorAll('[data-dwell-target]')) : [];
  }

  /**
   * Group targets into rows by their vertical position. Row-column scanning
   * is the recommended pattern for grids (Android: "often faster than linear
   * scanning"; AssistiveWare notes single-switch linear scanning "has
   * significant timing and attention demands"), but it needs to know what a
   * row IS — and this layer does not otherwise care about layout.
   *
   * Targets are grouped by their vertical centre with a tolerance, so items
   * that share a visual row land in one group without requiring markup to
   * declare it. Targets with no measurable geometry (a test stub, a detached
   * node) all collapse into a single row, which degrades to linear scanning.
   */
  _rows() {
    const targets = this._targets();
    if (!targets.length) return [];
    const measured = targets.map((el, i) => {
      const r = el.getBoundingClientRect?.();
      return { i, el, mid: r ? r.top + r.height / 2 : 0 };
    });
    measured.sort((a, b) => a.mid - b.mid || a.i - b.i);

    const rows = [];
    let current = [measured[0]];
    // Tolerance in pixels: half a typical target height separates real rows
    // without splitting a row on sub-pixel differences.
    const TOLERANCE = 12;
    for (let k = 1; k < measured.length; k++) {
      if (Math.abs(measured[k].mid - current[0].mid) <= TOLERANCE) {
        current.push(measured[k]);
      } else {
        rows.push(current);
        current = [measured[k]];
      }
    }
    rows.push(current);
    // Order each row left-to-right so scanning reads naturally.
    for (const row of rows) row.sort((a, b) => a.i - b.i);
    return rows;
  }

  /** Attach the DOM subtree whose targets this switch scans. */
  attach(root) { this._root = root; }

  /** True while the auto-scan is actually running (timer armed, not paused). */
  get scanning() { return this._timer !== null; }

  _advance(tMs) {
    const targets = this._targets();
    if (!targets.length) return;

    // Row-column scanning: phase 1 walks whole ROWS, phase 2 walks the items
    // WITHIN the chosen row. Two phases mean at most rows+items steps instead
    // of one step per item, which is why every AAC platform offers it for
    // grids. A single row (or unmeasurable geometry) degrades to linear.
    if (this.scanPattern === 'row-column') {
      const rows = this._rows();
      if (rows.length > 1) {
        const step = this.reverse ? -1 : 1;
        if (this._phase === 'row') {
          const nextRow = this._rowIndex + step;
          if (nextRow >= rows.length || nextRow < 0) {
            this._cycles++;
            if (this.maxCycles > 0 && this._cycles >= this.maxCycles) {
              this.pauseScan();
              return;
            }
          }
          this._rowIndex = ((nextRow % rows.length) + rows.length) % rows.length;
          // Announce the row by highlighting its FIRST item — the user needs
          // to see where the row starts before choosing it.
          const first = rows[this._rowIndex][0];
          this.onFocus?.(first.el.getAttribute('data-dwell-target'), tMs);
          return;
        }
        // Phase 2: walk items inside the chosen row.
        const row = rows[this._rowIndex] || [];
        if (!row.length) return;
        const nextItem = this._itemIndex + step;
        if (nextItem >= row.length) {
          this._cycles++;
          if (this.maxCycles > 0 && this._cycles >= this.maxCycles) {
            this.pauseScan();
            return;
          }
        }
        this._itemIndex = ((nextItem % row.length) + row.length) % row.length;
        this.onFocus?.(row[this._itemIndex].el.getAttribute('data-dwell-target'), tMs);
        return;
      }
    }

    // Linear scanning (the default).
    const step = this.reverse ? -1 : 1;
    const next = this._index + step;
    if (next >= targets.length) {
      this._cycles++;
      if (this.maxCycles > 0 && this._cycles >= this.maxCycles) {
        this.pauseScan();
        return;
      }
    }
    this._index = ((next % targets.length) + targets.length) % targets.length;
    this.onFocus?.(targets[this._index].getAttribute('data-dwell-target'), tMs);
  }

  /**
   * One switch press.
   *
   * The order of the gates matters: bounce is filtered first (a double-report
   * of ONE physical press must never count as two advances), then the
   * accidental-press gate (a second press right after a selection is almost
   * always unintended), then the actual behaviour — resume a paused scan, or
   * advance, or select.
   */
  press(tMs) {
    if (!this._active) return;

    // Gate 1: hardware bounce / key repeat.
    if (tMs - this._lastPressAt < this.debounceMs) return;
    this._lastPressAt = tMs;

    // A paused scan resumes on the next press rather than advancing — the
    // user needs to see where the highlight is before it moves again.
    if (this._scanPaused) {
      this.resumeScan();
      return;
    }

    // Gate 2: a press immediately after a selection is treated as unintended.
    if (tMs - this._lastSelectAt < this.accidentalPressMs) return;

    // Row-column phase 1: the press chooses a ROW, not an item. The scan then
    // narrows to the items inside it.
    if (this.scanPattern === 'row-column' && this._phase === 'row') {
      const rows = this._rows();
      if (rows.length > 1 && this._rowIndex >= 0) {
        this._phase = 'item';
        this._itemIndex = -1;
        this._advance(tMs); // focus the first item of the chosen row
        return;
      }
    }

    if (this.scanPattern === 'row-column' && this._phase === 'item') {
      const rows = this._rows();
      const row = rows[this._rowIndex] || [];
      const id = row[this._itemIndex]?.el.getAttribute('data-dwell-target');
      if (id) {
        this._lastSelectAt = tMs;
        this.onSelect?.(id, tMs);
        // Return to row phase so the next selection starts from the top.
        this._phase = 'row';
        this._rowIndex = -1;
        this._itemIndex = -1;
        if (this.pauseScanOnSelect && this.autoScan) this.pauseScan();
      }
      return;
    }

    if (this._index < 0) {
      this._advance(tMs);
      return;
    }
    const targets = this._targets();
    const id = targets[this._index]?.getAttribute('data-dwell-target');
    if (id) {
      this._lastSelectAt = tMs;
      this.onSelect?.(id, tMs);
      // Gate 3: stop the scan so the next press is deliberate.
      if (this.pauseScanOnSelect && this.autoScan) this.pauseScan();
    }
  }

  /** Stop the auto-scan, keeping the highlight where it is. */
  pauseScan() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._scanPaused = true;
    this.onScanState?.(false);
  }

  /** Restart the auto-scan from the current highlight. */
  resumeScan() {
    this._scanPaused = false;
    if (!this.autoScan || !this._active) return;
    this._startTimer(this.scanMs);
    this.onScanState?.(true);
  }

  _startTimer(interval) {
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => this._advance(this._now()), interval);
  }

  async start() {
    if (this._bound) return;
    this._bound = true;
    this._active = true;
    this._handler = (ev) => {
      if (!this._active) return;
      if (this.keys.includes(ev.key)) {
        ev.preventDefault();
        this.press(this._now());
      } else if (ev.key === 'Escape') {
        this.onCancel?.('escape', this._now());
      }
    };
    if (hasWindow) window.addEventListener('keydown', this._handler);
    if (this.autoScan) {
      // First item gets the orientation delay before the regular cadence.
      this._startTimer(this.firstItemDelayMs);
      this._scanPaused = false;
      this.onScanState?.(true);
    }
  }

  stop() {
    this._active = false;
    // Cleanup must happen even if start() was never called (or was already
    // stopped): a timer started directly via _startTimer would otherwise keep
    // firing forever and hold the process open. Caught by a test suite that
    // refused to exit.
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._scanPaused = false;
    if (!this._bound) return;
    if (hasWindow && this._handler) {
      window.removeEventListener('keydown', this._handler);
    }
    this._bound = false;
  }
}

/**
 * ExternalSource — the escape hatch that makes this layer future-proof.
 *
 * Any device that can reach the page — a BLE switch, a serial sip-puff
 * sensor, an EMG channel, and one day an EEG bridge — drives the host by
 * calling these methods. It is the same contract read-along's ExternalEngine
 * uses for its clock, applied to input instead of timing: the device owns the
 * signal, the app owns the rendering.
 *
 *   const src = new ExternalSource();
 *   src.focus('word-12');   // signal moved to a target
 *   src.select('word-12');  // user chose it
 *   src.cancel();           // user backed out
 *
 * This is why no EEG-specific code is needed to support EEG later: an EEG
 * pipeline that can decide "focus" and "select" plugs in here unchanged.
 */
export class ExternalSource extends InputSource {
  static get capabilities() {
    return { continuous: true, direct: true, targets: true, twoAxis: true };
  }

  constructor(options = {}) {
    super(options);
    this._now = options.now || (() => performance.now());
  }

  async start() { this._active = true; }
  stop() { this._active = false; }

  /**
   * Report the position the external system is pointing at.
   *
   * THE tMs PARAMETER IS LOAD-BEARING AND WAS MISSING. This method previously
   * accepted only `targetId` and always stamped the event with its own clock,
   * so a host driving a virtual clock (the documented pattern for
   * determinism) could not say what time it was. The bridge then handed the
   * engine a wall-clock timestamp while the host ticked `dwell.hold()` on a
   * virtual one — two timebases, which the engine's contract forbids. Because
   * the wall clock grows with process age, the resulting failure was
   * load-dependent and looked random.
   *
   * Passing `tMs` is now the way a virtual-clock host states the time. Omitting
   * it keeps the old behaviour — stamp with this source's clock — which is
   * correct for a host that uses one real clock throughout.
   *
   * @param {string} targetId
   * @param {number} [tMs] the time of this event, in the caller's timebase
   */
  focus(targetId, tMs) { if (this._active) this.onFocus?.(targetId, Number.isFinite(tMs) ? tMs : this._now()); }

  /**
   * Report a discrete selection. `tMs` as in focus() — see the note there for
   * why an omitted timestamp is a real hazard for a virtual-clock host.
   */
  select(targetId, tMs) { if (this._active) this.onSelect?.(targetId, Number.isFinite(tMs) ? tMs : this._now()); }

  /** Report an external cancellation. `tMs` as in focus(). */
  cancel(reason = 'external', tMs) { if (this._active) this.onCancel?.(reason, Number.isFinite(tMs) ? tMs : this._now()); }
}

/**
 * SignalBridge — connects a source to a DwellEngine and a target host.
 *
 * This is the piece an app actually instantiates. It wires the three source
 * events into the dwell lifecycle, respecting the source's declared
 * capabilities:
 *
 *   - a CONTINUOUS source (gaze, pointer) dwells: focus starts a dwell,
 *     leaving cancels it, completing activates.
 *   - a DIRECT source (switch, keyboard, external device) does not dwell:
 *     its select event activates immediately. Dwelling on a switch press
 *     would be nonsense — the press already happened.
 */
export class SignalBridge {
  /**
   * @param {object} options
   * @param {InputSource} options.source
   * @param {DwellEngine} options.dwell
   * @param {Function} options.onActivate (targetId, meta) — the app's handler
   * @param {Function} [options.onFocus] (targetId|null) — for painting
   * @param {Function} [options.onProgress] (targetId, ratio)
   * @param {Function} [options.onCancel] (targetId, meta)
   * @param {'auto'|'dwell'|'direct'} [options.mode='auto'] how to interpret the
   *   source. 'auto' derives it from the source's declared capabilities. A host
   *   that KNOWS its device is position-only (a gaze tracker, a head-pointer)
   *   can force 'dwell' even for a source class that declares both, and a host
   *   whose device only ever presses can force 'direct'.
   * @param {object} [options.consent] an OPTIONAL consent gate. Duck-typed —
   *   anything with isGranted(purposeId) works, which includes neural-consent's
   *   ConsentManager. access-input has zero dependencies, so this is an
   *   interface, not an import.
   * @param {string} [options.consentPurpose='acquire_signal'] which purpose
   *   must be granted before the source may deliver anything. Neural-input
   *   tools have a real reason to gate here: reading the signal IS the
   *   processing act, so that is where consent has to bite.
   * @param {Function} [options.onBlocked] (reason) — called when start() is
   *   refused by the gate, so a host can explain the refusal instead of looking
   *   broken.
   * @param {Function} [options.onConsentLost] — called when a grant is
   *   withdrawn mid-session. The source is stopped at the hardware boundary
   *   before this fires.
   * @param {boolean} [options.stopSourceOnConsentLoss=true] set false only if
   *   the host manages the device lifecycle itself and knows why.
   */
  constructor(options) {
    this.source = options.source;
    this.dwell = options.dwell;
    this.onActivate = options.onActivate || null;
    this.onFocus = options.onFocus || null;
    this.onProgress = options.onProgress || null;
    this.onCancel = options.onCancel || null;
    this.mode = options.mode || 'auto';

    /**
     * CONSENT GATE — FAIL CLOSED.
     *
     * When a gate is supplied, the bridge checks it before forwarding ANY
     * event from the source. Without a grant nothing reaches the dwell engine
     * and nothing can activate: the app cannot read the signal at all.
     *
     * The check runs PER EVENT, not once at startup, because consent can be
     * withdrawn while the tool is running. A gate evaluated only at start
     * would keep working after the user turned it off — the exact failure
     * mode consent exists to prevent.
     *
     * A gate that throws is treated as NO CONSENT. If the gate object is
     * broken, the safe reading is "not granted": a broken gate must never be
     * a permissive one.
     */
    this.consent = options.consent || null;
    this.consentPurpose = options.consentPurpose ?? 'acquire_signal';
    this.onBlocked = options.onBlocked || null;
    this.onConsentLost = options.onConsentLost || null;
    this._stopSourceOnConsentLoss = options.stopSourceOnConsentLoss;

    /**
     * THE CLOCK THAT DRIVES THE ENGINE.
     *
     * DwellEngine's contract is that every timestamp it receives comes from ONE
     * timebase; its header spells out the failure when they don't ("mixing a
     * device's own clock into enter() while ticking hold() with the host's
     * clock will look like a stall").
     *
     * WHERE THIS WENT WRONG, THREE TIMES, IN ORDER:
     *
     *   1. The bridge forwarded the SOURCE's timestamp into `dwell.enter()`.
     *      A source on `performance.now()` plus a host ticking a test clock
     *      gave the engine two timebases, and a source stamp ahead of the
     *      host's clock makes `elapsed` negative so the dwell never completes.
     *   2. Stamping `_now()` unconditionally was worse: it DISCARDED a
     *      timestamp the caller had explicitly supplied (`src.focus('w3', 0)`
     *      became "enter at performance.now()"), which is a different way of
     *      putting the engine on the wrong clock.
     *
     * The rule that actually holds: THE CALLER'S TIMESTAMP IS AUTHORITATIVE.
     * A source that was handed a time stamps with that time — an
     * ExternalSource's `focus(id, tMs)` exists precisely so a host driving a
     * virtual clock can state the time. `options.now` is only the FALLBACK for
     * events that arrive WITHOUT one, and defaults to the source's own clock,
     * which is what a real device's event timestamp is.
     */
    this._now = options.now || (options.source && typeof options.source._now === 'function'
      ? options.source._now
      : (() => performance.now()));

    /** The engine's timebase for an event: the caller's time, else our fallback. */
    this._timebase = (tMs) => (Number.isFinite(tMs) ? tMs : this._now());

    this._lastFocused = null;
    this._dwellUsed = false;

    // The bridge must CHAIN onto the dwell engine's callbacks, not replace
    // them: a host that configured the engine directly (a progress painter, a
    // logger) would otherwise have its handlers silently discarded the moment
    // a bridge was attached. Caught live — the demo's dwell ring never
    // painted because this constructor clobbered the engine's onProgress.
    const prevProgress = this.dwell.onProgress;
    const prevActivate = this.dwell.onActivate;
    const prevCancel = this.dwell.onCancel;

    this.dwell.onProgress = (id, ratio) => {
      prevProgress?.(id, ratio);
      this.onProgress?.(id, ratio);
    };
    this.dwell.onActivate = (id, meta) => {
      // Final gate. The dwell ran while consent was held, but consent can be
      // withdrawn in the last few frames of a dwell, and an activation fired
      // after the user turned it off is exactly the failure consent prevents.
      if (!this._consentAllows()) return;
      this._dwellUsed = true;
      prevActivate?.(id, meta);
      this.onActivate?.(id, { ...meta, via: 'dwell' });
    };
    this.dwell.onCancel = (id, meta) => {
      prevCancel?.(id, meta);
      this.onCancel?.(id, meta);
    };

    this._wireSource();
  }

  /**
   * Is the source allowed to deliver events right now?
   *
   * No gate configured means yes (the module is usable without consent
   * tooling — a pointer or keyboard user has nothing to consent to). A gate
   * that throws, or that lacks isGranted, means NO: a broken gate must fail
   * in the safe direction.
   *
   * When the answer changes to refused, any in-flight dwell is cancelled —
   * otherwise withdrawing consent mid-dwell would still complete and fire.
   */
  _consentAllows() {
    if (!this.consent) return true;
    let granted = false;
    try {
      if (typeof this.consent.isGranted !== 'function') return false;
      granted = this.consent.isGranted(this.consentPurpose) === true;
    } catch {
      return false; // an unreadable gate is not consent
    }
    if (!granted && this._consentWasGranted) {
      /**
       * The grant just went away. Two things must stop, and only one did.
       *
       * `dwell.cancel()` stops the ATTEMPT — the activation in flight. But the
       * source was left running: a serial port stayed open, a BLE peripheral
       * stayed connected, a gamepad kept being polled. The biosignal was still
       * being acquired, digitised, and streamed into the page.
       *
       * That is the difference between "we will not act on your signal" and
       * "we will not read your signal", and for a purpose literally named
       * `acquire_signal` it is the whole point. Gating the disclosure of a read
       * body signal is not gating the reading of it.
       *
       * The source is stopped here, on the transition, so withdrawal takes
       * effect at the hardware boundary rather than at the UI boundary.
       */
      this.dwell.cancel('consent-withdrawn');
      if (this._stopSourceOnConsentLoss !== false) {
        try { this.source.stop(); } catch { /* a source that cannot stop must not break the gate */ }
      }
      this.onConsentLost?.();
    }
    this._consentWasGranted = granted;
    return granted;
  }

  _wireSource() {
    const caps = this.source.capabilities;
    // An explicit mode wins over the class declaration: the host knows its
    // actual device, the class only knows its category.
    const direct = this.mode === 'auto' ? caps.direct : this.mode === 'direct';
    const continuous = this.mode === 'auto' ? caps.continuous : this.mode === 'dwell';

    // Seed the grant state so a withdrawal DURING the first dwell is detected
    // (without this the "was granted" flag starts undefined and the first
    // withdrawal would be missed).
    this._consentWasGranted = this.consent ? this._consentAllows() : true;

    this.source.onFocus = (id, tMs) => {
      if (!this._consentAllows()) {
        // Track the position even while gated, WITHOUT acting on it.
        //
        // Otherwise the bridge's "last focused" state goes stale: the signal
        // moves to a new target during the withdrawal, and when consent is
        // re-granted the next focus event is judged "unchanged" and no dwell
        // ever starts. The tool appears broken until the user happens to move
        // to a third target. Caught by a test that withdrew and re-granted.
        this._lastFocused = id;
        return;
      }
      if (id !== this._lastFocused) {
        this.onFocus?.(id);
        this._lastFocused = id;
      }
      // Only a continuous source has a position to dwell on. A direct source
      // that also reports focus (e.g. an external device naming its target)
      // gets no dwell: its select IS the choice.
      //
      // The caller's timestamp is authoritative — see _timebase().
      if (continuous && !direct) {
        if (id === null) this.dwell.leave(this._timebase(tMs));
        else this.dwell.enter(id, this._timebase(tMs));
      }
    };

    this.source.onSelect = (id, tMs) => {
      if (!this._consentAllows()) return;
      this._dwellUsed = false;
      // A direct source selecting a target: activate it outright.
      this.onActivate?.(id, { tMs, via: 'direct' });
    };

    this.source.onCancel = (reason, tMs) => {
      // Cancel is NOT gated: a user backing out must always work, including
      // when consent is the thing they are backing out of.
      this.dwell.cancel(reason);
      this.onCancel?.(null, { reason, tMs });
    };
  }

  /** Whether the most recent activation came from dwelling (vs. direct). */
  get lastWasDwell() { return this._dwellUsed; }

  /**
   * Start the source — GATED.
   *
   * Without this check the gate only prevented the bridge from *forwarding*
   * events. A host that supplied a refusing gate still opened the serial port,
   * connected the BLE peripheral, and began polling the gamepad: the signal was
   * being read the whole time, which is precisely what a consent gate for
   * `acquire_signal` is supposed to prevent.
   *
   * Now a refused gate means the device is never opened. The caller is not left
   * guessing either — `onBlocked` fires so the UI can explain why nothing is
   * happening, rather than appearing broken.
   */
  async start() {
    if (!this._consentAllows()) {
      this.onBlocked?.('consent');
      return false;
    }
    const started = await this.source.start();
    return started === undefined ? true : started;
  }

  stop() {
    this.source.stop();
    this.dwell.cancel('stopped');
  }
}
