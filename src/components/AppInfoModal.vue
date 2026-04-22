<script setup>
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

function displayValue(value) {
  if (value === null || value === undefined || value === '') return '未知';
  return value;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="$emit('close')">
      <section class="modal-panel app-info-panel" role="dialog" aria-modal="true" aria-label="QED 信息">
        <header class="modal-header">
          <div>
            <span class="eyebrow">{{ info.appName || 'QED' }}</span>
            <h2 class="modal-title">项目信息</h2>
          </div>
          <button class="icon-button" type="button" @click="$emit('close')">✕</button>
        </header>

        <div class="app-info-body">
          <p v-if="loading" class="muted-copy">正在读取信息...</p>
          <p v-if="error" class="app-info-error">{{ error }}</p>

          <div class="app-info-list">
            <div class="app-info-row">
              <span>当前版本</span>
              <strong>v{{ displayValue(info.version) }}</strong>
            </div>
            <div class="app-info-row">
              <span>当前 Git 提交</span>
              <strong>{{ displayValue(info.gitCommit) }}</strong>
            </div>
            <div class="app-info-row">
              <span>题库信息</span>
              <strong>{{ displayValue(info.questionCount) }} 题 · {{ displayValue(info.suiteCount) }} 套卷</strong>
            </div>
            <div class="app-info-row">
              <span>Profile 数量</span>
              <strong>{{ displayValue(info.profileCount) }}</strong>
            </div>
            <div class="app-info-row">
              <span>GitHub</span>
              <a :href="info.githubUrl || 'https://github.com/tangxiaoyi97/QED'" target="_blank" rel="noreferrer">
                {{ info.githubUrl || 'https://github.com/tangxiaoyi97/QED' }}
              </a>
            </div>
            <div class="app-info-row">
              <span>作者</span>
              <strong>{{ displayValue(info.authors) }}</strong>
            </div>
            <div class="app-info-row">
              <span>致谢</span>
              <strong>{{ Array.isArray(info.acknowledgements) ? info.acknowledgements.join(' / ') : 'Claude / Codex' }}</strong>
            </div>
            <div class="app-info-row">
              <span>开源协议</span>
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
              {{ refreshing ? '刷新中...' : '手动刷新题库' }}
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
