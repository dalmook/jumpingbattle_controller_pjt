import { getOperator } from "@/app/operator";
import { createMember, getMember, linkReservationMember, listMembers, updateMember } from "@/db/members";
import { getReservationById } from "@/db/reservations";

function memberError(error: unknown) {
  const message = error instanceof Error ? error.message : "회원 처리 중 문제가 발생했습니다.";
  if (message.includes("UNIQUE constraint")) return Response.json({ error: "이미 등록된 전화번호입니다." }, { status: 409 });
  if (message === "MEMBER_NAME_REQUIRED") return Response.json({ error: "회원 이름을 입력해주세요." }, { status: 400 });
  if (message === "MEMBER_PHONE_INVALID") return Response.json({ error: "전화번호를 확인해주세요." }, { status: 400 });
  if (message === "MEMBER_NOT_FOUND") return Response.json({ error: "회원을 찾지 못했습니다." }, { status: 404 });
  return Response.json({ error: message }, { status: 500 });
}

export async function GET(request: Request) {
  if (!(await getOperator())) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    if (id) {
      const member = await getMember(id);
      return member ? Response.json({ member }) : Response.json({ error: "회원을 찾지 못했습니다." }, { status: 404 });
    }
    return Response.json({ members: await listMembers(params.get("q") ?? "", Number(params.get("limit") ?? 200), Number(params.get("offset") ?? 0)) });
  } catch (error) { return memberError(error); }
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    return Response.json({ member: await createMember({
      name: String(body.name ?? ""), phone: String(body.phone ?? ""),
      birthday: String(body.birthday ?? ""), teamName: String(body.teamName ?? ""),
      email: String(body.email ?? ""), vehicleNumber: String(body.vehicleNumber ?? ""),
      memo: String(body.memo ?? ""),
    }, operator.email) }, { status: 201 });
  } catch (error) { return memberError(error); }
}

export async function PATCH(request: Request) {
  if (!(await getOperator())) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "update");
    if (action === "link" || action === "unlink") {
      const reservationId = String(body.reservationId ?? "");
      const linked = await linkReservationMember(reservationId, action === "unlink" ? null : String(body.memberId ?? ""));
      if (!linked) return Response.json({ error: "예약을 찾지 못했습니다." }, { status: 404 });
      return Response.json({ linked: action === "link", reservation: await getReservationById(reservationId) });
    }
    const member = await updateMember(String(body.id ?? ""), body);
    return member ? Response.json({ member }) : Response.json({ error: "회원을 찾지 못했습니다." }, { status: 404 });
  } catch (error) { return memberError(error); }
}
