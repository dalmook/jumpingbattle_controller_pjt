export type PassUseQuoteInput = {
  baseAmount: number;
  addOnAmount: number;
  discountAmount: number;
  regularUnitPrice: number;
  uses: number;
};

function safeAmount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function quotePassUse(input: PassUseQuoteInput) {
  const baseAmount = safeAmount(input.baseAmount);
  const addOnAmount = safeAmount(input.addOnAmount);
  const currentDiscount = Math.min(baseAmount, safeAmount(input.discountAmount));
  const uses = Math.max(1, Math.trunc(input.uses) || 1);
  const requestedDiscount = safeAmount(input.regularUnitPrice) * uses;
  const appliedDiscount = Math.min(
    Math.max(0, baseAmount - currentDiscount),
    requestedDiscount,
  );
  const nextDiscountAmount = currentDiscount + appliedDiscount;
  return {
    uses,
    appliedDiscount,
    nextDiscountAmount,
    paymentAmount: Math.max(0, baseAmount + addOnAmount - nextDiscountAmount),
  };
}
