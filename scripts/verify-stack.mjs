// verify-stack.mjs — drives the consent-gated stack demo over raw CDP.
// Probes live in files (scripts/*.js) so shell escaping cannot corrupt them.
import { readFileSync } from 'fs';

const PROBE = readFileSync(new URL('./roundtrip-probe.js', import.meta.url), 'utf8');

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.url.includes('stack.html'));
if (!page) { console.error('stack.html tab not found'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout')); } }, 30000);
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    return 'EXC: ' + (d.exception?.description?.split('\n')[0] || d.text);
  }
  return r.result?.value;
};

// Start from a clean, ungranted state.
await ev('localStorage.clear()');
await send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 3500));

console.log('gate at start  :', await ev("document.getElementById('gateVerdict').textContent"));

// --- while gated -----------------------------------------------------------
await ev("window.__probeTarget = 'w30'; window.__probeMs = 1600");
console.log('GATED   dwell  :', await ev(PROBE, true));

// --- grant and retry ------------------------------------------------------
await ev("document.getElementById('grantBtn').click()");
await new Promise((r) => setTimeout(r, 700));
console.log('gate now       :', await ev("document.getElementById('gateVerdict').textContent"));
console.log('stack states   :', await ev(
  "[...document.querySelectorAll('.stack .layer')].map(l => l.querySelector('.state').textContent).join(',')"
));

await ev("window.__probeTarget = 'w32'; window.__probeMs = 1600");
console.log('GRANTED dwell  :', await ev(PROBE, true));

// --- withdraw mid-dwell ---------------------------------------------------
await ev("window.__probeTarget = 'w34'; window.__probeMs = 300");
const midDwell = ev(PROBE, true);
await new Promise((r) => setTimeout(r, 400));
await ev("document.getElementById('withdrawBtn').click()");
console.log('MID-DWELL W/D  :', await midDwell);
console.log('gate after w/d :', await ev("document.getElementById('gateVerdict').textContent"));

console.log('log            :', await ev(
  "document.getElementById('log').textContent.trim().split(String.fromCharCode(10)).slice(0,5).join(' // ')"
));

ws.close();
process.exit(0);
