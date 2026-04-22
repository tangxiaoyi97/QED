import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(version)
  },
  server: {
    middlewareMode: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('pdfjs-dist')) return 'pdf-runtime';
          if (id.includes('/node_modules/vue/')) return 'vue-vendor';
          if (id.includes('/src/components/ExamWorkspace.vue')) return 'exam-workspace';
          if (id.includes('/src/components/StatsView.vue')) return 'stats-workspace';
          return null;
        }
      }
    }
  }
});
