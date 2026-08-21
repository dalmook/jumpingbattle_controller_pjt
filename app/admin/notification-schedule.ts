export const DEFAULT_NOTIFICATION_TIME = "21:30";
export const DEFAULT_NOTIFICATION_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export type NotificationSchedule = {
  enabled: boolean;
  deliveryTime: string;
  weekdays: number[];
  lastSentDate: string;
};

export type SeoulClock = {
  date: string;
  time: string;
  weekday: number;
};

export function seoulClock(now = new Date()): SeoulClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    value("weekday"),
  );
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
    weekday,
  };
}

export function validDeliveryTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizeWeekdays(values: unknown): number[] {
  if (!Array.isArray(values)) return [...DEFAULT_NOTIFICATION_WEEKDAYS];
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
    ),
  ).sort((left, right) => left - right);
}

export function isNotificationDue(
  schedule: NotificationSchedule,
  clock: SeoulClock,
) {
  return Boolean(
    schedule.enabled &&
      validDeliveryTime(schedule.deliveryTime) &&
      schedule.weekdays.includes(clock.weekday) &&
      clock.time >= schedule.deliveryTime &&
      schedule.lastSentDate !== clock.date,
  );
}

export function dueNotificationSchedules<T extends NotificationSchedule>(
  schedules: T[],
  clock: SeoulClock,
) {
  return schedules.filter((schedule) => isNotificationDue(schedule, clock));
}
