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
 */
export class PointerSource extends InputSource {
  static get capabilities() {
    return { continuous: true, direct: false, targets: true, twoAxis: true };
  }

  /**
   * @param {HTMLElement} root element whose [data-dwell-target] children are targets
   * @param {object} [options]
   * @param {Function} [options.now] clock, defaults to performance.now
   */
  constructor(root, options = {}) {
    super(options);
    this.root = root;
    this._now = options.now || (() => performance.now());
    this._bound = false;
    this._handlers = {};
  }

  /** Nearest dwell target under a point, or null. */
  _targetAt(x, y) {
    const el = document.elementFromPoint?.(x, y);
    if (!el) return null;
    const target = el.closest?.('[data-dwell-target]');
    if (!target || !this.root.contains(target)) return null;
    return target.getAttribute('data-dwell-target');
  }

  async start() {
    if (this._bound || !this.root) return;
    this._bound = true;
    this._active = true;

    const move = (ev) => {
      if (!this._active) return;
      const id = this._targetAt(ev.clientX, ev.clientY);
      this.onFocus?.(id, this._now());
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
    const handler = (ev) => {
      if (!this._active) return;
      const t = this._now();
      switch (ev.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'Tab':
          ev.preventDefault();
          this._focusIndex(this._index + 1, t);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          ev.preventDefault();
          this._focusIndex(this._index - 1, t);
          break;
        case 'Enter':
        case ' ':
          ev.preventDefault();
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
    if (hasWindow) window.addEventListener('keydown', handler);
  }

  stop() {
    this._active = false;
    if (!this._bound) return;
    if (hasWindow) window.removeEventListener('keydown', this._handler);
    this._bound = false;
  }
}

/**
 * SwitchSource — a single binary switch driven by ANY key, a click, or an
 * external device event. One-switch access has exactly two gestures: advance
 * and select. Timing (auto-scan) is the host's job; this source only reports
 * presses, which keeps it honest about what the hardware actually provides.
 *
 * @param {object} [options]
 * @param {string[]} [options.keys=[' ']] keys that count as a press
 * @param {boolean} [options.autoScan=false] emit periodic advances on its own
 * @param {number} [options.scanMs=1200] auto-scan interval
 */
export class SwitchSource extends InputSource {
  static get capabilities() {
    return { continuous: false, direct: true, targets: false, twoAxis: false };
  }

  constructor(options = {}) {
    super(options);
    this.keys = options.keys ?? [' '];
    this.autoScan = options.autoScan ?? false;
    this.scanMs = options.scanMs ?? 1200;
    this._now = options.now || (() => performance.now());
    this._index = -1;
    this._timer = null;
    this._bound = false;
  }

  _targets() {
    return this._root ? Array.from(this._root.querySelectorAll('[data-dwell-target]')) : [];
  }

  /** Attach the DOM subtree whose targets this switch scans. */
  attach(root) { this._root = root; }

  _advance(tMs) {
    const targets = this._targets();
    if (!targets.length) return;
    this._index = (this._index + 1) % targets.length;
    this.onFocus?.(targets[this._index].getAttribute('data-dwell-target'), tMs);
  }

  /** One switch press: advance the scan, or select if a target is focused. */
  press(tMs) {
    if (!this._active) return;
    if (this._index < 0) {
      this._advance(tMs);
      return;
    }
    const targets = this._targets();
    const id = targets[this._index]?.getAttribute('data-dwell-target');
    if (id) this.onSelect?.(id, tMs);
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
      this._timer = setInterval(() => this._advance(this._now()), this.scanMs);
    }
  }

  stop() {
    this._active = false;
    if (!this._bound) return;
    if (hasWindow) window.removeEventListener('keydown', this._handler);
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
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

  focus(targetId) { if (this._active) this.onFocus?.(targetId, this._now()); }
  select(targetId) { if (this._active) this.onSelect?.(targetId, this._now()); }
  cancel(reason = 'external') { if (this._active) this.onCancel?.(reason, this._now()); }
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
   */
  constructor(options) {
    this.source = options.source;
    this.dwell = options.dwell;
    this.onActivate = options.onActivate || null;
    this.onFocus = options.onFocus || null;
    this.onProgress = options.onProgress || null;
    this.onCancel = options.onCancel || null;
    this.mode = options.mode || 'auto';

    this._lastFocused = null;
    this._dwellUsed = false;

    // The dwell engine drives progress and activation for continuous sources.
    this.dwell.onProgress = (id, ratio) => this.onProgress?.(id, ratio);
    this.dwell.onActivate = (id, meta) => {
      this._dwellUsed = true;
      this.onActivate?.(id, { ...meta, via: 'dwell' });
    };
    this.dwell.onCancel = (id, meta) => this.onCancel?.(id, meta);

    this._wireSource();
  }

  _wireSource() {
    const caps = this.source.capabilities;
    // An explicit mode wins over the class declaration: the host knows its
    // actual device, the class only knows its category.
    const direct = this.mode === 'auto' ? caps.direct : this.mode === 'direct';
    const continuous = this.mode === 'auto' ? caps.continuous : this.mode === 'dwell';

    this.source.onFocus = (id, tMs) => {
      if (id !== this._lastFocused) {
        this.onFocus?.(id);
        this._lastFocused = id;
      }
      // Only a continuous source has a position to dwell on. A direct source
      // that also reports focus (e.g. an external device naming its target)
      // gets no dwell: its select IS the choice.
      if (continuous && !direct) {
        if (id === null) this.dwell.leave(tMs);
        else this.dwell.enter(id, tMs);
      }
    };

    this.source.onSelect = (id, tMs) => {
      this._dwellUsed = false;
      // A direct source selecting a target: activate it outright.
      this.onActivate?.(id, { tMs, via: 'direct' });
    };

    this.source.onCancel = (reason, tMs) => {
      this.dwell.cancel(reason);
      this.onCancel?.(null, { reason, tMs });
    };
  }

  /** Whether the most recent activation came from dwelling (vs. direct). */
  get lastWasDwell() { return this._dwellUsed; }

  async start() { await this.source.start(); }
  stop() {
    this.source.stop();
    this.dwell.cancel('stopped');
  }
}
