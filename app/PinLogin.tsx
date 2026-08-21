"use client";

import { FormEvent, useState } from "react";

export default function PinLogin() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{4}$/.test(pin)) {
      setError("PIN 번호 4자리를 입력해주세요.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pin-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "로그인하지 못했습니다.");
      window.location.reload();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "로그인하지 못했습니다.",
      );
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="pin-form" onSubmit={submit}>
      <label htmlFor="operator-pin">운영자 PIN</label>
      <input
        id="operator-pin"
        className="pin-input"
        type="password"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{4}"
        maxLength={4}
        value={pin}
        disabled={busy}
        onChange={(event) =>
          setPin(event.target.value.replace(/\D/g, "").slice(0, 4))
        }
        aria-describedby={error ? "pin-error" : "pin-help"}
        autoFocus
      />
      <p id="pin-help" className="pin-help">
        로그인 상태는 이 기기에서 12시간 유지됩니다.
      </p>
      {error ? (
        <p id="pin-error" className="signin-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="signin-button" type="submit" disabled={busy}>
        {busy ? "확인 중…" : "운영실 입장"}
      </button>
    </form>
  );
}
