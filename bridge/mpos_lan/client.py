"""High-level, idempotent MPOS payment client."""

from __future__ import annotations

from dataclasses import replace
import os
import re
import sqlite3
import threading
import time
import uuid

from .config import MposConfig
from .exceptions import MposError
from .gateway import (
    AmountBreakdown,
    FdkGateway,
    GatewayResponse,
    PaymentGateway,
    TraceCallback,
    calculate_amounts,
)
from .logging_utils import build_audit_logger, close_audit_logger, log_transaction
from .models import ErrorCode, TerminalStatus, TransactionResult, TransactionStatus, TransactionType
from .transaction_store import TransactionStore


_LOCKS_GUARD = threading.Lock()
_PROCESS_LOCKS: dict[str, threading.Lock] = {}


def _process_lock(key: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _PROCESS_LOCKS.setdefault(key, threading.Lock())


def _new_transaction_uuid(value: str | None) -> str:
    candidate = value or str(uuid.uuid4())
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", candidate):
        raise ValueError("transaction_uuid는 영문/숫자/._:- 조합 1~128자여야 합니다.")
    return candidate


def _trace_event(
    trace: TraceCallback | None,
    stage: str,
    duration_ms: float | None = None,
    details: dict[str, object] | None = None,
) -> None:
    if trace is not None:
        trace(stage, duration_ms, details)


class MposClient:
    """Reusable facade for status, approval, cancellation and durable history."""

    def __init__(
        self,
        config: MposConfig | None = None,
        *,
        gateway: PaymentGateway | None = None,
        store: TransactionStore | None = None,
    ):
        self.config = config or MposConfig.load()
        self.store = store or TransactionStore(self.config.database_path)
        self.gateway = gateway or FdkGateway(self.config)
        self.logger = build_audit_logger(self.config.log_path)
        self._local_lock = _process_lock(str(self.config.database_path.resolve()))
        self._closed = False

    def __enter__(self) -> "MposClient":
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        try:
            self.gateway.close()
        finally:
            self.store.close()
            close_audit_logger(self.logger)
            self._closed = True

    def status(self, *, trace: TraceCallback | None = None) -> TerminalStatus:
        """Read terminal integrity information; safe to retry after connection failure."""
        status_started = time.perf_counter()
        _trace_event(trace, "STATUS_CHECK_START")
        if self._closed:
            return TerminalStatus(False, response_message="클라이언트가 닫혔습니다.", error_code=ErrorCode.PROTOCOL_ERROR)
        if not self._local_lock.acquire(blocking=False):
            _trace_event(trace, "STATUS_CHECK_DONE", (time.perf_counter() - status_started) * 1000, {"result": "BUSY"})
            return TerminalStatus(False, response_message="다른 거래가 진행 중입니다.", error_code=ErrorCode.BUSY)
        owner = f"status:{os.getpid()}:{threading.get_ident()}:{uuid.uuid4()}"
        try:
            if not self.store.acquire_device_lock(owner):
                _trace_event(trace, "STATUS_CHECK_DONE", (time.perf_counter() - status_started) * 1000, {"result": "BUSY"})
                return TerminalStatus(False, response_message="다른 프로세스의 거래가 진행 중입니다.", error_code=ErrorCode.BUSY)
            last: TerminalStatus | None = None
            for attempt in range(self.config.status_retries + 1):
                attempt_started = time.perf_counter()
                _trace_event(trace, "STATUS_ATTEMPT_START", details={"attempt": attempt + 1})
                try:
                    last = self._status_result(
                        self.gateway.status(trace=trace) if trace is not None else self.gateway.status()
                    )
                except MposError as exc:
                    last = TerminalStatus(False, response_message=str(exc), error_code=exc.code)
                except OSError as exc:
                    last = TerminalStatus(False, response_message=str(exc), error_code=ErrorCode.CONNECTION_FAILED)
                _trace_event(
                    trace,
                    "STATUS_ATTEMPT_DONE",
                    (time.perf_counter() - attempt_started) * 1000,
                    {"attempt": attempt + 1, "success": bool(last.success), "error": last.error_code.value},
                )
                if last.success or last.error_code not in (
                    ErrorCode.CONNECTION_FAILED,
                    ErrorCode.DEVICE_OFFLINE,
                    ErrorCode.TIMEOUT,
                ):
                    _trace_event(trace, "STATUS_CHECK_DONE", (time.perf_counter() - status_started) * 1000, {"attempts": attempt + 1})
                    return last
                if attempt < self.config.status_retries:
                    _trace_event(trace, "STATUS_RETRY_BACKOFF", 200.0, {"attempt": attempt + 1})
                    time.sleep(0.2)
            result = last or TerminalStatus(False, response_message="상태 확인 결과가 없습니다.", error_code=ErrorCode.UNKNOWN)
            _trace_event(trace, "STATUS_CHECK_DONE", (time.perf_counter() - status_started) * 1000, {"attempts": self.config.status_retries + 1})
            return result
        finally:
            self.store.release_device_lock(owner)
            self._local_lock.release()

    def pay(
        self,
        amount: int,
        *,
        transaction_uuid: str | None = None,
        installment: str = "00",
        service: int = 0,
        nontaxable: int = 0,
        tax: int | None = None,
        taxable: int | None = None,
        trace: TraceCallback | None = None,
    ) -> TransactionResult:
        prepare_started = time.perf_counter()
        _trace_event(trace, "CLIENT_PREPARE_START", details={"transaction_type": "PAY"})
        self.config.require_payment_settings()
        if not re.fullmatch(r"\d{2}", installment):
            raise ValueError("할부 개월은 00 같은 숫자 두 자리여야 합니다.")
        breakdown = calculate_amounts(
            amount,
            service=service,
            nontaxable=nontaxable,
            tax=tax,
            taxable=taxable,
        )
        tx_uuid = _new_transaction_uuid(transaction_uuid)
        existing = self._existing_or_conflict(tx_uuid, TransactionType.PAY, amount)
        if existing:
            _trace_event(trace, "CLIENT_PREPARE_DONE", (time.perf_counter() - prepare_started) * 1000, {"idempotent_replay": True})
            return existing
        _trace_event(trace, "CLIENT_PREPARE_DONE", (time.perf_counter() - prepare_started) * 1000)
        return self._run_transaction(
            tx_uuid,
            TransactionType.PAY,
            breakdown,
            installment,
            (
                (lambda: self.gateway.pay(breakdown, installment, trace=trace))
                if trace is not None
                else (lambda: self.gateway.pay(breakdown, installment))
            ),
            trace=trace,
        )

    def cancel(
        self,
        amount: int,
        auth_date: str,
        auth_no: str,
        *,
        transaction_uuid: str | None = None,
        original_transaction_id: int | None = None,
        installment: str = "00",
        service: int = 0,
        nontaxable: int = 0,
        tax: int | None = None,
        taxable: int | None = None,
        trace: TraceCallback | None = None,
    ) -> TransactionResult:
        prepare_started = time.perf_counter()
        _trace_event(trace, "CLIENT_PREPARE_START", details={"transaction_type": "CANCEL"})
        self.config.require_payment_settings()
        if not re.fullmatch(r"\d{2}", installment):
            raise ValueError("할부 개월은 00 같은 숫자 두 자리여야 합니다.")
        auth_digits = re.sub(r"\D", "", auth_date)
        if len(auth_digits) == 14:
            auth_digits = auth_digits[:8]
        if len(auth_digits) != 8:
            raise ValueError("원승인일자는 YYYYMMDD 8자리여야 합니다.")
        if not re.fullmatch(r"[A-Za-z0-9]{1,20}", auth_no.strip()):
            raise ValueError("원승인번호 형식이 잘못되었습니다.")
        breakdown = calculate_amounts(
            amount,
            service=service,
            nontaxable=nontaxable,
            tax=tax,
            taxable=taxable,
        )
        tx_uuid = _new_transaction_uuid(transaction_uuid)
        existing = self._existing_or_conflict(tx_uuid, TransactionType.CANCEL, amount)
        if existing:
            _trace_event(trace, "CLIENT_PREPARE_DONE", (time.perf_counter() - prepare_started) * 1000, {"idempotent_replay": True})
            return existing

        original = self.store.find_original_approval(amount, auth_date, auth_no)
        if original is not None:
            detected_id = int(original["id"])
            if original_transaction_id is not None and original_transaction_id != detected_id:
                return self._validation_error(
                    tx_uuid,
                    TransactionType.CANCEL,
                    amount,
                    "지정한 원거래 ID가 승인번호/승인일자와 일치하지 않습니다.",
                )
            original_transaction_id = detected_id
            guarded = self.store.find_guarded_cancel(detected_id)
            if guarded:
                _trace_event(trace, "CLIENT_PREPARE_DONE", (time.perf_counter() - prepare_started) * 1000, {"guarded_cancel": True})
                return guarded

        _trace_event(trace, "CLIENT_PREPARE_DONE", (time.perf_counter() - prepare_started) * 1000)
        return self._run_transaction(
            tx_uuid,
            TransactionType.CANCEL,
            breakdown,
            installment,
            (
                (lambda: self.gateway.cancel(breakdown, installment, auth_date, auth_no, trace=trace))
                if trace is not None
                else (lambda: self.gateway.cancel(breakdown, installment, auth_date, auth_no))
            ),
            original_transaction_id=original_transaction_id,
            trace=trace,
        )

    def _run_transaction(
        self,
        tx_uuid: str,
        transaction_type: TransactionType,
        amount: AmountBreakdown,
        installment: str,
        operation,
        *,
        original_transaction_id: int | None = None,
        trace: TraceCallback | None = None,
    ) -> TransactionResult:
        _trace_event(trace, "LOCK_WAIT_START")
        lock_started = time.perf_counter()
        if self._closed:
            return self._validation_error(tx_uuid, transaction_type, amount.total, "클라이언트가 닫혔습니다.")
        if not self._local_lock.acquire(blocking=False):
            _trace_event(trace, "LOCK_BUSY", (time.perf_counter() - lock_started) * 1000)
            return self._busy_result(tx_uuid, transaction_type, amount.total)
        _trace_event(trace, "LOCK_ACQUIRED", (time.perf_counter() - lock_started) * 1000)
        owner = f"transaction:{os.getpid()}:{threading.get_ident()}:{tx_uuid}"
        try:
            lookup_started = time.perf_counter()
            _trace_event(trace, "BRIDGE_DB_LOOKUP_START")
            existing = self._existing_or_conflict(tx_uuid, transaction_type, amount.total)
            _trace_event(trace, "BRIDGE_DB_LOOKUP_DONE", (time.perf_counter() - lookup_started) * 1000)
            if existing:
                _trace_event(trace, "IDEMPOTENT_REPLAY")
                return existing
            device_lock_started = time.perf_counter()
            _trace_event(trace, "DEVICE_LOCK_START")
            if not self.store.acquire_device_lock(owner):
                _trace_event(trace, "DEVICE_LOCK_BUSY", (time.perf_counter() - device_lock_started) * 1000)
                return self._busy_result(tx_uuid, transaction_type, amount.total)
            _trace_event(trace, "DEVICE_LOCK_ACQUIRED", (time.perf_counter() - device_lock_started) * 1000)
            try:
                try:
                    begin_started = time.perf_counter()
                    _trace_event(trace, "BRIDGE_DB_START", details={"operation": "begin"})
                    self.store.begin(
                        tx_uuid,
                        transaction_type,
                        amount.total,
                        installment=installment,
                        original_transaction_id=original_transaction_id,
                    )
                    _trace_event(trace, "BRIDGE_DB_DONE", (time.perf_counter() - begin_started) * 1000, {"operation": "begin"})
                except sqlite3.IntegrityError:
                    replay = self.store.get_by_uuid(tx_uuid, replay=True)
                    if replay:
                        return replay
                    raise

                try:
                    _trace_event(trace, "CLIENT_PREPARE_DONE")
                    response = operation()
                    result = self._transaction_result(
                        tx_uuid,
                        transaction_type,
                        amount.total,
                        response,
                        installment,
                        original_transaction_id,
                    )
                except TimeoutError as exc:
                    # Execute may already have reached the VAN. Never resend here.
                    result = self._exception_result(
                        tx_uuid,
                        transaction_type,
                        amount.total,
                        TransactionStatus.UNKNOWN,
                        ErrorCode.TIMEOUT,
                        str(exc) or "승인 결과 수신 시간 초과",
                        original_transaction_id,
                    )
                except MposError as exc:
                    result = self._exception_result(
                        tx_uuid,
                        transaction_type,
                        amount.total,
                        TransactionStatus.ERROR,
                        exc.code,
                        str(exc),
                        original_transaction_id,
                    )
                except OSError as exc:
                    result = self._exception_result(
                        tx_uuid,
                        transaction_type,
                        amount.total,
                        TransactionStatus.ERROR,
                        ErrorCode.CONNECTION_FAILED,
                        str(exc),
                        original_transaction_id,
                    )
                except Exception as exc:
                    # Unknown exceptions during Execute may follow a completed card approval.
                    result = self._exception_result(
                        tx_uuid,
                        transaction_type,
                        amount.total,
                        TransactionStatus.UNKNOWN,
                        ErrorCode.UNKNOWN,
                        f"결과 확정 불가: {type(exc).__name__}",
                        original_transaction_id,
                    )
                complete_started = time.perf_counter()
                _trace_event(trace, "BRIDGE_DB_START", details={"operation": "complete"})
                self.store.complete(result)
                _trace_event(trace, "BRIDGE_DB_DONE", (time.perf_counter() - complete_started) * 1000, {"operation": "complete"})
                log_transaction(self.logger, result)
                _trace_event(trace, "CLIENT_RESULT_READY", details={"status": result.status.value})
                return result
            finally:
                release_started = time.perf_counter()
                self.store.release_device_lock(owner)
                _trace_event(trace, "DEVICE_LOCK_RELEASED", (time.perf_counter() - release_started) * 1000)
        finally:
            self._local_lock.release()
            _trace_event(trace, "LOCK_RELEASED")

    def _existing_or_conflict(
        self,
        tx_uuid: str,
        transaction_type: TransactionType,
        amount: int,
    ) -> TransactionResult | None:
        existing = self.store.get_by_uuid(tx_uuid, replay=True)
        if existing is None:
            return None
        if existing.transaction_type != transaction_type or existing.amount != amount:
            return self._validation_error(
                tx_uuid,
                transaction_type,
                amount,
                "동일 transaction_uuid가 다른 거래 종류 또는 금액에 이미 사용되었습니다.",
            )
        return existing

    @staticmethod
    def _status_result(response: GatewayResponse) -> TerminalStatus:
        values = response.values
        code = values.get("Response Code", "")
        message = values.get("ErrorInfo", "") or values.get("Display", "")
        error = _classify_error(response.raw_return_code, code, message)
        success = response.raw_return_code == 0 and code in ("", "0000")
        return TerminalStatus(
            success=success,
            response_code=code,
            response_message=message,
            model=values.get("H/W Model Name", ""),
            firmware=values.get("F/W Version", ""),
            integrity=values.get("Integrity Info", ""),
            raw_return_code=response.raw_return_code,
            elapsed_ms=response.elapsed_ms,
            error_code=ErrorCode.NONE if success else error,
        )

    @staticmethod
    def _transaction_result(
        tx_uuid: str,
        transaction_type: TransactionType,
        amount: int,
        response: GatewayResponse,
        installment: str,
        original_transaction_id: int | None,
    ) -> TransactionResult:
        values = response.values
        response_code = values.get("Response Code", "")
        message = (
            values.get("ErrorInfo", "")
            or values.get("Display", "")
            or values.get("Notification", "")
            or values.get("Notice", "")
        )
        error = _classify_error(response.raw_return_code, response_code, message)
        success = response.raw_return_code == 0 and response_code == "0000"
        if success:
            status = (
                TransactionStatus.APPROVED
                if transaction_type == TransactionType.PAY
                else TransactionStatus.CANCELLED
            )
            error = ErrorCode.NONE
        elif error in (
            ErrorCode.TIMEOUT,
            ErrorCode.RECONCILIATION_REQUIRED,
            ErrorCode.UNKNOWN,
        ):
            status = TransactionStatus.UNKNOWN
        elif error == ErrorCode.DECLINED:
            status = TransactionStatus.DECLINED
        elif error == ErrorCode.BUSY:
            status = TransactionStatus.BUSY
        else:
            status = TransactionStatus.ERROR
        issuer_name = values.get("Issuer Name", "")
        return TransactionResult(
            success=success,
            transaction_uuid=tx_uuid,
            transaction_type=transaction_type,
            status=status,
            amount=amount,
            response_code=response_code,
            response_message=message,
            auth_no=values.get("Authorization Number", ""),
            auth_date=values.get("Authorization Date", "") or values.get("Original Authorization Date", ""),
            # The verified D6/D7 output does not expose a separate Card Name.
            card_name="",
            issuer_code=values.get("Issuer Code", ""),
            issuer_name=issuer_name,
            acquirer_code=values.get("Acquirer Code", ""),
            acquirer_name=values.get("Acquirer Name", ""),
            masked_card_no=values.get("Masking Financial Information", ""),
            installment=values.get("Installment Period", "") or installment,
            merchant_no=values.get("Merchant Number", ""),
            raw_return_code=response.raw_return_code,
            elapsed_ms=response.elapsed_ms,
            error_code=error,
            original_transaction_id=original_transaction_id,
        )

    @staticmethod
    def _exception_result(
        tx_uuid: str,
        transaction_type: TransactionType,
        amount: int,
        status: TransactionStatus,
        error: ErrorCode,
        message: str,
        original_transaction_id: int | None,
    ) -> TransactionResult:
        return TransactionResult(
            success=False,
            transaction_uuid=tx_uuid,
            transaction_type=transaction_type,
            status=status,
            amount=amount,
            response_message=message,
            error_code=error,
            original_transaction_id=original_transaction_id,
        )

    @staticmethod
    def _busy_result(tx_uuid: str, kind: TransactionType, amount: int) -> TransactionResult:
        return TransactionResult(
            success=False,
            transaction_uuid=tx_uuid,
            transaction_type=kind,
            status=TransactionStatus.BUSY,
            amount=amount,
            response_message="하나의 MPOS에서 다른 거래가 진행 중입니다.",
            error_code=ErrorCode.BUSY,
        )

    @staticmethod
    def _validation_error(tx_uuid: str, kind: TransactionType, amount: int, message: str) -> TransactionResult:
        return TransactionResult(
            success=False,
            transaction_uuid=tx_uuid,
            transaction_type=kind,
            status=TransactionStatus.ERROR,
            amount=amount,
            response_message=message,
            error_code=ErrorCode.VALIDATION_ERROR,
        )


def _classify_error(raw_code: int, response_code: str, message: str) -> ErrorCode:
    combined = f"{response_code} {message}".lower()
    if raw_code == 0 and response_code == "0000":
        return ErrorCode.NONE
    if raw_code in (-203, -7004, -7005) or "사용자 취소" in combined or "user cancel" in combined:
        return ErrorCode.USER_CANCELLED
    # Official FDK_Module.h: -4000 series means the request was sent but the
    # result is ambiguous or an automatic network cancellation failed.
    if -4999 <= raw_code <= -4000:
        return ErrorCode.RECONCILIATION_REQUIRED
    if raw_code == -5002:
        return ErrorCode.RECONCILIATION_REQUIRED
    if raw_code == -5003:
        return ErrorCode.NET_CANCEL_COMPLETED
    if (
        "socket connect" in combined
        or "connection refused" in combined
        or raw_code in (-5004, -5006, -5007, -5008, -5009, -5013, -5014, -5015, -5016)
    ):
        return ErrorCode.CONNECTION_FAILED
    if raw_code in (-7003,) or "timeout" in combined or "time out" in combined or "시간 초과" in combined:
        return ErrorCode.TIMEOUT
    if raw_code in (-7016, -7017) or "busy" in combined or "사용중" in combined:
        return ErrorCode.BUSY
    if raw_code in (-7000, -7001, -7015, -7018, -7019):
        return ErrorCode.DEVICE_OFFLINE
    if "단말" in combined and ("응답" in combined or "offline" in combined or "전원" in combined):
        return ErrorCode.DEVICE_OFFLINE
    if response_code and response_code != "0000":
        return ErrorCode.DECLINED
    return ErrorCode.PROTOCOL_ERROR
