import { getOperator } from "@/app/operator";
import { dateInSeoul } from "@/app/reservation-config";
import { getMonthlyAnalytics } from "@/db/analytics";

function validMonth(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export async function GET(request: Request) {
  const operator = await getOperator();
  if (!operator) {
    return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const month =
    new URL(request.url).searchParams.get("month") ??
    dateInSeoul().slice(0, 7);
  if (!validMonth(month)) {
    return Response.json(
      { error: "조회할 월을 다시 선택해주세요." },
      { status: 400 },
    );
  }
  try {
    return Response.json(await getMonthlyAnalytics(month));
  } catch {
    return Response.json(
      { error: "매출 분석을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
