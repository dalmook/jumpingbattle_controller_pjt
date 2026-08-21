import assert from "node:assert/strict";
import test from "node:test";
import { formatPaymentTimeInSeoul } from "../app/admin/payment-time.ts";

test("MPOS compact approval timestamps remain terminal-local Korean time", () => {
  assert.equal(
    formatPaymentTimeInSeoul({ authDate: "20260812143022" }),
    "2026-08-12 14:30",
  );
});

test("manual terminal approval date and time are combined without UTC conversion", () => {
  assert.equal(
    formatPaymentTimeInSeoul({ authDate: "20260812", approvalTime: "143022" }),
    "2026-08-12 14:30",
  );
});

test("D1 UTC timestamps are displayed in Asia/Seoul", () => {
  assert.equal(
    formatPaymentTimeInSeoul({ fallbackTimestamp: "2026-08-12 05:30:00" }),
    "2026-08-12 14:30",
  );
  assert.equal(
    formatPaymentTimeInSeoul({ fallbackTimestamp: "2026-08-12T16:10:00Z" }),
    "2026-08-13 01:10",
  );
});

test("server KST fallback is used when approval date contains no time", () => {
  assert.equal(
    formatPaymentTimeInSeoul({
      authDate: "20260812",
      fallbackTimestamp: "2026-08-12 05:30:00",
    }),
    "2026-08-12 14:30",
  );
});
