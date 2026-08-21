export function normalizeMemberPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("82")) return `0${digits.slice(2)}`.slice(0, 11);
  return digits.slice(0, 11);
}

export function formatMemberPhone(value: string) {
  const phone = normalizeMemberPhone(value);
  if (phone.length === 11) return `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
  if (phone.length === 10) return `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}`;
  return phone;
}

export function getVehicleLast4(vehicleNumber: string) {
  const digits = String(vehicleNumber ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}
