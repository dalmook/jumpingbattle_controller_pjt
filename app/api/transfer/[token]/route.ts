import { getPublicKioskBankTransferSession } from "@/db/kiosk-payment-settings";

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const transfer = await getPublicKioskBankTransferSession(token);
  if (!transfer) {
    return Response.json({ error: "계좌이체 안내가 만료되었거나 올바르지 않습니다." }, { status: 404 });
  }
  return Response.json({
    amount: transfer.amount,
    bankName: transfer.bankName,
    accountNumber: transfer.accountNumber,
    accountHolder: transfer.accountHolder,
    guideText: transfer.guideText,
    depositorGuide: transfer.depositorGuide,
    expiresAt: transfer.expiresAt,
  }, { headers: { "cache-control": "private, no-store" } });
}
