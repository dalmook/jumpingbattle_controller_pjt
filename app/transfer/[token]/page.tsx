import { getPublicKioskBankTransferSession } from "@/db/kiosk-payment-settings";
import TransferGuide from "./TransferGuide";
import "../transfer.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "점핑배틀 계좌이체 안내",
  description: "점핑배틀 계좌이체 계좌번호와 결제금액 안내",
};

export default async function TransferPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const transfer = await getPublicKioskBankTransferSession(token);
  if (!transfer) {
    return <main className="transfer-shell"><section className="transfer-card expired"><span>!</span><h1>안내 시간이 만료됐어요</h1><p>키오스크에서 결제수단을 다시 선택하거나 직원에게 알려주세요.</p></section></main>;
  }
  return <TransferGuide transfer={transfer} />;
}
