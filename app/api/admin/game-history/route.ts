import { getOperator } from "@/app/operator";
import { dateInSeoul, ROOM_OPTIONS } from "@/app/reservation-config";
import { seoulGameDateTime } from "@/app/admin/game-history-utils";
import { listGameHistory } from "@/db/game-history";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function csvCell(value: string | number) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sourceLabel(source: string) {
  if (source === "naver") return "네이버 예약";
  if (source === "web_walkin") return "고객 예약 화면";
  if (source === "manual") return "관리자 직접 입력";
  return source || "현장 게임";
}

function gameHistoryCsv(
  records: Awaited<ReturnType<typeof listGameHistory>>["records"],
) {
  const headers = [
    "게임 날짜", "종료 시간", "방", "팀명", "예약자", "예약 경로",
    "예약번호", "예약 일시", "맵", "난이도", "성인", "청소년",
    "총인원", "점수", "최종 레벨", "기본금액", "추가금액",
    "할인금액", "예약금", "카드", "현금", "계좌", "현장결제",
    "총결제금액", "결제상태", "실제 게임시간(초)",
  ];
  const lines = records.map((record) => [
    record.gameDate,
    record.gameTime,
    record.roomName || record.roomCode,
    record.teamName,
    record.customerName,
    sourceLabel(record.source),
    record.bookingCode,
    [record.scheduledDate, record.scheduledTime].filter(Boolean).join(" "),
    record.mapName,
    record.difficultyLabel,
    record.adultCount,
    record.youthCount,
    record.people,
    record.score,
    record.level,
    record.baseAmount,
    record.addOnAmount,
    record.discountAmount,
    record.depositAmount,
    record.paymentCardAmount,
    record.paymentCashAmount,
    record.paymentAccountAmount,
    record.paymentAmount,
    record.depositAmount + record.paymentAmount,
    record.paymentStatus === "paid" ? "결제완료" : "미결제",
    record.durationSeconds,
  ].map(csvCell).join(","));
  return `\uFEFF${[headers.map(csvCell).join(","), ...lines].join("\r\n")}`;
}

export async function GET(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const today = dateInSeoul();
    const defaultFrom = seoulGameDateTime(
      new Date(`${today}T00:00:00+09:00`).getTime() - 29 * 24 * 60 * 60 * 1_000,
    ).date;
    const fromValue = url.searchParams.get("from") ?? "";
    const toValue = url.searchParams.get("to") ?? "";
    const from = DATE_PATTERN.test(fromValue) ? fromValue : defaultFrom;
    const to = DATE_PATTERN.test(toValue) ? toValue : today;
    const roomValue = (url.searchParams.get("room") ?? "").toUpperCase();
    const roomCode = ROOM_OPTIONS.some((room) => room.code === roomValue)
      ? roomValue
      : "";
    const query = (url.searchParams.get("query") ?? "").trim().slice(0, 60);
    const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
    const limit = format === "csv"
      ? 5_000
      : Math.max(
          1,
          Math.min(500, Math.trunc(Number(url.searchParams.get("limit")) || 250)),
        );
    const result = await listGameHistory({ from, to, query, roomCode, limit });
    if (format === "csv") {
      return new Response(gameHistoryCsv(result.records), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="jumping-game-history-${from}-${to}.csv"`,
          "cache-control": "no-store",
        },
      });
    }
    return Response.json({ ...result, filters: { from, to, query, roomCode } });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "게임 기록을 불러오지 못했습니다.",
      },
      { status: 500 },
    );
  }
}
