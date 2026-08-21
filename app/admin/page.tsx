import PinLogin from "../PinLogin";
import { getOperator } from "../operator";
import { dateInSeoul } from "../reservation-config";
import ReservationsAdmin from "./ReservationsAdmin";
import { getPricingSettings } from "@/db/pricing-settings";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const operator = await getOperator();
  if (!operator) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <p className="eyebrow">JUMPING BATTLE · OFFICE</p>
          <h1>예약·정산 관리</h1>
          <p>예약 정보와 결제 내역을 보호하기 위해 운영자 PIN을 입력해주세요.</p>
          <PinLogin />
        </section>
      </main>
    );
  }
  return (
    <ReservationsAdmin
      operatorName={operator.displayName}
      initialDate={dateInSeoul()}
      pricing={await getPricingSettings()}
    />
  );
}
