"""Frozen pretrained fastText contexts + lexical action/operator logistic classifier."""
from collections import Counter
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import time

from .fasttext_model import CONTEXT_CHANNELS, MAX_EMBEDDING_BYTES, FastTextRiskModel, context_features, context_texts, lexical_tokens
from .model import ActionRiskModel, normalized_text
from .train import deduplicated_split, metrics, threshold_from_validation


def frozen_parts(rows, seed=17, reference_report=None):
    # Use v1's observable-input fingerprint, never embeddings, to keep a paired
    # evaluation. Representation changes must not reshuffle or drop test cases.
    parts, excluded = deduplicated_split(rows, seed, include_history=True)
    if reference_report is not None:
        if reference_report.get("seed") != seed:
            raise ValueError("Reference split seed mismatch")
        for name, subset in parts.items():
            if [row["id"] for row in subset] != reference_report["splits"][name]["sample_ids"]:
                raise ValueError(f"Frozen {name} sample IDs differ from reference; do not compare these runs")
    return parts, excluded


def runtime_aligned(request):
    return {**request, "history": [{**entry, "text": normalized_text(entry.get("text", ""))[:6000]}
                                   for entry in request.get("history", [])[-16:]]}


def train_fasttext(rows, output, pretrained_embeddings, seed=17, reference_report=None, baseline_model=None,
                   embedding_source_url="https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.en.300.bin.gz"):
    import fasttext
    import numpy as np
    import sklearn
    from scipy.sparse import csr_matrix, hstack
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression

    parts, excluded = frozen_parts(rows, seed, reference_report)
    pretrained = Path(pretrained_embeddings)
    if pretrained.is_symlink() or not pretrained.is_file():
        raise ValueError("Pretrained embeddings must be an operator-owned regular, non-symlink file")
    source_stat = pretrained.stat()
    if not 1 <= source_stat.st_size <= MAX_EMBEDDING_BYTES:
        raise ValueError("Pretrained embedding exceeds size limit")
    digest = hashlib.sha256()
    consumed = 0
    with pretrained.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            consumed += len(block)
            if consumed > MAX_EMBEDDING_BYTES:
                raise ValueError("Pretrained embedding exceeds size limit")
            digest.update(block)
    if (pretrained.stat().st_size, pretrained.stat().st_mtime_ns) != (source_stat.st_size, source_stat.st_mtime_ns):
        raise ValueError("Pretrained embedding changed during checksum verification")
    embedding_hash = digest.hexdigest()
    output = Path(output)
    embedding_path = output / "context.fasttext.bin"
    # Never fit or mutate pretrained embeddings. Hard-link the trusted immutable
    # cache to the private model directory (same filesystem; no GB-sized copies).
    os.link(pretrained, embedding_path)
    embedding = fasttext.load_model(str(embedding_path))
    dimension = embedding.get_dimension()
    if not 1 <= dimension <= 512:
        raise ValueError("Pretrained embedding dimension outside prototype limits")

    vectorizer = TfidfVectorizer(analyzer=lambda value: value, lowercase=False,
                                 sublinear_tf=True, max_features=30_000, min_df=1)
    lexical = {name: [lexical_tokens(row["input"]) for row in subset] for name, subset in parts.items()}
    vectorizer.fit(lexical["train"])
    matrices = {name: hstack([vectorizer.transform(lexical[name]),
                             csr_matrix(np.asarray([context_features(embedding, row["input"], dimension)
                                                   for row in subset], dtype=np.float64))], format="csr")
                for name, subset in parts.items()}
    classifier = LogisticRegression(class_weight="balanced", max_iter=1000, C=1.0, random_state=seed)
    classifier.fit(matrices["train"], [row["risk"] for row in parts["train"]])
    scores = {name: classifier.predict_proba(matrix)[:, 1].tolist() for name, matrix in matrices.items()}
    threshold = threshold_from_validation([row["risk"] for row in parts["validation"]], scores["validation"])
    artifact = {"format": "aidr-action-risk-fasttext-v1", "include_history": True,
                "context_channels": list(CONTEXT_CHANNELS),
                "terms": vectorizer.get_feature_names_out().tolist(), "idf": vectorizer.idf_.tolist(),
                "weights": classifier.coef_[0].tolist(), "intercept": float(classifier.intercept_[0]),
                "threshold": threshold,
                "embedding": {"file": embedding_path.name, "sha256": embedding_hash, "dimension": dimension,
                              "pretrained": True, "source_url": embedding_source_url,
                              "license": "CC-BY-SA-3.0", "bytes": source_stat.st_size},
                "training": {"python": platform.python_version(), "sklearn": sklearn.__version__,
                             "fasttext": version("fasttext"), "seed": seed, "embedding_frozen": True,
                             "embedding_fit_on_sessions": False, "labels": "tiny-sum-intent-v1",
                             "domain": "synthetic tiny-sum maintenance", "context_history_chars": 6000,
                             "context_tokens_per_channel": 2500}}
    portable = FastTextRiskModel(artifact, embedding)
    error = max(abs(portable.predict(row["input"])["risk_score"] - score)
                for name, subset in parts.items() for row, score in zip(subset, scores[name]))
    if error > 1e-10:
        raise RuntimeError(f"Portable fastText inference differs from sklearn: {error}")
    report = {"model_id": portable.model_id, "encoder": "pretrained-fasttext-context+lexical-action-operator",
              "mode": "advisory", "seed": seed, "threshold": threshold,
              "threshold_selection": "minimum validation FP at >=95% validation recall",
              "portable_max_error": error, "duplicate_inputs_excluded": excluded,
              "frozen_reference_verified": reference_report is not None, "splits": {}, "false_predictions": [],
              "limitations": ["Weak task-specific labels; only four held-out positive actions in the source benchmark.",
                              "Frozen pretrained English fastText vectors are static and pooling loses within-channel ordering; multilingual accuracy is unverified.",
                              "Scores are not calibrated probabilities and cannot override deterministic policies.",
                              "The v1 test set was already exposed; this is a descriptive comparison, not fresh independent validation.",
                              "Frozen v1 splits use original fingerprints; new representation is not used to deduplicate or select test cases."]}
    for name, subset in parts.items():
        predictions = [portable.predict(row["input"]) for row in subset]
        report["splits"][name] = {"families": sorted({row["family"] for row in subset}),
                                  "sessions": len({row["session_id"] for row in subset}),
                                  "sample_ids": [row["id"] for row in subset],
                                  "metrics": metrics([row["risk"] for row in subset], scores[name], threshold),
                                  "abstentions": sum(prediction["abstain"] for prediction in predictions)}
        if name == "test":
            report["false_predictions"] = [{"id": row["id"], "family": row["family"], "risk": row["risk"],
                                             "score": score, "action": row["input"]["action"], "label_reason": row["label_reason"]}
                                            for row, score in zip(subset, scores[name]) if (score >= threshold) != bool(row["risk"])]
            report["test_predictions"] = [{"id": row["id"], "risk": row["risk"], **prediction}
                                          for row, prediction in zip(subset, predictions)]
    # Pooling/truncation may collapse distinct original inputs. Disclose collisions
    # without using them to drop difficult held-out examples or change labels.
    observed, collisions = {}, Counter()
    for name, subset in parts.items():
        for row in subset:
            features = {"context": {source: sorted(Counter(text.split()).items()) for source, text in context_texts(row["input"]).items()},
                        "lexical": sorted(Counter(lexical_tokens(row["input"])).items())}
            key = hashlib.sha256(json.dumps(features, sort_keys=True).encode()).hexdigest()
            if key in observed:
                previous_split, previous_label = observed[key]
                collisions[f"{name}_duplicate_representations"] += 1
                if name != previous_split:
                    collisions[f"{name}_cross_split_representations"] += 1
                if previous_label != row["risk"]:
                    collisions["conflicting_labels"] += 1
            else:
                observed[key] = (name, row["risk"])
    report["representation_collisions"] = dict(collisions)
    if baseline_model is not None:
        baseline = ActionRiskModel.load(baseline_model)
        subset = parts["test"]
        labels = [row["risk"] for row in subset]
        original = [baseline.predict(row["input"]) for row in subset]
        aligned = [baseline.predict(runtime_aligned(row["input"])) for row in subset]
        report["paired_baseline"] = {"model_id": baseline.model_id, "threshold": baseline.artifact["threshold"],
            "same_test_sample_ids": True,
            "original_prefix_metrics": metrics(labels, [item["risk_score"] for item in original], baseline.artifact["threshold"]),
            "runtime_aligned_prefix_metrics": metrics(labels, [item["risk_score"] for item in aligned], baseline.artifact["threshold"]),
            "original_abstentions": sum(item["abstain"] for item in original),
            "runtime_aligned_abstentions": sum(item["abstain"] for item in aligned)}
    start = time.perf_counter()
    for row in parts["test"]:
        portable.predict(row["input"])
    report["mean_scoring_ms"] = (time.perf_counter() - start) * 1000 / len(parts["test"])
    return artifact, report
