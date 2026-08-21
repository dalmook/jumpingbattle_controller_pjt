import { getControlAgentId, isAgentAuthorized } from "@/db/control";
import { getParkingSettings } from "@/db/parking-settings";

export async function POST(request: Request) {
  if (!isAgentAuthorized(request)) {
    return Response.json({ error: "제어 모듈 인증 실패" }, { status: 401 });
  }
  const body = await request.json() as { agentId?: string };
  if (String(body.agentId ?? "").trim() !== getControlAgentId()) {
    return Response.json({ error: "허용되지 않은 매장 제어 모듈입니다." }, { status: 403 });
  }
  const settings = await getParkingSettings();
  return Response.json({
    enabled: true,
    autoRegistrationEnabled: settings.autoRegistrationEnabled,
  });
}
