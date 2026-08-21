import { waitKioskPayment } from "@/db/customer-flow";

export async function GET(request: Request) {
  const search = new URL(request.url).searchParams;
  const token = String(request.headers.get("x-customer-session") ?? "").trim();
  const attemptId = String(search.get("attemptId") ?? "");
  if (!token || !/^[0-9a-f-]{36}$/i.test(attemptId)) {
    return Response.json({ error: "결제 확인 요청이 올바르지 않습니다." }, { status: 400 });
  }
  try {
    return Response.json(await waitKioskPayment(token, attemptId), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "결제 결과를 확인하지 못했습니다." }, { status: 400 });
  }
}
