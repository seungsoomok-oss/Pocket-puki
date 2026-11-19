// Claude API 호출과 처리 대기열
import * as db from './db.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
];
export const DEFAULT_MODEL = 'claude-opus-5-5';
const RECLUSTER_EVERY = 5; // 새 아이디어 5개마다 묶음 재정리

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

async function callClaude({ system, user, schema, maxTokens }) {
  const apiKey = await db.getMeta('apiKey');
  if (!apiKey) throw new ApiError('no key', 0);
  const model = (await db.getMeta('model')) || DEFAULT_MODEL;

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
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
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
  if (data.stop_reason === 'refusal') throw new ApiError('refusal', 200);
  if (data.stop_reason === 'max_tokens') throw new ApiError('truncated', 200);
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

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

  const r = await callClaude({ system: PROCESS_SYSTEM, user, schema: PROCESS_SCHEMA, maxTokens: 4000 });

  const ids = new Set(ideas.map((i) => i.id));
  const related = [...new Set((r.related_ids || []).filter((x) => ids.has(x)))].slice(0, 4);

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
  const r = await callClaude({ system: RECLUSTER_SYSTEM, user, schema: RECLUSTER_SCHEMA, maxTokens: 16000 });

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
