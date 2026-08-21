import type { MetadataRoute } from "next";

const MEMBER_MANIFEST = {
  name: "점핑배틀 MY",
  short_name: "점핑배틀 MY",
  description: "내 이용권, 무료 이용권, 스탬프와 이용내역을 확인합니다.",
  id: "/member",
  start_url: "/member",
  scope: "/member",
  display: "standalone",
  background_color: "#f5f6f8",
  theme_color: "#ff642e",
  orientation: "portrait",
  icons: [
    { src: "/reserve-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/reserve-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
} satisfies MetadataRoute.Manifest;

export function GET() {
  return Response.json(MEMBER_MANIFEST, {
    headers: {
      "cache-control": "public, max-age=3600",
      "content-type": "application/manifest+json; charset=utf-8",
    },
  });
}
