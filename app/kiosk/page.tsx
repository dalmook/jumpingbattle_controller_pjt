import KioskApp from "./KioskApp";
import { KioskKeyboardProvider } from "./KioskKeyboard";
import "../touch-feedback.css";
import "./kiosk.css";
import "./benefits.css";
import "./kiosk-home.css";
import "./kiosk-keyboard.css";
import "./kiosk-27.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "점핑배틀 화성병점점 키오스크",
  description: "현장 예약·결제·게임 시작 키오스크",
  manifest: "/kiosk/manifest.webmanifest",
  appleWebApp: { capable: true, title: "점핑배틀 키오스크", statusBarStyle: "default" as const },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover" as const,
};

export default function KioskPage() {
  return <KioskKeyboardProvider><KioskApp /></KioskKeyboardProvider>;
}
