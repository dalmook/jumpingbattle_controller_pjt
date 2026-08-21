"""Public result models used by POS and kiosk applications."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from enum import Enum
from typing import Any


class TransactionType(str, Enum):
    PAY = "PAY"
    CANCEL = "CANCEL"


class TransactionStatus(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    DECLINED = "DECLINED"
    CANCELLED = "CANCELLED"
    UNKNOWN = "UNKNOWN"
    ERROR = "ERROR"
    BUSY = "BUSY"


class ErrorCode(str, Enum):
    NONE = "NONE"
    DEVICE_OFFLINE = "DEVICE_OFFLINE"
    AGENT_OFFLINE = "AGENT_OFFLINE"
    CONNECTION_FAILED = "CONNECTION_FAILED"
    TIMEOUT = "TIMEOUT"
    RECONCILIATION_REQUIRED = "RECONCILIATION_REQUIRED"
    NET_CANCEL_COMPLETED = "NET_CANCEL_COMPLETED"
    USER_CANCELLED = "USER_CANCELLED"
    DECLINED = "DECLINED"
    PROTOCOL_ERROR = "PROTOCOL_ERROR"
    DLL_LOAD_FAILED = "DLL_LOAD_FAILED"
    BITNESS_MISMATCH = "BITNESS_MISMATCH"
    BUSY = "BUSY"
    IDEMPOTENT_REPLAY = "IDEMPOTENT_REPLAY"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    CONFIGURATION_ERROR = "CONFIGURATION_ERROR"
    UNKNOWN = "UNKNOWN"


@dataclass(slots=True)
class TerminalStatus:
    success: bool
    response_code: str = ""
    response_message: str = ""
    model: str = ""
    firmware: str = ""
    integrity: str = ""
    raw_return_code: int | None = None
    elapsed_ms: int = 0
    error_code: ErrorCode = ErrorCode.NONE

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["error_code"] = self.error_code.value
        return value


@dataclass(slots=True)
class TransactionResult:
    success: bool
    transaction_uuid: str
    transaction_type: TransactionType
    status: TransactionStatus
    amount: int
    response_code: str = ""
    response_message: str = ""
    auth_no: str = ""
    auth_date: str = ""
    card_name: str = ""
    issuer_code: str = ""
    issuer_name: str = ""
    acquirer_code: str = ""
    acquirer_name: str = ""
    masked_card_no: str = ""
    installment: str = ""
    merchant_no: str = ""
    raw_return_code: int | None = None
    elapsed_ms: int = 0
    error_code: ErrorCode = ErrorCode.NONE
    original_transaction_id: int | None = None
    idempotent_replay: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Return safe structured output; raw card/track fields do not exist here."""
        value = asdict(self)
        value["transaction_type"] = self.transaction_type.value
        value["status"] = self.status.value
        value["error_code"] = self.error_code.value
        return value
