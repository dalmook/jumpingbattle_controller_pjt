import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_KIOSK_PAYMENT_SETTINGS,
  activeKioskPaymentMethodCount,
  applyKioskPaymentPreset,
  assertKioskPaymentMethodEnabled,
  effectiveBankName,
  isKioskPaymentMethodEnabled,
  publicKioskPaymentSettings,
  requiresUnmannedBankWarning,
  sanitizeKioskPaymentSettings,
} from "../app/kiosk/payment-settings.ts";

const bankReady = {
  ...DEFAULT_KIOSK_PAYMENT_SETTINGS,
  bankTransferEnabled: true,
  bankName: "국민은행",
  accountNumber: "123-456-789",
  accountHolder: "점핑배틀",
};

test("1. 기존 운영 기본값은 카드·현금·다회권·쿠폰을 유지하고 계좌이체는 안전하게 꺼둔다", () => {
  assert.deepEqual({
    card: DEFAULT_KIOSK_PAYMENT_SETTINGS.cardEnabled,
    cash: DEFAULT_KIOSK_PAYMENT_SETTINGS.cashEnabled,
    bank: DEFAULT_KIOSK_PAYMENT_SETTINGS.bankTransferEnabled,
    pass: DEFAULT_KIOSK_PAYMENT_SETTINGS.passEnabled,
    coupon: DEFAULT_KIOSK_PAYMENT_SETTINGS.couponEnabled,
  }, { card: true, cash: true, bank: false, pass: true, coupon: true });
});

test("2. 직원 운영 프리셋은 모든 결제수단을 켠다", () => {
  const settings = applyKioskPaymentPreset(DEFAULT_KIOSK_PAYMENT_SETTINGS, "STAFFED");
  assert.equal(activeKioskPaymentMethodCount(settings), 5);
});

test("3. 무인 운영 프리셋은 카드·다회권·쿠폰만 켠다", () => {
  const settings = applyKioskPaymentPreset(bankReady, "UNMANNED");
  assert.deepEqual([settings.cardEnabled, settings.cashEnabled, settings.bankTransferEnabled, settings.passEnabled, settings.couponEnabled], [true, false, false, true, true]);
});

test("4. 프리셋 적용 후 개별 결제수단을 다시 켤 수 있다", () => {
  const settings = { ...applyKioskPaymentPreset(bankReady, "UNMANNED"), bankTransferEnabled: true };
  assert.equal(isKioskPaymentMethodEnabled(settings, "account"), true);
});

test("5. 결제수단을 모두 끈 설정은 거부한다", () => {
  assert.equal(sanitizeKioskPaymentSettings({
    ...DEFAULT_KIOSK_PAYMENT_SETTINGS,
    cardEnabled: false, cashEnabled: false, bankTransferEnabled: false, passEnabled: false, couponEnabled: false,
  }), null);
});

test("6. 계좌정보가 없는 계좌이체 설정은 거부한다", () => {
  assert.equal(sanitizeKioskPaymentSettings({ ...DEFAULT_KIOSK_PAYMENT_SETTINGS, bankTransferEnabled: true }), null);
});

test("7. 기타 은행은 직접 입력 은행명을 사용한다", () => {
  assert.equal(effectiveBankName({ bankName: "기타", customBankName: "새마을금고" }), "새마을금고");
});

test("8. 무인 운영에서 직원 확인 계좌이체를 켜면 경고한다", () => {
  assert.equal(requiresUnmannedBankWarning({ ...bankReady, operationMode: "UNMANNED" }), true);
});

test("9. 아직 지원하지 않는 자동 입금확인은 저장하지 않는다", () => {
  assert.equal(sanitizeKioskPaymentSettings({ ...bankReady, confirmationMode: "AUTO_CONFIRM" }), null);
});

test("10. 공개 설정은 계좌이체를 내부 account 코드로 전달한다", () => {
  const settings = publicKioskPaymentSettings(bankReady);
  assert.equal(settings.methods.account, true);
  assert.equal(settings.bankTransferConfirmationMode, "STAFF_CONFIRM");
});

test("11. 비활성 결제수단은 서버 검증에서 거부한다", () => {
  assert.throws(() => assertKioskPaymentMethodEnabled(DEFAULT_KIOSK_PAYMENT_SETTINGS, "account"), /KIOSK_PAYMENT_METHOD_DISABLED/);
});

test("12. bank_transfer 별칭도 같은 설정으로 검사한다", () => {
  assert.equal(isKioskPaymentMethodEnabled(bankReady, "bank_transfer"), true);
});

test("13. 키오스크 bootstrap은 공개 결제 설정만 내려준다", async () => {
  const route = await readFile(new URL("../app/api/kiosk/route.ts", import.meta.url), "utf8");
  assert.match(route, /publicKioskPaymentSettings/);
  assert.match(route, /paymentSettings/);
});

test("14. 결제 시작과 회차 변경 모두 서버에서 결제수단을 검증한다", async () => {
  const source = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.ok((source.match(/assertKioskPaymentMethodEnabled/g) || []).length >= 4);
});

test("15. 다회권과 쿠폰은 설정이 켜지고 실제 사용 가능할 때만 선택지에 표시한다", async () => {
  const source = await readFile(new URL("../app/kiosk/KioskApp.tsx", import.meta.url), "utf8");
  assert.match(source, /methods\.pass !== false[\s\S]*passes\.filter\(\(item\) => item\.usable\)/);
  assert.match(source, /methods\.coupon !== false[\s\S]*coupons\.filter\(\(item\) => item\.usable\)/);
});

test("16. 계좌이체 안내는 거래별 계좌정보 스냅샷으로 생성한다", async () => {
  const source = await readFile(new URL("../db/kiosk-payment-settings.ts", import.meta.url), "utf8");
  assert.match(source, /bank_name_at_payment/);
  assert.match(source, /account_number_at_payment/);
  assert.match(source, /transaction_id TEXT NOT NULL UNIQUE/);
});

test("17. 직원 입금 확인 후 해당 계좌이체 세션을 완료 처리한다", async () => {
  const source = await readFile(new URL("../db/customer-flow.ts", import.meta.url), "utf8");
  assert.match(source, /setKioskBankTransferSessionStatus\(next\.id, "CONFIRMED"\)/);
  assert.match(source, /confirmKioskManualPayment/);
});

test("18. 계좌이체 QR과 모바일 안내는 외부 QR 서비스 없이 읽기 전용으로 제공한다", async () => {
  const [qr, page, guide] = await Promise.all([
    readFile(new URL("../app/api/transfer/[token]/qr/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/transfer/[token]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/transfer/[token]/TransferGuide.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(qr, /QRCode\.toString/);
  assert.doesNotMatch(qr, /googleapis|quickchart|api\.qrserver/i);
  assert.match(page, /getPublicKioskBankTransferSession/);
  assert.match(guide, /계좌번호 복사/);
  assert.match(guide, /금액을 복사했어요/);
});
