import PinLogin from "@/app/PinLogin";
import { getOperator } from "@/app/operator";
import { dateInSeoul } from "@/app/reservation-config";
import { getPricingSettings } from "@/db/pricing-settings";
import PosV2 from "./PosV2";

export const dynamic = "force-dynamic";

export default async function PosV2Page() {
  const operator = await getOperator();
  if (!operator) return <main className="pos-signin"><section><div className="pos-logo">JB</div><p>JUMPING BATTLE POS</p><h1>운영자 로그인</h1><span>운영 PIN을 입력하면 POS V2를 사용할 수 있습니다.</span><PinLogin /></section></main>;
  return <PosV2 operatorName={operator.displayName} initialDate={dateInSeoul()} pricing={await getPricingSettings()} />;
}
