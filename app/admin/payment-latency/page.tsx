import PinLogin from "@/app/PinLogin";
import { getOperator } from "@/app/operator";
import {
  listPaymentLatencyEvents,
  normalizePaymentTraceId,
  summarizePaymentLatencyEvents,
} from "@/db/payment-latency";

export const dynamic = "force-dynamic";

export default async function PaymentLatencyPage({
  searchParams,
}: {
  searchParams: Promise<{ traceId?: string }>;
}) {
  const operator = await getOperator();
  if (!operator) {
    return (
      <main className="signin-shell">
        <section className="signin-card">
          <div className="brand-mark" aria-hidden="true">JB</div>
          <p className="eyebrow">JUMPING BATTLE · DIAGNOSTICS</p>
          <h1>결제 지연 진단</h1>
          <p>운영자 PIN으로 로그인하면 결제 추적 결과를 확인할 수 있습니다.</p>
          <PinLogin />
        </section>
      </main>
    );
  }

  const traceId = normalizePaymentTraceId((await searchParams).traceId);
  const events = traceId ? await listPaymentLatencyEvents(traceId) : [];
  const report = summarizePaymentLatencyEvents(events);

  return (
    <main style={{ minHeight: "100vh", padding: 24, background: "#f5f7fa" }}>
      <section style={{ maxWidth: 1180, margin: "0 auto", padding: 24, borderRadius: 20, background: "white" }}>
        <p className="eyebrow">MPOS LATENCY DIAGNOSTICS</p>
        <h1>결제 지연 진단</h1>
        <p>추적 ID: {traceId || "주소에 traceId가 필요합니다."}</p>
        <pre style={{ overflow: "auto", padding: 20, borderRadius: 14, background: "#111827", color: "#f9fafb", whiteSpace: "pre-wrap" }}>
          {report.text}
        </pre>
        <details>
          <summary>세부 측정값</summary>
          <pre style={{ overflow: "auto", padding: 20, borderRadius: 14, background: "#f3f4f6", whiteSpace: "pre-wrap" }}>
            {JSON.stringify({ report, events }, null, 2)}
          </pre>
        </details>
      </section>
    </main>
  );
}
