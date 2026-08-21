import {
  getCustomerMemberDashboard,
  registerCustomerMember,
} from "@/db/member-auth";

function authError(error: unknown) {
  const code = error instanceof Error ? error.message : "MEMBER_REGISTER_ERROR";
  console.error("customer member registration failed", { code });
  const messages: Record<string, string> = {
    MEMBER_NAME_REQUIRED: "이름을 입력해주세요.",
    MEMBER_PHONE_INVALID: "휴대폰 번호를 확인해주세요.",
    MEMBER_PASSWORD_INVALID: "비밀번호를 입력해주세요.",
    MEMBER_TERMS_REQUIRED: "필수 약관에 동의해주세요.",
    MEMBER_ACCOUNT_EXISTS: "이미 가입된 휴대폰 번호입니다. 로그인해주세요.",
  };
  const status = code === "MEMBER_ACCOUNT_EXISTS" ? 409 : 400;
  return Response.json({ error: messages[code] ?? "회원가입을 완료하지 못했습니다.", code }, { status });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const registered = await registerCustomerMember({
      name: String(body.name ?? ""),
      phone: String(body.phone ?? ""),
      password: String(body.password ?? ""),
      teamName: String(body.teamName ?? ""),
      agreed: body.agreed === true,
    });
    return Response.json({
      dashboard: await getCustomerMemberDashboard(registered.memberId),
      migrated: registered.migrated,
    }, {
      status: 201,
      headers: { "set-cookie": registered.cookie, "cache-control": "no-store" },
    });
  } catch (error) {
    return authError(error);
  }
}
