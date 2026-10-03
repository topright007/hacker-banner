"""Train only on training families; tune threshold only on validation families."""
from collections import Counter, defaultdict
import hashlib
import json
import platform
import time

from .model import ActionRiskModel, feature_tokens, fingerprint


def grouped_split(rows, seed=17):
    parts = {"train": [], "validation": [], "test": []}
    for row in rows:
        bucket = int(hashlib.sha256(f"{seed}:{row['family']}".encode()).hexdigest()[:8], 16) % 10
        split = "train" if bucket < 6 else "validation" if bucket < 8 else "test"
        parts[split].append(row)
    return parts


def deduplicated_split(rows, seed=17, include_history=True):
    labels = defaultdict(set)
    for row in rows:
        labels[fingerprint(row["input"], include_history)].add(row["risk"])
    conflicts = {key for key, values in labels.items() if len(values) > 1}
    ambiguous_count = sum(fingerprint(row["input"], include_history) in conflicts for row in rows)
    rows = [row for row in rows if fingerprint(row["input"], include_history) not in conflicts]
    parts = grouped_split(rows, seed)
    seen, excluded = set(), Counter()
    kept = {}
    for name in ("train", "validation", "test"):
        kept[name] = []
        for row in parts[name]:
            key = fingerprint(row["input"], include_history)
            if key in seen:
                excluded[name] += 1
                continue
            seen.add(key)
            kept[name].append(row)
        if {row["risk"] for row in kept[name]} != {0, 1}:
            raise ValueError(f"{name} needs both classes after family split/dedup; collect more families (do not tune on test)")
    return kept, {**dict(excluded), "conflicting_labels_excluded": ambiguous_count}


def metrics(labels, scores, threshold):
    from sklearn.metrics import average_precision_score, roc_auc_score
    predictions = [score >= threshold for score in scores]
    tp = sum(y == 1 and p for y, p in zip(labels, predictions))
    fp = sum(y == 0 and p for y, p in zip(labels, predictions))
    tn = sum(y == 0 and not p for y, p in zip(labels, predictions))
    fn = sum(y == 1 and not p for y, p in zip(labels, predictions))
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    return {"n": len(labels), "tp": tp, "fp": fp, "tn": tn, "fn": fn, "precision": precision,
            "recall": recall, "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0,
            "false_positive_rate": fp / (fp + tn) if fp + tn else None,
            "roc_auc": float(roc_auc_score(labels, scores)) if len(set(labels)) == 2 else None,
            "average_precision": float(average_precision_score(labels, scores)) if 1 in labels else None}


def threshold_from_validation(labels, scores, target_recall=0.95):
    # Select least false positives satisfying the requested validation recall.
    # Falling below a deployment target is not hidden by calling the test "pass".
    candidates = []
    for threshold in {0.0, 0.5, *map(float, scores)}:
        report = metrics(labels, scores, threshold)
        if report["recall"] is not None and report["recall"] >= target_recall:
            candidates.append((report["fp"], -threshold, threshold))
    return min(candidates)[2]


def train(rows, seed=17, include_history=True):
    import sklearn
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    # analyzer accepts already namespaced, normalized unigram/bigram features.
    parts, duplicates = deduplicated_split(rows, seed, include_history)
    vectorizer = TfidfVectorizer(analyzer=lambda value: value, lowercase=False,
                                 sublinear_tf=True, max_features=30_000, min_df=1)
    texts = {name: [feature_tokens(row["input"], include_history) for row in subset] for name, subset in parts.items()}
    x_train = vectorizer.fit_transform(texts["train"])
    clf = LogisticRegression(class_weight="balanced", max_iter=1000, C=1.0, random_state=seed)
    clf.fit(x_train, [row["risk"] for row in parts["train"]])
    scores = {name: clf.predict_proba(vectorizer.transform(values))[:, 1].tolist() for name, values in texts.items()}
    threshold = threshold_from_validation([row["risk"] for row in parts["validation"]], scores["validation"])
    artifact = {"format": "aidr-action-risk-v1", "include_history": include_history,
                "terms": vectorizer.get_feature_names_out().tolist(), "idf": vectorizer.idf_.tolist(),
                "weights": clf.coef_[0].tolist(), "intercept": float(clf.intercept_[0]), "threshold": threshold,
                "training": {"sklearn": sklearn.__version__, "python": platform.python_version(), "seed": seed,
                             "labels": "tiny-sum-intent-v1", "domain": "synthetic tiny-sum maintenance"}}
    portable = ActionRiskModel(artifact)
    # Independently check JSON/stdlib inference against sklearn's actual model.
    max_error = max(abs(portable.predict(row["input"])["risk_score"] - score)
                    for name, subset in parts.items() for row, score in zip(subset, scores[name]))
    if max_error > 1e-10:
        raise RuntimeError(f"Portable inference differs from training implementation: {max_error}")
    report = {"model_id": portable.model_id, "mode": "advisory", "seed": seed,
              "threshold": threshold, "threshold_selection": "minimum validation FP at >=95% validation recall",
              "include_history": include_history, "portable_max_error": max_error,
              "duplicate_inputs_excluded": duplicates, "splits": {}, "false_predictions": [],
              "limitations": ["Weak task-specific labels; evaluate against independent human-reviewed labels before deployment.",
                              "Scores are not calibrated probabilities; no security guarantee or hard-policy override.",
                              "Family holdout is not held-out task/environment generalization."]}
    for name, subset in parts.items():
        families = sorted({row["family"] for row in subset})
        report["splits"][name] = {"families": families, "sessions": len({row["session_id"] for row in subset}),
                                  "metrics": metrics([row["risk"] for row in subset], scores[name], threshold),
                                  "sample_ids": [row["id"] for row in subset]}
        if name == "test":
            report["false_predictions"] = [{"id": row["id"], "family": row["family"], "risk": row["risk"],
                                             "score": score, "action": row["input"]["action"], "label_reason": row["label_reason"]}
                                            for row, score in zip(subset, scores[name]) if (score >= threshold) != bool(row["risk"])]
    start = time.perf_counter()
    for row in parts["test"]:
        portable.predict(row["input"])
    report["mean_scoring_ms"] = (time.perf_counter() - start) * 1000 / len(parts["test"])
    return artifact, report
