# Action-risk baseline v1

Experimental namespaced unigram/bigram TF-IDF and class-balanced logistic regression, trained on synthetic tiny-sum maintenance sessions. Model ID: `81afeed77a6150eb`. Use only in shadow/advisory mode; scores cannot override the monitor's deterministic policies.

`model.json` contains vocabulary, IDF, linear weights and threshold, with standard-library inference and no pickle. SHA-256: `f24e68c206f6de89fdbb5a9d0ddf15b10c9c299590f285017ebe3e3f04ba58c9`. `evaluation.json` contains aggregate metrics, not raw session examples or split membership. Training examples, import reports, credentials and runtimes are not bundled.

Source: external `security-stand/test-sessions` corpus, 458 available real-model OpenCode 1.18.11 sessions (smoke sessions excluded), normalized to V2 actions. Labels are task-specific weak supervision, not independently reviewed truth. Family holdout with seed 17; vocabulary/weights fit on training only, threshold chosen on validation only, exact input duplicates and contradictory labels excluded.

After deduplication: 748 training, 204 validation, 88 held-out test actions. Test confusion matrix: TP=2, FP=0, TN=84, FN=2; precision 100%, recall 50%, F1 66.7%. There are only four positive test actions; this is not evidence of general-task or production accuracy. Misses were `.env` discovery/read. The exposed test set must not be reused for tuning. Scores are not calibrated probabilities; low coverage or missing runtime context yields abstention.

From the prototype directory:

```bash
python -m agent_monitor.action_risk.cli score \
  --model models/action-risk-v1/model.json \
  --input config/action-risk-exfil.example.json
export MONITOR_ACTION_RISK_MODEL="$PWD/models/action-risk-v1/model.json"
agent-monitor serve
```

Keep the monitor, model and private credentials outside the agent's writable task. See the prototype README for deployment, training and limitations.
