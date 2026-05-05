import fs from 'node:fs/promises';
import { loadPdfjs } from './pdfjs.js';

// LRU cache keyed by `${absolutePath}:${mtimeMs}:${size}` so:
// - the same Lösung file shared across libraries doesn't collide;
// - replacing a Lösung PDF on disk invalidates its cached tiers.
const CACHE_LIMIT = 128;
const CACHE = new Map();

function lruGet(key) {
  if (!CACHE.has(key)) return undefined;
  const value = CACHE.get(key);
  // Refresh recency by re-inserting at the tail.
  CACHE.delete(key);
  CACHE.set(key, value);
  return value;
}

function lruSet(key, value) {
  if (CACHE.has(key)) CACHE.delete(key);
  CACHE.set(key, value);
  while (CACHE.size > CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value;
    if (!oldest) break;
    CACHE.delete(oldest);
  }
}

async function fileSignature(filePath) {
  const stat = await fs.stat(filePath);
  return `${filePath}:${stat.mtimeMs}:${stat.size}`;
}

async function extractText(filePath) {
  const { getDocument } = await loadPdfjs();
  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false
  }).promise;

  let text = '';
  try {
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // Join items; PDF.js sometimes splits words so keep a space between items
      text += content.items.map((item) => (typeof item.str === 'string' ? item.str : '')).join(' ') + '\n';
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return text;
}

function parseGermanNumber(str) {
  if (typeof str !== 'string') return null;
  const n = parseFloat(str.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function isValidExamScore(n) {
  // Must be non-negative, at most 20, and a multiple of 0.5
  return n >= 0 && n <= 20 && Math.round(n * 2) === n * 2;
}

/**
 * Extract all score values (as numbers) mentioned near "Punkt/Punkte" in the given text.
 * Returns [] when nothing is found (caller should fall back to defaults).
 * Always includes 0 when any scores are found.
 */
export function parseScoresFromText(text) {
  const raw = new Set();

  // Pattern A: slash-separated list immediately before "Punkt(e)"
  // Examples: "0 / 1 / 2 / 3 Punkte"  "0/0,5/1/1,5 Punkt"
  const slashRe = /((?:\d+(?:[,\.]\d+)?)(?:\s*[/]\s*\d+(?:[,\.]\d+)?)+)\s*Punkt/gi;
  for (const m of text.matchAll(slashRe)) {
    for (const part of m[1].split('/')) {
      const n = parseGermanNumber(part);
      if (n !== null && isValidExamScore(n)) raw.add(n);
    }
  }

  // Pattern B: dash/en-dash range before "Punkt(e)"
  // Examples: "0–3 Punkte"  "0-3 Punkte"
  const rangeRe = /\b(\d+(?:[,\.]\d+)?)\s*[-–—]\s*(\d+(?:[,\.]\d+)?)\s*Punkt/gi;
  for (const m of text.matchAll(rangeRe)) {
    const lo = parseGermanNumber(m[1]);
    const hi = parseGermanNumber(m[2]);
    if (lo !== null && hi !== null && hi > lo && hi - lo <= 10) {
      for (let v = lo * 2; v <= hi * 2; v += 1) {
        const score = v / 2;
        if (isValidExamScore(score)) raw.add(score);
      }
    }
  }

  // Pattern C: "N bis M Punkte"
  // Example: "0 bis 3 Punkte"
  const bisRe = /\b(\d+(?:[,\.]\d+)?)\s+bis\s+(\d+(?:[,\.]\d+)?)\s*Punkt/gi;
  for (const m of text.matchAll(bisRe)) {
    const lo = parseGermanNumber(m[1]);
    const hi = parseGermanNumber(m[2]);
    if (lo !== null && hi !== null && hi > lo && hi - lo <= 10) {
      for (let v = lo * 2; v <= hi * 2; v += 1) {
        const score = v / 2;
        if (isValidExamScore(score)) raw.add(score);
      }
    }
  }

  // Pattern D: single number directly before "Punkt(e)" (catches any remaining)
  // Examples: "1 Punkt"  "2 Punkte"  "0,5 Punkte"
  // Use word boundary to avoid matching "10.3 Punkte" from something like "Aufgabe 10.3"
  const singleRe = /(?<![.\d])(\d+(?:[,\.]\d+)?)\s*Punkt/gi;
  for (const m of text.matchAll(singleRe)) {
    const n = parseGermanNumber(m[1]);
    if (n !== null && isValidExamScore(n)) raw.add(n);
  }

  // Pattern E: "Punkt(e): N" or "Punkt(e) N" (number after keyword)
  // Example: "Punkte: 2"
  const afterRe = /Punkt\w*[:\s]+\b(\d+(?:[,\.]\d+)?)\b/gi;
  for (const m of text.matchAll(afterRe)) {
    const n = parseGermanNumber(m[1]);
    if (n !== null && isValidExamScore(n)) raw.add(n);
  }

  if (raw.size === 0) return []; // nothing detected → caller uses fallback

  raw.add(0); // zero is always a valid score
  return [...raw].sort((a, b) => a - b);
}

/**
 * Returns score tiers for a question given the path to its Lösung PDF.
 * Returns [] when no PDF or nothing parseable (caller should use default range).
 *
 * The cache is keyed by file signature (path + mtime + size), so:
 * - the same questionId across two libraries is cached separately;
 * - replacing the PDF on disk transparently invalidates the cached entry.
 */
export async function getScoreTiers(questionId, loPdfPath) {
  if (!loPdfPath) return [];

  let signature;
  try {
    signature = await fileSignature(loPdfPath);
  } catch {
    return []; // file missing / unreadable
  }

  const cached = lruGet(signature);
  if (cached !== undefined) return cached;

  try {
    const text = await extractText(loPdfPath);
    const scores = parseScoresFromText(text);
    lruSet(signature, scores);
    return scores;
  } catch (error) {
    console.error(`[score-parser] ${questionId}: ${error.message}`);
    lruSet(signature, []);
    return [];
  }
}

export function clearScoreCache() {
  CACHE.clear();
}
