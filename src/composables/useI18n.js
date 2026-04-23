import { computed, ref } from 'vue';
import { DEFAULT_LOCALE, LOCALE_LABELS, SUPPORTED_LOCALES, messages } from '../i18n/messages.js';

const STORAGE_KEY = 'qed.locale';

function readStoredLocale() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredLocale(nextLocale) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, nextLocale);
  } catch {
    // Ignore write failures in restricted environments.
  }
}

function resolveInitialLocale() {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;

  const persisted = readStoredLocale();
  if (persisted && SUPPORTED_LOCALES.includes(persisted)) {
    return persisted;
  }

  const browser = window.navigator?.language || '';
  const exact = SUPPORTED_LOCALES.find((locale) => locale.toLowerCase() === browser.toLowerCase());
  if (exact) return exact;

  if (browser.toLowerCase().startsWith('de')) return 'de-AT';
  if (browser.toLowerCase().startsWith('en')) return 'en-US';
  return DEFAULT_LOCALE;
}

const locale = ref(resolveInitialLocale());

const localeOptions = SUPPORTED_LOCALES.map((value) => ({
  value,
  label: LOCALE_LABELS[value] ?? value
}));

const activeMessages = computed(() => messages[locale.value] ?? messages[DEFAULT_LOCALE]);

function readPath(obj, path) {
  return path.split('.').reduce((acc, segment) => {
    if (acc && Object.hasOwn(acc, segment)) return acc[segment];
    return undefined;
  }, obj);
}

function applyDocumentMetadata(nextLocale) {
  if (typeof document === 'undefined') return;
  const localized = messages[nextLocale] ?? messages[DEFAULT_LOCALE];
  const fallback = messages[DEFAULT_LOCALE];
  const title = readPath(localized, 'appMeta.title') ?? readPath(fallback, 'appMeta.title') ?? 'QED';
  const description = readPath(localized, 'appMeta.description') ?? readPath(fallback, 'appMeta.description') ?? '';

  document.documentElement.lang = nextLocale;
  document.title = String(title);
  const meta = document.querySelector('meta[name="description"]');
  if (meta) {
    meta.setAttribute('content', String(description));
  }
}

function applyParams(template, params) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (Object.hasOwn(params, key)) return String(params[key]);
    return `{${key}}`;
  });
}

function t(key, params = {}) {
  const localized = readPath(activeMessages.value, key);
  const fallback = readPath(messages[DEFAULT_LOCALE], key);
  const resolved = localized ?? fallback ?? key;
  return applyParams(resolved, params);
}

function setLocale(nextLocale) {
  if (!SUPPORTED_LOCALES.includes(nextLocale)) return;
  locale.value = nextLocale;
  applyDocumentMetadata(nextLocale);
  writeStoredLocale(nextLocale);
}

applyDocumentMetadata(locale.value);

export function useI18n() {
  return {
    locale,
    localeOptions,
    setLocale,
    t
  };
}
