"use client";

import { useState } from "react";

type TransferData = {
  amount: number;
  bankName: string;
  accountNumber: string;
  accountHolder: string;
  guideText: string;
  depositorGuide: string;
};

function money(value: number) {
  return `${Math.max(0, Math.trunc(Number(value) || 0)).toLocaleString("ko-KR")}원`;
}

export default function TransferGuide({ transfer }: { transfer: TransferData }) {
  const [notice, setNotice] = useState("");

  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(message);
    } catch {
      setNotice("길게 눌러 직접 복사해주세요.");
    }
    window.setTimeout(() => setNotice(""), 2_000);
  }

  return <main className="transfer-shell">
    <section className="transfer-card">
      <header><span className="transfer-brand">JB</span><div><b>JUMPING BATTLE</b><small>계좌이체 안내</small></div></header>
      <div className="transfer-amount"><span>결제금액</span><strong>{money(transfer.amount)}</strong></div>
      <div className="transfer-account">
        <span>{transfer.bankName}</span>
        <b>{transfer.accountNumber}</b>
        <small>예금주: {transfer.accountHolder}</small>
      </div>
      <button type="button" onClick={() => void copy(transfer.accountNumber, "계좌번호를 복사했어요.")}>계좌번호 복사</button>
      <button type="button" className="secondary" onClick={() => void copy(String(transfer.amount), "금액을 복사했어요.")}>{money(transfer.amount)} 복사</button>
      <div className="transfer-guide"><b>{transfer.guideText}</b><span>{transfer.depositorGuide}</span><small>입금 후 키오스크에서 잠시 기다려주세요. 직원이 확인하면 자동으로 다음 단계로 이동합니다.</small></div>
      {notice ? <div className="transfer-toast" role="status">{notice}</div> : null}
    </section>
  </main>;
}
