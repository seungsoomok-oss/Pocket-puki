// 공유: 이미지 저장(html2canvas), 공유 시트(Web Share API), 텍스트 복사

export function reportToText(rec) {
  const r = rec.report;
  const lines = [];
  lines.push(`【${rec.name}은(는) 어떤 사람인가】`);
  lines.push(`“${r.oneLiner}”`);
  lines.push('');
  lines.push('■ 핵심 특성');
  r.traits.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.name} — ${t.description}`);
    (t.evidence || []).forEach((e) => lines.push(`   └ Q${e.questionNo}: “${e.quote}”`));
  });
  lines.push('');
  lines.push('■ 강점');
  r.strengths.forEach((s) => lines.push(`· ${s}`));
  lines.push('');
  lines.push('■ 주의할 점');
  r.blindSpots.forEach((s) => lines.push(`· ${s}`));
  lines.push('');
  lines.push('■ 이 사람을 움직이는 것');
  r.motivations.forEach((s) => lines.push(`· ${s}`));
  lines.push('');
  lines.push('■ 요약');
  lines.push(r.summary);
  lines.push('');
  lines.push('— AI 인터뷰 10문 10답');
  return lines.join('\n');
}

// 공유용: 시만 (사적인 분석·편지는 포함하지 않음)
export function poemToText(rec) {
  const r = rec.report;
  const out = [`「${r.poem.title}」`, ''];
  r.poem.lines.forEach((l) => out.push(String(l).trim() ? l : ''));
  if (r.keywords?.length) out.push('', r.keywords.map((k) => `#${k.replace(/\s+/g, '')}`).join(' '));
  out.push('', `— ${rec.name}님을 위한 시, 10문 10답`);
  return out.join('\n');
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 구형 브라우저 대비
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export async function shareText(title, text) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  const ok = await copyText(text);
  return ok ? 'copied' : 'failed';
}

export async function renderCardImage(el) {
  if (!window.html2canvas) throw new Error('이미지 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
  const bg = getComputedStyle(el).backgroundColor || '#ffffff';
  const canvas = await window.html2canvas(el, {
    scale: Math.min(3, Math.max(2, window.devicePixelRatio || 2)),
    backgroundColor: bg,
    useCORS: true,
    logging: false,
  });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지 생성 실패'))), 'image/png')
  );
}

/** 이미지 저장: 휴대폰에서는 공유 시트(사진에 저장 가능), 아니면 파일 다운로드 */
export async function saveCardImage(el, filename) {
  const blob = await renderCardImage(el);
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
