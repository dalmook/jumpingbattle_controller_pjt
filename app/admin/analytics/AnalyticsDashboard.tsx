"use client";

import { useEffect, useMemo, useState } from "react";
import type { AnalyticsResponse, SalesBucket } from "../analytics-types";

function won(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function dayLabel(date: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00+09:00`));
}

function average(value: number, divisor: number) {
  return divisor > 0 ? Math.round(value / divisor) : 0;
}

function SalesCell({ value }: { value: number }) {
  return <span className={value ? "" : "is-zero"}>{value ? `${won(value)}원` : "—"}</span>;
}

export default function AnalyticsDashboard({
  operatorName,
  initialMonth,
}: {
  operatorName: string;
  initialMonth: string;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/analytics?month=${encodeURIComponent(month)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as AnalyticsResponse & {
          error?: string;
        };
        if (!response.ok) throw new Error(result.error ?? "매출 분석을 불러오지 못했습니다.");
        setData(result);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "매출 분석을 불러오지 못했습니다.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [month]);

  const summary = data?.monthSummary;
  const days = useMemo(() => data?.days ?? [], [data]);
  const hours = useMemo(() => data?.hours ?? [], [data]);
  const maxDailyRevenue = useMemo(
    () => Math.max(1, ...days.map((day) => day.revenue)),
    [days],
  );
  const maxHourlyRevenue = useMemo(
    () => Math.max(1, ...hours.map((hour) => hour.revenue)),
    [hours],
  );
  const showUnclassifiedGamePayments = Boolean(summary?.gameUnclassified);

  return (
    <main className="admin-shell analytics-shell">
      <header className="topbar admin-topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <div>
            <p className="eyebrow">JUMPING BATTLE · SALES ANALYTICS</p>
            <h1>매출·인원 분석</h1>
          </div>
        </div>
        <nav className="admin-nav" aria-label="운영 메뉴">
          <a href="/admin">통합 운영 관리</a>
          <a href="/admin/game-history">게임 기록</a>
          <a href="/admin/settings">가격 설정</a>
          <a href="/admin/notifications">매출 알림</a>
          <a href="/reserve" target="_blank" rel="noreferrer">고객 예약 화면</a>
          <span>{operatorName}</span>
        </nav>
      </header>

      <section className="analytics-toolbar">
        <div>
          <label htmlFor="analytics-month">분석 월</label>
          <input
            id="analytics-month"
            type="month"
            value={month}
            onChange={(event) => {
              setLoading(true);
              setError("");
              setMonth(event.target.value);
            }}
          />
        </div>
        <div>
          <strong>{month.replace("-", "년 ")}월 매출 분석</strong>
          <span>일별·시간대별 매출과 이용 인원을 한 화면에서 비교합니다.</span>
        </div>
        <a href="/admin">← 관리자 화면</a>
      </section>

      {error ? <div className="alert error-alert">{error}</div> : null}
      {loading ? <div className="analytics-loading">매출 데이터를 계산하는 중…</div> : null}

      {summary ? (
        <>
          <section className="analytics-kpis" aria-label="월 매출 요약">
            <article className="analytics-kpi-primary">
              <span>월 실매출</span>
              <strong>{won(summary.revenue)}원</strong>
              <small>예상 {won(summary.expected)}원</small>
            </article>
            <article><span>게임비 매출</span><strong>{won(summary.gameRevenue)}원</strong><small>다회권·네이버 예약금 포함</small></article>
            <article><span>부가매출</span><strong>{won(summary.addOnRevenue)}원</strong><small>슬러시·음료·기타</small></article>
            <article><span>일평균 매출</span><strong>{won(average(summary.revenue, days.length))}원</strong><small>매출 발생 {days.length}일</small></article>
            <article><span>게임·인원</span><strong>{summary.games}건 · {summary.people}명</strong><small>게임당 {average(summary.people, summary.games)}명</small></article>
            <article><span>카드</span><strong>{won(summary.card)}원</strong><small>예약 + 부가매출</small></article>
            <article><span>현금</span><strong>{won(summary.cash)}원</strong><small>예약 + 부가매출</small></article>
            <article><span>계좌</span><strong>{won(summary.account)}원</strong><small>예약 + 부가매출</small></article>
            <article><span>예약금</span><strong>{won(summary.deposit)}원</strong><small>네이버 예약</small></article>
            <article><span>취소 수수료</span><strong>{won(summary.cancellationFee)}원</strong><small>네이버 당일 취소</small></article>
            <article><span>슬러시</span><strong>{won(summary.slush)}원</strong><small>공용 부가매출</small></article>
            <article><span>음료</span><strong>{won(summary.beverage)}원</strong><small>공용 부가매출</small></article>
            <article><span>기타 부가매출</span><strong>{won(summary.sharedOther)}원</strong><small>1개 1,000원</small></article>
            <article><span>다회권</span><strong>{won(summary.passes)}원</strong><small>청소년·성인 판매</small></article>
            {summary.other ? <article><span>기타 결제</span><strong>{won(summary.other)}원</strong><small>쿠폰·기존 복합</small></article> : null}
          </section>

          <section className="analytics-panel">
            <div className="analytics-panel-heading">
              <div><p className="eyebrow">DAILY SALES</p><h2>일매출·일인원</h2></div>
              <span>다회권은 게임비, 슬러시·음료·기타는 부가매출로 분류합니다.</span>
            </div>
            {days.length ? (
              <div className="analytics-table-scroll">
                <table className="analytics-table daily-sales-table">
                  <thead>
                    <tr>
                      <th rowSpan={2}>날짜</th>
                      <th rowSpan={2}>총 매출</th>
                      <th className="analytics-group-game" colSpan={showUnclassifiedGamePayments ? 6 : 5}>게임비</th>
                      <th className="analytics-group-addon" colSpan={4}>부가매출</th>
                      <th rowSpan={2}>게임</th>
                      <th rowSpan={2}>인원</th>
                    </tr>
                    <tr>
                      <th className="analytics-group-game">합계</th>
                      <th className="analytics-group-game">네이버 예약금<small>취소수수료 포함</small></th>
                      <th className="analytics-group-game">카드</th>
                      <th className="analytics-group-game">현금</th>
                      <th className="analytics-group-game">계좌</th>
                      {showUnclassifiedGamePayments ? <th className="analytics-group-game">미분류</th> : null}
                      <th className="analytics-group-addon">합계</th>
                      <th className="analytics-group-addon">카드</th>
                      <th className="analytics-group-addon">현금</th>
                      <th className="analytics-group-addon">계좌</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((day) => (
                      <tr key={day.key}>
                        <th><strong>{dayLabel(day.key)}</strong><small>{day.key}</small></th>
                        <td className="analytics-revenue-cell">
                          <strong>{won(day.revenue)}원</strong>
                          <i style={{ width: `${Math.max(2, (day.revenue / maxDailyRevenue) * 100)}%` }} />
                        </td>
                        <td className="analytics-game-cell analytics-group-total"><SalesCell value={day.gameRevenue} /></td>
                        <td className="analytics-game-cell"><SalesCell value={day.gameDeposit} /></td>
                        <td className="analytics-game-cell"><SalesCell value={day.gameCard} /></td>
                        <td className="analytics-game-cell"><SalesCell value={day.gameCash} /></td>
                        <td className="analytics-game-cell"><SalesCell value={day.gameAccount} /></td>
                        {showUnclassifiedGamePayments ? <td className="analytics-game-cell"><SalesCell value={day.gameUnclassified} /></td> : null}
                        <td className="analytics-addon-cell analytics-group-total"><SalesCell value={day.addOnRevenue} /></td>
                        <td className="analytics-addon-cell"><SalesCell value={day.addOnCard} /></td>
                        <td className="analytics-addon-cell"><SalesCell value={day.addOnCash} /></td>
                        <td className="analytics-addon-cell"><SalesCell value={day.addOnAccount} /></td>
                        <td>{day.games}건</td><td>{day.people}명</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="analytics-empty">선택한 월의 매출 기록이 없습니다.</div>}
          </section>

          <section className="analytics-panel">
            <div className="analytics-panel-heading">
              <div><p className="eyebrow">TIME SLOT</p><h2>시간대별 매출·인원</h2></div>
              <span>예약 결제 기준이며, 입력 시간이 없는 슬러시·음료·기타·다회권 매출은 제외합니다.</span>
            </div>
            {hours.length ? (
              <div className="analytics-hour-grid">
                {hours.map((hour: SalesBucket) => (
                  <article key={hour.key}>
                    <div><strong>{hour.key}</strong><span>{hour.games}건 · {hour.people}명</span></div>
                    <b>{won(hour.revenue)}원</b>
                    <div className="analytics-hour-bar"><i style={{ width: `${Math.max(2, (hour.revenue / maxHourlyRevenue) * 100)}%` }} /></div>
                    <small>카드 {won(hour.card)} · 현금 {won(hour.cash)} · 계좌 {won(hour.account)} · 예약금 {won(hour.deposit)} · 취소 수수료 {won(hour.cancellationFee)}</small>
                  </article>
                ))}
              </div>
            ) : <div className="analytics-empty">선택한 월의 시간대별 예약 매출이 없습니다.</div>}
          </section>
        </>
      ) : null}

      <footer>
        <span>일반 취소 예약은 제외되며, 네이버 당일 취소는 수수료 5,000원이 매출에 포함됩니다.</span>
        <form method="post" action="/api/pin-logout"><button type="submit">로그아웃</button></form>
      </footer>
    </main>
  );
}
