import * as db from './db.js';
import * as ai from './ai.js';
import { createMap, clusterColor } from './map.js';

const $ = (id) => document.getElementById(id);
const input = $('input'), mic = $('mic'), gear = $('gear'), scrim = $('scrim');
const detail = $('detail'), settings = $('settings'), askSheet = $('ask');
const SHEETS = [detail, settings, askSheet];

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
  input.classList.toggle('ask', !!askQuery(input.value));
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
});
$('dock').addEventListener('submit', (e) => { e.preventDefault(); save(); });

// "?"(또는 말로 "질문 …")로 시작하면 기록 대신 질문
function askQuery(text) {
  const m = text.trim().match(/^(?:[?？]|질문[\s,:]+)\s*([\s\S]+)/);
  return m ? m[1].trim() : null;
}

async function save(textArg) {
  const text = (textArg ?? input.value).trim();
  if (!text) return;
  const q = askQuery(text);
  if (q) {
    input.value = ''; autosize(); input.blur();
    return runAsk(q);
  }
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
const pad2 = (n) => String(n).padStart(2, '0');
const fmt = { format: (d) => `${pad2(d.getFullYear() % 100)}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` };

async function openDetail(id) {
  const [it, clusters] = await Promise.all([db.get('ideas', id), db.all('clusters')]);
  if (!it) return;
  current = id;
  setEditing(false);
  setExtra(null);
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
  $('d-merge').hidden = !(it.links && it.links.length);
  $('d-note').hidden = !it.aiNote;
  $('d-note').textContent = it.aiNote ? '✦ ' + it.aiNote : '';
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
  SHEETS.forEach((s) => { s.classList.toggle('open', s === el); s.setAttribute('aria-hidden', s !== el); });
  scrim.classList.add('on');
}
function closeSheets() {
  if (settings.classList.contains('open')) saveKey();
  const fromDetail = detail.classList.contains('open');
  current = null;
  map.select(null);
  document.activeElement?.blur?.();
  // 질문 결과에서 들어온 상세라면 결과 목록으로 돌아감
  if (fromDetail && lensActive) { openSheet(askSheet); return; }
  SHEETS.forEach((s) => { s.classList.remove('open'); s.setAttribute('aria-hidden', 'true'); });
  scrim.classList.remove('on');
  if (lensActive) { lensActive = false; map.lens(null); }
}
scrim.addEventListener('click', closeSheets);

// 아래로 쓸어내려 닫기
for (const sheet of SHEETS) {
  let y0 = null, dy = 0;
  sheet.addEventListener('touchstart', (e) => {
    if (sheet.scrollTop > 0 || e.target.closest('textarea,input,pre')) { y0 = null; return; }
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
  await renderHistory();
  await renderUsage();
  await renderModels();
  updateStatus(await db.all('ideas'));
  openSheet(settings);
});

// 붙여넣기만 해도 저장 (iOS에서 change 이벤트가 안 오는 경우 대비)
let keyTimer = null;
async function saveKey() {
  clearTimeout(keyTimer);
  const v = $('s-key').value.trim();
  const prev = (await db.getMeta('apiKey')) || '';
  if (v === prev) return;
  await db.setMeta('apiKey', v || null);
  await db.setMeta('keyError', false);
  updateStatus(await db.all('ideas'));
  if (v) { toast('✓'); kick(); }
}
$('s-key').addEventListener('input', () => { clearTimeout(keyTimer); keyTimer = setTimeout(saveKey, 500); });
$('s-key').addEventListener('change', saveKey);
$('s-key').addEventListener('blur', saveKey);

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
  if (!(await db.getMeta('apiKey'))) parts.push('키 없음');
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
  if (!(await db.getMeta('modelV2'))) { await db.setMeta('model', ai.DEFAULT_MODEL); await db.setMeta('modelV2', true); }
  await refresh();
  scheduleSpark(15000 + Math.random() * 20000);
  if (await db.getMeta('keyError')) gear.className = 'error';
  else if (!(await db.getMeta('apiKey'))) gear.className = 'pending';
  kick();
})();

// ---------- 질문 ----------
let lensActive = false;
let askSeq = 0;
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LOADING = '<div class="loading"><i></i><i></i><i></i></div>';

const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
const KRW = 1400; // 대략 환율
const fmtCost = (usd) => {
  const w = usd * KRW;
  return w < 1 ? '₩1 미만' : '₩' + (w < 100 ? w.toFixed(1) : Math.round(w).toLocaleString());
};
const usageText = (u) => (u ? `입력 ${fmtTok(u.in)} · 출력 ${fmtTok(u.out)} 토큰 · ${fmtCost(u.cost)}` : '');

function askLoading(q) {
  current = null;
  map.select(null);
  $('ask-q').textContent = '? ' + q;
  $('ask-title').textContent = '';
  $('ask-insight').innerHTML = LOADING;
  $('ask-list').innerHTML = '';
  $('ask-foot').innerHTML = '';
  lensActive = true;
  map.lens(null);
  openSheet(askSheet);
}

async function runAsk(q) {
  const seq = ++askSeq;
  askLoading(q);
  try {
    const entry = await ai.ask(q);
    if (seq !== askSeq || !lensActive) return;
    await showAsk(entry, { keepOpen: true });
  } catch (e) {
    if (seq !== askSeq) return;
    $('ask-insight').textContent = ai.errorText(e);
    $('ask-foot').innerHTML = `<div class="bar"><button id="ask-redo">다시</button></div>`;
    $('ask-redo').onclick = () => runAsk(q);
  }
}

// 저장된 질문 결과 보여주기 (API 호출 없음)
async function showAsk(entry, { keepOpen = false } = {}) {
  if (!keepOpen) { ++askSeq; askLoading(entry.q); }
  const [ideas, clusters] = await Promise.all([db.all('ideas'), db.all('clusters')]);
  const byId = new Map(ideas.map((i) => [i.id, i]));
  const colorOf = new Map(clusters.map((c) => [c.id, c.color]));
  const picks = (entry.picks || []).filter((p) => byId.has(p.id)); // 지운 아이디어 제외
  $('ask-q').textContent = '? ' + entry.q;
  $('ask-title').textContent = entry.title || entry.q;
  $('ask-insight').textContent = entry.insight || '';
  $('ask-list').innerHTML = picks.map((p) => {
    const it = byId.get(p.id);
    const color = clusterColor(colorOf.has(it.clusterId) ? colorOf.get(it.clusterId) : null);
    const label = it.keyword || it.text.slice(0, 14) + '…';
    return `<li data-id="${esc(p.id)}"><span class="dot" style="background:${color}"></span>
      <span class="k">${esc(label)}</span><span class="s">${p.score}</span>
      <span class="r">${esc(p.reason)}</span></li>`;
  }).join('');
  const newer = ideas.length - (entry.ideaCount ?? ideas.length);
  $('ask-foot').innerHTML = `
    <div class="meta">${fmt.format(new Date(entry.at))}${entry.usage ? '<br>' + usageText(entry.usage) : ''}${newer > 0 ? `<br>이후 새 아이디어 ${newer}개` : ''}</div>
    <div class="bar"><button id="ask-del">삭제</button><button class="primary" id="ask-redo">다시 묻기</button></div>`;
  $('ask-redo').onclick = () => runAsk(entry.q);
  $('ask-del').onclick = async (ev) => {
    const b = ev.currentTarget;
    if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = '삭제?'; return; }
    if (entry.id) await db.del('asks', entry.id);
    closeSheets();
  };
  map.lens(new Map(picks.map((p) => [p.id, p.score])));
  if (picks.length) map.fit(picks.map((p) => p.id));
}

$('ask-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openDetail(li.dataset.id);
});

// 설정: 질문 내역 + 사용량
async function renderHistory() {
  const asks = (await db.all('asks')).sort((a, b) => b.at - a.at);
  // 예전 버전의 "최근 질문"(결과 없이 질문만 남은 것)
  const legacy = (await db.getMeta('recentAsks', [])).filter((q) => !asks.some((a) => a.q === q));
  const box = $('s-hist');
  box.innerHTML = '';
  for (const a of asks.slice(0, 30)) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="hq">${esc(a.title || a.q)}</span><span class="hd">${fmt.format(new Date(a.at)).slice(3)} · ${(a.picks || []).length}</span>`;
    b.onclick = () => { saveKey(); showAsk(a); };
    box.appendChild(b);
  }
  for (const q of legacy) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="hq">${esc(q)}</span><span class="hd">↻</span>`;
    b.onclick = () => { saveKey(); runAsk(q); };
    box.appendChild(b);
  }
  $('s-hist-label').hidden = !box.children.length;
}

async function renderUsage() {
  const u = await ai.getUsage();
  const rows = Object.entries(ai.KINDS).filter(([k]) => u.kinds[k]);
  const tot = rows.reduce((t, [k]) => ({ n: t.n + u.kinds[k].n, in: t.in + u.kinds[k].in, out: t.out + u.kinds[k].out, cost: t.cost + u.kinds[k].cost }), { n: 0, in: 0, out: 0, cost: 0 });
  const since = new Date(u.since);
  $('s-usage-label').querySelector('span').textContent = `사용량 · ${since.getMonth() + 1}.${since.getDate()}부터`;
  $('s-usage').innerHTML = rows.length ? rows.map(([k, name]) => {
    const r = u.kinds[k];
    return `<div class="ur"><span>${name}</span><span>${r.n}회</span><span>${fmtTok(r.in + r.out)}</span><span>${fmtCost(r.cost)}</span></div>`;
  }).join('') + `<div class="ur tot"><span>합계</span><span>${tot.n}회</span><span>${fmtTok(tot.in + tot.out)}</span><span>${fmtCost(tot.cost)}</span></div><div class="usd">$${tot.cost.toFixed(3)} · 1달러≈${KRW}원</div>`
    : '<div class="ur"><span>아직 없음</span></div>';
}

// ---------- 상세: 합치기 · 개발 프롬프트 ----------
let extraSeq = 0;
function setExtra(html, which = null) {
  $('d-extra').innerHTML = html ? `<div class="extra">${html}</div>` : '';
  $('d-merge').classList.toggle('on', which === 'merge');
  $('d-build').classList.toggle('on', which === 'build');
  if (!html) extraSeq++;
}

$('d-merge').addEventListener('click', async () => {
  if ($('d-merge').classList.contains('on')) return setExtra(null);
  const id = current, seq = ++extraSeq;
  setExtra(LOADING, 'merge');
  try {
    const r = await ai.merge(id);
    if (seq !== extraSeq || current !== id) return;
    const ideas = new Map((await db.all('ideas')).map((i) => [i.id, i]));
    const used = r.used_ids.map((x) => ideas.get(x)?.keyword).filter(Boolean).join(' + ');
    setExtra(`<div class="t">${esc(r.keyword)}</div><div class="p">${esc(r.pitch)}</div>
      <div class="used">${esc(used)}</div>
      <div class="bar"><button class="primary" id="x-save">기록</button></div>`, 'merge');
    $('x-save').onclick = async () => {
      const now = Date.now();
      const nid = db.uid();
      await db.put('ideas', { id: nid, text: `${r.keyword}\n${r.pitch}`, createdAt: now, updatedAt: now, links: r.used_ids, seeds: r.used_ids, clusterId: null, status: 'pending', origin: 'ai', aiNote: `합치기 · ${used}` });
      for (const x of r.used_ids) {
        const o = await db.get('ideas', x);
        if (o && !o.links?.includes(nid)) { o.links = [...(o.links || []), nid]; await db.put('ideas', o); }
      }
      toast('✓');
      await refresh();
      kick();
      openDetail(nid);
    };
  } catch (e) {
    if (seq === extraSeq) setExtra(`<div class="p">${esc(ai.errorText(e))}</div>`, 'merge');
  }
});

$('d-build').addEventListener('click', async () => {
  if ($('d-build').classList.contains('on')) return setExtra(null);
  const id = current;
  const it = await db.get('ideas', id);
  if (!it) return;
  const show = (text) => {
    setExtra(`<pre id="x-prompt">${esc(text)}</pre>
      <div class="bar"><button id="x-redo">다시</button><button class="primary" id="x-copy">복사</button></div>`, 'build');
    $('x-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast('복사됨'); }
      catch {
        const r = document.createRange(); r.selectNodeContents($('x-prompt'));
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      }
    };
    $('x-redo').onclick = () => generate();
  };
  const generate = async () => {
    const seq = ++extraSeq;
    setExtra(LOADING, 'build');
    try {
      const text = await ai.buildPrompt(id);
      if (seq === extraSeq && current === id) show(text);
    } catch (e) {
      if (seq === extraSeq) setExtra(`<div class="p">${esc(ai.errorText(e))}</div>`, 'build');
    }
  };
  // 글이 그대로면 저장해 둔 프롬프트 재사용
  if (it.buildPrompt && it.buildFor === it.text) show(it.buildPrompt); else generate();
});

// ---------- 떠다니는 영감(+) ----------
const sparkBtn = $('spark');
let sparkTimer = null, sparkHide = null, sparking = false;
const rand = (a, b) => a + Math.random() * (b - a);

function scheduleSpark(ms) {
  clearTimeout(sparkTimer);
  sparkTimer = setTimeout(showSpark, ms);
}

async function showSpark() {
  const ideas = await db.all('ideas');
  const busySheet = SHEETS.some((s) => s.classList.contains('open'));
  if (document.hidden || !navigator.onLine || busySheet || !(await db.getMeta('apiKey')) || !ai.canSpark(ideas)) {
    return scheduleSpark(60000);
  }
  sparkBtn.style.left = rand(0.18, 0.82) * window.innerWidth + 'px';
  sparkBtn.style.top = rand(0.2, 0.6) * window.innerHeight + 'px';
  sparkBtn.classList.add('show');
  clearTimeout(sparkHide);
  sparkHide = setTimeout(hideSpark, 30000);
}

function hideSpark() {
  if (sparking) return;
  sparkBtn.classList.remove('show');
  scheduleSpark(rand(120000, 300000)); // 2~5분 뒤 다시
}

sparkBtn.addEventListener('click', async () => {
  if (sparking) return;
  sparking = true;
  clearTimeout(sparkHide);
  sparkBtn.classList.add('busy');
  if (navigator.vibrate) navigator.vibrate(12);
  try {
    const idea = await ai.spark();
    await refresh();
    kick();
    setTimeout(() => openDetail(idea.id), 500);
  } catch (e) {
    toast(ai.errorText(e));
  } finally {
    sparking = false;
    sparkBtn.classList.remove('busy');
    hideSpark();
  }
});
