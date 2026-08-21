"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { KioskInput, useKioskKeyboard } from "../kiosk/KioskKeyboard";
import {
  ACTUAL_PLAY_MINUTES,
  DIFFICULTY_OPTIONS,
  GAME_DURATION_MINUTES,
  OPERATING_SLOTS,
  ROOM_OPTIONS,
  calculateBaseAmount,
  getRoom,
  nextBookableTime,
  type ReservationRecord,
} from "../reservation-config";
import type { PricingSettings } from "../pricing-config";

type OccupiedSlot = { time: string; roomCode: string };
type Step = 1 | 2 | 3 | 4;
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const STEP_LABELS = ["방", "인원", "난이도", "확인·동의"];
const STEP_COMPLETION_MESSAGES: Record<Step, { title: string; body: string }> = {
  1: {
    title: "방 선택 완료!",
    body: "아래 버튼을 눌러 인원과 팀명을 입력해요.",
  },
  2: {
    title: "인원·팀명 입력 완료!",
    body: "아래 버튼을 눌러 난이도를 골라요.",
  },
  3: {
    title: "난이도 선택 완료!",
    body: "아래 버튼을 눌러 마지막 확인을 해요.",
  },
  4: {
    title: "동의가 완료됐어요!",
    body: "아래 예약 접수 버튼을 눌러주세요.",
  },
};

function won(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function koreanDate(value: string) {
  const date = new Date(`${value}T12:00:00+09:00`);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

export default function ReserveForm({
  today,
  pricing,
}: {
  today: string;
  pricing: PricingSettings;
}) {
  const [step, setStep] = useState<Step>(1);
  const [scheduledTime, setScheduledTime] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [adultCount, setAdultCount] = useState(0);
  const [youthCount, setYouthCount] = useState(0);
  const [teamName, setTeamName] = useState("");
  const [difficultyCode, setDifficultyCode] = useState("");
  const [vehicleLast4, setVehicleLast4] = useState("");
  const [agreeSafety, setAgreeSafety] = useState(false);
  const [occupied, setOccupied] = useState<OccupiedSlot[]>([]);
  const [availabilityError, setAvailabilityError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReservationRecord | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const safetyAgreementRef = useRef<HTMLLabelElement>(null);
  const { activeId, close: closeKioskKeyboard } = useKioskKeyboard();
  const teamInputFocused = activeId === "reserve-team-name";

  const loadAvailability = useCallback(async () => {
    setAvailabilityError("");
    try {
      const response = await fetch(
        `/api/reservations?date=${encodeURIComponent(today)}`,
        { cache: "no-store" },
      );
      const data = (await response.json()) as {
        occupied?: OccupiedSlot[];
        error?: string;
      };
      if (!response.ok) {
        throw new Error(data.error ?? "예약 가능 시간을 불러오지 못했습니다.");
      }
      setOccupied(data.occupied ?? []);
    } catch (reason) {
      setAvailabilityError(
        reason instanceof Error
          ? reason.message
          : "예약 가능 시간을 불러오지 못했습니다.",
      );
    }
  }, [today]);

  useEffect(() => {
    void loadAvailability();

    const refreshAvailability = () => {
      void loadAvailability();
    };
    const refreshWhenVisible = () => {
      if (!document.hidden) refreshAvailability();
    };
    const intervalId = window.setInterval(refreshAvailability, 5_000);

    window.addEventListener("focus", refreshAvailability);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshAvailability);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [loadAvailability]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    const updateKeyboardInset = () => {
      const inset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
      root.style.setProperty("--reserve-keyboard-inset", `${inset}px`);
    };

    updateKeyboardInset();
    viewport.addEventListener("resize", updateKeyboardInset);
    viewport.addEventListener("scroll", updateKeyboardInset);

    return () => {
      viewport.removeEventListener("resize", updateKeyboardInset);
      viewport.removeEventListener("scroll", updateKeyboardInset);
      root.style.removeProperty("--reserve-keyboard-inset");
    };
  }, []);

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleInstalled = () => setInstallPrompt(null);

    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);

  async function installCustomerApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  const room = getRoom(roomCode);
  const difficulty = DIFFICULTY_OPTIONS.find(
    (option) => option.code === difficultyCode,
  );
  const totalCount = adultCount + youthCount;
  const baseAmount = calculateBaseAmount(adultCount, youthCount, pricing);
  const occupiedKeys = useMemo(
    () => new Set(occupied.map((slot) => `${slot.roomCode}|${slot.time}`)),
    [occupied],
  );
  const minimumTime = nextBookableTime();
  const earliestByRoom = useMemo(
    () =>
      Object.fromEntries(
        ROOM_OPTIONS.map((option) => [
          option.code,
          OPERATING_SLOTS.find(
            (time) =>
              time >= minimumTime &&
              !occupiedKeys.has(`${option.code}|${time}`),
          ) ?? "",
        ]),
      ),
    [minimumTime, occupiedKeys],
  );
  const earliestAvailableTime = roomCode
    ? earliestByRoom[roomCode] ?? ""
    : "";

  useEffect(() => {
    setScheduledTime(earliestAvailableTime);
  }, [earliestAvailableTime, roomCode]);

  function changeCount(kind: "adult" | "youth", amount: number) {
    if (kind === "adult") {
      setAdultCount((value) => Math.max(0, Math.min(10, value + amount)));
      return;
    }
    setYouthCount((value) => Math.max(0, Math.min(10, value + amount)));
  }

  function validateStep(target: Step) {
    if (target === 1) {
      if (!room) return "직원이 안내한 방을 선택해주세요.";
      if (!scheduledTime) return "선택한 방은 현재 예약 가능한 시간이 없습니다.";
    }
    if (target === 2) {
      if (totalCount < 1 || totalCount > 10) {
        return "전체 인원은 1~10명으로 입력해주세요.";
      }
      if (!teamName.trim()) return "팀명을 입력해주세요.";
      if (teamName.trim().length > 10) {
        return "팀명은 최대 10자까지 입력할 수 있습니다.";
      }
    }
    if (target === 3 && !difficultyCode) {
      return "난이도를 선택해주세요.";
    }
    if (target === 4) {
      if (vehicleLast4 && !/^\d{4}$/.test(vehicleLast4)) {
        return "차량번호 뒤 4자리를 입력해주세요.";
      }
      if (!agreeSafety) return "필수 안내를 확인하고 동의해주세요.";
    }
    return "";
  }

  const stepReady = !validateStep(step);
  const completionMessage = STEP_COMPLETION_MESSAGES[step];

  function nextStep() {
    const validationError = validateStep(step);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    closeKioskKeyboard();
    setStep((current) => Math.min(4, current + 1) as Step);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function previousStep() {
    setError("");
    closeKioskKeyboard();
    setStep((current) => Math.max(1, current - 1) as Step);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step !== 4) {
      nextStep();
      return;
    }
    const validationError = validateStep(4);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/reservations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scheduledDate: today,
          scheduledTime,
          roomCode,
          adultCount,
          youthCount,
          teamName: teamName.trim(),
          difficultyCode,
          vehicleLast4,
          agreeSafety,
          idempotencyKey,
        }),
      });
      const data = (await response.json()) as {
        reservation?: ReservationRecord;
        error?: string;
      };
      if (!response.ok || !data.reservation) {
        if (response.status === 409) {
          await loadAvailability();
          setStep(1);
          throw new Error(
            "방금 다른 예약이 접수되어 가장 빠른 시간이 변경됐습니다. 방을 다시 확인해주세요.",
          );
        }
        throw new Error(data.error ?? "예약을 접수하지 못했습니다.");
      }
      setResult(data.reservation);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "예약을 접수하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const resultRoom = getRoom(result.roomCode);
    return (
      <main className="reserve-shell reserve-success-shell">
        <section className="reserve-success-card">
          <div className="success-check" aria-hidden="true">✓</div>
          <p className="eyebrow">RESERVATION COMPLETE</p>
          <h1>예약 접수가 완료됐어요</h1>
          <p className="success-lead">
            직원에게 아래 예약번호를 보여주세요.
          </p>
          <strong className="booking-code">{result.bookingCode}</strong>
          <dl className="success-details">
            <div>
              <dt>입장 예정</dt>
              <dd>{koreanDate(result.scheduledDate)} {result.scheduledTime}</dd>
            </div>
            <div>
              <dt>방</dt>
              <dd>{resultRoom?.name ?? result.roomCode}</dd>
            </div>
            <div>
              <dt>팀명 · 난이도</dt>
              <dd>{result.teamName} · {result.difficultyLabel}</dd>
            </div>
            <div>
              <dt>인원</dt>
              <dd>총 {result.totalCount}명</dd>
            </div>
            {result.vehicleLast4 ? (
              <div>
                <dt>차량번호</dt>
                <dd>뒤 4자리 {result.vehicleLast4}</dd>
              </div>
            ) : null}
            <div>
              <dt>예상 결제</dt>
              <dd>{won(result.baseAmount)}원</dd>
            </div>
          </dl>
          <p className="success-note">
            총 {GAME_DURATION_MINUTES}분(설명 1분 + 게임 {ACTUAL_PLAY_MINUTES}분)
            이용이며, 결제는 매장에서 진행합니다.
          </p>
          <button
            className="reserve-secondary-button"
            type="button"
            onClick={() => window.location.reload()}
          >
            다른 예약 접수
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className={`reserve-shell reserve-step-shell ${stepReady ? "has-step-nudge" : ""}`}>
      <header className="reserve-step-header">
        <div className="reserve-brand-row">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <div>
            <p className="eyebrow">JUMPING BATTLE · 화성병점점</p>
            <strong>오늘 바로 입장 예약</strong>
          </div>
        </div>
        <div className="reserve-step-tools">
          <a className="reserve-member-link" href="/member">
            회원 MY
          </a>
          {installPrompt ? (
            <button
              className="reserve-install-button"
              type="button"
              onClick={() => void installCustomerApp()}
            >
              <span aria-hidden="true">＋</span> 앱 설치
            </button>
          ) : null}
          <div className="reserve-step-count">
            <strong>{step}</strong><span>/ 4</span>
          </div>
        </div>
      </header>

      <div className="reserve-progress" aria-label={`예약 ${step}단계`}>
        {STEP_LABELS.map((label, index) => (
          <span
            className={index + 1 <= step ? "is-active" : ""}
            key={label}
          >
            <i />
            <small>{label}</small>
          </span>
        ))}
      </div>

      <form className="reserve-step-form" onSubmit={submit}>
        <section className="reserve-step-card" aria-live="polite">
          {step === 1 ? (
            <>
              <div className="reserve-step-copy">
                <span>STEP 1</span>
                <h1>직원이 안내한 방을<br />선택해주세요</h1>
                <p>방을 고르면 오늘 가장 빠른 입장 시간이 자동으로 정해져요.</p>
              </div>
              <div className="room-choice-grid reserve-room-grid" role="radiogroup" aria-label="방 선택">
                {ROOM_OPTIONS.map((option) => (
                  <button
                    className={roomCode === option.code ? "choice-button is-selected" : "choice-button"}
                    key={option.code}
                    type="button"
                    role="radio"
                    aria-checked={roomCode === option.code}
                    disabled={!earliestByRoom[option.code]}
                    onClick={() => {
                      setRoomCode(option.code);
                      setError("");
                    }}
                  >
                    <span className="room-choice-check" aria-hidden="true">
                      {roomCode === option.code ? "✓" : ""}
                    </span>
                    <strong>{option.name}</strong>
                    <small>권장 {option.min}~{option.max}명</small>
                    <b className={earliestByRoom[option.code] ? "room-earliest-time" : "room-earliest-time is-full"}>
                      {earliestByRoom[option.code]
                        ? `${earliestByRoom[option.code]} 입장 예상`
                        : "오늘 예약 마감"}
                    </b>
                  </button>
                ))}
              </div>
              {room && scheduledTime ? (
                <div className="automatic-time-card">
                  <span>자동 배정된 가장 빠른 시간</span>
                  <strong>{scheduledTime}</strong>
                  <small>{room.name} · 별도 시간 선택 없이 접수됩니다.</small>
                </div>
              ) : null}
              {availabilityError ? (
                <p className="reserve-inline-error" role="alert">
                  {availabilityError}
                </p>
              ) : null}
            </>
          ) : null}

          {step === 2 ? (
            <>
              <div className="reserve-step-copy">
                <span>STEP 2</span>
                <h1>몇 명이 함께<br />플레이하나요?</h1>
                <p>팀명은 게임 화면과 랭킹에 표시됩니다.</p>
              </div>
              <div className="counter-grid reserve-counter-grid">
                <div className="count-box">
                  <span>성인 <small>{won(pricing.adultPrice)}원</small></span>
                  <div>
                    <button type="button" onClick={() => changeCount("adult", -1)} aria-label="성인 한 명 빼기">−</button>
                    <strong>{adultCount}</strong>
                    <button type="button" onClick={() => changeCount("adult", 1)} aria-label="성인 한 명 추가">＋</button>
                  </div>
                </div>
                <div className="count-box">
                  <span>청소년·어린이 <small>{won(pricing.youthPrice)}원</small></span>
                  <div>
                    <button type="button" onClick={() => changeCount("youth", -1)} aria-label="청소년 한 명 빼기">−</button>
                    <strong>{youthCount}</strong>
                    <button type="button" onClick={() => changeCount("youth", 1)} aria-label="청소년 한 명 추가">＋</button>
                  </div>
                </div>
              </div>
              <label className="reserve-field reserve-team-field">
                <span>팀명 <small>{teamName.length}/10</small></span>
                <KioskInput
                  inputId="reserve-team-name"
                  label="팀명"
                  kind="korean"
                  maxLength={10}
                  value={teamName}
                  onValueChange={(value) => {
                    setTeamName(value.slice(0, 10));
                    setError("");
                  }}
                  enterKeyHint="next"
                  placeholder="예) 번개슛"
                />
              </label>
              <div className="step-price-summary">
                <span>현재 예상 결제금액</span>
                <strong>{won(baseAmount)}원</strong>
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div className="reserve-step-copy">
                <span>STEP 3</span>
                <h1>난이도를<br />골라주세요</h1>
                <p>처음이라면 베이직을 추천해요.</p>
              </div>
              <div className="difficulty-grid reserve-difficulty-grid" role="radiogroup" aria-label="난이도 선택">
                {DIFFICULTY_OPTIONS.map((option) => (
                  <button
                    key={option.code}
                    className={difficultyCode === option.code ? "difficulty-choice is-selected" : "difficulty-choice"}
                    type="button"
                    role="radio"
                    aria-checked={difficultyCode === option.code}
                    onClick={() => {
                      setDifficultyCode(option.code);
                      setError("");
                    }}
                  >
                    <span>
                      <strong>{option.label}</strong>
                      {option.code === "basic" ? <em>추천</em> : null}
                      <b>{option.stars}</b>
                    </span>
                    <small>{option.description}</small>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <div className="reserve-step-copy">
                <span>STEP 4</span>
                <h1>마지막으로<br />확인해주세요</h1>
                <p>차량번호는 주차 등록이 필요한 경우에만 입력하세요.</p>
              </div>
              <div className="final-reservation-summary">
                <dl>
                  <div><dt>방</dt><dd>{room?.name}</dd></div>
                  <div><dt>팀</dt><dd>{teamName} · {difficulty?.label}</dd></div>
                  <div><dt>인원</dt><dd>총 {totalCount}명</dd></div>
                  <div><dt>예상 결제</dt><dd>{won(baseAmount)}원</dd></div>
                </dl>
              </div>
              <label className="reserve-field vehicle-field">
                <span>차량번호 뒤 4자리 <small>선택</small></span>
                <KioskInput
                  inputId="reserve-vehicle-last4"
                  label="차량번호 뒤 4자리"
                  kind="numeric"
                  maxLength={4}
                  value={vehicleLast4}
                  onValueChange={(value) => {
                    setVehicleLast4(
                      value.replace(/\D/g, "").slice(0, 4),
                    );
                    setError("");
                  }}
                  enterKeyHint="done"
                  placeholder="예) 1234"
                />
              </label>
              <label
                ref={safetyAgreementRef}
                className={`safety-agreement step-safety-agreement ${agreeSafety ? "is-checked" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={agreeSafety}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setAgreeSafety(checked);
                    setError("");
                    if (checked) {
                      closeKioskKeyboard();
                      window.setTimeout(() => {
                        safetyAgreementRef.current?.scrollIntoView({
                          behavior: "smooth",
                          block: "center",
                        });
                      }, 80);
                    }
                  }}
                />
                <span>
                  <strong>필수안내를 확인했고 동의합니다</strong>
                  <small>
                    부주의로 인한 사고·부상 및 LED로 인한 어지러움/구토 등의
                    증상 발생 시, 이에 대한 책임은 이용자에게 있습니다.
                  </small>
                </span>
              </label>
            </>
          ) : null}

          {error ? (
            <div className="reserve-submit-error" role="alert">{error}</div>
          ) : null}
        </section>

        <div className={`reserve-step-actions ${stepReady ? "has-step-ready has-step-nudge" : ""}`}>
          {stepReady ? (
            <div
              className={`reserve-step-nudge ${step === 2 && teamInputFocused ? "is-team-input-focused" : ""}`}
              role="status"
              aria-live="polite"
            >
              <img
                className="reserve-step-nudge-mascot"
                src="/reservation-penguin.png"
                alt=""
                aria-hidden="true"
              />
              <span className="reserve-step-nudge-copy">
                <strong>{completionMessage.title}</strong>
                <small>{completionMessage.body}</small>
              </span>
              <b className="reserve-step-nudge-arrow" aria-hidden="true">↓</b>
            </div>
          ) : null}
          <div className="reserve-step-action-row">
            {step > 1 ? (
              <button
                className="step-back-button"
                type="button"
                disabled={busy}
                onClick={previousStep}
              >
                이전
              </button>
            ) : null}
            <button
              className="step-next-button"
              type="submit"
              disabled={busy}
            >
              {busy
                ? "접수 중…"
                : step === 4
                  ? "동의하고 예약 접수"
                  : step === 3
                    ? "마지막 확인하기"
                    : step === 2
                      ? "난이도 선택하기"
                      : "인원·팀명 입력하기"}
            </button>
          </div>
        </div>
      </form>

      <footer className="reserve-footer">
        점핑배틀 화성병점점 · 오늘 방문 고객 전용 예약
      </footer>
    </main>
  );
}
