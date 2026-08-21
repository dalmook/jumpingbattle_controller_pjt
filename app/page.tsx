import type { Metadata } from "next";
import Dashboard from "./Dashboard";
import PinLogin from "./PinLogin";
import { getOperator } from "./operator";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
};

export default async function Home() {
  const operator = await getOperator();

  if (!operator) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">
            JB
          </div>
          <p className="eyebrow">JUMPING BATTLE · REMOTE</p>
          <h1>점핑배틀 원격 운영실</h1>
          <p>
            게임 시작과 정지는 매장 장비에 직접 영향을 줍니다. 운영자 PIN을
            입력해주세요.
          </p>
          <PinLogin />
        </section>
      </main>
    );
  }

  return <Dashboard operatorName={operator.displayName} />;
}
