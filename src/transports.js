/**
 * transports.js — ways an analog or switch signal reaches the page.
 *
 * THE TRANSPORT ORDER IS RESEARCH-DRIVEN, and it is not the order you would
 * guess. The most capable transport turned out not to be Web Serial — it is the
 * GAMEPAD API, for a specific reason:
 *
 *   Origin Instruments' Breeze sip-and-puff switch has a "Joystick Plus" mode
 *   that publishes RAW ANALOG PRESSURE as a standard HID joystick X/Y axis.
 *   Sip is negative, puff is positive, and +/-4 kPa of pressure maps linearly
 *   to the axis range. That is vendor-documented. So the browser can read real
 *   sip-and-puff pressure from a shipping commercial device with no driver, no
 *   serial protocol, no chooser UI and no baud negotiation.
 *
 * The Xbox Adaptive Controller and Hori Flex are likewise HID/XInput class
 * devices, so they arrive through the same API.
 *
 * Meanwhile: NO assistive switch vendor publishes a serial protocol, and no
 * consumer EMG device in 2026 is browser-reachable with documented protocol.
 * Web Serial matters only for the maker path (a sensor wired to a
 * microcontroller), which is why it ships with a self-authored protocol rather
 * than an adopted one.
 *
 * And the simplest path of all: MOST commercial USB switch interfaces (AbleNet
 * Hitch 2, Blue2 FT, Origin Swifty in keyboard mode, RJ Cooper's) present as
 * HID KEYBOARDS emitting Enter or Space. Those already work through
 * KeyboardSource with no new code — documented rather than rebuilt.
 *
 * Every transport ends up calling the same ActivationDetector, so the signal
 * processing is written once and each transport only has to deliver samples.
 */

import { ActivationDetector, ANALOG_DEFAULTS } from './analog.js';

/**
 * GamepadTransport — analog and button input from any HID gamepad.
 *
 * Two modes, because the two device families deliver different things:
 *
 *   'analog'  — an axis carries pressure (the Breeze). Samples are fed to the
 *               ActivationDetector like any other biosignal.
 *   'button'  — a button is the switch (Xbox Adaptive Controller, Hifty,
 *               anything with a switch plugged into it). A press IS a press;
 *               no signal processing is warranted, and running a detector over
 *               a boolean would be theatre.
 *
 * The Gamepad API requires a user gesture (a button press while the page is
 * focused) before a device appears, and a secure context. Both are documented
 * browser behaviour, not limitations of this class — so `waitForGamepad()`
 * exists to make the "press a button on your device to connect" instruction
 * easy to implement honestly.
 */
export class GamepadTransport {
  /**
   * @param {object} options
   * @param {'analog'|'button'} [options.mode='button']
   * @param {number} [options.axisIndex=0] which axis carries pressure
   * @param {boolean} [options.invertAxis=false] flip the sign (device-dependent)
   * @param {number} [options.deadzone=0.02] axis magnitude treated as rest
   * @param {number} [options.buttonIndex=0] which button is the switch
   * @param {Function} [options.onSample] (value, tMs)
   * @param {Function} [options.onPress]
   * @param {Function} [options.onRelease]
   * @param {Function} [options.onStatus] (text) — for a connect prompt
   * @param {Function} [options.now]
   */
  constructor(options = {}) {
    this.mode = options.mode ?? 'button';
    this.axisIndex = options.axisIndex ?? 0;
    this.invertAxis = options.invertAxis ?? false;
    this.deadzone = options.deadzone ?? 0.02;
    this.buttonIndex = options.buttonIndex ?? 0;
    this.onSample = options.onSample || null;
    this.onPress = options.onPress || null;
    this.onRelease = options.onRelease || null;
    this.onStatus = options.onStatus || null;
    /** See SerialTransport: a disconnect is announced, not logged. */
    this.onDisconnect = options.onDisconnect || null;
    this.onDeviceState = options.onDeviceState || null;
    this._now = options.now || (() => performance.now());

    this._raf = 0;
    this._active = false;
    this._pad = null;
    this._wasDown = false;
    this._deviceState = 'idle';
  }

  /** 'idle' | 'streaming' | 'disconnected'. */
  get deviceState() { return this._deviceState; }

  /** Is the Gamepad API usable in this environment at all? */
  static get supported() {
    return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
  }

  get active() { return this._active; }
  get connected() { return this._pad !== null; }

  /** The device as the browser describes it, for a UI to name. */
  get info() {
    return this._pad ? { id: this._pad.id, mapping: this._pad.mapping, index: this._pad.index } : null;
  }

  /**
   * Resolve with the first gamepad that appears, or reject after timeoutMs.
   *
   * The Gamepad API hides devices until a button is pressed, so an
   * implementation must TELL the user to press something rather than waiting
   * silently. This helper exists so that instruction is easy to give.
   */
  static waitForGamepad(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!GamepadTransport.supported) {
        reject(new Error('The Gamepad API is not available in this browser.'));
        return;
      }
      const started = Date.now();
      const tick = () => {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const p of pads) {
          if (p) { resolve(p); return; }
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('No gamepad appeared. Press a button on the device while this page is focused.'));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  /** Begin polling. Resolves once a device is present. */
  async start(opts = {}) {
    if (!GamepadTransport.supported) {
      this.onStatus?.('The Gamepad API is not available in this browser.');
      return false;
    }
    this._active = true;
    this.onStatus?.('Press a button on your device to connect.');

    // Poll for a device, then keep polling for values. There is no event for
    // either — getGamepads() is a snapshot, which is why this is a loop.
    const tick = () => {
      if (!this._active) return;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = this._pad ? pads[this._pad.index] : (pads.find((p) => p) || null);

      if (pad && !this._pad) {
        this._pad = pad;
        this._deviceState = 'streaming';
        this.onDeviceState?.('streaming', pad.id);
        this.onStatus?.(`Connected: ${pad.id}`);
      }

      /**
       * A gamepad that vanishes from getGamepads() has been unplugged or
       * powered off — the API reports it by omission, with no event and no
       * error. Without this check a switch user's controller silently stops
       * working and the most available explanations are about themselves.
       */
      if (!pad && this._pad) {
        const gone = this._pad.id;
        this._pad = null;
        this._wasDown = false;
        this._deviceState = 'disconnected';
        this.onDeviceState?.('disconnected', gone);
        this.onDisconnect?.({ reason: 'gamepad-gone', error: null });
        this.onStatus?.(`Disconnected: ${gone}`);
      }

      if (this._pad) {
        const t = this._now();
        if (this.mode === 'analog') {
          const axis = this._pad.axes[this.axisIndex] ?? 0;
          let v = this.invertAxis ? -axis : axis;
          if (Math.abs(v) < this.deadzone) v = 0;
          this.onSample?.(v, t);
        } else {
          const btn = this._pad.buttons[this.buttonIndex];
          const down = !!(btn && (btn.pressed || btn.value > 0.5));
          if (down && !this._wasDown) this.onPress?.(t);
          if (!down && this._wasDown) this.onRelease?.(t);
          this._wasDown = down;
        }
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
    return true;
  }

  stop() {
    this._active = false;
    if (this._raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._pad = null;
  }
}

/**
 * SerialTransport — the maker path.
 *
 * No assistive switch vendor publishes a serial protocol (verified: the set is
 * empty), so there is nothing to adopt. This defines a MINIMAL one instead, and
 * ships expectations for firmware rather than a promise of compatibility with
 * hardware that does not exist:
 *
 *   One JSON object per line, newline-terminated:
 *
 *     {"t":<ms>,"v":<value>}            a sample
 *     {"dev":"<name>","fs":<hz>}        an optional hello, announcing the rate
 *
 * Values are uncalibrated sensor units. The ActivationDetector derives
 * thresholds from the signal's own statistics, so the units do not matter —
 * volts, ADC counts, or kPa all work.
 *
 * `requestPort()` requires a user gesture (transient activation), so connecting
 * must be an explicit button, never something that happens on page load.
 */
export class SerialTransport {
  constructor(options = {}) {
    this.baudRate = options.baudRate ?? 115200;
    this.onSample = options.onSample || null;
    this.onPress = options.onPress || null;
    this.onRelease = options.onRelease || null;
    this.onStatus = options.onStatus || null;
    this.onError = options.onError || null;
    /**
     * Device-state channel. `onDisconnect` is separate from `onError` because a
     * disconnect is not a programming error — it is a thing that happened to
     * the user's hardware, and it must be announced as such rather than logged.
     */
    this.onDisconnect = options.onDisconnect || null;   // ({ reason, error })
    this.onDeviceState = options.onDeviceState || null; // (state, detail)
    this._port = null;
    this._reader = null;
    this._active = false;
    this._buffer = '';
    this._sampleRateHz = null;
    this._deviceState = 'idle';
    this._disconnected = false;
  }

  /** 'idle' | 'connecting' | 'streaming' | 'disconnected'. */
  get deviceState() { return this._deviceState; }

  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  get active() { return this._active; }
  get connected() { return this._port !== null; }
  /** Sample rate announced by the device's hello line, if it sent one. */
  get sampleRateHz() { return this._sampleRateHz; }

  /**
   * Open a port. MUST be called from a user gesture — the browser enforces
   * transient activation and will reject otherwise.
   */
  async start() {
    if (!SerialTransport.supported) {
      this.onStatus?.('Web Serial is not available in this browser. Chrome, Edge, Opera and Firefox 151+ support it.');
      return false;
    }
    try {
      this._port = await navigator.serial.requestPort();
      await this._port.open({ baudRate: this.baudRate });
      this._active = true;
      this.onStatus?.('Connected.');
      this._readLoop();
      return true;
    } catch (e) {
      // A user dismissing the chooser is not an error worth shouting about.
      this.onStatus?.(e?.name === 'NotFoundError' ? 'No device chosen.' : `Could not open the device: ${e?.message ?? e}`);
      return false;
    }
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    try {
      while (this._active && this._port?.readable) {
        this._reader = this._port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this._reader.read();
            if (done) {
              /**
               * The stream ended. If we did not ask it to, the device went
               * away — unplugged, powered down, out of range.
               *
               * This MUST be reported distinctly. A switch user whose device
               * stops responding reaches for the two most available
               * explanations first, and both are about themselves: "the switch
               * is broken" or "I am not pressing hard enough." A silent stream
               * end hands them that conclusion. Naming the disconnect is the
               * difference between a five-second fix and a crisis of confidence.
               */
              if (this._active) this._reportDisconnect('stream-ended');
              break;
            }
            this._buffer += decoder.decode(value, { stream: true });
            // Newline-delimited JSON: a partial line stays buffered.
            let nl;
            while ((nl = this._buffer.indexOf('\n')) >= 0) {
              const line = this._buffer.slice(0, nl).trim();
              this._buffer = this._buffer.slice(nl + 1);
              if (line) this._handleLine(line);
            }
          }
        } finally {
          this._reader.releaseLock();
        }
      }
    } catch (e) {
      if (!this._active) return;
      // A read failure on an open port is a disconnect in practice; report the
      // state as well as the error so a UI can act on it.
      this._reportDisconnect('read-failed', e);
    } finally {
      if (this._active) this._setDeviceState('disconnected', 'the device stopped responding');
    }
  }

  /** Report a disconnect once, with a reason a UI can show a human. */
  _reportDisconnect(reason, err) {
    this._disconnected = true;
    this._setDeviceState('disconnected', reason);
    this.onDisconnect?.({ reason, error: err ?? null });
  }

  _setDeviceState(state, detail) {
    if (this._deviceState === state) return;
    this._deviceState = state;
    this.onDeviceState?.(state, detail ?? null);
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // a malformed line is skipped, not fatal — serial noise happens
    }
    if (typeof msg.fs === 'number' && msg.fs > 0) {
      this._sampleRateHz = msg.fs;
      this.onStatus?.(`Device reports ${msg.fs} Hz.`);
      return;
    }
    if (typeof msg.v === 'number') {
      // Prefer the device's own timestamp when it sends one; a device clock is
      // closer to the signal than the host's arrival time. The caller must
      // keep it on ONE clock with the rest of the host (see dwell.js).
      const t = typeof msg.t === 'number' ? msg.t : (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.onSample?.(msg.v, t);
    }
  }

  async stop() {
    this._active = false;
    try { await this._reader?.cancel(); } catch { /* already closed */ }
    try { await this._port?.close(); } catch { /* already closed */ }
    this._port = null;
    this._reader = null;
  }
}
