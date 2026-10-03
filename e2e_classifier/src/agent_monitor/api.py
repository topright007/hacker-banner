import hmac
import os

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from .models import Approval, ContentEvent, Evaluate, RunCreate, ToolResult
from .policy import Policy
from .service import Monitor, MonitorError
from .store import Store


def create_app(db_path=None, policy_path=None, admin_token=None):
    admin_token = admin_token or os.environ.get("MONITOR_ADMIN_TOKEN")
    if not admin_token or len(admin_token) < 24:
        raise RuntimeError("Set MONITOR_ADMIN_TOKEN to a random token of at least 24 characters")
    monitor = Monitor(Store(db_path or os.environ.get("MONITOR_DB", ".monitor/state.sqlite")),
                      Policy(policy_path or os.environ.get("MONITOR_POLICY", "config/policies.yaml")))
    app = FastAPI(title="Agent Monitor", version="0.1.0")
    app.state.monitor = monitor

    def bearer(authorization: str = Header(default="")):
        if not authorization.startswith("Bearer "):
            raise HTTPException(401, "Bearer credential required")
        return authorization[7:]

    def admin(token=Depends(bearer)):
        if not hmac.compare_digest(token, admin_token):
            raise HTTPException(403, "Administrator credential required")

    @app.exception_handler(MonitorError)
    async def error_handler(request: Request, exc: MonitorError):
        return JSONResponse(status_code=exc.status, content={"detail": exc.detail})

    @app.middleware("http")
    async def size_limit(request: Request, call_next):
        # Bound decoded input, including clients using chunked transfer.
        parts, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 262144:
                return JSONResponse(status_code=413, content={"detail": "Request exceeds 256 KiB"})
            parts.append(chunk)
        request._body = b"".join(parts)
        return await call_next(request)

    @app.get("/health")
    def health():
        return {"status": "ok", "schema_version": 1, "policy_version": monitor.policy.version}

    @app.post("/v1/runs", dependencies=[Depends(admin)])
    def register(request: RunCreate):
        return monitor.register(request)

    @app.post("/v1/evaluate")
    def evaluate(request: Evaluate, token=Depends(bearer)):
        return monitor.evaluate(request, token)

    @app.post("/v1/start")
    def start(request: Evaluate, token=Depends(bearer), x_execution_permit: str = Header(default="")):
        return monitor.start(request, token, x_execution_permit)

    @app.post("/v1/results")
    def result(request: ToolResult, token=Depends(bearer)):
        return monitor.result(request, token)

    @app.post("/v1/events")
    def content(request: ContentEvent, token=Depends(bearer)):
        return monitor.content(request, token)

    @app.post("/v1/approvals/{approval_id}", dependencies=[Depends(admin)])
    def approve(approval_id: str, request: Approval):
        return monitor.approve(approval_id, request.approve)

    @app.get("/v1/runs/{run_id}/events", dependencies=[Depends(admin)])
    def events(run_id: str):
        return monitor.inspect(run_id)

    @app.post("/v1/runs/{run_id}/terminate", dependencies=[Depends(admin)])
    def terminate(run_id: str):
        return monitor.terminate(run_id)

    return app
