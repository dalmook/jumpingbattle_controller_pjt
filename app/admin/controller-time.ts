import type { Room } from "../types";

export const ROOM_SYNC_STALE_AFTER_MS = 5_000;

export function databaseTimestamp(value: string) {
  if (!value) return Number.NaN;
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  return new Date(normalized).getTime();
}

export function correctedRemainingSeconds(room: Room, serverNow: number) {
  const remainingSeconds = Math.max(0, Math.floor(room.remainingSeconds));
  if (room.status !== "running") return 0;
  if (remainingSeconds === 0) return 0;

  const observedAt = databaseTimestamp(room.updatedAt);
  if (!Number.isFinite(observedAt)) return remainingSeconds;

  const elapsedSeconds = Math.floor(Math.max(0, serverNow - observedAt) / 1_000);
  return Math.max(0, remainingSeconds - elapsedSeconds);
}

export function isRoomSampleFresh(room: Room, serverNow: number) {
  const observedAt = databaseTimestamp(room.updatedAt);
  return (
    Number.isFinite(observedAt) &&
    serverNow - observedAt >= -1_000 &&
    serverNow - observedAt <= ROOM_SYNC_STALE_AFTER_MS
  );
}
