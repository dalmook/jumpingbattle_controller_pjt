import {
  ensureControlSchema,
  getControlAgentId,
  getD1,
  isAgentAuthorized,
} from "@/db/control";
import { supportsControlFastLane } from "@/db/bridge-capabilities";
import { ControlPerformanceTrace } from "@/db/control-performance";

type ControlCommandBody = {
  agentId?: string;
  version?: string;
};

type CommandRow = {
  id: string;
  room_id: string;
  action: string;
  payload_json: string;
  expires_at: string;
};

const CONTROL_ACTIONS = ["set_info", "start", "stop", "all_stop"] as const;

export async function POST(request: Request) {
  const perf = new ControlPerformanceTrace("POST /api/agent/control-commands");
  const authStarted = perf.start();
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }
  perf.end("agent_auth", authStarted);

  try {
    const parseStarted = perf.start();
    const body = (await request.json()) as ControlCommandBody;
    perf.end("request_parse", parseStarted);
    const agentId = String(body.agentId ?? "").trim().slice(0, 80);
    const version = String(body.version ?? "").trim().slice(0, 40);
    if (!agentId) {
      return Response.json({ error: "agentId가 필요합니다." }, { status: 400 });
    }
    if (agentId !== getControlAgentId()) {
      return Response.json({ error: "허용되지 않은 매장 제어 모듈입니다." }, { status: 403 });
    }
    if (!supportsControlFastLane(version)) {
      return Response.json(
        { error: "Control Fast Lane을 지원하지 않는 브릿지 버전입니다." },
        { status: 409 },
      );
    }

    const schemaStarted = perf.start();
    await ensureControlSchema();
    perf.end("schema_ready", schemaStarted);
    const now = new Date().toISOString();
    const claimStarted = perf.start();
    const claimed = await getD1()
      .prepare(
        `UPDATE commands SET status = 'claimed', claimed_at = CURRENT_TIMESTAMP
         WHERE id IN (
           SELECT id FROM commands
           WHERE status = 'pending' AND expires_at > ?
             AND target_agent_id = ?
             AND action IN ('set_info', 'start', 'stop', 'all_stop')
             AND NOT EXISTS (
               SELECT 1 FROM commands active_control
               WHERE active_control.status = 'claimed'
                 AND active_control.action IN ('set_info', 'start', 'stop', 'all_stop')
             )
           ORDER BY created_at ASC LIMIT 1
         )
         RETURNING id, room_id, action, payload_json, expires_at`,
      )
      .bind(now, agentId)
      .all<CommandRow>();
    perf.end("command_claim", claimStarted);
    perf.log({
      actions: CONTROL_ACTIONS,
      claimed_commands: claimed.results.map((command) => ({
        trace_id: `CTRL-${command.id}`,
        action: command.action,
        room_id: command.room_id,
      })),
    });

    return Response.json(
      {
        commands: claimed.results.map((command) => ({
          id: command.id,
          roomId: command.room_id,
          action: command.action,
          payload: JSON.parse(command.payload_json),
          expiresAt: command.expires_at,
        })),
      },
      { headers: perf.headers() },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "제어 명령 수신에 실패했습니다." },
      { status: 500 },
    );
  }
}
