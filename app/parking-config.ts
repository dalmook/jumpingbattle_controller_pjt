export const DEFAULT_PARKING_REGISTRATION_URL =
  "https://parking.example.com/discount/registration?SWversion=ATS3000V2.89_20231018";

export type ParkingSettings = {
  enabled: boolean;
  autoRegistrationEnabled: boolean;
  registrationUrl: string;
  sessionMaxSeconds: number;
};

export const DEFAULT_PARKING_SETTINGS: ParkingSettings = {
  enabled: false,
  autoRegistrationEnabled: false,
  registrationUrl: DEFAULT_PARKING_REGISTRATION_URL,
  sessionMaxSeconds: 30,
};

export function isAllowedParkingRegistrationUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "parking.example.com"
      && url.pathname.startsWith("/discount/registration");
  } catch {
    return false;
  }
}

export function sanitizeParkingSettings(input: unknown): ParkingSettings | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const registrationUrl = String(source.registrationUrl ?? "").trim();
  const sessionMaxSeconds = Math.trunc(Number(source.sessionMaxSeconds));
  if (!isAllowedParkingRegistrationUrl(registrationUrl)) return null;
  if (!Number.isInteger(sessionMaxSeconds) || sessionMaxSeconds < 30 || sessionMaxSeconds > 300) return null;
  return {
    enabled: source.enabled === true,
    autoRegistrationEnabled: source.autoRegistrationEnabled === true,
    registrationUrl,
    sessionMaxSeconds,
  };
}
