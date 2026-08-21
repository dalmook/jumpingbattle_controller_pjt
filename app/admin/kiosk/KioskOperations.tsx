"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Visit = {
  id: string; status: string; teamName: string; customerName: string; partyCount: number;
  roomCode: string; scheduledTime: string; difficultyLabel: string; reservationId: string;
  hold: { state: string; expiresAt: string } | null; error: { code: string; message: string } | null;
  flowType: string; createdAt: string; updatedAt: string; expiresAt: string; startedAt: string; completedAt: string;
  amounts: { final: number };
  pendingPayment: null | { transactionId: string; paymentId: string; splitIndex: number; paymentMethod: string; amount: number; depositorGuide?: string };
  management: { isTest: boolean; isTemporary: boolean; canTerminate: boolean; canReleaseHold: boolean; deleteCandidate: boolean };
};
type Product = { code: string; name: string; price: number; status: string; sortOrder: number };
type Guidance = {
  id: string; placement: string; title: string; summary: string; content: string; agreementText: string;
  required: boolean; version: number; sortOrder: number; active: boolean;
};
type RoomRecommendationRule = {
  id: string; name: string; adultMin: number; adultMax: number; youthMin: number; youthMax: number;
  totalMin: number; totalMax: number; primarySize: "SMALL" | "MEDIUM" | "LARGE";
  secondarySize: "" | "SMALL" | "MEDIUM" | "LARGE"; active: boolean; priority: number;
};
type CleanupPreview = { expiredHolds: number; expiredSessions: number; safeDelete: number; protected: number };
type VisitDetails = {
  visit: Visit;
  management: { isTest: boolean; isTemporary: boolean; canTerminate: boolean; canHardDelete: boolean; canReleaseHold: boolean; deleteBlockReason: string };
  facts: Record<string, string | number>;
  audit: Array<Record<string, unknown>>;
};
type Payload = {
  visits: Visit[]; products: Product[]; guidance: Guidance[]; roomRecommendationRules: RoomRecommendationRule[]; devicePaired: boolean;
  displaySettings: { homeTitle: string; homeSubtitle: string };
  cleanupResult?: CleanupPreview & { deleted: number };
};
type QueueFilter = "active" | "preparing" | "payment" | "closed" | "test";

const LABELS: Record<string, string> = {
  DRAFT: "입력 중", HOLD: "선택 중", PAYMENT_PENDING: "카드 결제 중", WAITING_STAFF_CONFIRMATION: "직원 결제 확인",
  PREPARING: "고객 준비", READY_TO_PLAY: "시작 가능", PLAYING: "게임 중", COMPLETED: "정상 완료",
  ABORTED: "중도 종료", ERROR: "오류", START_FAILED: "시작 실패", STAFF_REVIEW: "직원 확인",
  CANCELLED: "취소", EXPIRED: "시간 만료", ABANDONED: "관리자 종료",
};
const CLOSED_STATES = new Set(["COMPLETED", "CANCELLED", "EXPIRED", "ABANDONED"]);
const PLACEMENTS = [
  { code: "REQUIRED_AGREEMENT", label: "예약 전 필수 이용안내" },
  { code: "AFTER_PAYMENT", label: "결제 후 준비 안내" },
  { code: "BEFORE_GAME_START", label: "게임 시작 전 체크" },
  { code: "AFTER_GAME", label: "게임 후 안내" },
];

function money(value: number) { return `${Math.max(0, Number(value) || 0).toLocaleString("ko-KR")}원`; }

export default function KioskOperations({ operatorName }: { operatorName: string }) {
  const [data, setData] = useState<Payload>({ visits: [], products: [], guidance: [], roomRecommendationRules: [], displaySettings: { homeTitle: "오늘도 신나게 뛰어볼까요?", homeSubtitle: "예약 확인 또는 현장 이용을 선택해주세요." }, devicePaired: false });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<QueueFilter>("active");
  const [showExpired, setShowExpired] = useState(false);
  const [details, setDetails] = useState<VisitDetails | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null);
  const [newProduct, setNewProduct] = useState({ name: "", price: 1000 });
  const [newGuidance, setNewGuidance] = useState({
    placement: "REQUIRED_AGREEMENT", title: "", summary: "", content: "", agreementText: "", required: true,
  });
  const [guidanceMessage, setGuidanceMessage] = useState("");
  const [newRecommendation, setNewRecommendation] = useState({
    name: "", adultMin: 0, adultMax: 10, youthMin: 0, youthMax: 10,
    totalMin: 1, totalMax: 4, primarySize: "SMALL", secondarySize: "MEDIUM", active: true, priority: 100,
  });
  const [displaySettings, setDisplaySettings] = useState(data.displaySettings);
  const loadSequenceRef = useRef(0);
  const mutationEpochRef = useRef(0);
  const activeMutationCountRef = useRef(0);
  useEffect(() => setDisplaySettings(data.displaySettings), [data.displaySettings]);
  const load = useCallback(async () => {
    if (activeMutationCountRef.current > 0) return;
    const requestId = ++loadSequenceRef.current;
    const mutationEpoch = mutationEpochRef.current;
    const response = await fetch("/api/admin/kiosk", { cache: "no-store" });
    const payload = await response.json() as Payload & { error?: string };
    if (!response.ok) throw new Error(payload.error || "불러오지 못했습니다.");
    if (requestId !== loadSequenceRef.current || mutationEpoch !== mutationEpochRef.current || activeMutationCountRef.current > 0) return;
    setData(payload);
  }, []);
  useEffect(() => {
    void load().catch((error) => setMessage(error instanceof Error ? error.message : "상태를 불러오지 못했습니다."));
    const timer = window.setInterval(() => void load().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function act(action: string, body: Record<string, unknown>) {
    activeMutationCountRef.current += 1;
    mutationEpochRef.current += 1;
    setBusy(`${action}:${String(body.visitId ?? body.productCode ?? body.id ?? "new")}`);
    setMessage("");
    try {
      const response = await fetch("/api/admin/kiosk", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...body }),
      });
      const payload = await response.json() as Payload & { error?: string };
      if (!response.ok) throw new Error(payload.error || "처리하지 못했습니다.");
      if (payload.visits) setData(payload);
      return payload as Payload & { cleanupPreview?: CleanupPreview };
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "처리하지 못했습니다.");
      return null;
    }
    finally { activeMutationCountRef.current = Math.max(0, activeMutationCountRef.current - 1); setBusy(""); }
  }

  function updateNewGuidance(patch: Partial<typeof newGuidance>) {
    setGuidanceMessage("");
    setNewGuidance((value) => ({ ...value, ...patch }));
  }

  const active = data.visits.filter((visit) => !CLOSED_STATES.has(visit.status));
  const visibleVisits = useMemo(() => data.visits.filter((visit) => {
    if (!showExpired && visit.status === "EXPIRED") return false;
    if (filter === "active") return !CLOSED_STATES.has(visit.status);
    if (filter === "preparing") return ["PREPARING", "READY_TO_PLAY", "PLAYING", "START_FAILED", "STAFF_REVIEW"].includes(visit.status);
    if (filter === "payment") return ["PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION"].includes(visit.status);
    if (filter === "closed") return CLOSED_STATES.has(visit.status);
    return visit.management.isTest;
  }), [data.visits, filter, showExpired]);

  async function openDetails(visitId: string) {
    setBusy(`visit_details:${visitId}`);
    setMessage("");
    try {
      const response = await fetch("/api/admin/kiosk", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "visit_details", visitId }),
      });
      const payload = await response.json() as VisitDetails & { error?: string };
      if (!response.ok) throw new Error(payload.error || "상세 정보를 불러오지 못했습니다.");
      setDetails(payload);
    } catch (error) { setMessage(error instanceof Error ? error.message : "상세 정보를 불러오지 못했습니다."); }
    finally { setBusy(""); }
  }

  async function requestCleanupPreview() {
    const result = await act("cleanup_preview", {});
    if (result?.cleanupPreview) setCleanupPreview(result.cleanupPreview);
  }

  async function terminateVisit(visit: Visit) {
    if (!window.confirm(`${visit.teamName || visit.customerName || "이 진행 건"}을 종료할까요?\n예약·결제·매출 기록은 삭제되지 않습니다.`)) return;
    await act("terminate_visit", { visitId: visit.id, reason: "관리자 화면에서 진행 종료" });
    setDetails(null);
  }

  async function deleteVisit(visit: Visit) {
    if (!window.confirm("이 작업은 복구할 수 없습니다. 결제 및 게임 기록이 없는 테스트/임시 데이터만 삭제됩니다. 계속할까요?")) return;
    await act("delete_test_visit", { visitId: visit.id, reason: "관리자 화면에서 테스트/임시 데이터 삭제" });
    setDetails(null);
  }
  return <main className="kiosk-admin-shell">
    <header><div><p>KIOSK OPERATIONS</p><h1>키오스크 운영</h1><span>{operatorName} · 3초마다 자동 갱신</span></div><nav><Link href="/admin/v2">← POS V2</Link><Link href="/kiosk" target="_blank">고객 화면 열기 ↗</Link></nav></header>
    {message ? <div className="kiosk-admin-alert">{message}</div> : null}
    <section className={data.devicePaired ? "kiosk-device-panel paired" : "kiosk-device-panel"}><div><span>{data.devicePaired ? "● 등록 완료" : "○ 최초 1회 설정"}</span><b>{data.devicePaired ? "이 브라우저는 매장 키오스크입니다" : "이 기기를 매장 키오스크로 등록해주세요"}</b><small>{data.devicePaired ? "고객은 확인번호 없이 준비된 방을 시작할 수 있습니다." : "실제 키오스크에서 직원 PIN으로 들어온 뒤 한 번만 눌러주세요."}</small></div>{data.devicePaired ? <button disabled={Boolean(busy)} onClick={() => void act("unpair_device", {})}>등록 해제</button> : <button className="primary" disabled={Boolean(busy)} onClick={() => void act("pair_device", {})}>이 기기 등록</button>}</section>
    <section className="kiosk-admin-summary"><article><span>진행 중</span><b>{active.length}건</b></article><article><span>결제 확인</span><b>{active.filter((v) => v.status === "WAITING_STAFF_CONFIRMATION").length}건</b></article><article><span>확인 필요</span><b>{active.filter((v) => ["ERROR", "START_FAILED", "STAFF_REVIEW"].includes(v.status)).length}건</b></article></section>

    <section className="kiosk-admin-panel"><div className="panel-title queue-title"><div><p>LIVE QUEUE</p><h2>고객 진행 현황</h2></div><div className="queue-title-actions"><button onClick={() => void requestCleanupPreview()}>정리 미리보기</button><button onClick={() => void load()}>새로고침</button></div></div>
      <div className="queue-filters" role="tablist" aria-label="고객 진행 상태 필터">
        {(["active", "preparing", "payment", "closed", "test"] as QueueFilter[]).map((item) => <button key={item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)}>{({ active: "진행 중", preparing: "준비·게임", payment: "결제 대기", closed: "종료", test: "테스트" } as Record<QueueFilter, string>)[item]}</button>)}
        <label><input type="checkbox" checked={showExpired} onChange={(event) => setShowExpired(event.target.checked)} /> 만료 건 표시</label>
      </div>
      <div className="kiosk-admin-grid">{visibleVisits.length ? visibleVisits.map((visit) => <article className={`visit-card state-${visit.status.toLowerCase()}`} key={visit.id}>
        <div className="visit-top"><span>{LABELS[visit.status] || visit.status}</span><b>{visit.roomCode || "방 선택 전"} {visit.scheduledTime}</b></div>
        {visit.management.isTest ? <div className="test-badge">TEST DATA</div> : null}
        <h3>{visit.teamName || visit.customerName || "현장 고객"}</h3><p>{visit.partyCount}명 · {visit.difficultyLabel || "난이도 선택 전"} · {money(visit.amounts.final)}</p>
        {visit.pendingPayment ? <div className="manual-payment"><b>{visit.pendingPayment.paymentMethod === "cash" ? "현금 수납" : "계좌 입금"} 확인 대기</b><strong>{money(visit.pendingPayment.amount)}</strong>{visit.pendingPayment.paymentMethod === "account" && visit.pendingPayment.depositorGuide ? <small>{visit.pendingPayment.depositorGuide}</small> : null}</div> : null}
        {visit.error ? <div className="visit-error">{visit.error.message}</div> : null}
        <div className="visit-actions">
          {visit.pendingPayment ? <button className="primary" disabled={Boolean(busy)} onClick={() => void act("confirm_payment", { visitId: visit.id, transactionId: visit.pendingPayment?.transactionId })}>{visit.pendingPayment.paymentMethod === "cash" ? "현금 수납 완료" : "입금 확인"}</button> : null}
          {visit.status === "PREPARING" ? <button className="primary" disabled={Boolean(busy)} onClick={() => void act("ready", { visitId: visit.id })}>{busy === `ready:${visit.id}` ? "전송 중" : "방 준비 완료·게임 정보 전송"}</button> : null}
          {visit.status === "READY_TO_PLAY" ? <button className="primary" disabled={Boolean(busy)} onClick={() => void act("start_game", { visitId: visit.id })}>{busy === `start_game:${visit.id}` ? "시작 요청 중" : "직원이 게임 시작"}</button> : null}
        </div>
        <div className="visit-management-actions">
          <button disabled={Boolean(busy)} onClick={() => void openDetails(visit.id)}>상세</button>
          {visit.management.canReleaseHold ? <button disabled={Boolean(busy)} onClick={() => void act("release", { visitId: visit.id })}>홀드 해제</button> : null}
          {visit.management.canTerminate ? <button disabled={Boolean(busy)} onClick={() => void terminateVisit(visit)}>진행 종료</button> : null}
          {visit.management.deleteCandidate ? <button className="danger" disabled={Boolean(busy)} onClick={() => void deleteVisit(visit)}>{visit.management.isTest ? "테스트 데이터 삭제" : "임시 데이터 삭제"}</button> : null}
          {visit.reservationId ? <Link href={`/admin/v2#booking-${visit.reservationId}`}>결제 상세 보기</Link> : null}
        </div>
      </article>) : <div className="kiosk-admin-empty">선택한 조건에 해당하는 진행 건이 없습니다.</div>}</div>
    </section>

    {details ? <div className="kiosk-admin-modal" role="dialog" aria-modal="true" aria-label="키오스크 진행 상세"><section><div className="modal-title"><div><p>VISIT DETAILS</p><h2>{details.visit.teamName || details.visit.customerName || "현장 고객"}</h2></div><button onClick={() => setDetails(null)}>닫기</button></div>
      <dl className="visit-detail-list"><div><dt>진행 ID</dt><dd>{details.visit.id}</dd></div><div><dt>상태</dt><dd>{LABELS[details.visit.status] || details.visit.status}</dd></div><div><dt>예약 ID</dt><dd>{details.visit.reservationId || "연결 없음"}</dd></div><div><dt>방·시간</dt><dd>{details.visit.roomCode || "미선택"} {details.visit.scheduledTime}</dd></div><div><dt>생성</dt><dd>{details.visit.createdAt}</dd></div><div><dt>마지막 갱신</dt><dd>{details.visit.updatedAt}</dd></div></dl>
      {!details.management.canHardDelete && details.management.deleteBlockReason ? <div className="cleanup-protected">삭제 보호: {details.management.deleteBlockReason}</div> : null}
      <div className="cleanup-facts"><span>승인 결제 {Number(details.facts.approvedPaymentCount) || 0}건</span><span>게임 기록 {Number(details.facts.gameRecordCount) || 0}건</span><span>매출 기록 {Number(details.facts.salesCount) || 0}건</span><span>혜택 원장 {(Number(details.facts.passLedgerCount) || 0) + (Number(details.facts.couponLedgerCount) || 0) + (Number(details.facts.stampLedgerCount) || 0)}건</span></div>
      {details.audit.length ? <div className="audit-list"><h3>관리 이력</h3>{details.audit.slice(0, 5).map((item, index) => <p key={`${String(item.created_at)}-${index}`}><b>{String(item.action || "관리")}</b><span>{String(item.reason || "사유 없음")}</span><small>{String(item.created_by || "")} · {String(item.created_at || "")}</small></p>)}</div> : null}
      <div className="detail-actions">{details.management.canReleaseHold ? <button onClick={async () => { await act("release", { visitId: details.visit.id }); setDetails(null); }}>홀드 해제</button> : null}{details.management.canTerminate ? <button onClick={() => void terminateVisit(details.visit)}>진행 종료</button> : null}{details.management.canHardDelete ? <button className="danger" onClick={() => void deleteVisit(details.visit)}>{details.management.isTest ? "테스트 데이터 삭제" : "임시 데이터 삭제"}</button> : null}</div>
      {details.visit.reservationId ? <Link className="payment-detail-link" href={`/admin/v2#booking-${details.visit.reservationId}`}>예약·결제 상세로 이동</Link> : null}
    </section></div> : null}

    {cleanupPreview ? <div className="kiosk-admin-modal" role="dialog" aria-modal="true" aria-label="키오스크 정리 미리보기"><section><div className="modal-title"><div><p>CLEANUP PREVIEW</p><h2>일괄 정리 미리보기</h2></div><button onClick={() => setCleanupPreview(null)}>닫기</button></div>
      <div className="cleanup-preview-grid"><article><span>만료 홀드</span><b>{cleanupPreview.expiredHolds}건</b></article><article><span>만료 세션</span><b>{cleanupPreview.expiredSessions}건</b></article><article><span>안전 삭제 가능</span><b>{cleanupPreview.safeDelete}건</b></article><article className="protected"><span>보호되어 제외</span><b>{cleanupPreview.protected}건</b></article></div>
      <p className="cleanup-note">승인 결제·실제 예약·게임·매출·다회권·쿠폰·스탬프가 연결된 기록은 자동으로 제외됩니다.</p>
      <div className="detail-actions"><button onClick={() => setCleanupPreview(null)}>취소</button><button className="danger" disabled={Boolean(busy)} onClick={async () => { if (!window.confirm("미리보기에서 안전하다고 판정된 만료/테스트 데이터만 정리합니다. 계속할까요?")) return; const result = await act("bulk_cleanup", { reason: "관리자 화면 일괄 정리" }); if (result?.cleanupResult) setMessage(`정리 완료: ${result.cleanupResult.deleted}건 삭제, 보호 기록 ${result.cleanupResult.protected}건 제외`); setCleanupPreview(null); }}>안전한 항목만 정리</button></div>
    </section></div> : null}

    <section className="kiosk-admin-panel"><div className="panel-title"><div><p>PRODUCTS</p><h2>부가상품 관리</h2></div><small>과거 판매내역은 저장 당시 이름과 금액으로 유지됩니다.</small></div>
      <div className="product-list editable">{data.products.map((product, index) => <ProductEditor key={product.code} product={product} busy={Boolean(busy)} first={index === 0} last={index === data.products.length - 1} onAct={act} />)}</div>
      <div className="admin-add-row"><input placeholder="새 상품명" value={newProduct.name} onChange={(event) => setNewProduct((value) => ({ ...value, name: event.target.value }))} /><input type="number" min="0" step="100" value={newProduct.price} onChange={(event) => setNewProduct((value) => ({ ...value, price: Number(event.target.value) || 0 }))} /><button disabled={Boolean(busy) || !newProduct.name.trim()} onClick={async () => { await act("product_save", newProduct); setNewProduct({ name: "", price: 1000 }); }}>+ 상품 추가</button></div>
    </section>

    <section className="kiosk-admin-panel"><div className="panel-title"><div><p>DISPLAY</p><h2>고객 첫 화면 문구</h2></div><small>키오스크 홈의 안내 문구를 매장에서 바로 수정할 수 있습니다.</small></div>
      <div className="admin-add-row guidance-add"><input maxLength={60} placeholder="첫 화면 제목" value={displaySettings.homeTitle} onChange={(event) => setDisplaySettings((value) => ({ ...value, homeTitle: event.target.value }))} /><input maxLength={120} placeholder="보조 안내 문구" value={displaySettings.homeSubtitle} onChange={(event) => setDisplaySettings((value) => ({ ...value, homeSubtitle: event.target.value }))} /><button disabled={Boolean(busy) || !displaySettings.homeTitle.trim() || !displaySettings.homeSubtitle.trim()} onClick={() => void act("display_settings_save", displaySettings)}>문구 저장</button></div>
    </section>

    <section className="kiosk-admin-panel"><div className="panel-title"><div><p>GUIDANCE</p><h2>키오스크 안내사항</h2></div><small>활성 항목만 고객 화면에 순서대로 표시됩니다.</small></div>
      {PLACEMENTS.map((placement) => <div className="guidance-group" key={placement.code}><h3>{placement.label}</h3>{data.guidance.filter((item) => item.placement === placement.code).map((item, index, items) => <GuidanceEditor key={item.id} item={item} busy={Boolean(busy)} first={index === 0} last={index === items.length - 1} onAct={act} />)}</div>)}
      <div className="guidance-add-detailed">
        <div className="guidance-editor-heading"><div><strong>새 안내 추가</strong><small>표시할 단계와 안내 내용을 입력해주세요.</small></div></div>
        <div className="guidance-form-grid">
          <label className="guidance-field"><span>표시 단계</span><select disabled={Boolean(busy)} value={newGuidance.placement} onChange={(event) => updateNewGuidance({ placement: event.target.value })}>{PLACEMENTS.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
          <label className="guidance-field"><span>제목</span><input disabled={Boolean(busy)} maxLength={60} placeholder="안내 제목" value={newGuidance.title} onChange={(event) => updateNewGuidance({ title: event.target.value })} /></label>
          <label className="guidance-field wide"><span>요약</span><input disabled={Boolean(busy)} maxLength={160} placeholder="고객 화면에 보일 짧은 요약" value={newGuidance.summary} onChange={(event) => updateNewGuidance({ summary: event.target.value })} /></label>
          <label className="guidance-field wide"><span>상세 안내</span><textarea disabled={Boolean(busy)} maxLength={1000} placeholder="고객이 확인할 상세 안내" value={newGuidance.content} onChange={(event) => updateNewGuidance({ content: event.target.value })} /></label>
          <label className="guidance-field wide"><span>동의 문구</span><input disabled={Boolean(busy)} maxLength={160} placeholder="동의 확인 문구" value={newGuidance.agreementText} onChange={(event) => updateNewGuidance({ agreementText: event.target.value })} /></label>
        </div>
        <div className="guidance-add-footer"><label className="guidance-required"><input disabled={Boolean(busy)} type="checkbox" checked={newGuidance.required} onChange={(event) => updateNewGuidance({ required: event.target.checked })} /><span>필수 동의</span></label><button disabled={Boolean(busy) || !newGuidance.title.trim() || !newGuidance.content.trim()} onClick={async () => { setGuidanceMessage(""); const result = await act("guidance_save", newGuidance); if (!result) { setGuidanceMessage("추가하지 못했습니다. 입력 내용은 그대로 유지됩니다."); return; } setGuidanceMessage("안내사항을 추가했습니다."); setNewGuidance((value) => ({ ...value, title: "", summary: "", content: "", agreementText: "" })); }}>+ 안내 추가</button></div>
        {guidanceMessage ? <p className="guidance-action-message" role="status">{guidanceMessage}</p> : null}
      </div>
    </section>

    <section className="kiosk-admin-panel"><div className="panel-title"><div><p>ROOM RECOMMENDATION</p><h2>방 추천 규칙</h2></div><small>고객은 방 크기만 선택하고 실제 방과 시간은 서버가 가장 빠른 순서로 배정합니다.</small></div>
      <div className="recommendation-list">{data.roomRecommendationRules.map((rule) => <RecommendationEditor key={rule.id} rule={rule} busy={Boolean(busy)} onAct={act} />)}</div>
      <div className="recommendation-new"><input placeholder="규칙명" value={newRecommendation.name} onChange={(event) => setNewRecommendation((value) => ({ ...value, name: event.target.value }))} /><label>총 인원 최소<input type="number" min="1" max="10" value={newRecommendation.totalMin} onChange={(event) => setNewRecommendation((value) => ({ ...value, totalMin: Number(event.target.value) || 1 }))} /></label><label>최대<input type="number" min="1" max="10" value={newRecommendation.totalMax} onChange={(event) => setNewRecommendation((value) => ({ ...value, totalMax: Number(event.target.value) || 1 }))} /></label><label>1순위<select value={newRecommendation.primarySize} onChange={(event) => setNewRecommendation((value) => ({ ...value, primarySize: event.target.value }))}><RoomSizeOptions /></select></label><label>2순위<select value={newRecommendation.secondarySize} onChange={(event) => setNewRecommendation((value) => ({ ...value, secondarySize: event.target.value }))}><option value="">없음</option><RoomSizeOptions /></select></label><label>우선순위<input type="number" min="0" max="1000" value={newRecommendation.priority} onChange={(event) => setNewRecommendation((value) => ({ ...value, priority: Number(event.target.value) || 0 }))} /></label><button disabled={Boolean(busy)} onClick={async () => { await act("recommendation_save", newRecommendation); setNewRecommendation((value) => ({ ...value, name: "", priority: value.priority + 10 })); }}>+ 추천 규칙 추가</button></div>
    </section>
  </main>;
}

function ProductEditor({ product, busy, first, last, onAct }: { product: Product; busy: boolean; first: boolean; last: boolean; onAct: (action: string, body: Record<string, unknown>) => Promise<unknown> }) {
  const [name, setName] = useState(product.name);
  const [price, setPrice] = useState(product.price);
  useEffect(() => { setName(product.name); setPrice(product.price); }, [product.name, product.price]);
  return <article><div className="product-edit-fields"><input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /><label><input type="number" min="0" step="100" value={price} onChange={(event) => setPrice(Number(event.target.value) || 0)} /><span>원</span></label></div><div className="admin-inline-actions"><button disabled={busy || (name === product.name && price === product.price)} onClick={() => void onAct("product_save", { productCode: product.code, name, price })}>저장</button><select value={product.status} disabled={busy} onChange={(event) => void onAct("product_status", { productCode: product.code, status: event.target.value })}><option value="SALE">판매</option><option value="SOLD_OUT">품절</option><option value="HIDDEN">숨김</option></select><button disabled={busy || first} onClick={() => void onAct("product_move", { productCode: product.code, direction: -1 })}>↑</button><button disabled={busy || last} onClick={() => void onAct("product_move", { productCode: product.code, direction: 1 })}>↓</button><button className="danger" disabled={busy} onClick={() => void onAct("product_remove", { productCode: product.code })}>삭제</button></div></article>;
}

function GuidanceEditor({ item, busy, first, last, onAct }: { item: Guidance; busy: boolean; first: boolean; last: boolean; onAct: (action: string, body: Record<string, unknown>) => Promise<unknown> }) {
  const [draft, setDraft] = useState(item);
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState("");
  useEffect(() => { if (!dirty) setDraft(item); }, [dirty, item]);
  const unchanged = !dirty || (draft.title === item.title && draft.summary === item.summary && draft.content === item.content && draft.agreementText === item.agreementText && draft.required === item.required);
  function updateDraft(patch: Partial<Guidance>) { setDirty(true); setFeedback(""); setDraft((value) => ({ ...value, ...patch })); }
  async function saveDraft(next: Guidance) {
    setFeedback("");
    const result = await onAct("guidance_save", next);
    if (!result) { setFeedback("저장하지 못했습니다. 입력 내용은 그대로 유지됩니다."); return; }
    setDraft(next);
    setDirty(false);
    setFeedback("저장되었습니다.");
  }
  async function toggleActive() {
    const next = { ...item, active: !item.active };
    setFeedback("");
    const result = await onAct("guidance_save", next);
    if (!result) { setFeedback("상태를 변경하지 못했습니다."); return; }
    setDraft((value) => ({ ...value, active: next.active }));
    setFeedback(next.active ? "안내를 활성화했습니다." : "안내를 비활성화했습니다.");
  }
  return <article className="guidance-item detailed"><div className="guidance-editor-heading"><div><strong>{item.title || "제목 없는 안내"}</strong><small>{item.active ? "고객 화면에 표시 중" : "고객 화면에서 숨김"}</small></div><span className="guidance-version">v{item.version}</span></div><div className="guidance-form-grid"><label className="guidance-field"><span>제목</span><input disabled={busy} value={draft.title} maxLength={60} placeholder="제목" onChange={(event) => updateDraft({ title: event.target.value })} /></label><label className="guidance-field"><span>요약</span><input disabled={busy} value={draft.summary} maxLength={160} placeholder="요약" onChange={(event) => updateDraft({ summary: event.target.value })} /></label><label className="guidance-field wide"><span>상세 안내</span><textarea disabled={busy} value={draft.content} maxLength={1000} placeholder="상세 안내" onChange={(event) => updateDraft({ content: event.target.value })} /></label><label className="guidance-field wide"><span>동의 문구</span><input disabled={busy} value={draft.agreementText} maxLength={160} placeholder="동의 문구" onChange={(event) => updateDraft({ agreementText: event.target.value })} /></label></div><div className="guidance-editor-footer"><label className="guidance-required"><input disabled={busy} type="checkbox" checked={draft.required} onChange={(event) => updateDraft({ required: event.target.checked })} /><span>필수 동의</span></label><div className="admin-inline-actions"><button disabled={busy || unchanged || !draft.title.trim() || !draft.content.trim()} onClick={() => void saveDraft(draft)}>저장</button><button className={item.active ? "active-toggle on" : "active-toggle"} disabled={busy} onClick={() => void toggleActive()}>{item.active ? "활성" : "비활성"}</button><button disabled={busy || first} onClick={() => void onAct("guidance_move", { id: item.id, direction: -1 })}>↑</button><button disabled={busy || last} onClick={() => void onAct("guidance_move", { id: item.id, direction: 1 })}>↓</button><button className="danger" disabled={busy} onClick={() => void onAct("guidance_remove", { id: item.id })}>삭제</button></div></div>{feedback ? <p className="guidance-action-message" role="status">{feedback}</p> : null}</article>;
}

function RoomSizeOptions() { return <><option value="SMALL">소형</option><option value="MEDIUM">중형</option><option value="LARGE">대형</option></>; }

function RecommendationEditor({ rule, busy, onAct }: { rule: RoomRecommendationRule; busy: boolean; onAct: (action: string, body: Record<string, unknown>) => Promise<unknown> }) {
  const [draft, setDraft] = useState(rule);
  useEffect(() => setDraft(rule), [rule]);
  return <article className="recommendation-item"><input value={draft.name} onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))} /><label>총 인원<input type="number" min="1" max="10" value={draft.totalMin} onChange={(event) => setDraft((value) => ({ ...value, totalMin: Number(event.target.value) || 1 }))} /><span>~</span><input type="number" min="1" max="10" value={draft.totalMax} onChange={(event) => setDraft((value) => ({ ...value, totalMax: Number(event.target.value) || 1 }))} /></label><label>1순위<select value={draft.primarySize} onChange={(event) => setDraft((value) => ({ ...value, primarySize: event.target.value as RoomRecommendationRule["primarySize"] }))}><RoomSizeOptions /></select></label><label>2순위<select value={draft.secondarySize} onChange={(event) => setDraft((value) => ({ ...value, secondarySize: event.target.value as RoomRecommendationRule["secondarySize"] }))}><option value="">없음</option><RoomSizeOptions /></select></label><label>우선순위<input type="number" min="0" max="1000" value={draft.priority} onChange={(event) => setDraft((value) => ({ ...value, priority: Number(event.target.value) || 0 }))} /></label><button className={draft.active ? "active-toggle on" : "active-toggle"} disabled={busy} onClick={() => setDraft((value) => ({ ...value, active: !value.active }))}>{draft.active ? "활성" : "비활성"}</button><button disabled={busy} onClick={() => void onAct("recommendation_save", draft)}>저장</button><button className="danger" disabled={busy} onClick={() => void onAct("recommendation_remove", { id: rule.id })}>삭제</button></article>;
}
