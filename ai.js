// Claude API 호출과 처리 대기열
import * as db from './db.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
export const MODELS = [
  { id: 'claude-haiku-5-5', label: '기본' },
  { id: 'claude-sonnet-5-5', label: '중급' },
  { id: 'claude-opus-5-5', label: '고급' },
];
export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const BUILD_MODEL = 'claude-opus-5-5'; // 개발 프롬프트는 항상 고급
const RECLUSTER_EVERY = 5; // 새 아이디어 5개마다 묶음 재정리

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function callClaude({ system, user, schema, maxTokens, effort = 'low', kind = 'other', model: forced }) {
  const apiKey = await db.getMeta('apiKey');
  if (!apiKey) throw new ApiError('no key', 0);
  const model = forced || (await db.getMeta('model')) || DEFAULT_MODEL;

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, format: { type: 'json_schema', schema } },
  };
  // Opus/Sonnet 5.5: 거절 시 서버가 다른 모델로 자동 재시도
  if (model !== 'claude-haiku-5-5') {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  let res;
  try {
    res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new ApiError('network', -1);
  }
  if (!res.ok) {
    let msg = String(res.status);
    try { msg = (await res.json())?.error?.message || msg; } catch {}
    throw new ApiError(msg, res.status);
  }
  const data = await res.json();
  const usage = await recordUsage(kind, data.model || model, data.usage);
  if (data.stop_reason === 'refusal') throw new ApiError('refusal', 200);
  if (data.stop_reason === 'max_tokens') throw new ApiError('truncated', 200);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const out = JSON.parse(text);
  Object.defineProperty(out, '_usage', { value: usage, enumerable: false });
  return out;
}

// ---------- 토큰 사용량 ----------
// 1M 토큰당 달러 (입력, 출력)
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
const priceOf = (m) => PRICES[m] || PRICES[Object.keys(PRICES).find((k) => m?.startsWith(k))] || PRICES[DEFAULT_MODEL];
export const KINDS = { process: '기록 처리', recluster: '다시 묶기', ask: '질문', merge: '합치기', spark: 'AI 영감', build: '개발 프롬프트' };

async function recordUsage(kind, model, u) {
  if (!u) return null;
  const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  const [pi, po] = priceOf(model);
  const cost = (inTok * pi + outTok * po) / 1e6;
  const t = await db.getMeta('usage', { since: Date.now(), kinds: {} });
  const k = (t.kinds[kind] ||= { n: 0, in: 0, out: 0, cost: 0 });
  k.n++; k.in += inTok; k.out += outTok; k.cost += cost;
  await db.setMeta('usage', t);
  return { in: inTok, out: outTok, cost, model };
}

export const getUsage = () => db.getMeta('usage', { since: Date.now(), kinds: {} });
export const resetUsage = () => db.setMeta('usage', { since: Date.now(), kinds: {} });

// ---------- 프롬프트 ----------

const PROCESS_SYSTEM = `너는 한 사람의 개인 아이디어 노트를 정리하는 도우미다.
메모는 바이브 코딩으로 만들 서비스나 상품 아이디어이며, 음성 인식으로 적혀 오타나 군더더기가 있을 수 있다.
새 아이디어 하나와 기존 아이디어 목록, 기존 묶음 목록을 받는다. 다음을 JSON으로만 답한다.

- keyword: 아이디어의 핵심을 나타내는 1~3단어. 메모와 같은 언어(보통 한국어). 명사형, 짧게. 예: "식단 기록봇", "중고 시세 알림".
- summary: 무엇을 누구에게 해주는지 한 줄 요약. 40자 이내. 마침표 없이.
- related_ids: 기존 아이디어 중 실제로 연관된 것의 id. 같은 문제를 풀거나, 같은 사용자를 노리거나, 합치면 하나의 제품이 될 만한 것만. 억지로 채우지 말 것. 0~4개. 목록에 있는 id만 사용.
- cluster_id: 기존 묶음 중 이 아이디어가 자연스럽게 속하는 것의 id. 맞는 것이 없으면 "".
- new_cluster_name: cluster_id가 ""일 때만, 이 아이디어가 열 새 묶음 이름(2~4단어, 주제 영역을 나타내는 이름. 예: "건강 관리", "개발자 도구"). cluster_id를 골랐으면 "".`;

const PROCESS_SCHEMA = {
  type: 'object',
  properties: {
    keyword: { type: 'string' },
    summary: { type: 'string' },
    related_ids: { type: 'array', items: { type: 'string' } },
    cluster_id: { type: 'string' },
    new_cluster_name: { type: 'string' },
  },
  required: ['keyword', 'summary', 'related_ids', 'cluster_id', 'new_cluster_name'],
  additionalProperties: false,
};

const RECLUSTER_SYSTEM = `너는 한 사람의 개인 아이디어 노트 전체를 주제별로 다시 정리하는 도우미다.
아이디어 목록(id | 키워드 | 요약)을 받는다. 다음을 JSON으로만 답한다.

- clusters: 아이디어를 주제 영역별 묶음으로 나눈다. 모든 id는 정확히 하나의 묶음에 들어가야 한다.
  묶음 수는 아이디어 수에 맞게 자연스럽게(대략 아이디어 3~6개당 하나, 최대 10개). 어디에도 맞지 않는 아이디어만 혼자 묶음이 될 수 있다.
  name: 2~4단어의 짧은 주제 이름(예: "건강 관리", "개발자 도구", "부모 육아").
- links: 서로 실제로 연관된 아이디어 쌍. 같은 문제를 풀거나, 같은 사용자를 노리거나, 합치면 하나의 제품이 될 만한 것만.
  다른 묶음 사이의 연결도 허용. 아이디어 하나당 최대 4개. 억지로 만들지 말 것. 목록에 있는 id만 사용.`;

const RECLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          idea_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'idea_ids'],
        additionalProperties: false,
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required: ['a', 'b'],
        additionalProperties: false,
      },
    },
  },
  required: ['clusters', 'links'],
  additionalProperties: false,
};

const line = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ---------- 처리 ----------

async function nextColor() {
  const used = (await db.all('clusters')).map((c) => c.color);
  for (let i = 0; ; i++) if (!used.includes(i)) return i;
}

async function processIdea(idea) {
  const ideas = (await db.all('ideas')).filter((i) => i.id !== idea.id && i.status === 'done');
  const clusters = await db.all('clusters');

  const user = [
    '## 기존 묶음 (id | 이름)',
    clusters.length ? clusters.map((c) => `${c.id} | ${line(c.name)}`).join('\n') : '(없음)',
    '',
    '## 기존 아이디어 (id | 키워드 | 요약)',
    ideas.length ? ideas.map((i) => `${i.id} | ${line(i.keyword)} | ${line(i.summary)}`).join('\n') : '(없음)',
    '',
    '## 새 아이디어',
    idea.text,
  ].join('\n');

  const r = await callClaude({ system: PROCESS_SYSTEM, user, schema: PROCESS_SCHEMA, maxTokens: 4000, kind: 'process' });

  const ids = new Set(ideas.map((i) => i.id));
  let related = [...new Set((r.related_ids || []).filter((x) => ids.has(x)))].slice(0, 4);

  let clusterId = clusters.some((c) => c.id === r.cluster_id) ? r.cluster_id : null;
  if (!clusterId) {
    const name = line(r.new_cluster_name) || line(r.keyword);
    const existing = clusters.find((c) => c.name === name);
    if (existing) clusterId = existing.id;
    else {
      clusterId = db.uid();
      await db.put('clusters', { id: clusterId, name, color: await nextColor() });
    }
  }

  // 최신 상태를 다시 읽어 덮어쓰기 충돌 방지
  const fresh = await db.get('ideas', idea.id);
  if (!fresh) return; // 처리 중 삭제됨
  const oldLinks = fresh.links || [];
  // AI 영감·합치기로 생긴 아이디어는 출처 연결을 유지
  if (fresh.seeds?.length) related = [...new Set([...related, ...fresh.seeds.filter((x) => ids.has(x))])];
  fresh.keyword = line(r.keyword).slice(0, 24);
  fresh.summary = line(r.summary);
  fresh.links = related;
  fresh.clusterId = clusterId;
  fresh.status = 'done';
  fresh.processedText = fresh.text;
  await db.put('ideas', fresh);

  // 양방향 연결 유지
  for (const other of await db.all('ideas')) {
    if (other.id === fresh.id) continue;
    const has = other.links?.includes(fresh.id);
    const should = related.includes(other.id);
    if (should && !has) { other.links = [...(other.links || []), fresh.id]; await db.put('ideas', other); }
    if (!should && has && oldLinks.includes(other.id)) {
      other.links = other.links.filter((x) => x !== fresh.id); await db.put('ideas', other);
    }
  }
  await db.pruneClusters();
}

export async function recluster() {
  const ideas = (await db.all('ideas')).filter((i) => i.status === 'done');
  if (ideas.length < 2) return;
  const user = ideas.map((i) => `${i.id} | ${line(i.keyword)} | ${line(i.summary)}`).join('\n');
  const r = await callClaude({ system: RECLUSTER_SYSTEM, user, schema: RECLUSTER_SCHEMA, maxTokens: 16000, kind: 'recluster' });

  const ids = new Set(ideas.map((i) => i.id));
  const old = await db.all('clusters');
  const oldMembers = new Map(old.map((c) => [c.id, new Set(ideas.filter((i) => i.clusterId === c.id).map((i) => i.id))]));
  const usedOld = new Set();
  const assign = new Map();
  const next = [];

  for (const nc of r.clusters || []) {
    const members = [...new Set(nc.idea_ids || [])].filter((x) => ids.has(x) && !assign.has(x));
    if (!members.length) continue;
    // 가장 많이 겹치는 기존 묶음의 id와 색을 이어받아 화면이 덜 흔들리게
    let best = null, bestN = 0;
    for (const c of old) {
      if (usedOld.has(c.id)) continue;
      const n = members.filter((m) => oldMembers.get(c.id).has(m)).length;
      if (n > bestN) { best = c; bestN = n; }
    }
    const cluster = best
      ? { ...best, name: line(nc.name) || best.name }
      : { id: db.uid(), name: line(nc.name), color: null };
    if (best) usedOld.add(best.id);
    next.push(cluster);
    members.forEach((m) => assign.set(m, cluster.id));
  }

  // 색 배정
  const taken = new Set(next.filter((c) => c.color != null).map((c) => c.color));
  for (const c of next) if (c.color == null) { let i = 0; while (taken.has(i)) i++; c.color = i; taken.add(i); }

  const links = new Map(ideas.map((i) => [i.id, new Set()]));
  for (const { a, b } of r.links || []) {
    if (a !== b && ids.has(a) && ids.has(b)) { links.get(a).add(b); links.get(b).add(a); }
  }

  await db.clear('clusters');
  for (const c of next) await db.put('clusters', c);
  for (const i of ideas) {
    const fresh = await db.get('ideas', i.id);
    if (!fresh) continue;
    if (assign.has(i.id)) fresh.clusterId = assign.get(i.id);
    else if (!next.some((c) => c.id === fresh.clusterId)) fresh.clusterId = null;
    fresh.links = [...links.get(i.id)];
    await db.put('ideas', fresh);
  }
  await db.setMeta('sinceRecluster', 0);
}

// ---------- 대기열 ----------

let running = false;
let listeners = [];
export const onChange = (fn) => listeners.push(fn);
const emit = (state) => listeners.forEach((fn) => fn(state));

// state: 'idle' | 'busy' | 'pending' (오프라인/키 없음으로 대기) | 'error' (키 오류)
export async function runQueue({ forceRecluster = false } = {}) {
  if (running) return;
  running = true;
  try {
    const key = await db.getMeta('apiKey');
    const pending = (await db.all('ideas'))
      .filter((i) => i.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);

    if (!key || !navigator.onLine) {
      emit(pending.length || forceRecluster ? 'pending' : 'idle');
      return;
    }
    if (!pending.length && !forceRecluster) { emit('idle'); return; }

    emit('busy');
    let since = (await db.getMeta('sinceRecluster')) || 0;
    for (const idea of pending) {
      try {
        await processIdea(idea);
      } catch (e) {
        // 네트워크·인증·과부하는 전체를 멈추고, 그 외(거절·파싱 실패)는 이 아이디어만 건너뜀
        const s = e instanceof ApiError ? e.status : 0;
        if (s === -1 || s === 401 || s === 403 || s === 429 || s >= 500) throw e;
        const fresh = await db.get('ideas', idea.id);
        if (fresh) {
          fresh.fails = (fresh.fails || 0) + 1;
          if (fresh.fails >= 3) fresh.status = 'failed';
          await db.put('ideas', fresh);
        }
        continue;
      }
      since++;
      await db.setMeta('sinceRecluster', since);
      emit('busy');
    }
    const total = (await db.all('ideas')).length;
    if (forceRecluster || (since >= RECLUSTER_EVERY && total >= 4)) {
      await recluster();
    }
    await db.setMeta('keyError', false);
    emit('idle');
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      await db.setMeta('keyError', true);
      emit('error');
    } else {
      // 네트워크·서버 오류: 대기 상태로 남겨두고 나중에 다시 시도
      console.warn('queue', e);
      emit('pending');
    }
  } finally {
    running = false;
  }
}

// ---------- 활용: 질문 · 합치기 · 개발 프롬프트 ----------

const ideaBlock = (i) =>
  `[${i.id}] ${line(i.keyword) || '(키워드 없음)'}${i.summary ? ' — ' + line(i.summary) : ''}\n${i.text.trim()}`;

const ASK_SYSTEM = `너는 한 사람의 개인 아이디어 노트를 함께 검토하는 날카로운 제품 파트너다.
메모는 바이브 코딩(AI로 빠르게 만드는 방식)으로 혼자 만들 서비스나 상품 아이디어다.
사용자가 어떤 기준이나 질문을 주면, 아이디어 전체를 그 기준으로 평가해 JSON으로만 답한다.

- title: 사용자의 기준을 12자 이내로 다듬은 제목.
- insight: 고른 아이디어들을 전체적으로 본 분석 의견 2~3문장. 공통점, 눈에 띄는 기회나 위험, 무엇부터 해보면 좋을지. 일반론 말고 이 아이디어들에 대한 구체적인 이야기.
- picks: 기준에 잘 맞는 아이디어만, 잘 맞는 순서로 최대 12개.
  - id: 목록의 [ ] 안 id 그대로.
  - score: 기준에 맞는 정도 1~10. 5 미만이면 넣지 말 것.
  - reason: 왜 맞는지 한 줄(40자 이내). 메모에 근거가 부족하면 추측임을 밝힐 것.
맞는 아이디어가 없으면 picks는 빈 배열로 두고 insight에 그 이유를 쓴다. 답은 한국어로.`;

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    insight: { type: 'string' },
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, score: { type: 'integer' }, reason: { type: 'string' } },
        required: ['id', 'score', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'insight', 'picks'],
  additionalProperties: false,
};

export async function ask(query) {
  const ideas = (await db.all('ideas')).sort((a, b) => a.createdAt - b.createdAt);
  if (!ideas.length) return { title: query, insight: '', picks: [], q: query, at: Date.now() };
  const user = `## 기준\n${query}\n\n## 아이디어 목록\n${ideas.map(ideaBlock).join('\n\n')}`;
  const r = await callClaude({ system: ASK_SYSTEM, user, schema: ASK_SCHEMA, maxTokens: 8000, effort: 'medium', kind: 'ask' });
  const ids = new Set(ideas.map((i) => i.id));
  const seen = new Set();
  r.picks = (r.picks || [])
    .filter((p) => ids.has(p.id) && !seen.has(p.id) && seen.add(p.id))
    .map((p) => ({ ...p, score: Math.max(1, Math.min(10, p.score | 0)) }))
    .sort((a, b) => b.score - a.score);
  // 질문 내역에 결과까지 저장
  const entry = { id: db.uid(), q: query, at: Date.now(), title: r.title, insight: r.insight, picks: r.picks, usage: r._usage, ideaCount: ideas.length };
  await db.put('asks', entry);
  return entry;
}

const MERGE_SYSTEM = `너는 아이디어를 엮어 더 강한 제품을 찾아주는 제품 기획자다.
기준 아이디어 하나와, 그것과 연결된 아이디어들을 받는다. 이들 중 2~3개를 합쳐 하나의 제품 콘셉트를 제안하고 JSON으로만 답한다.

- keyword: 합친 콘셉트의 이름 1~3단어.
- pitch: 3~4문장. 누구를 위한 무엇인지, 핵심 기능, 그리고 따로 만들 때보다 합쳤을 때 왜 더 나은지.
- used_ids: 합치는 데 쓴 아이디어의 id(기준 아이디어 포함). 목록에 있는 id만.
억지스러운 조합은 피하고, 가장 자연스러운 조합 하나만 고른다. 답은 한국어로.`;

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    keyword: { type: 'string' },
    pitch: { type: 'string' },
    used_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['keyword', 'pitch', 'used_ids'],
  additionalProperties: false,
};

export async function merge(id) {
  const base = await db.get('ideas', id);
  if (!base) throw new Error('missing');
  const others = (await Promise.all((base.links || []).map((x) => db.get('ideas', x)))).filter(Boolean);
  const user = `## 기준 아이디어\n${ideaBlock(base)}\n\n## 연결된 아이디어\n${others.map(ideaBlock).join('\n\n')}`;
  const r = await callClaude({ system: MERGE_SYSTEM, user, schema: MERGE_SCHEMA, maxTokens: 4000, effort: 'medium', kind: 'merge' });
  const ok = new Set([base.id, ...others.map((o) => o.id)]);
  r.used_ids = [...new Set([base.id, ...(r.used_ids || []).filter((x) => ok.has(x))])];
  r.keyword = line(r.keyword);
  return r;
}

const BUILD_SYSTEM = `너는 아이디어를 AI 코딩 도구(Claude Code 등)에 그대로 붙여넣을 개발 지시문으로 바꿔주는 도우미다.
혼자 바이브 코딩으로 하루~며칠 안에 만들 첫 버전(MVP)을 기준으로, 아래 구성의 한국어 지시문을 JSON의 prompt 필드에 담아 답한다.

구성 (각 항목은 짧은 제목 줄 + 불릿):
1. 만들 것: 한두 문장 요약
2. 사용자: 누가, 어떤 순간에 쓰는지
3. 핵심 기능: 3~5개, 각각 동작이 분명하게
4. 화면: 화면별 구성과 흐름
5. 데이터: 무엇을 어디에 저장하는지
6. 기술: 가장 단순한 선택을 제안 (특별한 이유가 없으면 휴대폰에서 쓰는 단일 웹앱/PWA, 서버 없이 기기 저장). 외부 API가 필요하면 무엇인지
7. 이번엔 안 할 것: 첫 버전 범위 밖
8. 완료 기준: 직접 확인할 체크리스트 3~5개
마지막 줄에 "먼저 전체 구조를 짧게 제안하고, 내가 확인하면 만들어줘."를 넣는다.
메모에 없는 부분은 합리적으로 채우되, 원래 아이디어의 의도를 바꾸지 않는다. 마크다운 제목(#)은 쓰지 말고 번호와 불릿만 쓴다.`;

const BUILD_SCHEMA = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
  additionalProperties: false,
};

export async function buildPrompt(id) {
  const it = await db.get('ideas', id);
  if (!it) throw new Error('missing');
  const linked = (await Promise.all((it.links || []).map((x) => db.get('ideas', x)))).filter(Boolean);
  const ctx = linked.length ? `\n\n## 참고: 연결된 아이디어(필요할 때만 반영)\n${linked.map((l) => `- ${line(l.keyword)}: ${line(l.summary)}`).join('\n')}` : '';
  const user = `## 아이디어\n${it.text.trim()}${ctx}`;
  const r = await callClaude({ system: BUILD_SYSTEM, user, schema: BUILD_SCHEMA, maxTokens: 8000, effort: 'medium', kind: 'build', model: BUILD_MODEL });
  const fresh = await db.get('ideas', id);
  if (fresh) { fresh.buildPrompt = r.prompt; fresh.buildFor = fresh.text; await db.put('ideas', fresh); }
  return r.prompt;
}

export function errorText(e) {
  if (!(e instanceof ApiError)) return '✕';
  if (e.status === 0) return 'API key';
  if (e.status === -1) return '오프라인';
  if (e.status === 401 || e.status === 403) return '키 오류';
  if (e.status === 429) return '잠시 후';
  return '✕';
}

// ---------- AI 영감: 내 아이디어들을 엮어 새 아이디어 ----------

// 매번 다른 각도를 하나 골라 결합
const TWISTS = [
  '전혀 다른 사용자층(예: 부모, 시니어, 학생, 자영업자, 반려인)에게 옮겨보기',
  '개인용을 팀·회사용(B2B)으로 바꿔보기',
  '반대로 뒤집기: 기록 대신 줄여주기, 알려주는 대신 물어보기처럼',
  '하루 만에 만들 수 있는 아주 작은 한 기능짜리 버전으로 줄이기',
  '사람 대신 AI 에이전트가 알아서 대신 해주는 형태로 바꾸기',
  '혼자 쓰던 것을 친구·커뮤니티와 함께 쓰는 소셜 형태로 바꾸기',
  '모이는 데이터를 전혀 다른 용도로 다시 쓰기',
  '오프라인 장소·물건·이벤트와 결합하기',
  '돈을 버는 방식부터 정하고 거꾸로 설계하기 (구독, 건당 결제, 중개 수수료 등)',
  '게임처럼 만들기: 점수, 연속 기록, 수집 요소',
  '음성·카메라·위치 같은 휴대폰 센서를 핵심으로 쓰기',
  '귀찮은 반복 작업 하나를 완전히 자동화하는 데만 집중하기',
];

const SPARK_SYSTEM = `너는 한 사람의 아이디어 노트에서 영감을 받아 새 아이디어를 떠올리는 공동 창업자다.
메모는 바이브 코딩(AI로 빠르게 혼자 만드는 방식)으로 만들 서비스나 상품 아이디어다.
씨앗 아이디어 2~3개와 이번에 적용할 각도 하나를 받는다. 씨앗들을 엮고 각도를 적용해, 기존 메모에 없는 새롭거나 한 단계 업그레이드된 아이디어 하나를 JSON으로만 답한다.

- keyword: 새 아이디어 이름 1~3단어.
- idea: 사용자가 직접 적은 메모처럼 자연스러운 2~4문장. 누구를 위해 무엇을 해주는지, 무엇이 새로운지. 너무 거창하지 않게, 혼자 만들 수 있는 크기로.
- spark: 어떤 씨앗을 어떻게 엮고 어떤 각도를 적용했는지 한 줄(40자 이내).
- used_ids: 실제로 영감을 받은 씨앗 id.
씨앗을 단순히 합쳐 다시 말하지 말고, 반드시 새로운 요소가 하나 이상 있어야 한다. 답은 한국어로.`;

const SPARK_SCHEMA = {
  type: 'object',
  properties: {
    keyword: { type: 'string' },
    idea: { type: 'string' },
    spark: { type: 'string' },
    used_ids: { type: 'array', items: { type: 'string' } },
  },
  required: ['keyword', 'idea', 'spark', 'used_ids'],
  additionalProperties: false,
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// 씨앗 고르기: 무작위 하나 + 연결된 것 하나 + (가끔) 다른 묶음의 것 하나
function pickSeeds(ideas) {
  const done = ideas.filter((i) => i.status === 'done');
  if (done.length < 2) return [];
  const a = pick(done);
  const seeds = [a];
  const linked = done.filter((i) => a.links?.includes(i.id));
  const b = linked.length && Math.random() < 0.7 ? pick(linked) : pick(done.filter((i) => i.id !== a.id));
  seeds.push(b);
  const far = done.filter((i) => !seeds.includes(i) && i.clusterId !== a.clusterId);
  if (far.length && Math.random() < 0.5) seeds.push(pick(far));
  return seeds;
}

export async function spark() {
  const ideas = await db.all('ideas');
  const seeds = pickSeeds(ideas);
  if (!seeds.length) throw new Error('not enough');
  const twist = pick(TWISTS);
  const user = `## 씨앗 아이디어\n${seeds.map(ideaBlock).join('\n\n')}\n\n## 이번 각도\n${twist}`;
  const r = await callClaude({ system: SPARK_SYSTEM, user, schema: SPARK_SCHEMA, maxTokens: 4000, effort: 'medium', kind: 'spark' });
  const ok = new Set(seeds.map((x) => x.id));
  const used = [...new Set((r.used_ids || []).filter((x) => ok.has(x)))];
  const now = Date.now();
  const idea = {
    id: db.uid(),
    text: String(r.idea || '').trim() || line(r.keyword),
    createdAt: now, updatedAt: now,
    links: used.length ? used : [...ok],
    clusterId: null,
    status: 'pending',
    origin: 'ai',
    aiNote: line(r.spark),
    aiTwist: twist,
    seeds: used.length ? used : [...ok],
  };
  await db.put('ideas', idea);
  for (const x of idea.links) {
    const o = await db.get('ideas', x);
    if (o && !o.links?.includes(idea.id)) { o.links = [...(o.links || []), idea.id]; await db.put('ideas', o); }
  }
  return idea;
}

export const canSpark = (ideas) => ideas.filter((i) => i.status === 'done').length >= 3;
