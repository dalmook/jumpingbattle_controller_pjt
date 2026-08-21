(() => {
  if (globalThis.__jumpingBattleFastSyncTrigger) return;
  globalThis.__jumpingBattleFastSyncTrigger = true;

  const VISIBLE_INTERVAL_MS = 5_000;
  const HIDDEN_INTERVAL_MS = 10_000;
  const INITIAL_DELAY_MS = 1_500;
  let timerId = 0;
  let inFlight = false;

  function baseInterval() {
    return document.hidden ? HIDDEN_INTERVAL_MS : VISIBLE_INTERVAL_MS;
  }

  function schedule(delayMs = baseInterval()) {
    window.clearTimeout(timerId);
    timerId = window.setTimeout(runOnce, Math.max(1_000, Number(delayMs) || baseInterval()));
  }

  async function runOnce() {
    if (inFlight) {
      schedule();
      return;
    }

    inFlight = true;
    let nextDelay = baseInterval();
    try {
      const result = await chrome.runtime.sendMessage({
        type: "NAVER_FAST_SYNC_TICK",
        pageHidden: document.hidden
      });
      if (Number(result?.nextPollMs) > nextDelay) {
        nextDelay = Number(result.nextPollMs);
      }
    } catch (_) {
      // The 30-second chrome.alarms path remains the fallback when the worker
      // is restarting or this tab is being navigated.
    } finally {
      inFlight = false;
      schedule(nextDelay);
    }
  }

  document.addEventListener("visibilitychange", () => schedule(500));
  window.addEventListener("pageshow", () => schedule(500));
  schedule(INITIAL_DELAY_MS);
})();
