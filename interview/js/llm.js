// LLM 호출. 브라우저에서 사용자 본인의 API 키로 직접 호출합니다.
// 키는 해당 AI 회사의 API 주소 외에는 어디로도 보내지 않습니다.
import { getSettings } from './storage.js';

export class LLMError extends Error {
  constructor(message, { kind = 'api', status } = {}) {
    super(message);
    this.kind = kind; // 'nokey' | 'auth' | 'rate' | 'network' | 'api' | 'parse' | 'refusal'
    this.status = status;
  }
}

/**
 * JSON 객체 하나를 받아 옵니다.
 * @param {{system: string, user: string, schema: object, schemaName: string, effort?: string}} opts
 */
export async function callJSON({ system, user, schema, schemaName, effort = 'medium' }) {
  const s = getSettings();
  if (s.provider === 'openai') {
    if (!s.openaiKey) throw new LLMError('설정에서 OpenAI API 키를 입력해 주세요.', { kind: 'nokey' });
    return callOpenAI({ key: s.openaiKey, model: s.openaiModel, system, user, schema, schemaName });
  }
  if (!s.anthropicKey) throw new LLMError('설정에서 Anthropic API 키를 입력해 주세요.', { kind: 'nokey' });
  return callAnthropic({ key: s.anthropicKey, model: s.anthropicModel, system, user, schema, effort });
}

// ── Anthropic Messages API ──
async function callAnthropic({ key, model, system, user, schema, effort }) {
  const body = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort, format: { type: 'json_schema', schema } },
    // 안전 분류기가 거절하면 서버가 다른 모델로 자동 대체 (아래에서 미지원 시 제거 후 재시도)
    fallbacks: 'default',
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': 'server-side-fallback-2026-07-01',
  };

  let res = await post('https://api.anthropic.com/v1/messages', headers, body);
  // 모델/계정이 일부 옵션을 지원하지 않으면 옵션을 줄여 한 번 더 시도
  if (res.status === 400) {
    const msg = await peekError(res);
    if (/fallback|beta/i.test(msg)) {
      delete body.fallbacks;
      delete headers['anthropic-beta'];
      res = await post('https://api.anthropic.com/v1/messages', headers, body);
    }
    if (res.status === 400) {
      const msg2 = await peekError(res);
      if (/output_config|format|schema|effort/i.test(msg2)) {
        delete body.output_config;
        res = await post('https://api.anthropic.com/v1/messages', headers, body);
      }
    }
  }
  const data = await handle(res);
  if (data.stop_reason === 'refusal') {
    throw new LLMError('AI가 이 요청에 응답하지 않았습니다. 답변을 조금 바꿔 다시 시도해 주세요.', { kind: 'refusal' });
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return parseJSON(text);
}

// ── OpenAI Chat Completions API ──
async function callOpenAI({ key, model, system, user, schema, schemaName }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
  };
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  let res = await post('https://api.openai.com/v1/chat/completions', headers, body);
  if (res.status === 400) {
    const msg = await peekError(res);
    if (/response_format|json_schema/i.test(msg)) {
      body.response_format = { type: 'json_object' };
      res = await post('https://api.openai.com/v1/chat/completions', headers, body);
    }
  }
  const data = await handle(res);
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) {
    throw new LLMError('AI가 이 요청에 응답하지 않았습니다.', { kind: 'refusal' });
  }
  return parseJSON(choice?.message?.content || '');
}

// ── 공통 ──
async function post(url, headers, body) {
  try {
    return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new LLMError('네트워크에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.', { kind: 'network' });
  }
}

async function peekError(res) {
  try {
    const j = await res.clone().json();
    return j?.error?.message || JSON.stringify(j);
  } catch {
    return '';
  }
}

async function handle(res) {
  if (res.ok) return res.json();
  const msg = await peekError(res);
  if (res.status === 401 || res.status === 403)
    throw new LLMError('API 키가 올바르지 않습니다. 설정에서 키를 확인해 주세요.', { kind: 'auth', status: res.status });
  if (res.status === 429)
    throw new LLMError('요청이 너무 많거나 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.', { kind: 'rate', status: 429 });
  if (res.status >= 500)
    throw new LLMError('AI 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.', { kind: 'api', status: res.status });
  throw new LLMError(`요청 오류 (${res.status}): ${msg}`.slice(0, 300), { kind: 'api', status: res.status });
}

export function parseJSON(text) {
  const t = String(text).trim();
  try {
    return JSON.parse(t);
  } catch {
    // 코드펜스나 앞뒤 글이 섞인 경우 첫 { 부터 마지막 } 까지
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {}
    }
    throw new LLMError('AI 응답을 해석하지 못했습니다. 다시 시도해 주세요.', { kind: 'parse' });
  }
}
