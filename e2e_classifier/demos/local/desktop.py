"""Desktop lifecycle for the synthetic demo (no login/background installation)."""
import json
import os
from pathlib import Path
import subprocess
import time


def desktop_seed(user_data, workspace):
    """Seed only a brand-new profile. Never overwrite an existing desktop profile."""
    if user_data.exists():
        return False
    user_data.mkdir(parents=True, mode=0o700)
    (user_data / "opencode.settings").write_text(json.dumps({
        "defaultServerUrl": "sidecar", "firstLaunchOnboardingComplete": True,
    }))
    state = {"list": [], "hidden": {},
             "projects": {"local": [{"worktree": str(workspace), "expanded": True}]},
             "lastProject": {"local": str(workspace)}, "recentlyClosed": {}}
    (user_data / "opencode.global.dat").write_text(json.dumps({"server": json.dumps(state)}))
    return True


def preflight_passed(events, marker_exists):
    decisions = [e for e in events if e.get("type") == "decision"]
    completed = {e["call_id"] for e in events if e.get("type") == "result" and e.get("status") == "completed"}
    started = {e["call_id"] for e in events if e.get("type") == "started"}
    read_ok = any(e["tool"] in {"read", "fixture_read_public"} and e["decision"] == "ALLOW" and
                  e["call_id"] in completed for e in decisions)
    write_blocked = any(e["tool"] == "write" and e["decision"] == "BLOCK" and
                        "P01_READ_ONLY_TASK" in e["reason_codes"] and e["call_id"] not in started for e in decisions)
    return read_ok and write_blocked and not marker_exists


def desktop_demo(root, base, workspace, env, monitor, run_id, model, stop):
    app = root / ".runtime/desktop/OpenCode.app/Contents/MacOS/OpenCode"
    if not app.exists():
        raise RuntimeError("Install the signed OpenCode Desktop 2.0.22 app in .runtime/desktop first")
    if subprocess.run(["/usr/bin/pgrep", "-x", "OpenCode"], capture_output=True).returncode == 0:
        raise RuntimeError("Quit the already-running OpenCode desktop before starting the dedicated demo")
    # Desktop reloads a login shell environment. /bin/sh preserves our dedicated
    # XDG settings without loading the user's interactive shell/API credentials.
    env = {**env, "SHELL": "/bin/sh"}
    subprocess.run(["/usr/bin/git", "init", "-q", str(workspace)], check=True, env=env)
    backend = desktop = None
    current = root / ".runtime/desktop-current.json"
    with (base / "opencode-server.log").open("a") as backend_log, (base / "desktop.log").open("a") as desktop_log:
        try:
            backend = subprocess.Popen([str(root / ".runtime/opencode/node_modules/.bin/opencode"),
                "serve", "--service", "--hostname", "127.0.0.1", "--port", "0"],
                cwd=workspace, env=env, stdout=backend_log, stderr=backend_log)
            bootstrap = subprocess.run([str(root / ".conda-env/bin/node"),
                str(root / "demos/local/desktop.mjs"), str(workspace), model],
                env=env, capture_output=True, text=True, timeout=420)
            print(bootstrap.stderr, end="", flush=True)
            if bootstrap.returncode:
                raise RuntimeError(f"Desktop backend setup failed: {bootstrap.stdout}\n{bootstrap.stderr}\nLog: {base / 'opencode-server.log'}")
            connection = json.loads(bootstrap.stdout)
            preflight = monitor.inspect(run_id)
            if not preflight_passed(preflight["events"], (workspace / "demo.marker").exists()):
                raise RuntimeError("Real-model preflight did not demonstrate an allowed read AND a blocked write; desktop not launched")
            (base / "preflight.json").write_text(json.dumps(preflight, indent=2))
            user_data = Path.home() / "Library/Application Support/ai.opencode.desktop"
            seeded = desktop_seed(user_data, workspace)
            desktop = subprocess.Popen([str(app)], cwd=workspace, env=env, stdout=desktop_log, stderr=desktop_log)
            state = {**connection, "launcher_pid": os.getpid(), "backend_pid": backend.pid,
                     "desktop_pid": desktop.pid, "workspace": str(workspace), "base": str(base),
                     "model": model, "profile": "review", "preflight": "passed", "seeded_profile": seeded,
                     "audit_live": str(base / "audit-live.jsonl")}
            current.write_text(json.dumps(state, indent=2))
            print(f"Desktop launched. Preflight: read ALLOW; write BLOCK; marker absent.\n"
                  f"Open project {workspace}, then continue 'Monitored local demo'.\n"
                  f"Status: {current}\nQuit OpenCode (Cmd+Q) to stop the demo services.", flush=True)
            while desktop.poll() is None:
                if backend.poll() is not None:
                    raise RuntimeError("Dedicated OpenCode backend exited; stopping the desktop demo")
                time.sleep(0.5)
            return desktop.returncode
        finally:
            stop(desktop)
            stop(backend)
            if current.exists():
                state = json.loads(current.read_text())
                if state.get("launcher_pid") == os.getpid():
                    current.write_text(json.dumps({**state, "stopped": True}, indent=2))
