"use client";

import type { ReactNode } from "react";

export function money(value: number) {
  return `${Math.max(0, Math.trunc(value || 0)).toLocaleString("ko-KR")}원`;
}

export function PageHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return <header className="pos-page-header"><div>{eyebrow && <p>{eyebrow}</p>}<h1>{title}</h1></div>{action}</header>;
}

export function SectionCard({ title, description, action, children, className = "" }: {
  title?: string; description?: string; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return <section className={`pos-card ${className}`.trim()}>{(title || action) && <header className="pos-card-head"><div>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</div>{action}</header>}{children}</section>;
}

export function SummaryCard({ label, value, caption, tone = "default" }: { label: string; value: ReactNode; caption?: string; tone?: "default" | "accent" | "good" }) {
  return <article className={`pos-summary pos-summary-${tone}`}><span>{label}</span><strong>{value}</strong>{caption && <small>{caption}</small>}</article>;
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = { booked: "예약", arrived: "입장", completed: "완료", cancelled: "취소", paid: "결제완료", partially_paid: "부분결제", partially_cancelled: "부분취소", pending: "결제대기", unknown: "확인 필요", unpaid: "미결제", running: "게임 중", waiting: "대기", offline: "연결 끊김", error: "확인 필요" };
  return <span className={`pos-badge pos-badge-${status}`}>{labels[status] ?? status}</span>;
}

export function Button({ children, tone = "secondary", className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "secondary" | "danger" | "ghost" }) {
  return <button className={`pos-button pos-button-${tone} ${className}`.trim()} {...props}>{children}</button>;
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return <div className="pos-empty"><div aria-hidden="true">✓</div><strong>{title}</strong>{description && <p>{description}</p>}</div>;
}

export function Skeleton({ count = 3 }: { count?: number }) {
  return <div className="pos-skeleton-list" aria-label="불러오는 중">{Array.from({ length: count }, (_, index) => <div className="pos-skeleton" key={index} />)}</div>;
}

export function BottomSheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return <div className="pos-sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="pos-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header><div className="pos-sheet-grip" /><h2>{title}</h2><button aria-label="닫기" onClick={onClose}>×</button></header>
      <div className="pos-sheet-body">{children}</div>
    </section>
  </div>;
}

export function ConfirmDialog({ open, title, description, confirmLabel = "확인", danger = false, onConfirm, onClose }: {
  open: boolean; title: string; description: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  if (!open) return null;
  return <div className="pos-confirm-backdrop"><section className="pos-confirm" role="alertdialog" aria-modal="true"><h2>{title}</h2><p>{description}</p><div><Button onClick={onClose}>닫기</Button><Button tone={danger ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button></div></section></div>;
}

export function Toast({ message, tone = "good" }: { message: string; tone?: "good" | "error" }) {
  if (!message) return null;
  return <div className={`pos-toast pos-toast-${tone}`} role="status">{message}</div>;
}
