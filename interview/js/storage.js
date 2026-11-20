// localStorage 저장소. 모든 데이터는 이 기기에만 저장됩니다.
const K = {
  interviews: 'ai-interview:interviews',
  reports: 'ai-interview:reports',
  settings: 'ai-interview:settings',
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ── 인터뷰 ──
// { id, name, persona, startedAt, qa: [{question, answer, area, isFollowUp, intent, remainingPlan}],
//   current: {question, area, isFollowUp, intent, remainingPlan} | null, draft, status: 'in_progress'|'completed' }
export function listInterviews() {
  return read(K.interviews, []);
}
export function getInterview(id) {
  return listInterviews().find((x) => x.id === id) || null;
}
export function saveInterview(iv) {
  const all = listInterviews();
  const i = all.findIndex((x) => x.id === iv.id);
  if (i >= 0) all[i] = iv;
  else all.push(iv);
  write(K.interviews, all);
}
export function getInProgress() {
  return listInterviews()
    .filter((x) => x.status === 'in_progress')
    .sort((a, b) => b.startedAt - a.startedAt)[0] || null;
}
export function deleteInterview(id) {
  write(K.interviews, listInterviews().filter((x) => x.id !== id));
}

// ── 보고서 ──
// { interviewId, createdAt, report: {oneLiner, traits, strengths, blindSpots, motivations, summary} }
export function listReports() {
  return read(K.reports, []).sort((a, b) => b.createdAt - a.createdAt);
}
export function getReport(interviewId) {
  return read(K.reports, []).find((x) => x.interviewId === interviewId) || null;
}
export function saveReport(rec) {
  const all = read(K.reports, []).filter((x) => x.interviewId !== rec.interviewId);
  all.push(rec);
  write(K.reports, all);
}
export function deleteReport(interviewId) {
  write(K.reports, read(K.reports, []).filter((x) => x.interviewId !== interviewId));
  deleteInterview(interviewId);
}

// ── 설정 ──
export const DEFAULT_SETTINGS = {
  provider: 'anthropic',
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  openaiKey: '',
  openaiModel: 'gpt-4.1-mini',
};
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(K.settings, {}) };
}
export function saveSettings(s) {
  write(K.settings, s);
}

export function clearAll() {
  Object.values(K).forEach((k) => localStorage.removeItem(k));
}
