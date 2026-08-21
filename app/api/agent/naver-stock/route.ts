import { dateInSeoul } from "@/app/reservation-config";
import { isAgentAuthorized } from "@/db/control";
import {
  applyNaverStockActions,
  listNaverStockPlan,
  NAVER_BIZ_ITEM_BY_ROOM,
  naverSlotKey,
  type NaverRoomCode,
  type NaverStockAction,
} from "@/db/naver-stock";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_ACTIONS = 100;

function addDays(dateKey: string, days: number) {
  const date = new Date(`${dateKey}T00:00:00.000+09:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function validDateRange(startDate: string, endDate: string) {
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) return false;
  const start = Date.parse(`${startDate}T00:00:00.000+09:00`);
  const end = Date.parse(`${endDate}T23:59:59.999+09:00`);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 31 * 86_400_000;
}

function parseActions(payload: unknown): NaverStockAction[] | null {
  if (!payload || typeof payload !== "object") return null;
  const rawActions = (payload as { actions?: unknown }).actions;
  if (!Array.isArray(rawActions) || rawActions.length > MAX_ACTIONS) return null;
  const actions: NaverStockAction[] = [];

  for (const raw of rawActions) {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    if (value.action === "release") {
      const slotKey = String(value.slotKey || "");
      if (!/^(?:C1|C2|A1|B1)\|\d{4}-\d{2}-\d{2}\|\d{2}:\d{2}$/.test(slotKey)) return null;
      actions.push({ action: "release", slotKey });
      continue;
    }
    if (value.action !== "claim") return null;
    const roomCode = String(value.roomCode || "") as NaverRoomCode;
    const scheduledDate = String(value.scheduledDate || "");
    const scheduledTime = String(value.scheduledTime || "");
    const bizItemId = Number(value.bizItemId);
    const originalStock = Math.max(1, Math.min(20, Number(value.originalStock) || 1));
    if (
      !NAVER_BIZ_ITEM_BY_ROOM[roomCode] ||
      NAVER_BIZ_ITEM_BY_ROOM[roomCode] !== bizItemId ||
      !DATE_PATTERN.test(scheduledDate) ||
      !TIME_PATTERN.test(scheduledTime)
    ) return null;
    actions.push({
      action: "claim",
      slotKey: naverSlotKey(roomCode, scheduledDate, scheduledTime),
      roomCode,
      scheduledDate,
      scheduledTime,
      bizItemId,
      originalStock,
    });
  }
  return actions;
}

export async function GET(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const startDate = url.searchParams.get("start") || dateInSeoul();
  const endDate = url.searchParams.get("end") || addDays(startDate, 14);
  if (!validDateRange(startDate, endDate)) {
    return Response.json({ error: "Invalid date range" }, { status: 400 });
  }

  const plan = await listNaverStockPlan(startDate, endDate);
  return Response.json({
    success: true,
    startDate,
    endDate,
    generatedAt: new Date().toISOString(),
    ...plan,
  });
}

export async function POST(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const actions = parseActions(await request.json());
    if (!actions) {
      return Response.json({ error: "Invalid actions" }, { status: 400 });
    }
    await applyNaverStockActions(actions);
    return Response.json({ success: true, applied: actions.length });
  } catch {
    return Response.json({ error: "Failed to save Naver stock state" }, { status: 500 });
  }
}
