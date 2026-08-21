import { ensureControlSchema, getD1 } from "@/db/control";
import { getOperator } from "@/app/operator";
import { maybeDispatchDueSalesBriefing } from "@/db/push-notifications";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { ControlPerformanceTrace } from "@/db/control-performance";

type RoomRow = {
  room_id: string;
  name: string;
  size: string;
  status: string;
  team_name: string;
  map_name: string;
  map_index: number;
  people: number;
  remaining_seconds: number;
  game_started_at: string | null;
  score: number;
  level: string;
  updated_at: string;
  map_options_json: string;
};

type AgentRow = {
  agent_id: string;
  version: string;
  last_seen: string;
  armed: number;
  simulate: number;
  manager_visible: number;
  bridge_instance_id: string;
  control_state: string;
  current_control_action: string;
  control_started_at: string | null;
  last_control_success_at: string | null;
  last_control_error: string;
  state_stale: number;
};

type CommandRow = {
  id: string;
  room_id: string;
  action: string;
  status: string;
  result: string;
  created_at: string;
};

function isOnline(lastSeen: string | null) {
  if (!lastSeen) return false;
  const normalized = lastSeen.includes("T")
    ? lastSeen
    : `${lastSeen.replace(" ", "T")}Z`;
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp < 25_000;
}

function parseMapOptions(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 50);
  } catch {
    return [];
  }
}

export async function GET() {
  const perf = new ControlPerformanceTrace("GET /api/status");
  const authStarted = perf.start();
  const operator = await getOperator();
  perf.end("operator_auth", authStarted);
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const schemaStarted = perf.start();
    await ensureControlSchema();
    perf.end("schema_ready", schemaStarted);
    const db = getD1();
    const queryStarted = perf.start();
    const [roomsResult, agent, commandsResult] = await Promise.all([
      db
        .prepare(`
          SELECT rooms.*, COALESCE(room_metadata.map_options_json, '[]') AS map_options_json
            , room_game_runtime.game_started_at AS game_started_at
          FROM rooms
          LEFT JOIN room_metadata ON room_metadata.room_id = rooms.room_id
          LEFT JOIN room_game_runtime ON room_game_runtime.room_id = rooms.room_id
          ORDER BY CAST(rooms.room_id AS INTEGER)
        `)
        .all<RoomRow>(),
      db
        .prepare(`
          SELECT agents.*,
            COALESCE(agent_runtime.armed, 0) AS armed,
            COALESCE(agent_runtime.simulate, 0) AS simulate,
            COALESCE(agent_runtime.manager_visible, 0) AS manager_visible,
            COALESCE(agent_runtime.bridge_instance_id, '') AS bridge_instance_id,
            COALESCE(agent_runtime.control_state, 'IDLE') AS control_state,
            COALESCE(agent_runtime.current_control_action, '') AS current_control_action,
            agent_runtime.control_started_at AS control_started_at,
            agent_runtime.last_control_success_at AS last_control_success_at,
            COALESCE(agent_runtime.last_control_error, '') AS last_control_error,
            COALESCE(agent_runtime.state_stale, 0) AS state_stale
          FROM agents
          LEFT JOIN agent_runtime ON agent_runtime.agent_id = agents.agent_id
          ORDER BY agents.last_seen DESC LIMIT 1
        `)
        .first<AgentRow>(),
      db
        .prepare(`SELECT id, room_id, action, status, result, created_at
                  FROM commands ORDER BY created_at DESC LIMIT 12`)
        .all<CommandRow>(),
    ]);
    perf.end("parallel_status_queries", queryStarted);

    getRequestExecutionContext()?.waitUntil(maybeDispatchDueSalesBriefing());

    return Response.json(
      {
        generatedAt: new Date().toISOString(),
        store: {
          name: "화성병점점",
          agentOnline: isOnline(agent?.last_seen ?? null),
          lastSeen: agent?.last_seen ?? null,
          agentVersion: agent?.version ?? null,
          controlArmed: agent?.armed === 1,
          managerVisible: agent?.manager_visible === 1,
          simulate: agent?.simulate === 1,
          controlState: agent?.control_state ?? "IDLE",
          currentControlAction: agent?.current_control_action ?? "",
          controlStartedAt: agent?.control_started_at ?? null,
          lastControlSuccessAt: agent?.last_control_success_at ?? null,
          lastControlError: agent?.last_control_error ?? "",
          stateStale: agent?.state_stale === 1,
        },
        rooms: roomsResult.results.map((room) => ({
          roomId: room.room_id,
          name: room.name,
          size: room.size,
          status: room.status,
          teamName: room.team_name,
          mapName: room.map_name,
          mapIndex: room.map_index,
          mapOptions: parseMapOptions(room.map_options_json),
          people: room.people,
          remainingSeconds: room.remaining_seconds,
          gameStartedAt: room.game_started_at ?? "",
          score: room.score,
          level: room.level,
          updatedAt: room.updated_at,
        })),
        recentCommands: commandsResult.results.map((command) => ({
          id: command.id,
          roomId: command.room_id,
          action: command.action,
          status: command.status,
          result: command.result,
          createdAt: command.created_at,
        })),
      },
      { headers: perf.headers() },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "매장 상태를 불러오지 못했습니다.",
      },
      { status: 500 },
    );
  }
}
