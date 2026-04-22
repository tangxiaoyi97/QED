import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
import 'katex/dist/katex.min.css';
import { router } from './router.js';

createApp(App).use(router).mount('#app');
