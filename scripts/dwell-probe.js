// dwell-probe.js — a CDP-evaluation body to test the stack demo's gate.
// Kept as a file so shell escaping cannot corrupt it.
(async () => {
  const target = window.__probeTarget || 'w20';
  const reader = document.getElementById('reader');
  const t = reader.querySelector('[data-dwell-target="' + target + '"]');
  if (!t) return JSON.stringify({ error: 'no target ' + target });

  t.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 400));

  const rect = t.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const under = document.elementFromPoint(cx, cy);
  const underId = under ? under.getAttribute('data-dwell-target') : null;

  const count = () =>
    document.getElementById('log').textContent
      .split('\n')
      .filter((l) => l.indexOf('ACTIVATE') !== -1).length;

  const before = count();
  const stream = setInterval(() => {
    reader.dispatchEvent(
      new PointerEvent('pointermove', { clientX: cx, clientY: cy, bubbles: true })
    );
  }, 25);

  const samples = [];
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 100));
    samples.push(t.style.getPropertyValue('--dwell-progress') || null);
  }
  clearInterval(stream);
  await new Promise((r) => setTimeout(r, 400));

  return JSON.stringify({
    word: t.textContent,
    hitTarget: underId,
    painted: samples.some((v) => v && Number(v) > 0),
    activations: count() - before,
    readerState: reader.state,
  });
})()
