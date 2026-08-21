import type { PricingSettings } from "./pricing-config.ts";

export type PassProductCode =
  | "YOUTH_PASS_10"
  | "YOUTH_PASS_20"
  | "ADULT_PASS_10"
  | "ADULT_PASS_20";

export type PassProduct = {
  code: PassProductCode;
  name: string;
  ageGroup: "youth" | "adult";
  uses: number;
  price: number;
  regularUnitPrice: number;
  active: boolean;
};

export function configuredPassProducts(pricing: PricingSettings): PassProduct[] {
  return [
    { code: "YOUTH_PASS_10", name: "청소년 10회권", ageGroup: "youth", uses: 10, price: pricing.youthPass10Price, regularUnitPrice: pricing.youthPrice, active: true },
    { code: "YOUTH_PASS_20", name: "청소년 20회권", ageGroup: "youth", uses: 20, price: pricing.youthPass20Price, regularUnitPrice: pricing.youthPrice, active: true },
    { code: "ADULT_PASS_10", name: "성인 10회권", ageGroup: "adult", uses: 10, price: pricing.adultPass10Price, regularUnitPrice: pricing.adultPrice, active: true },
    { code: "ADULT_PASS_20", name: "성인 20회권", ageGroup: "adult", uses: 20, price: pricing.adultPass20Price, regularUnitPrice: pricing.adultPrice, active: true },
  ];
}
