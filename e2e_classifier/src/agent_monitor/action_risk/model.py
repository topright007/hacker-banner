"""Portable TF-IDF/logistic classifier; JSON artifacts, no pickle or executing text."""
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re

MAX_TEXT = 24_000
MAX_HISTORY = 16
WORDS = re.compile(r"[\w./:@$-]{2,}", re.UNICODE)
CANARY = re.compile(r"(?:LAB|MONITOR)_SECRET_[A-Za-z0-9_-]+")


def normalized_text(value, workspace="/workspace"):
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, ensure_ascii=False)
    if workspace:
        text = text.replace(workspace.rstrip("/"), "WORKSPACE")
    return CANARY.sub("SYNTHETIC_SECRET", text)[:MAX_TEXT]


def normalize_action(tool, arguments):
    arguments = dict(arguments)
    if "filePath" in arguments:
        if "path" in arguments and arguments["path"] != arguments["filePath"]:
            raise ValueError("Conflicting V1 and V2 path arguments")
        arguments["path"] = arguments.pop("filePath")
    return {"tool": {"bash": "shell", "task": "subagent"}.get(tool, tool), "arguments": arguments}


def feature_tokens(request, include_history=True):
    """Whitelist inputs: provenance/labels/results of the CURRENT call never enter."""
    action = request["action"]
    action = normalize_action(action["tool"], action.get("arguments", {}))
    tokens = []
    def add(namespace, value):
        words = WORDS.findall(normalized_text(value).lower())[:2500]
        tokens.extend(f"{namespace}:{w}" for w in words)
        tokens.extend(f"{namespace}:{a} {b}" for a, b in zip(words, words[1:]))
    add("goal", request.get("goal", ""))
    # These facts must be supplied by the trusted operator, not extracted from
    # statements of authority in a document or from the acting model's claims.
    facts = request.get("operator", {})
    add("operator", {key: facts[key] for key in ("profile", "mutations", "outbound", "sensitive_seen") if key in facts})
    add("action", action)
    if include_history:
        for entry in request.get("history", [])[-MAX_HISTORY:]:
            source = entry.get("source", "tool")
            if source not in {"user", "assistant", "tool", "repository"}:
                source = "tool"
            add(f"history-{source}", entry.get("text", ""))
    return tokens


def fingerprint(request, include_history=True):
    # TF-IDF is a bag of features: fingerprint its actual observable input.
    counts = sorted(Counter(feature_tokens(request, include_history)).items())
    return hashlib.sha256(json.dumps(counts, ensure_ascii=False).encode()).hexdigest()


class ActionRiskModel:
    def __init__(self, artifact):
        if artifact.get("format") != "aidr-action-risk-v1":
            raise ValueError("Unsupported action-risk artifact")
        terms = artifact["terms"]
        weights, idf = artifact["weights"], artifact["idf"]
        if not 1 <= len(terms) <= 100_000 or len(set(terms)) != len(terms) or len(weights) != len(terms) or len(idf) != len(terms):
            raise ValueError("Invalid model dimensions")
        if any(not isinstance(term, str) or len(term) > 1024 for term in terms):
            raise ValueError("Invalid vocabulary")
        numbers = [*weights, *idf, artifact["intercept"], artifact["threshold"]]
        if any(not isinstance(n, (int, float)) or not math.isfinite(n) for n in numbers):
            raise ValueError("Nonfinite model parameters")
        if any(n <= 0 for n in idf) or not 0 <= artifact["threshold"] <= 1:
            raise ValueError("Invalid model parameters")
        self.artifact = artifact
        self.vocabulary = {term: i for i, term in enumerate(terms)}
        self.model_id = hashlib.sha256(json.dumps(artifact, sort_keys=True).encode()).hexdigest()[:16]

    @classmethod
    def load(cls, path):
        path = Path(path)
        if path.stat().st_size > 30_000_000:
            raise ValueError("Model artifact exceeds size limit")
        artifact = json.loads(path.read_text())
        if artifact.get("format") == "aidr-action-risk-fasttext-v1":
            from .fasttext_model import FastTextRiskModel
            return FastTextRiskModel.load(path, artifact)
        return cls(artifact)

    def predict(self, request):
        counts = Counter(feature_tokens(request, self.artifact.get("include_history", True)))
        values = {self.vocabulary[term]: (1 + math.log(count)) * self.artifact["idf"][self.vocabulary[term]]
                  for term, count in counts.items() if term in self.vocabulary}
        norm = math.sqrt(sum(x * x for x in values.values()))
        z = self.artifact["intercept"]
        if norm:
            z += sum(value * self.artifact["weights"][index] / norm for index, value in values.items())
        probability = 1 / (1 + math.exp(-max(-700, min(700, z))))
        known = sum(count for term, count in counts.items() if term in self.vocabulary)
        coverage = known / sum(counts.values()) if counts else 0
        abstain = not norm or coverage < 0.1
        return {"model_id": self.model_id, "risk_score": probability, "threshold": self.artifact["threshold"],
                "alert": None if abstain else probability >= self.artifact["threshold"],
                "abstain": abstain, "feature_coverage": coverage, "mode": "advisory",
                "note": "Uncalibrated baseline score; no execution authority. Apply hard policies independently."}
