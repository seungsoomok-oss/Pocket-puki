// 인터뷰 흐름 로직. 질문 수(10개)는 AI가 아니라 이 코드가 셉니다.
import {
  TOTAL_QUESTIONS,
  AREAS,
  PERSONAS,
  questionSystemPrompt,
  questionUserPrompt,
  QUESTION_SCHEMA,
  reportSystemPrompt,
  reportUserPrompt,
  REPORT_SCHEMA,
  RETRY_NOTE,
} from './prompts.js';
import { callJSON, LLMError } from './llm.js';
import { uid, saveInterview, saveReport } from './storage.js';

export function createInterview(name, persona = 'self') {
  const iv = {
    id: uid(),
    name: name.trim(),
    persona,
    startedAt: Date.now(),
    qa: [],
    current: null,
    draft: '',
    status: 'in_progress',
  };
  saveInterview(iv);
  return iv;
}

// 진행 상황 분석: 다룬 영역, 남은 영역, 이번 질문에 코드가 강제할 규칙
export function planFor(iv) {
  const number = iv.qa.length + 1;
  const remainingIncl = TOTAL_QUESTIONS - number + 1; // 이번 질문 포함
  const covered = [...new Set(iv.qa.map((x) => x.area).filter(Boolean))];
  const uncovered = AREAS.filter((a) => !covered.includes(a));
  const followUps = iv.qa.filter((x) => x.isFollowUp).length;
  const last2 = iv.qa.slice(-2);
  const constraints = [];

  // 같은 주제 연속 3번 방지
  if (last2.length === 2 && last2.every((x) => x.isFollowUp)) {
    constraints.push('직전 두 질문이 연속 후속 질문이었습니다. 이번에는 반드시 새로운 영역으로 넘어가세요 (isFollowUp: false).');
  } else if (followUps === 0 && number >= 7) {
    // 7번째까지 후속 질문이 없었다면 반드시 후속 질문 (완료 기준: 최소 1회)
    constraints.push('아직 후속 질문이 한 번도 없었습니다. 이번 질문은 반드시 앞 답변 중 가장 중요한 단서를 파고드는 후속 질문이어야 합니다 (isFollowUp: true).');
  } else if (uncovered.length >= remainingIncl) {
    constraints.push(`남은 질문(${remainingIncl}개)이 아직 다루지 않은 영역(${uncovered.length}개)보다 적거나 같습니다. 후속 질문 대신 다루지 않은 영역 중 하나로 질문하세요.`);
  }
  if (number === TOTAL_QUESTIONS) {
    constraints.push('이번이 마지막 질문입니다. 지금까지 드러나지 않은 핵심을 확인하거나, 전체를 아우르는 질문으로 마무리하세요.');
  }
  return { number, remainingIncl, covered, uncovered, followUps, constraints };
}

function validateQuestion(q) {
  const problems = [];
  if (!q || typeof q.question !== 'string' || q.question.trim().length < 5) problems.push('question이 비어 있습니다.');
  if (!AREAS.includes(q?.area)) problems.push(`area는 다음 중 하나여야 합니다: ${AREAS.join(', ')}`);
  if (typeof q?.isFollowUp !== 'boolean') problems.push('isFollowUp은 true/false여야 합니다.');
  return problems;
}

/** 다음 질문 생성 → iv.current에 저장 */
export async function generateNextQuestion(iv) {
  if (iv.qa.length >= TOTAL_QUESTIONS) throw new Error('이미 10개 질문을 모두 마쳤습니다.');
  const persona = PERSONAS[iv.persona] || PERSONAS.self;
  const p = planFor(iv);
  const system = questionSystemPrompt(persona);
  let user = questionUserPrompt({
    name: iv.name,
    qa: iv.qa,
    number: p.number,
    coveredAreas: p.covered,
    uncoveredAreas: p.uncovered,
    constraints: p.constraints,
  });

  let q;
  for (let attempt = 0; attempt < 2; attempt++) {
    q = await callJSON({ system, user, schema: QUESTION_SCHEMA, schemaName: 'interview_question', effort: 'medium' });
    const problems = validateQuestion(q);
    if (!problems.length) break;
    if (attempt === 1) throw new LLMError('질문을 만들지 못했습니다. 다시 시도해 주세요.', { kind: 'parse' });
    user += RETRY_NOTE(problems);
  }
  iv.current = {
    question: q.question.trim(),
    area: q.area,
    isFollowUp: !!q.isFollowUp,
    intent: q.intent || '',
    remainingPlan: q.remainingPlan || '',
  };
  saveInterview(iv);
  return iv.current;
}

/** 현재 질문에 답변 → 문답 기록. 10개를 채우면 true 반환 */
export function submitAnswer(iv, answer) {
  if (!iv.current) throw new Error('현재 질문이 없습니다.');
  iv.qa.push({ ...iv.current, answer: answer.trim() });
  iv.current = null;
  iv.draft = '';
  saveInterview(iv);
  return iv.qa.length >= TOTAL_QUESTIONS;
}

const norm = (s) => String(s).replace(/[\s"'“”‘’.,!?…·~\-]/g, '').toLowerCase();

// 공유용 텍스트(시·상징·키워드)에 답변 원문이 그대로 들어갔는지 검사
export function findLeaks(r, qa, name = '') {
  const N = 9; // 공백·문장부호 제외 9글자 이상 연속 일치하면 원문 노출로 봄
  const answers = qa.map((x) => norm(x.answer || ''));
  const pub = [r?.symbol, ...(r?.keywords || []), r?.poem?.title, ...(r?.poem?.lines || [])].filter(Boolean);
  const leaks = [];
  for (const text of pub) {
    const t = norm(text);
    for (let i = 0; i + N <= t.length; i++) {
      const g = t.slice(i, i + N);
      if (answers.some((a) => a.includes(g))) {
        leaks.push(`공유용 시에 답변 원문 표현이 그대로 들어 있습니다: "${text}". 은유로 바꾸세요.`);
        break;
      }
    }
    if (name && name.length >= 2 && text.includes(name)) leaks.push(`공유용 시에 대상자 이름을 넣지 마세요: "${text}"`);
  }
  return leaks;
}

export function validateReport(r, qa, name = '') {
  const problems = [];
  if (!r || typeof r !== 'object') return ['JSON 객체가 아닙니다.'];
  const lines = (r.poem?.lines || []).filter((l) => String(l).trim());
  if (!r.poem?.title?.trim()) problems.push('poem.title이 비어 있습니다.');
  if (lines.length < 6 || lines.length > 14) problems.push('poem.lines는 내용 있는 행이 8~12행이어야 합니다.');
  if (!r.symbol?.trim()) problems.push('symbol이 비어 있습니다.');
  if (!Array.isArray(r.keywords) || r.keywords.length < 2) problems.push('keywords는 3개여야 합니다.');
  if (!r.letter?.trim()) problems.push('letter가 비어 있습니다.');
  problems.push(...findLeaks(r, qa, name));
  if (!r.oneLiner?.trim()) problems.push('oneLiner가 비어 있습니다.');
  if (!Array.isArray(r.traits) || r.traits.length < 3 || r.traits.length > 5) problems.push('traits는 3~5개여야 합니다.');
  (r.traits || []).forEach((t, i) => {
    if (!t?.name || !t?.description) problems.push(`traits[${i}]의 name/description이 비어 있습니다.`);
    if (!Array.isArray(t?.evidence) || !t.evidence.length) {
      problems.push(`traits[${i}]에 evidence(답변 인용)가 없습니다.`);
      return;
    }
    t.evidence.forEach((e) => {
      const ans = qa[e.questionNo - 1]?.answer;
      if (!ans) problems.push(`traits[${i}]의 questionNo ${e.questionNo}가 잘못되었습니다.`);
      else if (!norm(ans).includes(norm(e.quote).slice(0, 12)))
        problems.push(`traits[${i}]의 인용 "${e.quote}"가 Q${e.questionNo} 답변 원문에 없습니다. 원문 그대로 인용하세요.`);
    });
  });
  for (const k of ['strengths', 'blindSpots', 'motivations']) {
    if (!Array.isArray(r[k]) || !r[k].length) problems.push(`${k}가 비어 있습니다.`);
  }
  if (!r.summary?.trim()) problems.push('summary가 비어 있습니다.');
  return problems;
}

/** 보고서 생성 → 저장 */
export async function generateReport(iv) {
  const persona = PERSONAS[iv.persona] || PERSONAS.self;
  const system = reportSystemPrompt(persona);
  let user = reportUserPrompt({ name: iv.name, qa: iv.qa });
  let r;
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    r = await callJSON({ system, user, schema: REPORT_SCHEMA, schemaName: 'profile_report', effort: 'high' });
    problems = validateReport(r, iv.qa, iv.name);
    if (!problems.length) break;
    user += RETRY_NOTE(problems);
  }
  // 재시도 후에도 구조가 깨졌으면 실패. 인용 불일치는 진행.
  // 원문 노출이 남아 있으면 해당 행을 공유 화면에서 숨김 처리.
  const fatal = problems.filter((p) => !p.includes('원문에 없습니다') && !p.startsWith('공유용 시에'));
  if (problems.some((p) => p.startsWith('공유용 시에'))) {
    const leaky = new Set(findLeaks(r, iv.qa, iv.name).map((p) => (p.match(/"(.*)"/) || [])[1]));
    r.poem.lines = r.poem.lines.filter((l) => !leaky.has(l));
    r.keywords = (r.keywords || []).filter((k) => !leaky.has(k));
    if (leaky.has(r.symbol)) r.symbol = '';
    if (leaky.has(r.poem.title)) r.poem.title = '무제';
  }
  if (fatal.length) throw new LLMError('보고서 형식이 올바르지 않습니다. 다시 시도해 주세요.', { kind: 'parse' });

  const rec = { interviewId: iv.id, name: iv.name, createdAt: Date.now(), report: r };
  saveReport(rec);
  iv.status = 'completed';
  iv.completedAt = rec.createdAt;
  saveInterview(iv);
  return rec;
}
