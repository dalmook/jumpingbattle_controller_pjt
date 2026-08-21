import { ensureControlSchema, getD1 } from "@/db/control";
import {
  createOperatorSessionCookie,
  fingerprintPinClient,
  isValidOperatorPin,
} from "@/app/pin-auth";

const FAILURE_WINDOW_SECONDS = 10 * 60;
const BLOCK_SECONDS = 15 * 60;
const MAX_FAILURES = 5;

type AttemptRow = {
  failures: number;
  window_started: number;
  blocked_until: number;
};

function clientAddress(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { pin?: unknown };
    const pin = typeof body.pin === "string" ? body.pin.slice(0, 16) : "";
    const clientKey = await fingerprintPinClient(clientAddress(request));
    if (!clientKey) {
      return Response.json(
        { error: "PIN 로그인 보안 설정이 준비되지 않았습니다." },
        { status: 503 },
      );
    }

    await ensureControlSchema();
    const db = getD1();
    const now = Math.floor(Date.now() / 1000);
    const attempt = await db
      .prepare(
        `SELECT failures, window_started, blocked_until
         FROM pin_attempts WHERE client_key = ?`,
      )
      .bind(clientKey)
      .first<AttemptRow>();

    if (attempt && attempt.blocked_until > now) {
      const waitMinutes = Math.max(1, Math.ceil((attempt.blocked_until - now) / 60));
      return Response.json(
        { error: `입력 횟수를 초과했습니다. ${waitMinutes}분 후 다시 시도해주세요.` },
        { status: 429 },
      );
    }

    if (/^\d{4}$/.test(pin) && (await isValidOperatorPin(pin))) {
      await db
        .prepare(`DELETE FROM pin_attempts WHERE client_key = ?`)
        .bind(clientKey)
        .run();
      return Response.json(
        { ok: true },
        { headers: { "set-cookie": await createOperatorSessionCookie() } },
      );
    }

    const withinWindow =
      attempt && now - attempt.window_started < FAILURE_WINDOW_SECONDS;
    const failures = withinWindow ? attempt.failures + 1 : 1;
    const windowStarted = withinWindow ? attempt.window_started : now;
    const blockedUntil = failures >= MAX_FAILURES ? now + BLOCK_SECONDS : 0;
    await db
      .prepare(
        `INSERT INTO pin_attempts
         (client_key, failures, window_started, blocked_until, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(client_key) DO UPDATE SET
           failures = excluded.failures,
           window_started = excluded.window_started,
           blocked_until = excluded.blocked_until,
           updated_at = excluded.updated_at`,
      )
      .bind(clientKey, failures, windowStarted, blockedUntil, now)
      .run();

    const remaining = Math.max(0, MAX_FAILURES - failures);
    return Response.json(
      {
        error:
          remaining > 0
            ? `PIN 번호가 맞지 않습니다. ${remaining}회 더 입력할 수 있습니다.`
            : "입력 횟수를 초과했습니다. 15분 후 다시 시도해주세요.",
      },
      { status: failures >= MAX_FAILURES ? 429 : 401 },
    );
  } catch {
    return Response.json(
      { error: "로그인 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요." },
      { status: 500 },
    );
  }
}
