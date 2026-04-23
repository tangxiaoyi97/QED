export function sanitizeModelName(value, fallback = 'gpt-5.4-mini') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (!/^[a-zA-Z0-9._:-]{2,64}$/.test(trimmed)) return fallback;
  return trimmed;
}

export function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
