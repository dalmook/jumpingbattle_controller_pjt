import { getOperator } from "@/app/operator";
import { listPushDevices, registerPushSubscription } from "@/db/push-notifications";

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = (await request.json()) as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
      deviceName?: unknown;
    };
    const registration = await registerPushSubscription({
      endpoint: String(body.endpoint ?? ""),
      p256dh: String(body.keys?.p256dh ?? ""),
      auth: String(body.keys?.auth ?? ""),
      deviceName: String(body.deviceName ?? ""),
    });
    return Response.json({ ...registration, devices: await listPushDevices() });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "휴대폰을 등록하지 못했습니다." },
      { status: 400 },
    );
  }
}

