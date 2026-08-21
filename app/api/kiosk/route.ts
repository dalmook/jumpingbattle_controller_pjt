import { getDifficultyOptions, ROOM_OPTIONS } from "@/app/reservation-config";
import {
  continueKioskAsGuest,
  addKioskParticipantMember,
  acceptKioskGuidance,
  autoAssignKioskSlot,
  cancelKioskCheckout,
  createKioskVisit,
  findKioskReservations,
  getKioskAvailability,
  getKioskCatalog,
  getKioskDisplaySettings,
  getKioskGuidance,
  getKioskRoomRecommendation,
  getKioskRuntimeState,
  getKioskRoomStatusSnapshot,
  getKioskReadyVisitForDevice,
  holdKioskSlot,
  loginKioskMember,
  quoteKioskCheckout,
  quoteKioskParticipantTopUp,
  processKioskPayment,
  requestKioskStaffHelp,
  resetKioskVisit,
  selectKioskReservation,
  startKioskCheckout,
  startKioskGame,
  startKioskGameFromDevice,
  syncKioskDraft,
  updateKioskDifficulty,
  updateKioskParty,
  updateKioskTeamName,
} from "@/db/customer-flow";
import { maybeDispatchInfrastructureAlerts, touchKioskRuntime } from "@/db/remote-operations";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { memberClientIdentity, registerCustomerMember } from "@/db/member-auth";
import { hasKioskDeviceSession } from "@/app/pin-auth";
import { getParkingSettings } from "@/db/parking-settings";
import { publicKioskPaymentSettings } from "@/app/kiosk/payment-settings";
import { getKioskPaymentSettings } from "@/db/kiosk-payment-settings";
import {
  createKioskLatencyTrace,
  finishKioskLatencyTrace,
  type KioskLatencyTrace,
} from "@/db/kiosk-latency";

function token(request: Request) {
  return String(request.headers.get("x-customer-session") ?? "").trim();
}

function safeError(error: unknown) {
  const code = error instanceof Error ? error.message : "KIOSK_REQUEST_FAILED";
  const messages: Record<string, string> = {
    KIOSK_SESSION_NOT_FOUND: "처음 화면부터 다시 시작해주세요.",
    KIOSK_SESSION_EXPIRED: "입력이 오래 멈춰 처음 화면으로 돌아갑니다.",
    KIOSK_SLOT_OCCUPIED: "방금 다른 고객이 선택한 시간입니다. 다른 시간대를 골라주세요.",
    KIOSK_SLOT_INVALID: "선택할 수 없는 방 또는 시간입니다.",
    KIOSK_BENEFIT_NOT_USABLE: "현재 사용할 수 없는 이용권 또는 쿠폰입니다.",
    KIOSK_BENEFIT_OWNER_INVALID: "연결되지 않은 회원의 혜택입니다.",
    KIOSK_BENEFIT_OWNER_MISMATCH: "다회권과 무료 이용권은 같은 회원의 혜택만 함께 사용할 수 있습니다.",
    KIOSK_PAYMENT_ITEMS_INVALID: "결제수단 구성을 다시 확인해주세요.",
    KIOSK_PAYMENT_TOTAL_MISMATCH: "결제수단별 금액 합계가 결제할 금액과 다릅니다.",
    KIOSK_PAYMENT_METHOD_DISABLED: "현재 키오스크에서 사용할 수 없는 결제수단입니다. 다른 결제수단을 선택해주세요.",
    KIOSK_BANK_TRANSFER_NOT_CONFIGURED: "계좌이체 안내가 준비되지 않았습니다. 직원에게 알려주세요.",
    KIOSK_PRODUCT_NOT_AVAILABLE: "선택한 상품이 방금 품절 또는 판매 중지됐습니다.",
    KIOSK_HOLD_EXPIRED: "선택 시간이 끝났습니다. 방과 시간을 다시 골라주세요.",
    KIOSK_MEMBER_COUNT_EXCEEDED: "이용 인원보다 많은 회원을 연결할 수 없습니다.",
    KIOSK_RESERVATION_IN_USE: "이 예약은 이미 확인 중입니다. 처음 화면으로 돌아가 다시 시도해주세요.",
    KIOSK_TEAM_NAME_INVALID: "기존 게임에서 사용한 팀명을 입력해주세요.",
    KIOSK_PARTICIPANT_TOP_UP_EMPTY: "추가할 성인 또는 청소년 인원을 선택해주세요.",
    KIOSK_PARTICIPANT_TOP_UP_INVALID_STATE: "인원 추가 결제를 처음부터 다시 진행해주세요.",
    KIOSK_PARTICIPANT_TOP_UP_NOT_ACTIVE: "이미 이용이 끝났거나 취소된 예약에는 인원을 추가할 수 없습니다.",
    KIOSK_PARTICIPANT_TOP_UP_PAYMENT_REQUIRED: "기존 게임비 결제가 완료된 예약만 인원을 추가할 수 있습니다.",
    KIOSK_PARTICIPANT_TOP_UP_STALE: "예약 인원이 방금 변경됐습니다. 처음 화면에서 다시 확인해주세요.",
    KIOSK_PARTICIPANT_TOP_UP_GROUPED: "묶음 결제된 예약은 직원에게 인원 추가를 요청해주세요.",
    KIOSK_REPEAT_GAME_NOT_COMPLETED: "정상 완료된 게임만 한 게임 더 이어갈 수 있습니다.",
    KIOSK_REPEAT_GAME_VISIT_NOT_FOUND: "이전 게임 정보를 찾지 못했습니다. 직원에게 알려주세요.",
    KIOSK_CHECKOUT_INCOMPLETE: "예약 정보를 모두 입력해주세요.",
    KIOSK_CHECKOUT_CANCEL_NOT_ALLOWED: "결제가 이미 시작됐거나 확인이 필요한 상태입니다. 직원에게 알려주세요.",
    KIOSK_CHECKOUT_CANCEL_UNSUPPORTED: "이 예약은 직원 확인 후 취소할 수 있습니다.",
    KIOSK_CHECKOUT_CANCEL_BENEFIT_APPLIED: "다회권이나 쿠폰이 적용된 결제는 직원에게 취소를 요청해주세요.",
    KIOSK_REQUIRED_GUIDANCE_NOT_ACCEPTED: "필수 이용안내에 동의해주세요.",
    KIOSK_ROOM_SIZE_INVALID: "방 크기를 다시 선택해주세요.",
    PAYMENT_AGENT_OFFLINE: "결제 연결을 확인하고 있습니다. 직원에게 알려주세요.",
    PAYMENT_TERMINAL_NOT_READY: "카드 단말기를 준비하고 있습니다. 직원에게 알려주세요.",
    PAYMENT_TERMINAL_BUSY: "다른 카드 결제를 처리 중입니다. 잠시 후 다시 시도해주세요.",
    PAYMENT_UNKNOWN: "결제 결과를 확인하고 있습니다. 중복 결제하지 말고 직원에게 알려주세요.",
    PAYMENT_PLAN_LOCKED: "이미 처리된 결제 내역이 있어 직원 확인이 필요합니다.",
    PAYMENT_PLAN_STALE: "결제 정보가 변경됐습니다. 결제 화면을 다시 확인해주세요.",
    PAYMENT_TRANSACTION_NOT_PENDING: "이전 결제 결과를 확인했습니다. 결제 화면에서 다시 시도해주세요.",
    PAYMENT_COMMAND_QUEUE_CONFLICT: "결제 요청 상태를 확인하고 있습니다. 직원에게 알려주세요.",
    PAYMENT_TRANSACTION_NOT_RETRYABLE: "이 결제는 자동으로 다시 시도할 수 없습니다. 직원에게 알려주세요.",
    PAYMENT_ATTEMPT_NOT_FOUND: "결제 회차를 찾지 못했습니다. 결제 화면을 다시 확인해주세요.",
    CONTROL_AGENT_OFFLINE: "게임 연결을 확인하고 있습니다. 직원에게 알려주세요.",
    CONTROL_MANAGER_NOT_VISIBLE: "게임 준비 프로그램을 확인하고 있습니다. 직원에게 알려주세요.",
    CONTROL_LOCKED: "직원이 게임 시작 준비를 확인하고 있습니다.",
    CONTROL_ROOM_BUSY: "선택한 방을 준비 중입니다. 잠시 후 다시 눌러주세요.",
    KIOSK_ROOM_NOT_READY: "아직 방 준비가 끝나지 않았습니다.",
    KIOSK_START_NOT_READY: "아직 게임을 시작할 수 있는 상태가 아닙니다.",
    KIOSK_DEVICE_NOT_PAIRED: "직원 메뉴에서 이 기기를 매장 키오스크로 한 번 등록해주세요.",
    MEMBER_LOGIN_INVALID: "휴대폰 번호 또는 비밀번호를 확인해주세요.",
    MEMBER_AUTH_RATE_LIMITED: "로그인 시도가 많습니다. 잠시 후 다시 시도해주세요.",
    MEMBER_ACCOUNT_EXISTS: "이미 가입된 휴대폰 번호입니다. 로그인해주세요.",
  };
  return { code, message: messages[code] ?? "처리하지 못했습니다. 직원에게 알려주세요." };
}

function kioskTraceResponse(trace: KioskLatencyTrace, payload: unknown, init: ResponseInit = {}) {
  const status = init.status ?? 200;
  const completed = finishKioskLatencyTrace(trace, status);
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("server-timing", completed.serverTiming);
  headers.set("x-kiosk-trace-id", completed.traceId);
  return Response.json(payload, { ...init, status, headers });
}

export async function GET(request: Request) {
  try {
    const search = new URL(request.url).searchParams;
    const scope = search.get("scope") ?? "bootstrap";
    if (scope === "room_status") {
      getRequestExecutionContext()?.waitUntil(
        touchKioskRuntime({ status: "ROOM_STATUS" }).then(() => maybeDispatchInfrastructureAlerts()),
      );
      return Response.json({ ...(await getKioskRoomStatusSnapshot()), devicePaired: await hasKioskDeviceSession(request) }, { headers: { "cache-control": "no-store" } });
    }
    if (scope === "availability") {
      return Response.json({ rooms: await getKioskAvailability(Number(search.get("partyCount")) || 1) });
    }
    if (scope === "room_recommendation") {
      const adultCount = Math.max(0, Number(search.get("adultCount")) || 0);
      const youthCount = Math.max(0, Number(search.get("youthCount")) || 0);
      return Response.json({ roomRecommendation: await getKioskRoomRecommendation(adultCount, youthCount) }, {
        headers: { "cache-control": "no-store" },
      });
    }
    if (scope === "catalog") return Response.json({ products: await getKioskCatalog() });
    if (scope === "state") return Response.json(await getKioskRuntimeState(token(request)));
    const kioskPaymentSettings = await getKioskPaymentSettings();
    const adultCount = Math.max(0, Number(search.get("adultCount")) || 0);
    const youthCount = Math.max(0, Number(search.get("youthCount")) || 0);
    return Response.json({
      store: { name: "점핑배틀 화성병점점", today: (await import("@/app/reservation-config")).dateInSeoul() },
      rooms: await getKioskAvailability(Number(search.get("partyCount")) || 1),
      products: await getKioskCatalog(),
      guidance: await getKioskGuidance(),
      displaySettings: await getKioskDisplaySettings(),
      roomRecommendation: await getKioskRoomRecommendation(adultCount, youthCount),
      parking: await getParkingSettings(),
      paymentSettings: publicKioskPaymentSettings(kioskPaymentSettings),
      difficulties: Object.fromEntries(ROOM_OPTIONS.map((room) => [
        room.code,
        getDifficultyOptions(room.code).map((item) => ({
          code: item.code, label: item.label, stars: item.stars, description: item.description,
        })),
      ])),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const normalized = safeError(error);
    return Response.json({ error: normalized.message, code: normalized.code }, { status: 400 });
  }
}

export async function POST(request: Request) {
  let trace: KioskLatencyTrace | null = null;
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    getRequestExecutionContext()?.waitUntil(touchKioskRuntime({
      kioskId: String(body.kioskId ?? "main-kiosk"),
      visitId: String(body.visitId ?? ""),
      status: action || "ACTIVE",
    }));
    trace = createKioskLatencyTrace(String(request.headers.get("x-kiosk-trace-id") ?? ""), action);
    const reply = (payload: unknown, init: ResponseInit = {}) => kioskTraceResponse(trace!, payload, init);
    if (action === "open_ready_room" || action === "start_ready_game") {
      if (!(await hasKioskDeviceSession(request))) throw new Error("KIOSK_DEVICE_NOT_PAIRED");
      const visitId = String(body.visitId ?? "");
      if (action === "open_ready_room") return reply({ visit: await getKioskReadyVisitForDevice(visitId) });
      return reply(await startKioskGameFromDevice(visitId), { status: 202 });
    }
    if (action === "create_session") {
      return reply(await createKioskVisit({ kioskId: String(body.kioskId ?? "main-kiosk"), flowType: String(body.flowType ?? "WALK_IN") }), { status: 201 });
    }
    const sessionToken = token(request);
    if (!sessionToken) throw new Error("KIOSK_SESSION_NOT_FOUND");
    if (action === "staff_help") return reply(await requestKioskStaffHelp(sessionToken));
    if (action === "sync_draft") return reply(await syncKioskDraft(sessionToken, body.draft as never, trace));
    if (action === "party") {
      const result = await updateKioskParty(sessionToken, {
        adultCount: body.adultCount, youthCount: body.youthCount, teamName: body.teamName,
      }, trace);
      return reply({
        ...result,
        roomRecommendation: await getKioskRoomRecommendation(Number(body.adultCount), Number(body.youthCount)),
      });
    }
    if (action === "team") return reply(await updateKioskTeamName(sessionToken, body.teamName, trace));
    if (action === "accept_guidance") return reply(await acceptKioskGuidance(
      sessionToken,
      Array.isArray(body.guidanceIds) ? body.guidanceIds.map(String) : [],
    ));
    if (action === "guest") return reply(await continueKioskAsGuest(sessionToken, { name: body.name, phone: body.phone }, trace));
    if (action === "login") return reply(await loginKioskMember(sessionToken, {
      phone: String(body.phone ?? ""), password: String(body.password ?? ""), clientIdentity: memberClientIdentity(request),
    }));
    if (action === "add_member") return reply(await addKioskParticipantMember(sessionToken, {
      phone: String(body.phone ?? ""), password: String(body.password ?? ""), clientIdentity: memberClientIdentity(request),
    }));
    if (action === "register") {
      await registerCustomerMember({
        name: String(body.name ?? ""), phone: String(body.phone ?? ""), password: String(body.password ?? ""),
        teamName: String(body.teamName ?? ""), agreed: body.agreed === true, createPersistentSession: false,
      });
      return reply(await loginKioskMember(sessionToken, {
        phone: String(body.phone ?? ""), password: String(body.password ?? ""), clientIdentity: memberClientIdentity(request),
      }));
    }
    if (action === "find_reservations") return reply({ reservations: await findKioskReservations(sessionToken, {
      phone: String(body.phone ?? ""), teamName: String(body.teamName ?? ""),
    }) });
    if (action === "select_reservation") return reply(await selectKioskReservation(sessionToken, String(body.reservationId ?? "")));
    if (action === "hold") return reply(await holdKioskSlot(sessionToken, {
      date: String(body.date ?? ""), time: String(body.time ?? ""), roomCode: String(body.roomCode ?? ""), draft: body.draft as never,
    }, trace));
    if (action === "auto_assign") return reply(await autoAssignKioskSlot(sessionToken, {
      roomSize: body.roomSize,
      difficultyCode: body.difficultyCode,
      afterTime: body.afterTime,
      appendGame: body.appendGame === true,
      draft: body.draft as never,
    }, trace));
    if (action === "difficulty") return reply(await updateKioskDifficulty(sessionToken, String(body.difficultyCode ?? ""), trace));
    if (action === "quote") return reply(await quoteKioskCheckout(sessionToken, {
      addOns: body.addOns as never, benefitType: String(body.benefitType ?? ""), benefitId: String(body.benefitId ?? ""), benefitMemberId: String(body.benefitMemberId ?? ""),
      benefitUses: body.benefitUses,
      vehicleLast4: String(body.vehicleLast4 ?? ""),
      passId: String(body.passId ?? ""), passMemberId: String(body.passMemberId ?? ""), passUses: body.passUses,
      couponId: String(body.couponId ?? ""), couponMemberId: String(body.couponMemberId ?? ""),
      draft: body.draft as never,
    }, trace));
    if (action === "participant_top_up_quote") return reply(await quoteKioskParticipantTopUp(sessionToken, {
      additionalAdultCount: body.additionalAdultCount,
      additionalYouthCount: body.additionalYouthCount,
    }));
    if (action === "checkout") return reply(await startKioskCheckout(
      sessionToken,
      String(body.requestKey ?? ""),
      Array.isArray(body.paymentItems) ? body.paymentItems as Array<{ amount?: unknown; paymentMethod?: unknown }> : undefined,
      String(body.paymentMode ?? "single"),
    ), { status: 202 });
    if (action === "process_payment") return reply(await processKioskPayment(
      sessionToken,
      String(body.transactionId ?? ""),
      String(body.paymentMethod ?? "card"),
      String(body.requestKey ?? ""),
    ), { status: 202 });
    if (action === "start_game") return reply(await startKioskGame(sessionToken, String(body.startToken ?? "")), { status: 202 });
    if (action === "cancel_checkout") return reply(await cancelKioskCheckout(sessionToken));
    if (action === "reset") return reply(await resetKioskVisit(sessionToken));
    return reply({ error: "지원하지 않는 요청입니다." }, { status: 400 });
  } catch (error) {
    const normalized = safeError(error);
    const conflict = [
      "KIOSK_SLOT_OCCUPIED",
      "CONTROL_ROOM_BUSY",
      "KIOSK_VISIT_LOCKED",
      "KIOSK_CHECKOUT_CANCEL_NOT_ALLOWED",
      "KIOSK_CHECKOUT_CANCEL_UNSUPPORTED",
      "KIOSK_CHECKOUT_CANCEL_BENEFIT_APPLIED",
      "KIOSK_PAYMENT_CANCEL_NOT_ALLOWED",
      "PAYMENT_COMMAND_QUEUE_CONFLICT",
    ].includes(normalized.code);
    const init = { status: conflict ? 409 : 400 };
    console.warn("[KIOSK_API_ERROR]", JSON.stringify({
      traceId: trace?.traceId ?? "-",
      action: trace?.action ?? "unknown",
      code: normalized.code,
      status: init.status,
    }));
    return trace
      ? kioskTraceResponse(trace, { error: normalized.message, code: normalized.code }, init)
      : Response.json({ error: normalized.message, code: normalized.code }, init);
  }
}
