export function isStoppedGameTransition(
  previousStatus: string,
  nextStatus: string,
  _nextRemainingSeconds: number,
) {
  return (
    previousStatus === "running" &&
    nextStatus === "waiting"
  );
}

export function normalizeFinalLevel(value: string) {
  const normalized = value.trim().slice(0, 80);
  if (!normalized || /^(?:game\s*start|gamestart|대기|-+)$/i.test(normalized)) {
    return "";
  }
  return normalized;
}

export function seoulGameDateTime(value: string | number | Date) {
  const source = value instanceof Date ? value : new Date(value);
  const timestamp = Number.isFinite(source.getTime()) ? source.getTime() : Date.now();
  const shifted = new Date(timestamp + 9 * 60 * 60 * 1_000)
    .toISOString();
  return {
    date: shifted.slice(0, 10),
    time: shifted.slice(11, 16),
  };
}

export function displayGameLevel(value: string) {
  const normalized = normalizeFinalLevel(value);
  if (!normalized) return "기록 없음";
  return normalized.replace(/^level[-\s]*/i, "Level ");
}
