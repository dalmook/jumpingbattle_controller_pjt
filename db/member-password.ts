export const MEMBER_PASSWORD_ITERATIONS = 210_000;
export const PBKDF2_RUNTIME_MAX_ITERATIONS = 100_000;
export const CHUNKED_PASSWORD_SALT_PREFIX = "v2$";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createMemberPasswordSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${CHUNKED_PASSWORD_SALT_PREFIX}${bytesToHex(bytes)}`;
}

export async function deriveMemberPasswordHash(
  password: string,
  salt: string,
  iterations = MEMBER_PASSWORD_ITERATIONS,
) {
  if (!Number.isSafeInteger(iterations) || iterations <= 0) {
    throw new Error("MEMBER_PASSWORD_ITERATIONS_INVALID");
  }

  const chunked = salt.startsWith(CHUNKED_PASSWORD_SALT_PREFIX);
  const rawSalt = chunked ? salt.slice(CHUNKED_PASSWORD_SALT_PREFIX.length) : salt;
  if (!chunked) {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(rawSalt), iterations },
      material,
      256,
    );
    return bytesToHex(new Uint8Array(bits));
  }

  // Cloudflare Workers caps one PBKDF2 call at 100,000 iterations. Chaining
  // bounded calls preserves the configured total work factor without lowering
  // it. The prefix versions this format while legacy hashes retain their path.
  let materialBytes: Uint8Array = new TextEncoder().encode(password);
  let remaining = iterations;
  let round = 0;
  while (remaining > 0) {
    const roundIterations = Math.min(remaining, PBKDF2_RUNTIME_MAX_ITERATIONS);
    const material = await crypto.subtle.importKey("raw", materialBytes, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(`${rawSalt}:${round}`),
        iterations: roundIterations,
      },
      material,
      256,
    );
    materialBytes = new Uint8Array(bits);
    remaining -= roundIterations;
    round += 1;
  }
  return bytesToHex(materialBytes);
}
