import PinLogin from "@/app/PinLogin";
import { getOperator } from "@/app/operator";
import { dateInSeoul } from "@/app/reservation-config";
import AnalyticsDashboard from "./AnalyticsDashboard";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const operator = await getOperator();
  if (!operator) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <p className="eyebrow">JUMPING BATTLE · OFFICE</p>
          <h1>매출·인원 분석</h1>
          <p>운영자 PIN으로 로그인하면 매출 분석을 확인할 수 있습니다.</p>
          <PinLogin />
        </section>
      </main>
    );
  }
  return (
    <AnalyticsDashboard
      operatorName={operator.displayName}
      initialMonth={dateInSeoul().slice(0, 7)}
    />
  );
}
