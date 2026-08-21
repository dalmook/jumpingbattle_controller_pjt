import { getOperator } from "@/app/operator";
import {
  deletePushDevice,
  listPushDevices,
  setPushDeviceEnabled,
} from "@/db/push-notifications";

export async function PATCH(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = (await request.json()) as { id?: unknown; enabled?: unknown };
    const id = String(body.id ?? "");
    if (!id) throw new Error("알림 기기를 선택해주세요.");
    return Response.json({
      devices: await setPushDeviceEnabled(id, body.enabled === true),
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "기기 설정을 변경하지 못했습니다." },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!id) throw new Error("알림 기기를 선택해주세요.");
    await deletePushDevice(id);
    return Response.json({ ok: true, devices: await listPushDevices() });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "기기를 삭제하지 못했습니다." },
      { status: 400 },
    );
  }
}

