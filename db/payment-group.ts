import type { PaymentMethod, PaymentWholeStatus } from "./payment-ledger";

export type GroupPaymentAllocation = {
  reservationId: string;
  finalAmount: number;
  payableAmount: number;
};

export type CompletedPaymentFlow = {
  method: PaymentMethod;
  amount: number;
};

export type GroupReservationPaymentSummary = {
  reservationId: string;
  finalAmount: number;
  cardAmount: number;
  cashAmount: number;
  accountAmount: number;
  paymentMethod: string;
  paymentStatus: string;
};

export function allocateGroupPaymentMethods(input: {
  allocations: GroupPaymentAllocation[];
  completedPayments: CompletedPaymentFlow[];
  wholeStatus: PaymentWholeStatus;
}): GroupReservationPaymentSummary[] {
  const flows = input.completedPayments
    .map((item) => ({ ...item, amount: Math.max(0, Math.trunc(item.amount)) }))
    .filter((item) => item.amount > 0);
  let paymentCursor = 0;

  return input.allocations.map((allocation) => {
    let needed = Math.max(0, Math.trunc(allocation.payableAmount));
    const byMethod: Record<PaymentMethod, number> = {
      card: 0,
      cash: 0,
      account: 0,
      coupon: 0,
    };

    while (needed > 0 && paymentCursor < flows.length) {
      const current = flows[paymentCursor];
      const applied = Math.min(needed, current.amount);
      byMethod[current.method] += applied;
      needed -= applied;
      current.amount -= applied;
      if (current.amount === 0) paymentCursor += 1;
    }

    const completedAmount = Math.max(0, Math.trunc(allocation.payableAmount) - needed);
    const methods = (Object.keys(byMethod) as PaymentMethod[])
      .filter((method) => byMethod[method] > 0);
    const paymentMethod = methods.length > 1 ? "mixed" : methods[0] ?? "";
    const paymentStatus = input.wholeStatus === "CANCELLED"
      ? "cancelled"
      : input.wholeStatus === "UNKNOWN"
        ? "unknown"
        : needed === 0
          ? "paid"
          : completedAmount > 0
            ? "partially_paid"
            : "unpaid";

    return {
      reservationId: allocation.reservationId,
      finalAmount: Math.max(0, Math.trunc(allocation.finalAmount)),
      cardAmount: byMethod.card,
      cashAmount: byMethod.cash,
      accountAmount: byMethod.account,
      paymentMethod,
      paymentStatus,
    };
  });
}
