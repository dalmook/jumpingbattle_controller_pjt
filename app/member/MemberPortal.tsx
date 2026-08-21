"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { CustomerMemberDashboard } from "@/db/member-auth";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type AuthMode = "login" | "signup" | "reset";

function formatPhoneInput(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

function dateLabel(value: string) {
  if (!value) return "유효기간 없음";
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T23:59:59+09:00`
    : value.includes("T")
      ? value
      : `${value.replace(" ", "T")}+09:00`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function shortDate(value: string) {
  const date = new Date(`${value}T12:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function statusLabel(status: string, usable: boolean) {
  if (usable) return "사용 가능";
  if (status === "USED" || status === "USED_UP") return "사용 완료";
  if (status === "EXPIRED") return "기간 만료";
  if (status === "CANCELLED") return "사용 불가";
  return "사용 불가";
}

function PasswordField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="member-field">
      <span>{label}</span>
      <div className="member-password-field">
        <input
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={label === "비밀번호" ? "current-password" : "new-password"}
        />
        <button type="button" onClick={() => setVisible((current) => !current)}>
          {visible ? "숨김" : "보기"}
        </button>
      </div>
    </label>
  );
}

export default function MemberPortal({
  initialDashboard,
}: {
  initialDashboard: CustomerMemberDashboard | null;
}) {
  const [dashboard, setDashboard] = useState(initialDashboard);
  const [mode, setMode] = useState<AuthMode>("login");
  const [signupStep, setSignupStep] = useState(1);
  const [resetStep, setResetStep] = useState(1);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [teamName, setTeamName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [signupComplete, setSignupComplete] = useState(false);
  const [passwordResetComplete, setPasswordResetComplete] = useState(false);
  const [resetNotice, setResetNotice] = useState("");
  const [migrated, setMigrated] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileName, setProfileName] = useState(initialDashboard?.member.name ?? "");
  const [profileTeam, setProfileTeam] = useState(initialDashboard?.member.teamName ?? "");

  useEffect(() => {
    setInstalled(window.matchMedia("(display-mode: standalone)").matches);
    const captureInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const completeInstall = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", captureInstall);
    window.addEventListener("appinstalled", completeInstall);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstall);
      window.removeEventListener("appinstalled", completeInstall);
    };
  }, []);

  async function installApp() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setInstallPrompt(null);
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    if (!password && phone.replace(/\D/g, "").length >= 10) {
      setMode("reset");
      setResetStep(1);
      setName("");
      setResetNotice("휴대폰 번호를 확인했어요. 가입할 때 입력한 이름을 확인해주세요.");
      setError("");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/member/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, password }),
      });
      const data = await response.json() as { dashboard?: CustomerMemberDashboard; error?: string };
      if (!response.ok || !data.dashboard) throw new Error(data.error ?? "로그인하지 못했습니다.");
      setDashboard(data.dashboard);
      setProfileName(data.dashboard.member.name);
      setProfileTeam(data.dashboard.member.teamName);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "로그인하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function findRegisteredAccount() {
    const response = await fetch("/api/member/auth/account-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const data = await response.json() as { existing?: boolean; registered?: boolean; error?: string };
    if (!response.ok) throw new Error(data.error ?? "회원정보를 확인하지 못했습니다.");
    return data;
  }

  async function openSignupOrReset() {
    setError("");
    setResetNotice("");
    if (phone.replace(/\D/g, "").length >= 10) {
      setBusy(true);
      try {
        const account = await findRegisteredAccount();
        if (account.registered) {
          setMode("reset");
          setResetStep(1);
          setName("");
          setResetNotice("기존에 가입된 계정을 찾았어요. 이름을 확인한 뒤 새 비밀번호를 설정해주세요.");
          return;
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "회원정보를 확인하지 못했습니다.");
        return;
      } finally {
        setBusy(false);
      }
    }
    setMode("signup");
    setSignupStep(1);
  }

  function validateSignupStep() {
    if (signupStep === 1) {
      if (!name.trim()) return "이름을 입력해주세요.";
      if (phone.replace(/\D/g, "").length < 10) return "휴대폰 번호를 확인해주세요.";
    }
    if (signupStep === 2) {
      if (!password) return "비밀번호를 입력해주세요.";
      if (password !== passwordConfirm) return "비밀번호 확인이 일치하지 않습니다.";
    }
    if (signupStep === 3 && !agreed) return "필수 약관에 동의해주세요.";
    return "";
  }

  async function signupNext(event: FormEvent) {
    event.preventDefault();
    const validation = validateSignupStep();
    if (validation) {
      setError(validation);
      return;
    }
    setError("");
    if (signupStep === 1) {
      setBusy(true);
      try {
        const account = await findRegisteredAccount();
        if (account.registered) {
          setMode("reset");
          setResetStep(2);
          setPassword("");
          setPasswordConfirm("");
          setResetNotice("기존에 가입된 계정을 찾았어요. 새 비밀번호만 설정하면 바로 이용할 수 있어요.");
        } else {
          setSignupStep(2);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "회원정보를 확인하지 못했습니다.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (signupStep < 3) {
      setSignupStep((current) => current + 1);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/member/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, phone, password, teamName, agreed }),
      });
      const data = await response.json() as {
        dashboard?: CustomerMemberDashboard;
        migrated?: boolean;
        code?: string;
        error?: string;
      };
      if (data.code === "MEMBER_ACCOUNT_EXISTS") {
        setMode("reset");
        setResetStep(2);
        setPassword("");
        setPasswordConfirm("");
        setResetNotice("이미 가입된 계정이에요. 새 비밀번호를 설정하면 바로 이용할 수 있어요.");
        return;
      }
      if (!response.ok || !data.dashboard) throw new Error(data.error ?? "회원가입을 완료하지 못했습니다.");
      setDashboard(data.dashboard);
      setProfileName(data.dashboard.member.name);
      setProfileTeam(data.dashboard.member.teamName);
      setMigrated(Boolean(data.migrated));
      setSignupComplete(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "회원가입을 완료하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPasswordNext(event: FormEvent) {
    event.preventDefault();
    if (resetStep === 1) {
      if (!name.trim()) {
        setError("가입할 때 입력한 이름을 입력해주세요.");
        return;
      }
      if (phone.replace(/\D/g, "").length < 10) {
        setError("휴대폰 번호를 확인해주세요.");
        return;
      }
      setError("");
      setResetStep(2);
      return;
    }
    if (!password) {
      setError("새 비밀번호를 입력해주세요.");
      return;
    }
    if (password !== passwordConfirm) {
      setError("비밀번호 확인이 일치하지 않습니다.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/member/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, phone, password }),
      });
      const data = await response.json() as { dashboard?: CustomerMemberDashboard; error?: string };
      if (!response.ok || !data.dashboard) throw new Error(data.error ?? "비밀번호를 변경하지 못했습니다.");
      setDashboard(data.dashboard);
      setProfileName(data.dashboard.member.name);
      setProfileTeam(data.dashboard.member.teamName);
      setPasswordResetComplete(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "비밀번호를 변경하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/member/auth/logout", { method: "POST" });
    setDashboard(null);
    setSignupComplete(false);
    setPasswordResetComplete(false);
    setMode("login");
    setPassword("");
    setPasswordConfirm("");
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/member/me", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: profileName, teamName: profileTeam }),
      });
      const data = await response.json() as { dashboard?: CustomerMemberDashboard; error?: string };
      if (!response.ok || !data.dashboard) throw new Error(data.error ?? "저장하지 못했습니다.");
      setDashboard(data.dashboard);
      setEditingProfile(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const activePasses = useMemo(() => dashboard?.passes.filter((pass) => pass.usable) ?? [], [dashboard]);
  const inactivePasses = useMemo(() => dashboard?.passes.filter((pass) => !pass.usable) ?? [], [dashboard]);
  const activeCoupons = useMemo(() => dashboard?.coupons.filter((coupon) => coupon.usable) ?? [], [dashboard]);
  const inactiveCoupons = useMemo(() => dashboard?.coupons.filter((coupon) => !coupon.usable) ?? [], [dashboard]);

  if (passwordResetComplete && dashboard) {
    return (
      <main className="member-auth-shell">
        <section className="member-complete-card">
          <div className="member-complete-check">✓</div>
          <p className="member-eyebrow">PASSWORD UPDATED</p>
          <h1>{dashboard.member.name}님,<br />비밀번호를 변경했어요.</h1>
          <p>새 비밀번호로 안전하게 변경했고, MY 화면에도 로그인했어요.</p>
          <button className="member-primary-button" type="button" onClick={() => setPasswordResetComplete(false)}>내 이용권 보기</button>
        </section>
      </main>
    );
  }

  if (signupComplete && dashboard) {
    return (
      <main className="member-auth-shell">
        <section className="member-complete-card">
          <div className="member-complete-check">✓</div>
          <p className="member-eyebrow">WELCOME TO JUMPING BATTLE</p>
          <h1>{dashboard.member.name}님,<br />가입이 완료됐어요.</h1>
          <p>{migrated ? "기존 회원정보와 이용권·스탬프를 그대로 연결했어요." : "이제 이용권과 스탬프를 휴대폰에서 바로 확인할 수 있어요."}</p>
          <div className="member-complete-summary">
            <span><small>사용 가능한 이용권</small><strong>{activePasses.length}개</strong></span>
            <span><small>무료 이용권</small><strong>{activeCoupons.length}장</strong></span>
          </div>
          {!installed ? (
            <div className="member-install-card">
              <span className="member-app-icon">JB</span>
              <div><strong>점핑배틀 MY 앱 설치</strong><small>다음부터 홈 화면에서 한 번에 열어요.</small></div>
              {installPrompt ? <button type="button" onClick={() => void installApp()}>설치</button> : <em>브라우저 메뉴 → 홈 화면에 추가</em>}
            </div>
          ) : null}
          <button className="member-primary-button" type="button" onClick={() => setSignupComplete(false)}>내 이용권 보기</button>
        </section>
      </main>
    );
  }

  if (!dashboard) {
    return (
      <main className="member-auth-shell">
        <header className="member-auth-header">
          <div className="member-mini-brand"><span>JB</span><b>점핑배틀 MY</b></div>
        </header>
        <section className="member-auth-card">
          <div className="member-auth-intro">
            <p className="member-eyebrow">JUMPING BATTLE · 화성병점점</p>
            <h1>{mode === "login" ? <>내 이용권을<br />확인해볼까요?</> : mode === "signup" ? <>간단하게 가입하고<br />혜택을 모아보세요.</> : <>새 비밀번호를<br />설정해볼까요?</>}</h1>
            <p>{mode === "login" ? "다회권, 무료 이용권과 스탬프를 한눈에 확인해요." : mode === "signup" ? "기존 회원은 같은 휴대폰 번호로 가입하면 보유 혜택이 그대로 연결돼요." : "가입할 때 입력한 이름과 휴대폰 번호로 회원정보를 확인해요."}</p>
          </div>

          {mode === "login" ? (
            <form className="member-auth-form" onSubmit={login}>
              <label className="member-field"><span>휴대폰 번호</span><input type="tel" inputMode="numeric" autoComplete="username" value={phone} onChange={(event) => setPhone(formatPhoneInput(event.target.value))} placeholder="010-0000-0000" /></label>
              <PasswordField label="비밀번호" value={password} onChange={setPassword} placeholder="비밀번호 입력" />
              {error ? <p className="member-form-error" role="alert">{error}</p> : null}
              <button className="member-primary-button" type="submit" disabled={busy}>{busy ? "로그인 중…" : "로그인"}</button>
              <button className="member-text-button" type="button" onClick={() => { setMode("reset"); setResetStep(1); setName(""); setPassword(""); setPasswordConfirm(""); setResetNotice(""); setError(""); }}>비밀번호를 잊으셨나요? <b>비밀번호 찾기</b></button>
              <button className="member-text-button" type="button" disabled={busy} onClick={() => void openSignupOrReset()}>처음이신가요? <b>회원가입</b></button>
            </form>
          ) : mode === "signup" ? (
            <form className="member-auth-form member-signup-form" onSubmit={signupNext}>
              <div className="member-signup-progress" aria-label={`회원가입 ${signupStep}단계`}><span>{signupStep}</span><i><b style={{ width: `${signupStep / 3 * 100}%` }} /></i><small>3</small></div>
              {signupStep === 1 ? <>
                <div className="member-step-copy"><span>STEP 1</span><h2>회원님을 알려주세요</h2><p>휴대폰 번호가 로그인 아이디가 됩니다.</p></div>
                <label className="member-field"><span>이름</span><input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="이름 입력" /></label>
                <label className="member-field"><span>휴대폰 번호</span><input type="tel" inputMode="numeric" autoComplete="tel" value={phone} onChange={(event) => setPhone(formatPhoneInput(event.target.value))} placeholder="010-0000-0000" /></label>
              </> : null}
              {signupStep === 2 ? <>
                <div className="member-step-copy"><span>STEP 2</span><h2>비밀번호를 만들어주세요</h2><p>로그인할 때 사용할 비밀번호를 입력해주세요.</p></div>
                <PasswordField label="비밀번호" value={password} onChange={setPassword} placeholder="비밀번호 입력" />
                <PasswordField label="비밀번호 확인" value={passwordConfirm} onChange={setPasswordConfirm} placeholder="한 번 더 입력" />
                {passwordConfirm ? <p className={`member-password-match ${password === passwordConfirm ? "is-match" : ""}`}>{password === passwordConfirm ? "✓ 비밀번호가 일치해요" : "비밀번호가 일치하지 않아요"}</p> : null}
              </> : null}
              {signupStep === 3 ? <>
                <div className="member-step-copy"><span>STEP 3</span><h2>마지막으로 확인해주세요</h2><p>팀명은 나중에 MY에서도 수정할 수 있어요.</p></div>
                <label className="member-field"><span>팀명 <small>선택</small></span><input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="등록하지 않아도 괜찮아요" maxLength={80} /></label>
                <label className={`member-terms ${agreed ? "is-checked" : ""}`}><input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} /><i>{agreed ? "✓" : ""}</i><span><b>필수 약관에 모두 동의합니다</b><small>서비스 이용약관 및 개인정보 수집·이용 동의</small></span></label>
                <details className="member-terms-detail"><summary>약관 내용 보기</summary><p>회원 서비스 제공을 위해 이름과 휴대폰 번호를 저장하며, 회원 탈퇴 또는 관계 법령상 보관기간까지 관리합니다. 비밀번호는 복원할 수 없는 형태로 보호됩니다.</p></details>
              </> : null}
              {error ? <p className="member-form-error" role="alert">{error}</p> : null}
              <div className="member-signup-actions">{signupStep > 1 ? <button type="button" onClick={() => { setSignupStep((current) => current - 1); setError(""); }}>이전</button> : null}<button className="member-primary-button" type="submit" disabled={busy}>{busy ? "처리 중…" : signupStep === 3 ? "동의하고 가입하기" : "다음"}</button></div>
              <button className="member-text-button" type="button" onClick={() => { setMode("login"); setError(""); }}>이미 가입하셨나요? <b>로그인</b></button>
            </form>
          ) : (
            <form className="member-auth-form member-signup-form" onSubmit={resetPasswordNext}>
              <div className="member-signup-progress" aria-label={`비밀번호 찾기 ${resetStep}단계`}><span>{resetStep}</span><i><b style={{ width: `${resetStep / 2 * 100}%` }} /></i><small>2</small></div>
              {resetStep === 1 ? <>
                <div className="member-step-copy"><span>STEP 1</span><h2>회원정보를 확인할게요</h2><p>가입할 때 입력한 정보와 같아야 해요.</p></div>
                <label className="member-field"><span>이름</span><input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="가입 시 입력한 이름" /></label>
                <label className="member-field"><span>휴대폰 번호</span><input type="tel" inputMode="numeric" autoComplete="username" value={phone} onChange={(event) => setPhone(formatPhoneInput(event.target.value))} placeholder="010-0000-0000" /></label>
              </> : <>
                <div className="member-step-copy"><span>STEP 2</span><h2>새 비밀번호를 입력해주세요</h2><p>앞으로 로그인할 때 사용할 비밀번호예요.</p></div>
                {resetNotice ? <p className="member-form-notice">{resetNotice}</p> : null}
                <PasswordField label="새 비밀번호" value={password} onChange={setPassword} placeholder="새 비밀번호 입력" />
                <PasswordField label="새 비밀번호 확인" value={passwordConfirm} onChange={setPasswordConfirm} placeholder="한 번 더 입력" />
                {passwordConfirm ? <p className={`member-password-match ${password === passwordConfirm ? "is-match" : ""}`}>{password === passwordConfirm ? "✓ 비밀번호가 일치해요" : "비밀번호가 일치하지 않아요"}</p> : null}
              </>}
              {error ? <p className="member-form-error" role="alert">{error}</p> : null}
              <div className="member-signup-actions">{resetStep > 1 ? <button type="button" onClick={() => { setResetStep(1); setError(""); }}>이전</button> : null}<button className="member-primary-button" type="submit" disabled={busy}>{busy ? "변경 중…" : resetStep === 1 ? "다음" : "새 비밀번호 저장"}</button></div>
              <button className="member-text-button" type="button" onClick={() => { setMode("login"); setError(""); }}>비밀번호가 기억났나요? <b>로그인</b></button>
            </form>
          )}
        </section>
      </main>
    );
  }

  const totalAvailable = activePasses.reduce((sum, pass) => sum + pass.remainingUses, 0);
  const stampPercent = Math.min(100, Math.round(dashboard.stamp.balance / Math.max(1, dashboard.stamp.goal) * 100));
  return (
    <main className="member-my-shell">
      <header className="member-my-header">
        <div className="member-mini-brand"><span>JB</span><b>점핑배틀 MY</b></div>
        <div className="member-my-actions"><a href="/reserve">오늘 예약</a>{!installed && installPrompt ? <button type="button" onClick={() => void installApp()}>앱 설치</button> : null}<button type="button" onClick={() => void logout()}>로그아웃</button></div>
      </header>

      <section className="member-my-hero">
        <div><p>안녕하세요,</p><h1>{dashboard.member.name}님 👋</h1><span>{dashboard.member.teamName || "팀명 미등록"}</span></div>
        <article><small>지금 사용 가능한 횟수</small><strong>{totalAvailable}<b>회</b></strong><span>무료 이용권 {activeCoupons.length}장</span></article>
      </section>

      <section className="member-my-section" id="passes">
        <header><div><span>MY PASSES</span><h2>내 이용권</h2></div><b>{activePasses.length}개 사용 가능</b></header>
        {activePasses.length ? <div className="member-pass-list">{activePasses.map((pass) => <article className="member-pass-card" key={pass.id}><div className="member-pass-top"><span>사용 가능</span><small>{pass.remainingUses} / {pass.purchasedUses}회</small></div><h3>{pass.productName}</h3><strong>{pass.remainingUses}<b>회 남음</b></strong><footer><span>유효기간</span><b>{dateLabel(pass.expiresAt)}</b></footer></article>)}</div> : <div className="member-empty-card"><span>🎟️</span><b>현재 사용 가능한 다회권이 없어요</b><small>이용권 구매는 매장에서 도와드려요.</small></div>}
        {inactivePasses.length ? <details className="member-past-benefits"><summary>지난 이용권 {inactivePasses.length}개</summary><div>{inactivePasses.map((pass) => <article key={pass.id}><span>{statusLabel(pass.status, pass.usable)}</span><b>{pass.productName}</b><small>{pass.remainingUses}회 · {dateLabel(pass.expiresAt)}</small></article>)}</div></details> : null}
      </section>

      <section className="member-my-section" id="coupons">
        <header><div><span>FREE TICKETS</span><h2>무료 이용권</h2></div><b>{activeCoupons.length}장</b></header>
        {activeCoupons.length ? <div className="member-coupon-list">{activeCoupons.map((coupon) => <article className="member-coupon-card" key={coupon.id}><div><span>무료 이용</span><strong>1장</strong></div><h3>{coupon.productName}</h3><p>{coupon.conditions}</p><footer><b>{dateLabel(coupon.expiresAt)}까지</b><span>사용 가능</span></footer></article>)}</div> : <div className="member-empty-inline"><span>현재 사용할 수 있는 무료 이용권이 없어요.</span></div>}
        {inactiveCoupons.length ? <details className="member-past-benefits"><summary>지난 무료 이용권 {inactiveCoupons.length}장</summary><div>{inactiveCoupons.map((coupon) => <article key={coupon.id}><span>{statusLabel(coupon.status, coupon.usable)}</span><b>{coupon.productName}</b><small>{dateLabel(coupon.expiresAt)}</small></article>)}</div></details> : null}
      </section>

      <section className="member-my-section" id="stamp">
        <header><div><span>STAMP</span><h2>스탬프 현황</h2></div><b>{dashboard.stamp.balance} / {dashboard.stamp.goal}</b></header>
        <article className="member-stamp-card"><div><strong>{dashboard.stamp.balance}<small>개</small></strong><span>{Math.max(0, dashboard.stamp.goal - dashboard.stamp.balance)}개 더 모으면<br />무료 이용권이 생겨요.</span></div><div className="member-stamp-progress"><i style={{ width: `${stampPercent}%` }} /></div><footer>{Array.from({ length: dashboard.stamp.goal }, (_, index) => <i className={index < dashboard.stamp.balance ? "is-filled" : ""} key={index}>{index < dashboard.stamp.balance ? "✓" : ""}</i>)}</footer></article>
      </section>

      <section className="member-my-section" id="history">
        <header><div><span>RECENT</span><h2>최근 이용내역</h2></div></header>
        {dashboard.recentVisits.length ? <div className="member-history-list">{dashboard.recentVisits.map((visit) => <article key={visit.id}><div className="member-history-date"><strong>{shortDate(visit.date)}</strong><small>{visit.time}</small></div><div><b>{visit.roomCode} · {visit.teamName || dashboard.member.teamName || "점핑배틀"}</b><span>{visit.people}명 · {visit.status === "completed" ? "이용 완료" : "예약 내역"}</span></div><i>›</i></article>)}</div> : <div className="member-empty-inline"><span>아직 연결된 이용내역이 없어요.</span></div>}
      </section>

      <section className="member-my-section member-profile-section" id="profile">
        <header><div><span>PROFILE</span><h2>내 정보</h2></div><button type="button" onClick={() => { setEditingProfile((current) => !current); setError(""); }}>{editingProfile ? "닫기" : "수정"}</button></header>
        {editingProfile ? <form className="member-profile-form" onSubmit={saveProfile}><label className="member-field"><span>이름</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label><label className="member-field"><span>팀명 <small>선택</small></span><input value={profileTeam} onChange={(event) => setProfileTeam(event.target.value)} placeholder="미등록" /></label>{error ? <p className="member-form-error" role="alert">{error}</p> : null}<button className="member-primary-button" type="submit" disabled={busy}>{busy ? "저장 중…" : "변경 내용 저장"}</button></form> : <dl className="member-profile-list"><div><dt>이름</dt><dd>{dashboard.member.name}</dd></div><div><dt>휴대폰 번호</dt><dd>{dashboard.member.phone}</dd></div><div><dt>팀명</dt><dd className={dashboard.member.teamName ? "" : "is-empty"}>{dashboard.member.teamName || "미등록"}</dd></div><div><dt>가입일</dt><dd>{dateLabel(dashboard.member.createdAt)}</dd></div></dl>}
      </section>

      {!installed ? <section className="member-install-banner"><span className="member-app-icon">JB</span><div><b>홈 화면에서 바로 확인하세요</b><small>점핑배틀 MY를 앱처럼 설치할 수 있어요.</small></div>{installPrompt ? <button type="button" onClick={() => void installApp()}>설치</button> : <em>브라우저 메뉴에서 홈 화면에 추가</em>}</section> : null}

      <nav className="member-bottom-nav" aria-label="MY 바로가기"><a href="#passes"><span>🎟️</span><b>이용권</b></a><a href="#coupons"><span>🎁</span><b>무료권</b></a><a href="#history"><span>🕘</span><b>내역</b></a><a href="#profile"><span>👤</span><b>내 정보</b></a></nav>
    </main>
  );
}
