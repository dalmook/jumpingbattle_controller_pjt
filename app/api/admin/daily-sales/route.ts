import { getOperator } from "@/app/operator";
import { dateInSeoul } from "@/app/reservation-config";
import {
  emptyDailySharedSales,
  getDailySharedSales,
  addDailySharedSales,
  replaceDailySharedSales,
} from "@/db/daily-sales";

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function safeCount(value: unknown) {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count)
    ? Math.max(0, Math.min(999, count))
    : 0;
}

export async function GET(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const date = new URL(request.url).searchParams.get("date") ?? dateInSeoul();
  if (!validDate(date)) {
    return Response.json({ error: "날짜 형식이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    return Response.json({ sales: await getDailySharedSales(date) });
  } catch {
    return Response.json(
      { error: "공용 매출을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const date = String(body.date ?? "");
    if (!validDate(date)) {
      return Response.json({ error: "운영 날짜를 확인해주세요." }, { status: 400 });
    }
    const input = emptyDailySharedSales(date);
    const slush = (body.slush ?? {}) as Record<string, unknown>;
    const beverage = (body.beverage ?? {}) as Record<string, unknown>;
    const other = (body.other ?? {}) as Record<string, unknown>;
    const youthPass10 = (body.youthPass10 ?? {}) as Record<string, unknown>;
    const youthPass20 = (body.youthPass20 ?? {}) as Record<string, unknown>;
    const adultPass10 = (body.adultPass10 ?? {}) as Record<string, unknown>;
    const adultPass20 = (body.adultPass20 ?? {}) as Record<string, unknown>;
    input.slush = {
      card: safeCount(slush.card),
      cash: safeCount(slush.cash),
      account: safeCount(slush.account),
    };
    input.beverage = {
      card: safeCount(beverage.card),
      cash: safeCount(beverage.cash),
      account: safeCount(beverage.account),
    };
    input.other = {
      card: safeCount(other.card),
      cash: safeCount(other.cash),
      account: safeCount(other.account),
    };
    input.youthPass10 = {
      card: safeCount(youthPass10.card),
      cash: safeCount(youthPass10.cash),
      account: safeCount(youthPass10.account),
    };
    input.youthPass20 = {
      card: safeCount(youthPass20.card),
      cash: safeCount(youthPass20.cash),
      account: safeCount(youthPass20.account),
    };
    input.adultPass10 = {
      card: safeCount(adultPass10.card),
      cash: safeCount(adultPass10.cash),
      account: safeCount(adultPass10.account),
    };
    input.adultPass20 = {
      card: safeCount(adultPass20.card),
      cash: safeCount(adultPass20.cash),
      account: safeCount(adultPass20.account),
    };
    const mode = String(body.mode ?? "add");
    if (mode !== "add" && mode !== "replace") {
      return Response.json({ error: "저장 방식을 확인해주세요." }, { status: 400 });
    }
    return Response.json({
      sales:
        mode === "replace"
          ? await replaceDailySharedSales(input, operator.email)
          : await addDailySharedSales(input, operator.email),
    });
  } catch {
    return Response.json(
      { error: "공용 매출을 저장하지 못했습니다." },
      { status: 500 },
    );
  }
}
