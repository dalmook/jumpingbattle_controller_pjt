export type ImportedSourceState = "booked" | "completed" | "cancelled";

export type ReservationOperationalState =
  | "booked"
  | "arrived"
  | "completed"
  | "cancelled";

export function classifyImportedSourceState(value: string): ImportedSourceState {
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  const hasCompleted = /(이용완료|사용완료|COMPLETED|COMPLETE|USED|DONE)/.test(normalized);
  const hasCancelled = /(취소|환불|CANCELED|CANCELLED|REFUND)/.test(normalized);

  // The Naver calendar can expose the available action labels together as
  // "이용완료 취소". In that mixed label, "취소" is a button, not the
  // reservation state. Real cancellations arrive without a completion label.
  if (hasCompleted) {
    return "completed";
  }
  if (hasCancelled) {
    return "cancelled";
  }
  return "booked";
}

export function resolveImportedOperationalState(
  sourceState: ImportedSourceState,
  currentState: ReservationOperationalState | null,
  locallyCompleted: boolean,
): ReservationOperationalState {
  if (sourceState === "cancelled") return "cancelled";
  if (currentState === "completed" && locallyCompleted) return "completed";
  if (currentState === "arrived") return "arrived";

  // Naver's "completed" flag is only source metadata. Store operations are
  // completed by the manager or controller stop event, never by an import.
  return "booked";
}
