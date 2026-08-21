export type PassCreditAgeGroup = "youth" | "adult" | string;

export type PassCreditCandidate = {
  id: string;
  adultCount: number;
  youthCount: number;
  totalCount: number;
  paidGameAmount: number;
};

export type PassCreditAllocation = {
  reservationId: string;
  uses: number;
  amount: number;
};

function nonNegativeInteger(value: unknown) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function passCreditPeople(candidate: PassCreditCandidate, ageGroup: PassCreditAgeGroup) {
  const adultCount = nonNegativeInteger(candidate.adultCount);
  const youthCount = nonNegativeInteger(candidate.youthCount);
  if (ageGroup === "youth") return youthCount || (adultCount === 0 ? nonNegativeInteger(candidate.totalCount) : 0);
  if (ageGroup === "adult") return adultCount || (youthCount === 0 ? nonNegativeInteger(candidate.totalCount) : 0);
  return nonNegativeInteger(candidate.totalCount);
}

export function maxPassCreditUses(
  candidates: PassCreditCandidate[],
  ageGroup: PassCreditAgeGroup,
  regularUnitPrice: number,
) {
  const unitPrice = nonNegativeInteger(regularUnitPrice);
  if (unitPrice < 1) return 0;
  return candidates.reduce((total, candidate) => total + Math.min(
    passCreditPeople(candidate, ageGroup),
    Math.floor(nonNegativeInteger(candidate.paidGameAmount) / unitPrice),
  ), 0);
}

export function buildPassCreditPlan(input: {
  candidates: PassCreditCandidate[];
  ageGroup: PassCreditAgeGroup;
  regularUnitPrice: number;
  requestedUses: number;
  productUses: number;
}) {
  const unitPrice = nonNegativeInteger(input.regularUnitPrice);
  const productUses = nonNegativeInteger(input.productUses);
  const availableUses = Math.min(
    productUses,
    maxPassCreditUses(input.candidates, input.ageGroup, unitPrice),
  );
  const requestedUses = Math.min(
    availableUses,
    Math.max(1, nonNegativeInteger(input.requestedUses)),
  );
  let remaining = requestedUses;
  const allocations: PassCreditAllocation[] = [];
  for (const candidate of input.candidates) {
    if (remaining < 1) break;
    const uses = Math.min(
      remaining,
      passCreditPeople(candidate, input.ageGroup),
      unitPrice > 0 ? Math.floor(nonNegativeInteger(candidate.paidGameAmount) / unitPrice) : 0,
    );
    if (uses < 1) continue;
    allocations.push({ reservationId: candidate.id, uses, amount: uses * unitPrice });
    remaining -= uses;
  }
  return {
    availableUses,
    usedUses: requestedUses - remaining,
    creditAmount: allocations.reduce((total, item) => total + item.amount, 0),
    allocations,
  };
}
