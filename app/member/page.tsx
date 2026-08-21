import MemberPortal from "./MemberPortalV127";
import {
  getCustomerMemberDashboard,
  getCustomerMemberSession,
} from "@/db/member-auth";

export const dynamic = "force-dynamic";

export default async function MemberPage() {
  const session = await getCustomerMemberSession();
  const dashboard = session
    ? await getCustomerMemberDashboard(session.memberId)
    : null;
  return <MemberPortal initialDashboard={dashboard} />;
}
