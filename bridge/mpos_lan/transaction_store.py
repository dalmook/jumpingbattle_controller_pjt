"""SQLite transaction history, idempotency, and cross-process device lock."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
import sqlite3
from typing import Iterator

from .models import ErrorCode, TransactionResult, TransactionStatus, TransactionType


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class TransactionStore:
    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def _connection(self, *, timeout: float = 5.0) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=timeout)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    transaction_uuid TEXT NOT NULL UNIQUE,
                    transaction_type TEXT NOT NULL,
                    requested_at TEXT NOT NULL,
                    completed_at TEXT,
                    amount INTEGER NOT NULL CHECK(amount > 0),
                    status TEXT NOT NULL,
                    response_code TEXT NOT NULL DEFAULT '',
                    response_message TEXT NOT NULL DEFAULT '',
                    auth_no TEXT NOT NULL DEFAULT '',
                    auth_date TEXT NOT NULL DEFAULT '',
                    card_name TEXT NOT NULL DEFAULT '',
                    masked_card_no TEXT NOT NULL DEFAULT '',
                    issuer_code TEXT NOT NULL DEFAULT '',
                    issuer_name TEXT NOT NULL DEFAULT '',
                    acquirer_code TEXT NOT NULL DEFAULT '',
                    acquirer_name TEXT NOT NULL DEFAULT '',
                    installment TEXT NOT NULL DEFAULT '',
                    merchant_no TEXT NOT NULL DEFAULT '',
                    error_code TEXT NOT NULL DEFAULT 'NONE',
                    raw_return_code INTEGER,
                    elapsed_ms INTEGER NOT NULL DEFAULT 0,
                    original_transaction_id INTEGER,
                    FOREIGN KEY(original_transaction_id) REFERENCES transactions(id)
                );

                CREATE INDEX IF NOT EXISTS idx_transactions_auth
                    ON transactions(auth_date, auth_no, amount, status);
                CREATE INDEX IF NOT EXISTS idx_transactions_original
                    ON transactions(original_transaction_id, status);

                CREATE TABLE IF NOT EXISTS device_lock (
                    lock_name TEXT PRIMARY KEY,
                    owner_token TEXT NOT NULL,
                    acquired_at TEXT NOT NULL
                );
                """
            )
            connection.commit()

    def begin(
        self,
        transaction_uuid: str,
        transaction_type: TransactionType,
        amount: int,
        *,
        installment: str = "00",
        original_transaction_id: int | None = None,
    ) -> int:
        with self._connection() as connection:
            cursor = connection.execute(
                """
                INSERT INTO transactions (
                    transaction_uuid, transaction_type, requested_at, amount,
                    status, installment, original_transaction_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    transaction_uuid,
                    transaction_type.value,
                    _now(),
                    amount,
                    TransactionStatus.PENDING.value,
                    installment,
                    original_transaction_id,
                ),
            )
            connection.commit()
            return int(cursor.lastrowid)

    def complete(self, result: TransactionResult) -> None:
        with self._connection() as connection:
            connection.execute(
                """
                UPDATE transactions SET
                    completed_at=?, status=?, response_code=?, response_message=?,
                    auth_no=?, auth_date=?, card_name=?, masked_card_no=?,
                    issuer_code=?, issuer_name=?, acquirer_code=?, acquirer_name=?,
                    installment=?, merchant_no=?, error_code=?, raw_return_code=?,
                    elapsed_ms=?, original_transaction_id=COALESCE(?, original_transaction_id)
                WHERE transaction_uuid=?
                """,
                (
                    _now(),
                    result.status.value,
                    result.response_code,
                    result.response_message,
                    result.auth_no,
                    result.auth_date,
                    result.card_name,
                    result.masked_card_no,
                    result.issuer_code,
                    result.issuer_name,
                    result.acquirer_code,
                    result.acquirer_name,
                    result.installment,
                    result.merchant_no,
                    result.error_code.value,
                    result.raw_return_code,
                    result.elapsed_ms,
                    result.original_transaction_id,
                    result.transaction_uuid,
                ),
            )
            connection.commit()

    def get_by_uuid(self, transaction_uuid: str, *, replay: bool = False) -> TransactionResult | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM transactions WHERE transaction_uuid=?",
                (transaction_uuid,),
            ).fetchone()
        return self._to_result(row, replay=replay) if row else None

    def get_row_id(self, transaction_uuid: str) -> int | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT id FROM transactions WHERE transaction_uuid=?",
                (transaction_uuid,),
            ).fetchone()
        return int(row["id"]) if row else None

    def find_original_approval(self, amount: int, auth_date: str, auth_no: str) -> sqlite3.Row | None:
        date8 = "".join(char for char in auth_date if char.isdigit())[:8]
        with self._connection() as connection:
            return connection.execute(
                """
                SELECT * FROM transactions
                WHERE transaction_type=? AND status=? AND amount=? AND auth_no=?
                  AND substr(auth_date, 1, 8)=?
                ORDER BY id DESC LIMIT 1
                """,
                (
                    TransactionType.PAY.value,
                    TransactionStatus.APPROVED.value,
                    amount,
                    auth_no,
                    date8,
                ),
            ).fetchone()

    def find_guarded_cancel(self, original_transaction_id: int) -> TransactionResult | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM transactions
                WHERE original_transaction_id=? AND transaction_type=?
                  AND status IN (?, ?, ?)
                ORDER BY id DESC LIMIT 1
                """,
                (
                    original_transaction_id,
                    TransactionType.CANCEL.value,
                    TransactionStatus.CANCELLED.value,
                    TransactionStatus.PENDING.value,
                    TransactionStatus.UNKNOWN.value,
                ),
            ).fetchone()
        return self._to_result(row, replay=True) if row else None

    def acquire_device_lock(self, owner_token: str) -> bool:
        try:
            with self._connection(timeout=0.1) as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute(
                    "INSERT INTO device_lock(lock_name, owner_token, acquired_at) VALUES('MPOS', ?, ?)",
                    (owner_token, _now()),
                )
                connection.commit()
                return True
        except (sqlite3.IntegrityError, sqlite3.OperationalError):
            return False

    def release_device_lock(self, owner_token: str) -> None:
        with self._connection() as connection:
            connection.execute(
                "DELETE FROM device_lock WHERE lock_name='MPOS' AND owner_token=?",
                (owner_token,),
            )
            connection.commit()

    def lock_info(self) -> dict[str, str] | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT owner_token, acquired_at FROM device_lock WHERE lock_name='MPOS'"
            ).fetchone()
        return dict(row) if row else None

    def list_unknown(self) -> list[TransactionResult]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM transactions WHERE status=? ORDER BY id",
                (TransactionStatus.UNKNOWN.value,),
            ).fetchall()
        return [self._to_result(row) for row in rows]

    @staticmethod
    def _to_result(row: sqlite3.Row, *, replay: bool = False) -> TransactionResult:
        status = TransactionStatus(row["status"])
        return TransactionResult(
            success=status in (TransactionStatus.APPROVED, TransactionStatus.CANCELLED),
            transaction_uuid=row["transaction_uuid"],
            transaction_type=TransactionType(row["transaction_type"]),
            status=status,
            amount=int(row["amount"]),
            response_code=row["response_code"],
            response_message=row["response_message"],
            auth_no=row["auth_no"],
            auth_date=row["auth_date"],
            card_name=row["card_name"],
            issuer_code=row["issuer_code"],
            issuer_name=row["issuer_name"],
            acquirer_code=row["acquirer_code"],
            acquirer_name=row["acquirer_name"],
            masked_card_no=row["masked_card_no"],
            installment=row["installment"],
            merchant_no=row["merchant_no"],
            raw_return_code=row["raw_return_code"],
            elapsed_ms=int(row["elapsed_ms"]),
            error_code=ErrorCode(row["error_code"]),
            original_transaction_id=row["original_transaction_id"],
            idempotent_replay=replay,
        )

    def close(self) -> None:
        # Connections are short-lived and closed per operation.
        return None
