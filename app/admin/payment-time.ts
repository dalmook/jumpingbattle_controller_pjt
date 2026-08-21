type PaymentTimeInput = {
  authDate?: string | null;
  approvalTime?: string | null;
  fallbackTimestamp?: string | null;
};

function formatCompactLocal(dateDigits: string, timeDigits: string) {
  const date = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`;
  if (timeDigits.length < 4) return date;
  return `${date} ${timeDigits.slice(0, 2)}:${timeDigits.slice(2, 4)}`;
}

function parseUtcStorageTimestamp(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
    ? trimmed
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(trimmed)
      ? `${trimmed.replace(" ", "T")}Z`
      : trimmed;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function formatPaymentTimeInSeoul(input: PaymentTimeInput) {
  const authDigits = String(input.authDate ?? "").replace(/\D/g, "");
  const approvalDigits = String(input.approvalTime ?? "").replace(/\D/g, "");

  // MPOS authorization timestamps are terminal-local KST values, not UTC.
  if (authDigits.length >= 12) {
    return formatCompactLocal(authDigits.slice(0, 8), authDigits.slice(8, 14));
  }
  if (authDigits.length === 8 && approvalDigits.length >= 4) {
    return formatCompactLocal(authDigits, approvalDigits);
  }

  // D1 CURRENT_TIMESTAMP is UTC. Convert it explicitly instead of slicing the string.
  const fallback = parseUtcStorageTimestamp(String(input.fallbackTimestamp ?? ""));
  if (fallback) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(fallback);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
  }

  if (authDigits.length >= 8) return formatCompactLocal(authDigits.slice(0, 8), "");
  return "-";
}
