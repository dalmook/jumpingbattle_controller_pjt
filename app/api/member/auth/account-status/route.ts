import { getCustomerMemberAccountState } from "@/db/member-auth";

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    return Response.json(await getCustomerMemberAccountState({
      phone: String(body.phone ?? ""),
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "MEMBER_ACCOUNT_CHECK_ERROR";
    const message = code === "MEMBER_PHONE_INVALID"
        ? "휴대폰 번호를 확인해주세요."
        : "회원정보를 확인하지 못했습니다.";
    return Response.json({ error: message }, { status: 400 });
  }
}
