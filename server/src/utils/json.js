export function parseLooseJson(text) {
  if (typeof text !== 'string') return text;
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] || trimmed).trim();
  try { return JSON.parse(candidate); } catch {}
  const firstObj = candidate.indexOf('{');
  const lastObj = candidate.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) {
    try { return JSON.parse(candidate.slice(firstObj, lastObj + 1)); } catch {}
  }
  throw new Error('A IA respondeu fora do JSON esperado.');
}

export function safeJson(value) {
  return JSON.parse(JSON.stringify(value));
}
