import PinLogin from "@/app/PinLogin";
import { getOperator } from "@/app/operator";
import { dateInSeoul } from "@/app/reservation-config";
import { seoulGameDateTime } from "../game-history-utils";
import GameHistoryDashboard from "./GameHistoryDashboard";

export const dynamic = "force-dynamic";

export default async function GameHistoryPage() {
  const operator = await getOperator();
  if (!operator) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <p className="eyebrow">JUMPING BATTLE · GAME ARCHIVE</p>
          <h1>게임 기록</h1>
          <p>운영자 PIN으로 로그인하면 최종 점수와 게임 기록을 확인할 수 있습니다.</p>
          <PinLogin />
        </section>
      </main>
    );
  }
  const today = dateInSeoul();
  const initialFrom = seoulGameDateTime(
    new Date(`${today}T00:00:00+09:00`).getTime() - 29 * 24 * 60 * 60 * 1_000,
  ).date;
  return (
    <GameHistoryDashboard
      operatorName={operator.displayName}
      initialFrom={initialFrom}
      initialTo={today}
    />
  );
}
