<script setup>
import { useI18n } from '../composables/useI18n.js';

const appVersion = __APP_VERSION__;

const props = defineProps({
  mode: {
    type: String,
    required: true
  },
  searchCount: {
    type: Number,
    default: 0
  },
  locale: {
    type: String,
    default: 'zh-CN'
  },
  localeOptions: {
    type: Array,
    default: () => []
  },
  isGuest: {
    type: Boolean,
    default: true
  },
  profile: {
    type: String,
    default: 'guest'
  }
});

defineEmits(['switch-mode', 'open-exam', 'open-search', 'change-locale', 'open-settings', 'open-about']);

const { t } = useI18n();
</script>

<template>
  <header class="top-nav">
    <button class="brand-lockup brand-lockup-button" type="button" @click="$emit('open-about')">
      <span class="brand-mark">Q</span>
      <div>
        <strong>{{ t('topNav.brandTitle') }}</strong>
        <span>v{{ appVersion }}</span>
      </div>
    </button>

    <nav class="mode-switch" :aria-label="t('topNav.modeAria')">
      <button
        class="pill-button"
        :class="{ 'pill-button--dark': mode === 'random' }"
        type="button"
        @click="$emit('switch-mode', 'random')"
      >
        {{ t('topNav.random') }}
      </button>
      <button
        class="pill-button"
        :class="{ 'pill-button--dark': mode === 'browse' }"
        type="button"
        @click="$emit('switch-mode', 'browse')"
      >
        {{ t('topNav.browse') }}
      </button>
      <button
        class="pill-button"
        :class="{ 'pill-button--dark': mode === 'stats' }"
        type="button"
        @click="$emit('switch-mode', 'stats')"
      >
        {{ t('topNav.stats') }}
      </button>
      <button
        v-if="!isGuest"
        class="pill-button"
        :class="{ 'pill-button--dark': mode === 'ai' }"
        type="button"
        @click="$emit('switch-mode', 'ai')"
      >
        {{ t('topNav.ai') }}
      </button>
      <button
        class="pill-button"
        :class="{ 'pill-button--dark': mode === 'records' }"
        type="button"
        @click="$emit('switch-mode', 'records')"
      >
        {{ t('topNav.records') }}
      </button>
      <button
        v-if="!isGuest"
        class="pill-button pill-button--warm"
        type="button"
        @click="$emit('open-exam')"
      >
        {{ t('topNav.exam') }}
      </button>
    </nav>

    <div class="top-nav-actions">
      <!-- Guest mode badge -->
      <span v-if="isGuest" class="guest-badge" @click="$emit('open-settings')">
        {{ t('topNav.guest') }}
      </span>

      <div class="nav-control nav-control--select">
        <select :value="locale" @change="$emit('change-locale', $event.target.value)">
          <option v-for="item in localeOptions" :key="item.value" :value="item.value">
            {{ item.label }}
          </option>
        </select>
      </div>

      <button class="pill-button nav-control" type="button" @click="$emit('open-settings')">
        {{ isGuest ? t('topNav.profile') : '@' + profile }}
      </button>

      <button class="pill-button nav-control search-trigger" type="button" @click="$emit('open-search')">
        {{ t('topNav.search') }}<span v-if="searchCount"> · {{ searchCount }}</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.brand-lockup-button {
  border: 0;
  background: transparent;
  padding: 0;
  text-align: left;
}

.brand-lockup-button:hover .brand-mark {
  transform: translateY(-1px);
}

.brand-mark {
  transition: transform 140ms ease;
}
</style>
