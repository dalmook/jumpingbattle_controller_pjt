"""Command line interface for safe MPOS status, pay and cancel operations."""

from __future__ import annotations

import argparse
from dataclasses import replace
import json
from pathlib import Path
import sys

from .client import MposClient
from .config import MposConfig
from .exceptions import MposError
from .transaction_store import TransactionStore
from latency_trace import LatencyTrace, new_trace_id


def _load_config(args: argparse.Namespace) -> MposConfig:
    config = MposConfig.load(args.config)
    if getattr(args, "business_number", None):
        config = replace(config, business_number=args.business_number)
    return config


def _print_json(value) -> None:
    print(json.dumps(value.to_dict(), ensure_ascii=False, indent=2))


def _confirm(kind: str, amount: int, assume_yes: bool) -> bool:
    word = "PAY" if kind == "승인" else "CANCEL"
    print("실제 카드 거래가 단말기로 전송됩니다.")
    print(f"TYPE={word} AMOUNT={amount}")
    if assume_yes:
        return True
    expected = f"{word} {amount}"
    answer = input(f"계속하려면 정확히 '{expected}' 입력: ").strip()
    return answer == expected


def _latency_trace(config: MposConfig) -> LatencyTrace:
    trace = LatencyTrace(
        new_trace_id(),
        config.log_path.parent.parent / "logs" / "mpos_latency.jsonl",
    )
    trace.mark("DIRECT_CLI_START", details={"path": "mpos_lan.cli"})
    return trace


def run_status(args: argparse.Namespace) -> int:
    config = _load_config(args)
    trace = _latency_trace(config)
    with MposClient(config) as client:
        result = client.status(trace=trace.callback)
    trace.mark("DIRECT_CLI_RESULT", details={"success": result.success})
    trace.log_summary()
    _print_json(result)
    return 0 if result.success else 2


def run_pay(args: argparse.Namespace) -> int:
    print(f"PLAN TYPE=PAY AMOUNT={args.amount} TX_ID={args.transaction_uuid or '<AUTO>'}")
    if args.dry_run:
        print("DRY-RUN: 단말기에 요청을 보내지 않았습니다.")
        return 0
    if not _confirm("승인", args.amount, args.yes):
        print("사용자가 실행을 중단했습니다.")
        return 3
    config = _load_config(args)
    trace = _latency_trace(config)
    with MposClient(config) as client:
        result = client.pay(
            args.amount,
            transaction_uuid=args.transaction_uuid,
            installment=args.installment,
            service=args.service,
            nontaxable=args.nontaxable,
            tax=args.tax,
            taxable=args.taxable,
            trace=trace.callback,
        )
    trace.mark("DIRECT_CLI_RESULT", details={"success": result.success})
    trace.log_summary()
    _print_json(result)
    return 0 if result.success else 4


def run_cancel(args: argparse.Namespace) -> int:
    print(f"PLAN TYPE=CANCEL AMOUNT={args.amount} TX_ID={args.transaction_uuid or '<AUTO>'}")
    print(f"ORIGINAL AUTH_DATE={args.auth_date} AUTH_NO=<PROVIDED>")
    if args.dry_run:
        print("DRY-RUN: 단말기에 요청을 보내지 않았습니다.")
        return 0
    if not _confirm("취소", args.amount, args.yes):
        print("사용자가 실행을 중단했습니다.")
        return 3
    config = _load_config(args)
    trace = _latency_trace(config)
    with MposClient(config) as client:
        result = client.cancel(
            amount=args.amount,
            auth_date=args.auth_date,
            auth_no=args.auth_no,
            transaction_uuid=args.transaction_uuid,
            original_transaction_id=args.original_transaction_id,
            installment=args.installment,
            service=args.service,
            nontaxable=args.nontaxable,
            tax=args.tax,
            taxable=args.taxable,
            trace=trace.callback,
        )
    trace.mark("DIRECT_CLI_RESULT", details={"success": result.success})
    trace.log_summary()
    _print_json(result)
    return 0 if result.success else 4


def run_unknown(args: argparse.Namespace) -> int:
    config = _load_config(args)
    store = TransactionStore(config.database_path)
    values = [item.to_dict() for item in store.list_unknown()]
    store.close()
    print(json.dumps(values, ensure_ascii=False, indent=2))
    return 0


def _add_config(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--config", type=Path, help="JSON 설정 파일 경로")


def _add_payment_options(parser: argparse.ArgumentParser) -> None:
    _add_config(parser)
    parser.add_argument("--business-number", help="설정/환경변수 대신 사용할 사업자번호")
    parser.add_argument("--transaction-uuid", help="POS 주문 ID와 고정 매핑할 멱등 키")
    parser.add_argument("--installment", default="00")
    parser.add_argument("--service", type=int, default=0)
    parser.add_argument("--nontaxable", type=int, default=0)
    parser.add_argument("--tax", type=int)
    parser.add_argument("--taxable", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--yes", action="store_true", help="대화형 문구 입력 생략")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="MPOS-1700AE FDK LAN client")
    subparsers = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser("status", help="비거래 단말 상태 확인")
    _add_config(status)
    status.set_defaults(func=run_status)

    pay = subparsers.add_parser("pay", help="카드 승인")
    pay.add_argument("amount", type=int)
    _add_payment_options(pay)
    pay.set_defaults(func=run_pay)

    cancel = subparsers.add_parser("cancel", help="카드 승인취소")
    cancel.add_argument("--amount", type=int, required=True)
    cancel.add_argument("--auth-date", required=True)
    cancel.add_argument("--auth-no", required=True)
    cancel.add_argument("--original-transaction-id", type=int)
    _add_payment_options(cancel)
    cancel.set_defaults(func=run_cancel)

    unknown = subparsers.add_parser("unknown", help="수동 확인이 필요한 UNKNOWN 거래 조회")
    _add_config(unknown)
    unknown.set_defaults(func=run_unknown)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return int(args.func(args))
    except MposError as exc:
        print(
            json.dumps(
                {"success": False, "error_code": exc.code.value, "message": str(exc)},
                ensure_ascii=False,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2
    except (ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
