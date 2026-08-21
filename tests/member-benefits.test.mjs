import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { configuredPassProducts } from "../app/pass-products.ts";

const pricing = {
  adultPrice: 8100, youthPrice: 6100, naverDepositAmount: 5000,
  naverCancellationFeeAmount: 5000, slushPrice: 1500, beveragePrice: 1000,
  otherPrice: 1000, youthPass10Price: 50100, youthPass20Price: 90200,
  adultPass10Price: 70300, adultPass20Price: 120400,
};

test("pass products always use current operating settings", () => {
  const products = configuredPassProducts(pricing);
  assert.deepEqual(products.map((item) => [item.code, item.uses, item.price]), [
    ["YOUTH_PASS_10", 10, 50100], ["YOUTH_PASS_20", 20, 90200],
    ["ADULT_PASS_10", 10, 70300], ["ADULT_PASS_20", 20, 120400],
  ]);
  assert.deepEqual(products.map((item) => item.regularUnitPrice), [6100, 6100, 8100, 8100]);
});

test("pass issuance is gated by PAID and cancellation protects partial use", async () => {
  const [benefits, payments, ui, analytics] = await Promise.all([
    readFile(new URL("../db/member-benefits.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/payments.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/v2/PosV2.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/analytics.ts", import.meta.url), "utf8"),
  ]);
  assert.match(benefits, /if \(status === "PAID"\)/);
  assert.match(benefits, /PASS_PURCHASE_PARTIALLY_USED/);
  assert.match(benefits, /purchase_price/);
  assert.match(benefits, /'USE', \?, \?, \?, \?, \?, 'POS'/);
  assert.match(benefits, /-uses/);
  assert.match(benefits, /'RESTORE', \?, \?, \?, \?, \?, \?, 'POS'/);
  assert.match(benefits, /remaining_uses \+ \?/);
  assert.match(benefits, /stamp-cancel:pass-use:/);
  assert.match(benefits, /FROM pass_ledger u/);
  assert.match(benefits, /r\.type = 'RESTORE'/);
  assert.match(benefits, /WHEN instr\(memo, '다회권 사용'\) > 0 THEN memo/);
  assert.match(benefits, /ELSE rtrim\(memo\) \|\| char\(10\) \|\| '다회권 사용'/);
  assert.match(benefits, /ELSE trim\(replace\(replace\(replace\(/);
  assert.match(benefits, /credit_reservation_id/);
  assert.match(benefits, /다회권 구매 전환 \$\{usedUses\}회 사용/);
  assert.match(benefits, /FROM pass_purchase_credits WHERE order_id = \?/);
  assert.match(benefits, /PASS_PURCHASE_CREDIT_INSUFFICIENT/);
  assert.match(payments, /syncPassPurchasePayment/);
  assert.match(payments, /assertPassPurchaseRefundable/);
  assert.match(ui, /\+ 다회권 구매/);
  assert.match(ui, /다회권으로 이용/);
  assert.match(ui, /결제한 게임비 차감 후 구매/);
  assert.match(ui, /title=\{remoteSelection\.reservation \? "예약 상세"/);
  assert.match(ui, /스탬프 적립/);
  assert.match(ui, /TerminalPaymentControls reservation=\{passPurchaseReservation\}/);
  assert.match(analytics, /source = 'POS_PURCHASE'/);
  assert.match(analytics, /purchase_price IS NOT NULL/);
});

test("legacy migration tool is read-only toward Firebase and supports guarded dry run", async () => {
  const source = await readFile(new URL("../scripts/migrate_jumpingmanager.py", import.meta.url), "utf8");
  assert.match(source, /firestore\.googleapis\.com/);
  assert.match(source, /--dry-run/);
  assert.match(source, /action.: .preview/);
  assert.match(source, /action.: .backup/);
  assert.match(source, /action.: .apply/);
  assert.doesNotMatch(source, /documents:commit|documents:batchWrite|PATCH|DELETE/);
});
