import { notificationForDevice } from "@/db/push-notifications";

export async function GET(request: Request) {
  const deviceId = new URL(request.url).searchParams.get("deviceId") ?? "";
  const token = request.headers.get("x-push-device-token") ?? "";
  if (!deviceId || !token) {
    return Response.json({ error: "알림 기기 인증이 필요합니다." }, { status: 401 });
  }
  try {
    const notification = await notificationForDevice(deviceId, token);
    if (!notification) {
      return Response.json({ error: "알림 기기 인증이 만료되었습니다." }, { status: 401 });
    }
    return Response.json(notification, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "알림 내용을 만들지 못했습니다." }, { status: 500 });
  }
}

