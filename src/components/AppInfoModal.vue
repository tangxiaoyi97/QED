<script setup>
import { useI18n } from '../composables/useI18n.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  refreshing: { type: Boolean, default: false },
  error: { type: String, default: '' },
  info: {
    type: Object,
    default: () => ({
      appName: 'QED',
      version: null,
      gitCommit: null,
      questionCount: 0,
      suiteCount: 0,
      profileCount: 0,
      githubUrl: 'https://github.com/tangxiaoyi97/QED',
      authors: '唐晓翼 & 白清',
      acknowledgements: ['Claude', 'Codex'],
      license: 'MIT'
    })
  }
});

defineEmits(['close', 'refresh-catalog']);
const { t } = useI18n();

function displayValue(value) {
  if (value === null || value === undefined || value === '') return t('common.unknown');
  return value;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
      <section class="modal-panel app-info-panel" role="dialog" aria-modal="true" :aria-label="t('appInfo.ariaLabel')">
        <header class="modal-header">
          <div>
            <span class="eyebrow">{{ info.appName || 'QED' }}</span>
            <h2 class="modal-title">{{ t('appInfo.title') }}</h2>
          </div>
          <button class="icon-button" type="button" @click="$emit('close')">✕</button>
        </header>

        <div class="app-info-body">
          <p v-if="loading" class="muted-copy">{{ t('appInfo.loading') }}</p>
          <p v-if="error" class="app-info-error">{{ error }}</p>

          <div class="app-info-list">
            <div class="app-info-row">
              <span>{{ t('appInfo.version') }}</span>
              <strong>v{{ displayValue(info.version) }}</strong>
            </div>
            <div class="app-info-row">
              <span>{{ t('appInfo.gitCommit') }}</span>
              <strong>{{ displayValue(info.gitCommit) }}</strong>
            </div>
            <div class="app-info-row">
              <span>{{ t('appInfo.catalogInfo') }}</span>
              <strong>{{ t('appInfo.catalogStats', { questions: displayValue(info.questionCount), suites: displayValue(info.suiteCount) }) }}</strong>
            </div>
            <div class="app-info-row">
              <span>{{ t('appInfo.profileCount') }}</span>
              <strong>{{ displayValue(info.profileCount) }}</strong>
            </div>
            <div class="app-info-row">
              <span>{{ t('appInfo.github') }}</span>
              <a :href="info.githubUrl || 'https://github.com/tangxiaoyi97/QED'" target="_blank" rel="noreferrer">
                {{ info.githubUrl || 'https://github.com/tangxiaoyi97/QED' }}
              </a>
            </div>
            <div class="app-info-row">
              <span>{{ t('appInfo.authors') }}</span>
              <strong>{{ displayValue(info.authors) }}</strong>
            </div>
            <div class="app-info-row">
              <span>{{ t('appInfo.acknowledgements') }}</span>
              <strong>{{ Array.isArray(info.acknowledgements) ? info.acknowledgements.join(' / ') : 'Claude / Codex' }}</strong>
            </div>
            <div class="app-info-row">
              <span>{{ t('appInfo.license') }}</span>
              <strong>{{ displayValue(info.license) }}</strong>
            </div>
          </div>

          <div class="app-info-actions">
            <button
              class="pill-button pill-button--dark"
              type="button"
              :disabled="refreshing"
              @click="$emit('refresh-catalog')"
            >
              {{ refreshing ? t('appInfo.refreshing') : t('appInfo.refreshCatalog') }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.app-info-panel {
  width: min(620px, 100%);
}

.app-info-body {
  display: grid;
  gap: 14px;
}

.app-info-error {
  margin: 0;
  color: #c94a42;
  font-size: 13px;
  font-weight: 600;
}

.app-info-list {
  display: grid;
  gap: 8px;
}

.app-info-row {
  min-height: 38px;
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface-muted);
}

.app-info-row > span {
  color: var(--text-soft);
  font-size: 13px;
  font-weight: 600;
}

.app-info-row > strong,
.app-info-row > a {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text);
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}

.app-info-row > a:hover {
  text-decoration: underline;
}

.app-info-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
