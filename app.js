import * as db from './db.js';
import * as ai from './ai.js';
import { createMap, clusterColor } from './map.js';

const $ = (id) => document.getElementById(id);
const input = $('input'), mic = $('mic'), gear = $('gear'), scrim = $('scrim');
const detail = $('detail'), settings = $('settings');

// ---------- 맵 ----------
const map = createMap($('map'), { onTap: openDetail });
let current = null; // 상세 보기 중인 아이디어 id

async function refresh() {
  const [ideas, clusters] = await Promise.all([db.all('ideas'), db.all('clusters')]);
  ideas.sort((a, b) => a.createdAt - b.createdAt);
  map.update(ideas, clusters);
  $('empty').classList.toggle('hide', ideas.length > 0);
  if (current) {
    const it = ideas.find((i) => i.id === current);
    if (it) fillDetail(it, clusters); else closeSheets();
  }
  updateStatus(ideas);
}

ai.onChange(async (state) => {
  gear.className = state === 'idle' ? '' : state;
  await refresh();
});

function kick(opts) { ai.runQueue(opts); }
window.addEventListener('online', () => kick());
document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });

// ---------- 기록 ----------
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.3) + 'px';
  mic.classList.toggle('send', input.value.trim().length > 0 && !recognizing);
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
});
$('dock').addEventListener('submit', (e) => { e.preventDefault(); save(); });

async function save(textArg) {
  const text = (textArg ?? input.value).trim();
  if (!text) return;
  const now = Date.now();
  await db.put('ideas', { id: db.uid(), text, createdAt: now, updatedAt: now, links: [], clusterId: null, status: 'pending' });
  input.value = '';
  autosize();
  input.blur();
  if (navigator.vibrate) navigator.vibrate(10);
  await refresh();
  kick();
}

// ---------- 음성 ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recognizing = false, finalText = '', baseText = '';

function startVoice() {
  if (!SR) return fallbackToKeyboard();
  try {
    rec = new SR();
    rec.lang = 'ko-KR';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
  } catch { return fallbackToKeyboard(); }

  baseText = input.value.trim();
  finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    input.value = [baseText, (finalText + interim).trim()].filter(Boolean).join(' ');
    autosize();
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
      recognizing = false; rec = null; setRec(false);
      fallbackToKeyboard();
    }
  };
  rec.onend = () => {
    const had = recognizing;
    recognizing = false; rec = null; setRec(false);
    if (had && input.value.trim()) save();
  };
  try {
    rec.start();
    recognizing = true; setRec(true);
  } catch { fallbackToKeyboard(); }
}

function stopVoice() { try { rec?.stop(); } catch { recognizing = false; setRec(false); } }

function setRec(on) {
  mic.classList.toggle('rec', on);
  if (navigator.vibrate) navigator.vibrate(on ? 15 : 8);
  autosize();
}

// 음성 인식을 못 쓰면 키보드 받아쓰기로
function fallbackToKeyboard() {
  input.focus();
  input.classList.add('hint');
  setTimeout(() => input.classList.remove('hint'), 1800);
  toast('⌨︎ 🎙');
}

mic.addEventListener('click', () => {
  if (recognizing) return stopVoice();
  if (input.value.trim()) return save();
  startVoice();
});

// ---------- 상세 ----------
const fmt = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

async function openDetail(id) {
  const [it, clusters] = await Promise.all([db.get('ideas', id), db.all('clusters')]);
  if (!it) return;
  current = id;
  setEditing(false);
  fillDetail(it, clusters);
  openSheet(detail);
  map.select(id);
  map.focus(id);
}

function fillDetail(it, clusters) {
  const c = clusters.find((x) => x.id === it.clusterId);
  const key = $('d-key');
  key.textContent = it.keyword ? (c ? `${it.keyword}  ·  ${c.name}` : it.keyword) : '…';
  key.style.color = it.keyword ? clusterColor(c ? c.color : null) : 'var(--dim)';
  if ($('d-edit').hidden) $('d-text').textContent = it.text;
  $('d-date').textContent = fmt.format(new Date(it.createdAt));
}

function setEditing(on) {
  $('d-edit').hidden = !on;
  $('d-text').hidden = on;
  $('d-save').hidden = !on;
  $('d-editbtn').hidden = on;
  disarm();
}

$('d-editbtn').addEventListener('click', async () => {
  const it = await db.get('ideas', current);
  if (!it) return;
  $('d-edit').value = it.text;
  setEditing(true);
  $('d-edit').focus();
});

$('d-save').addEventListener('click', async () => {
  const it = await db.get('ideas', current);
  const text = $('d-edit').value.trim();
  if (!it || !text) return;
  if (text !== it.text) {
    it.text = text;
    it.updatedAt = Date.now();
    it.status = 'pending'; // 키워드·연결 다시 처리
    it.fails = 0;
    await db.put('ideas', it);
  }
  $('d-text').textContent = text;
  setEditing(false);
  await refresh();
  kick();
});

let armTimer = null;
function disarm() { $('d-del').classList.remove('armed'); clearTimeout(armTimer); }
$('d-del').addEventListener('click', async () => {
  const btn = $('d-del');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    armTimer = setTimeout(disarm, 2500);
    return;
  }
  disarm();
  const id = current;
  closeSheets();
  await db.deleteIdea(id);
  await refresh();
});

// ---------- 시트 공통 ----------
function openSheet(el) {
  [detail, settings].forEach((s) => { s.classList.toggle('open', s === el); s.setAttribute('aria-hidden', s !== el); });
  scrim.classList.add('on');
}
function closeSheets() {
  [detail, settings].forEach((s) => { s.classList.remove('open'); s.setAttribute('aria-hidden', 'true'); });
  scrim.classList.remove('on');
  document.activeElement?.blur?.();
  current = null;
  map.select(null);
}
scrim.addEventListener('click', closeSheets);

// 아래로 쓸어내려 닫기
for (const sheet of [detail, settings]) {
  let y0 = null, dy = 0;
  sheet.addEventListener('touchstart', (e) => {
    if (sheet.scrollTop > 0 || e.target.closest('textarea,input')) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none';
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (y0 == null) return;
    sheet.style.transition = ''; sheet.style.transform = '';
    if (dy > 80) closeSheets();
    y0 = null;
  });
}

// ---------- 설정 ----------
gear.addEventListener('click', async () => {
  $('s-key').value = (await db.getMeta('apiKey')) || '';
  await renderModels();
  updateStatus(await db.all('ideas'));
  openSheet(settings);
});

$('s-key').addEventListener('change', async (e) => {
  const v = e.target.value.trim();
  await db.setMeta('apiKey', v || null);
  await db.setMeta('keyError', false);
  if (v) { toast('✓'); kick(); }
});

async function renderModels() {
  const cur = (await db.getMeta('model')) || ai.DEFAULT_MODEL;
  const seg = $('s-model');
  seg.innerHTML = '';
  for (const m of ai.MODELS) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.className = m.id === cur ? 'on' : '';
    b.onclick = async () => { await db.setMeta('model', m.id); renderModels(); };
    seg.appendChild(b);
  }
}

async function updateStatus(ideas) {
  const pending = ideas.filter((i) => i.status === 'pending').length;
  const failed = ideas.filter((i) => i.status === 'failed').length;
  const keyError = await db.getMeta('keyError');
  const parts = [`${ideas.length}`];
  if (pending) parts.push(`대기 ${pending}`);
  if (failed) parts.push(`실패 ${failed}`);
  if (keyError) parts.push('키 오류');
  if (!navigator.onLine) parts.push('오프라인');
  $('s-status').textContent = parts.join('  ·  ');
}

$('s-recluster').addEventListener('click', async () => {
  if (!(await db.getMeta('apiKey'))) return toast('API key');
  if (!navigator.onLine) return toast('오프라인');
  // 실패한 것도 다시 시도
  for (const i of await db.all('ideas')) if (i.status === 'failed') { i.status = 'pending'; i.fails = 0; await db.put('ideas', i); }
  const b = $('s-recluster');
  b.disabled = true;
  await ai.runQueue({ forceRecluster: true });
  b.disabled = false;
  toast('✓');
});

$('s-export').addEventListener('click', async () => {
  const data = await db.exportAll();
  const name = `ideas-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  // iOS: 공유 시트 → "파일에 저장"
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

$('s-import').addEventListener('click', () => $('s-file').click());
$('s-file').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    const n = await db.importAll(JSON.parse(await f.text()));
    toast(`+${n}`);
    await refresh();
    kick();
  } catch { toast('✕'); }
});

// ---------- 기타 ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1600);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.().catch(() => {});

(async () => {
  await refresh();
  if (await db.getMeta('keyError')) gear.className = 'error';
  else if (!(await db.getMeta('apiKey'))) gear.className = 'pending';
  kick();
})();
