// Jev Voice side panel: the interface, and the agent's "hands". The local host (Native Messaging) decides;
// this panel reads pages and acts in them with chrome.scripting: no remote debugging, no focus stealing.
const $ = id => document.getElementById(id);
const HOST = 'jev_voice.host';
let port = null, recording = false, running = false, voiceReady = true, lastTab = null, myWindow = null, t0 = 0, retry = 1500;

// ------------------------------------------------------------------ settings
const SETTINGS = ['model', 'language', 'delay', 'confirm-on', 'autorun', 'whisper'];
async function loadSettings() {
  const saved = (await chrome.storage.local.get('settings')).settings || {};
  for (const id of SETTINGS) if (id in saved) {
    const el = $(id); if (el.type === 'checkbox') el.checked = saved[id]; else el.value = saved[id];
  }
}
function settings() {
  const s = {}; for (const id of SETTINGS) { const el = $(id); s[id] = el.type === 'checkbox' ? el.checked : el.value; }
  chrome.storage.local.set({settings: s});
  return {model: s.model, language: s.language, delay: Number(s.delay) || 0, confirm: s['confirm-on'], whisper: s.whisper,
    autorun: s.autorun};
}
for (const id of SETTINGS) $(id).addEventListener('change', settings);

// ------------------------------------------------------------------ activity log
function log(text, cls = '', ms = null) {
  const li = document.createElement('li'); if (cls) li.className = cls;
  li.textContent = text;
  if (ms != null) { const s = document.createElement('span'); s.className = 'ms'; s.textContent = `  ${(ms / 1000).toFixed(2)} s`; li.append(s); }
  $('log').append(li); li.scrollIntoView({block: 'nearest'});
}
function setRunning(on) {
  running = on; $('stop').disabled = !on && !recording; $('run').disabled = on; $('mic').disabled = on || !voiceReady;
}
function result(text, ok, tab) {
  $('result').hidden = false; $('result-text').textContent = text;
  $('result').className = 'result ' + (ok ? 'done' : 'fail');
  lastTab = tab ?? lastTab; $('show-tab').hidden = lastTab == null;
}

// ------------------------------------------------------------------ connection to the host
function connect() {
  try { port = chrome.runtime.connectNative(HOST); } catch (e) { $('host').textContent = 'host missing'; $('host').className = 'pill bad'; return; }
  const p = port;
  port.onMessage.addListener(m => onHost(m, p));
  port.onDisconnect.addListener(() => {
    const why = chrome.runtime.lastError?.message || '';
    $('host').textContent = 'host disconnected'; $('host').className = 'pill bad'; $('host').title = why;
    port = null; setRunning(false); recording = false; micLabel();
    if (why) log('Host: ' + why, 'err');
    setTimeout(connect, retry); retry = Math.min(retry * 2, 30000);
  });
  port.postMessage({type: 'ping'});
}
function post(msg) {
  if (port) { port.postMessage(msg); return true; }
  log('The local host is not running (see README, Install).', 'err'); return false;
}

async function onHost(m, from) {
  switch (m.type) {
    case 'pong': {
      retry = 1500;
      const missing = Object.entries(m.keys).filter(([, v]) => !v).map(([k]) => k);
      const voiceMissing = Object.entries(m.voice_keys || {}).filter(([, v]) => !v).map(([k]) => k);
      const ok = m.claude && m.jev && !missing.length, voice = m.recorder && !voiceMissing.length;
      $('host').textContent = !ok ? 'incomplete' : voice ? 'ready' : 'ready, typing only';
      $('host').className = 'pill ' + (ok ? 'ok' : 'bad');
      voiceReady = voice; $('mic').disabled = !voice || running; $('mic').title = voice ? '' : 'Dictation is not set up (see the activity list)';
      if (!m.claude) log('claude CLI not found (set JEV_VOICE_CLAUDE in the config file)', 'err');
      if (!m.jev) log('jev-ultrafast is not installed: run bin/install', 'err');
      if (missing.length) log('Missing keys: ' + missing.join(', '), 'err');
      if (!m.recorder) log('Dictation off: no recorder found (pw-record, parecord or arecord). Typed commands work.');
      if (voiceMissing.length) log('Dictation off: missing ' + voiceMissing.join(', ') + '. Typed commands work.');
      break;
    }
    case 'rpc': return answerRpc(m, from);
    case 'busy': setRunning(false); log(m.text, 'err'); break;
    case 'recording': recording = m.on; micLabel(); $('stop').disabled = !running && !recording; break;
    case 'transcript':
      $('text').value = m.text;
      if (m.final) {
        log('Dictation: "' + (m.text || '…') + '"', '', performance.now() - t0);
        if (m.cancelled) log('Dictation stopped: nothing runs (you can still edit the text).');
        else if (m.text && settings().autorun) start();
      }
      break;
    case 'status': log(m.text); break;
    case 'plan': {
      const p = m.plan;
      log(`Plan (${p.steps.length} step${p.steps.length > 1 ? 's' : ''}, ${p.use_current_tab ? 'this tab' : 'new tab'})`, '', m.ms);
      break;
    }
    case 'step': log(`Step ${m.step}: ${m.goal}` + (m.url ? `  → ${m.url}` : ''), 'step'); lastTab = m.tab; break;
    case 'decision':
      if (['DONE', 'BLOCKED'].includes(m.choice)) log(m.choice === 'DONE' ? 'Jev: goal reached' : 'Jev: blocked', '', m.ms);
      break;
    case 'action': log(`${m.kind === 'fill' ? 'Type' : m.kind === 'select' ? 'Select' : m.kind === 'scroll' ? 'Scroll' : m.kind === 'wait' ? 'Wait' : 'Click'}: ${m.label}`, '', m.ms); break;
    case 'confirm':
      $('confirm').hidden = false; $('confirm-text').textContent = m.text; break;
    case 'finished':
      $('confirm').hidden = true; setRunning(false);
      result(m.text, m.result === 'done' || m.result === 'reply', m.tab);
      log(`End (${m.result})`, m.result === 'done' ? '' : 'err', m.ms ?? null);
      break;
    case 'error': log(m.text, 'err'); break;
  }
}

// ------------------------------------------------------------------ voice
function micLabel() { $('mic').textContent = recording ? '■ Finish dictation' : '🎙 Speak'; $('mic').classList.toggle('rec', recording); }
$('mic').onclick = () => {
  if (recording) { post({type: 'record_stop'}); return; }
  $('text').value = ''; $('result').hidden = true; t0 = performance.now();
  post({type: 'record_start', settings: settings()});
};

// ------------------------------------------------------------------ running a command
async function currentTab() {
  myWindow ??= (await chrome.windows.getCurrent()).id;
  // The tab you are working in: the active one, or the last used one when the panel itself is open in a tab.
  const own = (await chrome.tabs.getCurrent())?.id;  // undefined in the side panel
  const tabs = (await chrome.tabs.query({windowId: myWindow})).filter(t => t.id !== own);
  return tabs.find(t => t.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}
async function start() {
  const instruction = $('text').value.trim();
  if (!instruction || running) return;
  for (let i = 0; !port && i < 30; i++) await sleep(100);  // panel just opened: the host is still connecting
  $('log').textContent = ''; $('result').hidden = true; setRunning(true); t0 = performance.now();
  let tab = null, text = '';
  try {
    tab = await currentTab();
    const [r] = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => document.body?.innerText.slice(0, 600) || ''});
    text = r?.result || '';
  } catch (e) { /* internal browser page: no context */ }
  log('Command: "' + instruction + '"');
  const sent = post({type: 'run', instruction, settings: settings(),
        context: {tab: tab?.id ?? null, url: tab?.url || '', title: tab?.title || '', text}});
  if (!sent) setRunning(false);
}
$('run').onclick = start;
$('stop').onclick = () => { post({type: 'stop'}); log('Stop requested', 'err'); };
$('confirm-yes').onclick = () => { $('confirm').hidden = true; post({type: 'confirm_answer', ok: true}); };
$('confirm-no').onclick = () => { $('confirm').hidden = true; post({type: 'confirm_answer', ok: false}); };
$('show-tab').onclick = async () => { if (lastTab != null) await chrome.tabs.update(lastTab, {active: true}); };
$('text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start(); });

// ------------------------------------------------------------------ the "hands" (RPC from the host)
async function answerRpc(m, from) {
  let reply;
  try { reply = {result: await OPS[m.op](m.args)}; }
  catch (e) { reply = {error: String(e?.message || e), stale: !!e?.stale}; }
  if (from === port) from.postMessage({type: 'rpc_result', id: m.id, ...reply});  // never to a previous host
}
const stale = msg => Object.assign(new Error(msg), {stale: true});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function inject(tab, spec) {
  const [r] = await chrome.scripting.executeScript({target: {tabId: tab}, ...spec});
  return r?.result;
}
const snapshot = tab => inject(tab, {files: ['snapshot.js']});

const OPS = {
  async observe({tab}) {
    try { return await snapshot(tab); }
    catch (e) { throw stale(String(e.message || e)); }  // page is navigating: the host retries
  },
  async fresh({tab, marker}) {
    const s = await snapshot(tab).catch(() => null);
    return !!s && same(s.marker, marker);
  },
  async act({tab, action, text, page_key, guard}) {
    const r = await inject(tab, {func: actInPage, args: [action, text ?? null, page_key, guard ?? null]});
    if (!r?.ok) throw stale(r?.why || 'action not possible');
    // Let the page react (setTimeout: requestAnimationFrame does not run in a background tab).
    await sleep(action.kind === 'fill' ? 300 : action.kind === 'wait' ? 400 : 200);
    return r;
  },
  async probe({tab}) { return inject(tab, {func: probeInPage}); },
  async navigate({tab, url, expect}) {
    if (!sameSite(url, expect)) throw new Error(`refused: ${url} is not on ${expect}`);
    myWindow ??= (await chrome.windows.getCurrent()).id;
    if (tab == null) {
      const cur = await currentTab();
      const created = await chrome.tabs.create({url: 'about:blank', active: false, windowId: myWindow, index: (cur?.index ?? 0) + 1});
      tab = created.id;
    }
    const loaded = waitLoaded(tab);
    await chrome.tabs.update(tab, {url});
    await loaded;
    return tab;
  },
};

// The requested page has loaded: first see its load start, so the previous page's "complete" does not count.
function waitLoaded(tab, timeout = 30000) {
  return new Promise(resolve => {
    let started = false, done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(on); setTimeout(resolve, 300); };
    const on = (id, info) => {
      if (id !== tab) return;
      if (info.status === 'loading' || info.url) started = true;
      if (started && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(on);
    setTimeout(finish, timeout);
  });
}

// Adapted from the input step of jev_ultrafast/browser.py in browser-use/jev-ultrafast (MIT, see
// THIRD_PARTY_NOTICES.md): the same hit test, done with DOM events instead of the DevTools protocol.
// Runs INSIDE the page (the extension's isolated world, the same as snapshot.js, so window.__jevFast is shared).
// Same guards as Jev: the observed element, still there, visible, enabled and not covered; otherwise "stale".
function actInPage(action, text, pageKey, guard) {
  const c = window.__jevFast;
  if (!c) return {why: 'page reloaded'};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (action.kind === 'wait') return {ok: true};
  if (action.kind === 'scroll') {
    const el = document.scrollingElement || document.documentElement;
    const before = el.scrollTop; el.scrollBy(0, action.delta);
    if (el.scrollTop === before) {  // the page scrolls inside a container: the one under the viewport centre
      let n = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      while (n && !(n.scrollHeight > n.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(n).overflowY))) n = n.parentElement;
      n?.scrollBy(0, action.delta);
    }
    return {ok: true};
  }
  const e = c.nodes.get(action.node);
  if (!e?.isConnected) return {why: 'element gone'};
  if (!same(c.pageKey(), pageKey)) return {why: 'page changed'};
  if (!same(c.guard(e), guard)) return {why: 'element changed'};
  if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return {why: 'element disabled'};
  if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return {why: 'read-only'};
  const F = c.frameOf(e); if (!F) return {why: 'frame gone'};
  const spot = () => {
    const r = e.getBoundingClientRect(), lx = r.x + r.width / 2, ly = r.y + r.height / 2, x = lx + F.ox, y = ly + F.oy;
    if (!r.width || !r.height || x < F.clip.l || y < F.clip.t || x >= F.clip.r || y >= F.clip.b) return null;
    const at = (e.getRootNode().elementFromPoint ? e.getRootNode() : F.doc).elementFromPoint(lx, ly);
    if (!e.contains(at) || (F.el && document.elementFromPoint(x, y) !== F.el)) return null;
    return {lx, ly};
  };
  let hit = spot();
  if (!hit) { e.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'}); hit = spot(); }
  if (!hit) return {why: 'element covered'};
  const W = F.win;
  if (action.kind === 'select') {
    if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value && !o.disabled)) return {why: 'option missing'};
    e.value = action.value;
    e.dispatchEvent(new W.Event('input', {bubbles: true})); e.dispatchEvent(new W.Event('change', {bubbles: true}));
    return {ok: true};
  }
  const o = {bubbles: true, cancelable: true, composed: true, view: W, clientX: hit.lx, clientY: hit.ly, button: 0, buttons: 1};
  const p = {...o, pointerId: 1, pointerType: 'mouse', isPrimary: true};
  e.dispatchEvent(new W.PointerEvent('pointerdown', p));
  e.dispatchEvent(new W.MouseEvent('mousedown', o));
  if (typeof e.focus === 'function') e.focus({preventScroll: true});
  e.dispatchEvent(new W.PointerEvent('pointerup', {...p, buttons: 0}));
  e.dispatchEvent(new W.MouseEvent('mouseup', {...o, buttons: 0}));
  if (action.kind === 'click') { e.dispatchEvent(new W.MouseEvent('click', {...o, buttons: 0})); return {ok: true}; }
  // Typing: select everything, then insert like a keystroke (execCommand), else through the native setter.
  if ('select' in e && typeof e.select === 'function') e.select();
  else { const sel = W.getSelection(), range = F.doc.createRange(); range.selectNodeContents(e); sel.removeAllRanges(); sel.addRange(range); }
  const norm = v => (v || '').replace(/\s+/g, ' ').trim();
  const read = () => norm('value' in e ? e.value : e.innerText);
  let done = false;
  try { done = F.doc.execCommand('insertText', false, text); } catch (err) { done = false; }
  if (done && read()) return {ok: true};  // the field took the input (even if it reformats it)
  if ('value' in e) {
    const proto = e.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, text);
    e.dispatchEvent(new W.InputEvent('input', {bubbles: true, inputType: 'insertText', data: text}));
    e.dispatchEvent(new W.Event('change', {bubbles: true}));
  } else return {why: 'rich editor: the input did not take'};  // never textContent (it would break the editor)
  return read() ? {ok: true} : {why: 'the input did not take'};
}

// Login, captcha or one-time code: the agent stops and hands control back to you.
function probeInPage() {
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) docs.push(f.contentDocument); } catch (e) {} }
  const vis = e => e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) && e.getBoundingClientRect().width > 0;
  for (const d of docs) {
    if ([...d.querySelectorAll('input[autocomplete="one-time-code"]')].some(vis)) return '2fa';
  }
  const cap = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|captcha-delivery|arkoselabs|funcaptcha/i;
  if ([...document.querySelectorAll('iframe')].some(f => cap.test(f.src || '') && vis(f))) return 'captcha';
  for (const d of docs) {
    if ([...d.querySelectorAll('input[type="password"]')].some(vis)) return 'login';
  }
  return null;
}

loadSettings().then(connect);
