import PinLogin from "@/app/PinLogin";
import { getOperator } from "@/app/operator";
import { getPricingSettings } from "@/db/pricing-settings";
import { getBenefitSettings } from "@/db/member-benefits";
import PricingSettingsForm from "./PricingSettingsForm";
import { getParkingSettings } from "@/db/parking-settings";
import { getKioskPaymentSettings } from "@/db/kiosk-payment-settings";

export const dynamic = "force-dynamic";

export default async function PricingSettingsPage() {
  const operator = await getOperator();
  if (!operator) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <p className="eyebrow">JUMPING BATTLE · OFFICE</p>
          <h1>운영 가격 설정</h1>
          <p>운영자 PIN으로 로그인하면 가격을 수정할 수 있습니다.</p>
          <PinLogin />
        </section>
      </main>
    );
  }

  return (
    <PricingSettingsForm
      initialPricing={await getPricingSettings()}
      initialBenefits={await getBenefitSettings()}
      initialParking={await getParkingSettings()}
      initialKioskPayment={await getKioskPaymentSettings()}
      operatorName={operator.displayName}
    />
  );
}
