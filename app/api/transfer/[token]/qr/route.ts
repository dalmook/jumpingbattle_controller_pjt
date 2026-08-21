import QRCode from "qrcode";
import { getPublicKioskBankTransferSession } from "@/db/kiosk-payment-settings";

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const transfer = await getPublicKioskBankTransferSession(token);
  if (!transfer) return new Response("Not Found", { status: 404 });
  const target = new URL(transfer.url, request.url).toString();
  const svg = await QRCode.toString(target, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
    color: { dark: "#172033", light: "#ffffff" },
  });
  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
