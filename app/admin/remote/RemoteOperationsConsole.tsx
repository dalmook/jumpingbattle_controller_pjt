"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Visit = {
  id: string;
  status: string;
  roomCode: string;
  teamName: string;
  customerName: string;
  difficultyLabel: string;
  partyCount: number;
  scheduledTime: string;
  updatedAt: string;
  error: { code: string; message: string } | null;
  pendingPayment: null | { transactionId: string; paymentMethod: string; amount: number };
};

type Room = {
  roomId: string; code: string; name: string; size: string; status: string;
  teamName: string; mapName: string; people: number; remainingSeconds: number;
  gameStartedAt: string; updatedAt: string;
  controlState: string; currentControlAction: string; currentCommandId: string;
  lastControlErrorCode: string; lastControlError: string; stateSeenAt: string; stateFresh: boolean;
  canSetInfo: boolean; canStart: boolean; canStop: boolean; controlReasonCode: string; controlReason: string;
};

type Command = {
  id: string; roomId: string; action: string; status: string; result: string;
  createdAt: string; completedAt: string;
};

type Overview = {
  generatedAt: string;
  bridge: {
    online: boolean; lastSeen: string; version: string; armed: boolean; managerVisible: boolean;
    controlState: string; currentAction: string; lastSuccessAt: string; lastError: string; stateStale: boolean;
  };
  control: {
    state: string; ready: boolean; currentAction: string; lastSuccessAt: string; lastError: string;
    loopAlive: boolean; loopLastSeen: string; reasonCode: string; reason: string;
  };
  manager: { state: string; visible: boolean; probeAt: string; probeSuccessCount: number; modalActive: boolean; stale: boolean };
  payment: { connected: boolean; paymentReady: boolean; responseMessage: string; updatedAt: string };
  kiosk: { online: boolean; currentStatus: string; lastSeen: string };
  rooms: Room[];
  visits: Visit[];
  recentCommands: Command[];
};

type PendingAction = { commandId: string; action: string; visitId: string; roomCode: string };

const ACTIVE_STATES = new Set([
  "PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION", "PREPARING", "READY_TO_PLAY",
  "PLAYING", "START_FAILED", "STAFF_REVIEW", "ERROR",
]);

const STATE_LABELS: Record<string, string> = {
  PAYMENT_PENDING: "결제 중",
  WAITING_STAFF_CONFIRMATION: "직원 결제확인",
  PREPARING: "게임 준비 중",
  READY_TO_PLAY: "시작 준비 완료",
  PLAYING: "게임 중",
  START_FAILED: "시작 확인 필요",
  STAFF_REVIEW: "직원 확인 필요",
  ERROR: "오류",
};

function money(value: number) {
  return `${Math.max(0, Number(value) || 0).toLocaleString("ko-KR")}원`;
}

function elapsedLabel(value: string) {
  if (!value) return "기록 없음";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(normalized)) / 1000));
  if (!Number.isFinite(seconds)) return value;
  if (seconds < 60) return `${seconds}초 전`;
  return `${Math.floor(seconds / 60)}분 전`;
}

function remaining(room: Room, generatedAt: string, now: number) {
  if (room.status !== "running") return "00:00";
  const current = now > 0 ? now : Date.parse(generatedAt);
  const base = Math.max(0, room.remainingSeconds - Math.floor((current - Date.parse(generatedAt)) / 1000));
  return `${String(Math.floor(base / 60)).padStart(2, "0")}:${String(base % 60).padStart(2, "0")}`;
}

function statusTone(ok: boolean, warning = false) {
  return ok ? "ok" : warning ? "warn" : "bad";
}

export default function RemoteOperationsConsole({ operatorName }: { operatorName: string }) {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => { pendingRef.current = pending; }, [pending]);

  const settlePending = useCallback((next: Overview) => {
    const current = pendingRef.current;
    if (!current) return;
    const command = next.recentCommands.find((item) => item.id === current.commandId);
    const room = next.rooms.find((item) => item.code === current.roomCode);
    const visit = next.visits.find((item) => item.id === current.visitId);
    if (command?.status === "failed") {
      setNotice(command.result || "명령 처리에 실패했습니다. 상태를 확인한 뒤 직접 다시 시도해주세요.");
      setPending(null);
      return;
    }
    if (current.action === "start_game" && room?.status === "running") {
      setNotice(`${current.roomCode} 게임이 실제로 시작됐습니다.`);
      setPending(null);
    } else if (current.action === "stop_game" && room && room.status !== "running") {
      setNotice(`${current.roomCode} 게임이 실제로 정지됐습니다.`);
      setPending(null);
    } else if (current.action === "manager_input" && visit?.status === "READY_TO_PLAY") {
      setNotice(`${current.roomCode} 관리자 프로그램 입력이 완료됐습니다.`);
      setPending(null);
    }
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/admin/remote", { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as Overview & { error?: string };
      if (!response.ok) throw new Error(payload.error || "상태를 불러오지 못했습니다.");
      setData(payload);
      settlePending(payload);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setNotice(error instanceof Error ? error.message : "연결 상태를 확인해주세요.");
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!silent) setLoading(false);
    }
  }, [settlePending]);

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    const poll = async () => {
      if (!active || document.hidden) return;
      await refresh(true);
      if (active && !document.hidden) timer = window.setTimeout(() => void poll(), 2_000);
    };
    const onVisibility = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.hidden) requestRef.current?.abort();
      else void poll();
    };
    timer = window.setTimeout(() => void poll(), 0);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      requestRef.current?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  useEffect(() => {
    const initial = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  const activeVisits = useMemo(() => (data?.visits || []).filter((visit) => ACTIVE_STATES.has(visit.status)), [data]);
  const alerts = useMemo(() => activeVisits.filter((visit) =>
    visit.status === "WAITING_STAFF_CONFIRMATION" || visit.status === "READY_TO_PLAY" ||
    visit.status === "START_FAILED" || visit.status === "STAFF_REVIEW" || visit.status === "ERROR" ||
    visit.error?.code === "STAFF_HELP_REQUESTED"), [activeVisits]);
  const stale = !data || (now > 0 && now - Date.parse(data.generatedAt) > 10_000);

  async function runAction(action: string, visit: Visit) {
    if (action === "stop_game" && !window.confirm(`${visit.roomCode} 게임을 정지할까요? 관리자 프로그램 확인창까지 처리한 뒤 실제 정지를 확인합니다.`)) return;
    if (action === "review_payment" && !window.confirm("결제 완료로 처리하지 않고 직원 확인 필요 상태로 보낼까요?")) return;
    const key = `${action}:${visit.id}`;
    setBusy(key);
    setNotice("");
    try {
      const response = await fetch("/api/admin/remote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, visitId: visit.id, transactionId: visit.pendingPayment?.transactionId || "" }),
      });
      const payload = await response.json() as { error?: string; commandId?: string };
      if (!response.ok) throw new Error(payload.error || "요청을 처리하지 못했습니다.");
      if (payload.commandId) {
        setPending({ commandId: payload.commandId, action, visitId: visit.id, roomCode: visit.roomCode });
        setNotice("명령을 전송했습니다. 실제 상태를 확인하고 있습니다.");
      } else {
        setNotice(action === "confirm_payment" ? "결제 확인을 반영했습니다." : "직원 확인 상태로 변경했습니다.");
      }
      await refresh(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "요청을 처리하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  function visitForRoom(room: Room) {
    const candidates = activeVisits.filter((visit) => visit.roomCode === room.code);
    return candidates.find((visit) => visit.status === "PLAYING") ||
      candidates.find((visit) => visit.status === "READY_TO_PLAY") || candidates[0];
  }

  function roomForVisit(visit: Visit) {
    return data?.rooms.find((room) => room.code === visit.roomCode);
  }

  return <main className="remote-console">
    <header className="remote-header">
      <div><p>JUMPING BATTLE · MOBILE</p><h1>무인운영 콘솔</h1><span>{operatorName}</span></div>
      <div className="remote-header-actions"><a href="/admin">PC 관리자</a><button onClick={() => void refresh()} disabled={loading}>{loading ? "확인 중" : "새로고침"}</button></div>
    </header>

    <section className="remote-health" aria-label="연결 상태">
      <article className={statusTone(Boolean(data?.bridge.online))}><span>브릿지</span><b>{data?.bridge.online ? "온라인" : "오프라인"}</b><small>{data?.bridge.version || "-"} · {elapsedLabel(data?.bridge.lastSeen || "")}</small></article>
      <article className={statusTone(Boolean(data?.control.ready), data?.control.state === "BUSY" || data?.control.state === "DEGRADED")}><span>게임 제어</span><b>{data?.control.state === "BUSY" ? "처리 중" : data?.control.state === "DEGRADED" ? "일부 확인 필요" : data?.control.ready ? "준비됨" : "확인 필요"}</b><small>{data?.control.currentAction || data?.control.lastError || data?.control.reason || "대기"}</small></article>
      <article className={statusTone(data?.manager.state === "AVAILABLE" && !data?.manager.modalActive, data?.manager.state === "STALE")}><span>관리자 프로그램</span><b>{data?.manager.modalActive ? "확인창 처리 필요" : data?.manager.state === "AVAILABLE" ? "사용 가능" : data?.manager.state === "STALE" ? "상태 확인 중" : "사용 불가"}</b><small>{data?.manager.probeAt ? `${elapsedLabel(data.manager.probeAt)} · 연속 ${data.manager.probeSuccessCount}회` : "확인 기록 없음"}</small></article>
      <article className={statusTone(Boolean(data?.payment.connected && data.payment.paymentReady))}><span>카드 단말</span><b>{data?.payment.connected && data.payment.paymentReady ? "준비됨" : "확인 필요"}</b><small>{data?.payment.responseMessage || "상태 없음"}</small></article>
      <article className={statusTone(Boolean(data?.kiosk.online))}><span>키오스크</span><b>{data?.kiosk.online ? "온라인" : "오프라인"}</b><small>{data?.kiosk.currentStatus || "-"} · {elapsedLabel(data?.kiosk.lastSeen || "")}</small></article>
    </section>

    {notice ? <div className="remote-notice" role="status">{notice}</div> : null}
    {stale ? <div className="remote-warning">최신 상태를 확인하지 못해 위험한 조작을 잠시 막았습니다.</div> : null}

    <section className="remote-tasks">
      <div className="remote-section-title"><div><p>ACTION REQUIRED</p><h2>지금 처리할 일</h2></div><b>{alerts.length}건</b></div>
      {alerts.length === 0 ? <div className="remote-empty">현재 바로 처리할 요청이 없습니다.</div> : alerts.map((visit) => <article className="remote-task" key={visit.id}>
        <div className="remote-task-head"><span>{visit.roomCode}</span><div><b>{visit.teamName || visit.customerName || "고객"}</b><small>{STATE_LABELS[visit.status] || visit.status} · {visit.scheduledTime || "현재"}</small></div></div>
        {visit.pendingPayment ? <div className="remote-payment-request"><span>{visit.pendingPayment.paymentMethod === "cash" ? "현금" : "계좌이체"}</span><b>{money(visit.pendingPayment.amount)}</b></div> : null}
        {visit.error?.message ? <p className="remote-task-error">{visit.error.message}</p> : null}
        <div className="remote-task-actions">
          {visit.status === "WAITING_STAFF_CONFIRMATION" && visit.pendingPayment ? <>
            <button className="primary" disabled={stale || Boolean(busy)} onClick={() => void runAction("confirm_payment", visit)}>결제 확인 완료</button>
            <button disabled={Boolean(busy)} onClick={() => void runAction("review_payment", visit)}>확인 보류</button>
          </> : null}
          {visit.status === "READY_TO_PLAY" ? <button className="primary" disabled={!roomForVisit(visit)?.canStart || stale || Boolean(busy)} onClick={() => void runAction("start_game", visit)}>게임 시작</button> : null}
          {["START_FAILED", "STAFF_REVIEW"].includes(visit.status) ? <button className="primary" disabled={!roomForVisit(visit)?.canSetInfo || stale || Boolean(busy)} onClick={() => void runAction("manager_input", visit)}>관리자에 다시 입력</button> : null}
        </div>
      </article>)}
    </section>

    <section className="remote-rooms">
      <div className="remote-section-title"><div><p>LIVE ROOMS</p><h2>방별 실시간 상태</h2></div><small>{data ? elapsedLabel(data.generatedAt) : "불러오는 중"}</small></div>
      <div className="remote-room-list">{(data?.rooms || []).map((room) => {
        const visit = visitForRoom(room);
        const running = room.status === "running";
        const roomError = ["SET_INFO_FAILED", "CONTROL_FAILED", "STALE"].includes(room.controlState);
        return <article className={`remote-room ${running ? "running" : roomError ? "error" : ""}`} key={room.roomId}>
          <div className="remote-room-top"><span>{room.size}</span><b>{room.code}</b><em>{running ? "게임 중" : room.status === "waiting" ? "대기" : "확인 필요"}</em></div>
          <div className="remote-room-time"><strong>{remaining(room, data?.generatedAt || "", now)}</strong><span>실제 남은시간</span></div>
          <dl><div><dt>팀명</dt><dd>{room.teamName || visit?.teamName || "-"}</dd></div><div><dt>난이도</dt><dd>{room.mapName || visit?.difficultyLabel || "-"}</dd></div><div><dt>인원</dt><dd>{room.people || visit?.partyCount || 0}명</dd></div></dl>
          {visit ? <div className="remote-visit-state"><span>{STATE_LABELS[visit.status] || visit.status}</span><small>{visit.scheduledTime || "현재"}</small></div> : null}
          {room.controlState === "SET_INFO_FAILED" ? <p className="remote-task-error">정보 입력 실패 · 다시 입력할 수 있습니다.</p> : null}
          {room.controlState === "STALE" ? <p className="remote-task-error">방 상태를 새로 확인하고 있습니다.</p> : null}
          <div className="remote-room-actions">
            {visit && ["PREPARING", "START_FAILED", "STAFF_REVIEW"].includes(visit.status) ? <button disabled={!room.canSetInfo || stale || Boolean(busy)} onClick={() => void runAction("manager_input", visit)}>정보 재입력</button> : null}
            {visit?.status === "READY_TO_PLAY" ? <button className="primary" disabled={!room.canStart || stale || Boolean(busy)} onClick={() => void runAction("start_game", visit)}>게임 시작</button> : null}
            {visit?.status === "PLAYING" && running ? <button className="danger" disabled={!room.canStop || stale || Boolean(busy)} onClick={() => void runAction("stop_game", visit)}>게임 정지</button> : null}
          </div>
        </article>;
      })}</div>
    </section>

    {pending ? <div className="remote-command-progress"><i /><div><b>실제 상태 확인 중</b><span>명령 성공 여부를 브릿지와 방 상태로 확인합니다.</span></div></div> : null}
  </main>;
}
