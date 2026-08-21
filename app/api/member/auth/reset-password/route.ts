import {
  getCustomerMemberDashboard,
  memberClientIdentity,
  resetCustomerMemberPassword,
} from "@/db/member-auth";

function resetError(error: unknown) {
  const code = error instanceof Error ? error.message : "MEMBER_RESET_ERROR";
  const messages: Record<string, string> = {
    MEMBER_NAME_REQUIRED: "가입할 때 입력한 이름을 입력해주세요.",
    MEMBER_PHONE_INVALID: "휴대폰 번호를 확인해주세요.",
    MEMBER_PASSWORD_INVALID: "새 비밀번호를 입력해주세요.",
    MEMBER_RESET_IDENTITY_INVALID: "일치하는 회원정보를 찾지 못했습니다. 이름과 휴대폰 번호를 확인해주세요.",
    MEMBER_AUTH_RATE_LIMITED: "확인 시도가 많습니다. 15분 뒤 다시 시도해주세요.",
  };
  return Response.json(
    { error: messages[code] ?? "비밀번호를 변경하지 못했습니다." },
    { status: code === "MEMBER_AUTH_RATE_LIMITED" ? 429 : 400 },
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const reset = await resetCustomerMemberPassword({
      name: String(body.name ?? ""),
      phone: String(body.phone ?? ""),
      password: String(body.password ?? ""),
      clientIdentity: memberClientIdentity(request),
    });
    return Response.json({ dashboard: await getCustomerMemberDashboard(reset.memberId) }, {
      headers: { "set-cookie": reset.cookie, "cache-control": "no-store" },
    });
  } catch (error) {
    return resetError(error);
  }
}
