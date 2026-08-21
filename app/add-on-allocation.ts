export type PhysicalPaymentAmounts = {
  card: number;
  cash: number;
  account: number;
};

function safeAmount(value: unknown) {
  const amount = Math.trunc(Number(value));
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

export function allocateAddOnPaymentMethods(
  addOnAmount: number,
  completedByMethod: Record<string, number>,
): PhysicalPaymentAmounts {
  const methodValues: PhysicalPaymentAmounts = {
    card: safeAmount(completedByMethod.card),
    cash: safeAmount(completedByMethod.cash),
    account: safeAmount(completedByMethod.account),
  };
  const physicalTotal = methodValues.card + methodValues.cash + methodValues.account;
  const recognized = Math.min(safeAmount(addOnAmount), physicalTotal);
  const allocation: PhysicalPaymentAmounts = { card: 0, cash: 0, account: 0 };
  const methods = (["card", "cash", "account"] as const)
    .filter((method) => methodValues[method] > 0);
  let allocated = 0;
  methods.forEach((method, index) => {
    const value = index === methods.length - 1
      ? recognized - allocated
      : Math.floor(recognized * methodValues[method] / Math.max(1, physicalTotal));
    allocation[method] = Math.max(0, value);
    allocated += allocation[method];
  });
  return allocation;
}
