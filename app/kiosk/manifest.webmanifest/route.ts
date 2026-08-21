export async function GET() {
  return Response.json({
    name: "점핑배틀 현장 키오스크",
    short_name: "점핑배틀 키오스크",
    start_url: "/kiosk",
    scope: "/kiosk",
    display: "standalone",
    background_color: "#f5f7fb",
    theme_color: "#ff5a1f",
    icons: [
      { src: "/app-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/app-icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  }, { headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "no-cache" } });
}
