interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    JUMPING_AGENT_TOKEN?: string;
    JUMPING_OPERATOR_PIN?: string;
    JUMPING_SESSION_SECRET?: string;
    WEB_PUSH_VAPID_PUBLIC_KEY?: string;
    WEB_PUSH_VAPID_PRIVATE_JWK?: string;
    WEB_PUSH_VAPID_SUBJECT?: string;
    [key: string]: unknown;
  };
}
