from fastapi.testclient import TestClient

from agent_monitor.api import create_app
from agent_monitor.models import ContentEvent, RunCreate
from demos.local.run import MODEL, guarded_model_app, make_config
from demos.local.desktop import desktop_seed, preflight_passed
from demos.local.unmonitored import control_config
import json


def test_desktop_seed_only_initializes_a_new_profile(tmp_path):
    profile = tmp_path / "desktop-profile"
    workspace = tmp_path / "task"
    assert desktop_seed(profile, workspace)
    settings = profile / "opencode.settings"
    assert json.loads(settings.read_text())["defaultServerUrl"] == "sidecar"
    saved = json.loads((profile / "opencode.global.dat").read_text())
    assert json.loads(saved["server"])["lastProject"]["local"] == str(workspace)
    assert not desktop_seed(profile, tmp_path / "different-task")
    assert json.loads(json.loads((profile / "opencode.global.dat").read_text())["server"])["lastProject"]["local"] == str(workspace)


def test_desktop_preflight_requires_effects_and_pre_execution_denial():
    events = [
        {"type": "decision", "tool": "fixture_read_public", "decision": "ALLOW", "call_id": "r"},
        {"type": "decision", "tool": "write", "decision": "BLOCK", "call_id": "w", "reason_codes": ["P01_READ_ONLY_TASK"]},
    ]
    assert not preflight_passed(events, False)
    events.append({"type": "result", "call_id": "r", "status": "completed"})
    assert preflight_passed(events, False)
    assert not preflight_passed(events, True)
    assert not preflight_passed(events + [{"type": "started", "call_id": "w"}], False)


def test_local_demo_config_keeps_monitor_and_fixed_local_model(tmp_path):
    task = tmp_path / "task"
    credentials = tmp_path / "run.credentials.json"
    config = make_config(task, credentials, 12345)
    assert config["model"] == f"demo/{MODEL}"
    assert list(config["providers"]) == ["demo"]
    assert config["providers"]["demo"]["settings"]["baseURL"] == "http://127.0.0.1:12345/v1"
    assert config["providers"]["demo"]["models"][MODEL]["capabilities"]["tools"]
    assert config["plugins"][-1]["options"]["credentials"] == str(credentials)
    assert any(p["action"] == "execute" and p["effect"] == "deny" for p in config["permissions"])


def test_unmonitored_control_changes_only_security_plugin_and_fixture_directory(tmp_path):
    original = make_config(tmp_path / "monitored", tmp_path / "credentials", 12345)
    control = control_config(original, tmp_path / "control")
    assert len(control["plugins"]) == 1
    assert control["plugins"][0]["options"]["workspace"] == str(tmp_path / "control")
    assert len(original["plugins"]) == 2
    for key in ("model", "providers", "permissions", "agents"):
        assert control[key] == original[key]


def test_generation_refused_without_monitored_prompt(tmp_path):
    app = create_app(db_path=tmp_path / "state.sqlite", policy_path="config/policies.yaml", admin_token="a" * 32)
    monitor = app.state.monitor
    reg = monitor.register(RunCreate(goal="Synthetic demo", workspace=str(tmp_path), profile="review"))
    guarded_model_app(app, monitor, reg["run_id"])
    with TestClient(app) as client:
        response = client.post("/v1/chat/completions", json={"model": MODEL})
        assert response.status_code == 503
        monitor.content(ContentEvent(run_id=reg["run_id"], session_id="s", event_id="repository", source="repository", text="context"), reg["run_token"])
        assert client.post("/v1/chat/completions", json={"model": MODEL}).status_code == 503
        monitor.content(ContentEvent(run_id=reg["run_id"], session_id="s", event_id="prompt", source="user", text="hello"), reg["run_token"])
        assert client.post("/v1/chat/completions", json={"model": "cloud-model"}).status_code == 400
        monitor.terminate(reg["run_id"])
        assert client.post("/v1/chat/completions", json={"model": MODEL}).status_code == 503
