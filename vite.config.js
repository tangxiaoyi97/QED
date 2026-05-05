import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The application version is sourced from the running server (via /api/about
// and the bootstrap response) rather than baked into the bundle, so a single
// build can be deployed against newer servers without going stale.
export default defineConfig({
  plugins: [vue()],
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
