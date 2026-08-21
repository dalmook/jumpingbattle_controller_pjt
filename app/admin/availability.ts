export const SLOT_MINUTES = 20;
export const GAME_MINUTES = 16;
export const START_GRACE_MINUTES = 5;

const MINUTE_MS = 60_000;
const SLOT_MS = SLOT_MINUTES * MINUTE_MS;
const GAME_MS = GAME_MINUTES * MINUTE_MS;
const START_GRACE_MS = START_GRACE_MINUTES * MINUTE_MS;
const NON_BLOCKING_STATUSES = new Set([
  "cancelled",
  "canceled",
  "completed",
  "deleted",
  "no_show",
  "no-show",
  "noshow",
]);

export type AvailabilityReservation = {
  startsAt: number;
  status: string;
  scheduledTime: string;
  teamName: string;
};

type NextGameAvailabilityInput = {
  now: number;
  gameStartedAt: number | null;
  controllerRemainingSeconds?: number | null;
  currentTeamName: string;
  currentReservationStartsAt: number | null;
  reservations: AvailabilityReservation[];
};

export type NextGameAvailability = {
  availableAt: number;
  availableSeconds: number;
  queuedReservations: number;
  nextReservationTime: string;
  basis: "controller" | "schedule" | "available";
};

function isBlockingReservation(reservation: AvailabilityReservation) {
  return !NON_BLOCKING_STATUSES.has(reservation.status.trim().toLowerCase());
}

export function slotStartsAt(timestamp: number) {
  return Math.floor(timestamp / SLOT_MS) * SLOT_MS;
}

function uniqueBlockingReservationsFrom(
  reservations: AvailabilityReservation[],
  startsAt: number,
) {
  const byStartsAt = new Map<number, AvailabilityReservation>();
  reservations
    .filter(
      (reservation) =>
        reservation.startsAt >= startsAt && isBlockingReservation(reservation),
    )
    .sort((left, right) => left.startsAt - right.startsAt)
    .forEach((reservation) => {
      if (!byStartsAt.has(reservation.startsAt)) {
        byStartsAt.set(reservation.startsAt, reservation);
      }
    });
  return [...byStartsAt.values()];
}

function appendRunningReservationChain(
  reservations: AvailabilityReservation[],
  firstSlotStartsAt: number,
  currentGameEndsAt: number,
) {
  let availableAt = currentGameEndsAt;
  const queued: AvailabilityReservation[] = [];

  for (const reservation of uniqueBlockingReservationsFrom(
    reservations,
    firstSlotStartsAt,
  )) {
    // A new 16-minute game can fit when it ends exactly at the reservation.
    if (reservation.startsAt >= availableAt + GAME_MS) break;
    queued.push(reservation);
    // Store operations start a waiting reservation as soon as the room frees.
    availableAt += GAME_MS;
  }

  return { availableAt, queued };
}

function appendScheduledReservationChain(
  reservations: AvailabilityReservation[],
  firstSlotStartsAt: number,
) {
  const blocking = uniqueBlockingReservationsFrom(
    reservations,
    firstSlotStartsAt,
  );
  const firstReservation = blocking.find(
    (reservation) => reservation.startsAt === firstSlotStartsAt,
  );
  if (!firstReservation) {
    return { availableAt: firstSlotStartsAt, queued: [] };
  }

  const queued = [firstReservation];
  let availableAt = firstSlotStartsAt + SLOT_MS;
  for (const reservation of blocking) {
    if (reservation.startsAt <= firstSlotStartsAt) continue;
    if (reservation.startsAt >= availableAt + GAME_MS) break;
    queued.push(reservation);
    availableAt = Math.max(availableAt, reservation.startsAt) + SLOT_MS;
  }

  return { availableAt, queued };
}

function sameTeam(left: string, right: string) {
  const normalizedLeft = left.trim().toLocaleLowerCase("ko-KR");
  const normalizedRight = right.trim().toLocaleLowerCase("ko-KR");
  return Boolean(
    normalizedLeft &&
      normalizedRight &&
      normalizedLeft === normalizedRight,
  );
}

function matchingCurrentReservationStartsAt(
  reservations: AvailabilityReservation[],
  currentTeamName: string,
  now: number,
  preferredStartsAt: number | null,
) {
  const matching = reservations.filter(
    (reservation) =>
      isBlockingReservation(reservation) &&
      sameTeam(reservation.teamName, currentTeamName),
  );
  const containingNow = matching
    .filter(
      (reservation) =>
        reservation.startsAt <= now && now < reservation.startsAt + SLOT_MS,
    )
    .sort((left, right) => right.startsAt - left.startsAt)[0];

  if (containingNow) return containingNow.startsAt;
  if (preferredStartsAt === null) return null;

  return (
    matching.find(
      (reservation) => reservation.startsAt === preferredStartsAt,
    )?.startsAt ?? null
  );
}

export function calculateNextGameAvailability({
  now,
  gameStartedAt,
  controllerRemainingSeconds,
  currentTeamName,
  currentReservationStartsAt,
  reservations,
}: NextGameAvailabilityInput): NextGameAvailability {
  const runningStartedAt =
    gameStartedAt !== null && Number.isFinite(gameStartedAt)
      ? gameStartedAt
      : null;
  const hasControllerRemaining =
    controllerRemainingSeconds !== undefined &&
    controllerRemainingSeconds !== null &&
    Number.isFinite(controllerRemainingSeconds);
  const safeControllerRemaining = hasControllerRemaining
    ? Math.max(0, Number(controllerRemainingSeconds))
    : null;
  const hasRunningGame =
    safeControllerRemaining !== null
      ? safeControllerRemaining > 0
      : runningStartedAt !== null;
  const finishedReservationStartsAt =
    !hasRunningGame &&
    safeControllerRemaining === 0 &&
    runningStartedAt !== null
      ? matchingCurrentReservationStartsAt(
          reservations,
          currentTeamName,
          now,
          currentReservationStartsAt,
        )
      : null;
  const matchedReservationStartsAt = hasRunningGame
    ? matchingCurrentReservationStartsAt(
        reservations,
        currentTeamName,
        now,
        currentReservationStartsAt,
      )
    : null;
  const referenceTime = hasRunningGame
    ? matchedReservationStartsAt ?? runningStartedAt ?? now
    : now;
  const currentSlotStartsAt =
    matchedReservationStartsAt ?? slotStartsAt(referenceTime);
  const nextSlotStartsAt = currentSlotStartsAt + SLOT_MS;

  let availableAt = now;
  let basis: NextGameAvailability["basis"] = "available";
  let queuedReservations: AvailabilityReservation[] = [];

  if (hasRunningGame) {
    const currentGameEndsAt =
      safeControllerRemaining !== null
        ? now + safeControllerRemaining * 1_000
        : (runningStartedAt ?? now) + GAME_MS;
    const chain = appendRunningReservationChain(
      reservations,
      nextSlotStartsAt,
      currentGameEndsAt,
    );
    availableAt = chain.availableAt;
    queuedReservations = chain.queued;
    basis = "controller";
  } else {
    const elapsedInCurrentSlot = now - currentSlotStartsAt;
    const currentSlotIsBooked = uniqueBlockingReservationsFrom(
      reservations,
      currentSlotStartsAt,
    ).some(
      (reservation) =>
        reservation.startsAt === currentSlotStartsAt &&
        reservation.startsAt !== finishedReservationStartsAt,
    );
    const scheduledChainStartsAt = currentSlotIsBooked
      ? currentSlotStartsAt
      : elapsedInCurrentSlot >= START_GRACE_MS
        ? nextSlotStartsAt
        : null;

    if (scheduledChainStartsAt !== null) {
      const chain = appendScheduledReservationChain(
        reservations,
        scheduledChainStartsAt,
      );
      if (chain.queued.length > 0) {
        availableAt = chain.availableAt;
        queuedReservations = chain.queued;
        basis = "schedule";
      }
    }
  }

  availableAt = Math.max(now, availableAt);

  return {
    availableAt,
    availableSeconds: Math.max(0, Math.ceil((availableAt - now) / 1_000)),
    queuedReservations: queuedReservations.length,
    nextReservationTime: queuedReservations[0]?.scheduledTime ?? "",
    basis,
  };
}
