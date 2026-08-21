import { getOperator } from "@/app/operator";
import {
  getPushSchedules,
  getOperationalPushSettings,
  getWebPushPublicKey,
  listPushDevices,
  savePushSchedules,
  saveOperationalPushSettings,
  type PushScheduleInput,
} from "@/db/push-notifications";

export async function GET() {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const [schedules, devices, operationalSettings] = await Promise.all([
      getPushSchedules(),
      listPushDevices(),
      getOperationalPushSettings(),
    ]);
    return Response.json({
      schedules,
      devices,
      operationalSettings,
      publicKey: getWebPushPublicKey(),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "알림 설정을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = (await request.json()) as {
      schedules?: PushScheduleInput[];
      operationalSettings?: Array<{ eventType?: unknown; enabled?: unknown }>;
    };
    const [schedules, operationalSettings] = await Promise.all([
      savePushSchedules(body.schedules ?? [], operator.email),
      saveOperationalPushSettings(body.operationalSettings ?? [], operator.email),
    ]);
    return Response.json({ schedules, operationalSettings });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "알림 설정을 저장하지 못했습니다." },
      { status: 400 },
    );
  }
}
