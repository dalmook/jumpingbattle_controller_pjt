import { dateInSeoul, getDifficulty } from "@/app/reservation-config";
import { isAgentAuthorized } from "@/db/control";
import { upsertImportedReservation } from "@/db/reservations";
import { getPricingSettings } from "@/db/pricing-settings";
import { classifyImportedSourceState } from "./source-state";

type ImportRow = [string, string, string, string, string, string, string, string, string, string, string];

function normalizeRows(payload: Record<string, unknown>): ImportRow[] {
  if (Array.isArray(payload.rows)) {
    return payload.rows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) => {
        const values = row.slice(0, 11).map((value) => String(value ?? ""));
        while (values.length < 11) values.push("");
        return values as ImportRow;
      });
  }
  if (!Array.isArray(payload.items)) return [];
  return payload.items
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => [
      "",
      String(item["예약자"] ?? item.name ?? ""),
      String(item["이용일시"] ?? item.when ?? ""),
      String(item["예약"] ?? item.product ?? ""),
      String(item["상태"] ?? item.status ?? ""),
      String(item["예약번호"] ?? item.bookNo ?? ""),
      String(item["전화번호"] ?? item.phone ?? ""),
      String(item["상세링크"] ?? item.link ?? ""),
      String(item["팀명"] ?? item.teamName ?? ""),
      String(item["난이도"] ?? item.difficulty ?? ""),
      String(item["인원"] ?? item.totalCount ?? item.people ?? ""),
    ]);
}

function parseSchedule(value: string) {
  const currentYear = Number(dateInSeoul().slice(0, 4));
  const dateMatch =
    value.match(/\b(\d{4})[-./년]\s*(\d{1,2})[-./월]\s*(\d{1,2})/) ??
    value.match(/\b(\d{2})\.\s*(\d{1,2})\.\s*(\d{1,2})\./);
  const rawYear = Number(dateMatch?.[1] || currentYear);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const month = Number(dateMatch?.[2] || 0);
  const day = Number(dateMatch?.[3] || 0);
  const timeMatch = value.match(/(?:(오전|오후|AM|PM)\s*)?(\d{1,2}):(\d{2})/i);
  let hour = Number(timeMatch?.[2] || 0);
  const minute = Number(timeMatch?.[3] || 0);
  const period = (timeMatch?.[1] || "").toUpperCase();
  if ((period === "오후" || period === "PM") && hour < 12) hour += 12;
  if ((period === "오전" || period === "AM") && hour === 12) hour = 0;
  const validDate = month >= 1 && month <= 12 && day >= 1 && day <= 31;
  const validTime = hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
  return {
    date: validDate
      ? `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : "",
    time: validTime ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : "",
  };
}

function parseRoom(...values: string[]) {
  const match = values.join(" ").toUpperCase().match(/\b(A1|B1|C1|C2)\b/);
  return match?.[1] ?? "";
}

function parsePeople(value: string) {
  if (/[~～-]/.test(value)) return 0;
  const match = value.match(/(\d{1,2})\s*(?:인|명)/);
  const count = Number(match?.[1] || 0);
  return count >= 1 && count <= 10 ? count : 0;
}

async function fallbackBookingNo(row: ImportRow) {
  const source = `${row[1]}|${row[2]}|${row[3]}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const value = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `legacy-${value.slice(0, 24)}`;
}

export async function POST(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "가져오기 권한이 없습니다." }, { status: 401 });
  }

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const rows = normalizeRows(payload);
    if (rows.length === 0 || rows.length > 500) {
      return Response.json({ error: "가져올 예약 데이터가 없습니다." }, { status: 400 });
    }

    let inserted = 0;
    let updated = 0;
    let failed = 0;
    const pricing = await getPricingSettings();
    for (const row of rows) {
      try {
        const schedule = parseSchedule(row[2]);
        const difficulty = getDifficulty(row[9]);
        const result = await upsertImportedReservation({
          sourceBookingNo: row[5].trim() || (await fallbackBookingNo(row)),
          customerName: row[1].trim().slice(0, 80),
          customerPhone: row[6].trim().slice(0, 30),
          scheduledDate: schedule.date,
          scheduledTime: schedule.time,
          roomCode: parseRoom(row[3], row[2]),
          teamName: row[8].trim().slice(0, 10),
          difficultyCode: difficulty?.code ?? "",
          difficultyLabel: difficulty?.label ?? row[9].trim().slice(0, 30),
          mapIndex: difficulty?.mapIndex ?? 0,
          totalCount: parsePeople(row[10]) || parsePeople(row[3]),
          sourceProduct: row[3].trim().slice(0, 200),
          sourceStatus: row[4].trim().slice(0, 80),
          sourceLink: row[7].trim().slice(0, 500),
          sourceState: classifyImportedSourceState(row[4]),
        }, pricing.adultPrice);
        if (result === "inserted") inserted += 1;
        else updated += 1;
      } catch {
        failed += 1;
      }
    }

    return Response.json({ success: failed === 0, inserted, updated, failed });
  } catch {
    return Response.json({ error: "예약 가져오기 중 문제가 발생했습니다." }, { status: 500 });
  }
}
