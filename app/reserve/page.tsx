import type { Metadata } from "next";
import ReserveForm from "./ReserveForm";
import { dateInSeoul } from "../reservation-config";
import { getPricingSettings } from "@/db/pricing-settings";
import { KioskKeyboardProvider } from "../kiosk/KioskKeyboard";
import "../kiosk/kiosk-keyboard.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "점핑배틀 화성병점점 오늘 입장 예약",
  description: "직원 안내에 따라 방을 고르고 가장 빠른 시간으로 접수하는 오늘 방문 고객 전용 예약",
  applicationName: "점핑배틀 고객 예약",
  manifest: "/reserve/manifest.webmanifest",
  themeColor: "#ff642e",
  appleWebApp: {
    capable: true,
    title: "점핑배틀 고객 예약",
    statusBarStyle: "default",
  },
  icons: {
    apple: "/reserve-icon-192.png",
  },
};

export default async function ReservePage() {
  const today = dateInSeoul();
  return <KioskKeyboardProvider>
    <ReserveForm today={today} pricing={await getPricingSettings()} />
  </KioskKeyboardProvider>;
}
