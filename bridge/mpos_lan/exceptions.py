"""Exceptions raised by the MPOS LAN integration."""

from __future__ import annotations

from .models import ErrorCode


class MposError(RuntimeError):
    """Base integration error with a stable internal error code."""

    def __init__(self, message: str, code: ErrorCode = ErrorCode.UNKNOWN):
        super().__init__(message)
        self.code = code


class ConfigurationError(MposError):
    def __init__(self, message: str):
        super().__init__(message, ErrorCode.CONFIGURATION_ERROR)


class DllLoadError(MposError):
    def __init__(self, message: str, *, bitness_mismatch: bool = False):
        code = ErrorCode.BITNESS_MISMATCH if bitness_mismatch else ErrorCode.DLL_LOAD_FAILED
        super().__init__(message, code)


class DeviceBusyError(MposError):
    def __init__(self, message: str = "다른 거래가 진행 중입니다."):
        super().__init__(message, ErrorCode.BUSY)


class ProtocolError(MposError):
    def __init__(self, message: str):
        super().__init__(message, ErrorCode.PROTOCOL_ERROR)
