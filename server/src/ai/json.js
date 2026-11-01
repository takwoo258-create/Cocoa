// 从模型输出中鲁棒地提取 JSON
export function extractJson(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  const raw = String(text).trim();
  const attempts = [];
  attempts.push(raw);
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1].trim());
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(raw.slice(start, end + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

export function normalizeYesNo(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (t.startsWith('yes')) return 'yes';
  if (t.startsWith('no')) return 'no';
  return null;
}
