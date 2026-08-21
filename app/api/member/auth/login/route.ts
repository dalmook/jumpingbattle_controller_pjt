import {
  getCustomerMemberDashboard,
  loginCustomerMember,
  memberClientIdentity,
} from "@/db/member-auth";

function loginError(error: unknown) {
  const code = error instanceof Error ? error.message : "MEMBER_LOGIN_ERROR";
  const messages: Record<string, string> = {
    MEMBER_LOGIN_INVALID: "휴대폰 번호 또는 비밀번호가 맞지 않습니다.",
    MEMBER_ACCOUNT_NEEDS_ACTIVATION: "기존 회원정보를 찾았어요. 회원가입에서 비밀번호를 설정하면 혜택이 그대로 연결됩니다.",
    MEMBER_AUTH_RATE_LIMITED: "로그인 시도가 많습니다. 15분 후 다시 시도해주세요.",
  };
  return Response.json({ error: messages[code] ?? "로그인하지 못했습니다." }, { status: code === "MEMBER_AUTH_RATE_LIMITED" ? 429 : 401 });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const loggedIn = await loginCustomerMember({
      phone: String(body.phone ?? ""),
      password: String(body.password ?? ""),
      clientIdentity: memberClientIdentity(request),
    });
    return Response.json({ dashboard: await getCustomerMemberDashboard(loggedIn.memberId) }, {
      headers: { "set-cookie": loggedIn.cookie, "cache-control": "no-store" },
    });
  } catch (error) {
    return loginError(error);
  }
}
