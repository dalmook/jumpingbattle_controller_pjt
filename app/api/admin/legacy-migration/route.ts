import { getOperator } from "@/app/operator";
import {
  applyLegacyMembers,
  createLegacyMigrationBackup,
  getLegacyMigrationStats,
  previewLegacyMembers,
  refreshLegacyMemberProfiles,
  type LegacyMemberInput,
} from "@/db/member-benefits";

function migrationInput(value: unknown): LegacyMemberInput[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("LEGACY_MIGRATION_INPUT_INVALID");
  return value as LegacyMemberInput[];
}

export async function POST(request: Request) {
  const operator = await getOperator();
  if (!operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "preview");
    if (action === "backup") {
      return Response.json({ backup: await createLegacyMigrationBackup(operator.email) }, { status: 201 });
    }
    if (action === "verify") {
      return Response.json({ stats: await getLegacyMigrationStats() });
    }
    const members = migrationInput(body.members);
    if (action === "preview") return Response.json({ preview: await previewLegacyMembers(members) });
    if (action === "refresh_profiles") {
      const backupId = String(body.backupId ?? "");
      if (!backupId) throw new Error("LEGACY_MIGRATION_BACKUP_REQUIRED");
      return Response.json({ result: await refreshLegacyMemberProfiles(members, backupId) });
    }
    if (action === "apply") {
      const backupId = String(body.backupId ?? "");
      if (!backupId) throw new Error("LEGACY_MIGRATION_BACKUP_REQUIRED");
      return Response.json({ result: await applyLegacyMembers(members, backupId, operator.email) });
    }
    return Response.json({ error: "지원하지 않는 마이그레이션 요청입니다." }, { status: 400 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "LEGACY_MIGRATION_ERROR";
    const messages: Record<string, string> = {
      LEGACY_MIGRATION_INPUT_INVALID: "마이그레이션 데이터 형식을 확인해주세요.",
      LEGACY_MIGRATION_HAS_CONFLICTS: "중복 또는 오류 항목이 있어 가져오기를 중단했습니다.",
      LEGACY_MIGRATION_BACKUP_REQUIRED: "가져오기 전 백업이 필요합니다.",
    };
    return Response.json({ error: messages[code] ?? code }, { status: 409 });
  }
}
