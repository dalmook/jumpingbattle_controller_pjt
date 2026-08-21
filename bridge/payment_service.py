"""Application payment service for the KPN MPOS-1700AE LAN terminal.

The web UI never imports the vendor DLL.  This service is the only bridge layer
that owns ``MposClient`` and all calls are serialized for the single terminal.
"""

from __future__ import annotations

import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from mpos_lan import (
    ErrorCode,
    MposClient,
    MposConfig,
    TerminalStatus,
    TransactionResult,
    TransactionStatus,
    TransactionType,
)
from latency_trace import LatencyTrace, valid_trace_id


TERMINAL_STATUS_INTERVAL_SECONDS = 60.0


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def build_mpos_config(
    bridge_config: Any,
    *,
    application_dir: Path,
    runtime_dir: Path,
) -> MposConfig:
    """Build MPOS settings from bridge config with MPOS_* env overrides."""

    dll_value = os.environ.get(
        "MPOS_DLL_PATH",
        str(getattr(bridge_config, "mpos_dll_path", "mpos_lan/vendor/FDK_Module_64bit.dll")),
    )
    dll_path = Path(dll_value).expanduser()
    if not dll_path.is_absolute():
        dll_path = application_dir / dll_path

    database_value = os.environ.get("MPOS_DB_PATH", "")
    log_value = os.environ.get("MPOS_LOG_PATH", "")
    database_path = (
        Path(database_value).expanduser()
        if database_value
        else runtime_dir / "payments" / "mpos_transactions.db"
    )
    log_path = (
        Path(log_value).expanduser()
        if log_value
        else runtime_dir / "payments" / "mpos_lan.log"
    )

    config = MposConfig(
        host=os.environ.get(
            "MPOS_HOST",
            str(getattr(bridge_config, "mpos_host", "192.0.2.54")),
        ).strip(),
        port=int(os.environ.get("MPOS_PORT", getattr(bridge_config, "mpos_port", 4600))),
        dll_path=dll_path.resolve(),
        business_number=os.environ.get(
            "MPOS_BUSINESS_NUMBER",
            str(getattr(bridge_config, "mpos_business_number", "")),
        ).strip(),
        timeout_seconds=float(
            os.environ.get("MPOS_TIMEOUT", getattr(bridge_config, "mpos_timeout_seconds", 40.0))
        ),
        status_retries=int(
            os.environ.get("MPOS_STATUS_RETRIES", getattr(bridge_config, "mpos_status_retries", 1))
        ),
        database_path=database_path.resolve(),
        log_path=log_path.resolve(),
    )
    config.validate()
    return config


class PaymentService:
    """One-client, one-terminal payment boundary used by the store bridge."""

    def __init__(
        self,
        config: MposConfig,
        *,
        client_factory: Callable[[MposConfig], MposClient] = MposClient,
        auto_status: bool = True,
    ):
        self.config = config
        self._operation_lock = threading.Lock()
        self._closed = False
        self._client: MposClient | None = None
        self._initialization_error = ""
        self._latency_log_path = config.log_path.parent.parent / "logs" / "mpos_latency.jsonl"
        self._last_status: dict[str, Any] = self._unavailable_status(
            ErrorCode.DEVICE_OFFLINE,
            "단말 상태를 아직 확인하지 않았습니다.",
        )
        self._last_status_monotonic = 0.0
        try:
            self._client = client_factory(config)
        except Exception as exc:  # DLL/config failure must not stop the bridge.
            code = getattr(exc, "code", ErrorCode.DLL_LOAD_FAILED)
            if not isinstance(code, ErrorCode):
                code = ErrorCode.DLL_LOAD_FAILED
            self._initialization_error = str(exc)
            self._last_status = self._unavailable_status(code, str(exc))
        if auto_status and self._client is not None:
            self.status()

    @classmethod
    def from_bridge_config(
        cls,
        bridge_config: Any,
        *,
        application_dir: Path,
        runtime_dir: Path,
        auto_status: bool = True,
    ) -> "PaymentService":
        return cls(
            build_mpos_config(
                bridge_config,
                application_dir=application_dir,
                runtime_dir=runtime_dir,
            ),
            auto_status=auto_status,
        )

    @staticmethod
    def _unavailable_status(code: ErrorCode, message: str) -> dict[str, Any]:
        return {
            "kind": "terminal_status",
            "success": False,
            "response_code": "",
            "response_message": message,
            "model": "",
            "firmware": "",
            "integrity": "",
            "raw_return_code": None,
            "elapsed_ms": 0,
            "error_code": code.value,
            "payment_ready": False,
            "checked_at": _utc_now(),
        }

    def _terminal_payload(self, result: TerminalStatus) -> dict[str, Any]:
        payload = result.to_dict()
        payload["kind"] = "terminal_status"
        payload["payment_ready"] = bool(
            re.fullmatch(r"\d{10}", self.config.business_number)
        )
        payload["checked_at"] = _utc_now()
        return payload

    def terminal_snapshot(self) -> dict[str, Any]:
        return dict(self._last_status)

    def refresh_status_if_due(self, now_monotonic: float) -> dict[str, Any]:
        if now_monotonic - self._last_status_monotonic >= TERMINAL_STATUS_INTERVAL_SECONDS:
            return self.status()
        return self.terminal_snapshot()

    def status(self, trace: LatencyTrace | None = None) -> dict[str, Any]:
        if self._closed:
            self._last_status = self._unavailable_status(
                ErrorCode.PROTOCOL_ERROR,
                "결제 서비스가 종료되었습니다.",
            )
            return self.terminal_snapshot()
        if self._client is None:
            return self.terminal_snapshot()
        lock_started = time.perf_counter()
        if trace is not None:
            trace.mark("LOCK_WAIT_START")
        if not self._operation_lock.acquire(blocking=False):
            if trace is not None:
                trace.mark("LOCK_BUSY", duration_ms=(time.perf_counter() - lock_started) * 1000)
            return self._unavailable_status(
                ErrorCode.BUSY,
                "다른 카드 거래가 진행 중입니다.",
            )
        try:
            if trace is not None:
                trace.mark("LOCK_ACQUIRED", duration_ms=(time.perf_counter() - lock_started) * 1000)
            result = self._client.status(trace=trace.callback if trace is not None else None)
            self._last_status = self._terminal_payload(result)
            self._last_status_monotonic = __import__("time").monotonic()
            return self.terminal_snapshot()
        finally:
            self._operation_lock.release()

    @staticmethod
    def _busy_result(
        transaction_uuid: str,
        transaction_type: TransactionType,
        amount: int,
    ) -> TransactionResult:
        return TransactionResult(
            success=False,
            transaction_uuid=transaction_uuid,
            transaction_type=transaction_type,
            status=TransactionStatus.BUSY,
            amount=amount,
            response_message="하나의 MPOS에서 다른 거래가 진행 중입니다.",
            error_code=ErrorCode.BUSY,
        )

    def _unavailable_result(
        self,
        transaction_uuid: str,
        transaction_type: TransactionType,
        amount: int,
    ) -> TransactionResult:
        error_code = ErrorCode.DLL_LOAD_FAILED
        raw_code = self._last_status.get("error_code")
        try:
            error_code = ErrorCode(str(raw_code))
        except ValueError:
            pass
        return TransactionResult(
            success=False,
            transaction_uuid=transaction_uuid,
            transaction_type=transaction_type,
            status=TransactionStatus.ERROR,
            amount=amount,
            response_message=self._initialization_error or "결제 단말을 사용할 수 없습니다.",
            error_code=error_code,
        )

    def _transaction_payload(self, result: TransactionResult) -> dict[str, Any]:
        payload = result.to_dict()
        payload["kind"] = "payment"
        payload["mpos_transaction_id"] = None
        if self._client is not None:
            payload["mpos_transaction_id"] = self._client.store.get_row_id(
                result.transaction_uuid
            )
        return payload

    @staticmethod
    def _finish_trace(
        result: dict[str, Any],
        trace: LatencyTrace | None,
    ) -> dict[str, Any]:
        """Attach trace transport metadata without bloating the command result JSON."""

        if trace is None:
            return result
        trace.mark("BRIDGE_RESPONSE_START")
        result["trace_id"] = trace.trace_id
        # Bridge.run_once removes this private field before serializing the
        # payment result and sends the events beside it in the ACK envelope.
        result["_latency_events"] = trace.public_events()
        trace.log_summary()
        return result

    def pay(
        self,
        order_id: str,
        amount: int,
        *,
        transaction_uuid: str,
        trace: LatencyTrace | None = None,
    ) -> dict[str, Any]:
        del order_id  # Stored by the web DB; never sent to the vendor module.
        if self._client is None or self._closed:
            return self._transaction_payload(
                self._unavailable_result(
                    transaction_uuid,
                    TransactionType.PAY,
                    amount,
                )
            )
        lock_started = time.perf_counter()
        if trace is not None:
            trace.mark("LOCK_WAIT_START")
        if not self._operation_lock.acquire(blocking=False):
            if trace is not None:
                trace.mark("LOCK_BUSY", duration_ms=(time.perf_counter() - lock_started) * 1000)
            return self._transaction_payload(
                self._busy_result(transaction_uuid, TransactionType.PAY, amount)
            )
        try:
            if trace is not None:
                trace.mark("LOCK_ACQUIRED", duration_ms=(time.perf_counter() - lock_started) * 1000)
            result = self._client.pay(
                amount=amount,
                transaction_uuid=transaction_uuid,
                trace=trace.callback if trace is not None else None,
            )
            return self._transaction_payload(result)
        finally:
            self._operation_lock.release()

    def cancel(
        self,
        payment_id: str,
        *,
        amount: int,
        auth_no: str,
        auth_date: str,
        transaction_uuid: str,
        original_transaction_id: int | None,
        trace: LatencyTrace | None = None,
    ) -> dict[str, Any]:
        del payment_id
        if self._client is None or self._closed:
            return self._transaction_payload(
                self._unavailable_result(
                    transaction_uuid,
                    TransactionType.CANCEL,
                    amount,
                )
            )
        lock_started = time.perf_counter()
        if trace is not None:
            trace.mark("LOCK_WAIT_START")
        if not self._operation_lock.acquire(blocking=False):
            if trace is not None:
                trace.mark("LOCK_BUSY", duration_ms=(time.perf_counter() - lock_started) * 1000)
            return self._transaction_payload(
                self._busy_result(transaction_uuid, TransactionType.CANCEL, amount)
            )
        try:
            if trace is not None:
                trace.mark("LOCK_ACQUIRED", duration_ms=(time.perf_counter() - lock_started) * 1000)
            result = self._client.cancel(
                amount=amount,
                auth_no=auth_no,
                auth_date=auth_date,
                transaction_uuid=transaction_uuid,
                original_transaction_id=original_transaction_id,
                trace=trace.callback if trace is not None else None,
            )
            return self._transaction_payload(result)
        finally:
            self._operation_lock.release()

    def execute(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        trace_id = valid_trace_id(payload.get("traceId"))
        trace = LatencyTrace(trace_id, self._latency_log_path) if trace_id else None
        if trace is not None:
            trace.mark("BRIDGE_REQUEST_RECEIVED", details={"action": action})
            sync_rtt_ms = float(payload.get("_bridgeSyncRttMs", 0) or 0)
            if sync_rtt_ms > 0:
                trace.mark(
                    "BRIDGE_SYNC_HTTP_ROUND_TRIP",
                    duration_ms=sync_rtt_ms,
                    details={"caller_measured": True},
                )
        if action == "payment_status":
            return self._finish_trace(self.status(trace), trace)
        transaction_uuid = str(payload.get("transactionUuid", ""))
        reservation_id = str(payload.get("reservationId", ""))
        amount = int(payload.get("amount", 0) or 0)
        if not transaction_uuid or not reservation_id or amount <= 0:
            kind = TransactionType.CANCEL if action == "payment_cancel" else TransactionType.PAY
            result = TransactionResult(
                success=False,
                transaction_uuid=transaction_uuid or "invalid-transaction",
                transaction_type=kind,
                status=TransactionStatus.ERROR,
                amount=max(0, amount),
                response_message="결제 명령 값이 올바르지 않습니다.",
                error_code=ErrorCode.VALIDATION_ERROR,
            )
            return self._finish_trace(self._transaction_payload(result), trace)
        if action == "payment_pay":
            result = self.pay(
                reservation_id,
                amount,
                transaction_uuid=transaction_uuid,
                trace=trace,
            )
            return self._finish_trace(result, trace)
        if action == "payment_cancel":
            result = self.cancel(
                str(payload.get("originalAttemptId", "")),
                amount=amount,
                auth_no=str(payload.get("authNo", "")),
                auth_date=str(payload.get("authDate", "")),
                transaction_uuid=transaction_uuid,
                original_transaction_id=(
                    int(payload["originalMposTransactionId"])
                    if payload.get("originalMposTransactionId") is not None
                    else None
                ),
                trace=trace,
            )
            return self._finish_trace(result, trace)
        result = TransactionResult(
            success=False,
            transaction_uuid=transaction_uuid,
            transaction_type=TransactionType.PAY,
            status=TransactionStatus.ERROR,
            amount=amount,
            response_message="지원하지 않는 결제 명령입니다.",
            error_code=ErrorCode.VALIDATION_ERROR,
        )
        return self._finish_trace(self._transaction_payload(result), trace)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._client is not None:
            self._client.close()


class DisabledPaymentService:
    """Safe placeholder used until MPOS is enabled in bridge configuration."""

    def __init__(self):
        self._status = PaymentService._unavailable_status(
            ErrorCode.CONFIGURATION_ERROR,
            "결제 단말 연동이 비활성화되어 있습니다.",
        )

    def terminal_snapshot(self) -> dict[str, Any]:
        return dict(self._status)

    def refresh_status_if_due(self, now_monotonic: float) -> dict[str, Any]:
        del now_monotonic
        return self.terminal_snapshot()

    def execute(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if action == "payment_status":
            return self.terminal_snapshot()
        transaction_uuid = str(payload.get("transactionUuid", "invalid-transaction"))
        amount = max(0, int(payload.get("amount", 0) or 0))
        kind = TransactionType.CANCEL if action == "payment_cancel" else TransactionType.PAY
        result = TransactionResult(
            success=False,
            transaction_uuid=transaction_uuid,
            transaction_type=kind,
            status=TransactionStatus.ERROR,
            amount=amount,
            response_message=self._status["response_message"],
            error_code=ErrorCode.CONFIGURATION_ERROR,
        )
        value = result.to_dict()
        value["kind"] = "payment"
        value["mpos_transaction_id"] = None
        return value

    def close(self) -> None:
        return None
