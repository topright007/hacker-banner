"""Offline operator commands for an advisory action-risk classifier."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path

from .data import import_sessions
from .model import ActionRiskModel
from .train import train


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False))
    path.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    fit = commands.add_parser("train")
    fit.add_argument("--sessions", required=True, type=Path)
    fit.add_argument("--output", default=Path(".risk-models"), type=Path)
    fit.add_argument("--seed", type=int, default=17)
    fit.add_argument("--encoder", choices=("tfidf", "fasttext"), default="tfidf")
    fit.add_argument("--pretrained-embeddings", type=Path, help="Trusted pretrained fastText .bin; required for fasttext")
    fit.add_argument("--reference-evaluation", type=Path, help="Private v1 report with frozen split sample IDs")
    fit.add_argument("--baseline-model", type=Path, help="Existing v1 model for paired descriptive comparison")
    score = commands.add_parser("score")
    score.add_argument("--model", required=True, type=Path)
    score.add_argument("--input", required=True, type=Path, help="JSON: goal, operator, history, proposed action; no current outcome")
    args = parser.parse_args()
    if args.command == "score":
        print(json.dumps(ActionRiskModel.load(args.model).predict(json.loads(args.input.read_text())), indent=2))
        return
    if args.encoder == "fasttext" and args.pretrained_embeddings is None:
        parser.error("--encoder fasttext requires --pretrained-embeddings; embeddings are never fitted on sessions")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = args.output.resolve() / stamp
    output.mkdir(parents=True, mode=0o700)
    rows, import_report = import_sessions(args.sessions)
    write_json(output / "import-report.json", import_report)
    write_json(output / "dataset.json", rows)
    if args.encoder == "fasttext":
        from .fasttext_train import train_fasttext
        reference = json.loads(args.reference_evaluation.read_text()) if args.reference_evaluation else None
        artifact, report = train_fasttext(rows, output, args.pretrained_embeddings, args.seed,
                                         reference, args.baseline_model)
    else:
        artifact, report = train(rows, args.seed)
        # Different dedup means this ablation is not a paired comparison.
        try:
            _, action_only = train(rows, args.seed, include_history=False)
            report["action_only_ablation"] = action_only
        except ValueError as exc:
            report["action_only_ablation"] = {"unavailable": str(exc)}
    write_json(output / "model.json", artifact)
    write_json(output / "evaluation.json", report)
    # Separate, inspectable source labels from inputs. Never load pickle models.
    print(json.dumps({"output": str(output), "model": str(output / "model.json"),
                      "import": import_report["counts"], "evaluation": report["splits"]["test"]["metrics"],
                      "mode": "advisory", "limitations": report["limitations"]}, indent=2))


if __name__ == "__main__":
    main()
