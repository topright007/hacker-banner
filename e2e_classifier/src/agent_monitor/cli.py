"""Trusted operator CLI. Never give administrator credentials to the agent."""
import argparse
import json
import os
from pathlib import Path
import secrets

import httpx
import uvicorn


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=8765)
    register = commands.add_parser("register")
    register.add_argument("--goal", required=True)
    register.add_argument("--workspace", required=True)
    register.add_argument("--profile", default="review")
    register.add_argument("--output", required=True, help="Private credential file OUTSIDE agent workspace")
    register.add_argument("--session")
    approve = commands.add_parser("approve")
    approve.add_argument("approval_id")
    approve.add_argument("--reject", action="store_true")
    for name in ("inspect", "terminate"):
        commands.add_parser(name).add_argument("run_id")
    commands.add_parser("token")
    args = parser.parse_args()
    if args.command == "token":
        print(secrets.token_urlsafe(32))
        return
    if args.command == "serve":
        uvicorn.run("agent_monitor.api:create_app", factory=True, host="127.0.0.1", port=args.port)
        return
    token = os.environ.get("MONITOR_ADMIN_TOKEN", "")
    if len(token) < 24:
        parser.error("MONITOR_ADMIN_TOKEN must contain at least 24 characters")
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(base_url=args.url, headers=headers, timeout=10) as client:
        if args.command == "register":
            workspace = Path(args.workspace).resolve()
            output = Path(args.output).resolve()
            if output.is_relative_to(workspace):
                parser.error("Run credentials must be stored outside the agent workspace")
            response = client.post("/v1/runs", json={"goal": args.goal, "workspace": str(workspace),
                                                     "profile": args.profile, "session_id": args.session})
        elif args.command == "approve":
            response = client.post(f"/v1/approvals/{args.approval_id}", json={"approve": not args.reject})
        elif args.command == "inspect":
            response = client.get(f"/v1/runs/{args.run_id}/events")
        else:
            response = client.post(f"/v1/runs/{args.run_id}/terminate")
        response.raise_for_status()
        data = response.json()
    if args.command == "register":
        data["url"] = args.url
        data["workspace"] = str(workspace)
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream)
        print(json.dumps({"run_id": data["run_id"], "credentials": str(output)}))
    else:
        print(json.dumps(data, indent=2))


if __name__ == "__main__":
    main()
