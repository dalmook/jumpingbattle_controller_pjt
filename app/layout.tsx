import type { Metadata } from "next";
import { headers } from "next/headers";
import PwaRegistration from "./PwaRegistration";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:4173";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const previewImage = `${protocol}://${host}/og.png`;

  return {
    title: "점핑배틀 화성병점점 운영",
    description: "점핑배틀 화성병점점의 예약·정산·원격제어와 매출 알림 운영",
    themeColor: "#ff642e",
    appleWebApp: {
      capable: true,
      title: "점핑배틀 운영",
      statusBarStyle: "default",
    },
    icons: {
      apple: "/app-icon-192.png",
    },
    openGraph: {
      type: "website",
      title: "점핑배틀 화성병점점 예약·원격 운영",
      description: "고객 예약부터 매장 정산과 안전한 게임룸 원격 제어까지",
      images: [
        {
          url: previewImage,
          width: 1200,
          height: 630,
          alt: "점핑배틀 화성병점점 예약·원격 운영",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "점핑배틀 화성병점점 예약·원격 운영",
      description: "고객 예약부터 매장 정산과 안전한 게임룸 원격 제어까지",
      images: [previewImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>
        <PwaRegistration />
        {children}
      </body>
    </html>
  );
}
