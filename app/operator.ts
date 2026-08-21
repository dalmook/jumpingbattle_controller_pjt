import { headers } from "next/headers";
import { hasOperatorSession, type Operator } from "./pin-auth";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function getOperator(): Promise<Operator | null> {
  const requestHeaders = await headers();
  const host = (requestHeaders.get("host") ?? "").split(":")[0];

  if (await hasOperatorSession()) {
    return {
      displayName: "PIN 운영자",
      email: "pin-operator@jumpingbattle.local",
    };
  }

  if (LOCAL_HOSTS.has(host)) {
    return {
      displayName: "로컬 테스트 운영자",
      email: "local-preview@jumpingbattle.invalid",
    };
  }

  return null;
}
