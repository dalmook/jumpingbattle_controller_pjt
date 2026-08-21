import PinLogin from "@/app/PinLogin";
import { getOperator } from "@/app/operator";
import KioskOperations from "./KioskOperations";
import "./kiosk-admin.css";
import "./kiosk-management.css";
import "./kiosk-management-details.css";

export const dynamic = "force-dynamic";

export default async function KioskOperationsPage() {
  const operator = await getOperator();
  if (!operator) return <main className="signin-shell"><section className="signin-card"><div className="brand-mark">JB</div><p className="eyebrow">KIOSK OPERATIONS</p><h1>운영자 로그인</h1><PinLogin /></section></main>;
  return <KioskOperations operatorName={operator.displayName} />;
}
