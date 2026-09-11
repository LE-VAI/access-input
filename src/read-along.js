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
 * The adapter tags every word in the element with data-dwell-target so the
 * existing sources work unchanged — no source needs to know what a "word" is.
 */

import { DwellEngine } from './dwell.js';
import { SignalBridge } from './sources.js';

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
   */
  constructor(el, options = {}) {
    this.el = el;
    this.source = options.source;
    this._tagged = false;

    this.dwell = new DwellEngine({
      dwellMs: options.dwellMs ?? READING_DWELL_MS,
      adaptive: options.adaptive !== false,
      onProgress: (id, ratio) => this._paintProgress(id, ratio),
      onAdapt: options.onAdapt || null,
    });

    this.bridge = new SignalBridge({
      source: this.source,
      dwell: this.dwell,
      onActivate: (id, meta) => this._activate(id, meta),
      onFocus: (id) => this._paintFocus(id),
      onProgress: (id, ratio) => this._paintProgress(id, ratio),
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

  /**
   * Tag each word as a dwell target. read-along tokenizes internally, so the
   * adapter does the same whitespace split to produce stable ids — and keeps
   * the mapping so an activation can be translated back to a token index.
   */
  _tag() {
    if (this._tagged) return;
    const text = this.el.textContent || '';
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      words.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    this._words = words;
    // Wrap each word so it can carry an attribute and be hit-tested. This is
    // display-preserving: the spans are inline and unstyled, and read-along
    // tokenizes the same text content, so offsets are unchanged.
    if (!words.length) return;
    this._wrapWords(words);
    this._tagged = true;
  }

  _wrapWords(words) {
    // Walk text nodes and wrap in place, right-to-left so earlier offsets
    // stay valid while mutating.
    const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode()) !== null) nodes.push(n);

    let offset = 0;
    for (const node of nodes) {
      const nodeStart = offset;
      offset += node.data.length;
      // Words fully inside this node get wrapped.
      const inside = words.filter(
        (w) => w.start >= nodeStart && w.end <= nodeStart + node.data.length
      );
      if (!inside.length) continue;
      const frag = document.createDocumentFragment();
      let cursor = 0;
      for (const w of inside) {
        const localStart = w.start - nodeStart;
        const localEnd = w.end - nodeStart;
        if (localStart > cursor) {
          frag.appendChild(document.createTextNode(node.data.slice(cursor, localStart)));
        }
        const span = document.createElement('span');
        span.textContent = node.data.slice(localStart, localEnd);
        span.setAttribute('data-dwell-target', `w${words.indexOf(w)}`);
        span.className = 'ra-dwell-word';
        frag.appendChild(span);
        cursor = localEnd;
      }
      if (cursor < node.data.length) {
        frag.appendChild(document.createTextNode(node.data.slice(cursor)));
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  _activate(targetId) {
    const i = this._indexOf(targetId);
    if (i < 0) return;
    // Word-level seek is the read-along API; fall back to a plain play when
    // the element predates seek support.
    if (typeof this.el.seekToToken === 'function' && this.el.state === 'playing') {
      this.el.seekToToken(i);
    } else if (typeof this.el.play === 'function') {
      this.el.play();
      if (typeof this.el.seekToToken === 'function') this.el.seekToToken(i);
    }
    this._clearPaint();
    this.el.dispatchEvent(
      new CustomEvent('dwell-activate', {
        bubbles: true,
        detail: { token: i, word: this._words[i]?.text },
      })
    );
  }

  _indexOf(targetId) {
    const m = /^w(\d+)$/.exec(String(targetId || ''));
    return m ? Number(m[1]) : -1;
  }

  _paintFocus(targetId) {
    this._clearPaint();
    if (targetId === null) return;
    const el = this._el(targetId);
    if (el) el.setAttribute('data-dwell-focus', '');
  }

  _paintProgress(targetId, ratio) {
    const el = this._el(targetId);
    if (el) el.style.setProperty('--dwell-progress', String(ratio));
  }

  _el(targetId) {
    if (!this.el.querySelector) return null;
    return this.el.querySelector(`[data-dwell-target="${targetId}"]`);
  }

  _clearPaint() {
    if (!this.el.querySelectorAll) return;
    for (const el of this.el.querySelectorAll('[data-dwell-focus]')) {
      el.removeAttribute('data-dwell-focus');
    }
    for (const el of this.el.querySelectorAll('.ra-dwell-word')) {
      el.style.removeProperty('--dwell-progress');
    }
  }
}
