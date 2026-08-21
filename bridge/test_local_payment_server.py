from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from local_payment_server import (
    LocalPaymentHttpServer,
    LocalPaymentRuntime,
    LocalPaymentStore,
    intent_signature,
    validate_payment_intent,
)


SECRET = "test-local-payment-signing-secret-32-bytes"
ORIGIN = "https://your-site.example"


def signed_intent(*, amount: int = 1000, transaction_uuid: str | None = None):
    now = datetime.now(timezone.utc)
    attempt_id = transaction_uuid or str(uuid.uuid4())
    intent = {
        "version": 1,
        "intent_id": str(uuid.uuid4()),
        "reservation_id": str(uuid.uuid4()),
        "payment_id": str(uuid.uuid4()),
        "attempt_id": attempt_id,
        "transaction_uuid": attempt_id,
        "amount": amount,
        "payment_method": "CARD",
        "issued_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=60)).isoformat(),
        "nonce": str(uuid.uuid4()),
        "trace_id": f"PAY-TEST-{uuid.uuid4().hex[:8]}",
    }
    intent["signature"] = intent_signature(intent, SECRET)
    return intent


class FakePaymentService:
    def __init__(self):
        self.calls = 0

    def execute(self, action, payload):
        self.calls += 1
        return {
            "kind": "payment",
            "success": True,
            "transaction_uuid": payload["transactionUuid"],
            "transaction_type": "PAY",
            "status": "APPROVED",
            "amount": payload["amount"],
            "response_code": "0000",
            "response_message": "승인",
            "auth_no": "TEST0001",
            "auth_date": "20260814",
            "issuer_name": "테스트카드",
            "masked_card_no": "1234********5678",
            "error_code": "NONE",
            "trace_id": payload["traceId"],
        }


class LocalPaymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "local-direct.db"
        self.service = FakePaymentService()
        self.synced: list[dict] = []
        self.runtime = LocalPaymentRuntime(
            secret=SECRET,
            allowed_origins={ORIGIN},
            store=LocalPaymentStore(self.path),
            payment_service=self.service,
            sync_result=self.synced.append,
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_signature_and_expiry_are_enforced(self):
        intent = signed_intent()
        self.assertEqual(validate_payment_intent(intent, SECRET)["amount"], 1000)
        intent["amount"] = 2000
        with self.assertRaisesRegex(ValueError, "SIGNATURE_INVALID"):
            validate_payment_intent(intent, SECRET)

    def test_duplicate_transaction_executes_terminal_once(self):
        intent = signed_intent()
        self.runtime.prepare(intent)
        first = self.runtime.execute(intent)
        second = self.runtime.execute(intent)
        self.assertEqual(first["status"], "APPROVED")
        self.assertEqual(second["status"], "APPROVED")
        self.assertTrue(second["replayed"])
        self.assertTrue(second["request_sent"])
        self.assertEqual(self.service.calls, 1)
        self.assertEqual(self.runtime.store.pending_sync_count(), 1)

    def test_ready_intent_can_be_refreshed_before_execute(self):
        transaction_uuid = str(uuid.uuid4())
        first = signed_intent(transaction_uuid=transaction_uuid)
        second = signed_intent(transaction_uuid=transaction_uuid)
        self.runtime.prepare(first)
        self.runtime.prepare(second)
        with self.assertRaisesRegex(ValueError, "PAYMENT_INTENT_INACTIVE"):
            self.runtime.execute(first)
        result = self.runtime.execute(second)
        self.assertEqual(result["status"], "APPROVED")
        self.assertTrue(result["request_sent"])
        self.assertEqual(self.service.calls, 1)

    def test_busy_response_proves_request_was_not_sent(self):
        intent = signed_intent()
        self.runtime.prepare(intent)
        self.runtime._execute_lock.acquire()
        try:
            result = self.runtime.execute(intent)
        finally:
            self.runtime._execute_lock.release()
        self.assertEqual(result["status"], "BUSY")
        self.assertFalse(result["request_sent"])
        self.assertEqual(self.service.calls, 0)
        self.assertIsNone(self.runtime.store.transaction_result(intent["transaction_uuid"]))

    def test_outbox_retries_result_upload_not_terminal(self):
        failures = {"count": 0}

        def flaky_sync(payload):
            failures["count"] += 1
            if failures["count"] == 1:
                raise ConnectionError("cloud offline")
            self.synced.append(payload)

        self.runtime.sync_result = flaky_sync
        intent = signed_intent()
        self.runtime.execute(intent)
        self.runtime.sync_due()
        self.assertEqual(self.service.calls, 1)
        self.assertEqual(self.runtime.store.pending_sync_count(), 1)
        time.sleep(1.05)
        self.runtime.sync_due()
        self.assertEqual(self.service.calls, 1)
        self.assertEqual(self.runtime.store.pending_sync_count(), 0)
        self.assertEqual(len(self.synced), 1)

    def test_permanent_inactive_result_is_quarantined_without_retry(self):
        calls = {"count": 0}

        def rejected_sync(_payload):
            calls["count"] += 1
            raise RuntimeError(
                '서버 응답 오류 409: {"error":"LOCAL_PAYMENT_INTENT_INACTIVE"}'
            )

        self.runtime.sync_result = rejected_sync
        intent = signed_intent()
        self.runtime.execute(intent)
        self.runtime.sync_due()
        self.runtime.sync_due()
        self.assertEqual(calls["count"], 1)
        self.assertEqual(self.runtime.store.pending_sync_count(), 0)
        with self.runtime.store._connection() as connection:
            row = connection.execute(
                "SELECT status FROM cloud_sync_outbox WHERE transaction_uuid = ?",
                (intent["transaction_uuid"],),
            ).fetchone()
        self.assertEqual(row["status"], "QUARANTINED")

    def test_existing_permanent_failures_are_quarantined_on_startup(self):
        intent = signed_intent()
        self.runtime.execute(intent)
        with self.runtime.store._connection() as connection:
            connection.execute(
                "UPDATE cloud_sync_outbox SET status = 'FAILED', last_error = ?, next_retry_at = 0",
                ('서버 응답 오류 409: {"error":"LOCAL_PAYMENT_INTENT_INACTIVE"}',),
            )
        recovered = LocalPaymentStore(self.path)
        self.assertEqual(recovered.pending_sync_count(), 0)

    def test_new_pending_result_is_prioritized_over_old_retry(self):
        old_intent = signed_intent()
        self.runtime.execute(old_intent)
        with self.runtime.store._connection() as connection:
            connection.execute(
                "UPDATE cloud_sync_outbox SET status = 'FAILED', next_retry_at = 0 "
                "WHERE transaction_uuid = ?",
                (old_intent["transaction_uuid"],),
            )
        new_intent = signed_intent()
        self.runtime.execute(new_intent)
        rows = self.runtime.store.due_outbox()
        self.assertEqual(rows[0]["transaction_uuid"], new_intent["transaction_uuid"])
        self.assertEqual(rows[0]["status"], "PENDING")

    def test_core_commit_receipt_keeps_outbox_until_derived_sync(self):
        calls = {"count": 0}

        def two_phase_sync(_payload):
            calls["count"] += 1
            return {"synced": calls["count"] > 1, "coreCommitted": True}

        self.runtime.sync_result = two_phase_sync
        intent = signed_intent()
        self.runtime.execute(intent)
        self.runtime.sync_due()
        self.assertEqual(self.runtime.store.pending_sync_count(), 1)
        self.runtime.sync_due()
        self.assertEqual(self.runtime.store.pending_sync_count(), 0)
        self.assertEqual(calls["count"], 2)
        self.assertEqual(self.service.calls, 1)

    def test_restart_marks_interrupted_request_unknown_without_repay(self):
        intent = signed_intent()
        self.runtime.store.save_intent(intent)
        self.runtime.store.begin(intent)
        recovered = LocalPaymentStore(self.path)
        result = recovered.transaction_result(intent["transaction_uuid"])
        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertEqual(recovered.pending_sync_count(), 1)
        self.assertEqual(self.service.calls, 0)

    def test_loopback_http_restricts_origin_and_returns_cors(self):
        server = LocalPaymentHttpServer("127.0.0.1", 0, self.runtime)
        server.start()
        port = server.server.server_address[1]
        try:
            intent = signed_intent()
            body = json.dumps({"payment_intent": intent}).encode("utf-8")
            request = urllib.request.Request(
                f"http://127.0.0.1:{port}/local-payments/prepare",
                data=body,
                method="POST",
                headers={"content-type": "application/json", "Origin": ORIGIN},
            )
            with urllib.request.urlopen(request, timeout=2) as response:
                payload = json.loads(response.read())
                self.assertTrue(payload["ready"])
                self.assertEqual(response.headers["Access-Control-Allow-Origin"], ORIGIN)
                self.assertEqual(response.headers["Access-Control-Allow-Private-Network"], "true")
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
