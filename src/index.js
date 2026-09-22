/**
 * access-input — input abstraction for assistive access.
 *
 * Every access method reduces to three events: FOCUS, SELECT, CANCEL. This
 * package provides the seam between whatever signal a person can produce and
 * whatever interface they need to drive.
 */

export { DwellEngine } from './dwell.js';
export {
  InputSource,
  PointerSource,
  KeyboardSource,
  SwitchSource,
  ExternalSource,
  SignalBridge,
} from './sources.js';
export { ReadAlongInputHost } from './read-along.js';
export { tagWords, untagWords, splitWords, TARGET_ATTR, WORD_CLASS } from './words.js';
export {
  AnalogSwitchSource,
} from './analog-source.js';

export {
  ActivationDetector,
  ANALOG_DEFAULTS,
  EnvelopeFilter,
  applyTkeo,
  median,
  mad,
  sigmaFromMad,
} from './analog.js';

export {
  GamepadTransport,
  SerialTransport,
} from './transports.js';

/**
 * Measurement — the outcome classifier and session accounting.
 *
 * Separated from the detector on purpose: the detector answers "did the signal
 * cross?", which is all it should answer. Whether the user MEANT it is a
 * different question with a different evidence base, and the three-way split
 * (true / ambiguous / not-an-episode) is what keeps an abandoned attempt from
 * being scored against the device. See docs/MEASUREMENT-PROTOCOL.md §2.1.
 */
export {
  AccessOutcomeCounter,
  classifyActivation,
  OUTCOMES,
  DENOMINATORS,
  MEASURE_DEFAULTS,
} from './measure.js';
