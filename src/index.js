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
