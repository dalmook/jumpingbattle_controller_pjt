const fs = require("fs");
const vm = require("vm");
const { webcrypto } = require("crypto");

const storage = {};
const network = {
  sheetOk: true,
  ordersOk: false,
  siteOk: true,
  sheetCalls: 0,
  ordersCalls: 0,
  siteCalls: 0,
  naverStatusCalls: 0,
  naverBookingCalls: 0,
  csrfCalls: 0
};
let apiRows = [];
let apiConfirmedCount = 0;
let sitePayload = null;
let stockPlan = { blockedSlots: [], managedSlots: [] };
let stockStatusBody = null;
let stockActionsPayload = null;
const stockPatchCalls = [];
let cookieRows = [];
let scriptResults = [];
const event = () => ({ addListener() {} });

const chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map(k => [k, storage[k]]));
        if (typeof key === "string") return { [key]: storage[key] };
        return { ...storage };
      },
      async set(values) { Object.assign(storage, values); },
      async remove(key) {
        for (const item of Array.isArray(key) ? key : [key]) delete storage[item];
      }
    }
  },
  alarms: {
    async get() { return undefined; },
    async create() {},
    async clear() { return true; },
    onAlarm: event()
  },
  runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
  tabs: { onRemoved: event(), async query() { return [{ id: 7 }]; } },
  windows: { onRemoved: event() },
  action: { onClicked: event() },
  webRequest: { onBeforeSendHeaders: event() },
  scripting: {
    async executeScript(input) {
      if (Array.isArray(input?.args) && input.args.length === 5) {
        const [, businessId, slot, stock, role] = input.args;
        stockPatchCalls.push({
          url: `https://api-partner.booking.naver.com/v3.1/businesses/${businessId}/biz-items/${slot.bizItemId}/schedules`,
          headers: { "x-booking-naver-role": role },
          body: {
            startTime: slot.scheduledTime,
            startDate: slot.scheduledDate,
            endDate: slot.scheduledDate,
            status: "ON",
            stock
          }
        });
        return [{ result: { ok: true, stage: "patch", status: 200, text: "{}" } }];
      }
      return scriptResults;
    }
  },
  cookies: { async getAll() { return cookieRows; } }
};

async function fetch(url, options = {}) {
  if (String(url).includes("api-partner.booking.naver.com/v3.1/csrf-token") && options.method === "POST") {
    network.csrfCalls += 1;
    return {
      ok: true,
      status: 200,
      url: String(url),
      headers: { get() { return "application/json"; } },
      async text() { return JSON.stringify({ csrfToken: "c".repeat(128) }); }
    };
  }
  if (String(url).includes("api-partner.booking.naver.com/v3.1/") && options.method === "PATCH") {
    stockPatchCalls.push({
      url: String(url),
      headers: options.headers,
      body: JSON.parse(options.body || "{}")
    });
    return {
      ok: true,
      status: 200,
      url: String(url),
      headers: { get() { return "application/json"; } },
      async text() { return JSON.stringify({ success: true }); }
    };
  }
  if (String(url).includes("partner.booking.naver.com/api/")) {
    const isStatus = String(url).includes("booking-status");
    if (isStatus) network.naverStatusCalls += 1;
    else network.naverBookingCalls += 1;
    const body = isStatus
      ? stockStatusBody || { bizItems: [{ bizItemId: 1000001, status: { today: { confirmedBookingCount: apiConfirmedCount } } }] }
      : apiRows;
    return {
      ok: true,
      status: 200,
      url: String(url),
      headers: { get() { return "application/json"; } },
      async text() { return JSON.stringify(body); }
    };
  }
  const isOrders = String(url).includes("REPLACE_WITH_KIOSK_WEBAPP_ID");
  const isSite = String(url).includes("your-site");
  const isStock = String(url).includes("/api/agent/naver-stock");
  if (isStock) {
    if (options.method === "POST") stockActionsPayload = JSON.parse(options.body || "{}");
    const body = options.method === "POST"
      ? { success: true, applied: stockActionsPayload?.actions?.length || 0 }
      : { success: true, ...stockPlan };
    return {
      ok: true,
      status: 200,
      url: String(url),
      headers: { get() { return "application/json"; } },
      async text() { return JSON.stringify(body); }
    };
  }
  if (isSite) network.siteCalls += 1;
  else if (isOrders) network.ordersCalls += 1;
  else network.sheetCalls += 1;
  if (isSite) sitePayload = JSON.parse(options.body || "{}");
  const ok = isSite ? network.siteOk : isOrders ? network.ordersOk : network.sheetOk;
  return {
    ok,
    status: ok ? 200 : 503,
    url: String(url),
    headers: { get() { return "application/json"; } },
    async text() { return JSON.stringify(ok ? { success: true } : { success: false, error: "mock failure" }); }
  };
}

const context = vm.createContext({
  chrome,
  fetch,
  console,
  crypto: webcrypto,
  Intl,
  Date,
  Math,
  Promise,
  setTimeout,
  clearTimeout,
  URL,
  AbortController,
  globalThis: null
});
context.globalThis = context;

const source = fs.readFileSync(__dirname + "/sw.js", "utf8")
  .replace("__JUMPING_AGENT_TOKEN__", "test-agent-token");
const instrumentedSource = source +
  "\nglobalThis.__testApi = { enqueueBookings, drainOutbox, getOutbox, getBookingStates, mapApiBooking, collectBookingsFromNaverApi, collectBookingsFromNaverApiWithStatus, getKstBookingRange, isTodayBooking, captureNaverWriteAuth, discoverNaverCsrfFromCookies, discoverNaverCsrfFromOpenPage, syncNaverStock, parseRemoteStockSlots, fastSyncBackoffMs, bookingStatusInfo };";
vm.runInContext(instrumentedSource, context, { filename: "sw.js" });

function naverWhen(dateKey, time = "오후 2:00") {
  const [year, month, day] = dateKey.split("-").map(Number);
  return `${String(year).slice(-2)}. ${month}. ${day}.(목) ${time}`;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

(async () => {
  const range = context.__testApi.getKstBookingRange(
    new Date("2026-07-29T15:00:00.000Z"),
  );
  if (
    range.dateKey !== "2026-07-30" ||
    range.startIso !== "2026-07-29T15:00:00.000Z" ||
    range.endIso !== "2026-08-13T14:59:59.999Z"
  ) {
    throw new Error("14-day Naver booking range is incorrect");
  }
  const todayKey = context.__testApi.getKstBookingRange().dateKey;

  const mapped = context.__testApi.mapApiBooking({
    bookingId: 123,
    bookingStatusCode: "RC03",
    bookingCount: 2,
    name: "테스트",
    phone: "010-0000-0000",
    startDate: "2026-07-29",
    bizItemName: "소형방 C1 (2~4인)",
    snapshotJson: {
      startDateTime: "2026-07-29T05:00:00Z",
      customFormInputJson: [
        { title: "Team명을 정해주세요!", value: "TEAM" },
        { title: "난이도 선택", value: "Basic" }
      ]
    }
  });
  if (
    mapped.bookNo !== "123" ||
    mapped.teamName !== "TEAM" ||
    mapped.difficulty !== "Basic" ||
    !mapped.when.includes("오후 2:00") ||
    mapped.totalCount !== 2
  ) {
    throw new Error("Naver API response mapping failed");
  }

  apiRows = [{
    bookingId: 123,
    bookingStatusCode: "RC03",
    name: "테스트",
    phone: "010-0000-0000",
    startDate: "2026-07-29",
    bizItemName: "소형방 C1 (2~4인)",
    snapshotJson: { startDateTime: "2026-07-29T05:00:00Z", customFormInputJson: [] }
  }];
  apiConfirmedCount = 1;
  const confirmed = await context.__testApi.collectBookingsFromNaverApi(true);
  if (confirmed.length !== 1 || confirmed[0].status !== "확정") {
    throw new Error("confirmed API collection failed");
  }

  const unchangedStatusInfo = context.__testApi.bookingStatusInfo({
    bizItems: [{ bizItemId: 1000001, status: { today: { confirmedBookingCount: 1 } } }]
  });
  storage.naverConfirmedBookingSnapshot = {
    dateKey: todayKey,
    items: confirmed,
    statusFingerprint: unchangedStatusInfo.fingerprint,
    lastFullPollAt: Date.now() - 5_000
  };
  const detailCallsBeforeFreshSnapshot = network.naverBookingCalls;
  const freshSnapshot = await context.__testApi.collectBookingsFromNaverApiWithStatus(false, unchangedStatusInfo);
  if (
    freshSnapshot.items.length !== 0 ||
    network.naverBookingCalls !== detailCallsBeforeFreshSnapshot
  ) {
    throw new Error("unchanged status should skip detailed polling before the reconcile deadline");
  }
  storage.naverConfirmedBookingSnapshot.lastFullPollAt = Date.now() - 31_000;
  const detailCallsBeforeDueSnapshot = network.naverBookingCalls;
  const dueSnapshot = await context.__testApi.collectBookingsFromNaverApiWithStatus(false, unchangedStatusInfo);
  if (
    dueSnapshot.items.length !== 1 ||
    network.naverBookingCalls <= detailCallsBeforeDueSnapshot
  ) {
    throw new Error("detailed polling must reconcile unchanged counts within 30 seconds");
  }

  apiRows = [{
    bookingId: 123,
    bookingStatusCode: "RC04",
    cancelledCount: 1,
    name: "테스트",
    startDate: "2026-07-29",
    bizItemName: "소형방 C1 (2~4인)",
    snapshotJson: { startDateTime: "2026-07-29T05:00:00Z", customFormInputJson: [] }
  }];
  apiConfirmedCount = 0;
  const cancelled = await context.__testApi.collectBookingsFromNaverApi(true);
  if (cancelled.length !== 1 || cancelled[0].status !== "취소") {
    throw new Error("explicitly cancelled booking was not mapped as cancellation");
  }

  const refundedConfirmedCode = context.__testApi.mapApiBooking({
    bookingId: 125,
    bookingStatusCode: "RC03",
    isAllRefunded: true,
    cancelledCount: 2,
    bookingCount: 2,
    startDate: "2026-07-29",
    bizItemName: "소형방 C1 (2~4인)",
    snapshotJson: { startDateTime: "2026-07-29T05:20:00Z", customFormInputJson: [] }
  });
  if (!refundedConfirmedCode || refundedConfirmedCode.status !== "취소") {
    throw new Error("fully cancelled booking with a stale confirmed code was not cancelled");
  }

  const cancelledNameWithConfirmedCode = context.__testApi.mapApiBooking({
    bookingId: 127,
    bookingStatusCode: "RC03",
    bookingStatusName: "취소",
    cancelledCount: 1,
    startDate: "2026-07-29",
    bizItemName: "소형방 C1 (2~4인)",
    snapshotJson: { startDateTime: "2026-07-29T05:30:00Z", customFormInputJson: [] }
  });
  if (!cancelledNameWithConfirmedCode || cancelledNameWithConfirmedCode.status !== "취소") {
    throw new Error("explicit cancellation name must override a stale confirmed code");
  }

  const partiallyCancelled = context.__testApi.mapApiBooking({
    bookingId: 126,
    bookingStatusCode: "RC03",
    cancelledCount: 1,
    bookingCount: 2,
    startDate: "2026-07-29",
    bizItemName: "소형방 C1 (2~4인)",
    snapshotJson: { startDateTime: "2026-07-29T05:40:00Z", customFormInputJson: [] }
  });
  if (!partiallyCancelled || partiallyCancelled.status !== "확정") {
    throw new Error("partially cancelled confirmed booking must remain active");
  }

  const waitingPaymentCancelled = context.__testApi.mapApiBooking({
    bookingId: 128,
    bookingStatusCode: "RC04",
    cancelledCount: 0,
    bookingCount: 1,
    startDate: "2026-08-10",
    bizItemName: "대형방 B1 (4~8인)",
    paymentStatusName: "입금대기취소",
    snapshotJson: { startDateTime: "2026-08-10T07:00:00Z", customFormInputJson: [] }
  });
  if (!waitingPaymentCancelled || waitingPaymentCancelled.status !== "취소") {
    throw new Error("waiting-payment cancellation without refund counters was not cancelled");
  }

  const waitingForPayment = context.__testApi.mapApiBooking({
    bookingId: 129,
    bookingStatusCode: "RC03",
    cancelledCount: 0,
    bookingCount: 1,
    startDate: "2026-08-10",
    bizItemName: "대형방 B1 (4~8인)",
    paymentStatusName: "입금대기",
    snapshotJson: { startDateTime: "2026-08-10T07:20:00Z", customFormInputJson: [] }
  });
  if (!waitingForPayment || waitingForPayment.status !== "확정") {
    throw new Error("active waiting-payment booking was incorrectly cancelled");
  }

  const activeBookingWithCustomerHistory = context.__testApi.mapApiBooking({
    bookingId: 130,
    bookingStatusCode: "RC03",
    bookingStatusName: "확정",
    completedCount: 1,
    cancelledCount: 10,
    userCancelledCount: 10,
    bookingCount: 1,
    startDate: "2026-08-21",
    bizItemName: "대형방 B1 (4~8인)",
    paymentStatusName: "입금대기",
    snapshotJson: { startDateTime: "2026-08-21T08:00:00Z", customFormInputJson: [] }
  });
  if (!activeBookingWithCustomerHistory || activeBookingWithCustomerHistory.status !== "확정") {
    throw new Error("customer history counters must not cancel or complete the current confirmed booking");
  }

  const newBookingWithCustomerHistory = context.__testApi.mapApiBooking({
    bookingId: 131,
    bookingStatusCode: "RC03",
    bookingStatusName: "신규예약",
    cancelledCount: 3,
    bookingCount: 1,
    startDate: "2026-08-21",
    bizItemName: "대형방 B1 (4~8인)",
    paymentStatusName: "입금대기",
    snapshotJson: { startDateTime: "2026-08-21T09:20:00Z", customFormInputJson: [] }
  });
  if (!newBookingWithCustomerHistory || newBookingWithCustomerHistory.status !== "확정") {
    throw new Error("customer cancellation history must not override a current new booking");
  }

  const completed = context.__testApi.mapApiBooking({
    bookingId: 124,
    bookingStatusCode: "RC99",
    isCompleted: true,
    completedCount: 1,
    cancelledCount: 1,
    startDate: "2026-07-29",
    bizItemName: "소형방 C1 (2~4인)",
    snapshotJson: { startDateTime: "2026-07-29T06:20:00Z", customFormInputJson: [] }
  });
  if (!completed || completed.status !== "이용완료" || !completed.when.includes("오후 3:20")) {
    throw new Error("completed booking must take precedence over stale cancellation counters");
  }

  const item = {
    name: "테스트",
    when: naverWhen(todayKey),
    product: "소형방 C1",
    status: "확정",
    bookNo: "TEST-1",
    phone: "",
    link: "",
    teamName: "TEAM",
    difficulty: "Basic"
  };

  await context.__testApi.enqueueBookings([item], false);
  const first = await context.__testApi.drainOutbox();
  if (first.sheetOk !== true || first.ordersOk !== false || first.siteOk !== true) {
    throw new Error("partial result was not recorded correctly");
  }
  if (sitePayload?.items?.[0]?.bookNo !== "TEST-1") {
    throw new Error("site delivery payload is incorrect");
  }

  let outbox = await context.__testApi.getOutbox();
  const pending = Object.values(outbox)[0];
  if (!pending || pending.sheetPending !== false || pending.ordersPending !== true || pending.sitePending !== false) {
    throw new Error("only the failed destination should remain pending");
  }

  // A manual main-sheet refresh must not erase a previously failed orders job.
  await context.__testApi.enqueueBookings([item], true);
  outbox = await context.__testApi.getOutbox();
  if (!Object.values(outbox)[0].ordersPending) {
    throw new Error("manual refresh erased the pending orders delivery");
  }

  let states = await context.__testApi.getBookingStates();
  if (
    states["NO:TEST-1"].sheetStatus !== "CONFIRMED" ||
    states["NO:TEST-1"].siteStatus !== "CONFIRMED" ||
    states["NO:TEST-1"].ordersStatus
  ) {
    throw new Error("sheet delivery state is incorrect");
  }

  network.ordersOk = true;
  const second = await context.__testApi.drainOutbox();
  if (!second.ok) throw new Error("retry should succeed");

  outbox = await context.__testApi.getOutbox();
  states = await context.__testApi.getBookingStates();
  if (Object.keys(outbox).length !== 0) throw new Error("delivered outbox entry was not removed");
  if (states["NO:TEST-1"].ordersStatus !== "CONFIRMED") {
    throw new Error("orders delivery state was not updated");
  }

  // A corrected time with the same status must update the main sheet and web,
  // without creating another orders delivery.
  const correctedItem = { ...item, when: naverWhen(todayKey, "오후 3:20") };
  await context.__testApi.enqueueBookings([correctedItem], false);
  outbox = await context.__testApi.getOutbox();
  const correction = Object.values(outbox)[0];
  if (!correction?.sheetPending || !correction?.sitePending || correction?.ordersPending) {
    throw new Error("same-status detail correction was not routed to the sheet and site");
  }
  const correctionResult = await context.__testApi.drainOutbox();
  if (!correctionResult.ok) throw new Error("detail correction delivery should succeed");

  // Future bookings remain visible on the website, but neither Google Sheet
  // destination may receive them before their actual KST booking date.
  const futureItem = {
    ...item,
    bookNo: "TEST-FUTURE",
    when: naverWhen(addDays(todayKey, 2))
  };
  const callsBeforeFuture = { ...network };
  await context.__testApi.enqueueBookings([futureItem], true);
  outbox = await context.__testApi.getOutbox();
  const futurePending = Object.values(outbox)[0];
  if (!futurePending || futurePending.sheetPending || futurePending.ordersPending || !futurePending.sitePending) {
    throw new Error("future booking was not restricted to website delivery");
  }
  const futureResult = await context.__testApi.drainOutbox();
  if (!futureResult.ok) throw new Error("future website delivery should succeed");
  if (
    network.sheetCalls !== callsBeforeFuture.sheetCalls ||
    network.ordersCalls !== callsBeforeFuture.ordersCalls ||
    network.siteCalls !== callsBeforeFuture.siteCalls + 1
  ) {
    throw new Error("future booking was sent to a Google Sheet destination");
  }

  // Naver stock changes are tested entirely against mocked JSON endpoints.
  // No real Partner booking inventory is touched by this harness.
  const cookieCsrf = "a".repeat(128);
  cookieRows = [{ name: "XSRF-TOKEN", value: cookieCsrf }];
  if (await context.__testApi.discoverNaverCsrfFromCookies() !== cookieCsrf) {
    throw new Error("Naver CSRF cookie discovery failed");
  }
  cookieRows = [];
  const pageCsrf = "b".repeat(128);
  scriptResults = [{ result: { csrfToken: pageCsrf } }];
  if (await context.__testApi.discoverNaverCsrfFromOpenPage() !== pageCsrf) {
    throw new Error("Naver CSRF page discovery failed");
  }
  scriptResults = [];

  await context.__testApi.captureNaverWriteAuth({
    requestHeaders: [
      { name: "x-csrf-token", value: "test-csrf" },
      { name: "x-booking-naver-role", value: "test-role" }
    ]
  });
  const fixedNow = new Date("2026-08-01T02:10:00.000Z"); // 11:10 KST
  const c1 = {
    slotKey: "C1|2026-08-01|11:20",
    roomCode: "C1",
    scheduledDate: "2026-08-01",
    scheduledTime: "11:20",
    bizItemId: 1000001,
    localCount: 1
  };
  const c2 = {
    slotKey: "C2|2026-08-01|11:40",
    roomCode: "C2",
    scheduledDate: "2026-08-01",
    scheduledTime: "11:40",
    bizItemId: 1000002,
    localCount: 1
  };

  stockPlan = { blockedSlots: [c1], managedSlots: [] };
  stockStatusBody = {
    bizItems: [{
      bizItemId: c1.bizItemId,
      status: {
        "2026-08-01T11:20:00+09:00": {
          stock: 1,
          remainingBookingCount: 1,
          requestedBookingCount: 0,
          confirmedBookingCount: 0
        }
      }
    }]
  };
  stockPatchCalls.length = 0;
  stockActionsPayload = null;
  const closedStock = await context.__testApi.syncNaverStock(fixedNow);
  if (
    closedStock.closed !== 1 ||
    stockPatchCalls[0]?.body?.stock !== 0 ||
    stockActionsPayload?.actions?.[0]?.action !== "claim"
  ) {
    throw new Error("local reservation did not close its Naver stock");
  }

  // Moving a reservation closes the new room/time and reopens only the old
  // slot that this extension previously claimed.
  stockPlan = {
    blockedSlots: [c2],
    managedSlots: [{ ...c1, originalStock: 1 }]
  };
  stockStatusBody = {
    bizItems: [
      {
        bizItemId: c1.bizItemId,
        status: {
          "2026-08-01T11:20:00+09:00": {
            stock: 0,
            remainingBookingCount: 0,
            requestedBookingCount: 0,
            confirmedBookingCount: 0
          }
        }
      },
      {
        bizItemId: c2.bizItemId,
        status: {
          "2026-08-01T11:40:00+09:00": {
            stock: 1,
            remainingBookingCount: 1,
            requestedBookingCount: 0,
            confirmedBookingCount: 0
          }
        }
      }
    ]
  };
  stockPatchCalls.length = 0;
  stockActionsPayload = null;
  await context.__testApi.syncNaverStock(fixedNow);
  if (
    !stockPatchCalls.some(call => call.body.startTime === "11:40" && call.body.stock === 0) ||
    !stockPatchCalls.some(call => call.body.startTime === "11:20" && call.body.stock === 1) ||
    !stockActionsPayload?.actions?.some(action => action.action === "release" && action.slotKey === c1.slotKey)
  ) {
    throw new Error("moving a reservation did not reconcile both Naver slots");
  }

  // A real Naver booking owns its availability. Never reopen that slot while
  // a requested/confirmed/completed/no-show count exists.
  stockPlan = { blockedSlots: [], managedSlots: [{ ...c2, originalStock: 1 }] };
  stockStatusBody = {
    bizItems: [{
      bizItemId: c2.bizItemId,
      status: {
        "2026-08-01T11:40:00+09:00": {
          stock: 0,
          remainingBookingCount: 0,
          requestedBookingCount: 0,
          confirmedBookingCount: 1
        }
      }
    }]
  };
  stockPatchCalls.length = 0;
  stockActionsPayload = null;
  await context.__testApi.syncNaverStock(fixedNow);
  if (
    stockPatchCalls.length !== 0 ||
    stockActionsPayload?.actions?.[0]?.action !== "release"
  ) {
    throw new Error("a native Naver reservation was incorrectly reopened");
  }

  // A manually closed, unowned slot must remain untouched.
  stockPlan = { blockedSlots: [], managedSlots: [] };
  stockStatusBody = {
    bizItems: [{
      bizItemId: 1000003,
      status: {
        "2026-08-01T12:00:00+09:00": {
          stock: 0,
          remainingBookingCount: 0,
          requestedBookingCount: 0,
          confirmedBookingCount: 0
        }
      }
    }]
  };
  stockPatchCalls.length = 0;
  stockActionsPayload = null;
  await context.__testApi.syncNaverStock(fixedNow);
  if (stockPatchCalls.length !== 0 || stockActionsPayload !== null) {
    throw new Error("a manually closed Naver slot was changed");
  }

  // A provided status response is reused by stock reconciliation, and write
  // authorization is not refreshed when no stock PATCH is needed.
  storage.naverManagedStockSlots = {};
  stockPlan = { blockedSlots: [], managedSlots: [] };
  network.naverStatusCalls = 0;
  network.csrfCalls = 0;
  await context.__testApi.syncNaverStock(fixedNow, { statusBody: stockStatusBody });
  if (network.naverStatusCalls !== 0 || network.csrfCalls !== 0) {
    throw new Error("provided status or lazy write authorization was not reused");
  }

  if (
    context.__testApi.fastSyncBackoffMs({ httpStatus: 429, retryAfterMs: 90_000 }, 1) !== 90_000 ||
    context.__testApi.fastSyncBackoffMs({ httpStatus: 403 }, 1) !== 5 * 60 * 1000
  ) {
    throw new Error("fast synchronization rate-limit backoff is unsafe");
  }

  // Missing/expired write authorization fails closed: no stock request is sent.
  delete storage.naverWriteAuth;
  stockPlan = {
    blockedSlots: [{
      slotKey: "A1|2026-08-01|12:00",
      roomCode: "A1",
      scheduledDate: "2026-08-01",
      scheduledTime: "12:00",
      bizItemId: 1000003,
      localCount: 1
  }],
    managedSlots: []
  };
  stockStatusBody.bizItems[0].status["2026-08-01T12:00:00+09:00"].stock = 1;
  stockStatusBody.bizItems[0].status["2026-08-01T12:00:00+09:00"].confirmedBookingCount = 0;
  stockPatchCalls.length = 0;
  let missingAuthRejected = false;
  try {
    await context.__testApi.syncNaverStock(fixedNow);
  } catch (_) {
    missingAuthRejected = true;
  }
  if (!missingAuthRejected || stockPatchCalls.length !== 0) {
    throw new Error("missing Naver authorization did not fail safely");
  }

  console.log("state harness OK");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
