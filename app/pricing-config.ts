export type AddOnProductSetting = {
  code: string;
  name: string;
  price: number;
  active: boolean;
};

export type PricingSettings = {
  adultPrice: number;
  youthPrice: number;
  naverDepositAmount: number;
  naverCancellationFeeAmount: number;
  slushPrice: number;
  beveragePrice: number;
  otherPrice: number;
  youthPass10Price: number;
  youthPass20Price: number;
  adultPass10Price: number;
  adultPass20Price: number;
  extraAddOnItems: AddOnProductSetting[];
};

export type PricingAmountKey = Exclude<keyof PricingSettings, "extraAddOnItems">;

export type SharedSalesCategory =
  | "slush"
  | "beverage"
  | "other"
  | "youthPass10"
  | "youthPass20"
  | "adultPass10"
  | "adultPass20";

export const DEFAULT_PRICING_SETTINGS: PricingSettings = {
  adultPrice: 7_000,
  youthPrice: 5_000,
  naverDepositAmount: 5_000,
  naverCancellationFeeAmount: 5_000,
  slushPrice: 1_500,
  beveragePrice: 1_000,
  otherPrice: 1_000,
  youthPass10Price: 45_000,
  youthPass20Price: 80_000,
  adultPass10Price: 60_000,
  adultPass20Price: 110_000,
  extraAddOnItems: [],
};

export function sharedSalesUnitPrices(
  pricing: PricingSettings,
): Record<SharedSalesCategory, number> {
  return {
    slush: pricing.slushPrice,
    beverage: pricing.beveragePrice,
    other: pricing.otherPrice,
    youthPass10: pricing.youthPass10Price,
    youthPass20: pricing.youthPass20Price,
    adultPass10: pricing.adultPass10Price,
    adultPass20: pricing.adultPass20Price,
  };
}

export function calculateConfiguredBaseAmount(
  adultCount: number,
  youthCount: number,
  pricing: PricingSettings,
) {
  return adultCount * pricing.adultPrice + youthCount * pricing.youthPrice;
}

export function sanitizePricingSettings(input: unknown): PricingSettings | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const result = {} as PricingSettings;

  const amountKeys = (Object.keys(DEFAULT_PRICING_SETTINGS) as Array<keyof PricingSettings>)
    .filter((key): key is PricingAmountKey => key !== "extraAddOnItems");
  for (const key of amountKeys) {
    const value = Number(source[key]);
    if (!Number.isInteger(value) || value < 0 || value > 10_000_000) return null;
    result[key] = value;
  }

  const rawItems = source.extraAddOnItems ?? [];
  if (!Array.isArray(rawItems) || rawItems.length > 30) return null;
  const seen = new Set<string>();
  result.extraAddOnItems = [];
  for (const rawItem of rawItems) {
    if (!rawItem || typeof rawItem !== "object") return null;
    const item = rawItem as Record<string, unknown>;
    const code = String(item.code ?? "").trim().toLowerCase();
    const name = String(item.name ?? "").trim();
    const price = Number(item.price);
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(code) || seen.has(code)) return null;
    if (!name || name.length > 40) return null;
    if (!Number.isInteger(price) || price < 0 || price > 10_000_000) return null;
    seen.add(code);
    result.extraAddOnItems.push({ code, name, price, active: item.active !== false });
  }

  return result;
}
