import type { MetadataRoute } from "next";

const CUSTOMER_APP_MANIFEST = {
  name: "점핑배틀 고객 예약",
  short_name: "고객 예약",
  description: "점핑배틀 화성병점점 오늘 방문 고객 전용 예약 앱입니다.",
  id: "/reserve",
  start_url: "/reserve",
  scope: "/reserve",
  display: "standalone",
  background_color: "#fff7f2",
  theme_color: "#ff642e",
  orientation: "portrait",
  icons: [
    {
      src: "/reserve-icon-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/reserve-icon-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ],
} satisfies MetadataRoute.Manifest;

export function GET() {
  return Response.json(CUSTOMER_APP_MANIFEST, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "application/manifest+json; charset=utf-8",
    },
  });
}
