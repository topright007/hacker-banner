import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path


class Store:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600) if not Path(path).exists() else None
        if fd is not None:
            os.close(fd)
        with self.transaction() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, state TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS calls (
                    run_id TEXT NOT NULL, call_id TEXT NOT NULL, request_hash TEXT NOT NULL,
                    action_hash TEXT NOT NULL, response TEXT NOT NULL,
                    status TEXT NOT NULL, epoch INTEGER NOT NULL, expires REAL NOT NULL,
                    PRIMARY KEY(run_id, call_id));
                CREATE TABLE IF NOT EXISTS approvals (
                    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, call_id TEXT NOT NULL,
                    action_hash TEXT NOT NULL, epoch INTEGER NOT NULL, expires REAL NOT NULL,
                    policy_version TEXT NOT NULL, status TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
                    event_id TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL,
                    UNIQUE(run_id, event_id));
            """)

    @contextmanager
    def transaction(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def save_run(db, run):
        db.execute("UPDATE runs SET state=? WHERE id=?", (json.dumps(run), run["id"]))
