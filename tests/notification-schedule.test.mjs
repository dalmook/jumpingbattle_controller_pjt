import test from "node:test";
import assert from "node:assert/strict";
import {
  dueNotificationSchedules,
  isNotificationDue,
  normalizeWeekdays,
  seoulClock,
  validDeliveryTime,
} from "../app/admin/notification-schedule.ts";

const base = {
  enabled: true,
  deliveryTime: "21:30",
  weekdays: [6],
  lastSentDate: "",
};

test("scheduled notification becomes due at the configured Seoul time", () => {
  assert.equal(
    isNotificationDue(base, { date: "2026-08-08", time: "21:30", weekday: 6 }),
    true,
  );
});

test("scheduled notification is not due before time, on another weekday, or twice", () => {
  assert.equal(
    isNotificationDue(base, { date: "2026-08-08", time: "21:29", weekday: 6 }),
    false,
  );
  assert.equal(
    isNotificationDue(base, { date: "2026-08-08", time: "22:00", weekday: 5 }),
    false,
  );
  assert.equal(
    isNotificationDue(
      { ...base, lastSentDate: "2026-08-08" },
      { date: "2026-08-08", time: "22:00", weekday: 6 },
    ),
    false,
  );
});

test("disabled schedule never dispatches", () => {
  assert.equal(
    isNotificationDue(
      { ...base, enabled: false },
      { date: "2026-08-08", time: "23:00", weekday: 6 },
    ),
    false,
  );
});

test("weekday and time inputs are normalized", () => {
  assert.deepEqual(normalizeWeekdays([6, 1, 6, "2", 9, -1]), [1, 2, 6]);
  assert.equal(validDeliveryTime("00:00"), true);
  assert.equal(validDeliveryTime("23:59"), true);
  assert.equal(validDeliveryTime("24:00"), false);
});

test("Seoul clock handles a UTC date boundary", () => {
  assert.deepEqual(seoulClock(new Date("2026-08-07T15:05:00.000Z")), {
    date: "2026-08-08",
    time: "00:05",
    weekday: 6,
  });
});

test("multiple schedules at different times are independently due on the same day", () => {
  const schedules = [
    { ...base, id: "closing", deliveryTime: "18:00", lastSentDate: "2026-08-08" },
    { ...base, id: "night", deliveryTime: "21:30", lastSentDate: "" },
    { ...base, id: "late", deliveryTime: "22:30", lastSentDate: "" },
  ];
  assert.deepEqual(
    dueNotificationSchedules(schedules, {
      date: "2026-08-08",
      time: "21:30",
      weekday: 6,
    }).map((schedule) => schedule.id),
    ["night"],
  );
});

test("two schedules sharing a time are both due unless each was already sent", () => {
  const schedules = [
    { ...base, id: "first" },
    { ...base, id: "second" },
    { ...base, id: "sent", lastSentDate: "2026-08-08" },
  ];
  assert.deepEqual(
    dueNotificationSchedules(schedules, {
      date: "2026-08-08",
      time: "21:30",
      weekday: 6,
    }).map((schedule) => schedule.id),
    ["first", "second"],
  );
});
