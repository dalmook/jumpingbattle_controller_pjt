import { getOperator } from "@/app/operator";
import { sanitizePricingSettings } from "@/app/pricing-config";
import {
  getPricingSettings,
  updatePricingSettings,
} from "@/db/pricing-settings";
import { getBenefitSettings, updateBenefitSettings } from "@/db/member-benefits";
import { sanitizeParkingSettings } from "@/app/parking-config";
import { getParkingSettings, updateParkingSettings } from "@/db/parking-settings";
import { sanitizeKioskPaymentSettings } from "@/app/kiosk/payment-settings";
import { getKioskPaymentSettings, updateKioskPaymentSettings } from "@/db/kiosk-payment-settings";

export async function GET() {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  return Response.json(
    {
      pricing: await getPricingSettings(),
      benefits: await getBenefitSettings(),
      parking: await getParkingSettings(),
      kioskPayment: await getKioskPaymentSettings(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  try {
    const body = await request.json() as Record<string, unknown>;
    const pricing = sanitizePricingSettings(body.pricing ?? body);
    if (!pricing) {
      return Response.json(
        { error: "모든 금액을 0원 이상 1,000만원 이하의 숫자로 입력해 주세요." },
        { status: 400 },
      );
    }
    const benefitInput = body.benefits && typeof body.benefits === "object"
      ? body.benefits as Record<string, unknown>
      : null;
    const benefits = benefitInput
      ? await updateBenefitSettings({
          stampGoal: Number(benefitInput.stampGoal),
          stampEarnPerGame: Number(benefitInput.stampEarnPerGame),
          passValidityMonths: Number(benefitInput.passValidityMonths),
        }, operator.email)
      : await getBenefitSettings();
    const parkingInput = body.parking && typeof body.parking === "object"
      ? sanitizeParkingSettings(body.parking)
      : null;
    if (body.parking && !parkingInput) {
      return Response.json({ error: "주차등록 주소 또는 이용시간을 확인해주세요." }, { status: 400 });
    }
    const parking = parkingInput
      ? await updateParkingSettings(parkingInput, operator.email)
      : await getParkingSettings();
    const kioskPaymentInput = body.kioskPayment && typeof body.kioskPayment === "object"
      ? sanitizeKioskPaymentSettings(body.kioskPayment)
      : null;
    if (body.kioskPayment && !kioskPaymentInput) {
      return Response.json({ error: "키오스크 결제수단과 계좌이체 정보를 확인해주세요. 활성 결제수단은 최소 1개가 필요합니다." }, { status: 400 });
    }
    const kioskPayment = kioskPaymentInput
      ? await updateKioskPaymentSettings(kioskPaymentInput, operator.email)
      : await getKioskPaymentSettings();
    return Response.json({
      pricing: await updatePricingSettings(pricing, operator.email),
      benefits,
      parking,
      kioskPayment,
    });
  } catch {
    return Response.json({ error: "가격 설정을 저장하지 못했습니다." }, { status: 500 });
  }
}
