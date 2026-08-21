import {
  clearMemberSessionCookie,
  destroyCustomerMemberSession,
} from "@/db/member-auth";

export async function POST(request: Request) {
  await destroyCustomerMemberSession(request.headers.get("cookie"));
  return Response.json({ ok: true }, {
    headers: { "set-cookie": clearMemberSessionCookie(), "cache-control": "no-store" },
  });
}
