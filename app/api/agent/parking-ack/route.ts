import { getControlAgentId, isAgentAuthorized } from "@/db/control";
import {
  PARKING_REQUEST_STATUSES,
  completeParkingDiscountRequest,
  type ParkingRequestStatus,
} from "@/db/parking-discounts";

export async function POST(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    if (String(body.agentId ?? "").trim() !== getControlAgentId()) {
      return Response.json({ error: "허용되지 않은 매장 제어 모듈입니다." }, { status: 403 });
    }
    const commandId = String(body.commandId ?? "").trim();
    const commandStatus = String(body.commandStatus ?? "") as "completed" | "failed";
    const result = body.result && typeof body.result === "object"
      ? body.result as Record<string, unknown>
      : {};
    const status = String(result.status ?? (commandStatus === "completed" ? "SUCCESS" : "FAILED")) as ParkingRequestStatus;
    if (!commandId || !["completed", "failed"].includes(commandStatus) || !PARKING_REQUEST_STATUSES.includes(status)) {
      return Response.json({ error: "올바르지 않은 주차등록 완료 응답입니다." }, { status: 400 });
    }
    const completed = await completeParkingDiscountRequest({
      commandId,
      commandStatus,
      status,
      matchCount: Number(result.matchCount) || 0,
      results: Array.isArray(result.results) ? result.results : [],
      errorCode: String(result.errorCode ?? ""),
      errorMessage: String(result.errorMessage ?? ""),
      dryRun: result.dryRun === true,
    });
    return Response.json({ ok: true, request: completed });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "주차등록 완료 응답을 저장하지 못했습니다." },
      { status: 500 },
    );
  }
}
