#!/usr/bin/env python3
"""Run every stand scenario sequentially and collect reviewable session bundles."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

from stand import ROOT, SCENARIOS

SESSION_FILES = (
    'session.json', 'session-export-status.json', 'session-transcript.md',
    'session-analysis.json', 'provider-reasoning.json', 'system-messages.json',
    'model-trace.jsonl', 'agent-events.jsonl', 'agent-stderr.log',
    'collector-requests.jsonl', 'manifest.json', 'result.json', 'report.md',
    'network-check.json',
)


def copy_session(run_dir, destination):
    destination.mkdir(mode=0o700, exist_ok=True)
    copied = []
    for name in SESSION_FILES:
        source = run_dir / name
        if source.exists():
            shutil.copy2(source, destination / name)
            copied.append(name)
    return copied


def run_scenario(args, scenario, batch_dir):
    command = [sys.executable, str(ROOT / 'stand.py'), '--mode', args.mode,
               '--scenario', scenario, '--timeout', str(args.timeout), '--trace-session',
               '--context', args.context]
    if args.mode == 'real':
        command.extend(['--model', args.model])
    process = subprocess.Popen(command, cwd=ROOT, env=os.environ.copy(), text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1)
    output = []
    run_dir = None
    for line in process.stdout:
        print(f'[{scenario}] {line}', end='', flush=True)
        output.append(line)
        match = re.match(r'Artifacts: (.+)\s*$', line)
        if match:
            run_dir = Path(match.group(1))
    return_code = process.wait()
    scenario_dir = batch_dir / scenario
    scenario_dir.mkdir(mode=0o700)
    (scenario_dir / 'batch-run.log').write_text(''.join(output))
    copied = copy_session(run_dir, scenario_dir) if run_dir and run_dir.is_dir() else []
    result_path = scenario_dir / 'result.json'
    result = json.loads(result_path.read_text()) if result_path.exists() else {}
    return {'scenario': scenario, 'return_code': return_code,
            'run_id': result.get('run_id'), 'run_dir': str(run_dir) if run_dir else None,
            'copied_files': copied, 'result': result}


def write_summary(batch_dir, entries, args):
    index = {'batch_id': batch_dir.name, 'mode': args.mode, 'model': args.model,
             'scenarios': entries}
    (batch_dir / 'index.json').write_text(json.dumps(index, indent=2, ensure_ascii=False))
    lines = [f'# Security stand batch {batch_dir.name}', '',
             f'- Mode: `{args.mode}`', f'- Model: `{args.model or "scripted-smoke"}`', '',
             '| Scenario | Run status | Attack succeeded | Exfiltration | Task success | Session |',
             '|---|---|---:|---:|---:|---|']
    for entry in entries:
        result = entry['result']
        session = '[transcript](./{0}/session-transcript.md)'.format(entry['scenario']) if 'session-transcript.md' in entry['copied_files'] else 'missing'
        lines.append('| {scenario} | {status} | {attack} | {exfil} | {task} | {session} |'.format(
            scenario=entry['scenario'], status=result.get('run_status', 'missing'),
            attack=result.get('attack_succeeded'), exfil=result.get('exfiltration_received'),
            task=result.get('task_success'), session=session))
    lines.extend(['', 'Raw session exports and model traces may contain synthetic canaries.'])
    (batch_dir / 'README.md').write_text('\n'.join(lines) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['smoke', 'real'], default='real')
    parser.add_argument('--model', help='Required in real mode')
    parser.add_argument('--timeout', type=int, default=900)
    parser.add_argument('--context', default='colima-security-stand')
    parser.add_argument('--sessions-root', type=Path, default=ROOT / 'test-sessions')
    parser.add_argument('--scenarios', nargs='*', choices=sorted(SCENARIOS), default=sorted(SCENARIOS))
    args = parser.parse_args()
    if args.mode == 'real' and not args.model:
        parser.error('--model is required in real mode')
    batch_id = time.strftime('%Y%m%d-%H%M%S')
    batch_dir = args.sessions_root / batch_id
    batch_dir.mkdir(parents=True, mode=0o700)
    entries = []
    for scenario in args.scenarios:
        entries.append(run_scenario(args, scenario, batch_dir))
        write_summary(batch_dir, entries, args)
    failures = [entry for entry in entries if entry['return_code'] != 0 or not entry['copied_files']]
    print(json.dumps({'batch_dir': str(batch_dir), 'scenarios': len(entries),
                      'execution_failures': [entry['scenario'] for entry in failures]}, indent=2))
    raise SystemExit(1 if failures else 0)


if __name__ == '__main__':
    main()
