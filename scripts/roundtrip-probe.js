// roundtrip-probe.js — full-stack round trip against the consent-gated demo.
// Loaded from a file so shell escaping cannot corrupt the expression.
(async () => {
  const target = window.__probeTarget || 'w30';
  const holdMs = window.__probeMs || 1600;
  const reader = document.getElementById('reader');
  const t = reader.querySelector('[data-dwell-target="' + target + '"]');
  if (!t) return JSON.stringify({ error: 'no target ' + target });

  t.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 400));

  const rect = t.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const activations = () =>
    document.getElementById('log').textContent
      .split('\n')
      .filter((l) => l.indexOf('ACTIVATE') !== -1).length;

  const before = activations();
  const stream = setInterval(() => {
    reader.dispatchEvent(
      new PointerEvent('pointermove', { clientX: cx, clientY: cy, bubbles: true })
    );
  }, 30);

  await new Promise((r) => setTimeout(r, holdMs));
  clearInterval(stream);
  await new Promise((r) => setTimeout(r, 500));

  return JSON.stringify({
    word: t.textContent,
    delta: activations() - before,
    readerState: reader.state,
    activeToken: reader.activeToken,
    highlightSize: (CSS.highlights.get('read-along-word') || { size: -1 }).size,
  });
})()
