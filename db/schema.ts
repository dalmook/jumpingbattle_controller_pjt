import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  roomId: text("room_id").primaryKey(),
  name: text("name").notNull(),
  size: text("size").notNull(),
  status: text("status").notNull().default("offline"),
  teamName: text("team_name").notNull().default(""),
  mapName: text("map_name").notNull().default(""),
  mapIndex: integer("map_index").notNull().default(0),
  people: integer("people").notNull().default(0),
  remainingSeconds: integer("remaining_seconds").notNull().default(0),
  score: integer("score").notNull().default(0),
  level: text("level").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const agents = sqliteTable("agents", {
  agentId: text("agent_id").primaryKey(),
  version: text("version").notNull().default(""),
  lastSeen: text("last_seen").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const agentRuntime = sqliteTable("agent_runtime", {
  agentId: text("agent_id").primaryKey(),
  armed: integer("armed").notNull().default(0),
  simulate: integer("simulate").notNull().default(0),
  managerVisible: integer("manager_visible").notNull().default(0),
  bridgeInstanceId: text("bridge_instance_id").notNull().default(""),
  controlState: text("control_state").notNull().default("IDLE"),
  currentControlAction: text("current_control_action").notNull().default(""),
  controlStartedAt: text("control_started_at"),
  lastControlSuccessAt: text("last_control_success_at"),
  lastControlError: text("last_control_error").notNull().default(""),
  stateStale: integer("state_stale").notNull().default(0),
  managerState: text("manager_state").notNull().default("UNAVAILABLE"),
  managerProbeAt: text("manager_probe_at"),
  managerProbeSuccessCount: integer("manager_probe_success_count").notNull().default(0),
  managerModalActive: integer("manager_modal_active").notNull().default(0),
  controlLoopLastSeen: text("control_loop_last_seen"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const roomControlRuntime = sqliteTable("room_control_runtime", {
  roomId: text("room_id").primaryKey(),
  controlState: text("control_state").notNull().default("READY"),
  currentAction: text("current_action").notNull().default(""),
  currentCommandId: text("current_command_id").notNull().default(""),
  lastSuccessAt: text("last_success_at"),
  lastErrorCode: text("last_error_code").notNull().default(""),
  lastError: text("last_error").notNull().default(""),
  lastErrorAt: text("last_error_at"),
  stateSeenAt: text("state_seen_at"),
  observedAt: text("observed_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const roomMetadata = sqliteTable("room_metadata", {
  roomId: text("room_id").primaryKey(),
  mapOptionsJson: text("map_options_json").notNull().default("[]"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const roomGameRuntime = sqliteTable("room_game_runtime", {
  roomId: text("room_id").primaryKey(),
  gameStartedAt: text("game_started_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const gameRecords = sqliteTable(
  "game_records",
  {
    id: text("id").primaryKey(),
    sessionKey: text("session_key").notNull().unique(),
    reservationId: text("reservation_id"),
    bookingCode: text("booking_code").notNull().default(""),
    source: text("source").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    roomId: text("room_id").notNull(),
    roomCode: text("room_code").notNull().default(""),
    roomName: text("room_name").notNull().default(""),
    teamName: text("team_name").notNull().default(""),
    mapName: text("map_name").notNull().default(""),
    difficultyLabel: text("difficulty_label").notNull().default(""),
    adultCount: integer("adult_count").notNull().default(0),
    youthCount: integer("youth_count").notNull().default(0),
    people: integer("people").notNull().default(0),
    score: integer("score").notNull().default(0),
    level: text("level").notNull().default(""),
    baseAmount: integer("base_amount").notNull().default(0),
    addOnAmount: integer("add_on_amount").notNull().default(0),
    discountAmount: integer("discount_amount").notNull().default(0),
    depositAmount: integer("deposit_amount").notNull().default(0),
    paymentAmount: integer("payment_amount").notNull().default(0),
    paymentCardAmount: integer("payment_card_amount").notNull().default(0),
    paymentCashAmount: integer("payment_cash_amount").notNull().default(0),
    paymentAccountAmount: integer("payment_account_amount").notNull().default(0),
    paymentStatus: text("payment_status").notNull().default("unpaid"),
    gameDate: text("game_date").notNull(),
    gameTime: text("game_time").notNull(),
    scheduledDate: text("scheduled_date").notNull().default(""),
    scheduledTime: text("scheduled_time").notNull().default(""),
    startedAt: text("started_at").notNull().default(""),
    endedAt: text("ended_at").notNull(),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("game_records_ended_at_idx").on(table.endedAt),
    index("game_records_date_room_idx").on(
      table.gameDate,
      table.roomCode,
      table.endedAt,
    ),
    index("game_records_reservation_idx").on(table.reservationId),
  ],
);

export const commands = sqliteTable(
  "commands",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    action: text("action").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    status: text("status").notNull().default("pending"),
    requestedBy: text("requested_by").notNull(),
    result: text("result").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    claimedAt: text("claimed_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("commands_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("commands_room_status_idx").on(table.roomId, table.status),
  ],
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id").notNull().unique(),
    mode: text("mode").notNull().default("single"),
    splitCount: integer("split_count").notNull().default(0),
    finalAmount: integer("final_amount").notNull().default(0),
    depositAmount: integer("deposit_amount").notNull().default(0),
    payableAmount: integer("payable_amount").notNull().default(0),
    status: text("status").notNull().default("PENDING"),
    fullCancelRequested: integer("full_cancel_requested").notNull().default(0),
    planRequestKey: text("plan_request_key"),
    requestedBy: text("requested_by").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("payments_plan_request_key_uidx").on(table.planRequestKey),
    index("payments_reservation_status_idx").on(
      table.reservationId,
      table.status,
    ),
  ],
);

export const paymentAttempts = sqliteTable(
  "payment_attempts",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id").notNull(),
    paymentId: text("payment_id"),
    memberCouponId: text("member_coupon_id"),
    splitIndex: integer("split_index").notNull().default(1),
    attemptType: text("attempt_type").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    amount: integer("amount").notNull(),
    saleAmount: integer("sale_amount").notNull().default(0),
    addOnAmount: integer("add_on_amount").notNull().default(0),
    discountAmount: integer("discount_amount").notNull().default(0),
    paymentMethod: text("payment_method").notNull().default("card"),
    status: text("status").notNull().default("PENDING"),
    responseCode: text("response_code").notNull().default(""),
    responseMessage: text("response_message").notNull().default(""),
    authNo: text("auth_no").notNull().default(""),
    authDate: text("auth_date").notNull().default(""),
    issuerName: text("issuer_name").notNull().default(""),
    acquirerName: text("acquirer_name").notNull().default(""),
    maskedCardNo: text("masked_card_no").notNull().default(""),
    rawReturnCode: integer("raw_return_code"),
    errorCode: text("error_code").notNull().default("NONE"),
    elapsedMs: integer("elapsed_ms").notNull().default(0),
    mposTransactionId: integer("mpos_transaction_id"),
    originalAttemptId: text("original_attempt_id"),
    originalMposTransactionId: integer("original_mpos_transaction_id"),
    commandId: text("command_id").unique(),
    requestKey: text("request_key"),
    activeKey: text("active_key").unique(),
    traceId: text("trace_id").notNull().default(""),
    transactionSource: text("transaction_source").notNull().default("POS_BRIDGE"),
    verificationStatus: text("verification_status").notNull().default("VERIFIED"),
    approvalTime: text("approval_time").notNull().default(""),
    terminalId: text("terminal_id").notNull().default(""),
    externalTransactionId: text("external_transaction_id").notNull().default(""),
    externalTransactionKey: text("external_transaction_key"),
    operatorNote: text("operator_note").notNull().default(""),
    requestedBy: text("requested_by").notNull(),
    requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("payment_attempts_reservation_idx").on(
      table.reservationId,
      table.requestedAt,
    ),
    index("payment_attempts_original_idx").on(
      table.originalAttemptId,
      table.status,
    ),
    index("payment_attempts_payment_split_idx").on(
      table.paymentId,
      table.splitIndex,
      table.requestedAt,
    ),
    uniqueIndex("payment_attempts_request_key_uidx").on(table.requestKey),
    index("payment_attempts_trace_idx").on(table.traceId, table.requestedAt),
    uniqueIndex("payment_attempts_external_key_uidx").on(table.externalTransactionKey),
    index("payment_attempts_source_idx").on(table.transactionSource, table.requestedAt),
  ],
);

export const paymentIntents = sqliteTable(
  "payment_intents",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id").notNull(),
    paymentId: text("payment_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    transactionUuid: text("transaction_uuid").notNull(),
    amount: integer("amount").notNull(),
    paymentMethod: text("payment_method").notNull().default("CARD"),
    requestKey: text("request_key").notNull().unique(),
    nonce: text("nonce").notNull().unique(),
    version: integer("version").notNull().default(1),
    signature: text("signature").notNull(),
    status: text("status").notNull().default("READY"),
    traceId: text("trace_id").notNull().default(""),
    requestedBy: text("requested_by").notNull().default(""),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    resultJson: text("result_json").notNull().default(""),
    localDurableAt: text("local_durable_at"),
    cloudSyncedAt: text("cloud_synced_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("payment_intents_attempt_status_idx").on(table.attemptId, table.status, table.createdAt),
    index("payment_intents_transaction_uuid_idx").on(table.transactionUuid, table.createdAt),
    index("payment_intents_status_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const paymentLatencyEvents = sqliteTable(
  "payment_latency_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    traceId: text("trace_id").notNull(),
    component: text("component").notNull(),
    stage: text("stage").notNull(),
    isoTimestamp: text("iso_timestamp").notNull(),
    elapsedMs: real("elapsed_ms").notNull().default(0),
    durationMs: real("duration_ms"),
    reservationId: text("reservation_id").notNull().default(""),
    paymentId: text("payment_id").notNull().default(""),
    attemptId: text("attempt_id").notNull().default(""),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("payment_latency_trace_stage_idx").on(table.traceId, table.id),
    index("payment_latency_created_idx").on(table.createdAt),
  ],
);

export const paymentTerminalState = sqliteTable("payment_terminal_state", {
  id: integer("id").primaryKey(),
  connected: integer("connected").notNull().default(0),
  paymentReady: integer("payment_ready").notNull().default(0),
  responseCode: text("response_code").notNull().default(""),
  responseMessage: text("response_message").notNull().default(""),
  model: text("model").notNull().default(""),
  firmware: text("firmware").notNull().default(""),
  integrity: text("integrity").notNull().default(""),
  rawReturnCode: integer("raw_return_code"),
  errorCode: text("error_code").notNull().default("DEVICE_OFFLINE"),
  elapsedMs: integer("elapsed_ms").notNull().default(0),
  checkedAt: text("checked_at").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    normalizedPhone: text("normalized_phone").notNull(),
    phoneLast4: text("phone_last4").notNull().default(""),
    birthday: text("birthday").notNull().default(""),
    teamName: text("team_name").notNull().default(""),
    email: text("email").notNull().default(""),
    vehicleNumber: text("vehicle_number").notNull().default(""),
    memo: text("memo").notNull().default(""),
    status: text("status").notNull().default("active"),
    mergedIntoId: text("merged_into_id"),
    createdBy: text("created_by").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("members_normalized_phone_uidx").on(table.normalizedPhone),
    index("members_name_idx").on(table.name),
    index("members_team_name_idx").on(table.teamName),
    index("members_phone_last4_idx").on(table.phoneLast4, table.updatedAt),
  ],
);

export const memberCredentials = sqliteTable("member_credentials", {
  memberId: text("member_id").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  passwordIterations: integer("password_iterations").notNull().default(210_000),
  termsVersion: text("terms_version").notNull(),
  termsAgreedAt: text("terms_agreed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  registeredAt: text("registered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastLoginAt: text("last_login_at"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const memberSessions = sqliteTable(
  "member_sessions",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("member_sessions_member_expires_idx").on(table.memberId, table.expiresAt),
  ],
);

export const memberAuthRateLimits = sqliteTable(
  "member_auth_rate_limits",
  {
    clientKey: text("client_key").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    windowStarted: integer("window_started").notNull().default(0),
    blockedUntil: integer("blocked_until").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("member_auth_rate_limits_blocked_idx").on(table.blockedUntil)],
);

export const paymentAllocations = sqliteTable(
  "payment_allocations",
  {
    paymentId: text("payment_id").notNull(),
    reservationId: text("reservation_id").notNull(),
    sequence: integer("sequence").notNull().default(1),
    finalAmount: integer("final_amount").notNull().default(0),
    depositAmount: integer("deposit_amount").notNull().default(0),
    payableAmount: integer("payable_amount").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("payment_allocations_payment_reservation_uidx").on(
      table.paymentId,
      table.reservationId,
    ),
    index("payment_allocations_reservation_idx").on(
      table.reservationId,
      table.paymentId,
    ),
  ],
);

export const memberCoupons = sqliteTable(
  "member_coupons",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id").notNull(),
    couponType: text("coupon_type").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    issuedAt: text("issued_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    usedReservationId: text("used_reservation_id"),
    usedPaymentAttemptId: text("used_payment_attempt_id"),
    source: text("source").notNull().default("ADMIN"),
    sourceReference: text("source_reference").notNull().unique(),
    issuedBy: text("issued_by").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("member_coupons_member_status_idx").on(
      table.memberId,
      table.status,
      table.expiresAt,
      table.issuedAt,
    ),
    index("member_coupons_used_reservation_idx").on(
      table.usedReservationId,
      table.usedAt,
    ),
  ],
);

export const reservations = sqliteTable(
  "reservations",
  {
    id: text("id").primaryKey(),
    bookingCode: text("booking_code").notNull(),
    source: text("source").notNull().default("web_walkin"),
    sourceBookingNo: text("source_booking_no"),
    sourceProduct: text("source_product").notNull().default(""),
    sourceStatus: text("source_status").notNull().default(""),
    sourceLink: text("source_link").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    customerPhone: text("customer_phone").notNull().default(""),
    memberId: text("member_id"),
    repeatGroupId: text("repeat_group_id").notNull().default(""),
    repeatSequence: integer("repeat_sequence").notNull().default(0),
    scheduledDate: text("scheduled_date").notNull().default(""),
    scheduledTime: text("scheduled_time").notNull().default(""),
    roomCode: text("room_code").notNull().default(""),
    activeSlotKey: text("active_slot_key"),
    scheduleOverridden: integer("schedule_overridden").notNull().default(0),
    detailsOverridden: integer("details_overridden").notNull().default(0),
    teamName: text("team_name").notNull().default(""),
    difficultyCode: text("difficulty_code").notNull().default(""),
    difficultyLabel: text("difficulty_label").notNull().default(""),
    mapIndex: integer("map_index").notNull().default(0),
    adultCount: integer("adult_count").notNull().default(0),
    youthCount: integer("youth_count").notNull().default(0),
    totalCount: integer("total_count").notNull().default(0),
    vehicleLast4: text("vehicle_last4").notNull().default(""),
    parkingRegistrationStatus: text("parking_registration_status").notNull().default(""),
    parkingRegistrationRequestId: text("parking_registration_request_id").notNull().default(""),
    parkingRegisteredVehicleLast4: text("parking_registered_vehicle_last4").notNull().default(""),
    parkingRegistrationCompletedAt: text("parking_registration_completed_at"),
    consentText: text("consent_text").notNull().default(""),
    gameMinutes: integer("game_minutes").notNull().default(16),
    baseAmount: integer("base_amount").notNull().default(0),
    addOnAmount: integer("add_on_amount").notNull().default(0),
    discountAmount: integer("discount_amount").notNull().default(0),
    paymentAmount: integer("payment_amount").notNull().default(0),
    paymentCardAmount: integer("payment_card_amount").notNull().default(0),
    paymentCashAmount: integer("payment_cash_amount").notNull().default(0),
    paymentAccountAmount: integer("payment_account_amount").notNull().default(0),
    paymentMethod: text("payment_method").notNull().default(""),
    paymentStatus: text("payment_status").notNull().default("unpaid"),
    status: text("status").notNull().default("booked"),
    cancelledAt: text("cancelled_at"),
    memo: text("memo").notNull().default(""),
    idempotencyKey: text("idempotency_key"),
    managerLoadedAt: text("manager_loaded_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("reservations_booking_code_uidx").on(table.bookingCode),
    uniqueIndex("reservations_source_booking_no_uidx").on(table.sourceBookingNo),
    uniqueIndex("reservations_active_slot_key_uidx").on(table.activeSlotKey),
    uniqueIndex("reservations_idempotency_key_uidx").on(table.idempotencyKey),
    index("reservations_schedule_idx").on(table.scheduledDate, table.scheduledTime),
    index("reservations_status_idx").on(table.status, table.updatedAt),
    index("reservations_member_idx").on(table.memberId, table.scheduledDate),
    index("reservations_repeat_group_idx").on(table.repeatGroupId, table.repeatSequence),
  ],
);

export const customerVisits = sqliteTable(
  "customer_visits",
  {
    id: text("id").primaryKey(),
    sessionTokenHash: text("session_token_hash").notNull().unique(),
    kioskId: text("kiosk_id").notNull().default(""),
    flowType: text("flow_type").notNull().default("WALK_IN"),
    status: text("status").notNull().default("DRAFT"),
    partyCount: integer("party_count").notNull().default(1),
    gameCount: integer("game_count").notNull().default(1),
    adultCount: integer("adult_count").notNull().default(0),
    youthCount: integer("youth_count").notNull().default(1),
    representativeMemberId: text("representative_member_id"),
    customerName: text("customer_name").notNull().default(""),
    customerPhone: text("customer_phone").notNull().default(""),
    teamName: text("team_name").notNull().default(""),
    scheduledDate: text("scheduled_date").notNull().default(""),
    scheduledTime: text("scheduled_time").notNull().default(""),
    roomCode: text("room_code").notNull().default(""),
    difficultyCode: text("difficulty_code").notNull().default(""),
    difficultyLabel: text("difficulty_label").notNull().default(""),
    mapIndex: integer("map_index").notNull().default(0),
    reservationId: text("reservation_id").unique(),
    holdId: text("hold_id"),
    addOnsJson: text("add_ons_json").notNull().default("{}"),
    settlementJson: text("settlement_json").notNull().default("{}"),
    stampAllocationsJson: text("stamp_allocations_json").notNull().default("[]"),
    baseAmount: integer("base_amount").notNull().default(0),
    addOnAmount: integer("add_on_amount").notNull().default(0),
    discountAmount: integer("discount_amount").notNull().default(0),
    finalAmount: integer("final_amount").notNull().default(0),
    startTokenHash: text("start_token_hash").notNull().default(""),
    startTokenValue: text("start_token_value").notNull().default(""),
    startTokenExpiresAt: text("start_token_expires_at"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    errorCode: text("error_code").notNull().default(""),
    errorMessage: text("error_message").notNull().default(""),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("customer_visits_status_updated_idx").on(table.status, table.updatedAt),
    index("customer_visits_room_status_idx").on(table.roomCode, table.status, table.updatedAt),
    index("customer_visits_reservation_idx").on(table.reservationId),
  ],
);

export const customerVisitMembers = sqliteTable(
  "customer_visit_members",
  {
    visitId: text("visit_id").notNull(),
    memberId: text("member_id").notNull(),
    memberName: text("member_name").notNull().default(""),
    role: text("role").notNull().default("PARTICIPANT"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("customer_visit_members_visit_member_uidx").on(table.visitId, table.memberId),
    index("customer_visit_members_member_idx").on(table.memberId, table.createdAt),
  ],
);

export const customerRoomHolds = sqliteTable(
  "customer_room_holds",
  {
    id: text("id").primaryKey(),
    visitId: text("visit_id").notNull().unique(),
    storeCode: text("store_code").notNull().default("HWASEONG_BYEONGJEOM"),
    scheduledDate: text("scheduled_date").notNull(),
    scheduledTime: text("scheduled_time").notNull(),
    roomCode: text("room_code").notNull(),
    state: text("state").notNull().default("ACTIVE"),
    activeSlotKey: text("active_slot_key").unique(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("customer_room_holds_schedule_idx").on(table.scheduledDate, table.scheduledTime, table.roomCode, table.state),
    index("customer_room_holds_expiry_idx").on(table.state, table.expiresAt),
  ],
);

export const customerVisitGames = sqliteTable(
  "customer_visit_games",
  {
    id: text("id").primaryKey(),
    visitId: text("visit_id").notNull(),
    sequence: integer("sequence").notNull(),
    status: text("status").notNull().default("HOLD"),
    scheduledDate: text("scheduled_date").notNull(),
    scheduledTime: text("scheduled_time").notNull(),
    roomCode: text("room_code").notNull(),
    roomSize: text("room_size").notNull(),
    difficultyCode: text("difficulty_code").notNull(),
    difficultyLabel: text("difficulty_label").notNull().default(""),
    mapIndex: integer("map_index").notNull().default(0),
    adultCount: integer("adult_count").notNull().default(0),
    youthCount: integer("youth_count").notNull().default(0),
    partyCount: integer("party_count").notNull().default(0),
    baseAmount: integer("base_amount").notNull().default(0),
    holdId: text("hold_id").notNull().default(""),
    activeSlotKey: text("active_slot_key").unique(),
    reservationId: text("reservation_id"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("customer_visit_games_visit_sequence_uidx").on(table.visitId, table.sequence),
    index("customer_visit_games_reservation_idx").on(table.reservationId),
    index("customer_visit_games_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const customerProductAvailability = sqliteTable("customer_product_availability", {
  productCode: text("product_code").primaryKey(),
  status: text("status").notNull().default("SALE"),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const customerProductOverrides = sqliteTable("customer_product_overrides", {
  productCode: text("product_code").primaryKey(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const kioskGuidanceItems = sqliteTable(
  "kiosk_guidance_items",
  {
    id: text("id").primaryKey(),
    placement: text("placement").notNull().default("BEFORE_GAME_START"),
    content: text("content").notNull(),
    title: text("title").notNull().default(""),
    summary: text("summary").notNull().default(""),
    agreementText: text("agreement_text").notNull().default(""),
    required: integer("required").notNull().default(0),
    version: integer("version").notNull().default(1),
    sortOrder: integer("sort_order").notNull().default(0),
    active: integer("active").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("kiosk_guidance_placement_order_idx").on(table.placement, table.sortOrder)],
);

export const customerStampAllocations = sqliteTable(
  "customer_stamp_allocations",
  {
    id: text("id").primaryKey(),
    visitId: text("visit_id").notNull(),
    memberId: text("member_id").notNull(),
    quantity: integer("quantity").notNull().default(1),
    status: text("status").notNull().default("PENDING"),
    referenceKey: text("reference_key").notNull().unique(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("customer_stamp_allocations_visit_idx").on(table.visitId, table.status)],
);

export const reservationEvents = sqliteTable(
  "reservation_events",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id").notNull(),
    eventType: text("event_type").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    createdBy: text("created_by").notNull().default("system"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("reservation_events_reservation_idx").on(table.reservationId, table.createdAt)],
);

export const reservationRateLimits = sqliteTable("reservation_rate_limits", {
  clientKey: text("client_key").primaryKey(),
  requestCount: integer("request_count").notNull().default(0),
  windowStarted: integer("window_started").notNull().default(0),
  updatedAt: integer("updated_at").notNull().default(0),
});

export const dailySharedSales = sqliteTable("daily_shared_sales", {
  salesDate: text("sales_date").primaryKey(),
  slushCard: integer("slush_card").notNull().default(0),
  slushCash: integer("slush_cash").notNull().default(0),
  slushAccount: integer("slush_account").notNull().default(0),
  beverageCard: integer("beverage_card").notNull().default(0),
  beverageCash: integer("beverage_cash").notNull().default(0),
  beverageAccount: integer("beverage_account").notNull().default(0),
  slushCardCount: integer("slush_card_count").notNull().default(0),
  slushCashCount: integer("slush_cash_count").notNull().default(0),
  slushAccountCount: integer("slush_account_count").notNull().default(0),
  beverageCardCount: integer("beverage_card_count").notNull().default(0),
  beverageCashCount: integer("beverage_cash_count").notNull().default(0),
  beverageAccountCount: integer("beverage_account_count").notNull().default(0),
  otherCardCount: integer("other_card_count").notNull().default(0),
  otherCashCount: integer("other_cash_count").notNull().default(0),
  otherAccountCount: integer("other_account_count").notNull().default(0),
  youthPass10CardCount: integer("youth_pass_10_card_count").notNull().default(0),
  youthPass10CashCount: integer("youth_pass_10_cash_count").notNull().default(0),
  youthPass10AccountCount: integer("youth_pass_10_account_count").notNull().default(0),
  youthPass20CardCount: integer("youth_pass_20_card_count").notNull().default(0),
  youthPass20CashCount: integer("youth_pass_20_cash_count").notNull().default(0),
  youthPass20AccountCount: integer("youth_pass_20_account_count").notNull().default(0),
  adultPass10CardCount: integer("adult_pass_10_card_count").notNull().default(0),
  adultPass10CashCount: integer("adult_pass_10_cash_count").notNull().default(0),
  adultPass10AccountCount: integer("adult_pass_10_account_count").notNull().default(0),
  adultPass20CardCount: integer("adult_pass_20_card_count").notNull().default(0),
  adultPass20CashCount: integer("adult_pass_20_cash_count").notNull().default(0),
  adultPass20AccountCount: integer("adult_pass_20_account_count").notNull().default(0),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const addOnSaleOrders = sqliteTable(
  "add_on_sale_orders",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id").notNull().unique(),
    salesDate: text("sales_date").notNull(),
    itemSummary: text("item_summary").notNull().default(""),
    slushCount: integer("slush_count").notNull().default(0),
    beverageCount: integer("beverage_count").notNull().default(0),
    otherCount: integer("other_count").notNull().default(0),
    slushUnitPrice: integer("slush_unit_price").notNull().default(0),
    beverageUnitPrice: integer("beverage_unit_price").notNull().default(0),
    otherUnitPrice: integer("other_unit_price").notNull().default(0),
    itemsJson: text("items_json").notNull().default("[]"),
    amount: integer("amount").notNull().default(0),
    status: text("status").notNull().default("PAYMENT_PENDING"),
    paymentStatus: text("payment_status").notNull().default("PENDING"),
    paymentId: text("payment_id"),
    paymentCardAmount: integer("payment_card_amount").notNull().default(0),
    paymentCashAmount: integer("payment_cash_amount").notNull().default(0),
    paymentAccountAmount: integer("payment_account_amount").notNull().default(0),
    requestedBy: text("requested_by").notNull().default(""),
    paidAt: text("paid_at"),
    cancelledAt: text("cancelled_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("add_on_sale_orders_date_status_idx").on(
      table.salesDate,
      table.status,
      table.createdAt,
    ),
  ],
);

export const pricingSettings = sqliteTable("pricing_settings", {
  id: integer("id").primaryKey(),
  adultPrice: integer("adult_price").notNull().default(7_000),
  youthPrice: integer("youth_price").notNull().default(5_000),
  naverDepositAmount: integer("naver_deposit_amount").notNull().default(5_000),
  naverCancellationFeeAmount: integer("naver_cancellation_fee_amount").notNull().default(5_000),
  slushPrice: integer("slush_price").notNull().default(1_500),
  beveragePrice: integer("beverage_price").notNull().default(1_000),
  otherPrice: integer("other_price").notNull().default(1_000),
  youthPass10Price: integer("youth_pass_10_price").notNull().default(45_000),
  youthPass20Price: integer("youth_pass_20_price").notNull().default(80_000),
  adultPass10Price: integer("adult_pass_10_price").notNull().default(60_000),
  adultPass20Price: integer("adult_pass_20_price").notNull().default(110_000),
  extraAddOnItemsJson: text("extra_add_on_items_json").notNull().default("[]"),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const kioskParkingSettings = sqliteTable("kiosk_parking_settings", {
  id: integer("id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  autoRegistrationEnabled: integer("auto_registration_enabled").notNull().default(0),
  registrationUrl: text("registration_url").notNull(),
  sessionMaxSeconds: integer("session_max_seconds").notNull().default(30),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const parkingDiscountRequests = sqliteTable(
  "parking_discount_requests",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    reservationId: text("reservation_id").notNull().default(""),
    triggerMode: text("trigger_mode").notNull().default("manual"),
    carLast4: text("car_last4").notNull(),
    status: text("status").notNull().default("PENDING"),
    matchCount: integer("match_count").notNull().default(0),
    resultsJson: text("results_json").notNull().default("[]"),
    errorCode: text("error_code").notNull().default(""),
    errorMessage: text("error_message").notNull().default(""),
    dryRun: integer("dry_run").notNull().default(0),
    requestedBy: text("requested_by").notNull(),
    commandId: text("command_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    claimedAt: text("claimed_at"),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("parking_discount_requests_idempotency_idx").on(table.idempotencyKey),
    uniqueIndex("parking_discount_requests_command_idx").on(table.commandId),
    index("parking_discount_requests_status_created_idx").on(table.status, table.createdAt),
    index("parking_discount_requests_reservation_idx").on(table.reservationId, table.createdAt),
  ],
);

export const parkingSettingAudit = sqliteTable("parking_setting_audit", {
  id: text("id").primaryKey(),
  settingKey: text("setting_key").notNull(),
  previousValue: text("previous_value").notNull(),
  nextValue: text("next_value").notNull(),
  changedBy: text("changed_by").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const naverStockManagedSlots = sqliteTable(
  "naver_stock_managed_slots",
  {
    slotKey: text("slot_key").primaryKey(),
    roomCode: text("room_code").notNull(),
    scheduledDate: text("scheduled_date").notNull(),
    scheduledTime: text("scheduled_time").notNull(),
    bizItemId: integer("biz_item_id").notNull(),
    originalStock: integer("original_stock").notNull().default(1),
    managedAt: text("managed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("naver_stock_managed_schedule_idx").on(
      table.scheduledDate,
      table.scheduledTime,
    ),
  ],
);

export const pushNotificationSettings = sqliteTable("push_notification_settings", {
  id: integer("id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  deliveryTime: text("delivery_time").notNull().default("21:30"),
  weekdaysJson: text("weekdays_json").notNull().default("[0,1,2,3,4,5,6]"),
  lastSentDate: text("last_sent_date").notNull().default(""),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const pushNotificationSchedules = sqliteTable(
  "push_notification_schedules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().default("매출 브리핑"),
    enabled: integer("enabled").notNull().default(1),
    deliveryTime: text("delivery_time").notNull().default("21:30"),
    weekdaysJson: text("weekdays_json").notNull().default("[0,1,2,3,4,5,6]"),
    lastSentDate: text("last_sent_date").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    updatedBy: text("updated_by").notNull().default(""),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("push_notification_schedules_due_idx").on(
      table.enabled,
      table.deliveryTime,
      table.sortOrder,
    ),
  ],
);

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull().default(""),
    auth: text("auth").notNull().default(""),
    deviceName: text("device_name").notNull().default(""),
    deviceTokenHash: text("device_token_hash").notNull(),
    enabled: integer("enabled").notNull().default(1),
    lastSuccessAt: text("last_success_at"),
    lastError: text("last_error").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_uidx").on(table.endpoint),
    uniqueIndex("push_subscriptions_token_uidx").on(table.deviceTokenHash),
    index("push_subscriptions_enabled_idx").on(table.enabled, table.updatedAt),
  ],
);

export const pushDispatchLog = sqliteTable(
  "push_dispatch_log",
  {
    id: text("id").primaryKey(),
    briefingDate: text("briefing_date").notNull(),
    dispatchType: text("dispatch_type").notNull().default("scheduled"),
    recipientCount: integer("recipient_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    summaryJson: text("summary_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("push_dispatch_log_date_idx").on(table.briefingDate, table.createdAt)],
);

export const kioskGuidanceAgreements = sqliteTable(
  "kiosk_guidance_agreements",
  {
    id: text("id").primaryKey(),
    visitId: text("visit_id").notNull(),
    guidanceId: text("guidance_id").notNull(),
    guidanceVersion: integer("guidance_version").notNull(),
    agreed: integer("agreed").notNull().default(1),
    agreedAt: text("agreed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("kiosk_guidance_agreements_visit_guidance_version_uidx").on(
      table.visitId,
      table.guidanceId,
      table.guidanceVersion,
    ),
    index("kiosk_guidance_agreements_visit_idx").on(table.visitId, table.agreedAt),
  ],
);

export const kioskRoomRecommendationRules = sqliteTable(
  "kiosk_room_recommendation_rules",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().default(""),
    adultMin: integer("adult_min").notNull().default(0),
    adultMax: integer("adult_max").notNull().default(10),
    youthMin: integer("youth_min").notNull().default(0),
    youthMax: integer("youth_max").notNull().default(10),
    totalMin: integer("total_min").notNull().default(1),
    totalMax: integer("total_max").notNull().default(10),
    primarySize: text("primary_size").notNull(),
    secondarySize: text("secondary_size").notNull().default(""),
    active: integer("active").notNull().default(1),
    priority: integer("priority").notNull().default(100),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("kiosk_room_recommendation_active_priority_idx").on(
      table.active,
      table.priority,
      table.totalMin,
      table.totalMax,
    ),
  ],
);

export const kioskDisplaySettings = sqliteTable("kiosk_display_settings", {
  id: text("id").primaryKey(),
  homeTitle: text("home_title").notNull().default("오늘도 신나게 뛰어볼까요?"),
  homeSubtitle: text("home_subtitle").notNull().default("예약 확인 또는 현장 이용을 선택해주세요."),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const kioskVisitAdminAudit = sqliteTable(
  "kiosk_visit_admin_audit",
  {
    id: text("id").primaryKey(),
    visitId: text("visit_id").notNull(),
    reservationId: text("reservation_id").notNull().default(""),
    action: text("action").notNull(),
    previousStatus: text("previous_status").notNull().default(""),
    nextStatus: text("next_status").notNull().default(""),
    reason: text("reason").notNull().default(""),
    detailsJson: text("details_json").notNull().default("{}"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("kiosk_visit_admin_audit_visit_created_idx").on(table.visitId, table.createdAt),
    index("kiosk_visit_admin_audit_action_created_idx").on(table.action, table.createdAt),
  ],
);

export const kioskRuntime = sqliteTable("kiosk_runtime", {
  kioskId: text("kiosk_id").primaryKey(),
  currentVisitId: text("current_visit_id").notNull().default(""),
  currentStatus: text("current_status").notNull().default("HOME"),
  lastSeen: text("last_seen").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const kioskPaymentSettings = sqliteTable("kiosk_payment_settings", {
  id: integer("id").primaryKey(),
  operationMode: text("operation_mode").notNull().default("STAFFED"),
  cardEnabled: integer("card_enabled").notNull().default(1),
  cashEnabled: integer("cash_enabled").notNull().default(1),
  bankTransferEnabled: integer("bank_transfer_enabled").notNull().default(0),
  passEnabled: integer("pass_enabled").notNull().default(1),
  couponEnabled: integer("coupon_enabled").notNull().default(1),
  bankName: text("bank_name").notNull().default(""),
  customBankName: text("custom_bank_name").notNull().default(""),
  accountNumber: text("account_number").notNull().default(""),
  accountHolder: text("account_holder").notNull().default(""),
  guideText: text("guide_text").notNull().default(""),
  depositorGuide: text("depositor_guide").notNull().default(""),
  confirmationMode: text("confirmation_mode").notNull().default("STAFF_CONFIRM"),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const kioskBankTransferSessions = sqliteTable(
  "kiosk_bank_transfer_sessions",
  {
    token: text("token").primaryKey(),
    visitId: text("visit_id").notNull(),
    reservationId: text("reservation_id").notNull(),
    paymentId: text("payment_id").notNull(),
    transactionId: text("transaction_id").notNull().unique(),
    amount: integer("amount").notNull(),
    bankNameAtPayment: text("bank_name_at_payment").notNull(),
    accountNumberAtPayment: text("account_number_at_payment").notNull(),
    accountHolderAtPayment: text("account_holder_at_payment").notNull(),
    guideTextAtPayment: text("guide_text_at_payment").notNull().default(""),
    depositorGuideAtPayment: text("depositor_guide_at_payment").notNull().default(""),
    confirmationMode: text("confirmation_mode").notNull().default("STAFF_CONFIRM"),
    status: text("status").notNull().default("ACTIVE"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("kiosk_bank_transfer_sessions_visit_idx").on(table.visitId, table.status, table.updatedAt),
    index("kiosk_bank_transfer_sessions_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const pushOperationalSettings = sqliteTable("push_operational_settings", {
  eventType: text("event_type").primaryKey(),
  enabled: integer("enabled").notNull().default(1),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const pushOperationalEvents = sqliteTable(
  "push_operational_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    dedupKey: text("dedup_key").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    targetUrl: text("target_url").notNull().default("/admin/remote"),
    tag: text("tag").notNull().default("jumping-battle-operation"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("push_operational_events_dedup_uidx").on(table.dedupKey),
    index("push_operational_events_created_idx").on(table.createdAt),
  ],
);

export const pushOperationalDeliveries = sqliteTable(
  "push_operational_deliveries",
  {
    eventId: text("event_id").notNull(),
    deviceId: text("device_id").notNull(),
    deliveredAt: text("delivered_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("push_operational_deliveries_uidx").on(table.eventId, table.deviceId)],
);
