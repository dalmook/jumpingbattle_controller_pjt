import PinLogin from "@/app/PinLogin";
import { getOperator } from "@/app/operator";
import RemoteOperationsConsole from "./RemoteOperationsConsole";
import "./remote.css";

export const dynamic = "force-dynamic";

export default async function RemoteOperationsPage() {
  const operator = await getOperator();
  if (!operator) {
    return <main className="signin-shell"><section className="signin-card">
      <div className="brand-mark">JB</div>
      <p className="eyebrow">MOBILE OPERATIONS</p>
      <h1>무인운영 콘솔</h1>
      <p>운영자 PIN으로 로그인해주세요.</p>
      <PinLogin />
    </section></main>;
  }
  return <RemoteOperationsConsole operatorName={operator.displayName} />;
}
