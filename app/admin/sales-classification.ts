export type ReservationSalesInput = {
  source: string;
  base_amount: number;
  add_on_amount: number;
  discount_amount: number;
  payment_amount: number;
  payment_card_amount: number;
  payment_cash_amount: number;
  payment_account_amount: number;
  payment_coupon_amount?: number;
  payment_method: string;
  payment_status: string;
  same_day_naver_cancel: number;
  linked_add_on_amount?: number;
  linked_add_on_card_amount?: number;
  linked_add_on_cash_amount?: number;
  linked_add_on_account_amount?: number;
};

export type SharedSalesInput = {
  slush_card: number;
  slush_cash: number;
  slush_account: number;
  beverage_card: number;
  beverage_cash: number;
  beverage_account: number;
  slush_card_count: number;
  slush_cash_count: number;
  slush_account_count: number;
  beverage_card_count: number;
  beverage_cash_count: number;
  beverage_account_count: number;
  other_card_count: number;
  other_cash_count: number;
  other_account_count: number;
  youth_pass_10_card_count: number;
  youth_pass_10_cash_count: number;
  youth_pass_10_account_count: number;
  youth_pass_20_card_count: number;
  youth_pass_20_cash_count: number;
  youth_pass_20_account_count: number;
  adult_pass_10_card_count: number;
  adult_pass_10_cash_count: number;
  adult_pass_10_account_count: number;
  adult_pass_20_card_count: number;
  adult_pass_20_cash_count: number;
  adult_pass_20_account_count: number;
};

export function unclassifiedReservationPaymentAmount(input: {
  paymentAmount: number;
  depositAmount: number;
  cardAmount: number;
  cashAmount: number;
  accountAmount: number;
  couponAmount: number;
}) {
  return Math.max(
    0,
    (Number(input.paymentAmount) || 0) -
      (Number(input.depositAmount) || 0) -
      (Number(input.cardAmount) || 0) -
      (Number(input.cashAmount) || 0) -
      (Number(input.accountAmount) || 0) -
      (Number(input.couponAmount) || 0),
  );
}

export function classifyReservationSales(
  row: ReservationSalesInput,
  cancellationFeeAmount: number,
  naverDepositAmount = DEFAULT_PRICING_SETTINGS.naverDepositAmount,
) {
  if (row.same_day_naver_cancel === 1) {
    return {
      expected: cancellationFeeAmount,
      gameDeposit: cancellationFeeAmount,
      gameCard: 0,
      gameCash: 0,
      gameAccount: 0,
      gameUnclassified: 0,
      gameRevenue: cancellationFeeAmount,
      cancellationFee: cancellationFeeAmount,
    };
  }

  const linkedAddOnAmount = Math.max(0, Number(row.linked_add_on_amount) || 0);
  const linkedAddOnCard = Math.max(0, Number(row.linked_add_on_card_amount) || 0);
  const linkedAddOnCash = Math.max(0, Number(row.linked_add_on_cash_amount) || 0);
  const linkedAddOnAccount = Math.max(0, Number(row.linked_add_on_account_amount) || 0);
  const expected = Math.max(
    0,
    row.base_amount + row.add_on_amount - row.discount_amount - linkedAddOnAmount,
  );
  const gameDeposit = row.source === "naver"
    ? Math.min(naverDepositAmount, expected)
    : 0;
  let gameCard = 0;
  let gameCash = 0;
  let gameAccount = 0;
  let gameUnclassified = 0;

  if (row.payment_status === "paid") {
    gameCard = Math.max(0, row.payment_card_amount - linkedAddOnCard);
    gameCash = Math.max(0, row.payment_cash_amount - linkedAddOnCash);
    gameAccount = Math.max(0, row.payment_account_amount - linkedAddOnAccount);
    const explicitCoupon = Math.max(0, Number(row.payment_coupon_amount) || 0);
    const couponAmount = explicitCoupon || (row.payment_method === "coupon"
      ? Math.max(0, row.payment_amount - linkedAddOnAmount - gameDeposit)
      : 0);
    const residual = Math.max(
      0,
      row.payment_amount - linkedAddOnAmount - couponAmount - gameDeposit - gameCard - gameCash - gameAccount,
    );
    if (row.payment_method === "card") gameCard += residual;
    else if (row.payment_method === "cash") gameCash += residual;
    else if (row.payment_method === "account") gameAccount += residual;
    else if (row.payment_method !== "coupon") gameUnclassified = residual;
  }

  return {
    expected,
    gameDeposit,
    gameCard,
    gameCash,
    gameAccount,
    gameUnclassified,
    gameRevenue:
      gameDeposit + gameCard + gameCash + gameAccount + gameUnclassified,
    cancellationFee: 0,
  };
}

export function classifySharedSales(
  row: SharedSalesInput,
  pricing: PricingSettings = DEFAULT_PRICING_SETTINGS,
) {
  const slushCard = row.slush_card + row.slush_card_count * pricing.slushPrice;
  const slushCash = row.slush_cash + row.slush_cash_count * pricing.slushPrice;
  const slushAccount = row.slush_account + row.slush_account_count * pricing.slushPrice;
  const beverageCard = row.beverage_card + row.beverage_card_count * pricing.beveragePrice;
  const beverageCash = row.beverage_cash + row.beverage_cash_count * pricing.beveragePrice;
  const beverageAccount = row.beverage_account + row.beverage_account_count * pricing.beveragePrice;
  const otherCard = row.other_card_count * pricing.otherPrice;
  const otherCash = row.other_cash_count * pricing.otherPrice;
  const otherAccount = row.other_account_count * pricing.otherPrice;
  const gameCard =
    row.youth_pass_10_card_count * pricing.youthPass10Price +
    row.youth_pass_20_card_count * pricing.youthPass20Price +
    row.adult_pass_10_card_count * pricing.adultPass10Price +
    row.adult_pass_20_card_count * pricing.adultPass20Price;
  const gameCash =
    row.youth_pass_10_cash_count * pricing.youthPass10Price +
    row.youth_pass_20_cash_count * pricing.youthPass20Price +
    row.adult_pass_10_cash_count * pricing.adultPass10Price +
    row.adult_pass_20_cash_count * pricing.adultPass20Price;
  const gameAccount =
    row.youth_pass_10_account_count * pricing.youthPass10Price +
    row.youth_pass_20_account_count * pricing.youthPass20Price +
    row.adult_pass_10_account_count * pricing.adultPass10Price +
    row.adult_pass_20_account_count * pricing.adultPass20Price;
  const addOnCard = slushCard + beverageCard + otherCard;
  const addOnCash = slushCash + beverageCash + otherCash;
  const addOnAccount = slushAccount + beverageAccount + otherAccount;

  return {
    slush: slushCard + slushCash + slushAccount,
    beverage: beverageCard + beverageCash + beverageAccount,
    sharedOther: otherCard + otherCash + otherAccount,
    passes: gameCard + gameCash + gameAccount,
    gameCard,
    gameCash,
    gameAccount,
    gameRevenue: gameCard + gameCash + gameAccount,
    addOnCard,
    addOnCash,
    addOnAccount,
    addOnRevenue: addOnCard + addOnCash + addOnAccount,
  };
}
import {
  DEFAULT_PRICING_SETTINGS,
  type PricingSettings,
} from "../pricing-config.ts";
