"""Source-separated fastText contexts plus lexical action/operator features.

The optional model only produces advisory scores. Model files are operator-owned
deployment artifacts, never paths or parameters supplied by the acting agent.
"""
from collections import Counter
from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
import re

from .model import MAX_HISTORY, WORDS, feature_tokens, normalized_text

CONTEXT_CHANNELS = ("goal", "user", "assistant", "tool", "repository")
MAX_CHANNEL_WORDS = 2500
# Official cc.en.300.bin contains pretrained vocabulary + subword matrices and
# is several GiB. Retain a bounded streaming check without loading it in Python.
MAX_EMBEDDING_BYTES = 10 * 1024 * 1024 * 1024
FORMAT = "aidr-action-risk-fasttext-v1"


def context_texts(request):
    """Only the trusted goal and previously visible, source-labelled prefix.

    Unknown sources and all non-whitelisted fields are omitted. Results of the
    proposed/current action must never be inserted into ``history`` by callers.
    """
    channels = {name: [] for name in CONTEXT_CHANNELS}
    channels["goal"] = WORDS.findall(normalized_text(request.get("goal", "")).lower())[:MAX_CHANNEL_WORDS]
    for entry in request.get("history", [])[-MAX_HISTORY:]:
        if not isinstance(entry, dict) or entry.get("source") not in CONTEXT_CHANNELS[1:]:
            continue
        source = entry["source"]
        # Match RiskShadow's bounded visible prefix, including newline/token
        # handling. fastText receives plain tokens, not JSON/hidden metadata.
        visible = normalized_text(entry.get("text", ""))[:6000]
        words = WORDS.findall(visible.lower())
        room = MAX_CHANNEL_WORDS - len(channels[source])
        channels[source].extend(words[:room])
    return {name: " ".join(words) for name, words in channels.items()}


def lexical_tokens(request):
    """Keep exact action/operator indicators; context text uses embeddings."""
    return [token for token in feature_tokens(request, include_history=False)
            if token.startswith(("action:", "operator:"))]


def context_features(embedder, request, dimension):
    vectors = []
    texts = context_texts(request)
    for source in CONTEXT_CHANNELS:
        if not texts[source]:
            vectors.extend([0.0] * dimension)
            continue
        vector = [float(value) for value in embedder.get_sentence_vector(texts[source])]
        if len(vector) != dimension or any(not math.isfinite(value) for value in vector):
            raise ValueError("Invalid fastText context vector")
        norm = math.sqrt(sum(value * value for value in vector))
        if not math.isfinite(norm):
            raise ValueError("Nonfinite fastText context norm")
        vectors.extend(value / norm if norm else 0.0 for value in vector)
    return vectors


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class FastTextRiskModel:
    def __init__(self, artifact, embedder):
        if not isinstance(artifact, dict) or artifact.get("format") != FORMAT:
            raise ValueError("Unsupported fastText action-risk artifact")
        if artifact.get("include_history") is not True or artifact.get("context_channels") != list(CONTEXT_CHANNELS):
            raise ValueError("Invalid fastText context channels")
        embedding = artifact.get("embedding", {})
        if not isinstance(embedding, dict) or embedding.get("file") != "context.fasttext.bin":
            raise ValueError("Embedding must be the relative sibling context.fasttext.bin")
        dimension = embedding.get("dimension")
        if not isinstance(dimension, int) or isinstance(dimension, bool) or not 1 <= dimension <= 512:
            raise ValueError("Invalid fastText embedding dimension")
        checksum = embedding.get("sha256")
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError("Invalid fastText embedding checksum")
        terms, idf, weights = artifact.get("terms"), artifact.get("idf"), artifact.get("weights")
        if not isinstance(terms, list) or not 1 <= len(terms) <= 100_000:
            raise ValueError("Invalid lexical vocabulary")
        if any(not isinstance(term, str) or len(term) > 1024 or not term.startswith(("action:", "operator:")) for term in terms):
            raise ValueError("Invalid lexical vocabulary")
        if len(set(terms)) != len(terms):
            raise ValueError("Duplicate lexical vocabulary")
        if not isinstance(idf, list) or not isinstance(weights, list) or len(idf) != len(terms) or len(weights) != len(terms) + len(CONTEXT_CHANNELS) * dimension:
            raise ValueError("Invalid fastText model dimensions")
        numbers = [*idf, *weights, artifact.get("intercept"), artifact.get("threshold")]
        if any(not _number(value) for value in numbers):
            raise ValueError("Nonfinite model parameters")
        if any(value <= 0 for value in idf) or not 0 <= artifact["threshold"] <= 1:
            raise ValueError("Invalid model parameters")
        if embedder.get_dimension() != dimension:
            raise ValueError("Embedding dimension does not match artifact")
        self.artifact = deepcopy(artifact)
        self.embedder = embedder
        self.dimension = dimension
        self.vocabulary = {term: index for index, term in enumerate(terms)}
        self.model_id = hashlib.sha256(json.dumps(artifact, sort_keys=True).encode()).hexdigest()[:16]

    @classmethod
    def load(cls, path, artifact=None):
        path = Path(path)
        if artifact is None:
            if path.stat().st_size > 30_000_000:
                raise ValueError("Model artifact exceeds size limit")
            artifact = json.loads(path.read_text())
        # Validate the descriptor before importing native code or reading files.
        descriptor = artifact.get("embedding", {}) if isinstance(artifact, dict) else {}
        if not isinstance(descriptor, dict) or descriptor.get("file") != "context.fasttext.bin":
            raise ValueError("Embedding must be the relative sibling context.fasttext.bin")
        checksum = descriptor.get("sha256")
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ValueError("Invalid fastText embedding checksum")
        embedding_path = path.parent / "context.fasttext.bin"
        if embedding_path.is_symlink() or not embedding_path.is_file():
            raise ValueError("Embedding must be a regular, non-symlink sibling file")
        if not 1 <= embedding_path.stat().st_size <= MAX_EMBEDDING_BYTES:
            raise ValueError("fastText embedding exceeds size limit")
        digest = hashlib.sha256()
        consumed = 0
        with embedding_path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                consumed += len(block)
                if consumed > MAX_EMBEDDING_BYTES:
                    raise ValueError("fastText embedding exceeds size limit")
                digest.update(block)
        if digest.hexdigest() != checksum:
            raise ValueError("fastText embedding checksum mismatch")
        try:
            import fasttext
        except ImportError as exc:
            raise RuntimeError("fastText inference requires the project's [fasttext] extra (official fasttext==0.9.3)") from exc
        return cls(artifact, fasttext.load_model(str(embedding_path)))

    def predict(self, request):
        counts = Counter(lexical_tokens(request))
        values = {self.vocabulary[term]: (1 + math.log(count)) * self.artifact["idf"][self.vocabulary[term]]
                  for term, count in counts.items() if term in self.vocabulary}
        norm = math.sqrt(sum(value * value for value in values.values()))
        z = self.artifact["intercept"]
        if norm:
            z += sum(value * self.artifact["weights"][index] / norm for index, value in values.items())
        vectors = context_features(self.embedder, request, self.dimension)
        z += sum(value * weight for value, weight in zip(vectors, self.artifact["weights"][len(self.vocabulary):]))
        score = 1 / (1 + math.exp(-max(-700, min(700, z))))
        known = sum(count for term, count in counts.items() if term in self.vocabulary)
        coverage = known / sum(counts.values()) if counts else 0
        abstain = not norm or coverage < 0.1
        return {"model_id": self.model_id, "risk_score": score, "threshold": self.artifact["threshold"],
                "alert": None if abstain else score >= self.artifact["threshold"], "abstain": abstain,
                "feature_coverage": coverage, "mode": "advisory",
                "note": "Uncalibrated fastText baseline score; no execution authority. Apply hard policies independently."}
