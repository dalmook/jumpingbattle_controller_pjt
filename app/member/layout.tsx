import type { Metadata } from "next";
import { headers } from "next/headers";
import "./member.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const previewImage = `${protocol}://${host}/member-og.png`;
  const description = "내 다회권, 무료 이용권, 스탬프와 최근 이용내역을 간편하게 확인하세요.";

  return {
    title: "점핑배틀 MY",
    description,
    applicationName: "점핑배틀 MY",
    manifest: "/member/manifest.webmanifest",
    themeColor: "#ff642e",
    appleWebApp: {
      capable: true,
      title: "점핑배틀 MY",
      statusBarStyle: "default",
    },
    icons: { apple: "/reserve-icon-192.png" },
    openGraph: {
      type: "website",
      title: "점핑배틀 MY",
      description,
      images: [{ url: previewImage, width: 1731, height: 909, alt: "점핑배틀 MY 내 이용권 화면" }],
    },
    twitter: { card: "summary_large_image", title: "점핑배틀 MY", description, images: [previewImage] },
  };
}

export default function MemberLayout({ children }: { children: React.ReactNode }) {
  return children;
}
