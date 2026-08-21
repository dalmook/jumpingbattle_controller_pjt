"""Loopback-only Local Direct Payment V2 adapter.

This module deliberately wraps the existing PaymentService.  It does not load
the vendor DLL, implement the MPOS protocol, or retry a terminal transaction.
Only durable Cloud result uploads are retried.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import sqlite3
import threading
import time
import urllib.parse
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable


INTENT_DOMAIN = "JUMPING_PAYMENT_INTENT_V1"
FINAL_STATUSES = {
    "APPROVED", "COMPLETED", "DECLINED", "USER_CANCELLED", "CANCELLED",
    "UNKNOWN", "BUSY", "ERROR",
}
OUTBOX_BACKOFF_SECONDS = (1, 3, 10, 30, 60)
PERMANENT_SYNC_ERROR_CODES = ("LOCAL_PAYMENT_INTENT_INACTIVE",)


def is_permanent_sync_error(error: Exception | str) -> bool:
    message = str(error)
    return any(code in message for code in PERMANENT_SYNC_ERROR_CODES)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def canonical_payment_intent(intent: dict[str, Any]) -> str:
    return "\n".join(
        [
            INTENT_DOMAIN,
            str(intent.get("version", "")),
            str(intent.get("intent_id", "")),
            str(intent.get("reservation_id", "")),
            str(intent.get("payment_id", "")),
            str(intent.get("attempt_id", "")),
            str(intent.get("transaction_uuid", "")),
            str(intent.get("amount", "")),
            str(intent.get("payment_method", "")),
            str(intent.get("issued_at", "")),
            str(intent.get("expires_at", "")),
            str(intent.get("nonce", "")),
            str(intent.get("trace_id", "")),
        ]
    )


def intent_signature(intent: dict[str, Any], secret: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        canonical_payment_intent(intent).encode("utf-8"),
        hashlib.sha256,
    ).digest()
    import base64

    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def validate_payment_intent(intent: Any, secret: str) -> dict[str, Any]:
    if not isinstance(intent, dict):
        raise ValueError("PAYMENT_INTENT_INVALID")
    required = (
        "intent_id", "reservation_id", "payment_id", "attempt_id",
        "transaction_uuid", "amount", "payment_method", "issued_at",
        "expires_at", "nonce", "trace_id", "signature",
    )
    if int(intent.get("version", 0) or 0) != 1:
        raise ValueError("PAYMENT_INTENT_VERSION_UNSUPPORTED")
    if any(not str(intent.get(key, "")).strip() for key in required):
        raise ValueError("PAYMENT_INTENT_FIELDS_MISSING")
    if str(intent.get("payment_method")) != "CARD":
        raise ValueError("PAYMENT_INTENT_CARD_ONLY")
    amount = int(intent.get("amount", 0) or 0)
    if amount <= 0 or amount > 10_000_000:
        raise ValueError("PAYMENT_INTENT_AMOUNT_INVALID")
    try:
        expires_at = datetime.fromisoformat(str(intent["expires_at"]).replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("PAYMENT_INTENT_EXPIRY_INVALID") from exc
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= datetime.now(timezone.utc):
        raise ValueError("PAYMENT_INTENT_EXPIRED")
    expected = intent_signature(intent, secret)
    if not hmac.compare_digest(expected, str(intent.get("signature", ""))):
        raise ValueError("PAYMENT_INTENT_SIGNATURE_INVALID")
    return dict(intent)


class LocalPaymentStore:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()
        self.quarantine_nonretryable_outbox()
        self.recover_interrupted_transactions()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self):
        with self._lock, self._connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS local_payment_intents (
                  intent_id TEXT PRIMARY KEY,
                  transaction_uuid TEXT NOT NULL,
                  reservation_id TEXT NOT NULL,
                  payment_id TEXT NOT NULL,
                  attempt_id TEXT NOT NULL,
                  amount INTEGER NOT NULL,
                  nonce TEXT NOT NULL UNIQUE,
                  signature TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'READY',
                  intent_json TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS local_payment_intents_status_idx
                  ON local_payment_intents(status, expires_at);
                CREATE INDEX IF NOT EXISTS local_payment_intents_transaction_idx
                  ON local_payment_intents(transaction_uuid, created_at);

                CREATE TABLE IF NOT EXISTS local_payment_transactions (
                  transaction_uuid TEXT PRIMARY KEY,
                  intent_id TEXT NOT NULL UNIQUE,
                  reservation_id TEXT NOT NULL,
                  payment_id TEXT NOT NULL,
                  attempt_id TEXT NOT NULL,
                  amount INTEGER NOT NULL,
                  status TEXT NOT NULL,
                  result_json TEXT NOT NULL DEFAULT '',
                  cloud_sync_status TEXT NOT NULL DEFAULT 'PENDING',
                  cloud_synced_at TEXT,
                  created_at TEXT NOT NULL,
                  completed_at TEXT,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS local_payment_transactions_sync_idx
                  ON local_payment_transactions(cloud_sync_status, updated_at);

                CREATE TABLE IF NOT EXISTS cloud_sync_outbox (
                  id TEXT PRIMARY KEY,
                  transaction_uuid TEXT NOT NULL UNIQUE,
                  event_type TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'PENDING',
                  attempt_count INTEGER NOT NULL DEFAULT 0,
                  next_retry_at REAL NOT NULL DEFAULT 0,
                  last_error TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL,
                  synced_at TEXT,
                  updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS cloud_sync_outbox_due_idx
                  ON cloud_sync_outbox(status, next_retry_at);
                """
            )

    def recover_interrupted_transactions(self):
        now = utc_now()
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM local_payment_transactions WHERE status IN ('PENDING', 'PROCESSING')"
            ).fetchall()
            for row in rows:
                result = {
                    "kind": "payment",
                    "success": False,
                    "transaction_uuid": row["transaction_uuid"],
                    "transaction_type": "PAY",
                    "status": "UNKNOWN",
                    "amount": row["amount"],
                    "response_message": "브릿지 재시작으로 승인 결과 확인이 필요합니다.",
                    "error_code": "UNKNOWN",
                }
                intent_row = connection.execute(
                    "SELECT intent_json FROM local_payment_intents WHERE intent_id = ?",
                    (row["intent_id"],),
                ).fetchone()
                if intent_row is None:
                    continue
                payload = {
                    "intent": json.loads(intent_row["intent_json"]),
                    "result": result,
                    "localDurableAt": now,
                }
                connection.execute(
                    "UPDATE local_payment_transactions SET status = 'UNKNOWN', result_json = ?, "
                    "completed_at = ?, updated_at = ? WHERE transaction_uuid = ?",
                    (json.dumps(result, ensure_ascii=False), now, now, row["transaction_uuid"]),
                )
                connection.execute(
                    "INSERT INTO cloud_sync_outbox "
                    "(id, transaction_uuid, event_type, payload_json, status, next_retry_at, created_at, updated_at) "
                    "VALUES (?, ?, 'PAYMENT_RESULT', ?, 'PENDING', 0, ?, ?) "
                    "ON CONFLICT(transaction_uuid) DO UPDATE SET payload_json = excluded.payload_json, "
                    "status = 'PENDING', next_retry_at = 0, updated_at = excluded.updated_at",
                    (str(uuid.uuid4()), row["transaction_uuid"], json.dumps(payload, ensure_ascii=False), now, now),
                )

    def save_intent(self, intent: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        encoded = json.dumps(intent, ensure_ascii=False, separators=(",", ":"))
        with self._lock, self._connection() as connection:
            existing = connection.execute(
                "SELECT * FROM local_payment_intents WHERE intent_id = ? LIMIT 1",
                (intent["intent_id"],),
            ).fetchone()
            if existing is not None:
                if (
                    existing["signature"] != intent["signature"]
                    or int(existing["amount"]) != int(intent["amount"])
                ):
                    raise ValueError("PAYMENT_INTENT_REPLAY_CONFLICT")
                if existing["status"] in ("REVOKED", "EXPIRED"):
                    transaction = connection.execute(
                        "SELECT status FROM local_payment_transactions WHERE transaction_uuid = ? LIMIT 1",
                        (intent["transaction_uuid"],),
                    ).fetchone()
                    if transaction is None:
                        raise ValueError("PAYMENT_INTENT_INACTIVE")
                return json.loads(existing["intent_json"])
            prior = connection.execute(
                "SELECT * FROM local_payment_intents WHERE transaction_uuid = ? "
                "ORDER BY created_at DESC LIMIT 1",
                (intent["transaction_uuid"],),
            ).fetchone()
            if prior is not None:
                transaction = connection.execute(
                    "SELECT status FROM local_payment_transactions WHERE transaction_uuid = ? LIMIT 1",
                    (intent["transaction_uuid"],),
                ).fetchone()
                if transaction is not None or prior["status"] not in ("READY", "REVOKED", "EXPIRED"):
                    raise ValueError("PAYMENT_INTENT_REPLAY_CONFLICT")
                if int(prior["amount"]) != int(intent["amount"]):
                    raise ValueError("PAYMENT_INTENT_REPLAY_CONFLICT")
                connection.execute(
                    "UPDATE local_payment_intents SET status = 'REVOKED', updated_at = ? "
                    "WHERE intent_id = ? AND status = 'READY'",
                    (now, prior["intent_id"]),
                )
            connection.execute(
                "INSERT INTO local_payment_intents "
                "(intent_id, transaction_uuid, reservation_id, payment_id, attempt_id, amount, nonce, "
                "signature, status, intent_json, expires_at, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?)",
                (
                    intent["intent_id"], intent["transaction_uuid"], intent["reservation_id"],
                    intent["payment_id"], intent["attempt_id"], int(intent["amount"]), intent["nonce"],
                    intent["signature"], encoded, intent["expires_at"], now, now,
                ),
            )
        return intent

    def transaction_result(self, transaction_uuid: str) -> dict[str, Any] | None:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT status, result_json, cloud_sync_status, cloud_synced_at "
                "FROM local_payment_transactions WHERE transaction_uuid = ? LIMIT 1",
                (transaction_uuid,),
            ).fetchone()
        if row is None:
            return None
        result = json.loads(row["result_json"]) if row["result_json"] else {}
        return {
            "status": row["status"],
            "result": result,
            "cloud_sync_status": row["cloud_sync_status"],
            "cloud_synced_at": row["cloud_synced_at"],
        }

    def begin(self, intent: dict[str, Any]) -> dict[str, Any] | None:
        now = utc_now()
        with self._lock, self._connection() as connection:
            existing = connection.execute(
                "SELECT status, result_json, amount, intent_id FROM local_payment_transactions "
                "WHERE transaction_uuid = ? LIMIT 1",
                (intent["transaction_uuid"],),
            ).fetchone()
            if existing is not None:
                if existing["intent_id"] != intent["intent_id"] or int(existing["amount"]) != int(intent["amount"]):
                    raise ValueError("LOCAL_PAYMENT_TRANSACTION_CONFLICT")
                return json.loads(existing["result_json"]) if existing["result_json"] else {
                    "kind": "payment",
                    "success": False,
                    "transaction_uuid": intent["transaction_uuid"],
                    "transaction_type": "PAY",
                    "status": "UNKNOWN",
                    "amount": intent["amount"],
                    "response_message": "동일 거래가 이미 처리 중이거나 결과 확인이 필요합니다.",
                    "error_code": "UNKNOWN",
                }
            connection.execute(
                "INSERT INTO local_payment_transactions "
                "(transaction_uuid, intent_id, reservation_id, payment_id, attempt_id, amount, status, "
                "cloud_sync_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING', 'PENDING', ?, ?)",
                (
                    intent["transaction_uuid"], intent["intent_id"], intent["reservation_id"],
                    intent["payment_id"], intent["attempt_id"], int(intent["amount"]), now, now,
                ),
            )
            connection.execute(
                "UPDATE local_payment_intents SET status = 'PROCESSING', updated_at = ? WHERE intent_id = ?",
                (now, intent["intent_id"]),
            )
        return None

    def complete(self, intent: dict[str, Any], result: dict[str, Any]) -> str:
        now = utc_now()
        status = str(result.get("status", "UNKNOWN")).upper()
        if status not in FINAL_STATUSES:
            status = "UNKNOWN"
            result = {**result, "status": status, "error_code": "UNKNOWN"}
        result_json = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        payload = {
            "intent": intent,
            "result": result,
            "localDurableAt": now,
        }
        payload_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "UPDATE local_payment_transactions SET status = ?, result_json = ?, cloud_sync_status = 'PENDING', "
                "completed_at = ?, updated_at = ? WHERE transaction_uuid = ?",
                (status, result_json, now, now, intent["transaction_uuid"]),
            )
            connection.execute(
                "UPDATE local_payment_intents SET status = ?, updated_at = ? WHERE intent_id = ?",
                (status, now, intent["intent_id"]),
            )
            connection.execute(
                "INSERT INTO cloud_sync_outbox "
                "(id, transaction_uuid, event_type, payload_json, status, next_retry_at, created_at, updated_at) "
                "VALUES (?, ?, 'PAYMENT_RESULT', ?, 'PENDING', 0, ?, ?) "
                "ON CONFLICT(transaction_uuid) DO UPDATE SET payload_json = excluded.payload_json, "
                "status = CASE WHEN cloud_sync_outbox.status = 'SYNCED' THEN 'SYNCED' ELSE 'PENDING' END, "
                "next_retry_at = 0, updated_at = excluded.updated_at",
                (str(uuid.uuid4()), intent["transaction_uuid"], payload_json, now, now),
            )
            connection.commit()
        return now

    def due_outbox(self, limit: int = 10) -> list[dict[str, Any]]:
        with self._lock, self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM cloud_sync_outbox WHERE status IN ('PENDING', 'FAILED') "
                "AND next_retry_at <= ? "
                "ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END, "
                "CASE WHEN status = 'PENDING' THEN created_at END, next_retry_at, created_at LIMIT ?",
                (time.time(), limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def quarantine_nonretryable_outbox(self) -> int:
        now = utc_now()
        with self._lock, self._connection() as connection:
            cursor = connection.execute(
                "UPDATE cloud_sync_outbox SET status = 'QUARANTINED', next_retry_at = 0, updated_at = ? "
                "WHERE status IN ('PENDING', 'FAILED') AND last_error LIKE ?",
                (now, "%LOCAL_PAYMENT_INTENT_INACTIVE%"),
            )
        quarantined = max(0, int(cursor.rowcount or 0))
        if quarantined:
            logging.warning("Local Direct 영구 실패 결과 %s건을 재시도 대기열에서 격리했습니다.", quarantined)
        return quarantined

    def mark_synced(self, outbox_id: str, transaction_uuid: str):
        now = utc_now()
        with self._lock, self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "UPDATE cloud_sync_outbox SET status = 'SYNCED', synced_at = ?, updated_at = ? WHERE id = ?",
                (now, now, outbox_id),
            )
            connection.execute(
                "UPDATE local_payment_transactions SET cloud_sync_status = 'SYNCED', cloud_synced_at = ?, "
                "updated_at = ? WHERE transaction_uuid = ?",
                (now, now, transaction_uuid),
            )
            connection.commit()

    def mark_sync_failed(self, row: dict[str, Any], error: Exception):
        attempts = int(row.get("attempt_count", 0) or 0) + 1
        now = utc_now()
        message = str(error)[:300]
        if is_permanent_sync_error(error):
            with self._lock, self._connection() as connection:
                connection.execute(
                    "UPDATE cloud_sync_outbox SET status = 'QUARANTINED', attempt_count = ?, "
                    "next_retry_at = 0, last_error = ?, updated_at = ? WHERE id = ?",
                    (attempts, message, now, row["id"]),
                )
            logging.warning("Local Direct 영구 실패 결과 격리: %s", row["transaction_uuid"])
            return
        delay = OUTBOX_BACKOFF_SECONDS[min(attempts - 1, len(OUTBOX_BACKOFF_SECONDS) - 1)]
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE cloud_sync_outbox SET status = 'FAILED', attempt_count = ?, next_retry_at = ?, "
                "last_error = ?, updated_at = ? WHERE id = ?",
                (attempts, time.time() + delay, message, now, row["id"]),
            )

    def defer_sync(self, outbox_id: str):
        now = utc_now()
        with self._lock, self._connection() as connection:
            connection.execute(
                "UPDATE cloud_sync_outbox SET status = 'PENDING', next_retry_at = 0, "
                "last_error = '', updated_at = ? WHERE id = ?",
                (now, outbox_id),
            )

    def pending_sync_count(self) -> int:
        with self._lock, self._connection() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM cloud_sync_outbox WHERE status IN ('PENDING', 'FAILED')"
            ).fetchone()
        return int(row["count"] if row else 0)


class LocalPaymentRuntime:
    def __init__(
        self,
        *,
        secret: str,
        allowed_origins: set[str],
        store: LocalPaymentStore,
        payment_service: Any,
        sync_result: Callable[[dict[str, Any]], Any],
    ):
        if len(secret.strip()) < 24:
            raise ValueError("Local Payment 서명키가 너무 짧습니다.")
        self.secret = secret
        self.allowed_origins = {origin.rstrip("/") for origin in allowed_origins if origin}
        self.store = store
        self.payment_service = payment_service
        self.sync_result = sync_result
        self._execute_lock = threading.Lock()
        self._sync_wakeup = threading.Event()

    def verify(self, intent: Any) -> dict[str, Any]:
        return validate_payment_intent(intent, self.secret)

    def prepare(self, intent_value: Any) -> dict[str, Any]:
        intent = self.verify(intent_value)
        self.store.save_intent(intent)
        return {
            "ready": True,
            "intent_id": intent["intent_id"],
            "transaction_uuid": intent["transaction_uuid"],
            "expires_at": intent["expires_at"],
        }

    def execute(self, intent_value: Any) -> dict[str, Any]:
        received = time.perf_counter()
        intent = self.verify(intent_value)
        self.store.save_intent(intent)
        existing = self.store.transaction_result(intent["transaction_uuid"])
        if existing is not None and existing["status"] in FINAL_STATUSES:
            return {
                **existing["result"],
                "replayed": True,
                "request_sent": True,
                "cloud_sync_status": existing["cloud_sync_status"],
            }
        if not self._execute_lock.acquire(blocking=False):
            return {
                "kind": "payment",
                "success": False,
                "transaction_uuid": intent["transaction_uuid"],
                "transaction_type": "PAY",
                "status": "BUSY",
                "amount": intent["amount"],
                "response_message": "다른 카드 거래가 진행 중입니다.",
                "error_code": "BUSY",
                "request_sent": False,
            }
        try:
            repeated = self.store.begin(intent)
            if repeated is not None:
                return {**repeated, "replayed": True, "request_sent": True}
            logging.info(
                "[LD TRACE] trace=%s stage=LD_BRIDGE_RECEIVED elapsed_ms=%.3f intent=%s amount=%d",
                intent["trace_id"], (time.perf_counter() - received) * 1000,
                intent["intent_id"], intent["amount"],
            )
            try:
                result = self.payment_service.execute(
                    "payment_pay",
                    {
                        "reservationId": intent["reservation_id"],
                        "transactionUuid": intent["transaction_uuid"],
                        "amount": intent["amount"],
                        "traceId": intent["trace_id"],
                    },
                )
            except Exception as exc:
                logging.exception("Local Direct MPOS 결과 확인 실패")
                result = {
                    "kind": "payment",
                    "success": False,
                    "transaction_uuid": intent["transaction_uuid"],
                    "transaction_type": "PAY",
                    "status": "UNKNOWN",
                    "amount": intent["amount"],
                    "response_message": "단말 요청 결과를 확인하지 못했습니다.",
                    "error_code": "UNKNOWN",
                    "trace_id": intent["trace_id"],
                    "bridge_error_type": type(exc).__name__,
                }
            logging.info(
                "[LD TRACE] trace=%s stage=LOCAL_DURABLE_START elapsed_ms=%.3f",
                intent["trace_id"], (time.perf_counter() - received) * 1000,
            )
            local_durable_at = self.store.complete(intent, result)
            logging.info(
                "[LD TRACE] trace=%s stage=LOCAL_DURABLE_DONE elapsed_ms=%.3f status=%s",
                intent["trace_id"], (time.perf_counter() - received) * 1000, result.get("status"),
            )
            self._sync_wakeup.set()
            return {
                **result,
                "request_sent": True,
                "local_durable_at": local_durable_at,
                "cloud_sync_status": "PENDING",
            }
        finally:
            self._execute_lock.release()

    def sync_due(self):
        for row in self.store.due_outbox():
            try:
                payload = json.loads(row["payload_json"])
                response = self.sync_result(payload)
                if isinstance(response, dict) and response.get("synced") is False:
                    self.store.defer_sync(row["id"])
                    logging.info(
                        "Local Direct 핵심 결제 원장 반영 완료, 후처리 재개 대기: %s",
                        row["transaction_uuid"],
                    )
                    continue
                self.store.mark_synced(row["id"], row["transaction_uuid"])
                logging.info("Local Direct cloud sync complete: %s", row["transaction_uuid"])
            except Exception as exc:
                self.store.mark_sync_failed(row, exc)

    def wait_for_sync(self, timeout: float = 0.5) -> bool:
        signaled = self._sync_wakeup.wait(timeout)
        self._sync_wakeup.clear()
        return signaled


class LocalPaymentHttpServer:
    def __init__(self, host: str, port: int, runtime: LocalPaymentRuntime):
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("Local Payment API는 loopback 주소에만 바인딩할 수 있습니다.")
        self.runtime = runtime
        handler = self._handler_type(runtime)
        self.server = ThreadingHTTPServer((host, port), handler)
        self.thread: threading.Thread | None = None

    @staticmethod
    def _handler_type(runtime: LocalPaymentRuntime):
        class Handler(BaseHTTPRequestHandler):
            server_version = "JumpingBattleLocalPayment/2"

            def log_message(self, format_string: str, *args: Any):
                logging.debug("Local Payment HTTP: " + format_string, *args)

            def _origin_allowed(self) -> bool:
                origin = self.headers.get("Origin", "").rstrip("/")
                return bool(origin and origin in runtime.allowed_origins)

            def _cors(self):
                origin = self.headers.get("Origin", "").rstrip("/")
                if origin in runtime.allowed_origins:
                    self.send_header("Access-Control-Allow-Origin", origin)
                    self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "content-type, x-payment-trace-id")
                self.send_header("Access-Control-Allow-Private-Network", "true")
                self.send_header("Access-Control-Max-Age", "600")

            def _json(self, status: int, payload: dict[str, Any]):
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self._cors()
                self.send_header("content-type", "application/json; charset=utf-8")
                self.send_header("content-length", str(len(body)))
                self.send_header("cache-control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _body(self) -> dict[str, Any]:
                size = int(self.headers.get("Content-Length", "0") or 0)
                if size <= 0 or size > 64_000:
                    raise ValueError("REQUEST_BODY_INVALID")
                value = json.loads(self.rfile.read(size).decode("utf-8"))
                if not isinstance(value, dict):
                    raise ValueError("REQUEST_BODY_INVALID")
                return value

            def do_OPTIONS(self):
                if not self._origin_allowed():
                    self._json(403, {"error": "ORIGIN_NOT_ALLOWED"})
                    return
                self.send_response(204)
                self._cors()
                self.send_header("content-length", "0")
                self.end_headers()

            def do_GET(self):
                path = urllib.parse.urlsplit(self.path).path
                if path == "/health":
                    self._json(200, {
                        "ok": True,
                        "service": "local-direct-payment-v2",
                        "pending_cloud_sync": runtime.store.pending_sync_count(),
                    })
                    return
                if path.startswith("/local-payments/"):
                    if not self._origin_allowed():
                        self._json(403, {"error": "ORIGIN_NOT_ALLOWED"})
                        return
                    transaction_uuid = path.rsplit("/", 1)[-1]
                    result = runtime.store.transaction_result(transaction_uuid)
                    self._json(200 if result else 404, result or {"error": "NOT_FOUND"})
                    return
                self._json(404, {"error": "NOT_FOUND"})

            def do_POST(self):
                if not self._origin_allowed():
                    self._json(403, {"error": "ORIGIN_NOT_ALLOWED"})
                    return
                try:
                    body = self._body()
                    path = urllib.parse.urlsplit(self.path).path
                    if path == "/local-payments/prepare":
                        self._json(200, runtime.prepare(body.get("payment_intent")))
                        return
                    if path == "/local-payments/execute":
                        self._json(200, runtime.execute(body.get("payment_intent")))
                        return
                    self._json(404, {"error": "NOT_FOUND"})
                except (ValueError, json.JSONDecodeError) as exc:
                    self._json(409, {"error": str(exc), "request_sent": False})
                except Exception as exc:
                    logging.exception("Local Payment HTTP 처리 오류")
                    self._json(500, {"error": type(exc).__name__})

        return Handler

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            name="local-payment-http",
            daemon=True,
        )
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=3.0)
