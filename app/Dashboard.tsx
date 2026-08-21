"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ControlAction,
  ControlPayload,
  Room,
  StatusResponse,
} from "./types";
import { GAME_DURATION_MINUTES } from "./reservation-config";

type RoomDraft = {
  teamName: string;
  mapIndex: number;
  people: number;
};

const DEFAULT_DRAFT: RoomDraft = {
  teamName: "",
  mapIndex: 0,
  people: 0,
};

const ACTION_LABELS: Record<string, string> = {
  set_info: "정보 입력",
  start: "게임 시작",
  stop: "게임 정지",
  all_stop: "전체 정지",
};

const COMMAND_STATUS_LABELS: Record<string, string> = {
  pending: "전송 대기",
  claimed: "처리 중",
  completed: "완료",
  failed: "실패",
};

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(
    safe % 60,
  ).padStart(2, "0")}`;
}

function statusLabel(status: Room["status"]) {
  return (
    {
      offline: "연결 없음",
      waiting: "대기",
      running: "게임 중",
      error: "확인 필요",
    } as const
  )[status];
}

function prettyDate(value: string | null) {
  if (!value) return "기록 없음";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export default function Dashboard({ operatorName }: { operatorName: string }) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RoomDraft>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [loadError, setLoadError] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error("상태를 불러오지 못했습니다.");
      const next = (await response.json()) as StatusResponse;
      setData(next);
      setLoadError("");
      setDrafts((current) => {
        const updated = { ...current };
        for (const room of next.rooms) {
          if (!updated[room.roomId]) {
            updated[room.roomId] = {
              ...DEFAULT_DRAFT,
              teamName: room.teamName,
              mapIndex: room.mapIndex,
              people: room.people,
            };
          }
        }
        return updated;
      });
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "상태 연결에 실패했습니다.",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const runningCount = useMemo(
    () => data?.rooms.filter((room) => room.status === "running").length ?? 0,
    [data],
  );
  const agentReady = Boolean(
    data?.store.agentOnline &&
      data.store.controlArmed &&
      data.store.managerVisible,
  );

  function updateDraft(roomId: string, patch: Partial<RoomDraft>) {
    setDrafts((current) => ({
      ...current,
      [roomId]: { ...(current[roomId] ?? DEFAULT_DRAFT), ...patch },
    }));
  }

  async function sendCommand(
    roomId: string,
    action: ControlAction,
    explicitPayload?: Partial<ControlPayload>,
  ) {
    if (!data?.store.agentOnline) {
      setNotice("매장 제어 모듈이 오프라인이라 명령을 보낼 수 없습니다.");
      return;
    }
    if (!data.store.managerVisible) {
      setNotice("매장 PC에서 점핑배틀 관리자 창을 찾지 못했습니다.");
      return;
    }
    if (!data.store.controlArmed) {
      setNotice("매장 제어 모듈이 안전 잠금 상태입니다.");
      return;
    }

    const room = data.rooms.find((item) => item.roomId === roomId);
    if (
      (action === "stop" || action === "all_stop") &&
      !window.confirm(
        action === "all_stop"
          ? "현재 진행 중인 모든 게임을 정지할까요?"
          : `${room?.name ?? roomId} 게임을 정지할까요?`,
      )
    ) {
      return;
    }

    const draft = drafts[roomId] ?? DEFAULT_DRAFT;
    const payload: ControlPayload = {
      roomId,
      action,
      teamName: draft.teamName.trim(),
      mapIndex: draft.mapIndex,
      people: draft.people,
      durationMinutes: GAME_DURATION_MINUTES,
      ...explicitPayload,
    };

    const key = `${roomId}:${action}`;
    setBusyKey(key);
    setNotice("");
    try {
      const response = await fetch("/api/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(result.error ?? "명령 전송에 실패했습니다.");
      }
      setNotice(
        `${room?.name ?? "전체"} · ${ACTION_LABELS[action]} 명령을 전송했습니다.`,
      );
      await refresh();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "명령 전송에 실패했습니다.",
      );
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            JB
          </div>
          <div>
            <p className="eyebrow">JUMPING BATTLE · REMOTE</p>
            <h1>화성병점점 운영실</h1>
          </div>
        </div>
        <div className="operator-area">
          <a className="topbar-link" href="/admin">
            예약·정산
          </a>
          <span
            className={`connection-pill ${
              data?.store.agentOnline ? "is-online" : "is-offline"
            }`}
          >
            <span className="status-dot" />
            {!data?.store.agentOnline
              ? "매장 오프라인"
              : !data.store.managerVisible
                ? "관리자 창 없음"
                : data.store.controlArmed
                  ? "매장 연결됨"
                  : "연결됨 · 안전 잠금"}
          </span>
          <span className="operator-name">{operatorName}</span>
        </div>
      </header>

      <section className="summary-grid" aria-label="운영 요약">
        <article className="summary-card summary-primary">
          <span>진행 중</span>
          <strong>{runningCount}</strong>
          <small>총 4개 게임존</small>
        </article>
        <article className="summary-card">
          <span>매장 PC</span>
          <strong>{data?.store.agentOnline ? "정상" : "대기"}</strong>
          <small>최근 연결 {prettyDate(data?.store.lastSeen ?? null)}</small>
        </article>
        <article className="summary-card">
          <span>보조 프로그램</span>
          <strong>{data?.store.agentVersion ?? "—"}</strong>
          <small>
            {data?.store.controlArmed
              ? "원격 제어 허용 상태"
              : "원격 제어 안전 잠금 상태"}
          </small>
        </article>
        <button
          className="summary-card emergency-card"
          type="button"
          disabled={!agentReady || busyKey !== null}
          onClick={() => void sendCommand("ALL", "all_stop")}
        >
          <span>비상 제어</span>
          <strong>전체 정지</strong>
          <small>확인 후 모든 게임을 정지합니다</small>
        </button>
      </section>

      {loadError ? <div className="alert error-alert">{loadError}</div> : null}
      {notice ? <div className="alert">{notice}</div> : null}

      <section className="section-heading">
        <div>
          <p className="eyebrow">LIVE CONTROL</p>
          <h2>게임존 제어</h2>
        </div>
        <button className="text-button" type="button" onClick={() => void refresh()}>
          지금 새로고침
        </button>
      </section>

      <section className="room-grid" aria-live="polite">
        {(data?.rooms ?? []).map((room) => {
          const draft = drafts[room.roomId] ?? DEFAULT_DRAFT;
          const isBusy = busyKey?.startsWith(`${room.roomId}:`) ?? false;
          return (
            <article className={`room-card status-${room.status}`} key={room.roomId}>
              <div className="room-header">
                <div>
                  <span className="room-size">{room.size}</span>
                  <h3>{room.name}</h3>
                </div>
                <span className="room-status">{statusLabel(room.status)}</span>
              </div>

              <div className="room-metrics">
                <div>
                  <span>남은 시간</span>
                  <strong>{formatTime(room.remainingSeconds)}</strong>
                </div>
                <div>
                  <span>점수</span>
                  <strong>{room.score}</strong>
                </div>
                <div>
                  <span>현재 레벨</span>
                  <strong className="level-text">{room.level || "—"}</strong>
                </div>
              </div>

              <div className="control-form">
                <label>
                  <span>팀명</span>
                  <input
                    maxLength={10}
                    disabled={room.status === "running"}
                    value={draft.teamName}
                    onChange={(event) =>
                      updateDraft(room.roomId, { teamName: event.target.value })
                    }
                    placeholder="팀명을 입력하세요"
                  />
                </label>
                <div className="split-fields">
                  <label>
                    <span>맵 번호</span>
                    <select
                      disabled={room.status === "running"}
                      value={draft.mapIndex}
                      onChange={(event) =>
                        updateDraft(room.roomId, {
                          mapIndex: Number(event.target.value),
                        })
                      }
                    >
                      <option value={0}>현재 선택 유지</option>
                      {(room.mapOptions.length > 0
                        ? room.mapOptions
                        : Array.from(
                            { length: 20 },
                            (_, index) => `맵 ${index + 1}`,
                          )
                      ).map((mapName, index) => (
                        <option key={`${index + 1}:${mapName}`} value={index + 1}>
                          {mapName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>인원 선택값</span>
                    <select
                      disabled={room.status === "running"}
                      value={draft.people}
                      onChange={(event) =>
                        updateDraft(room.roomId, {
                          people: Number(event.target.value),
                        })
                      }
                    >
                      {Array.from({ length: 10 }, (_, index) => (
                        <option key={index} value={index}>
                          {index === 0 ? "현재값 유지" : `${index}명`}
                        </option>
                      ))}
                      <option value={10}>기타</option>
                    </select>
                  </label>
                  <label>
                    <span>이용 시간</span>
                    <div className="fixed-duration">
                      <strong>{GAME_DURATION_MINUTES}분 고정</strong>
                      <small>설명 1분 + 게임 15분</small>
                    </div>
                  </label>
                </div>
              </div>

              <div className="room-actions">
                <button
                  className="secondary-action"
                  type="button"
                  disabled={!agentReady || isBusy || room.status === "running"}
                  onClick={() => void sendCommand(room.roomId, "set_info")}
                >
                  정보 입력
                </button>
                <button
                  className="start-action"
                  type="button"
                  disabled={
                    !agentReady ||
                    isBusy ||
                    room.status === "running"
                  }
                  onClick={() => void sendCommand(room.roomId, "start")}
                >
                  {busyKey === `${room.roomId}:start` ? "전송 중…" : "게임 시작"}
                </button>
                <button
                  className="stop-action"
                  type="button"
                  disabled={
                    !agentReady ||
                    isBusy ||
                    room.status !== "running"
                  }
                  onClick={() => void sendCommand(room.roomId, "stop")}
                >
                  정지
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="activity-panel">
        <div className="section-heading activity-heading">
          <div>
            <p className="eyebrow">CONTROL LOG</p>
            <h2>최근 원격 명령</h2>
          </div>
        </div>
        <div className="activity-list">
          {(data?.recentCommands ?? []).length === 0 ? (
            <p className="empty-state">아직 원격 명령 기록이 없습니다.</p>
          ) : (
            data?.recentCommands.map((command) => (
              <div className="activity-row" key={command.id}>
                <span className={`command-state state-${command.status}`} />
                <div>
                  <strong>
                    {command.roomId === "ALL"
                      ? "전체"
                      : data.rooms.find((room) => room.roomId === command.roomId)
                          ?.name ?? command.roomId}
                    {" · "}
                    {ACTION_LABELS[command.action] ?? command.action}
                  </strong>
                  <small>{command.result || "매장 응답 대기 중"}</small>
                </div>
                <span className="activity-status">
                  {COMMAND_STATUS_LABELS[command.status] ?? command.status}
                </span>
                <time>{prettyDate(command.createdAt)}</time>
              </div>
            ))
          )}
        </div>
      </section>

      <footer>
        <span>원본 점핑배틀 관리자 프로그램은 수정하지 않습니다.</span>
        <form method="post" action="/api/pin-logout">
          <button type="submit">로그아웃</button>
        </form>
      </footer>
    </main>
  );
}
