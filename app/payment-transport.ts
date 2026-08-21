export type PaymentTransportDecision =
  | "LOCAL_DIRECT"
  | "CLOUD_FAST_LANE"
  | "WAIT"
  | "UNKNOWN";

export function decidePaymentTransport(input: {
  localDirectEnabled: boolean;
  browserLocalRequestPossible: boolean;
  localHealthHealthy: boolean;
  consecutiveHealthFailures: number;
  localRequestSent: boolean;
  responseKnown: boolean;
}): PaymentTransportDecision {
  if (input.localRequestSent) {
    return input.responseKnown ? "LOCAL_DIRECT" : "UNKNOWN";
  }
  if (!input.localDirectEnabled || !input.browserLocalRequestPossible) {
    return "CLOUD_FAST_LANE";
  }
  if (input.localHealthHealthy) return "LOCAL_DIRECT";
  if (input.consecutiveHealthFailures >= 3) return "CLOUD_FAST_LANE";
  return "WAIT";
}
