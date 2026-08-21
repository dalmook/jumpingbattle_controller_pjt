export const CURRENT_SLOT_GRACE_MINUTES = 3;

function minutesOfDay(time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function currentOperatingSlot(
  nowTime: string,
  slots: readonly string[],
  graceMinutes = CURRENT_SLOT_GRACE_MINUTES,
) {
  if (slots.length === 0) return "";
  const nowMinutes = minutesOfDay(nowTime);
  return (
    slots.find((slot) => nowMinutes < minutesOfDay(slot) + graceMinutes) ??
    slots.at(-1) ??
    ""
  );
}
