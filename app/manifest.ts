import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "점핑배틀 화성병점점 운영",
    short_name: "점핑배틀 운영",
    description: "예약·정산·원격제어와 매출 알림을 관리합니다.",
    id: "/admin",
    start_url: "/admin",
    scope: "/admin",
    display: "standalone",
    background_color: "#f4f6f8",
    theme_color: "#ff642e",
    orientation: "any",
    icons: [
      {
        src: "/app-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
    ],
  };
}
