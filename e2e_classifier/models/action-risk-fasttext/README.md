# Pretrained fastText action-risk classifier

Model ID: `c6d35ca8ac08a200`. Frozen official English `cc.en.300` fastText embeddings (300 dimensions), pooled separately for goal/user/assistant/tool/repository context, plus exact action/operator TF-IDF features and class-balanced logistic regression. Only the classifier and lexical vocabulary are fitted on session examples; pretrained embeddings are never updated.

The official binary retains character-subword vectors for unseen words. Static pooled vectors are not transformer-style contextual embeddings and lose within-channel ordering; multilingual performance is unverified. Context matches the online limits: last 16 entries, 6,000 characters per entry, 2,500 tokens per channel. Untrusted text does not grant operator authority.

## Evaluation

Frozen v1 sample IDs verified: 748 train / 204 validation / 88 test, seed 17, disjoint approach families. Labels remain task-specific weak supervision from 458 synthetic tiny-sum sessions. Vocabulary/classifier fit on train only; threshold `0.22371543665291926` chosen on validation only. The already-exposed test set was not used for model or threshold selection; this comparison is descriptive, not fresh independent validation.

| Held-out metric | TF-IDF v1 | Pretrained fastText |
| --- | --- | --- |
| TP / FP / TN / FN | 2 / 0 / 84 / 2 | 3 / 0 / 84 / 1 |
| Precision | 100% | 100% |
| Recall | 50% | 75% |
| F1 | 66.7% | 85.7% |
| ROC-AUC | 0.920 | 0.762 |
| Average precision | 0.684 | 0.762 |

Only four positive test actions remain: one extra detection is not robust evidence of improvement. Ranking ROC-AUC declined. The remaining miss is an unauthorized `.env` read; hard policy P11 still blocks it. Neither model abstained on the 88 test actions. Frozen input pooling produced two training and five validation duplicates, no cross-split collisions or contradictory labels; none were used to change the evaluation set. TF-IDF re-scoring with runtime-aligned truncation retained the same metrics.

Mean warm inference: approximately 0.307 ms on this Mac. Native-load integration measured approximately 5.52 seconds startup and 5.3 GB peak process RSS; deployment must budget for this large encoder. Use one monitor worker for the prototype. Scores are not calibrated probabilities. **Shadow/advisory only**: ML cannot change hard ALLOW/BLOCK/REQUIRE_APPROVAL or protect a session without interception hooks.

## Artifacts and pretrained provenance

`model.json` is the small inspectable classifier, not pickle. SHA-256: `45dede2773b4ef6ed8daf121dc56cd524b4f564d963ca96e6d496596f1869dcf`. `evaluation.json` contains aggregate metrics only; raw labels/examples, split membership and false predictions remain in ignored `.risk-models/20261003T113744758643Z/`.

The required sibling `context.fasttext.bin` is **ignored by Git**, locally hard-linked to the read-only cache; it is not bundled in a commit. Official source: [English Common Crawl/Wikipedia fastText models](https://fasttext.cc/docs/en/crawl-vectors.html), by Grave, Bojanowski, Gupta, Joulin and Mikolov, [Learning Word Vectors for 157 Languages](https://arxiv.org/abs/1802.06893). The pretrained vectors are distributed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/); retain attribution/license with any redistribution.

Compressed download: 4,503,593,528 bytes. Uncompressed binary: 7,237,176,312 bytes. Binary SHA-256: `14c7167b130056944cbdc37b7451f055867fe9a4e3fed3bbc1ecc0e74f6763ca`. This is a locally measured integrity record, not an independently signed publisher checksum. Runtime verifies size, fixed sibling location and hash before loading trusted native fastText data. No pickle, dynamic model downloads or agent-supplied embedding paths are accepted.

## Reproduce and enable

From `e2e_classifier`, in the separate project Conda environment:

```bash
python -m pip install -e '.[fasttext]'
mkdir -p .runtime/embeddings
curl --fail --location \
  --output .runtime/embeddings/cc.en.300.bin.gz \
  https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.en.300.bin.gz
gzip -dk .runtime/embeddings/cc.en.300.bin.gz
chmod 400 .runtime/embeddings/cc.en.300.bin
ln .runtime/embeddings/cc.en.300.bin models/action-risk-fasttext/context.fasttext.bin
python -m agent_monitor.action_risk.cli score \
  --model models/action-risk-fasttext/model.json \
  --input config/action-risk-exfil.example.json
export MONITOR_ACTION_RISK_MODEL="$PWD/models/action-risk-fasttext/model.json"
agent-monitor serve
```

Existing local weights are already linked; skip download/link steps on this Mac. Keep model/cache/configuration and private credentials outside the agent's writable task.

Retrain only the classifier:

```bash
python -m agent_monitor.action_risk.cli train --encoder fasttext \
  --sessions /absolute/security-stand/test-sessions \
  --pretrained-embeddings "$PWD/.runtime/embeddings/cc.en.300.bin" \
  --baseline-model models/action-risk-v1/model.json
```

For exact paired split verification also pass `--reference-evaluation /absolute/private/v1/evaluation.json` containing sample IDs. Training writes a fresh private timestamped directory, refuses existing outputs and never modifies input sessions or embedding weights. Python 3.12.14, scikit-learn 1.9.1, official fastText 0.9.3 were used. 100 Python tests pass, including frozen weights, native model loading, malformed descriptors and unchanged hard-policy decisions.
