/**
 * words.test.mjs — the addressability contract.
 *
 * The load-bearing property: wrapping words must not change the TEXT. A
 * component that tokenizes the same content (read-along does) computes its
 * offsets from textContent — if wrapping altered a single character, every
 * highlight would land on the wrong word. These tests run against a minimal
 * DOM stub so the offset math is provable without a browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitWords, tagWords, untagWords, TARGET_ATTR } from '../src/words.js';

// -- splitWords -------------------------------------------------------------

test('splitWords produces whitespace tokens with source offsets', () => {
  const text = 'Hello world, this is read-along.';
  const words = splitWords(text);
  assert.deepEqual(
    words.map((w) => w.text),
    ['Hello', 'world,', 'this', 'is', 'read-along.']
  );
  for (const w of words) {
    assert.equal(text.slice(w.start, w.end), w.text);
  }
  assert.deepEqual(words.map((w) => w.index), [0, 1, 2, 3, 4]);
});

test('splitWords collapses whitespace runs without losing offsets', () => {
  const text = 'a\n\n  b\t c';
  const words = splitWords(text);
  assert.deepEqual(words.map((w) => w.text), ['a', 'b', 'c']);
  for (const w of words) assert.equal(text.slice(w.start, w.end), w.text);
});

test('splitWords handles empty and whitespace-only input', () => {
  assert.deepEqual(splitWords(''), []);
  assert.deepEqual(splitWords('   \n\t '), []);
});

test('splitWords is codepoint-safe for accented text', () => {
  const text = 'café naïve';
  const words = splitWords(text);
  assert.deepEqual(words.map((w) => w.text), ['café', 'naïve']);
  for (const w of words) assert.equal(text.slice(w.start, w.end), w.text);
});

// -- tagWords: the text-preservation contract -------------------------------

/**
 * A minimal DOM: one element with a single text node. Enough to prove the
 * wrapping math without pulling in a DOM implementation.
 */
function makeDom(text) {
  const textNode = { nodeType: 3, data: text, parentNode: null };
  const root = {
    ownerDocument: null,
    childNodes: [textNode],
    _spans: [],
    get textContent() {
      return this.childNodes.map((n) => n.data ?? n.textContent).join('');
    },
    querySelector() { return null; },
    querySelectorAll(sel) {
      if (sel.includes(TARGET_ATTR)) return this._spans;
      return [];
    },
  };
  textNode.parentNode = root;

  const doc = {
    createTreeWalker() {
      let done = false;
      return { nextNode: () => (done ? null : ((done = true), textNode)) };
    },
    createTextNode(data) {
      return { nodeType: 3, data, parentNode: null };
    },
    createDocumentFragment() {
      const kids = [];
      return {
        childNodes: kids,
        appendChild(n) { kids.push(n); return n; },
      };
    },
    createElement(tag) {
      const attrs = {};
      const el = {
        tagName: tag.toUpperCase(),
        textContent: '',
        className: '',
        parentNode: null,
        setAttribute(k, v) { attrs[k] = v; },
        getAttribute(k) { return attrs[k] ?? null; },
      };
      root._spans.push(el);
      return el;
    },
  };
  root.ownerDocument = doc;

  // replaceChild on the text node's parent: splice the fragment in place.
  const origReplace = (newNode, oldNode) => {
    const frag = newNode;
    const idx = root.childNodes.indexOf(oldNode);
    if (idx >= 0) {
      root.childNodes.splice(idx, 1, ...(frag.childNodes || [frag]));
    }
  };
  Object.defineProperty(root, 'replaceChild', { value: origReplace });

  return { root, textNode };
}

test('tagWords wraps each word and PRESERVES the text exactly', () => {
  const text = 'Reading while listening helps.';
  const { root } = makeDom(text);
  const words = tagWords(root);

  assert.equal(words.length, 4);
  assert.equal(root.textContent, text, 'wrapping must not alter the text');
  assert.equal(root._spans.length, 4);
  assert.deepEqual(
    root._spans.map((s) => s.getAttribute(TARGET_ATTR)),
    ['w0', 'w1', 'w2', 'w3']
  );
  assert.deepEqual(
    root._spans.map((s) => s.textContent),
    ['Reading', 'while', 'listening', 'helps.']
  );
});

test('tagWords leaves the inter-word whitespace intact', () => {
  // The spaces between words must survive as text nodes, or the rendered
  // prose would collapse into one run-on string.
  const text = 'one two three';
  const { root } = makeDom(text);
  tagWords(root);
  assert.equal(root.textContent, text);
  const textPieces = root.childNodes.filter((n) => n.nodeType === 3).map((n) => n.data);
  // The single spaces between words survive; empty nodes are not emitted.
  assert.deepEqual(textPieces, [' ', ' ']);
});

test('tagWords is idempotent — a second call does not double-wrap', () => {
  const text = 'alpha beta';
  const { root } = makeDom(text);
  const first = tagWords(root);
  assert.equal(first.length, 2);
  // Second call sees existing targets and reports them rather than re-wrapping.
  const second = tagWords(root);
  assert.equal(second.length, 2, 'must not create a second layer of spans');
  assert.equal(root.textContent, text);
});

test('tagWords on empty content returns no words', () => {
  const { root } = makeDom('');
  assert.deepEqual(tagWords(root), []);
});

test('tagWords on an element with no ownerDocument is a no-op', () => {
  assert.deepEqual(tagWords(null), []);
  assert.deepEqual(tagWords({}), []);
});
