/**
 * analog-source.js — bind a transport + detector into a standard InputSource.
 *
 * This is the adapter that makes an analog biosignal look like every other
 * access method in the library. It declares `direct: true` (like SwitchSource),
 * so SignalBridge needs no changes at all and the source inherits debouncing,
 * the consent gate, and everything downstream for free.
 *
 * FOCUS/SELECT/CANCEL mapping, with the reason for each:
 *
 *   SELECT — a detected activation. This is the press.
 *   CANCEL — the second channel of a two-signal device (sip vs puff), or an
 *            explicit long-hold if the host asks for one. Mapping the second
 *            direction to CANCEL is the wheelchair convention: the two
 *            directions of a sip-and-puff map to opposite actions.
 *   FOCUS  — not emitted. An analog switch has no position, so there is
 *            nothing to dwell on; the scanning or dwell layer above decides
 *            what a press means. Emitting a synthetic FOCUS here would be
 *            inventing information the hardware does not provide.
 *
 * THE REFRACTORY / DOUBLE-FILTER WARNING. Host scanning software already
 * applies its own activation-time filtering (Tobii Dynavox exposes a
 * "switch pressed for at least X seconds" setting for exactly this). A second
 * unbounded filter on top makes the system feel broken in a way that is hard
 * to diagnose. So the detector's timing gates are EXPOSED and DISABLEABLE, and
 * press/release timestamps are passed through untouched so the host can apply
 * its own policy if it prefers.
 */

import { InputSource } from './sources.js';
import { ActivationDetector, ANALOG_DEFAULTS } from './analog.js';

export class AnalogSwitchSource extends InputSource {
  static get capabilities() {
    // No position (continuous: false), emits its own presses (direct: true),
    // cannot address named targets (targets: false) — exactly like a switch.
    return { continuous: false, direct: true, targets: false, twoAxis: false };
  }

  /**
   * @param {object} options
   * @param {object} options.transport   a GamepadTransport or SerialTransport
   * @param {object} [options.detector]  overrides for ANALOG_DEFAULTS
   * @param {Function} [options.onLevel] (level, thresholds, tMs) — for a meter
   * @param {Function} [options.onStatus] (text) — for connection UI
   * @param {Function} [options.onCalibration] (result) — pass a failure through
   * @param {boolean} [options.cancelOnSecondChannel] treat the negative
   *   direction as CANCEL (sip = cancel when puff = select)
   */
  constructor(options = {}) {
    super(options);
    this.transport = options.transport;
    if (!this.transport) throw new Error('AnalogSwitchSource requires a transport');

    this.onLevel = options.onLevel || null;
    this.onStatus = options.onStatus || null;
    this.onPressRaw = options.onPressRaw || null;
    this.onReleaseRaw = options.onReleaseRaw || null;
    this.cancelOnSecondChannel = options.cancelOnSecondChannel ?? false;

    this.detector = new ActivationDetector({
      ...options.detector,
      onPress: (tMs, level) => {
        this.onPressRaw?.(tMs, level);
        this.onSelect?.(this._target(), tMs);
      },
      onRelease: (tMs, level) => {
        this.onReleaseRaw?.(tMs, level);
      },
      onLevel: (level, thresholds, tMs) => this.onLevel?.(level, thresholds, tMs),
    });

    // The transport's samples flow into the detector. Nothing else knows the
    // transport exists.
    this.transport.onSample = (v, tMs) => {
      if (!this._active) return;
      if (this.cancelOnSecondChannel && v < 0) {
        // Negative direction = the device's second gesture.
        this.onCancel?.('second-channel', tMs);
        return;
      }
      this.detector.push(this.cancelOnSecondChannel ? Math.abs(v) : v, tMs);
    };
    this.transport.onStatus = (s) => this.onStatus?.(s);

    // A button-mode transport already has discrete presses; bypass the
    // detector entirely rather than running signal processing over a boolean.
    if (this.transport.mode === 'button') {
      this.transport.onPress = (tMs) => {
        this.onPressRaw?.(tMs, 1);
        this.onSelect?.(this._target(), tMs);
      };
      this.transport.onRelease = (tMs) => this.onReleaseRaw?.(tMs, 0);
    }
  }

  /** Calibrated thresholds, or nulls before calibration. */
  get thresholds() { return this.detector.thresholds; }
  get calibrated() { return this.detector.calibrated; }

  /**
   * Run the calibration and adopt the result — or report why it failed.
   *
   * The failure path is the important one. A weak signal is NOT rescued by
   * lowering the threshold; it is reported, because the alternative produces
   * activations the user did not make, which the 2025 EMG-switch trial found
   * to be the dominant usability complaint.
   *
   * @param {number[]} restSamples  a few seconds of the user at rest
   * @param {number[][]} effortSamples  repetitions of the user's strongest effort
   */
  calibrate(restSamples, effortSamples = []) {
    const { baseline, sigma } = this.detector.measureRest(restSamples);
    let peak = 0;
    for (const burst of effortSamples) {
      peak = Math.max(peak, this.detector.measurePeak(burst));
    }
    const result = this.detector.calibrate(baseline, sigma, peak);
    this.onCalibration?.(result);
    return result;
  }

  /** Re-derive thresholds from a rolling window, discarding calibration. */
  recalibrate(restSamples, effortSamples = []) {
    this.detector.reset();
    return this.calibrate(restSamples, effortSamples);
  }

  async start() {
    this._active = true;
    return this.transport.start?.();
  }

  stop() {
    this._active = false;
    this.transport.stop?.();
  }

  /** Analog sources have no position; the host supplies the target. */
  _target() { return this._explicitTarget ?? null; }

  /** Let a host name what a press means (e.g. the currently scanned item). */
  setTarget(targetId) { this._explicitTarget = targetId; }
}
