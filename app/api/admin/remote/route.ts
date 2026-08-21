import { getOperator } from "@/app/operator";
import {
  confirmKioskManualPayment,
  markKioskPaymentForStaffReview,
  reinputKioskVisitInfo,
  startKioskGameFromDevice,
  stopKioskGameFromAdmin,
} from "@/db/customer-flow";
import { getRemoteOperationsOverview } from "@/db/remote-operations";
import { ROOM_OPTIONS } from "@/app/reservation-config";
import { assertControlCommandReady, getD1 } from "@/db/control";

async function assertVisitControlReady(visitId: string, action: "set_info" | "start" | "stop") {
  const visit = await getD1().prepare(`SELECT room_code FROM customer_visits WHERE id = ? LIMIT 1`)
    .bind(visitId).first<{ room_code: string }>();
  const roomId = ROOM_OPTIONS.find((room) => room.code === visit?.room_code)?.roomId ?? "";
  await assertControlCommandReady(roomId, action);
}

export async function GET() {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    return Response.json(await getRemoteOperationsOverview(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "무인 운영 상태를 불러오지 못했습니다.",
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    const visitId = String(body.visitId ?? "");
    const requestedBy = `remote:${operator.email}`;
    if (action === "confirm_payment") {
      await confirmKioskManualPayment(visitId, String(body.transactionId ?? ""), requestedBy);
      return Response.json({ ok: true, action, visitId });
    }
    if (action === "review_payment") {
      return Response.json({ ok: true, action, ...(await markKioskPaymentForStaffReview(visitId, requestedBy)) });
    }
    if (action === "manager_input") {
      await assertVisitControlReady(visitId, "set_info");
      const result = await reinputKioskVisitInfo(visitId, requestedBy);
      return Response.json({ ok: true, action, ...result }, { status: 202 });
    }
    if (action === "start_game") {
      await assertVisitControlReady(visitId, "start");
      const result = await startKioskGameFromDevice(visitId, requestedBy);
      return Response.json({ ok: true, action, ...result }, { status: 202 });
    }
    if (action === "stop_game") {
      await assertVisitControlReady(visitId, "stop");
      const result = await stopKioskGameFromAdmin(visitId, requestedBy);
      return Response.json({ ok: true, action, ...result }, { status: 202 });
    }
    return Response.json({ error: "지원하지 않는 운영 요청입니다." }, { status: 400 });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "운영 요청을 처리하지 못했습니다.",
    }, { status: 409 });
  }
}
