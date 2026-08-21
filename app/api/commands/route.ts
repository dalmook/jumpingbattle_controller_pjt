import { getOperator } from "@/app/operator";
import {
  ensureControlSchema,
  getControlAgentId,
  getControlCommandReadiness,
  getD1,
  isControlCommandBusyError,
} from "@/db/control";
import type { ControlAction, ControlPayload } from "@/app/types";
import { ControlPerformanceTrace } from "@/db/control-performance";

const ACTIONS = new Set<ControlAction>([
  "set_info",
  "start",
  "stop",
  "all_stop",
]);
const ROOM_IDS = new Set(["0", "1", "2", "3", "ALL"]);

function cleanPayload(value: unknown): ControlPayload | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const roomId = String(input.roomId ?? "");
  const action = String(input.action ?? "") as ControlAction;
  if (!ROOM_IDS.has(roomId) || !ACTIONS.has(action)) return null;
  if (action === "all_stop" && roomId !== "ALL") return null;
  if (action !== "all_stop" && roomId === "ALL") return null;

  const teamName = String(input.teamName ?? "").trim().slice(0, 10);
  const mapIndex = Math.max(
    0,
    Math.min(50, Math.trunc(Number(input.mapIndex) || 0)),
  );
  const people = Math.max(
    0,
    Math.min(10, Math.trunc(Number(input.people) || 0)),
  );
  const skipPeople = input.skipPeople === true;
  const durationMinutes = 16;

  return {
    roomId,
    action,
    teamName,
    mapIndex,
    people,
    skipPeople,
    durationMinutes,
  };
}

export async function POST(request: Request) {
  const id = crypto.randomUUID();
  const perf = new ControlPerformanceTrace("POST /api/commands", id);
  const authStarted = perf.start();
  const operator = await getOperator();
  perf.end("operator_auth", authStarted);
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const validationStarted = perf.start();
    const payload = cleanPayload(await request.json());
    perf.end("request_parse_validation", validationStarted);
    if (!payload) {
      return Response.json(
        { error: "올바르지 않은 제어 요청입니다." },
        { status: 400 },
      );
    }

    const schemaStarted = perf.start();
    await ensureControlSchema();
    perf.end("schema_ready", schemaStarted);
    const db = getD1();
    const agentLookupStarted = perf.start();
    const readiness = await getControlCommandReadiness(payload.roomId, payload.action);
    perf.end("agent_runtime_lookup", agentLookupStarted);

    if (!readiness.ready) {
      return Response.json(
        { error: readiness.reason, code: readiness.reasonCode },
        { status: readiness.reasonCode === "CONTROL_LOCKED" ? 423 : 409 },
      );
    }

    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    const insertStarted = perf.start();
    await db
      .prepare(
        `INSERT INTO commands
         (id, room_id, action, payload_json, status, requested_by, target_agent_id, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(
        id,
        payload.roomId,
        payload.action,
        JSON.stringify(payload),
        operator.email,
        getControlAgentId(),
        expiresAt,
      )
      .run();
    perf.end("command_queue_insert", insertStarted);
    perf.log({ command_id: id, action: payload.action, room_id: payload.roomId });
    return Response.json(
      { id, status: "pending" },
      { status: 201, headers: perf.headers() },
    );
  } catch (error) {
    if (isControlCommandBusyError(error)) {
      return Response.json(
        { error: "해당 게임존의 다른 명령이 이미 처리 중입니다.", code: "CONTROL_ROOM_BUSY" },
        { status: 409 },
      );
    }
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "명령 저장에 실패했습니다.",
      },
      { status: 500 },
    );
  }
}
