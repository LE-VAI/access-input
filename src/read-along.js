/**
 * read-along.js — adapter: drive a <read-along> element with any input source.
 *
 * This is the integration that makes the substrate concrete. A person using a
 * switch, a gaze tracker, or an EMG channel cannot click a word. This adapter
 * maps the component's words to dwell targets and routes activations to
 * word-level seek, so "rest on a word" reads from there — the same gesture a
 * pointer user gets from clicking, expressed in whatever signal the person
 * actually has.
 *
 * It also demonstrates the direction of control the thesis depends on: the
 * accessibility layer drives the reading surface, and the reading surface
 * reports its state back (active word) so a gaze or EEG layer can use the
 * reading position as feedback. Two-way, engine-agnostic, no vendor.
 *
 * USAGE
 *   const host = new ReadAlongInputHost(el, {
 *     source: new SwitchSource({ keys: [' '], autoScan: true }),
 *   });
 *   await host.start();
 *
 * Word tagging is delegated to ../words.js so the same addressability works on
 * any content, not just a read-along element.
 */

import { DwellEngine } from './dwell.js';
import { SignalBridge } from './sources.js';
import { tagWords, TARGET_ATTR, WORD_CLASS } from './words.js';

/** Default dwell for word-by-word reading: shorter than a control, because
 *  reading is a flow activity and every word should not cost a second. */
const READING_DWELL_MS = 600;

export class ReadAlongInputHost {
  /**
   * @param {HTMLElement} el a <read-along> element
   * @param {object} options
   * @param {import('./sources.js').InputSource} options.source
   * @param {number} [options.dwellMs]
   * @param {boolean} [options.adaptive]
   * @param {Function} [options.onActivate] (tokenIndex, meta) — override the
   *   default seek behaviour (e.g. to log, or to drive something else)
   */
  constructor(el, options = {}) {
    this.el = el;
    this.source = options.source;
    this.onActivateHook = options.onActivate || null;
    this._words = null;

    this.dwell = new DwellEngine({
      dwellMs: options.dwellMs ?? READING_DWELL_MS,
      adaptive: options.adaptive !== false,
      onAdapt: options.onAdapt || null,
    });

    this.bridge = new SignalBridge({
      source: this.source,
      dwell: this.dwell,
      onActivate: (id, meta) => this._activate(id, meta),
      onFocus: (id) => this._paintFocus(id),
      onProgress: (id, ratio) => this._paintProgress(id, ratio),
      onCancel: options.onCancel || null,
    });
  }

  /** Number of addressable words found in the element. */
  get wordCount() { return this._words?.length ?? 0; }

  async start() {
    this._tag();
    await this.bridge.start();
  }

  stop() {
    this.bridge.stop();
    this._clearPaint();
  }

  /** Tag words as dwell targets, keeping the mapping back to token indexes. */
  _tag() {
    if (this._words) return;
    this._words = tagWords(this.el);
  }

  _activate(targetId, meta) {
    const i = this._indexOf(targetId);
    if (i < 0) return;
    const detail = { token: i, word: this._words[i]?.text, via: meta?.via };

    if (this.onActivateHook) {
      this.onActivateHook(i, detail);
    } else {
      this._seek(i);
    }

    this._clearPaint();
    this.el.dispatchEvent(
      new CustomEvent('dwell-activate', { bubbles: true, detail })
    );
  }

  /** Default behaviour: read from the chosen word. */
  _seek(i) {
    if (typeof this.el.seekToToken !== 'function') return;
    if (this.el.state === 'playing') {
      this.el.seekToToken(i);
    } else if (typeof this.el.play === 'function') {
      this.el.play();
      this.el.seekToToken(i);
    }
  }

  _indexOf(targetId) {
    const m = /^w(\d+)$/.exec(String(targetId || ''));
    return m ? Number(m[1]) : -1;
  }

  _paintFocus(targetId) {
    this._clearPaint();
    if (targetId === null) return;
    this._el(targetId)?.setAttribute('data-dwell-focus', '');
  }

  _paintProgress(targetId, ratio) {
    const el = this._el(targetId);
    if (!el) return;
    if (ratio >= 1) {
      // A completed dwell must not leave its fill painted — the activation
      // flash takes over from here. Without this the word keeps a full amber
      // ring after it has already been read.
      el.style.removeProperty('--dwell-progress');
      return;
    }
    el.style.setProperty('--dwell-progress', String(ratio));
  }

  _el(targetId) {
    if (!this.el.querySelector) return null;
    return this.el.querySelector(`[${TARGET_ATTR}="${targetId}"]`);
  }

  _clearPaint() {
    if (!this.el.querySelectorAll) return;
    for (const el of this.el.querySelectorAll('[data-dwell-focus]')) {
      el.removeAttribute('data-dwell-focus');
    }
    for (const el of this.el.querySelectorAll(`.${WORD_CLASS}`)) {
      el.style.removeProperty('--dwell-progress');
    }
  }
}
