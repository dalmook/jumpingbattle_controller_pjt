import { getOperator } from "@/app/operator";
import { sendTestPush } from "@/db/push-notifications";

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as { deviceId?: unknown };
    return Response.json({
      ok: true,
      result: await sendTestPush(
        typeof body.deviceId === "string" && body.deviceId ? body.deviceId : undefined,
      ),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "시험 알림을 보내지 못했습니다." },
      { status: 400 },
    );
  }
}

