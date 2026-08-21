export type BridgeState = "ONLINE" | "OFFLINE";
export type ManagerState = "AVAILABLE" | "UNAVAILABLE" | "STALE";
export type ControlState = "IDLE" | "BUSY" | "DEGRADED" | "ERROR";

export type ControlReadinessInput = {
  bridgeOnline: boolean;
  armed: boolean;
  controlState: string;
  controlLoopAlive: boolean;
  managerProbeFresh: boolean;
  managerState: string;
  managerModalActive: boolean;
  stateStale: boolean;
};

export type ControlReadiness = {
  ready: boolean;
  bridgeState: BridgeState;
  controlState: ControlState;
  managerState: ManagerState;
  reasonCode: string;
  reason: string;
};

export type RoomCommandReadiness = ControlReadiness & {
  roomControlState: string;
};

export function normalizeControlTimestamp(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function resolveRoomControlEventTimestamp(input: {
  state: string;
  updatedAt?: unknown;
  occurredAt?: unknown;
  lastSuccessAt?: unknown;
  nowIso: string;
}) {
  const explicitUpdatedAt = normalizeControlTimestamp(input.updatedAt);
  if (String(input.state).toUpperCase() === "READY" && !explicitUpdatedAt) return null;
  return explicitUpdatedAt
    ?? normalizeControlTimestamp(input.occurredAt)
    ?? normalizeControlTimestamp(input.lastSuccessAt)
    ?? normalizeControlTimestamp(input.nowIso);
}

export function normalizedControlState(value: unknown): ControlState {
  const state = String(value ?? "IDLE").toUpperCase();
  return state === "BUSY" || state === "DEGRADED" || state === "ERROR"
    ? state
    : "IDLE";
}

export function normalizedManagerState(
  value: unknown,
  fallback: { managerVisible: boolean; stateStale: boolean },
): ManagerState {
  const state = String(value ?? "").toUpperCase();
  if (state === "AVAILABLE" || state === "UNAVAILABLE" || state === "STALE") {
    return state;
  }
  if (!fallback.managerVisible) return "UNAVAILABLE";
  return fallback.stateStale ? "STALE" : "AVAILABLE";
}

export function evaluateControlReadiness(input: ControlReadinessInput): ControlReadiness {
  const bridgeState: BridgeState = input.bridgeOnline ? "ONLINE" : "OFFLINE";
  const controlState = normalizedControlState(input.controlState);
  const reportedManagerState = normalizedManagerState(input.managerState, {
    managerVisible: input.managerState === "AVAILABLE",
    stateStale: input.stateStale,
  });
  const managerState: ManagerState = input.managerProbeFresh ? reportedManagerState : "STALE";

  const blocked = (reasonCode: string, reason: string): ControlReadiness => ({
    ready: false,
    bridgeState,
    controlState,
    managerState,
    reasonCode,
    reason,
  });

  if (!input.bridgeOnline) return blocked("BRIDGE_OFFLINE", "매장 제어 모듈이 오프라인입니다.");
  if (!input.armed) return blocked("CONTROL_LOCKED", "매장 제어 모듈이 안전 잠금 상태입니다.");
  if (!input.controlLoopAlive) return blocked("CONTROL_LOOP_UNAVAILABLE", "원격제어 처리 상태를 확인해주세요.");
  if (managerState === "UNAVAILABLE") return blocked("MANAGER_UNAVAILABLE", "매장 PC에서 관리자 프로그램을 확인하지 못했습니다.");
  if (managerState === "STALE" || input.stateStale) return blocked("MANAGER_STALE", "관리자 프로그램의 최신 상태를 확인하고 있습니다.");
  if (input.managerModalActive) return blocked("MANAGER_MODAL_ACTIVE", "관리자 프로그램 확인창을 처리한 뒤 다시 시도해주세요.");
  if (controlState === "ERROR") return blocked("CONTROL_ERROR", "원격제어 공통 상태를 확인해주세요.");
  if (controlState === "BUSY") return blocked("CONTROL_BUSY", "다른 원격제어 명령을 처리하고 있습니다.");

  return {
    ready: true,
    bridgeState,
    controlState,
    managerState,
    reasonCode: controlState === "DEGRADED" ? "ROOM_CONTROL_DEGRADED" : "READY",
    reason: controlState === "DEGRADED"
      ? "일부 방의 이전 명령은 실패했지만 새 명령을 실행할 수 있습니다."
      : "원격제어 준비가 완료됐습니다.",
  };
}

export function evaluateRoomCommandReadiness(
  readiness: ControlReadiness,
  input: { roomControlState?: string; currentCommandId?: string; lastAction?: string; requestedAction?: string },
): RoomCommandReadiness {
  const roomControlState = String(input.roomControlState ?? "READY").toUpperCase();
  const result = (ready: boolean, reasonCode = readiness.reasonCode, reason = readiness.reason): RoomCommandReadiness => ({
    ...readiness,
    ready,
    reasonCode,
    reason,
    roomControlState,
  });
  if (!readiness.ready) return result(false);
  if (roomControlState === "CONTROL_PENDING" || input.currentCommandId) {
    return result(false, "ROOM_CONTROL_PENDING", "해당 방의 다른 명령이 처리 중입니다.");
  }
  if (roomControlState === "STALE") {
    return result(false, "ROOM_STATE_STALE", "해당 방의 최신 상태를 확인하고 있습니다.");
  }
  if (roomControlState === "SET_INFO_FAILED" && input.requestedAction !== "set_info") {
    return result(false, "ROOM_SET_INFO_REQUIRED", "게임 정보 입력을 다시 완료한 뒤 실행해주세요.");
  }
  if (roomControlState === "CONTROL_FAILED") {
    if (!input.lastAction || input.requestedAction !== input.lastAction) {
      return result(false, "ROOM_CONTROL_RETRY_REQUIRED", "실패한 명령 상태를 확인한 뒤 명시적으로 다시 시도해주세요.");
    }
  }
  return result(true);
}
