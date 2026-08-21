import { ROOM_OPTIONS } from "@/app/reservation-config";
import type { RoomTransition } from "@/db/control";
import { completeArrivedReservationForRoom } from "@/db/reservations";
import {
  recordStoppedGame,
  refreshRecentStoppedGame,
} from "@/db/game-history";
import { isStoppedGameTransition } from "@/app/admin/game-history-utils";

export async function autoCompleteStoppedRoom(
  transition: RoomTransition | null,
) {
  if (!transition) {
    return null;
  }
  if (
    !isStoppedGameTransition(
      transition.previousStatus,
      transition.nextStatus,
      transition.nextRemainingSeconds,
    )
  ) {
    await refreshRecentStoppedGame(transition);
    return null;
  }
  const roomCode = ROOM_OPTIONS.find(
    (room) => room.roomId === transition.roomId,
  )?.code;
  if (!roomCode) return null;
  const room = ROOM_OPTIONS.find((item) => item.code === roomCode);
  const teamName = transition.previousTeamName || transition.nextTeamName;
  const reservationId = teamName.trim()
    ? await completeArrivedReservationForRoom(roomCode, teamName)
    : null;
  await recordStoppedGame(
    transition,
    roomCode,
    room?.name ?? roomCode,
    reservationId ?? "",
  );
  return reservationId;
}
