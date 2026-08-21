from __future__ import annotations

import hashlib
import http.cookiejar
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Protocol


SEOUL = timezone(timedelta(hours=9))
MAX_DISCOUNT_MINUTES = 270
FINAL_ERROR_STATUSES = {
    "DISABLED",
    "SESSION_EXPIRED",
    "INVALID_DISCOUNT",
    "AMBIGUOUS_RESULT",
    "NEEDS_REVIEW",
    "FAILED",
}


class ParkingError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ParkingSessionExpired(ParkingError):
    def __init__(self, message: str = "주차 사이트 로그인 세션이 만료되었습니다."):
        super().__init__("SESSION_EXPIRED", message)


@dataclass(frozen=True)
class ParkingConfig:
    base_url: str
    user_id: str
    password: str
    lot_area: str
    member_id: str
    dry_run: bool
    timeout_seconds: float

    @classmethod
    def from_environment(cls) -> "ParkingConfig":
        return cls(
            base_url=os.environ.get("PARKING_BASE_URL", "https://parking.example.com").rstrip("/"),
            user_id=os.environ.get("PARKING_USER_ID", "").strip(),
            password=os.environ.get("PARKING_PASSWORD", ""),
            lot_area=os.environ.get("PARKING_LOT_AREA", "").strip(),
            member_id=os.environ.get("PARKING_MEMBER_ID", "").strip(),
            dry_run=os.environ.get("PARKING_DRY_RUN", "true").strip().lower() not in {"0", "false", "no", "off"},
            timeout_seconds=max(2.0, min(30.0, float(os.environ.get("PARKING_TIMEOUT_SECONDS", "8") or 8))),
        )


class ParkingApi(Protocol):
    def search(self, entry_date: str, car_last4: str) -> list[dict[str, Any]]: ...
    def detail(self, entry_id: str, member_id: str) -> dict[str, Any]: ...
    def save(self, form: dict[str, str]) -> bool: ...
    def reset_session(self) -> None: ...


def _find_array(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        for key in ("data", "rows", "list", "result", "items"):
            if key in value:
                found = _find_array(value[key])
                if found or isinstance(value[key], list):
                    return found
    return []


class ParkingHttpClient:
    def __init__(self, config: ParkingConfig):
        self.config = config
        self._lock = threading.RLock()
        self._cookies = http.cookiejar.CookieJar()
        self._opener = self._new_opener()
        self._authenticated = False

    def _new_opener(self):
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self._cookies))

    def reset_session(self) -> None:
        with self._lock:
            self._cookies.clear()
            self._opener = self._new_opener()
            self._authenticated = False

    @staticmethod
    def _looks_like_login_html(content_type: str, body: bytes) -> bool:
        sample = body[:6000].decode("utf-8", errors="ignore").lower()
        return (
            "text/html" in content_type.lower()
            and ("name=\"userid\"" in sample or "name='userid'" in sample or "/login" in sample)
        )

    @staticmethod
    def _safe_error_message(body: bytes, fallback: str) -> str:
        try:
            parsed = json.loads(body.decode("utf-8"))
            if isinstance(parsed, dict):
                message = parsed.get("errorMsg") or parsed.get("message") or parsed.get("error")
                if message:
                    return str(message)[:240]
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass
        return fallback

    def _post(self, path: str, form: dict[str, str], *, expect_json: bool = True) -> Any:
        payload = {"amano_http_ajax": "true", "ajax": "true", **form}
        request = urllib.request.Request(
            f"{self.config.base_url}{path}",
            data=urllib.parse.urlencode(payload).encode("utf-8"),
            headers={
                "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                "accept": "application/json, text/javascript, */*; q=0.01",
                "x-requested-with": "XMLHttpRequest",
                "user-agent": "JumpingBattleParkingBridge/1.0",
            },
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=self.config.timeout_seconds) as response:
                body = response.read()
                content_type = response.headers.get("content-type", "")
        except urllib.error.HTTPError as exc:
            body = exc.read()
            if exc.code in {401, 403}:
                raise ParkingSessionExpired() from exc
            raise ParkingError(
                "HTTP_ERROR",
                self._safe_error_message(body, f"주차 사이트 오류가 발생했습니다. ({exc.code})"),
            ) from exc
        except (TimeoutError, urllib.error.URLError, OSError) as exc:
            raise ParkingError("NETWORK_UNCERTAIN", "주차 사이트 응답을 확인하지 못했습니다.") from exc

        if self._looks_like_login_html(content_type, body):
            raise ParkingSessionExpired()
        if not expect_json:
            return body
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ParkingError("INVALID_RESPONSE", "주차 사이트 응답 형식을 확인할 수 없습니다.") from exc

    def _login_locked(self) -> None:
        if self._authenticated:
            return
        if not self.config.user_id or not self.config.password:
            raise ParkingError("PARKING_NOT_CONFIGURED", "매장 브릿지에 주차 계정이 설정되지 않았습니다.")
        password_hash = hashlib.sha256(self.config.password.encode("utf-8")).hexdigest()
        try:
            self._post(
                "/login",
                {"userId": self.config.user_id, "userPwd": password_hash},
                expect_json=False,
            )
        except ParkingSessionExpired as exc:
            raise ParkingError("LOGIN_FAILED", "주차 사이트 로그인에 실패했습니다.") from exc
        self._authenticated = True

    def _authenticated_post(
        self,
        path: str,
        form: dict[str, str],
        *,
        retry_session: bool = True,
    ) -> Any:
        with self._lock:
            self._login_locked()
            try:
                return self._post(path, form)
            except ParkingSessionExpired:
                self.reset_session()
                if not retry_session:
                    raise
                self._login_locked()
                return self._post(path, form)

    def search(self, entry_date: str, car_last4: str) -> list[dict[str, Any]]:
        response = self._authenticated_post(
            "/discount/registration/listForDiscount",
            {"iLotArea": self.config.lot_area, "entryDate": entry_date, "carNo": car_last4},
        )
        return _find_array(response)

    def detail(self, entry_id: str, member_id: str) -> dict[str, Any]:
        response = self._authenticated_post(
            "/discount/registration/getForDiscount",
            {"id": entry_id, "member_id": member_id},
        )
        if not isinstance(response, dict):
            raise ParkingError("INVALID_RESPONSE", "차량 상세정보를 확인할 수 없습니다.")
        return response

    def save(self, form: dict[str, str]) -> bool:
        response = self._authenticated_post(
            "/discount/registration/save",
            form,
            retry_session=False,
        )
        if response is True:
            return True
        if response is False:
            self.reset_session()
            raise ParkingSessionExpired()
        if isinstance(response, dict) and response.get("success") is True:
            return True
        message = "주차 할인 저장 결과를 확인할 수 없습니다."
        if isinstance(response, dict):
            message = str(response.get("errorMsg") or response.get("message") or message)[:240]
        raise ParkingError("SAVE_REJECTED", message)


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _minutes_from_raw(value: Any) -> int | None:
    if isinstance(value, str):
        matched = re.fullmatch(r"\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*", value)
        if matched:
            minutes = int(matched.group(1)) * 60 + int(matched.group(2))
            return minutes if 0 < minutes <= MAX_DISCOUNT_MINUTES else None
    number = _number(value)
    if number is None or number <= 0:
        return None
    rounded = round(number)
    if 0 < rounded <= MAX_DISCOUNT_MINUTES and rounded % 30 == 0:
        return rounded
    if rounded % 1800 == 0 and 0 < rounded // 60 <= MAX_DISCOUNT_MINUTES:
        return rounded // 60
    return None


def _minutes_from_name(value: Any) -> int | None:
    name = re.sub(r"\s+", "", str(value or ""))
    combined = re.findall(r"(\d+)시간(?:(\d+)분)?", name)
    if len(combined) == 1:
        hours, minutes = combined[0]
        total = int(hours) * 60 + int(minutes or 0)
        return total if 0 < total <= MAX_DISCOUNT_MINUTES else None
    if combined:
        return None
    minute_matches = re.findall(r"(\d+)분", name)
    if len(minute_matches) == 1:
        total = int(minute_matches[0])
        return total if 0 < total <= MAX_DISCOUNT_MINUTES else None
    return None


def _option_minutes(option: dict[str, Any]) -> int | None:
    raw = _minutes_from_raw(option.get("discount_value") or option.get("discountValue"))
    named = _minutes_from_name(option.get("discount_name") or option.get("discountName"))
    if raw is None or named is None or raw != named:
        return None
    return raw


def _discount_code(option: dict[str, Any]) -> str:
    return str(option.get("id") or option.get("discountId") or "").strip()


def _discount_name(option: dict[str, Any]) -> str:
    return re.sub(
        r"\s+", "", str(option.get("discount_name") or option.get("discountName") or "")
    ).lower()


def _is_paid_discount(option: dict[str, Any]) -> bool:
    name = _discount_name(option)
    return any(marker in name for marker in ("유료", "판매", "paid", "sale"))


def _masked_car(car_no: str) -> str:
    digits = re.sub(r"\D", "", car_no)
    return f"****{digits[-4:]}" if len(digits) >= 4 else "****"


def _entry_id(item: dict[str, Any]) -> str:
    return str(item.get("id") or item.get("iID") or "").strip()


def _entry_time(detail: dict[str, Any], search_item: dict[str, Any]) -> str:
    park_entry = detail.get("parkEntry") if isinstance(detail.get("parkEntry"), dict) else {}
    return str(
        park_entry.get("dtInDate")
        or search_item.get("entryDateToString")
        or search_item.get("entryDate")
        or ""
    )[:40]


def _car_no(detail: dict[str, Any], search_item: dict[str, Any]) -> str:
    park_entry = detail.get("parkEntry") if isinstance(detail.get("parkEntry"), dict) else {}
    return str(park_entry.get("acPlate1") or search_item.get("carNo") or "").strip()


def _is_departed(detail: dict[str, Any]) -> bool:
    park_entry = detail.get("parkEntry") if isinstance(detail.get("parkEntry"), dict) else {}
    for key in ("paid_stat", "paidStat", "out_stat", "outStat"):
        value = str(park_entry.get(key) or detail.get(key) or "").strip().lower()
        if value in {"10", "out", "departed", "completed", "true"}:
            return True
    for key in ("dtOutDate", "outDate", "exitDate"):
        if str(park_entry.get(key) or "").strip():
            return True
    return False


def _discount_types(detail: dict[str, Any]) -> list[dict[str, Any]]:
    return _find_array(detail.get("listDiscountType"))


def _history(detail: dict[str, Any]) -> list[dict[str, Any]]:
    value = detail.get("parkVisitCar")
    found = _find_array(value)
    if found:
        return found
    if isinstance(value, dict) and any(
        key in value for key in (
            "dc_time", "dcTime", "discount_value", "discountValue",
            "discount_time", "discountTime", "dscnt_time", "dscntTime",
            "discount_name", "discountName",
        )
    ):
        return [value]
    return []


def _current_discount_minutes(detail: dict[str, Any]) -> int:
    history = _history(detail)
    if not history:
        return 0
    types = _discount_types(detail)
    named_options: dict[str, set[int]] = {}
    for option in types:
        minutes = _option_minutes(option)
        name = re.sub(
            r"\s+", "", str(option.get("discount_name") or option.get("discountName") or "")
        )
        if minutes is not None and name:
            named_options.setdefault(name, set()).add(minutes)

    total = 0
    for item in history:
        minutes = None
        for key in (
            "dc_time", "dcTime", "discount_value", "discountValue",
            "discount_time", "discountTime", "dscnt_time", "dscntTime",
        ):
            minutes = _minutes_from_raw(item.get(key))
            if minutes is not None:
                break
        if minutes is None:
            # 다른 업체에서 등록한 할인은 우리 할인코드 목록과 이름이 다를 수 있다.
            # 이름 안의 "1시간/2시간"을 먼저 읽어 실제 누적시간에 포함한다.
            minutes = _minutes_from_name(item.get("discount_name") or item.get("discountName"))
        if minutes is None:
            name = re.sub(
                r"\s+", "", str(item.get("discount_name") or item.get("discountName") or "")
            )
            choices = named_options.get(name, set())
            if len(choices) == 1:
                minutes = next(iter(choices))
        if minutes is None:
            raise ParkingError("INVALID_DISCOUNT", "기존 할인시간을 안전하게 계산할 수 없어 등록하지 않았습니다.")
        total += minutes
    return total


def _choose_discount_type(detail: dict[str, Any], minutes: int) -> str:
    candidates = [
        option
        for option in _discount_types(detail)
        if _option_minutes(option) == minutes
        and _discount_code(option)
        and not _is_paid_discount(option)
    ]
    # 주차 할인 판매 상품은 금액이 아닌 시간값도 60분으로 내려올 수 있다.
    # 1시간은 반드시 "추가할인", 2시간은 가능하면 "무료" 코드를 우선한다.
    preferred = [
        option
        for option in candidates
        if (
            minutes == 60
            and "1시간" in _discount_name(option)
            and "추가" in _discount_name(option)
        ) or (
            minutes == 120
            and "2시간" in _discount_name(option)
            and "무료" in _discount_name(option)
        )
    ]
    selected = preferred if preferred else candidates
    unique = sorted({_discount_code(option) for option in selected})
    if len(unique) != 1:
        raise ParkingError(
            "AMBIGUOUS_RESULT",
            f"안전한 {minutes // 60}시간 무료·추가 할인코드를 정확히 하나로 식별하지 못해 등록하지 않았습니다.",
        )
    return unique[0]


class ParkingRegistrationService:
    def __init__(self, config: ParkingConfig, api: ParkingApi, audit_path: Path):
        self.config = config
        self.api = api
        self.audit_path = audit_path
        self._request_lock = threading.Lock()

    @classmethod
    def from_environment(cls, audit_path: Path) -> "ParkingRegistrationService | DisabledParkingService":
        config = ParkingConfig.from_environment()
        if not config.user_id or not config.password:
            return DisabledParkingService()
        return cls(config, ParkingHttpClient(config), audit_path)

    def _audit(self, request_id: str, car_last4: str, result: dict[str, Any]) -> None:
        record = {
            "requestId": request_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "query": car_last4,
            "entryId": result.get("entryId", ""),
            "carNo": result.get("carNo", "****"),
            "beforeMinutes": result.get("beforeMinutes", 0),
            "addedMinutes": result.get("addedMinutes", 0),
            "afterMinutes": result.get("afterMinutes", 0),
            "status": result.get("status", "FAILED"),
            "errorCode": result.get("errorCode", ""),
        }
        try:
            self.audit_path.parent.mkdir(parents=True, exist_ok=True)
            with self.audit_path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            logging.warning("주차등록 로컬 감사 로그를 저장하지 못했습니다.")

    @staticmethod
    def _result(
        *,
        entry_id: str,
        car_no: str,
        entry_time: str,
        before: int,
        action: str,
        added: int,
        after: int,
        status: str,
        message: str,
        error_code: str = "",
    ) -> dict[str, Any]:
        return {
            "entryId": entry_id,
            "carNo": _masked_car(car_no),
            "entryTime": entry_time,
            "beforeMinutes": before,
            "action": action,
            "addedMinutes": added,
            "afterMinutes": after,
            "status": status,
            "message": message[:200],
            "errorCode": error_code,
        }

    def _fresh_detail(self, entry_id: str) -> dict[str, Any]:
        return self.api.detail(entry_id, self.config.member_id)

    def _save_with_verification(
        self,
        *,
        entry_id: str,
        car_no: str,
        discount_code: str,
        before: int,
        added: int,
        policy_check: Callable[[], bool],
    ) -> tuple[str, int, str]:
        form = {
            "peId": entry_id,
            "discountType": discount_code,
            "saveCnt": "1",
            "carNo": car_no,
            "acPlate2": "",
            "memo": "JumpingBattle auto",
        }
        if not policy_check():
            raise ParkingError("DISABLED", "처리 중 주차 자동등록이 꺼져 저장하지 않았습니다.")

        try:
            if self.api.save(form):
                confirmed = _current_discount_minutes(self._fresh_detail(entry_id))
                if confirmed >= before + added:
                    return "SUCCESS", confirmed, f"{added // 60}시간 할인이 등록되었습니다."
                return "NEEDS_REVIEW", before, "저장 응답은 성공이지만 할인내역 확인이 필요합니다."
        except ParkingError as exc:
            if exc.code not in {"NETWORK_UNCERTAIN", "SESSION_EXPIRED"}:
                raise
            self.api.reset_session()

        try:
            rechecked = _current_discount_minutes(self._fresh_detail(entry_id))
        except ParkingError:
            return "NEEDS_REVIEW", before, "통신이 끊겨 할인 등록 여부를 확인해야 합니다."
        if rechecked >= before + added:
            return "SUCCESS", rechecked, f"{added // 60}시간 할인 등록을 확인했습니다."
        if rechecked != before:
            return "NEEDS_REVIEW", rechecked, "할인내역이 변경되어 자동 재등록하지 않았습니다."
        if not policy_check():
            raise ParkingError("DISABLED", "재확인 중 주차 자동등록이 꺼져 저장하지 않았습니다.")

        try:
            if not self.api.save(form):
                return "NEEDS_REVIEW", before, "재시도 결과를 확인해야 합니다."
        except ParkingError:
            return "NEEDS_REVIEW", before, "재시도 결과가 불명확하여 추가 등록을 중단했습니다."
        try:
            final = _current_discount_minutes(self._fresh_detail(entry_id))
        except ParkingError:
            return "NEEDS_REVIEW", before, "재시도 후 할인내역 확인이 필요합니다."
        if final >= before + added:
            return "SUCCESS", final, f"{added // 60}시간 할인이 등록되었습니다."
        return "NEEDS_REVIEW", final, "재시도 후에도 할인 등록 여부를 확인해야 합니다."

    def _process_entry(
        self,
        search_item: dict[str, Any],
        policy_check: Callable[[], bool],
    ) -> dict[str, Any]:
        entry_id = _entry_id(search_item)
        if not entry_id:
            raise ParkingError("INVALID_RESPONSE", "입차 차량 식별값이 없어 등록하지 않았습니다.")
        detail = self._fresh_detail(entry_id)
        car_no = _car_no(detail, search_item)
        entry_time = _entry_time(detail, search_item)
        if not car_no:
            raise ParkingError("INVALID_RESPONSE", "전체 차량번호를 확인할 수 없어 등록하지 않았습니다.")
        if detail.get("flagCustomer") is False or str(detail.get("flagCustomer", "")).lower() == "false":
            return self._result(
                entry_id=entry_id, car_no=car_no, entry_time=entry_time,
                before=0, action="SKIP_PRE_REGISTERED", added=0, after=0,
                status="SKIPPED", message="사전등록 차량은 웹할인을 등록할 수 없습니다.",
            )
        if _is_departed(detail):
            return self._result(
                entry_id=entry_id, car_no=car_no, entry_time=entry_time,
                before=0, action="SKIP_DEPARTED", added=0, after=0,
                status="SKIPPED", message="출차 완료 차량은 등록하지 않았습니다.",
            )

        history = _history(detail)
        before = _current_discount_minutes(detail)
        if before >= MAX_DISCOUNT_MINUTES:
            return self._result(
                entry_id=entry_id, car_no=car_no, entry_time=entry_time,
                before=before, action="SKIP_LIMIT", added=0, after=before,
                status="LIMIT_EXCEEDED", message="이미 최대 4시간 30분 할인이 적용되어 있습니다.",
            )
        # 기본 2시간은 할인내역이 전혀 없는 첫 등록에만 허용한다.
        # 타 업체 할인 등 기존 내역이 한 건이라도 있으면 누적시간이 0으로
        # 표시되더라도 추가 요청은 1시간 정책으로 처리한다.
        added = 120 if not history else 60
        if before + added > MAX_DISCOUNT_MINUTES:
            return self._result(
                entry_id=entry_id, car_no=car_no, entry_time=entry_time,
                before=before, action="SKIP_LIMIT", added=0, after=before,
                status="LIMIT_EXCEEDED", message="추가하면 최대 4시간 30분을 초과하여 등록하지 않았습니다.",
            )
        action = "BASE_120" if added == 120 else "ADD_60"
        discount_code = _choose_discount_type(detail, added)
        if self.config.dry_run:
            return self._result(
                entry_id=entry_id, car_no=car_no, entry_time=entry_time,
                before=before, action=f"DRY_RUN_{action}", added=0, after=before,
                status="SKIPPED", message=f"DRY RUN: {added // 60}시간 등록 가능 여부만 확인했습니다.",
            )

        status, after, message = self._save_with_verification(
            entry_id=entry_id,
            car_no=car_no,
            discount_code=discount_code,
            before=before,
            added=added,
            policy_check=policy_check,
        )
        return self._result(
            entry_id=entry_id, car_no=car_no, entry_time=entry_time,
            before=before, action=action, added=added if status == "SUCCESS" else 0,
            after=after, status=status, message=message,
        )

    def register(
        self,
        payload: dict[str, Any],
        policy_check: Callable[[], bool],
    ) -> dict[str, Any]:
        request_id = str(payload.get("requestId") or "")[:100]
        car_last4 = str(payload.get("carLast4") or "").strip()
        if not re.fullmatch(r"\d{4}", car_last4):
            return {
                "status": "FAILED", "matchCount": 0, "results": [],
                "errorCode": "INVALID_QUERY", "errorMessage": "차량번호 뒤 4자리가 올바르지 않습니다.",
                "dryRun": self.config.dry_run,
            }
        if not policy_check():
            return {
                "status": "DISABLED", "matchCount": 0, "results": [],
                "errorCode": "DISABLED", "errorMessage": "주차 자동등록이 꺼져 있습니다.",
                "dryRun": self.config.dry_run,
            }

        with self._request_lock:
            try:
                now = datetime.now(SEOUL)
                matches: dict[str, dict[str, Any]] = {}
                for day in (now - timedelta(days=1), now):
                    for item in self.api.search(day.strftime("%Y%m%d"), car_last4):
                        identifier = _entry_id(item)
                        if identifier:
                            matches.setdefault(identifier, item)
                if not matches:
                    return {
                        "status": "NOT_FOUND", "matchCount": 0, "results": [],
                        "errorCode": "NOT_FOUND", "errorMessage": "입차 차량을 찾을 수 없습니다.",
                        "dryRun": self.config.dry_run,
                    }

                results: list[dict[str, Any]] = []
                for item in matches.values():
                    try:
                        result = self._process_entry(item, policy_check)
                    except ParkingError as exc:
                        result = self._result(
                            entry_id=_entry_id(item), car_no=str(item.get("carNo") or ""),
                            entry_time=str(item.get("entryDateToString") or "")[:40],
                            before=0, action="FAILED", added=0, after=0,
                            status=exc.code if exc.code in FINAL_ERROR_STATUSES else "FAILED",
                            message=str(exc), error_code=exc.code,
                        )
                    results.append(result)
                    self._audit(request_id, car_last4, result)

                statuses = {str(item.get("status")) for item in results}
                if statuses & FINAL_ERROR_STATUSES:
                    status = next(
                        candidate for candidate in (
                            "NEEDS_REVIEW", "DISABLED", "SESSION_EXPIRED", "AMBIGUOUS_RESULT",
                            "INVALID_DISCOUNT", "FAILED",
                        ) if candidate in statuses
                    )
                elif "SUCCESS" in statuses:
                    status = "SUCCESS"
                elif "LIMIT_EXCEEDED" in statuses:
                    status = "LIMIT_EXCEEDED"
                else:
                    status = "SKIPPED"
                return {
                    "status": status,
                    "matchCount": len(matches),
                    "results": results,
                    "errorCode": "" if status in {"SUCCESS", "SKIPPED", "LIMIT_EXCEEDED"} else status,
                    "errorMessage": "" if status in {"SUCCESS", "SKIPPED", "LIMIT_EXCEEDED"} else "일부 차량의 주차등록을 완료하지 못했습니다.",
                    "dryRun": self.config.dry_run,
                }
            except ParkingError as exc:
                return {
                    "status": exc.code if exc.code in FINAL_ERROR_STATUSES else "FAILED",
                    "matchCount": 0,
                    "results": [],
                    "errorCode": exc.code,
                    "errorMessage": str(exc),
                    "dryRun": self.config.dry_run,
                }

    def close(self) -> None:
        self.api.reset_session()


class DisabledParkingService:
    def register(self, payload: dict[str, Any], policy_check: Callable[[], bool]) -> dict[str, Any]:
        del payload, policy_check
        return {
            "status": "FAILED",
            "matchCount": 0,
            "results": [],
            "errorCode": "PARKING_NOT_CONFIGURED",
            "errorMessage": "매장 브릿지에 주차 계정이 설정되지 않았습니다.",
            "dryRun": True,
        }

    def close(self) -> None:
        return
