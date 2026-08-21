import { supportsParkingCommands } from "@/db/bridge-capabilities";
import { ensureControlSchema, getControlAgentId, getD1, isAgentAuthorized } from "@/db/control";
import {
  ensureParkingDiscountSchema,
  maintainParkingDiscountRequests,
  markParkingRequestClaimed,
} from "@/db/parking-discounts";

type CommandRow = {
  id: string;
  room_id: string;
  action: string;
  payload_json: string;
  expires_at: string;
};

export async function POST(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }
  try {
    const body = await request.json() as { agentId?: string; version?: string };
    const agentId = String(body.agentId ?? "").trim().slice(0, 80);
    const version = String(body.version ?? "").trim().slice(0, 40);
    if (!agentId) return Response.json({ error: "agentId가 필요합니다." }, { status: 400 });
    if (agentId !== getControlAgentId()) {
      return Response.json({ error: "허용되지 않은 매장 제어 모듈입니다." }, { status: 403 });
    }
    if (!supportsParkingCommands(version)) {
      return Response.json({ error: "주차 자동등록을 지원하지 않는 브릿지입니다." }, { status: 409 });
    }

    await Promise.all([ensureControlSchema(), ensureParkingDiscountSchema()]);
    await maintainParkingDiscountRequests();
    const claimed = await getD1().prepare(`
      UPDATE commands SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT id FROM commands
        WHERE status = 'pending' AND expires_at > ?
          AND target_agent_id = ? AND action = 'parking_register'
        ORDER BY created_at ASC LIMIT 4
      )
      RETURNING id, room_id, action, payload_json, expires_at
    `).bind(new Date().toISOString(), agentId).all<CommandRow>();
    await markParkingRequestClaimed(claimed.results.map((command) => command.id));

    return Response.json({
      commands: claimed.results.map((command) => ({
        id: command.id,
        roomId: command.room_id,
        action: command.action,
        payload: JSON.parse(command.payload_json),
        expiresAt: command.expires_at,
      })),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "주차등록 명령 수신에 실패했습니다." },
      { status: 500 },
    );
  }
}
