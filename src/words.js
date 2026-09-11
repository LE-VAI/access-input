/**
 * words.js — tag the words in an element as addressable dwell targets.
 *
 * An input layer is only useful if a target exists to land on. Screen readers
 * have the accessibility tree; a dwell engine has nothing unless the words are
 * individually addressable. This module turns a block of prose into addressable
 * words WITHOUT changing how it looks or reads:
 *
 *   - each word is wrapped in an inline <span> carrying data-dwell-target
 *   - text is never altered, collapsed, or re-ordered
 *   - offsets are preserved, so a component that tokenizes the same text
 *     (like <read-along>) still sees identical character positions
 *
 * That last property is the load-bearing one. read-along computes its token
 * offsets from textContent; if wrapping changed the text at all, every
 * highlight would land on the wrong word. So the wrapping is purely additive:
 * the same characters, in the same order, in more nodes.
 *
 * Extracted as a public function because the adapter is not the only thing
 * that needs it — any content that wants to be dwellable can call this, which
 * is what makes the input layer content-agnostic rather than reading-specific.
 */

/** Attribute every target carries. Sources look for this; nothing else should. */
export const TARGET_ATTR = 'data-dwell-target';

/** Class applied to wrapped words, for styling the dwell affordance. */
export const WORD_CLASS = 'ra-dwell-word';

/**
 * Split text into word records with source offsets.
 * Whitespace-delimited (\S+), matching read-along's tokenizer so the two
 * produce identical indexes for the same text.
 *
 * @param {string} text
 * @returns {Array<{text: string, start: number, end: number, index: number}>}
 */
export function splitWords(text) {
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    words.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
      index: words.length,
    });
  }
  return words;
}

/**
 * Wrap every word inside `el` in a target span, in place.
 *
 * Mutates the DOM but not the text. Safe to call once per element; calling it
 * again on already-wrapped content would double-wrap, so it checks first.
 *
 * @param {HTMLElement} el
 * @param {object} [options]
 * @param {boolean} [options.onlyTextNodes=false] leave words inside <a>/<button>
 *   unwrapped, so a link keeps behaving like a link
 * @returns {Array<{text: string, start: number, end: number, index: number}>}
 */
export function tagWords(el, options = {}) {
  if (!el || !el.ownerDocument) return [];
  if (el.querySelector(`[${TARGET_ATTR}]`)) {
    // Already tagged — report what is there rather than double-wrapping.
    return Array.from(el.querySelectorAll(`[${TARGET_ATTR}]`)).map((node, i) => ({
      text: node.textContent,
      start: -1,
      end: -1,
      index: i,
      id: node.getAttribute(TARGET_ATTR),
    }));
  }

  const doc = el.ownerDocument;
  const words = splitWords(el.textContent || '');
  if (!words.length) return words;

  const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes = [];
  let n;
  while ((n = walker.nextNode()) !== null) {
    if (options.onlyTextNodes && isInteractive(n.parentElement)) continue;
    nodes.push(n);
  }

  // Walk text nodes in document order, tracking the absolute offset so each
  // word can be located in whichever node holds it. A word split across two
  // nodes (e.g. "<b>hel</b>lo") is wrapped as its fragments — the text is
  // preserved even though the word spans a boundary.
  let absBase = 0;
  for (const node of nodes) {
    const nodeStart = absBase;
    const nodeEnd = absBase + node.data.length;
    absBase = nodeEnd;

    const inside = words.filter((w) => w.start < nodeEnd && w.end > nodeStart);
    if (!inside.length) continue;

    const frag = doc.createDocumentFragment();
    let cursor = 0;
    for (const w of inside) {
      const localStart = Math.max(0, w.start - nodeStart);
      const localEnd = Math.min(node.data.length, w.end - nodeStart);
      if (localStart > cursor) {
        frag.appendChild(doc.createTextNode(node.data.slice(cursor, localStart)));
      }
      const span = doc.createElement('span');
      span.textContent = node.data.slice(localStart, localEnd);
      span.setAttribute(TARGET_ATTR, `w${w.index}`);
      span.className = WORD_CLASS;
      frag.appendChild(span);
      cursor = localEnd;
    }
    if (cursor < node.data.length) {
      frag.appendChild(doc.createTextNode(node.data.slice(cursor)));
    }
    node.parentNode.replaceChild(frag, node);
  }

  return words;
}

function isInteractive(el) {
  if (!el || !el.tagName) return false;
  return ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}

/** Remove target wrapping, restoring the original text nodes. */
export function untagWords(el) {
  if (!el || !el.querySelectorAll) return;
  for (const span of el.querySelectorAll(`[${TARGET_ATTR}]`)) {
    const parent = span.parentNode;
    if (!parent) continue;
    parent.replaceChild(el.ownerDocument.createTextNode(span.textContent), span);
    parent.normalize();
  }
}
