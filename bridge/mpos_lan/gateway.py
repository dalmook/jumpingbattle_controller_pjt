"""Low-level adapter for the proven FDK_Module direct-LAN route."""

from __future__ import annotations

import ctypes
from dataclasses import dataclass
from pathlib import Path
import re
import struct
import time
from typing import Any, Callable, Iterable, Protocol

from .config import MposConfig
from .exceptions import ConfigurationError, DllLoadError, ProtocolError


STATUS_WORK_KEY = "PaymentTerminal/Read/CATInformationSecurityCertification_ISC"
APPROVAL_WORK_KEY = "PaymentTerminal/SecuritySafe_Tell/CreditAuth_D6"
CANCEL_WORK_KEY = "PaymentTerminal/SecuritySafe_Tell/CreditCancel_D7"

STATUS_OUTPUT_KEYS = (
    "Response Code",
    "ErrorInfo",
    "Work Type",
    "H/W Model Name",
    "F/W Version",
    "Integrity Info",
)

# Deliberate allowlist. Card Data, Track, Token, PIN, signature and IC data are
# never requested from the DLL.
TRANSACTION_OUTPUT_KEYS = (
    "Response Code",
    "ErrorInfo",
    "Work Type",
    "Installment Period",
    "Authorization Date",
    "Original Authorization Date",
    "Transaction Amount",
    "Authorization Number",
    "Issuer Code",
    "Merchant Number",
    "DDC Flag",
    "Notice",
    "Acquirer Code",
    "Display",
    "Notification",
    "CAT ID",
    "Issuer Name",
    "Acquirer Name",
    "Check Card Flag",
    "Pay Kind",
    "Pay WCC",
    "Masking Financial Information",
)


@dataclass(frozen=True, slots=True)
class AmountBreakdown:
    total: int
    service: int
    taxable: int
    tax: int
    nontaxable: int

    def validate(self) -> None:
        values = (self.total, self.service, self.taxable, self.tax, self.nontaxable)
        if self.total <= 0 or any(value < 0 for value in values):
            raise ValueError("금액은 양수이고 세부 금액은 음수가 아니어야 합니다.")
        if self.service + self.taxable + self.tax + self.nontaxable != self.total:
            raise ValueError("봉사료+과세금액+세금+비과세금액이 총액과 일치하지 않습니다.")


def calculate_amounts(
    total: int,
    *,
    service: int = 0,
    nontaxable: int = 0,
    tax: int | None = None,
    taxable: int | None = None,
) -> AmountBreakdown:
    if (tax is None) != (taxable is None):
        raise ValueError("tax와 taxable은 함께 지정해야 합니다.")
    if tax is None:
        taxable_with_vat = total - service - nontaxable
        if taxable_with_vat < 0:
            raise ValueError("봉사료와 비과세금액의 합이 총액보다 큽니다.")
        tax = taxable_with_vat // 11
        taxable = taxable_with_vat - tax
    result = AmountBreakdown(total, service, int(taxable), int(tax), nontaxable)
    result.validate()
    return result


@dataclass(slots=True)
class GatewayResponse:
    raw_return_code: int
    values: dict[str, str]
    elapsed_ms: int


class PaymentGateway(Protocol):
    def status(self, *, trace: TraceCallback | None = None) -> GatewayResponse: ...

    def pay(
        self,
        amount: AmountBreakdown,
        installment: str,
        *,
        trace: TraceCallback | None = None,
    ) -> GatewayResponse: ...

    def cancel(
        self,
        amount: AmountBreakdown,
        installment: str,
        auth_date: str,
        auth_no: str,
        *,
        trace: TraceCallback | None = None,
    ) -> GatewayResponse: ...

    def close(self) -> None: ...


TraceCallback = Callable[[str, float | None, dict[str, Any] | None], None]


def _trace(
    callback: TraceCallback | None,
    stage: str,
    duration_ms: float | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    if callback is not None:
        callback(stage, duration_ms, details)


class FdkModule:
    """Small ctypes wrapper around the x64 FDK_Module used by the baseline."""

    def __init__(self, dll_path: Path):
        self.dll_path = dll_path.resolve()
        if not self.dll_path.is_file():
            raise DllLoadError(f"FDK DLL이 없습니다: {self.dll_path}")
        self._verify_bitness()
        try:
            self.dll = ctypes.WinDLL(str(self.dll_path))
        except (AttributeError, OSError) as exc:
            message = str(exc)
            mismatch = "%1" in message or "not a valid Win32" in message
            raise DllLoadError(f"FDK DLL 로드 실패: {message}", bitness_mismatch=mismatch) from exc
        self._bind()

    def _verify_bitness(self) -> None:
        try:
            raw = self.dll_path.read_bytes()[:4096]
            if raw[:2] != b"MZ":
                raise DllLoadError("FDK DLL이 유효한 PE 파일이 아닙니다.")
            pe_offset = struct.unpack_from("<I", raw, 0x3C)[0]
            machine = struct.unpack_from("<H", raw, pe_offset + 4)[0]
        except (OSError, IndexError, struct.error) as exc:
            raise DllLoadError(f"FDK DLL PE 정보를 읽지 못했습니다: {exc}") from exc
        dll_bits = 64 if machine in (0x8664, 0xAA64) else 32
        python_bits = ctypes.sizeof(ctypes.c_void_p) * 8
        if dll_bits != python_bits:
            raise DllLoadError(
                f"DLL/Python 비트 수 불일치: DLL={dll_bits}, Python={python_bits}",
                bitness_mismatch=True,
            )

    def _bind(self) -> None:
        self.dll.FDK_Creat.argtypes = []
        self.dll.FDK_Creat.restype = ctypes.c_int
        self.dll.FDK_Destroy.argtypes = [ctypes.c_int]
        self.dll.FDK_Destroy.restype = ctypes.c_int
        self.dll.FDK_Input.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p]
        self.dll.FDK_Input.restype = ctypes.c_int
        self.dll.FDK_Output.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        self.dll.FDK_Output.restype = ctypes.c_int
        self.dll.FDK_Execute.argtypes = [ctypes.c_int, ctypes.c_char_p]
        self.dll.FDK_Execute.restype = ctypes.c_int

    @staticmethod
    def _encode(value: str) -> bytes:
        return value.encode("cp949")

    def _output(self, proc_id: int, key: str) -> tuple[int, str]:
        buffer = ctypes.create_string_buffer(8192)
        result = int(
            self.dll.FDK_Output(proc_id, self._encode(key), buffer, len(buffer))
        )
        return result, buffer.value.decode("cp949", errors="replace").strip()

    def run(
        self,
        work_key: str,
        inputs: Iterable[tuple[str, str]],
        outputs: Iterable[str],
        *,
        trace: TraceCallback | None = None,
    ) -> GatewayResponse:
        started = time.perf_counter()
        create_started = time.perf_counter()
        _trace(trace, "FDK_CREATE_START")
        proc_id = int(self.dll.FDK_Creat())
        _trace(trace, "FDK_CREATE_DONE", (time.perf_counter() - create_started) * 1000)
        if proc_id < 0:
            raise ProtocolError(f"FDK_Creat 실패: {proc_id}")
        try:
            input_started = time.perf_counter()
            input_count = 0
            _trace(trace, "TRANSACTION_INIT_START")
            for key, value in inputs:
                result = int(
                    self.dll.FDK_Input(proc_id, self._encode(key), self._encode(value))
                )
                input_count += 1
                if result != 0:
                    raise ProtocolError(f"FDK_Input 실패: key={key!r}, result={result}")
            input_elapsed = (time.perf_counter() - input_started) * 1000
            _trace(trace, "FDK_INPUT_TOTAL", input_elapsed, {"count": input_count})
            _trace(trace, "TRANSACTION_INIT_DONE", input_elapsed)
            execute_started = time.perf_counter()
            transaction = work_key in {APPROVAL_WORK_KEY, CANCEL_WORK_KEY}
            _trace(trace, "PAY_EXECUTE_START" if transaction else "STATUS_EXECUTE_START")
            if transaction:
                _trace(trace, "PAY_REQUEST_SENT", details={"boundary": "FDK_Execute entry"})
            execute_result = int(self.dll.FDK_Execute(proc_id, self._encode(work_key)))
            execute_elapsed = (time.perf_counter() - execute_started) * 1000
            _trace(
                trace,
                "FIRST_DEVICE_RESPONSE" if transaction else "STATUS_EXECUTE_DONE",
                execute_elapsed,
                {"boundary": "FDK_Execute return", "raw_return_code": execute_result},
            )
            if transaction:
                _trace(
                    trace,
                    "CONNECT_AND_DEVICE_TRANSACTION_DONE",
                    execute_elapsed,
                    {"opaque_vendor_dll": True},
                )
            values: dict[str, str] = {}
            output_started = time.perf_counter()
            output_count = 0
            _trace(trace, "OUTPUT_PARSE_START")
            for key in outputs:
                output_result, value = self._output(proc_id, key)
                output_count += 1
                if output_result == 0 and value:
                    values[key] = value
            output_elapsed = (time.perf_counter() - output_started) * 1000
            _trace(trace, "FDK_OUTPUT_TOTAL", output_elapsed, {"count": output_count})
            _trace(trace, "OUTPUT_PARSE_DONE", output_elapsed)
            if transaction:
                _trace(trace, "PAY_FINAL_RESPONSE", details={"raw_return_code": execute_result})
            return GatewayResponse(
                raw_return_code=execute_result,
                values=_sanitize_allowlisted_outputs(values),
                elapsed_ms=round((time.perf_counter() - started) * 1000),
            )
        finally:
            destroy_started = time.perf_counter()
            self.dll.FDK_Destroy(proc_id)
            _trace(trace, "FDK_DESTROY", (time.perf_counter() - destroy_started) * 1000)


def _sanitize_allowlisted_outputs(values: dict[str, str]) -> dict[str, str]:
    result: dict[str, str] = {}
    date_or_number_fields = {
        "Authorization Date",
        "Original Authorization Date",
        "Authorization Number",
        "Transaction Amount",
        "Installment Period",
        "Merchant Number",
        "CAT ID",
    }
    for key, value in values.items():
        cleaned = value
        if key not in date_or_number_fields:
            cleaned = re.sub(
                r"\b\d{13,19}[=D]\d{4,}\b",
                "<TRACK-DATA-OMITTED>",
                cleaned,
                flags=re.IGNORECASE,
            )
            cleaned = re.sub(r"(?<!\d)\d{13,19}(?!\d)", _mask_if_pan, cleaned)
        result[key] = cleaned
    masked = result.get("Masking Financial Information", "")
    if masked and not any(marker in masked for marker in ("*", "X", "x")):
        # A number without a mask marker is never allowed beyond the adapter.
        result["Masking Financial Information"] = "<UNSAFE-CARD-VALUE-OMITTED>"
    return result


def _mask_if_pan(match: re.Match[str]) -> str:
    digits = match.group(0)
    total = 0
    parity = len(digits) % 2
    for index, char in enumerate(digits):
        value = int(char)
        if index % 2 == parity:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return "<CARD-DATA-OMITTED>" if total % 10 == 0 else digits


def _business_number(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) != 10:
        raise ConfigurationError("사업자번호는 숫자 10자리여야 합니다.")
    return digits


def _installment(value: str) -> str:
    if not re.fullmatch(r"\d{2}", value):
        raise ValueError("할부 개월은 00 같은 숫자 두 자리여야 합니다.")
    return value


def _auth_date(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) == 14:
        digits = digits[:8]
    if len(digits) != 8:
        raise ValueError("원승인일자는 YYYYMMDD 8자리여야 합니다.")
    return digits


def _auth_no(value: str) -> str:
    candidate = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9]{1,20}", candidate):
        raise ValueError("원승인번호 형식이 잘못되었습니다.")
    return candidate


class FdkGateway:
    """Direct LAN implementation: Python -> FDK_Module -> MPOS TCP 4600."""

    def __init__(self, config: MposConfig):
        self.config = config
        self.module = FdkModule(config.dll_path)

    def _connection_options(self, *, transaction: bool) -> list[tuple[str, str]]:
        return [
            ("@/PaymentTerminal/Ethernet/Use", "true"),
            ("@/PaymentTerminal/Ethernet/IP", self.config.host),
            ("@/PaymentTerminal/Ethernet/PORT", str(self.config.port)),
            ("@/PaymentTerminal/StateView_Show", "true" if transaction else "false"),
            # Do not enable TR/PR/COM logs: they can contain payment wire data.
            ("@/Common/LogOption", "SY."),
        ]

    def status(self, *, trace: TraceCallback | None = None) -> GatewayResponse:
        return self.module.run(
            STATUS_WORK_KEY,
            self._connection_options(transaction=False),
            STATUS_OUTPUT_KEYS,
            trace=trace,
        )

    def _transaction_inputs(
        self,
        amount: AmountBreakdown,
        installment: str,
        *,
        auth_no: str = "",
        auth_date: str = "",
    ) -> list[tuple[str, str]]:
        amount.validate()
        return self._connection_options(transaction=True) + [
            ("Business Number", _business_number(self.config.business_number)),
            ("Installment Period", _installment(installment)),
            ("Transaction Amount", str(amount.total)),
            ("Service Amount", str(amount.service)),
            ("Tax Amount", str(amount.tax)),
            ("Taxable Amount", str(amount.taxable)),
            ("Non-Taxable Amount", str(amount.nontaxable)),
            ("Original Authorization Number", auth_no),
            ("Original Authorization Date", auth_date),
            ("Receipt Print Flag", ""),
            ("User Data", ""),
            ("Cancel Reason", ""),
            ("Select CAT ID", ""),
        ]

    def pay(
        self,
        amount: AmountBreakdown,
        installment: str = "00",
        *,
        trace: TraceCallback | None = None,
    ) -> GatewayResponse:
        self.config.require_payment_settings()
        return self.module.run(
            APPROVAL_WORK_KEY,
            self._transaction_inputs(amount, installment),
            TRANSACTION_OUTPUT_KEYS,
            trace=trace,
        )

    def cancel(
        self,
        amount: AmountBreakdown,
        installment: str,
        auth_date: str,
        auth_no: str,
        *,
        trace: TraceCallback | None = None,
    ) -> GatewayResponse:
        self.config.require_payment_settings()
        return self.module.run(
            CANCEL_WORK_KEY,
            self._transaction_inputs(
                amount,
                installment,
                auth_no=_auth_no(auth_no),
                auth_date=_auth_date(auth_date),
            ),
            TRANSACTION_OUTPUT_KEYS,
            trace=trace,
        )

    def close(self) -> None:
        # The proven API creates and destroys one FDK process per operation.
        return None
