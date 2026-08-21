const CONFIG_CACHE = "jumping-push-config-v1";
const CONFIG_KEY = "/__push-config";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function saveConfig(config) {
  const cache = await caches.open(CONFIG_CACHE);
  await cache.put(CONFIG_KEY, new Response(JSON.stringify(config), {
    headers: { "content-type": "application/json" },
  }));
}

async function readConfig() {
  const response = await (await caches.open(CONFIG_CACHE)).match(CONFIG_KEY);
  return response ? response.json() : null;
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "PUSH_CONFIG") return;
  event.waitUntil(saveConfig({
    deviceId: String(event.data.deviceId || ""),
    deviceToken: String(event.data.deviceToken || ""),
  }).then(() => event.ports?.[0]?.postMessage({ ok: true })));
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const config = await readConfig();
    let title = "점핑배틀 매출 브리핑";
    let body = "오늘 매출 요약을 확인해주세요.";
    let targetUrl = "/admin/analytics";
    let tag = "jumping-battle-daily-sales";
    let notificationKind = "briefing";
    if (config?.deviceId && config?.deviceToken) {
      try {
        const response = await fetch(
          `/api/push/briefing?deviceId=${encodeURIComponent(config.deviceId)}`,
          {
            headers: { "x-push-device-token": config.deviceToken },
            cache: "no-store",
          },
        );
        if (response.ok) {
          const briefing = await response.json();
          title = briefing.title || title;
          body = briefing.body || body;
          targetUrl = briefing.url || targetUrl;
          tag = briefing.tag || tag;
          notificationKind = briefing.kind || notificationKind;
        }
      } catch {
        // A visible fallback notification is required when the summary fetch fails.
      }
    }
    await self.registration.showNotification(title, {
      body,
      icon: "/app-icon-512.png",
      badge: "/app-icon-192.png",
      tag,
      renotify: true,
      data: { url: targetUrl, kind: notificationKind },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const requestedUrl = new URL(event.notification.data?.url || "/admin", self.location.origin);
  const isOperationalNotification =
    event.notification.data?.kind === "operation" ||
    requestedUrl.pathname === "/admin/remote";
  const targetUrl = new URL(
    isOperationalNotification ? "/admin/remote" : requestedUrl.href,
    self.location.origin,
  );
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const adminClient = windows.find((windowClient) => {
      const clientUrl = new URL(windowClient.url);
      return clientUrl.origin === self.location.origin && clientUrl.pathname.startsWith("/admin");
    });
    if (adminClient) {
      await adminClient.navigate(targetUrl.href);
      return adminClient.focus();
    }
    return self.clients.openWindow(targetUrl.href);
  })());
});
