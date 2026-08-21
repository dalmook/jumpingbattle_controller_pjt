"use client";

import { useMemo, useState } from "react";
import type { PricingAmountKey, PricingSettings } from "@/app/pricing-config";
import type { StoredPricingSettings } from "@/db/pricing-settings";
import type { BenefitSettings } from "@/db/member-benefits";
import type { StoredParkingSettings } from "@/db/parking-settings";
import {
  applyKioskPaymentPreset,
  KIOSK_BANK_OPTIONS,
  requiresUnmannedBankWarning,
  type KioskPaymentSettings,
} from "@/app/kiosk/payment-settings";
import type { StoredKioskPaymentSettings } from "@/db/kiosk-payment-settings";

type Field = {
  key: PricingAmountKey;
  label: string;
  description: string;
};

const FIELD_GROUPS: Array<{ title: string; description: string; fields: Field[] }> = [
  {
    title: "게임 이용 요금",
    description: "새로 접수하거나 관리자가 직접 입력하는 예약의 기본 게임비입니다.",
    fields: [
      { key: "adultPrice", label: "성인 1인", description: "고객 예약·직접 예약" },
      { key: "youthPrice", label: "청소년·어린이 1인", description: "고객 예약·직접 예약" },
    ],
  },
  {
    title: "공용 부가매출",
    description: "수량을 입력했을 때 자동 계산되는 개당 판매가입니다.",
    fields: [
      { key: "slushPrice", label: "슬러시", description: "1개 단가" },
      { key: "beveragePrice", label: "음료", description: "1개 단가" },
      { key: "otherPrice", label: "양말", description: "1개 단가" },
    ],
  },
  {
    title: "다회권",
    description: "공용 부가매출에서 판매 수량을 입력할 때 적용되는 금액입니다.",
    fields: [
      { key: "youthPass10Price", label: "청소년 10회", description: "다회권 판매가" },
      { key: "youthPass20Price", label: "청소년 20회", description: "다회권 판매가" },
      { key: "adultPass10Price", label: "성인 10회", description: "다회권 판매가" },
      { key: "adultPass20Price", label: "성인 20회", description: "다회권 판매가" },
    ],
  },
  {
    title: "네이버 예약",
    description: "네이버 예약 결제와 당일 취소 매출에 사용하는 기준 금액입니다.",
    fields: [
      { key: "naverDepositAmount", label: "예약금", description: "현장 결제금 계산" },
      { key: "naverCancellationFeeAmount", label: "당일 취소 수수료", description: "네이버 당일 취소 매출" },
    ],
  },
];

function won(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function pricingValues(pricing: PricingSettings): PricingSettings {
  return {
    adultPrice: pricing.adultPrice,
    youthPrice: pricing.youthPrice,
    naverDepositAmount: pricing.naverDepositAmount,
    naverCancellationFeeAmount: pricing.naverCancellationFeeAmount,
    slushPrice: pricing.slushPrice,
    beveragePrice: pricing.beveragePrice,
    otherPrice: pricing.otherPrice,
    youthPass10Price: pricing.youthPass10Price,
    youthPass20Price: pricing.youthPass20Price,
    adultPass10Price: pricing.adultPass10Price,
    adultPass20Price: pricing.adultPass20Price,
    extraAddOnItems: pricing.extraAddOnItems.map((item) => ({ ...item })),
  };
}

function kioskPaymentValues(settings: KioskPaymentSettings): KioskPaymentSettings {
  return {
    operationMode: settings.operationMode,
    cardEnabled: settings.cardEnabled,
    cashEnabled: settings.cashEnabled,
    bankTransferEnabled: settings.bankTransferEnabled,
    passEnabled: settings.passEnabled,
    couponEnabled: settings.couponEnabled,
    bankName: settings.bankName,
    customBankName: settings.customBankName,
    accountNumber: settings.accountNumber,
    accountHolder: settings.accountHolder,
    guideText: settings.guideText,
    depositorGuide: settings.depositorGuide,
    confirmationMode: settings.confirmationMode,
  };
}

export default function PricingSettingsForm({
  initialPricing,
  initialBenefits,
  initialParking,
  initialKioskPayment,
  operatorName,
}: {
  initialPricing: StoredPricingSettings;
  initialBenefits: BenefitSettings;
  initialParking: StoredParkingSettings;
  initialKioskPayment: StoredKioskPaymentSettings;
  operatorName: string;
}) {
  const initialValues = useMemo<PricingSettings>(() => pricingValues(initialPricing), [initialPricing]);
  const [values, setValues] = useState(initialValues);
  const [savedValues, setSavedValues] = useState(initialValues);
  const [benefits, setBenefits] = useState({
    stampGoal: initialBenefits.stampGoal,
    stampEarnPerGame: initialBenefits.stampEarnPerGame,
    passValidityMonths: initialBenefits.passValidityMonths,
  });
  const [savedBenefits, setSavedBenefits] = useState(benefits);
  const [parking, setParking] = useState({
    enabled: initialParking.enabled,
    autoRegistrationEnabled: initialParking.autoRegistrationEnabled,
    registrationUrl: initialParking.registrationUrl,
    sessionMaxSeconds: initialParking.sessionMaxSeconds,
  });
  const [savedParking, setSavedParking] = useState(parking);
  const initialKioskPaymentValues = useMemo(() => kioskPaymentValues(initialKioskPayment), [initialKioskPayment]);
  const [kioskPayment, setKioskPayment] = useState(initialKioskPaymentValues);
  const [savedKioskPayment, setSavedKioskPayment] = useState(initialKioskPaymentValues);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const changed = JSON.stringify(values) !== JSON.stringify(savedValues)
    || JSON.stringify(benefits) !== JSON.stringify(savedBenefits)
    || JSON.stringify(parking) !== JSON.stringify(savedParking)
    || JSON.stringify(kioskPayment) !== JSON.stringify(savedKioskPayment);

  function changeValue(key: PricingAmountKey, rawValue: string) {
    const next = Math.max(0, Math.min(10_000_000, Math.trunc(Number(rawValue) || 0)));
    setValues((current) => ({ ...current, [key]: next }));
    setNotice("");
  }

  function addExtraItem() {
    const code = `extra-${crypto.randomUUID().slice(0, 8)}`;
    setValues((current) => ({
      ...current,
      extraAddOnItems: [...current.extraAddOnItems, { code, name: "새 상품", price: 1_000, active: true }],
    }));
    setNotice("");
  }

  function updateExtraItem(code: string, patch: Partial<{ name: string; price: number; active: boolean }>) {
    setValues((current) => ({
      ...current,
      extraAddOnItems: current.extraAddOnItems.map((item) => item.code === code ? { ...item, ...patch } : item),
    }));
    setNotice("");
  }

  function removeExtraItem(code: string) {
    setValues((current) => ({
      ...current,
      extraAddOnItems: current.extraAddOnItems.filter((item) => item.code !== code),
    }));
    setNotice("");
  }

  async function save() {
    if (requiresUnmannedBankWarning(kioskPayment) && !window.confirm(
      "현재 계좌이체는 직원 확인 방식입니다.\n\n무인 운영 중에는 고객이 입금한 뒤 직원이 확인하기 전까지 다음 단계로 진행할 수 없습니다.\n\n그래도 계좌이체를 활성화할까요?",
    )) return;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pricing: values, benefits, parking, kioskPayment }),
      });
      const data = (await response.json()) as { pricing?: StoredPricingSettings; benefits?: BenefitSettings; parking?: StoredParkingSettings; kioskPayment?: StoredKioskPaymentSettings; error?: string };
      if (!response.ok || !data.pricing || !data.benefits || !data.parking || !data.kioskPayment) throw new Error(data.error ?? "저장하지 못했습니다.");
      const next = pricingValues(data.pricing);
      setValues(next);
      setSavedValues(next);
      const nextBenefits = {
        stampGoal: data.benefits.stampGoal,
        stampEarnPerGame: data.benefits.stampEarnPerGame,
        passValidityMonths: data.benefits.passValidityMonths,
      };
      setBenefits(nextBenefits);
      setSavedBenefits(nextBenefits);
      const nextParking = {
        enabled: data.parking.enabled,
        autoRegistrationEnabled: data.parking.autoRegistrationEnabled,
        registrationUrl: data.parking.registrationUrl,
        sessionMaxSeconds: data.parking.sessionMaxSeconds,
      };
      setParking(nextParking);
      setSavedParking(nextParking);
      const nextKioskPayment = kioskPaymentValues(data.kioskPayment);
      setKioskPayment(nextKioskPayment);
      setSavedKioskPayment(nextKioskPayment);
      setNotice("운영 설정을 저장했습니다. 키오스크 홈을 새로 열면 바로 적용됩니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "가격 설정을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="pricing-settings-shell">
      <header className="pricing-settings-header">
        <div>
          <p className="eyebrow">JUMPING BATTLE · SETTINGS</p>
          <h1>운영 가격 설정</h1>
          <p>고정 금액을 이 화면에서 직접 수정할 수 있습니다.</p>
        </div>
        <nav aria-label="관리자 메뉴">
          <a href="/admin">통합 운영 관리</a>
          <a href="/admin/game-history">게임 기록</a>
          <a href="/admin/analytics">매출 분석</a>
          <a href="/admin/notifications">매출 알림</a>
          <a href="/reserve" target="_blank" rel="noreferrer">고객 예약 화면</a>
          <span>{operatorName}</span>
        </nav>
      </header>

      <section className="pricing-settings-note">
        <strong>적용 기준</strong>
        <span>인원 단가는 새 예약부터 적용됩니다. 공용 부가매출과 매출 분석의 수량 금액은 저장된 최신 단가로 계산됩니다.</span>
      </section>

      <div className="pricing-settings-groups">
        {FIELD_GROUPS.map((group) => (
          <section className="pricing-settings-card" key={group.title}>
            <div className="pricing-settings-card-heading">
              <h2>{group.title}</h2>
              <p>{group.description}</p>
            </div>
            <div className="pricing-settings-fields">
              {group.fields.map((field) => (
                <label key={field.key}>
                  <span><strong>{field.label}</strong><small>{field.description}</small></span>
                  <span className="pricing-settings-input">
                    <input
                      type="number"
                      min="0"
                      max="10000000"
                      step="100"
                      value={values[field.key]}
                      onChange={(event) => changeValue(field.key, event.target.value)}
                    />
                    <b>원</b>
                  </span>
                  <em>{won(values[field.key])}원</em>
                </label>
              ))}
            </div>
          </section>
        ))}
        <section className="pricing-settings-card">
          <div className="pricing-settings-card-heading pricing-settings-card-heading-actions">
            <div>
              <h2>추가 부가상품</h2>
              <p>결제 탭에 표시할 상품을 추가하거나 이름·단가·사용 여부를 변경합니다.</p>
            </div>
            <button type="button" onClick={addExtraItem}>+ 상품 추가</button>
          </div>
          {values.extraAddOnItems.length ? (
            <div className="pricing-extra-items">
              {values.extraAddOnItems.map((item) => (
                <div className="pricing-extra-item" key={item.code}>
                  <label>
                    <span>상품명</span>
                    <input maxLength={40} value={item.name} onChange={(event) => updateExtraItem(item.code, { name: event.target.value })} />
                  </label>
                  <label>
                    <span>단가</span>
                    <span className="pricing-settings-input">
                      <input type="number" min="0" max="10000000" step="100" value={item.price} onChange={(event) => updateExtraItem(item.code, { price: Math.max(0, Math.min(10_000_000, Math.trunc(Number(event.target.value) || 0))) })} />
                      <b>원</b>
                    </span>
                  </label>
                  <label className="pricing-extra-active">
                    <input type="checkbox" checked={item.active} onChange={(event) => updateExtraItem(item.code, { active: event.target.checked })} />
                    <span>결제 탭에 표시</span>
                  </label>
                  <button type="button" className="pricing-extra-remove" onClick={() => removeExtraItem(item.code)}>삭제</button>
                </div>
              ))}
            </div>
          ) : <p className="pricing-extra-empty">추가 상품이 없습니다. 슬러시·음료·양말은 위의 공용 부가매출에서 관리됩니다.</p>}
        </section>
        <section className="pricing-settings-card">
          <div className="pricing-settings-card-heading">
            <h2>회원 혜택 정책</h2>
            <p>게임 완료 시 스탬프 적립과 다회권 유효기간에 적용됩니다.</p>
          </div>
          <div className="pricing-settings-fields">
            {([
              ["stampEarnPerGame", "게임 완료 적립", "개"],
              ["stampGoal", "무료 혜택 기준", "개"],
              ["passValidityMonths", "신규 다회권 유효기간", "개월"],
            ] as const).map(([key, label, unit]) => (
              <label key={key}>
                <span><strong>{label}</strong><small>회원 원장 정책</small></span>
                <span className="pricing-settings-input">
                  <input type="number" min={key === "stampEarnPerGame" ? 0 : 1} max={key === "passValidityMonths" ? 120 : 100}
                    value={benefits[key]}
                    onChange={(event) => setBenefits((current) => ({ ...current, [key]: Math.max(key === "stampEarnPerGame" ? 0 : 1, Math.trunc(Number(event.target.value) || 0)) }))} />
                  <b>{unit}</b>
                </span>
                <em>{benefits[key]}{unit}</em>
              </label>
            ))}
          </div>
        </section>
        <section className="pricing-settings-card">
          <div className="pricing-settings-card-heading">
            <h2>키오스크 결제 설정</h2>
            <p>운영 방식에 맞는 기본값을 적용한 뒤 결제수단을 개별로 조정할 수 있습니다.</p>
          </div>
          <div className="kiosk-payment-preset" role="group" aria-label="키오스크 운영모드">
            <button
              type="button"
              className={kioskPayment.operationMode === "STAFFED" ? "selected" : ""}
              onClick={() => { setKioskPayment((current) => applyKioskPaymentPreset(current, "STAFFED")); setNotice(""); }}
            >
              <b>직원 상주</b><span>모든 결제수단 사용</span>
            </button>
            <button
              type="button"
              className={kioskPayment.operationMode === "UNMANNED" ? "selected" : ""}
              onClick={() => { setKioskPayment((current) => applyKioskPaymentPreset(current, "UNMANNED")); setNotice(""); }}
            >
              <b>무인 운영</b><span>카드·다회권·쿠폰 중심</span>
            </button>
          </div>
          <div className="kiosk-payment-method-settings">
            {([
              ["cardEnabled", "카드", "기존 MPOS 카드 승인"],
              ["cashEnabled", "현금", "직원 수납 확인 후 완료"],
              ["bankTransferEnabled", "계좌이체", "QR 안내 후 직원 입금 확인"],
              ["passEnabled", "다회권", "보유 회원에게만 표시"],
              ["couponEnabled", "무료이용 쿠폰", "사용 가능한 회원에게만 표시"],
            ] as const).map(([key, label, description]) => (
              <label key={key}>
                <span><b>{label}</b><small>{description}</small></span>
                <input
                  type="checkbox"
                  checked={kioskPayment[key]}
                  onChange={(event) => { setKioskPayment((current) => ({ ...current, [key]: event.target.checked })); setNotice(""); }}
                />
              </label>
            ))}
          </div>
          {requiresUnmannedBankWarning(kioskPayment) ? <div className="kiosk-payment-warning"><b>⚠ 직원 확인 필요</b><span>무인 운영 중에는 고객이 입금 후 직원 확인을 기다릴 수 있습니다.</span></div> : null}
          <div className={kioskPayment.bankTransferEnabled ? "bank-transfer-settings" : "bank-transfer-settings disabled"}>
            <div className="bank-transfer-settings-heading"><div><b>계좌이체 설정</b><span>계좌정보는 결제 시작 시점에 거래별로 안전하게 보관됩니다.</span></div>{kioskPayment.bankTransferEnabled ? <em>사용 중</em> : <em>사용 안 함</em>}</div>
            <div className="bank-transfer-settings-grid">
              <label><span>은행</span><select disabled={!kioskPayment.bankTransferEnabled} value={kioskPayment.bankName} onChange={(event) => setKioskPayment((current) => ({ ...current, bankName: event.target.value }))}><option value="">선택해주세요</option>{KIOSK_BANK_OPTIONS.map((bank) => <option key={bank} value={bank}>{bank}</option>)}</select></label>
              {kioskPayment.bankName === "기타" ? <label><span>은행명 직접입력</span><input disabled={!kioskPayment.bankTransferEnabled} maxLength={40} value={kioskPayment.customBankName} onChange={(event) => setKioskPayment((current) => ({ ...current, customBankName: event.target.value }))} /></label> : null}
              <label><span>계좌번호</span><input disabled={!kioskPayment.bankTransferEnabled} maxLength={60} value={kioskPayment.accountNumber} onChange={(event) => setKioskPayment((current) => ({ ...current, accountNumber: event.target.value }))} placeholder="숫자와 하이픈 입력" /></label>
              <label><span>예금주</span><input disabled={!kioskPayment.bankTransferEnabled} maxLength={60} value={kioskPayment.accountHolder} onChange={(event) => setKioskPayment((current) => ({ ...current, accountHolder: event.target.value }))} /></label>
              <label className="wide"><span>안내문구</span><input disabled={!kioskPayment.bankTransferEnabled} maxLength={160} value={kioskPayment.guideText} onChange={(event) => setKioskPayment((current) => ({ ...current, guideText: event.target.value }))} /></label>
              <label className="wide"><span>입금자명 안내</span><input disabled={!kioskPayment.bankTransferEnabled} maxLength={160} value={kioskPayment.depositorGuide} onChange={(event) => setKioskPayment((current) => ({ ...current, depositorGuide: event.target.value }))} /></label>
            </div>
            <div className="bank-confirmation-modes"><span>입금 확인 방식</span><label><input type="radio" checked readOnly /> 직원 확인</label><label className="future"><input type="radio" disabled /> 자동 확인 <small>향후 지원</small></label></div>
          </div>
        </section>
        <section className="pricing-settings-card">
          <div className="pricing-settings-card-heading">
            <h2>주차등록</h2>
            <p>ParkingWeb 계정정보는 웹과 DB에 저장하지 않고 매장 브릿지에서만 안전하게 사용합니다.</p>
          </div>
          <div className="pricing-extra-items">
            <div className="pricing-extra-item">
              <label className="pricing-extra-active">
                <input
                  type="checkbox"
                  checked={parking.autoRegistrationEnabled}
                  onChange={(event) => { setParking((current) => ({ ...current, autoRegistrationEnabled: event.target.checked })); setNotice(""); }}
                />
                <span>주차 자동등록</span>
              </label>
              <p>체크하면 차량번호 저장 후 백그라운드에서 자동 등록합니다. 체크를 해제하면 예약 카드의 주차등록 버튼으로 직접 처리합니다.</p>
            </div>
            <div className="pricing-extra-item">
              <label className="pricing-extra-active">
                <input
                  type="checkbox"
                  checked={parking.enabled}
                  onChange={(event) => { setParking((current) => ({ ...current, enabled: event.target.checked })); setNotice(""); }}
                />
                <span>키오스크 홈에 주차등록 표시</span>
              </label>
              <label>
                <span>최대 이용시간</span>
                <span className="pricing-settings-input">
                  <input
                    type="number"
                    min="30"
                    max="300"
                    step="10"
                    value={parking.sessionMaxSeconds}
                    onChange={(event) => { setParking((current) => ({ ...current, sessionMaxSeconds: Math.max(30, Math.min(300, Math.trunc(Number(event.target.value) || 30))) })); setNotice(""); }}
                  />
                  <b>초</b>
                </span>
              </label>
            </div>
            <label className="pricing-settings-note">
              <strong>ParkingWeb 등록 주소</strong>
              <input
                type="url"
                value={parking.registrationUrl}
                onChange={(event) => { setParking((current) => ({ ...current, registrationUrl: event.target.value })); setNotice(""); }}
                spellCheck={false}
              />
              <span>parking.example.com의 주차등록 주소만 저장할 수 있습니다.</span>
            </label>
          </div>
        </section>
      </div>

      <footer className="pricing-settings-actions">
        <div aria-live="polite">{notice || (changed ? "저장하지 않은 변경사항이 있습니다." : "현재 저장된 가격입니다.")}</div>
        <button type="button" className="secondary" disabled={!changed || saving} onClick={() => { setValues(savedValues); setBenefits(savedBenefits); setParking(savedParking); setKioskPayment(savedKioskPayment); }}>변경 취소</button>
        <button type="button" disabled={!changed || saving} onClick={save}>{saving ? "저장 중…" : "설정 저장"}</button>
      </footer>
    </main>
  );
}
