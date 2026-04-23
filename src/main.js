import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
import 'katex/dist/katex.min.css';
import { router } from './router.js';
import { initTheme } from './composables/useTheme.js';

// Apply the saved theme BEFORE Vue mounts to avoid a white flash on load
// for users who prefer dark mode.
initTheme();

createApp(App).use(router).mount('#app');
