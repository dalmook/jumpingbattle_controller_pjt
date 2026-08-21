from __future__ import annotations

import copy
import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path

from parking_service import (
    ParkingConfig,
    ParkingError,
    ParkingHttpClient,
    ParkingRegistrationService,
    _minutes_from_name,
    _minutes_from_raw,
)


class FakeResponse:
    def __init__(self, body: bytes, content_type: str):
        self.body = body
        self.headers = {"content-type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class SequenceOpener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        del timeout
        self.requests.append(request)
        return self.responses.pop(0)


def detail_for(car: str, minutes: int = 0, *, customer: bool = True):
    history = [] if minutes == 0 else [{"dc_time": minutes, "discount_name": f"{minutes // 60}시간 할인"}]
    return {
        "flagCustomer": customer,
        "parkEntry": {"iID": f"entry-{car}", "acPlate1": car, "dtInDate": "2026-08-14 10:00"},
        "parkVisitCar": history,
        "listDiscountType": [
            {"id": "one-hour", "discount_name": "1시간 할인", "discount_value": 60},
            {"id": "two-hour", "discount_name": "2시간 할인", "discount_value": 120},
        ],
    }


class FakeApi:
    def __init__(self, entries: dict[str, dict]):
        self.entries = entries
        self.search_rows = [{"id": key, "carNo": value["parkEntry"]["acPlate1"]} for key, value in entries.items()]
        self.saves: list[dict[str, str]] = []
        self.detail_order: list[str] = []
        self.save_effect = "success"
        self.reset_count = 0

    def search(self, entry_date: str, car_last4: str):
        del entry_date
        return [row for row in self.search_rows if row["carNo"].endswith(car_last4)]

    def detail(self, entry_id: str, member_id: str):
        del member_id
        self.detail_order.append(entry_id)
        return copy.deepcopy(self.entries[entry_id])

    def save(self, form: dict[str, str]):
        self.saves.append(dict(form))
        entry = self.entries[form["peId"]]
        added = 120 if form["discountType"] == "two-hour" else 60
        if self.save_effect == "timeout-always":
            raise ParkingError("NETWORK_UNCERTAIN", "timeout")
        if self.save_effect == "timeout-before" and len(self.saves) == 1:
            raise ParkingError("NETWORK_UNCERTAIN", "timeout")
        entry.setdefault("parkVisitCar", []).append({"dc_time": added, "discount_name": f"{added // 60}시간 할인"})
        if self.save_effect == "timeout-after" and len(self.saves) == 1:
            raise ParkingError("NETWORK_UNCERTAIN", "timeout")
        return True

    def reset_session(self):
        self.reset_count += 1


class ParkingServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    def service(self, api: FakeApi, *, dry_run: bool = False):
        return ParkingRegistrationService(
            ParkingConfig(
                base_url="https://example.invalid",
                user_id="test",
                password="secret",
                lot_area="TEST_LOT",
                member_id="TEST_MEMBER",
                dry_run=dry_run,
                timeout_seconds=2,
            ),
            api,
            Path(self.temp.name) / "parking.jsonl",
        )

    @staticmethod
    def execute(service, policy=lambda: True):
        return service.register({"requestId": "req-1", "carLast4": "1234"}, policy)

    def test_time_units_are_explicit(self):
        self.assertEqual(_minutes_from_raw(60), 60)
        self.assertEqual(_minutes_from_raw(210), 210)
        self.assertEqual(_minutes_from_raw(7200), 120)
        self.assertEqual(_minutes_from_raw(12600), 210)
        self.assertEqual(_minutes_from_raw("02:00"), 120)
        self.assertEqual(_minutes_from_raw("03:30"), 210)
        self.assertEqual(_minutes_from_name("3시간30분할인"), 210)
        self.assertIsNone(_minutes_from_raw(2))

    def test_login_hashes_password_and_keeps_session(self):
        config = ParkingConfig("https://example.invalid", "member", "password", "TEST_LOT", "TEST_MEMBER", True, 2)
        client = ParkingHttpClient(config)
        opener = SequenceOpener([
            FakeResponse(b"<html>home</html>", "text/html"),
            FakeResponse(json.dumps([]).encode(), "application/json"),
        ])
        client._opener = opener
        self.assertEqual(client.search("20260814", "1234"), [])
        login_form = urllib.parse.parse_qs(opener.requests[0].data.decode())
        self.assertEqual(login_form["userId"], ["member"])
        self.assertNotEqual(login_form["userPwd"], ["password"])
        self.assertEqual(len(login_form["userPwd"][0]), 64)

    def test_login_failure_is_reported_without_retrying_save(self):
        config = ParkingConfig("https://example.invalid", "member", "wrong", "TEST_LOT", "TEST_MEMBER", True, 2)
        client = ParkingHttpClient(config)
        client._opener = SequenceOpener([
            FakeResponse(b'<html><form action="/login"><input name="userId"></form></html>', "text/html"),
        ])
        with self.assertRaises(ParkingError) as caught:
            client.search("20260814", "1234")
        self.assertEqual(caught.exception.code, "LOGIN_FAILED")

    def test_read_session_expiry_relogs_once(self):
        config = ParkingConfig("https://example.invalid", "member", "password", "TEST_LOT", "TEST_MEMBER", True, 2)
        client = ParkingHttpClient(config)
        first_opener = SequenceOpener([
            FakeResponse(b"<html>home</html>", "text/html"),
            FakeResponse(b'<html><form action="/login"><input name="userId"></form></html>', "text/html"),
        ])
        second_opener = SequenceOpener([
            FakeResponse(b"<html>home</html>", "text/html"),
            FakeResponse(json.dumps([]).encode(), "application/json"),
        ])
        client._opener = first_opener
        client._new_opener = lambda: second_opener
        self.assertEqual(client.search("20260814", "1234"), [])
        self.assertEqual(len(second_opener.requests), 2)

    def test_not_found(self):
        result = self.execute(self.service(FakeApi({})))
        self.assertEqual(result["status"], "NOT_FOUND")

    def test_no_discount_adds_120(self):
        api = FakeApi({"a": detail_for("12가1234")})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["results"][0]["addedMinutes"], 120)
        self.assertEqual(api.saves[0]["discountType"], "two-hour")

    def test_existing_60_adds_60(self):
        api = FakeApi({"a": detail_for("12가1234", 60)})
        result = self.execute(self.service(api))
        self.assertEqual(result["results"][0]["afterMinutes"], 120)
        self.assertEqual(api.saves[0]["discountType"], "one-hour")

    def test_other_vendor_named_discount_is_counted_and_adds_60(self):
        value = detail_for("12가1234")
        value["parkVisitCar"] = [{"discountName": "다른업체 주차 2시간 할인"}]
        api = FakeApi({"a": value})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["results"][0]["beforeMinutes"], 120)
        self.assertEqual(result["results"][0]["addedMinutes"], 60)
        self.assertEqual(result["results"][0]["afterMinutes"], 180)
        self.assertEqual(api.saves[0]["discountType"], "one-hour")

    def test_other_vendor_three_and_half_hours_reaches_exact_270(self):
        value = detail_for("12가1234")
        value["parkVisitCar"] = [{"discountName": "3시간30분할인"}]
        api = FakeApi({"a": value})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["results"][0]["beforeMinutes"], 210)
        self.assertEqual(result["results"][0]["addedMinutes"], 60)
        self.assertEqual(result["results"][0]["afterMinutes"], 270)
        self.assertEqual(api.saves[0]["discountType"], "one-hour")

    def test_other_vendor_uses_additional_hour_and_never_paid_sale(self):
        value = detail_for("12가1234")
        value["parkVisitCar"] = [{"discountName": "다른업체 주차 2시간 할인"}]
        value["listDiscountType"] = [
            {"id": "two-hour-free", "discount_name": "2시간할인-무료", "discount_value": 120},
            {"id": "one-hour-additional", "discount_name": "1시간추가할인", "discount_value": 60},
            {"id": "one-hour-paid", "discount_name": "1시간유료할인(판매 : 1000)", "discount_value": 60},
        ]
        api = FakeApi({"a": value})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["results"][0]["addedMinutes"], 60)
        self.assertEqual(api.saves[0]["discountType"], "one-hour-additional")

    def test_paid_hour_is_never_selected_even_when_it_is_the_only_60_minute_option(self):
        value = detail_for("12가1234", 120)
        value["listDiscountType"] = [
            {"id": "two-hour-free", "discount_name": "2시간할인-무료", "discount_value": 120},
            {"id": "one-hour-paid", "discount_name": "1시간유료할인(판매 : 1000)", "discount_value": 60},
        ]
        api = FakeApi({"a": value})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "AMBIGUOUS_RESULT")
        self.assertEqual(api.saves, [])

    def test_camel_case_existing_discount_reaches_exact_240(self):
        value = detail_for("12가1234")
        value["parkVisitCar"] = [
            {"dcTime": 120, "discountName": "타업체 2시간 할인"},
            {"discountName": "타업체 1시간 할인"},
        ]
        api = FakeApi({"a": value})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(result["results"][0]["beforeMinutes"], 180)
        self.assertEqual(result["results"][0]["afterMinutes"], 240)

    def test_existing_discount_over_limit_is_not_saved(self):
        value = detail_for("12가1234")
        value["parkVisitCar"] = [
            {"discount_name": "2시간 할인"},
            {"discount_name": "2시간 할인"},
        ]
        api = FakeApi({"a": value})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "LIMIT_EXCEEDED")
        self.assertEqual(api.saves, [])

    def test_existing_180_reaches_240(self):
        api = FakeApi({"a": detail_for("12가1234", 180)})
        result = self.execute(self.service(api))
        self.assertEqual(result["results"][0]["afterMinutes"], 240)

    def test_existing_240_cannot_add_another_hour(self):
        api = FakeApi({"a": detail_for("12가1234", 240)})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "LIMIT_EXCEEDED")
        self.assertEqual(api.saves, [])

    def test_existing_270_is_skipped(self):
        api = FakeApi({"a": detail_for("12가1234", 270)})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "LIMIT_EXCEEDED")
        self.assertEqual(api.saves, [])

    def test_multiple_matches_are_sequential(self):
        api = FakeApi({"a": detail_for("12가1234"), "b": detail_for("34나1234", 60)})
        result = self.execute(self.service(api))
        self.assertEqual(result["matchCount"], 2)
        self.assertEqual([item["peId"] for item in api.saves], ["a", "b"])

    def test_pre_registered_vehicle_is_skipped(self):
        api = FakeApi({"a": detail_for("12가1234", customer=False)})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "SKIPPED")
        self.assertEqual(api.saves, [])

    def test_ambiguous_code_fails_closed(self):
        value = detail_for("12가1234")
        value["listDiscountType"].append({"id": "two-hour-2", "discount_name": "2시간", "discount_value": 120})
        api = FakeApi({"a": value})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "AMBIGUOUS_RESULT")
        self.assertEqual(api.saves, [])

    def test_unreadable_history_fails_closed(self):
        value = detail_for("12가1234")
        value["parkVisitCar"] = [{"discount_name": "알 수 없는 할인"}]
        api = FakeApi({"a": value})
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "INVALID_DISCOUNT")
        self.assertEqual(api.saves, [])

    def test_disabled_before_request(self):
        api = FakeApi({"a": detail_for("12가1234")})
        result = self.execute(self.service(api), lambda: False)
        self.assertEqual(result["status"], "DISABLED")
        self.assertEqual(api.saves, [])

    def test_disabled_immediately_before_save(self):
        api = FakeApi({"a": detail_for("12가1234")})
        values = iter([True, False])
        result = self.execute(self.service(api), lambda: next(values, False))
        self.assertEqual(result["status"], "DISABLED")
        self.assertEqual(api.saves, [])

    def test_dry_run_never_saves(self):
        api = FakeApi({"a": detail_for("12가1234")})
        result = self.execute(self.service(api, dry_run=True))
        self.assertTrue(result["dryRun"])
        self.assertEqual(result["status"], "SKIPPED")
        self.assertEqual(api.saves, [])

    def test_timeout_after_save_is_confirmed_without_retry(self):
        api = FakeApi({"a": detail_for("12가1234")})
        api.save_effect = "timeout-after"
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(len(api.saves), 1)

    def test_timeout_before_save_retries_once_after_recheck(self):
        api = FakeApi({"a": detail_for("12가1234")})
        api.save_effect = "timeout-before"
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "SUCCESS")
        self.assertEqual(len(api.saves), 2)

    def test_repeated_network_failure_stops_after_two_attempts(self):
        api = FakeApi({"a": detail_for("12가1234")})
        api.save_effect = "timeout-always"
        result = self.execute(self.service(api))
        self.assertEqual(result["status"], "NEEDS_REVIEW")
        self.assertEqual(len(api.saves), 2)


if __name__ == "__main__":
    unittest.main()
