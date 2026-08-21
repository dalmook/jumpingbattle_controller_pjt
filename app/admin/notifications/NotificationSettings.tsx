"use client";

import { useEffect, useMemo, useState } from "react";

type PushSchedule = {
  id: string;
  name: string;
  enabled: boolean;
  deliveryTime: string;
  weekdays: number[];
  lastSentDate: string;
  sortOrder: number;
  updatedAt: string;
};

type PushDevice = {
  id: string;
  deviceName: string;
  enabled: boolean;
  lastSuccessAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

type OperationalSetting = { eventType: string; enabled: boolean; updatedAt: string };

type SettingsResponse = {
  schedules?: PushSchedule[];
  devices?: PushDevice[];
  operationalSettings?: OperationalSetting[];
  publicKey?: string;
  error?: string;
};

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DAYS = [
  { value: 1, label: "월" },
  { value: 2, label: "화" },
  { value: 3, label: "수" },
  { value: 4, label: "목" },
  { value: 5, label: "금" },
  { value: 6, label: "토" },
  { value: 0, label: "일" },
];

const CURRENT_DEVICE_KEY = "jumping-push-current-device";

const OPERATION_LABELS: Record<string, string> = {
  KIOSK_PAYMENT_CONFIRM_REQUIRED: "현금·계좌 결제 확인 요청",
  KIOSK_READY_TO_PLAY: "게임 시작 준비 완료",
  KIOSK_START_FAILED: "게임 시작 실패",
  KIOSK_STOP_FAILED: "게임 정지 실패",
  KIOSK_STAFF_HELP: "키오스크 직원 호출",
  KIOSK_ERROR: "키오스크 오류",
  BRIDGE_OFFLINE: "매장 브릿지 오프라인",
  CONTROL_ERROR: "게임 제어 오류",
  KIOSK_SESSION_STARTED: "키오스크 이용 시작",
};

function base64UrlToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function defaultDeviceName() {
  if (isIos()) return "내 iPhone";
  if (/android/i.test(navigator.userAgent)) return "내 Android 휴대폰";
  return "내 휴대폰";
}

async function storePushConfig(
  registration: ServiceWorkerRegistration,
  deviceId: string,
  deviceToken: string,
) {
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) throw new Error("휴대폰 알림 기능을 준비하는 중입니다. 잠시 후 다시 눌러주세요.");
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(
      () => reject(new Error("알림 기기 저장 시간이 초과되었습니다.")),
      5_000,
    );
    channel.port1.onmessage = () => {
      window.clearTimeout(timer);
      resolve();
    };
    worker.postMessage({ type: "PUSH_CONFIG", deviceId, deviceToken }, [channel.port2]);
  });
}

function displayTimestamp(value: string) {
  if (!value) return "아직 발송 기록 없음";
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date)
    : value;
}

export default function NotificationSettings({ operatorName }: { operatorName: string }) {
  const initialSchedule: PushSchedule = {
    id: "new-initial",
    name: "마감 매출",
    enabled: false,
    deliveryTime: "21:30",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    lastSentDate: "",
    sortOrder: 0,
    updatedAt: "",
  };
  const [schedules, setSchedules] = useState<PushSchedule[]>([initialSchedule]);
  const [savedSchedules, setSavedSchedules] = useState<PushSchedule[]>([initialSchedule]);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [operationalSettings, setOperationalSettings] = useState<OperationalSetting[]>([]);
  const [savedOperationalSettings, setSavedOperationalSettings] = useState<OperationalSetting[]>([]);
  const [publicKey, setPublicKey] = useState("");
  const [deviceName, setDeviceName] = useState("내 휴대폰");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  const [supported, setSupported] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>("default");

  const changed = JSON.stringify(schedules) !== JSON.stringify(savedSchedules) ||
    JSON.stringify(operationalSettings) !== JSON.stringify(savedOperationalSettings);
  const enabledDevices = useMemo(
    () => devices.filter((device) => device.enabled).length,
    [devices],
  );
  const enabledSchedules = useMemo(
    () => schedules.filter((schedule) => schedule.enabled),
    [schedules],
  );
  const nextDeliveryTime = useMemo(
    () => enabledSchedules.map((schedule) => schedule.deliveryTime).sort()[0] ?? "없음",
    [enabledSchedules],
  );
  const lastScheduledDate = useMemo(
    () => schedules.map((schedule) => schedule.lastSentDate).filter(Boolean).sort().at(-1) ?? "없음",
    [schedules],
  );

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const response = await fetch("/api/admin/notifications", { cache: "no-store" });
      const data = (await response.json()) as SettingsResponse;
      if (!response.ok || !data.schedules || !data.publicKey) {
        throw new Error(data.error ?? "알림 설정을 불러오지 못했습니다.");
      }
      setSchedules(data.schedules);
      setSavedSchedules(data.schedules);
      setDevices(data.devices ?? []);
      setOperationalSettings(data.operationalSettings ?? []);
      setSavedOperationalSettings(data.operationalSettings ?? []);
      setPublicKey(data.publicKey);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "알림 설정을 불러오지 못했습니다.");
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    setStandalone(isStandalone());
    setIos(isIos());
    setSupported(
      "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window,
    );
    if ("Notification" in window) setNotificationPermission(Notification.permission);
    setDeviceName(defaultDeviceName());
    const handlePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handlePrompt);
    void load();
    return () => window.removeEventListener("beforeinstallprompt", handlePrompt);
  }, []);

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setStandalone(true);
      setNotice("홈 화면 설치가 시작되었습니다. 설치된 앱에서 알림 기기를 등록해주세요.");
    }
    setInstallPrompt(null);
  }

  async function registerDevice() {
    if (!supported) {
      setNotice("이 브라우저에서는 휴대폰 알림을 사용할 수 없습니다.");
      return;
    }
    if (ios && !standalone) {
      setNotice("iPhone은 먼저 Safari 공유 버튼에서 ‘홈 화면에 추가’한 뒤, 설치된 앱에서 등록해주세요.");
      return;
    }
    setBusy("register");
    setNotice("");
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission !== "granted") throw new Error("휴대폰 알림 허용이 필요합니다.");
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToUint8Array(publicKey),
        });
      }
      const json = subscription.toJSON();
      const response = await fetch("/api/admin/notifications/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          endpoint: subscription.endpoint,
          keys: json.keys ?? {},
          deviceName,
        }),
      });
      const data = (await response.json()) as SettingsResponse & {
        deviceId?: string;
        deviceToken?: string;
      };
      if (!response.ok || !data.deviceId || !data.deviceToken) {
        throw new Error(data.error ?? "휴대폰을 등록하지 못했습니다.");
      }
      await storePushConfig(registration, data.deviceId, data.deviceToken);
      localStorage.setItem(CURRENT_DEVICE_KEY, data.deviceId);
      setDevices(data.devices ?? []);
      setNotice("이 휴대폰의 알림 등록이 끝났습니다. 시험 알림을 눌러 확인해보세요.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "휴대폰을 등록하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function saveSettings() {
    setBusy("save");
    setNotice("");
    try {
      const response = await fetch("/api/admin/notifications", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schedules, operationalSettings }),
      });
      const data = (await response.json()) as SettingsResponse;
      if (!response.ok || !data.schedules) {
        throw new Error(data.error ?? "설정을 저장하지 못했습니다.");
      }
      setSchedules(data.schedules);
      setSavedSchedules(data.schedules);
      setOperationalSettings(data.operationalSettings ?? operationalSettings);
      setSavedOperationalSettings(data.operationalSettings ?? operationalSettings);
      setNotice("예약 발송 설정을 저장했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "설정을 저장하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function testPush(deviceId?: string) {
    setBusy(`test-${deviceId ?? "all"}`);
    setNotice("");
    try {
      const response = await fetch("/api/admin/notifications/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "시험 알림을 보내지 못했습니다.");
      setNotice("시험 알림을 보냈습니다. 휴대폰 알림창을 확인해주세요.");
      await load(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "시험 알림을 보내지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function updateDevice(id: string, enabled: boolean) {
    setBusy(`device-${id}`);
    try {
      const response = await fetch("/api/admin/notifications/device", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      const data = (await response.json()) as SettingsResponse;
      if (!response.ok) throw new Error(data.error ?? "기기 설정을 변경하지 못했습니다.");
      setDevices(data.devices ?? []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "기기 설정을 변경하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  async function removeDevice(id: string) {
    setBusy(`device-${id}`);
    try {
      const response = await fetch(
        `/api/admin/notifications/device?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const data = (await response.json()) as SettingsResponse;
      if (!response.ok) throw new Error(data.error ?? "기기를 삭제하지 못했습니다.");
      setDevices(data.devices ?? []);
      if (localStorage.getItem(CURRENT_DEVICE_KEY) === id) {
        localStorage.removeItem(CURRENT_DEVICE_KEY);
        const registration = await navigator.serviceWorker.ready;
        await (await registration.pushManager.getSubscription())?.unsubscribe();
      }
      setNotice("알림 기기를 삭제했습니다.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "기기를 삭제하지 못했습니다.");
    } finally {
      setBusy("");
    }
  }

  function updateSchedule(id: string, changes: Partial<PushSchedule>) {
    setSchedules((current) => current.map((schedule) =>
      schedule.id === id ? { ...schedule, ...changes } : schedule,
    ));
  }

  function toggleDay(id: string, value: number) {
    setSchedules((current) => current.map((schedule) => schedule.id === id
      ? {
          ...schedule,
          weekdays: schedule.weekdays.includes(value)
            ? schedule.weekdays.filter((day) => day !== value)
            : [...schedule.weekdays, value].sort((left, right) => left - right),
        }
      : schedule));
  }

  function addSchedule() {
    if (schedules.length >= 8) {
      setNotice("예약 알림은 최대 8개까지 설정할 수 있습니다.");
      return;
    }
    const index = schedules.length + 1;
    setSchedules((current) => [...current, {
      id: `new-${Date.now()}`,
      name: `매출 브리핑 ${index}`,
      enabled: true,
      deliveryTime: "21:30",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      lastSentDate: "",
      sortOrder: current.length,
      updatedAt: "",
    }]);
  }

  function removeSchedule(id: string) {
    setSchedules((current) => current
      .filter((schedule) => schedule.id !== id)
      .map((schedule, index) => ({ ...schedule, sortOrder: index })));
  }

  function toggleOperationalSetting(eventType: string, enabled: boolean) {
    setOperationalSettings((current) => current.map((setting) =>
      setting.eventType === eventType ? { ...setting, enabled } : setting,
    ));
  }

  return (
    <main className="notification-settings-shell">
      <header className="notification-settings-header">
        <div>
          <p className="eyebrow">JUMPING BATTLE · MOBILE BRIEFING</p>
          <h1>휴대폰 매출 알림</h1>
          <p>사이트를 앱처럼 설치하고 원하는 요일과 시간에 당일 매출 요약을 받습니다.</p>
        </div>
        <nav aria-label="관리자 메뉴">
          <a href="/admin">통합 운영 관리</a>
          <a href="/admin/analytics">매출 분석</a>
          <a href="/admin/settings">가격 설정</a>
          <span>{operatorName}</span>
        </nav>
      </header>

      <section className="notification-overview">
        <article><span>예약 알림</span><strong>{enabledSchedules.length}개 사용 중</strong><small>가장 빠른 발송 {nextDeliveryTime}</small></article>
        <article><span>알림 기기</span><strong>{enabledDevices}대</strong><small>등록 {devices.length}대</small></article>
        <article><span>최근 예약 발송</span><strong>{lastScheduledDate}</strong><small>한국 시간 기준</small></article>
      </section>

      <div className="notification-settings-grid">
        <section className="notification-settings-card notification-install-card">
          <div className="notification-card-heading">
            <div><span>01</span><h2>홈 화면 설치</h2></div>
            <b>{standalone ? "설치됨" : "설치 필요"}</b>
          </div>
          <p>Chrome은 아래 버튼을 누르고, iPhone은 Safari의 공유 버튼 → ‘홈 화면에 추가’를 선택하세요.</p>
          {installPrompt ? (
            <button type="button" className="notification-primary" onClick={installApp}>홈 화면에 설치</button>
          ) : standalone ? (
            <div className="notification-success">현재 설치된 앱으로 접속 중입니다.</div>
          ) : (
            <div className="notification-guide">{ios ? "Safari 하단 공유 버튼에서 홈 화면에 추가해주세요." : "브라우저 메뉴의 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 선택해주세요."}</div>
          )}
        </section>

        <section className="notification-settings-card">
          <div className="notification-card-heading">
            <div><span>02</span><h2>이 휴대폰 등록</h2></div>
            <b>{notificationPermission === "granted" ? "알림 허용" : "등록 전"}</b>
          </div>
          <label className="notification-device-name">
            <span>기기 이름</span>
            <input value={deviceName} maxLength={60} onChange={(event) => setDeviceName(event.target.value)} />
          </label>
          <button type="button" className="notification-primary" disabled={loading || busy === "register"} onClick={registerDevice}>
            {busy === "register" ? "등록 중…" : "이 휴대폰 알림 등록"}
          </button>
          {!supported ? <p className="notification-warning">현재 브라우저는 앱 알림을 지원하지 않습니다.</p> : null}
        </section>

        <section className="notification-settings-card notification-schedule-card">
          <div className="notification-card-heading">
            <div><span>03</span><h2>예약 발송</h2></div>
            <button type="button" className="notification-add-schedule" onClick={addSchedule}>+ 알림 시간 추가</button>
          </div>
          <div className="notification-schedule-list">
            {schedules.length === 0 ? (
              <div className="notification-empty">설정된 예약 알림이 없습니다. ‘알림 시간 추가’를 눌러주세요.</div>
            ) : schedules.map((schedule, index) => (
              <article className="notification-schedule-item" key={schedule.id}>
                <div className="notification-schedule-item-head">
                  <strong>알림 {index + 1}</strong>
                  <div>
                    <label className="notification-switch compact">
                      <input type="checkbox" checked={schedule.enabled} onChange={(event) => updateSchedule(schedule.id, { enabled: event.target.checked })} />
                      <span aria-hidden="true" />
                      <b>{schedule.enabled ? "사용" : "중지"}</b>
                    </label>
                    <button type="button" className="notification-remove-schedule" onClick={() => removeSchedule(schedule.id)}>삭제</button>
                  </div>
                </div>
                <div className="notification-schedule-fields">
                  <label className="notification-schedule-name">
                    <span>알림 이름</span>
                    <input maxLength={40} value={schedule.name} onChange={(event) => updateSchedule(schedule.id, { name: event.target.value })} />
                  </label>
                  <label className="notification-time-field">
                    <span>발송 시간</span>
                    <input type="time" value={schedule.deliveryTime} onChange={(event) => updateSchedule(schedule.id, { deliveryTime: event.target.value })} />
                  </label>
                </div>
                <fieldset className="notification-days">
                  <legend>발송 요일</legend>
                  <div>
                    {DAYS.map((day) => (
                      <button type="button" key={day.value} className={schedule.weekdays.includes(day.value) ? "active" : ""} onClick={() => toggleDay(schedule.id, day.value)}>{day.label}</button>
                    ))}
                  </div>
                </fieldset>
                <small className="notification-last-sent">최근 발송: {schedule.lastSentDate || "없음"}</small>
              </article>
            ))}
          </div>
          <div className="notification-schedule-actions">
            <button type="button" className="notification-secondary" disabled={!changed || Boolean(busy)} onClick={() => { setSchedules(savedSchedules); setOperationalSettings(savedOperationalSettings); }}>취소</button>
            <button type="button" className="notification-primary" disabled={!changed || Boolean(busy)} onClick={saveSettings}>{busy === "save" ? "저장 중…" : "예약 설정 저장"}</button>
          </div>
          <p className="notification-schedule-note">매장 브릿지 연결 중에는 발송 시각을 계속 확인합니다. 관리자 화면을 열어둔 경우에도 함께 점검합니다.</p>
        </section>

        <section className="notification-settings-card notification-schedule-card">
          <div className="notification-card-heading"><div><span>04</span><h2>무인운영 알림</h2></div></div>
          <p>고객 개인정보 없이 처리할 운영 상태만 등록된 관리자 휴대폰으로 알립니다.</p>
          <div className="notification-schedule-list">
            {operationalSettings.map((setting) => <article className="notification-schedule-item" key={setting.eventType}>
              <div className="notification-schedule-item-head">
                <strong>{OPERATION_LABELS[setting.eventType] || setting.eventType}</strong>
                <label className="notification-switch compact">
                  <input type="checkbox" checked={setting.enabled} onChange={(event) => toggleOperationalSetting(setting.eventType, event.target.checked)} />
                  <span aria-hidden="true" /><b>{setting.enabled ? "사용" : "중지"}</b>
                </label>
              </div>
            </article>)}
          </div>
        </section>
      </div>

      <section className="notification-devices-card">
        <div className="notification-devices-heading">
          <div><p className="eyebrow">REGISTERED DEVICES</p><h2>알림 받을 기기</h2></div>
          <button type="button" className="notification-test-all" disabled={enabledDevices === 0 || Boolean(busy)} onClick={() => testPush()}>{busy === "test-all" ? "발송 중…" : "전체 시험 알림"}</button>
        </div>
        {devices.length === 0 ? (
          <div className="notification-empty">아직 등록된 휴대폰이 없습니다. 위에서 이 휴대폰을 먼저 등록해주세요.</div>
        ) : (
          <div className="notification-device-list">
            {devices.map((device) => (
              <article key={device.id}>
                <div className="notification-device-icon" aria-hidden="true">●</div>
                <div className="notification-device-info">
                  <strong>{device.deviceName}</strong>
                  <span>최근 성공 {displayTimestamp(device.lastSuccessAt)}</span>
                  {device.lastError ? <small>{device.lastError}</small> : null}
                </div>
                <label className="notification-switch compact">
                  <input type="checkbox" checked={device.enabled} disabled={busy === `device-${device.id}`} onChange={(event) => updateDevice(device.id, event.target.checked)} />
                  <span aria-hidden="true" />
                  <b>{device.enabled ? "사용" : "중지"}</b>
                </label>
                <button type="button" className="notification-device-test" disabled={!device.enabled || Boolean(busy)} onClick={() => testPush(device.id)}>시험</button>
                <button type="button" className="notification-device-remove" disabled={Boolean(busy)} onClick={() => removeDevice(device.id)}>삭제</button>
              </article>
            ))}
          </div>
        )}
      </section>

      <div className={`notification-notice ${notice ? "show" : ""}`} role="status" aria-live="polite">{notice}</div>
    </main>
  );
}
