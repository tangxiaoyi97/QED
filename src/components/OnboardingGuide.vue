<script setup>
import { useI18n } from '../composables/useI18n.js';

const { t } = useI18n();
</script>

<template>
  <div class="onboarding-overlay">
    <div class="onboarding-modal">
      <header class="modal-header">
        <h2 class="modal-title">{{ t('onboarding.title') }}</h2>
      </header>

      <div class="modal-body">
        <p class="muted-copy" style="font-size: 15px; max-width: 500px; margin-bottom: 24px;">
          {{ t('onboarding.intro') }}
        </p>

        <section class="settings-section">
          <span class="eyebrow" style="margin-bottom: 8px; display: block;">{{ t('onboarding.structureTitle') }}</span>
          <p class="muted-copy" style="font-size: 13px;">
            {{ t('onboarding.structureDesc') }}
          </p>
          <div class="code-preview">
            library/<br/>
            └── [au]haupttermin-2023/<br/>
            &nbsp;&nbsp;&nbsp;&nbsp;└── [2023a1]t1-01.pdf
          </div>
        </section>

        <section class="settings-section" style="margin-top: 16px;">
          <span class="eyebrow" style="margin-bottom: 8px; display: block;">{{ t('onboarding.namingTitle') }}</span>
          <p class="muted-copy" style="font-size: 13px;">
            {{ t('onboarding.namingDescPrimary') }} {{ t('onboarding.namingDescSecondary') }}
          </p>
          <div class="property-row" style="margin-top: 8px;">
            <span>{{ t('onboarding.expectedPattern') }}</span>
            <span class="property-value">^[YYYY][a-z][0-9]]t[1|2]-[num](-[topic]).pdf$</span>
          </div>
        </section>

        <section class="settings-section" style="margin-top: 16px;">
          <span class="eyebrow" style="margin-bottom: 8px; display: block;">{{ t('onboarding.profilesTitle') }}</span>
          <p class="muted-copy" style="font-size: 13px;">
            {{ t('onboarding.profilesDesc') }}
          </p>
        </section>

        <div style="margin-top: 24px; text-align: center;">
          <p class="muted-copy" style="font-size: 13px; font-weight: 600; color: var(--text);">
            {{ t('onboarding.footerLine1') }}<br/>
            {{ t('onboarding.footerLine2') }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.onboarding-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--surface);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.onboarding-modal {
  background: var(--surface);
  max-width: 600px;
  width: 100%;
}
.settings-section {
  background: var(--surface-muted);
  padding: 16px;
  border-radius: var(--radius-lg);
}
.code-preview {
  font-family: monospace;
  font-size: 13px;
  color: var(--text-muted);
  background: var(--border-subtle);
  padding: 12px;
  border-radius: var(--radius-md);
  margin-top: 8px;
}
.property-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
}
.property-value {
  font-family: monospace;
  background: var(--border-subtle);
  padding: 4px 8px;
  border-radius: var(--radius-xs);
  color: var(--text-muted);
}
</style>
