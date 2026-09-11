// probe-readalong.mjs — read the demo's live state over raw CDP.
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.url.includes('read-along.html'));
if (!page) { console.error('tab not found'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const msgId = ++id;
  pending.set(msgId, { res, rej });
  ws.send(JSON.stringify({ id: msgId, method, params }));
  setTimeout(() => {
    if (pending.has(msgId)) { pending.delete(msgId); rej(new Error('timeout')); }
  }, 20000);
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const READ_STATE = [
  '(function () {',
  '  var reader = document.getElementById("reader");',
  '  var hl = CSS.highlights.get("read-along-word");',
  '  return [',
  '    "state=" + reader.state,',
  '    "activeToken=" + reader.activeToken,',
  '    "markIdx=" + (reader._highlighter ? reader._highlighter._markIndex : "n/a"),',
  '    "highlightSize=" + (hl ? hl.size : "none"),',
  '    "engineToken=" + (reader._engine ? reader._engine._tokenIndex : "n/a"),',
  '    "log=" + document.getElementById("log").textContent.trim().split("\\n").slice(0, 3).join(" // ")',
  '  ].join(" | ");',
  '})()',
].join('\n');

const PLACE = [
  '(function () {',
  '  var reader = document.getElementById("reader");',
  '  var t = reader.querySelector(\'[data-dwell-target="w30"]\');',
  '  t.scrollIntoView({ block: "center" });',
  '  return t.textContent;',
  '})()',
].join('\n');

const STREAM_ON = [
  '(function () {',
  '  var reader = document.getElementById("reader");',
  '  var t = reader.querySelector(\'[data-dwell-target="w30"]\');',
  '  var r = t.getBoundingClientRect();',
  '  window.__cx = r.left + r.width / 2;',
  '  window.__cy = r.top + r.height / 2;',
  '  var under = document.elementFromPoint(window.__cx, window.__cy);',
  '  window.__under = under ? under.getAttribute("data-dwell-target") : "NONE";',
  '  window.__stream = setInterval(function () {',
  '    reader.dispatchEvent(new PointerEvent("pointermove", {',
  '      clientX: window.__cx, clientY: window.__cy, bubbles: true }));',
  '  }, 25);',
  '  return window.__under;',
  '})()',
].join('\n');

const STREAM_OFF = 'clearInterval(window.__stream); "stopped"';

const evalOn = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result?.value;
};

// Quiet any leftover speech and clear the log.
await evalOn('speechSynthesis.cancel(); "ok"');
await evalOn('document.getElementById("log").textContent = ""; "ok"');

console.log('word  :', await evalOn(PLACE));
await new Promise((r) => setTimeout(r, 400));
console.log('under :', await evalOn(STREAM_ON));
await new Promise((r) => setTimeout(r, 2600));
console.log('after :', await evalOn(READ_STATE));
await evalOn(STREAM_OFF);

ws.close();
process.exit(0);
