import {
  getCustomerMemberDashboard,
  getCustomerMemberSession,
  updateCustomerProfile,
} from "@/db/member-auth";

async function requireMember(request: Request) {
  return getCustomerMemberSession(request.headers.get("cookie"));
}

export async function GET(request: Request) {
  const member = await requireMember(request);
  if (!member) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  return Response.json({ dashboard: await getCustomerMemberDashboard(member.memberId) }, {
    headers: { "cache-control": "no-store" },
  });
}

export async function PATCH(request: Request) {
  const member = await requireMember(request);
  if (!member) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    if (!name) return Response.json({ error: "이름을 입력해주세요." }, { status: 400 });
    return Response.json({ dashboard: await updateCustomerProfile(member.memberId, {
      name,
      teamName: String(body.teamName ?? ""),
    }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "내 정보를 저장하지 못했습니다.";
    return Response.json({ error: message }, { status: 409 });
  }
}
