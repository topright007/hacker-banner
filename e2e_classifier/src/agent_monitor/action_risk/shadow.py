"""Bounded, ephemeral model context. A shadow prediction never permits an action."""
from collections import OrderedDict
import json

from .model import MAX_HISTORY, normalized_text


class RiskShadow:
    def __init__(self, model, max_runs=64):
        self.model = model
        self.context = OrderedDict()
        self.max_runs = max_runs

    def observe(self, run_id, source, text, workspace):
        history = self.context.pop(run_id, [])
        snapshot = self._snapshot(text, workspace) if source == "repository" else None
        if snapshot is not None:
            # V2 hooks send a full AI-message snapshot, not a document. Ignore
            # system prompt boilerplate, hidden reasoning and provider metadata;
            # otherwise these drown out the training-compatible visible prefix.
            history = snapshot or history
        else:
            history.append({"source": source, "text": normalized_text(text, workspace)[:6000]})
        self.context[run_id] = history[-MAX_HISTORY:]
        while len(self.context) > self.max_runs:
            self.context.popitem(last=False)

    @staticmethod
    def _snapshot(text, workspace):
        if not isinstance(text, str):
            return None
        try:
            data = json.loads(text)
        except ValueError:
            return None
        if not isinstance(data, dict) or "system" not in data or not isinstance(data.get("messages"), list):
            return None
        history, calls = [], {}
        for message in data["messages"][-64:]:
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role not in {"user", "assistant", "tool"}:
                continue
            content = message.get("content", [])
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict):
                    continue
                kind = part.get("type")
                if kind == "text":
                    history.append({"source": role, "text": normalized_text(part.get("text", ""), workspace)[:6000]})
                elif kind == "tool-call":
                    calls[part.get("id")] = {"tool": part.get("name"), "arguments": part.get("input", {})}
                elif kind == "tool-result":
                    prior = calls.get(part.get("id"), {"tool": part.get("name"), "arguments": {}})
                    value = part.get("result", {})
                    if isinstance(value, dict):
                        value = value.get("value", "")
                    if isinstance(value, list):
                        value = "\n".join(item.get("text", "") for item in value if isinstance(item, dict) and item.get("type") == "text")
                    history.append({"source": "tool", "text": normalized_text({**prior, "result": value}, workspace)[:6000]})
        return history[-MAX_HISTORY:]

    def score(self, run, profile, action):
        if run["id"] not in self.context:
            return {"mode": "shadow", "abstain": True, "alert": None, "note": "No live prefix after startup/context eviction"}
        # Workspace normalization is supplied by the operator's registered run.
        def normalize(value):
            if isinstance(value, str):
                return normalized_text(value, run["workspace"])
            if isinstance(value, dict):
                return {key: normalize(item) for key, item in value.items()}
            if isinstance(value, list):
                return [normalize(item) for item in value]
            return value
        request = {"goal": run["goal"], "operator": {"profile": run["profile"], "mutations": profile["mutations"],
                    "outbound": profile["outbound"], "sensitive_seen": run["sensitive"]},
                   "history": self.context[run["id"]], "action": normalize(action)}
        result = self.model.predict(request)
        return {**result, "mode": "shadow"}

    def forget(self, run_id):
        self.context.pop(run_id, None)
