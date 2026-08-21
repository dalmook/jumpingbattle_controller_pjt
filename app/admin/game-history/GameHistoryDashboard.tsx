"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { ROOM_OPTIONS } from "@/app/reservation-config";
import { displayGameLevel } from "../game-history-utils";
import type { GameHistoryRecord } from "@/db/game-history";

type Filters = {
  from: string;
  to: string;
  query: string;
  roomCode: string;
};

type GameHistoryResponse = {
  records: GameHistoryRecord[];
  summary: {
    total: number;
    averageScore: number;
    highScore: number;
    totalPeople: number;
    totalPayment: number;
  };
  error?: string;
};

function won(value: number) {
  return new Intl.NumberFormat("ko-KR").format(Math.max(0, value));
}

function sourceLabel(source: string) {
  if (source === "naver") return "네이버 예약";
  if (source === "web_walkin") return "고객 예약 화면";
  if (source === "manual") return "관리자 직접 입력";
  return "현장 게임";
}

function durationLabel(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function koreanDate(date: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00+09:00`));
}

function queryString(filters: Filters, format = "") {
  const params = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    query: filters.query,
    room: filters.roomCode,
  });
  if (format) params.set("format", format);
  return params.toString();
}

export default function GameHistoryDashboard({
  operatorName,
  initialFrom,
  initialTo,
}: {
  operatorName: string;
  initialFrom: string;
  initialTo: string;
}) {
  const initialFilters = useMemo<Filters>(() => ({
    from: initialFrom,
    to: initialTo,
    query: "",
    roomCode: "",
  }), [initialFrom, initialTo]);
  const [draft, setDraft] = useState(initialFilters);
  const [filters, setFilters] = useState(initialFilters);
  const [data, setData] = useState<GameHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(`/api/admin/game-history?${queryString(filters)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as GameHistoryResponse;
        if (!response.ok) {
          throw new Error(result.error ?? "게임 기록을 불러오지 못했습니다.");
        }
        setData(result);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "게임 기록을 불러오지 못했습니다.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [filters, refreshKey]);

  const groupedRecords = useMemo(() => {
    const groups = new Map<string, GameHistoryRecord[]>();
    for (const record of data?.records ?? []) {
      const group = groups.get(record.gameDate) ?? [];
      group.push(record);
      groups.set(record.gameDate, group);
    }
    return [...groups.entries()];
  }, [data]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setFilters({ ...draft, query: draft.query.trim() });
  }

  function resetFilters() {
    setDraft(initialFilters);
    setFilters(initialFilters);
  }

  return (
    <main className="admin-shell game-history-shell">
      <header className="topbar admin-topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <div>
            <p className="eyebrow">JUMPING BATTLE · GAME ARCHIVE</p>
            <h1>게임 기록</h1>
          </div>
        </div>
        <nav className="admin-nav" aria-label="운영 메뉴">
          <a href="/admin">통합 운영 관리</a>
          <a href="/admin/analytics">매출 분석</a>
          <a href="/admin/notifications">매출 알림</a>
          <a href="/admin/settings">가격 설정</a>
          <a href="/reserve" target="_blank" rel="noreferrer">고객 예약 화면</a>
          <span>{operatorName}</span>
        </nav>
      </header>

      <section className="game-history-hero">
        <div>
          <p className="eyebrow">FINAL SCORE TIMELINE</p>
          <h2>정지 버튼을 누른 순간을<br />한 경기씩 기록합니다.</h2>
          <p>최종 점수·레벨과 팀, 예약자, 맵, 인원, 결제 내역을 시간순으로 확인하세요.</p>
        </div>
        <div className="game-history-hero-score" aria-label="검색 결과 최고 점수">
          <span>검색 결과 최고 점수</span>
          <strong>{won(data?.summary.highScore ?? 0)}</strong>
          <small>FINAL SCORE</small>
        </div>
      </section>

      <form className="game-history-toolbar" onSubmit={submit}>
        <label className="game-history-search">
          <span>통합 검색</span>
          <input
            type="search"
            value={draft.query}
            onChange={(event) => setDraft((current) => ({ ...current, query: event.target.value }))}
            placeholder="팀명, 예약자, 맵, 예약번호, 점수 검색"
          />
        </label>
        <label>
          <span>시작일</span>
          <input type="date" value={draft.from} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} />
        </label>
        <label>
          <span>종료일</span>
          <input type="date" value={draft.to} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} />
        </label>
        <label>
          <span>방</span>
          <select value={draft.roomCode} onChange={(event) => setDraft((current) => ({ ...current, roomCode: event.target.value }))}>
            <option value="">전체 방</option>
            {ROOM_OPTIONS.map((room) => <option value={room.code} key={room.code}>{room.name}</option>)}
          </select>
        </label>
        <div className="game-history-toolbar-actions">
          <button type="submit" className="game-history-search-button">검색</button>
          <button type="button" onClick={resetFilters}>초기화</button>
          <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>새로고침</button>
          <a className="game-history-export" href={`/api/admin/game-history?${queryString(filters, "csv")}`}>
            엑셀 다운로드
          </a>
        </div>
      </form>

      {error ? <div className="alert error-alert">{error}</div> : null}

      <section className="game-history-kpis" aria-label="게임 기록 요약">
        <article><span>게임 수</span><strong>{won(data?.summary.total ?? 0)}건</strong><small>현재 검색 조건</small></article>
        <article><span>총 이용 인원</span><strong>{won(data?.summary.totalPeople ?? 0)}명</strong><small>성인·청소년 합계</small></article>
        <article><span>평균 점수</span><strong>{won(data?.summary.averageScore ?? 0)}</strong><small>게임당 평균</small></article>
        <article><span>최고 점수</span><strong>{won(data?.summary.highScore ?? 0)}</strong><small>검색 기간 최고 기록</small></article>
        <article className="game-history-payment-kpi"><span>총 결제금액</span><strong>{won(data?.summary.totalPayment ?? 0)}원</strong><small>예약금 + 현장결제</small></article>
      </section>

      {loading ? <div className="game-history-loading">게임 기록을 정리하는 중…</div> : null}
      {!loading && groupedRecords.length === 0 ? (
        <section className="game-history-empty">
          <strong>아직 조건에 맞는 게임 기록이 없습니다.</strong>
          <span>이 기능 배포 후 게임을 정지하면 최종 점수와 레벨이 자동으로 쌓입니다.</span>
        </section>
      ) : null}

      <section className="game-history-timeline" aria-live="polite">
        {groupedRecords.map(([date, records]) => (
          <div className="game-history-day" key={date}>
            <div className="game-history-date">
              <strong>{koreanDate(date)}</strong>
              <span>{records.length}게임</span>
            </div>
            <div className="game-history-day-records">
              {records.map((record) => {
                const totalPaid = record.depositAmount + record.paymentAmount;
                return (
                  <article className="game-history-card" key={record.id}>
                    <div className="game-history-time">
                      <strong>{record.gameTime}</strong>
                      <span>종료</span>
                    </div>
                    <i className="game-history-dot" aria-hidden="true" />
                    <div className="game-history-card-body">
                      <header>
                        <div>
                          <span className={`game-history-source source-${record.source}`}>{sourceLabel(record.source)}</span>
                          <h3>{record.teamName}</h3>
                          <p>{record.roomName || record.roomCode} · {record.mapName || record.difficultyLabel || "맵 정보 없음"}</p>
                        </div>
                        <div className="game-history-result">
                          <span><small>FINAL SCORE</small><strong>{won(record.score)}</strong></span>
                          <span><small>FINAL LEVEL</small><strong>{displayGameLevel(record.level)}</strong></span>
                        </div>
                      </header>
                      <div className="game-history-info-grid">
                        <span><small>예약자</small><b>{record.customerName || "현장 입력"}</b></span>
                        <span><small>이용 인원</small><b>성인 {record.adultCount} · 청소년 {record.youthCount} · 총 {record.people}명</b></span>
                        <span><small>예약 시간</small><b>{record.scheduledDate ? `${record.scheduledDate} ${record.scheduledTime}` : "현장 게임"}</b></span>
                        <span><small>게임 시간</small><b>{durationLabel(record.durationSeconds)}</b></span>
                        <span><small>예약번호</small><b>{record.bookingCode || "—"}</b></span>
                        <span><small>결제 상태</small><b className={record.paymentStatus === "paid" ? "is-paid" : "is-unpaid"}>{record.paymentStatus === "paid" ? "결제완료" : "미결제"}</b></span>
                      </div>
                      <div className="game-history-payment-row">
                        <span><small>기본금액</small><b>{won(record.baseAmount)}원</b></span>
                        <span><small>할인</small><b>{won(record.discountAmount)}원</b></span>
                        <span><small>예약금</small><b>{won(record.depositAmount)}원</b></span>
                        <span><small>카드</small><b>{won(record.paymentCardAmount)}원</b></span>
                        <span><small>현금</small><b>{won(record.paymentCashAmount)}원</b></span>
                        <span><small>계좌</small><b>{won(record.paymentAccountAmount)}원</b></span>
                        <span className="game-history-payment-total"><small>총 결제금액</small><b>{won(totalPaid)}원</b></span>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <footer>
        <span>게임 종료 직후 브릿지가 보내는 최종 점수·레벨을 저장합니다.</span>
        <form method="post" action="/api/pin-logout"><button type="submit">로그아웃</button></form>
      </footer>
    </main>
  );
}
