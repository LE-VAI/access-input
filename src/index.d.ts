/**
 * Type definitions for access-input.
 *
 * Hand-written rather than generated. A custom element's public surface is a
 * deliberate API, and generating types from source freezes implementation
 * details (private fields, internal helper shapes) into a published contract
 * that then cannot be changed without a breaking version.
 *
 * These describe what a host may rely on. Anything not here is internal.
 */

// ---------------------------------------------------------------------------
// Dwell
// ---------------------------------------------------------------------------

export interface DwellStats {
  dwellMs: number;
  lockOnMs: number;
  activations: number;
  undos: number;
  abandons: number;
  spent: number;
}

export type DwellPhase = 'idle' | 'lockon' | 'dwell' | 'spent';

export interface DwellActivateMeta {
  tMs: number;
  dwellMs: number;
  /** How the activation happened: a completed dwell, or a direct source select. */
  via: 'dwell' | 'direct';
  /** True for a target registered via setRepeatTargets that re-fired on its interval. */
  repeat?: boolean;
  /**
   * Present on a completed dwell: the host should clear its progress indicator.
   * Emitted because a progress callback fires before onActivate, so a host that
   * clears inside onActivate would otherwise be overwritten.
   */
  clearProgress?: true;
}

export interface DwellCancelMeta {
  reason: string;
  progress: number;
}

export interface DwellOptions {
  /** Dwell duration for the progress phase. Default 600 (evidence-based). */
  dwellMs?: number;
  /** Entry gate before progress begins. Default 150 (Microsoft's gaze onset window). */
  lockOnMs?: number;
  /** Minimum gap between two fires on the same target. Default 200. */
  lockoutMs?: number;
  /** Auto-repeat period for targets opted in via setRepeatTargets. Default 1000. */
  repeatIntervalMs?: number;
  /** Adaptation floor. Default 300. */
  minDwellMs?: number;
  /** Adaptation ceiling. Default 1500. */
  maxDwellMs?: number;
  /** How long a slip off-target is forgiven before the attempt is abandoned. Default 140. */
  graceMs?: number;
  /** Learn from outcomes. Default true. */
  adaptive?: boolean;
  /**
   * Require a departure before a fired target may fire again. Default true.
   * This is what makes "one landing, one activation" true.
   */
  leaveToRearm?: boolean;
  onProgress?: (targetId: string | null, ratio: number) => void;
  onActivate?: (targetId: string, meta: DwellActivateMeta) => void;
  onCancel?: (targetId: string | null, meta: DwellCancelMeta) => void;
  onAdapt?: (dwellMs: number, meta: { from: number }) => void;
  onPhase?: (phase: DwellPhase | null, targetId: string | null) => void;
}

export declare class DwellEngine {
  constructor(options?: DwellOptions);

  dwellMs: number;
  lockOnMs: number;
  lockoutMs: number;
  repeatIntervalMs: number;
  minDwellMs: number;
  maxDwellMs: number;
  graceMs: number;
  adaptive: boolean;
  leaveToRearm: boolean;
  onProgress: DwellOptions['onProgress'] | null;
  onActivate: DwellOptions['onActivate'] | null;
  onCancel: DwellOptions['onCancel'] | null;
  onAdapt: DwellOptions['onAdapt'] | null;
  onPhase: DwellOptions['onPhase'] | null;

  /** Target currently being dwelled, or null. */
  readonly target: string | null;
  /** Current phase. */
  readonly phase: DwellPhase;
  /** True while the global pause is engaged. */
  readonly paused: boolean;
  /** Dwell progress 0..1 for the active target (0 during lock-on). */
  readonly progress: number;
  readonly stats: DwellStats;

  /**
   * Register repeat-capable targets (volume/scroll style). ADDITIVE: a second
   * call does not drop the first. Pass { replace: true } to clear deliberately.
   */
  setRepeatTargets(
    ids: string | string[] | Record<string, number> | Array<{ id: string; intervalMs?: number }>,
    opts?: { replace?: boolean },
  ): void;
  clearRepeatTargets(ids: string | string[]): void;
  /** The interval a target will use — its own, or the engine default. */
  repeatIntervalFor(id: string): number;
  resetRepeatTargets(): void;

  isSpent(id: string): boolean;
  /**
   * Set the dwell duration from an explicit user choice. Re-centres the
   * adaptive bounds and resets counters, so the choice STICKS rather than being
   * walked back — WCAG 2.2.1 requires the adjustment actually take effect.
   */
  setDwell(ms: number): void;

  pause(): void;
  resume(): void;

  enter(targetId: string, tMs: number): void;
  hold(tMs: number): void;
  leave(tMs: number): void;
  tick(tMs: number): void;
  cancel(reason?: string): void;
  /** Forget the heartbeat baseline — call after switching clocks. */
  rebaseline(tMs?: number): void;
  reportUndo(): void;
  reset(): void;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface SourceCapabilities {
  /** Emits FOCUS as a position, so dwell applies. */
  continuous: boolean;
  /** Emits SELECT itself, so dwell is redundant. */
  direct: boolean;
  /** Can address named targets (vs next/previous only). */
  targets: boolean;
  /** Has an independent second axis (scan direction control). */
  twoAxis: boolean;
}

export interface SourceOptions {
  onFocus?: (targetId: string | null, tMs: number) => void;
  onSelect?: (targetId: string | null, tMs: number) => void;
  onCancel?: (reason: string, tMs: number) => void;
}

export declare class InputSource {
  constructor(options?: SourceOptions);
  static readonly capabilities: SourceCapabilities;
  readonly capabilities: SourceCapabilities;
  readonly active: boolean;
  onFocus: SourceOptions['onFocus'] | null;
  onSelect: SourceOptions['onSelect'] | null;
  onCancel: SourceOptions['onCancel'] | null;
  start(): Promise<void> | void;
  stop(): void;
}

export interface PointerSourceOptions extends SourceOptions {
  now?: () => number;
  /** Distance from a target's centre before the pointer counts as having left. Default 24. */
  leaveRadiusPx?: number;
}

export declare class PointerSource extends InputSource {
  constructor(root: HTMLElement, options?: PointerSourceOptions);
}

export declare class KeyboardSource extends InputSource {
  constructor(root: HTMLElement, options?: SourceOptions & { now?: () => number });
}

export interface SwitchSourceOptions extends SourceOptions {
  /** Keys that count as a press. Default [' ']. */
  keys?: string[];
  /** Emit periodic advances on its own. Default false. */
  autoScan?: boolean;
  /** Auto-scan interval. Default 1000. */
  scanMs?: number;
  /** Extra orientation pause on the first item. Default 1000. */
  firstItemDelayMs?: number;
  /** Hardware-bounce floor. Default 50. */
  debounceMs?: number;
  /** Ignore a second press this soon after a selection. Default 400. */
  accidentalPressMs?: number;
  /** Stop the scan after a selection until the next press. Default true. */
  pauseScanOnSelect?: boolean;
  /** Stop after this many full passes. 0 = forever. */
  maxCycles?: number;
  /** Scan backwards. Default false. */
  reverse?: boolean;
  /** 'linear' (default) or 'row-column' — rows derived from layout, not markup. */
  scanPattern?: 'linear' | 'row-column';
  now?: () => number;
  onScanState?: (running: boolean) => void;
}

export declare class SwitchSource extends InputSource {
  constructor(options?: SwitchSourceOptions);
  attach(root: HTMLElement): void;
  readonly scanning: boolean;
  press(tMs?: number): void;
  pauseScan(): void;
  resumeScan(): void;
}

export declare class ExternalSource extends InputSource {
  constructor(options?: SourceOptions & { now?: () => number });
  focus(targetId: string): void;
  select(targetId: string): void;
  cancel(reason?: string): void;
}

/**
 * Any object with isGranted(purposeId) satisfies the consent gate — this is an
 * interface, not an import, because access-input has zero dependencies.
 */
export interface ConsentGate {
  isGranted(purposeId: string): boolean;
}

export interface SignalBridgeOptions {
  source: InputSource;
  dwell: DwellEngine;
  onActivate?: (targetId: string, meta: DwellActivateMeta) => void;
  onFocus?: (targetId: string | null) => void;
  onProgress?: (targetId: string | null, ratio: number) => void;
  onCancel?: (targetId: string | null, meta: DwellCancelMeta) => void;
  /**
   * 'auto' derives from the source's declared capabilities. A host that knows
   * its device is position-only can force 'dwell'; one whose device only ever
   * presses can force 'direct'.
   */
  mode?: 'auto' | 'dwell' | 'direct';
  /**
   * Optional consent gate, checked PER EVENT (consent can be withdrawn while
   * running). Fails closed: a gate that throws, or lacks isGranted, means NO
   * consent. Cancel is never gated, so a user can always back out.
   */
  consent?: ConsentGate | null;
  consentPurpose?: string;
}

export declare class SignalBridge {
  constructor(options: SignalBridgeOptions);
  source: InputSource;
  dwell: DwellEngine;
  mode: 'auto' | 'dwell' | 'direct';
  consent: ConsentGate | null;
  consentPurpose: string;
  onActivate: SignalBridgeOptions['onActivate'] | null;
  readonly lastWasDwell: boolean;
  start(): Promise<void>;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Analog biosignal input
// ---------------------------------------------------------------------------

export interface AnalogDefaults {
  sampleRateHz: number;
  envelopeCutoffHz: number;
  statsWindowMs: number;
  baselineSigmaMultiplier: number;
  minThresholdGapFraction: number;
  creepUpFractionPerSecond: number;
  creepDownFractionPerSecond: number;
  /**
   * JUDGEMENT, not evidence. No AT-specific published value exists; the 50 ms
   * figure that looks like a citation is a clinical BURST-DURATION floor that
   * healthy controls routinely breach, so this sits deliberately above it.
   */
  minActivationMs: number;
  minReleaseMs: number;
  refractoryMs: number;
  spikeClampMad: number;
  spikeClampFloorFraction: number;
  spikeClampPeakMultiplier: number;
  useTkeo: boolean;
  inputIsEnvelope: boolean;
}

export declare const ANALOG_DEFAULTS: AnalogDefaults;

export interface AnalogThresholds {
  low: number | null;
  high: number | null;
  baseline: number | null;
  sigma: number;
}

export interface CalibrationResult {
  ok: boolean;
  /** Present when ok is false. 'signal-too-weak' means the effort did not clear the noise floor. */
  reason?: string;
  /** Human-readable explanation, including the measured values. */
  detail?: string;
  thresholds?: AnalogThresholds;
}

export interface ActivationDetectorOptions extends Partial<AnalogDefaults> {
  onPress?: (tMs: number, level: number) => void;
  onRelease?: (tMs: number, level: number) => void;
  onLevel?: (level: number, thresholds: AnalogThresholds, tMs: number) => void;
}

export declare class ActivationDetector {
  constructor(options?: ActivationDetectorOptions);
  readonly thresholds: AnalogThresholds;
  readonly isPressed: boolean;
  readonly calibrated: boolean;
  readonly count: number;
  onPress: ActivationDetectorOptions['onPress'] | null;
  onRelease: ActivationDetectorOptions['onRelease'] | null;
  onLevel: ActivationDetectorOptions['onLevel'] | null;
  /** One sample. tMs must come from the SAME clock as the host's heartbeats. */
  push(raw: number, tMs: number): number;
  measureRest(samples: number[]): { baseline: number; sigma: number };
  measurePeak(samples: number[]): number;
  /**
   * Adopt measured thresholds — or REFUSE, with a reason. A signal too weak to
   * clear the noise floor is reported, never rescued by lowering the threshold,
   * because that produces activations the user did not make.
   */
  calibrate(baseline: number, sigma: number, maxLevel: number): CalibrationResult;
  reset(): void;
}

export declare class EnvelopeFilter {
  constructor(options?: { cutoffHz?: number; sampleRateHz?: number });
  readonly alpha: number;
  push(x: number): number;
}

export declare function applyTkeo(samples: number[]): number[];
export declare function median(values: number[]): number;
export declare function mad(values: number[], med?: number): number;
export declare function sigmaFromMad(m: number): number;

export interface GamepadTransportOptions {
  /** 'analog' feeds an axis to a detector; 'button' passes discrete presses through. */
  mode?: 'analog' | 'button';
  axisIndex?: number;
  invertAxis?: boolean;
  deadzone?: number;
  buttonIndex?: number;
  onSample?: (value: number, tMs: number) => void;
  onPress?: (tMs: number) => void;
  onRelease?: (tMs: number) => void;
  onStatus?: (text: string) => void;
  now?: () => number;
}

export declare class GamepadTransport {
  constructor(options?: GamepadTransportOptions);
  /** Gamepad API availability. False in Node and in unsupported browsers. */
  static readonly supported: boolean;
  mode: 'analog' | 'button';
  readonly active: boolean;
  readonly connected: boolean;
  /** Device identity as the browser reports it, for a UI to name. */
  readonly info: { id: string; mapping: string; index: number } | null;
  /**
   * Resolve with the first gamepad that appears. The API hides devices until a
   * button is pressed, so a host must TELL the user to press something.
   */
  static waitForGamepad(timeoutMs?: number): Promise<Gamepad>;
  start(): Promise<boolean>;
  stop(): void;
}

export interface SerialTransportOptions {
  baudRate?: number;
  onSample?: (value: number, tMs: number) => void;
  onPress?: (tMs: number) => void;
  onRelease?: (tMs: number) => void;
  onStatus?: (text: string) => void;
  onError?: (err: unknown) => void;
}

export declare class SerialTransport {
  constructor(options?: SerialTransportOptions);
  static readonly supported: boolean;
  readonly active: boolean;
  readonly connected: boolean;
  readonly sampleRateHz: number | null;
  /** MUST be called from a user gesture — the browser enforces transient activation. */
  start(): Promise<boolean>;
  stop(): Promise<void>;
}

export interface AnalogSwitchSourceOptions extends SourceOptions {
  transport: GamepadTransport | SerialTransport;
  detector?: ActivationDetectorOptions;
  onLevel?: ActivationDetectorOptions['onLevel'];
  onStatus?: (text: string) => void;
  onCalibration?: (result: CalibrationResult) => void;
  onPressRaw?: (tMs: number, level: number) => void;
  onReleaseRaw?: (tMs: number, level: number) => void;
  /** Treat the negative direction as CANCEL (sip = cancel when puff = select). */
  cancelOnSecondChannel?: boolean;
}

export declare class AnalogSwitchSource extends InputSource {
  constructor(options: AnalogSwitchSourceOptions);
  readonly thresholds: AnalogThresholds;
  readonly calibrated: boolean;
  calibrate(restSamples: number[], effortSamples?: number[][]): CalibrationResult;
  recalibrate(restSamples: number[], effortSamples?: number[][]): CalibrationResult;
  /** Analog sources have no position, so the host names what a press means. */
  setTarget(targetId: string | null): void;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export interface WordRecord {
  text: string;
  start: number;
  end: number;
  index: number;
}

export declare const TARGET_ATTR: 'data-dwell-target';
export declare const WORD_CLASS: 'ra-dwell-word';
export declare function splitWords(text: string): WordRecord[];
/** Wrap every word as a dwell target. Preserves the text exactly — offsets must not shift. */
export declare function tagWords(el: HTMLElement, options?: { onlyTextNodes?: boolean }): WordRecord[];
export declare function untagWords(el: HTMLElement): void;

// ---------------------------------------------------------------------------
// read-along adapter
// ---------------------------------------------------------------------------

export interface ReadAlongInputHostOptions {
  source: InputSource;
  dwellMs?: number;
  adaptive?: boolean;
  lockOnMs?: number;
  onActivate?: (tokenIndex: number, detail: { token: number; word?: string; via?: string }) => void;
  onCancel?: SignalBridgeOptions['onCancel'];
  onAdapt?: DwellOptions['onAdapt'];
  onPhase?: DwellOptions['onPhase'];
  consent?: ConsentGate | null;
  consentPurpose?: string;
}

export declare class ReadAlongInputHost {
  constructor(el: HTMLElement, options: ReadAlongInputHostOptions);
  readonly wordCount: number;
  dwell: DwellEngine;
  bridge: SignalBridge;
  start(): Promise<void>;
  stop(): void;
  /** Clear a word's dwell fill (used on cancel and departure). */
  clearProgress(targetId: string): void;
  /** Global kill switch, passed through to the engine. */
  pause(): void;
  resume(): void;
}
