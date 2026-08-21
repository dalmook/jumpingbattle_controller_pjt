export const PAYMENT_BRIDGE_MIN_VERSION = "0.6.0";
export const PAYMENT_FAST_LANE_MIN_VERSION = "0.6.2";
export const CONTROL_FAST_LANE_MIN_VERSION = "0.6.3";
export const PARKING_BRIDGE_MIN_VERSION = "0.6.4";

function versionParts(value: string) {
  const match = String(value ?? "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function supportsPaymentCommands(version: string) {
  const current = versionParts(version);
  const minimum = versionParts(PAYMENT_BRIDGE_MIN_VERSION);
  if (!current || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

export function supportsPaymentFastLane(version: string) {
  const current = versionParts(version);
  const minimum = versionParts(PAYMENT_FAST_LANE_MIN_VERSION);
  if (!current || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

export function supportsControlFastLane(version: string) {
  const current = versionParts(version);
  const minimum = versionParts(CONTROL_FAST_LANE_MIN_VERSION);
  if (!current || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

export function supportsParkingCommands(version: string) {
  const current = versionParts(version);
  const minimum = versionParts(PARKING_BRIDGE_MIN_VERSION);
  if (!current || !minimum) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}
