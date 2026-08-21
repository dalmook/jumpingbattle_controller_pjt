import PinLogin from "@/app/PinLogin";
import { getOperator } from "@/app/operator";
import { dateInSeoul } from "@/app/reservation-config";
import { getPricingSettings } from "@/db/pricing-settings";
import ReservationsAdmin from "../ReservationsAdmin";

export const dynamic = "force-dynamic";

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export default async function AdminSchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const operator = await getOperator();
  if (!operator) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <p className="eyebrow">JUMPING BATTLE · OFFICE</p>
          <h1>전체 예약 현황</h1>
          <p>운영자 PIN으로 로그인하면 예약 현황을 크게 볼 수 있습니다.</p>
          <PinLogin />
        </section>
      </main>
    );
  }

  const today = dateInSeoul();
  const requestedDate = (await searchParams).date;
  return (
    <ReservationsAdmin
      operatorName={operator.displayName}
      initialDate={today}
      initialSelectedDate={validDate(requestedDate) ? requestedDate : today}
      pricing={await getPricingSettings()}
      scheduleOnly
    />
  );
}
