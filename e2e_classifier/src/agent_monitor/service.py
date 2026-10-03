import hashlib
import hmac
import json
import secrets
import time
from uuid import uuid4

from .models import ContentEvent, Decision, Evaluate, RunCreate, ToolResult
from .policy import Policy, digest, inspect_content
from .store import Store


class MonitorError(Exception):
    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Monitor:
    def __init__(self, store: Store, policy: Policy, clock=time.time):
        self.store, self.policy, self.clock = store, policy, clock

    def register(self, request: RunCreate) -> dict:
        if request.profile not in self.policy.data["profiles"]:
            raise MonitorError(422, "Unknown task profile")
        from pathlib import Path
        workspace = Path(request.workspace)
        if not workspace.is_absolute() or not workspace.is_dir():
            raise MonitorError(422, "Workspace must be an existing absolute directory visible to the monitor")
        run_id, token = str(uuid4()), secrets.token_urlsafe(32)
        sensitive_goal, _ = inspect_content(request.goal)
        run = {
            "id": run_id, "goal": request.goal, "workspace": str(workspace.resolve()),
            "profile": request.profile, "principal": request.principal,
            "session_id": request.session_id, "sensitive": sensitive_goal, "epoch": int(sensitive_goal),
            "calls": 0, "closed": False, "denied": [], "state_gap": False,
        }
        with self.store.transaction() as db:
            db.execute("INSERT INTO runs VALUES (?,?,?)", (run_id, token_hash(token), json.dumps(run)))
        return {"run_id": run_id, "run_token": token, "policy_version": self.policy.version}

    def _run(self, db, run_id, token, session=None):
        row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not row or not hmac.compare_digest(row["token_hash"], token_hash(token)):
            raise MonitorError(401, "Invalid run credential")
        run = json.loads(row["state"])
        if run["closed"]:
            raise MonitorError(409, "Run terminated")
        if session is not None:
            if run["session_id"] is None:
                run["session_id"] = session
                self.store.save_run(db, run)
            elif session != run["session_id"]:
                raise MonitorError(403, "Session outside registered run; delegation is disabled")
        return run

    def _event(self, db, run_id, event_id, request_hash, body):
        old = db.execute("SELECT request_hash FROM events WHERE run_id=? AND event_id=?", (run_id, event_id)).fetchone()
        if old:
            if old["request_hash"] != request_hash:
                raise MonitorError(409, "Event identifier reused with different content")
            return False
        db.execute("INSERT INTO events(run_id,event_id,request_hash,body) VALUES (?,?,?,?)",
                   (run_id, event_id, request_hash, json.dumps(body)))
        return True

    @staticmethod
    def _taint(run):
        if not run["sensitive"]:
            run["sensitive"] = True
            run["epoch"] += 1

    def evaluate(self, request: Evaluate, token: str) -> Decision:
        payload = request.model_dump()
        action = request.action.model_dump()
        request_hash, action_hash = digest(payload), digest(action)
        with self.store.transaction() as db:
            run = self._run(db, request.run_id, token, request.session_id)
            existing = db.execute("SELECT * FROM calls WHERE run_id=? AND call_id=?", (run["id"], request.call_id)).fetchone()
            approval = None
            if existing:
                if existing["request_hash"] != request_hash:
                    raise MonitorError(409, "Call identifier reused with different arguments")
                response = Decision.model_validate_json(existing["response"])
                if response.decision != "REQUIRE_APPROVAL":
                    return response  # Idempotence; /start separately rejects replay/stale allows.
                approval = db.execute("SELECT * FROM approvals WHERE id=?", (response.approval_id,)).fetchone()
                if approval and approval["status"] == "rejected":
                    raise MonitorError(403, "Exact action approval was rejected")
                if not approval or approval["status"] != "approved":
                    return response
                if approval["expires"] < self.clock() or approval["epoch"] != run["epoch"] or approval["policy_version"] != self.policy.version:
                    raise MonitorError(409, "Approval expired or security state changed; submit a new call")

            assessment = self.policy.assess(run, action)
            reasons = list(assessment.reasons)
            if run["state_gap"]:
                reasons.append("P11_INCOMPLETE_SECURITY_STATE")
            if run["calls"] >= self.policy.data["max_calls"]:
                reasons.append("P09_CALL_BUDGET")
            # Repeating a denied canonical outcome cannot gain authority by retrying.
            if action_hash in run["denied"]:
                reasons.append("P08_REPEATED_DENIED_ACTION")
            if reasons:
                verdict = "BLOCK"
                run["denied"] = (run["denied"] + [action_hash])[-100:]
            elif assessment.requires_approval and not approval:
                verdict = "REQUIRE_APPROVAL"
                reasons = ["P05_SENSITIVE_RUN_EGRESS"] if assessment.effect == "outbound" else ["P03_CONSEQUENTIAL_ACTION"]
            else:
                verdict = "ALLOW"
                # Set sensitivity BEFORE execution, conservatively retaining it on failure.
                if assessment.sensitive_read:
                    self._taint(run)
                run["calls"] += 1

            approval_id, permit = None, None
            if verdict == "REQUIRE_APPROVAL":
                approval_id = str(uuid4())
                db.execute("INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?)", (
                    approval_id, run["id"], request.call_id, action_hash, run["epoch"],
                    self.clock() + self.policy.data["approval_ttl_seconds"], self.policy.version, "pending"))
            if verdict == "ALLOW":
                permit = secrets.token_urlsafe(32)
                if approval:
                    db.execute("UPDATE approvals SET status='consumed' WHERE id=?", (approval["id"],))
            decision = Decision(
                decision_id=str(uuid4()), decision=verdict, action_hash=action_hash,
                policy_version=self.policy.version, reason_codes=reasons,
                findings=assessment.findings, sensitive_run=run["sensitive"],
                approval_id=approval_id, permit=permit)
            db.execute("INSERT OR REPLACE INTO calls VALUES (?,?,?,?,?,?,?,?)", (
                run["id"], request.call_id, request_hash, action_hash, decision.model_dump_json(),
                "pending", run["epoch"], self.clock() + self.policy.data["permit_ttl_seconds"]))
            self._event(db, run["id"], f"decision:{decision.decision_id}", request_hash, {
                "type": "decision", "call_id": request.call_id, "tool": action["tool"],
                **decision.model_dump(exclude={"permit"}), "time": self.clock()})
            self.store.save_run(db, run)
            return decision

    def start(self, request: Evaluate, token: str, permit: str):
        with self.store.transaction() as db:
            run = self._run(db, request.run_id, token, request.session_id)
            row = db.execute("SELECT * FROM calls WHERE run_id=? AND call_id=?", (run["id"], request.call_id)).fetchone()
            if not row or row["request_hash"] != digest(request.model_dump()):
                raise MonitorError(403, "No decision for exact call")
            decision = Decision.model_validate_json(row["response"])
            if decision.decision != "ALLOW" or not decision.permit or not hmac.compare_digest(permit, decision.permit):
                raise MonitorError(403, "Invalid execution permit")
            if row["status"] != "pending" or row["expires"] < self.clock() or row["epoch"] != run["epoch"] or decision.policy_version != self.policy.version or run["state_gap"]:
                raise MonitorError(409, "Permit used, expired, or invalidated by security state")
            db.execute("UPDATE calls SET status='started' WHERE run_id=? AND call_id=?", (run["id"], request.call_id))
            self._event(db, run["id"], f"start:{request.call_id}", row["action_hash"], {
                "type": "started", "call_id": request.call_id, "action_hash": row["action_hash"], "time": self.clock()})
        return {"started": True}

    def result(self, request: ToolResult, token: str):
        with self.store.transaction() as db:
            run = self._run(db, request.run_id, token, request.session_id)
            row = db.execute("SELECT * FROM calls WHERE run_id=? AND call_id=?", (run["id"], request.call_id)).fetchone()
            if not row:
                raise MonitorError(409, "Unobserved call")
            permit = json.loads(row["response"])["permit"]
            if not permit or not hmac.compare_digest(permit, request.permit):
                raise MonitorError(403, "Invalid result permit")
            body_hash = digest(request.model_dump())
            if row["status"] == "completed":
                self._event(db, run["id"], f"result:{request.call_id}", body_hash, {})
                return {"recorded": True, "sensitive_run": run["sensitive"]}
            if row["status"] != "started":
                raise MonitorError(409, "Tool was not authorized to start")
            text = json.dumps(request.result, ensure_ascii=False)
            sensitive, findings = inspect_content(text)
            if sensitive:
                self._taint(run)
            self._event(db, run["id"], f"result:{request.call_id}", body_hash, {
                "type": "result", "call_id": request.call_id, "status": request.status,
                "content_hash": digest(request.result), "findings": findings,
                "sensitive_run": run["sensitive"], "time": self.clock()})
            db.execute("UPDATE calls SET status='completed' WHERE run_id=? AND call_id=?", (run["id"], request.call_id))
            self.store.save_run(db, run)
        return {"recorded": True, "sensitive_run": run["sensitive"]}

    def content(self, request: ContentEvent, token: str):
        with self.store.transaction() as db:
            run = self._run(db, request.run_id, token, request.session_id)
            sensitive, findings = inspect_content(request.text)
            new = self._event(db, run["id"], request.event_id, digest(request.model_dump()), {
                "type": "content", "source": request.source, "findings": findings,
                "sensitive": sensitive, "content_hash": digest(request.text), "time": self.clock()})
            if new and sensitive:
                self._taint(run)
                self.store.save_run(db, run)
        return {"recorded": True, "findings": findings, "sensitive_run": run["sensitive"]}

    def approve(self, approval_id: str, approved: bool):
        with self.store.transaction() as db:
            row = db.execute("SELECT * FROM approvals WHERE id=?", (approval_id,)).fetchone()
            if not row:
                raise MonitorError(404, "Unknown approval")
            if row["status"] != "pending" or row["expires"] < self.clock():
                raise MonitorError(409, "Approval no longer pending")
            db.execute("UPDATE approvals SET status=? WHERE id=?", ("approved" if approved else "rejected", approval_id))
            self._event(db, row["run_id"], f"approval:{approval_id}", digest(approved), {
                "type": "approval", "call_id": row["call_id"], "action_hash": row["action_hash"],
                "approved": approved, "time": self.clock()})
        return {"approved": approved, "action_hash": row["action_hash"]}

    def inspect(self, run_id: str):
        with self.store.transaction() as db:
            row = db.execute("SELECT state FROM runs WHERE id=?", (run_id,)).fetchone()
            if not row:
                raise MonitorError(404, "Unknown run")
            events = db.execute("SELECT body FROM events WHERE run_id=? ORDER BY sequence", (run_id,)).fetchall()
            return {"run": json.loads(row["state"]), "events": [json.loads(e["body"]) for e in events]}

    def terminate(self, run_id: str):
        with self.store.transaction() as db:
            row = db.execute("SELECT state FROM runs WHERE id=?", (run_id,)).fetchone()
            if not row:
                raise MonitorError(404, "Unknown run")
            run = json.loads(row["state"])
            run["closed"] = True
            self.store.save_run(db, run)
        return {"closed": True}
