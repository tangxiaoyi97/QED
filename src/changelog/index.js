import { DEFAULT_LOCALE } from '../i18n/messages.js';

const modules = import.meta.glob('./*.json', { eager: true });

function compareSemver(a, b) {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const entries = Object.values(modules)
  .map((mod) => mod?.default ?? mod)
  .filter((entry) => entry && typeof entry.version === 'string' && entry.locales)
  .sort((a, b) => compareSemver(b.version, a.version));

const byVersion = new Map(entries.map((entry) => [entry.version, entry]));

function pickEntry(version) {
  if (version && byVersion.has(version)) return byVersion.get(version);
  return entries[0] ?? null;
}

export function getChangelog(version, locale) {
  const entry = pickEntry(version);
  if (!entry) return null;
  const localized = entry.locales[locale] ?? entry.locales[DEFAULT_LOCALE] ?? null;
  if (!localized) return null;
  return {
    version: entry.version,
    intro: localized.intro ?? '',
    highlights: Array.isArray(localized.highlights) ? localized.highlights : []
  };
}

export function listChangelogVersions() {
  return entries.map((entry) => entry.version);
}
