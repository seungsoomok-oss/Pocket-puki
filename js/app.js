import { TOTAL_QUESTIONS } from './prompts.js';
import * as store from './storage.js';
import { createInterview, generateNextQuestion, submitAnswer, generateReport } from './interview.js';
import { reportToText, copyText, shareText, saveCardImage } from './share.js';

const app = document.getElementById('app');
const SHORT_ANSWER = 20; // 이 글자 수보다 짧으면 한 번 안내

// ── 유틸 ──
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};
const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};
let toastTimer;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
const hasKey = () => {
  const s = store.getSettings();
  return s.provider === 'openai' ? !!s.openaiKey : !!s.anthropicKey;
};

let renderToken = 0; // 화면이 바뀌면 이전 비동기 작업 결과를 무시

// ── 라우터 ──
function render() {
  renderToken++;
  const [, route, id] = (location.hash || '#/').split('/');
  window.scrollTo(0, 0);
  switch (route) {
    case 'interview':
      return viewInterview(id);
    case 'analyzing':
      return viewAnalyzing(id);
    case 'report':
      return viewReport(id);
    case 'history':
      return viewHistory();
    case 'settings':
      return viewSettings();
    default:
      return viewStart();
  }
}
window.addEventListener('hashchange', render);

// ── 시작 화면 ──
function viewStart() {
  const ongoing = store.getInProgress();
  const count = store.listReports().length;
  app.innerHTML = `
    <main class="screen start">
      <header class="topbar">
        <span class="wordmark">10문 10답</span>
        <a href="#/settings" class="icon-btn" aria-label="설정"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></a>
      </header>

      <section class="hero">
        <h1>질문 10개로<br/>나를 정리해 드릴게요</h1>
        <p class="sub">AI 인터뷰어가 답변에 맞춰 질문을 이어가고,<br/>마지막에 한 장짜리 보고서를 만들어요.</p>
      </section>

      ${
        !hasKey()
          ? `<a href="#/settings" class="row-card notice"><span>시작하려면 API 키가 필요해요</span><span class="row-action">설정하기 ›</span></a>`
          : ''
      }
      ${
        ongoing
          ? `<button class="row-card" id="resume" type="button">
              <span class="row-main"><span class="row-title">${esc(ongoing.name)}님 인터뷰 이어하기</span><span class="row-sub">${ongoing.qa.length}개 답변 완료 · ${TOTAL_QUESTIONS - ongoing.qa.length}개 남음</span></span>
              <span class="chev" aria-hidden="true">›</span>
            </button>`
          : ''
      }

      <form id="start-form" class="field-group">
        <label for="name" class="field-label">이름 또는 닉네임</label>
        <input id="name" name="name" class="field" maxlength="20" autocomplete="nickname" placeholder="이름을 입력해 주세요" required />
      </form>

      <nav class="list">
        <a href="#/history" class="list-row"><span>지난 보고서</span><span class="list-meta">${count}개 <span class="chev" aria-hidden="true">›</span></span></a>
      </nav>

      <div class="cta-bar">
        <p class="cta-note">약 10분 · 솔직할수록 정확해요</p>
        <button class="btn primary block" type="submit" form="start-form">${ongoing ? '새로 시작하기' : '시작하기'}</button>
      </div>
    </main>`;

  document.getElementById('resume')?.addEventListener('click', () => go(`#/interview/${ongoing.id}`));
  document.getElementById('start-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    if (!hasKey()) {
      toast('먼저 설정에서 API 키를 입력해 주세요.');
      return go('#/settings');
    }
    if (ongoing && !confirm(`진행 중인 ${ongoing.name}님의 인터뷰(${ongoing.qa.length}/${TOTAL_QUESTIONS})를 지우고 새로 시작할까요?`)) return;
    if (ongoing) store.deleteInterview(ongoing.id); // 이어하기는 하나만 유지
    const iv = createInterview(name);
    go(`#/interview/${iv.id}`);
  });
}

// ── 인터뷰 화면 ──
const THINKING = ['답변을 곱씹는 중…', '다음 질문을 고르는 중…', '단서를 정리하는 중…'];

function viewInterview(id) {
  const iv = store.getInterview(id);
  if (!iv) return go('#/');
  if (iv.status === 'completed') return go(`#/report/${id}`);
  if (iv.qa.length >= TOTAL_QUESTIONS) return go(`#/analyzing/${id}`);

  const token = renderToken;
  const number = iv.qa.length + 1;
  const pct = (iv.qa.length / TOTAL_QUESTIONS) * 100;

  app.innerHTML = `
    <main class="screen interview">
      <header class="progress-head">
        <button class="icon-btn" id="home" aria-label="처음으로"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${TOTAL_QUESTIONS}" aria-valuenow="${number}"><div class="bar" style="width:${pct}%"></div></div>
        <span class="progress-label"><strong>${number}</strong>/${TOTAL_QUESTIONS}</span>
      </header>

      <section class="question-area" id="qarea" aria-live="polite"></section>

      <form id="answer-form" class="answer" hidden>
        <textarea id="answer" class="field-area" rows="6" placeholder="떠오르는 장면이나 경험을 편하게 적어 주세요"></textarea>
      </form>

      ${
        iv.qa.length
          ? `<details class="history">
              <summary>지금까지의 답변 <span class="count">${iv.qa.length}</span></summary>
              <ol>${iv.qa
                .map((x) => `<li><p class="q">${esc(x.question)}</p><p class="a">${esc(x.answer) || '<span class="muted">(답변 없음)</span>'}</p></li>`)
                .join('')}</ol>
            </details>`
          : ''
      }

      <div class="cta-bar" id="cta" hidden>
        <p class="hint" id="hint" hidden>조금 더 구체적으로 말해주실래요? 그대로 넘어가도 괜찮아요.</p>
        <button class="btn primary block" type="submit" form="answer-form" id="next">${number === TOTAL_QUESTIONS ? '보고서 받기' : '다음'}</button>
      </div>
    </main>`;

  document.getElementById('home').addEventListener('click', () => go('#/'));
  const qarea = document.getElementById('qarea');
  const form = document.getElementById('answer-form');
  const ta = document.getElementById('answer');
  const hint = document.getElementById('hint');
  const cta = document.getElementById('cta');
  let warned = false;

  ta.value = iv.draft || '';
  let draftTimer;
  ta.addEventListener('input', () => {
    if (warned && ta.value.trim().length >= SHORT_ANSWER) hint.hidden = true;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const cur = store.getInterview(id);
      if (cur) {
        cur.draft = ta.value;
        store.saveInterview(cur);
      }
    }, 400);
  });

  function showQuestion(q) {
    qarea.innerHTML = `<p class="q-number">질문 ${number}</p><h2 class="question">${esc(q.question)}</h2>`;
    form.hidden = false;
    cta.hidden = false;
    setTimeout(() => ta.focus({ preventScroll: true }), 50);
  }

  function showLoading() {
    form.hidden = true;
    cta.hidden = true;
    let i = 0;
    qarea.innerHTML = `<div class="loading"><div class="dots"><span></span><span></span><span></span></div><p id="lt">${THINKING[0]}</p></div>`;
    const timer = setInterval(() => {
      const lt = document.getElementById('lt');
      if (!lt || token !== renderToken) return clearInterval(timer);
      lt.textContent = THINKING[++i % THINKING.length];
    }, 1800);
    return () => clearInterval(timer);
  }

  function showError(err, retry) {
    form.hidden = true;
    cta.hidden = true;
    qarea.innerHTML = `<div class="error-box">
        <p>${esc(err.message || '문제가 생겼어요.')}</p>
        <div class="row">
          <button class="btn primary" id="retry">다시 시도</button>
          ${err.kind === 'auth' || err.kind === 'nokey' ? '<a class="btn" href="#/settings">설정 열기</a>' : ''}
        </div>
      </div>`;
    document.getElementById('retry').addEventListener('click', retry);
  }

  async function loadQuestion() {
    const stop = showLoading();
    try {
      const fresh = store.getInterview(id);
      const q = await generateNextQuestion(fresh);
      if (token !== renderToken) return;
      showQuestion(q);
    } catch (err) {
      if (token !== renderToken) return;
      showError(err, loadQuestion);
    } finally {
      stop();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const answer = ta.value.trim();
    if (!answer) {
      hint.textContent = '한 줄이라도 적어 주시면 더 정확한 보고서가 나와요.';
      hint.hidden = false;
      if (!warned) {
        warned = true;
        return;
      }
    } else if (answer.length < SHORT_ANSWER && !warned) {
      warned = true;
      hint.textContent = '조금 더 구체적으로 말해주실래요? 그대로 넘어가도 괜찮아요.';
      hint.hidden = false;
      return;
    }
    const cur = store.getInterview(id);
    const done = submitAnswer(cur, answer);
    if (done) return go(`#/analyzing/${id}`);
    render(); // 다음 질문으로
  });

  if (iv.current) showQuestion(iv.current);
  else loadQuestion();
}

// ── 분석 중 화면 ──
const ANALYZING = [
  '10개의 답변을 다시 읽고 있어요',
  '반복되는 단서를 찾는 중이에요',
  '근거가 되는 문장을 고르는 중이에요',
  '한 문장으로 정리하는 중이에요',
];

function viewAnalyzing(id) {
  const iv = store.getInterview(id);
  if (!iv) return go('#/');
  if (store.getReport(id)) return go(`#/report/${id}`);
  if (iv.qa.length < TOTAL_QUESTIONS) return go(`#/interview/${id}`);
  const token = renderToken;

  const run = async () => {
    let i = 0;
    app.innerHTML = `
      <main class="screen analyzing">
        <div class="loading big">
          <div class="spinner" aria-hidden="true"></div>
          <h2>${esc(iv.name)}님의 답변을<br/>정리하고 있어요</h2>
          <p id="lt">${ANALYZING[0]}</p>
        </div>
      </main>`;
    const timer = setInterval(() => {
      const lt = document.getElementById('lt');
      if (!lt || token !== renderToken) return clearInterval(timer);
      lt.textContent = ANALYZING[++i % ANALYZING.length];
    }, 2500);
    try {
      await generateReport(store.getInterview(id));
      if (token !== renderToken) return;
      go(`#/report/${id}`);
    } catch (err) {
      if (token !== renderToken) return;
      app.innerHTML = `
        <main class="screen analyzing">
          <div class="error-box">
            <p>${esc(err.message || '보고서를 만들지 못했어요.')}</p>
            <p class="muted small">답변은 안전하게 저장되어 있어요.</p>
            <div class="row">
              <button class="btn primary" id="retry">다시 시도</button>
              <a class="btn" href="#/">처음으로</a>
            </div>
          </div>
        </main>`;
      document.getElementById('retry').addEventListener('click', run);
    } finally {
      clearInterval(timer);
    }
  };
  run();
}

// ── 보고서 화면 ──
function viewReport(id) {
  const rec = store.getReport(id);
  if (!rec) return go('#/history');
  const r = rec.report;
  const list = (arr) => `<ul>${arr.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`;

  app.innerHTML = `
    <main class="screen report">
      <header class="bar-head">
        <button class="icon-btn" id="back" aria-label="뒤로"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="muted small">${fmtDate(rec.createdAt)}</span>
        <span class="icon-btn ghost"></span>
      </header>

      <article class="report-card" id="report-card">
        <div class="rc-head">
          <div class="rc-kicker">${esc(rec.name)}님은 이런 사람이에요</div>
          <h1 class="rc-oneliner">${esc(r.oneLiner)}</h1>
        </div>

        <section class="rc-section">
          <h3>핵심 특성</h3>
          <ol class="traits">
            ${r.traits
              .map(
                (t) => `<li>
                  <div class="t-name">${esc(t.name)}</div>
                  <p class="t-desc">${esc(t.description)}</p>
                  ${(t.evidence || [])
                    .map((e) => `<blockquote><span class="qno">답변 ${esc(e.questionNo)}</span>${esc(e.quote)}</blockquote>`)
                    .join('')}
                </li>`
              )
              .join('')}
          </ol>
        </section>

        <section class="rc-section two">
          <div><h3>강점</h3>${list(r.strengths)}</div>
          <div><h3>주의할 점</h3>${list(r.blindSpots)}</div>
        </section>

        <section class="rc-section">
          <h3>이 사람을 움직이는 것</h3>
          ${list(r.motivations)}
        </section>

        <section class="rc-section">
          <h3>요약</h3>
          <p class="summary">${esc(r.summary)}</p>
        </section>

        <footer class="rc-foot"><span>10문 10답</span><span>${fmtDate(rec.createdAt)}</span></footer>
      </article>

      <div class="text-actions">
        <button class="text-btn" id="copy">텍스트 복사</button>
        <span class="sep" aria-hidden="true"></span>
        <button class="text-btn" id="home">처음으로</button>
      </div>

      <div class="cta-bar two">
        <button class="btn secondary" id="save-img">이미지 저장</button>
        <button class="btn primary" id="share">공유하기</button>
      </div>
    </main>`;

  const text = reportToText(rec);
  document.getElementById('back').addEventListener('click', () => go('#/history'));
  document.getElementById('home').addEventListener('click', () => go('#/'));
  document.getElementById('copy').addEventListener('click', async () => {
    toast((await copyText(text)) ? '보고서 텍스트를 복사했어요' : '복사하지 못했어요');
  });
  document.getElementById('share').addEventListener('click', async () => {
    const res = await shareText(`${rec.name}은(는) 어떤 사람인가`, text);
    if (res === 'copied') toast('공유를 지원하지 않아 텍스트를 복사했어요');
    if (res === 'failed') toast('공유하지 못했어요');
  });
  document.getElementById('save-img').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '이미지 만드는 중…';
    try {
      const res = await saveCardImage(document.getElementById('report-card'), `${rec.name}-보고서-${fmtDate(rec.createdAt)}.png`);
      if (res === 'downloaded') toast('이미지를 저장했어요');
    } catch (err) {
      toast(err.message || '이미지를 만들지 못했어요');
    } finally {
      btn.disabled = false;
      btn.textContent = '이미지 저장';
    }
  });
}

// ── 지난 보고서 목록 ──
function viewHistory() {
  const reports = store.listReports();
  app.innerHTML = `
    <main class="screen history-list">
      <header class="bar-head">
        <button class="icon-btn" id="back" aria-label="처음으로"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h2>지난 보고서</h2>
        <span class="icon-btn ghost"></span>
      </header>
      ${
        reports.length
          ? `<ul class="reports">${reports
              .map(
                (r) => `<li>
                  <a href="#/report/${esc(r.interviewId)}" class="r-item">
                    <div class="r-meta"><strong>${esc(r.name)}</strong><span class="muted small">${fmtDate(r.createdAt)}</span></div>
                    <p class="r-line">${esc(r.report.oneLiner)}</p>
                  </a>
                  <button class="del" data-id="${esc(r.interviewId)}" aria-label="삭제">삭제</button>
                </li>`
              )
              .join('')}</ul>`
          : `<div class="empty"><p>아직 완료한 보고서가 없어요.</p><a href="#/" class="btn primary">인터뷰 시작하기</a></div>`
      }
    </main>`;
  document.getElementById('back').addEventListener('click', () => go('#/'));
  app.querySelectorAll('.del').forEach((b) =>
    b.addEventListener('click', () => {
      if (!confirm('이 보고서를 삭제할까요? 되돌릴 수 없어요.')) return;
      store.deleteReport(b.dataset.id);
      toast('삭제했어요');
      viewHistory();
    })
  );
}

// ── 설정 ──
function viewSettings() {
  const s = store.getSettings();
  app.innerHTML = `
    <main class="screen settings">
      <header class="bar-head">
        <button class="icon-btn" id="back" aria-label="처음으로"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg></button>
        <h2>설정</h2>
        <span class="icon-btn ghost"></span>
      </header>

      <form id="settings-form" class="stack">
        <fieldset class="seg">
          <legend class="label">AI 서비스</legend>
          <label><input type="radio" name="provider" value="anthropic" ${s.provider !== 'openai' ? 'checked' : ''}/> Anthropic Claude</label>
          <label><input type="radio" name="provider" value="openai" ${s.provider === 'openai' ? 'checked' : ''}/> OpenAI</label>
        </fieldset>

        <div class="prov" data-prov="anthropic">
          <label class="label" for="anthropicKey">Anthropic API 키</label>
          <div class="key-row">
            <input id="anthropicKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-..." value="${esc(s.anthropicKey)}"/>
            <button type="button" class="btn small toggle" data-for="anthropicKey">보기</button>
          </div>
          <label class="label" for="anthropicModel">모델</label>
          <select id="anthropicModel">
            ${[
              ['claude-opus-5-5', 'Claude Opus 5.5 (권장 · 가장 깊이 있음)'],
              ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (빠름 · 저렴)'],
              ['claude-haiku-5-5', 'Claude Haiku 5.5 (가장 빠름 · 가장 저렴)'],
            ]
              .map(([v, l]) => `<option value="${v}" ${s.anthropicModel === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
        </div>

        <div class="prov" data-prov="openai">
          <label class="label" for="openaiKey">OpenAI API 키</label>
          <div class="key-row">
            <input id="openaiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-..." value="${esc(s.openaiKey)}"/>
            <button type="button" class="btn small toggle" data-for="openaiKey">보기</button>
          </div>
          <label class="label" for="openaiModel">모델 이름</label>
          <input id="openaiModel" autocomplete="off" spellcheck="false" value="${esc(s.openaiModel)}"/>
        </div>

        <p class="muted small">API 키는 이 기기의 브라우저에만 저장되며, 선택한 AI 회사의 API 외에는 어디로도 보내지 않습니다.</p>
        <button class="btn primary block" type="submit">저장</button>
      </form>

      <section class="danger">
        <h3>데이터</h3>
        <p class="muted small">인터뷰 기록, 보고서, API 키를 이 기기에서 모두 지웁니다.</p>
        <button class="btn danger-btn" id="wipe">전체 데이터 삭제</button>
      </section>
    </main>`;

  const form = document.getElementById('settings-form');
  const syncProv = () => {
    const p = form.provider.value;
    form.querySelectorAll('.prov').forEach((el) => (el.hidden = el.dataset.prov !== p));
  };
  syncProv();
  form.querySelectorAll('input[name=provider]').forEach((r) => r.addEventListener('change', syncProv));
  form.querySelectorAll('.toggle').forEach((b) =>
    b.addEventListener('click', () => {
      const inp = document.getElementById(b.dataset.for);
      inp.type = inp.type === 'password' ? 'text' : 'password';
      b.textContent = inp.type === 'password' ? '보기' : '숨기기';
    })
  );
  document.getElementById('back').addEventListener('click', () => go('#/'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    store.saveSettings({
      provider: form.provider.value,
      anthropicKey: document.getElementById('anthropicKey').value.trim(),
      anthropicModel: document.getElementById('anthropicModel').value,
      openaiKey: document.getElementById('openaiKey').value.trim(),
      openaiModel: document.getElementById('openaiModel').value.trim() || store.DEFAULT_SETTINGS.openaiModel,
    });
    toast('저장했어요');
    setTimeout(() => go('#/'), 500);
  });
  document.getElementById('wipe').addEventListener('click', () => {
    if (!confirm('모든 인터뷰, 보고서, API 키를 삭제할까요? 되돌릴 수 없어요.')) return;
    store.clearAll();
    toast('모든 데이터를 삭제했어요');
    viewSettings();
  });
}

// ── 시작 ──
render();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
