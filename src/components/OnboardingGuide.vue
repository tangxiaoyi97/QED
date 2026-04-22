<script setup>
</script>

<template>
  <div class="onboarding-overlay">
    <div class="onboarding-modal">
      <header class="modal-header">
        <h2 class="modal-title">Welcome to QED</h2>
      </header>

      <div class="modal-body">
        <p class="muted-copy" style="font-size: 15px; max-width: 500px; margin-bottom: 24px;">
          It looks like your local <strong>library</strong> folder is empty. Before you can start practicing, you need to populate the database with past examination papers.
        </p>

        <section class="settings-section">
          <span class="eyebrow" style="margin-bottom: 8px; display: block;">1. The Library Structure</span>
          <p class="muted-copy" style="font-size: 13px;">
            The `library/` folder sits in the root of the project. Whenever the server starts or changes are detected, QED auto-indexes this folder hierarchically. 
            All sub-folders placed within are interpreted as independent "Suites" or "Exam Sets".
          </p>
          <div class="code-preview">
            library/<br/>
            └── [au]haupttermin-2023/<br/>
            &nbsp;&nbsp;&nbsp;&nbsp;└── [2023a1]t1-01.pdf
          </div>
        </section>

        <section class="settings-section" style="margin-top: 16px;">
          <span class="eyebrow" style="margin-bottom: 8px; display: block;">2. PDF Naming Format</span>
          <p class="muted-copy" style="font-size: 13px;">
            This system has been exclusively engineered to parse <strong>Austrian Matura</strong> mathematics question structures. Files must be natively named using the established signature format to be parsed correctly. 
            If you wish to parse materials from other sources or curriculums, you must manually extend/adapt the regex parser in <code>server/catalog.js</code>.
          </p>
          <div class="property-row" style="margin-top: 8px;">
            <span>Expected Pattern:</span>
            <span class="property-value">^[YYYY][a-z][0-9]]t[1|2]-[num](-[topic]).pdf$</span>
          </div>
        </section>

        <section class="settings-section" style="margin-top: 16px;">
          <span class="eyebrow" style="margin-bottom: 8px; display: block;">3. Profiles & Records</span>
          <p class="muted-copy" style="font-size: 13px;">
            Any time you do an exercise, the backend saves your metrics in isolated JSON locks inside the <code>profile/</code>. You can click the settings gear (top right) to swap user profiles without rebooting.
          </p>
        </section>

        <div style="margin-top: 24px; text-align: center;">
          <p class="muted-copy" style="font-size: 13px; font-weight: 600; color: var(--text);">
            Drag and drop your extracted Matura PDF directories into <code>library/</code>.<br/>
            QED will hot-reload automatically once files are detected.
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
