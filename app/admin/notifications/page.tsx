import PinLogin from "@/app/PinLogin";
import { getOperator } from "@/app/operator";
import NotificationSettings from "./NotificationSettings";

export const dynamic = "force-dynamic";

export default async function NotificationSettingsPage() {
  const operator = await getOperator();
  if (!operator) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <p className="eyebrow">JUMPING BATTLE · NOTIFICATIONS</p>
          <h1>매출 알림 설정</h1>
          <p>운영자 PIN으로 로그인하면 휴대폰 알림을 설정할 수 있습니다.</p>
          <PinLogin />
        </section>
      </main>
    );
  }
  return <NotificationSettings operatorName={operator.displayName} />;
}

