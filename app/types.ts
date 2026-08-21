export type RoomStatus = "offline" | "waiting" | "running" | "error";

export type Room = {
  roomId: string;
  name: string;
  size: string;
  status: RoomStatus;
  teamName: string;
  mapName: string;
  mapIndex: number;
  mapOptions: string[];
  people: number;
  remainingSeconds: number;
  gameStartedAt: string;
  score: number;
  level: string;
  updatedAt: string;
};

export type RecentCommand = {
  id: string;
  roomId: string;
  action: string;
  status: string;
  result: string;
  createdAt: string;
};

export type StatusResponse = {
  generatedAt: string;
  store: {
    name: string;
    agentOnline: boolean;
    lastSeen: string | null;
    agentVersion: string | null;
    controlArmed: boolean;
    managerVisible: boolean;
    simulate: boolean;
    controlState: "IDLE" | "BUSY" | "ERROR" | "DEGRADED";
    currentControlAction: string;
    controlStartedAt: string | null;
    lastControlSuccessAt: string | null;
    lastControlError: string;
    stateStale: boolean;
  };
  rooms: Room[];
  recentCommands: RecentCommand[];
};

export type ControlAction = "set_info" | "start" | "stop" | "all_stop";

export type ControlPayload = {
  roomId: string;
  action: ControlAction;
  teamName?: string;
  mapIndex?: number;
  people?: number;
  skipPeople?: boolean;
  durationMinutes?: number;
};

export type PaymentStatus =
  | "PENDING"
  | "PROCESSING"
  | "APPROVED"
  | "COMPLETED"
  | "DECLINED"
  | "USER_CANCELLED"
  | "CANCELLED"
  | "UNKNOWN"
  | "BUSY"
  | "ERROR"
  | "UNLINKED";

export type PaymentAttempt = {
  id: string;
  transactionUuid: string;
  reservationId: string;
  paymentId: string | null;
  memberCouponId: string | null;
  splitIndex: number;
  attemptType: "PAY" | "CANCEL";
  attemptNumber: number;
  amount: number;
  saleAmount: number;
  addOnAmount: number;
  discountAmount: number;
  paymentMethod: string;
  status: PaymentStatus;
  responseCode: string;
  responseMessage: string;
  authNo: string;
  authDate: string;
  issuerName: string;
  acquirerName: string;
  maskedCardNo: string;
  rawReturnCode: number | null;
  errorCode: string;
  elapsedMs: number;
  mposTransactionId: number | null;
  originalAttemptId: string | null;
  originalMposTransactionId: number | null;
  commandId: string | null;
  activeKey: string | null;
  traceId: string;
  transactionSource: string;
  verificationStatus: string;
  approvalTime: string;
  terminalId: string;
  externalTransactionId: string;
  operatorNote: string;
  requestedAt: string;
  completedAt: string | null;
  updatedAt: string;
};

export type SignedPaymentIntent = {
  version: 1;
  intent_id: string;
  reservation_id: string;
  payment_id: string;
  attempt_id: string;
  transaction_uuid: string;
  amount: number;
  payment_method: "CARD";
  issued_at: string;
  expires_at: string;
  nonce: string;
  trace_id: string;
  signature: string;
};

export type PaymentOverview = {
  explicitExecutionV2Enabled?: boolean;
  paymentTransport?: "CLOUD_FAST_LANE" | "LOCAL_DIRECT";
  localDirectEnabled?: boolean;
  localBridgeUrl?: string;
  terminal: {
    connected: boolean;
    paymentReady: boolean;
    responseCode: string;
    responseMessage: string;
    model: string;
    firmware: string;
    integrity: string;
    rawReturnCode: number | null;
    errorCode: string;
    elapsedMs: number;
    checkedAt: string;
    updatedAt: string;
  };
  payment: {
    id: string;
    reservationId: string;
    mode: string;
    splitCount: number;
    finalAmount: number;
    depositAmount: number;
    payableAmount: number;
    status:
      | "PENDING"
      | "PARTIALLY_PAID"
      | "PAID"
      | "PARTIALLY_CANCELLED"
      | "CANCELLED"
      | "UNKNOWN"
      | "ERROR";
    fullCancelRequested: boolean;
    createdAt: string;
    updatedAt: string;
  } | null;
  summary: {
    finalAmount: number;
    depositAmount: number;
    payableAmount: number;
    approvedAmount: number;
    completedAmount: number;
    splitApprovedAmount: number;
    remainingAmount: number;
    approvedByMethod: Record<string, number>;
    hasUnknown: boolean;
    hasBusy: boolean;
    amountLocked: boolean;
    paymentStatus:
      | "PENDING"
      | "PARTIALLY_PAID"
      | "PAID"
      | "PARTIALLY_CANCELLED"
      | "CANCELLED"
      | "UNKNOWN"
      | "ERROR";
    currentSplitIndex: number | null;
    orderStatus:
      | "PENDING"
      | "PARTIALLY_PAID"
      | "PAID"
      | "PARTIALLY_CANCELLED"
      | "CANCELLED"
      | "UNKNOWN"
      | "ERROR";
  } | null;
  plan: PaymentAttempt[];
  attempts: PaymentAttempt[];
  group: {
    id: string;
    isPaymentGroup: boolean;
    eligible: boolean;
    anchorReservationId: string;
    totalFinalAmount: number;
    totalDepositAmount: number;
    totalPayableAmount: number;
    items: Array<{
      reservationId: string;
      bookingCode: string;
      teamName: string;
      scheduledDate: string;
      scheduledTime: string;
      roomCode: string;
      adultCount: number;
      youthCount: number;
      totalCount: number;
      status: string;
      paymentStatus: string;
      sequence: number;
      finalAmount: number;
      depositAmount: number;
      payableAmount: number;
    }>;
  } | null;
  terminalImport: {
    automaticLookup: boolean;
    recentLookup: boolean;
    approvalNumberLookup: boolean;
    callback: boolean;
    manualRegistration: boolean;
    reason: string;
  };
};
