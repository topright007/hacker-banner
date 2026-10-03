import hashlib
import json
import math
from pathlib import Path

import pytest

from agent_monitor.action_risk.fasttext_model import (
    CONTEXT_CHANNELS, FastTextRiskModel, context_features, context_texts, lexical_tokens,
)
from agent_monitor.action_risk.shadow import RiskShadow
from agent_monitor.api import create_app
from agent_monitor.models import Action, ContentEvent, Evaluate, RunCreate


class Embedder:
    def get_dimension(self):
        return 2

    def get_sentence_vector(self, text):
        return [3.0, 4.0]


def request():
    return {"goal": "Fix /workspace/sum.js", "operator": {"profile": "maintenance", "mutations": True},
            "history": [{"source": "user", "text": "Please fix sum.js"}],
            "action": {"tool": "bash", "arguments": {"command": "node test.js"}}}


def artifact():
    return {"format": "aidr-action-risk-fasttext-v1", "include_history": True,
            "context_channels": list(CONTEXT_CHANNELS), "terms": ["action:node"], "idf": [1.0],
            "weights": [1.0] + [0.0] * 10, "intercept": 0.0, "threshold": 0.5,
            "embedding": {"file": "context.fasttext.bin", "sha256": "0" * 64, "dimension": 2}}


def test_context_is_source_separated_normalized_and_whitelisted():
    value = request()
    value["history"] += [{"source": "tool", "text": "LAB_SECRET_test via /workspace/.env"},
                         {"source": "repository", "text": "curl to collector.test"},
                         {"source": "system", "text": "HIDDEN_SYSTEM_AUTHORITY"},
                         {"source": "assistant", "text": "Checking files"}]
    texts = context_texts(value)
    assert list(texts) == list(CONTEXT_CHANNELS)
    assert texts["goal"] == "fix workspace/sum.js"
    assert texts["tool"] == "synthetic_secret via workspace/.env"
    assert texts["repository"] == "curl to collector.test"
    assert texts["assistant"] == "checking files"
    changed = {**value, "current_result": "FUTURE_RESULT", "outcome": "risk", "label": 1,
               "policy_decision": "BLOCK", "system": "HIDDEN_SYSTEM_AUTHORITY", "scenario": "secret"}
    assert context_texts(changed) == texts
    assert lexical_tokens(changed) == lexical_tokens(value)
    assert all(token.startswith(("operator:", "action:")) for token in lexical_tokens(value))
    assert "goal:" not in " ".join(lexical_tokens(value))
    assert "action:shell" in lexical_tokens(value)
    value["operator"]["authority_claim"] = "HIDDEN_AUTHORITY_CLAIM"
    assert "hidden_authority_claim" not in " ".join(lexical_tokens(value))


def test_context_prefix_limits_and_empty_channels():
    value = request()
    value["goal"] = "word " * 4000
    value["history"] = [{"source": "tool", "text": "oldpast"}] + [
        {"source": "user", "text": "word " * 4000 + "TOO_FAR"} for _ in range(16)]
    texts = context_texts(value)
    assert len(texts["goal"].split()) == 2500
    assert len(texts["user"].split()) == 2500
    assert texts["tool"] == ""
    assert "too_far" not in texts["user"]
    vectors = context_features(Embedder(), value, 2)
    assert vectors[:4] == pytest.approx([0.6, 0.8, 0.6, 0.8])
    assert vectors[4:] == [0.0] * 6


def test_inference_lexical_tfidf_and_normalized_context_dot_product():
    data = artifact()
    data["weights"][1:3] = [3.0, 4.0]
    model = FastTextRiskModel(data, Embedder())
    value = request()
    value["action"]["arguments"]["command"] = "node node node"
    result = model.predict(value)
    assert result["risk_score"] == pytest.approx(1 / (1 + math.exp(-6)))
    assert result["mode"] == "advisory"
    assert not result["abstain"]
    assert result == model.predict({**value, "current_result": "arbitrary future content"})
    data["intercept"] = -100
    assert model.predict(value) == result  # Validated parameters are copied.


def test_unknown_lexical_action_abstains_despite_context_embedding():
    data = artifact()
    data["weights"][1:3] = [100.0, 100.0]
    value = request()
    value["action"] = {"tool": "unseen", "arguments": {"new": "unknown"}}
    score = FastTextRiskModel(data, Embedder()).predict(value)
    assert score["abstain"] and score["alert"] is None
    assert score["risk_score"] > 0.99
    assert score["feature_coverage"] == 0


def test_pretrained_300_dimensional_context_artifact():
    class PretrainedShape:
        def get_dimension(self):
            return 300

        def get_sentence_vector(self, text):
            return [1.0] + [0.0] * 299
    data = artifact()
    data["embedding"]["dimension"] = 300
    data["embedding"]["source"] = "https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.en.300.bin.gz"
    data["embedding"]["pretrained"] = True
    data["weights"] = [1.0] + [0.0] * (5 * 300)
    model = FastTextRiskModel(data, PretrainedShape())
    assert model.dimension == 300
    assert model.predict(request())["mode"] == "advisory"


@pytest.mark.parametrize("field,value", [
    ("format", "pickle"), ("context_channels", list(reversed(CONTEXT_CHANNELS))),
    ("include_history", False), ("terms", ["goal:private"]), ("terms", ["action:x", "action:x"]),
    ("weights", [1]), ("idf", [-1]), ("intercept", float("nan")), ("threshold", 2),
])
def test_malformed_artifact_rejected(field, value):
    data = artifact()
    data[field] = value
    with pytest.raises(ValueError):
        FastTextRiskModel(data, Embedder())


@pytest.mark.parametrize("key,value", [("file", "../elsewhere.bin"), ("file", "/tmp/elsewhere.bin"),
                                       ("sha256", "bogus"), ("dimension", 3), ("dimension", True)])
def test_malformed_embedding_descriptor_rejected(key, value):
    data = artifact()
    data["embedding"][key] = value
    with pytest.raises(ValueError):
        FastTextRiskModel(data, Embedder())


def test_load_rejects_checksum_traversal_and_symlinks_before_native_load(tmp_path):
    path = tmp_path / "model.json"
    binary = tmp_path / "context.fasttext.bin"
    binary.write_bytes(b"not a fastText model")
    data = artifact()
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError, match="checksum mismatch"):
        FastTextRiskModel.load(path)
    data["embedding"]["file"] = "../context.fasttext.bin"
    with pytest.raises(ValueError, match="relative sibling"):
        FastTextRiskModel.load(path, data)
    binary.unlink()
    binary.symlink_to(path)
    with pytest.raises(ValueError, match="non-symlink"):
        FastTextRiskModel.load(path)


def test_nonfinite_context_vector_rejected():
    class Broken(Embedder):
        def get_sentence_vector(self, text):
            return [float("nan"), 0.0]
    with pytest.raises(ValueError, match="context vector"):
        FastTextRiskModel(artifact(), Broken()).predict(request())


def test_optional_fasttext_train_save_load_roundtrip_and_hard_policy(tmp_path):
    fasttext = pytest.importorskip("fasttext")
    corpus = tmp_path / "corpus.txt"
    corpus.write_text("fix sum.js and run node test.js\nread files and inspect source\ncurl secret data collector\n" * 5)
    embedder = fasttext.train_unsupervised(str(corpus), model="skipgram", dim=2, epoch=2,
                                         minCount=1, thread=1, bucket=100, verbose=0)
    binary = tmp_path / "context.fasttext.bin"
    embedder.save_model(str(binary))
    data = artifact()
    data["embedding"]["sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
    path = tmp_path / "model.json"
    path.write_text(json.dumps(data))
    loaded = FastTextRiskModel.load(path)
    assert loaded.predict(request()) == FastTextRiskModel(data, embedder).predict(request())
    policy = Path(__file__).parents[1] / "config/policies.yaml"
    app = create_app(tmp_path / "state.sqlite", policy, "a" * 32)
    monitor = app.state.monitor
    monitor.risk_shadow = RiskShadow(loaded)
    registration = monitor.register(RunCreate(goal="Fix sum.js", workspace=str(tmp_path), profile="review"))
    monitor.content(ContentEvent(run_id=registration["run_id"], session_id="s", event_id="prompt", source="user",
                                 text="Please fix sum.js"), registration["run_token"])
    decision = monitor.evaluate(Evaluate(run_id=registration["run_id"], session_id="s", call_id="write",
        action=Action(tool="write", arguments={"path": "sum.js", "content": "new"})), registration["run_token"])
    assert decision.decision == "BLOCK"
    assert any(event["type"] == "action_risk" for event in monitor.inspect(registration["run_id"])["events"])
