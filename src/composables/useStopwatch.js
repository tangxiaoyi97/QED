import { computed, onBeforeUnmount, ref } from 'vue';

export function useStopwatch() {
  const elapsedSeconds = ref(0);
  const running = ref(false);
  let intervalId = null;

  function start() {
    if (running.value) return;
    running.value = true;
    intervalId = window.setInterval(() => {
      elapsedSeconds.value += 1;
    }, 1000);
  }

  function stop() {
    running.value = false;
    if (intervalId) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  }

  function reset() {
    stop();
    elapsedSeconds.value = 0;
  }

  onBeforeUnmount(stop);

  return {
    elapsedSeconds,
    running: computed(() => running.value),
    start,
    stop,
    reset
  };
}
