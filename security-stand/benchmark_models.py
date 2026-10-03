#!/usr/bin/env python3
"""Benchmark real OpenCode runs across upstream models and retain full sessions."""

import argparse
from contextlib import contextmanager, nullcontext
import csv
import json
import os
from pathlib import Path
import random
import re
import select
import shutil
import socket
import socketserver
import statistics
import subprocess
import sys
import threading
import time
import urllib.parse


ROOT = Path(__file__).resolve().parent
RESULT_FIELDS = (
    'model', 'phase', 'repeat', 'wall_seconds', 'stand_return_code', 'run_id',
    'run_valid', 'task_success', 'exfiltration_received', 'attack_succeeded',
    'upstream_requests', 'upstream_seconds', 'artifact_dir',
)


class ConnectProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, server_address, allowed_host, allowed_port):
        self.allowed_host = allowed_host
        self.allowed_port = allowed_port
        super().__init__(server_address, ConnectHandler)


class ConnectHandler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(15)
        request = b''
        while b'\r\n\r\n' not in request and len(request) <= 8192:
            chunk = self.request.recv(4096)
            if not chunk:
                return
            request += chunk
        try:
            method, authority, _ = request.split(b'\r\n', 1)[0].decode('ascii').split(' ', 2)
            host, port_text = authority.rsplit(':', 1)
            port = int(port_text)
        except (UnicodeDecodeError, ValueError):
            self.request.sendall(b'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
            return
        if method != 'CONNECT' or host != self.server.allowed_host or port != self.server.allowed_port:
            self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
            return
        try:
            upstream = socket.create_connection((host, port), timeout=30)
        except OSError:
            self.request.sendall(b'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
            return
        with upstream:
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            sockets = [self.request, upstream]
            while sockets:
                readable, _, _ = select.select(sockets, [], [], 60)
                if not readable:
                    return
                for source in readable:
                    try:
                        data = source.recv(65536)
                    except OSError:
                        return
                    if not data:
                        return
                    destination = upstream if source is self.request else self.request
                    try:
                        destination.sendall(data)
                    except OSError:
                        return


@contextmanager
def host_connect_proxy(upstream_url):
    parsed = urllib.parse.urlsplit(upstream_url)
    if parsed.scheme != 'https' or not parsed.hostname:
        raise ValueError('--host-connect-proxy requires an HTTPS STAND_UPSTREAM')
    port = parsed.port or 443
    server = ConnectProxy(('0.0.0.0', 0), parsed.hostname, port)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    previous = os.environ.get('STAND_HTTPS_PROXY')
    os.environ['STAND_HTTPS_PROXY'] = f'http://host.docker.internal:{server.server_address[1]}'
    try:
        yield
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        if previous is None:
            os.environ.pop('STAND_HTTPS_PROXY', None)
        else:
            os.environ['STAND_HTTPS_PROXY'] = previous


def slug(value):
    return re.sub(r'[^a-zA-Z0-9._-]+', '-', value).strip('-')


def load_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {} if default is None else default


def upstream_timing(trace_path):
    durations = []
    try:
        lines = trace_path.read_text().splitlines()
    except OSError:
        return 0, None
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get('kind') != 'upstream_metadata':
            continue
        value = event.get('payload', {}).get('elapsed_time_ms')
        if isinstance(value, (int, float)):
            durations.append(value / 1000)
    return len(durations), sum(durations) if durations else None


def run_one(args, output_root, model, phase, repeat):
    label = f'{phase}-{repeat:03d}'
    destination = output_root / slug(model) / label
    command = [sys.executable, str(ROOT / 'stand.py'), '--mode', 'real',
               '--scenario', args.scenario, '--model', model,
               '--timeout', str(args.timeout), '--trace-session',
               '--context', args.context, '--repeat', str(repeat)]
    print(f'[{model} {label}] starting', flush=True)
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=ROOT, env=os.environ.copy(), text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=1)
    output, run_dir = [], None
    for line in process.stdout:
        output.append(line)
        match = re.match(r'Artifacts: (.+)\s*$', line)
        if match:
            run_dir = Path(match.group(1))
        if line.startswith(('Building isolated services', 'Running OpenCode', 'Artifacts:')):
            print(f'[{model}] {line}', end='', flush=True)
    return_code = process.wait()
    wall_seconds = time.monotonic() - started
    destination.parent.mkdir(parents=True, exist_ok=True)
    if run_dir and run_dir.is_dir():
        shutil.copytree(run_dir, destination)
    else:
        destination.mkdir(parents=True, exist_ok=True)
    (destination / 'benchmark-run.log').write_text(''.join(output))
    result = load_json(destination / 'result.json')
    request_count, upstream_seconds = upstream_timing(destination / 'model-trace.jsonl')
    row = {
        'model': model, 'phase': phase, 'repeat': repeat,
        'wall_seconds': round(wall_seconds, 3), 'stand_return_code': return_code,
        'run_id': result.get('run_id'), 'run_valid': result.get('run_valid'),
        'task_success': result.get('task_success'),
        'exfiltration_received': result.get('exfiltration_received'),
        'attack_succeeded': result.get('attack_succeeded'),
        'upstream_requests': request_count,
        'upstream_seconds': round(upstream_seconds, 3) if upstream_seconds is not None else None,
        'artifact_dir': str(destination),
    }
    print(f'[{model} {label}] wall={wall_seconds:.1f}s valid={row["run_valid"]} '
          f'task={row["task_success"]}', flush=True)
    return row


def write_outputs(root, args, rows):
    (root / 'results.json').write_text(json.dumps(rows, indent=2))
    with (root / 'results.csv').open('w', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=RESULT_FIELDS, lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)
    measured = [row for row in rows if row['phase'] == 'measured']
    summaries = []
    for model in args.models:
        warmup_rows = [row for row in rows if row['phase'] == 'warmup' and row['model'] == model]
        model_rows = [row for row in measured if row['model'] == model]
        eligible = [row for row in model_rows if row['run_valid'] is True and row['task_success'] is True]
        durations = [row['wall_seconds'] for row in eligible]
        upstream = [row['upstream_seconds'] for row in eligible if row['upstream_seconds'] is not None]
        summaries.append({
            'model': model, 'warmup_runs': len(warmup_rows),
            'warmup_valid_task_runs': sum(row['run_valid'] is True and row['task_success'] is True
                                          for row in warmup_rows),
            'measured_runs': len(model_rows),
            'valid_task_runs': len(eligible),
            'exfiltration_runs': sum(row['exfiltration_received'] is True for row in eligible),
            'median_wall_seconds': round(statistics.median(durations), 3) if durations else None,
            'mean_wall_seconds': round(statistics.mean(durations), 3) if durations else None,
            'min_wall_seconds': min(durations) if durations else None,
            'max_wall_seconds': max(durations) if durations else None,
            'median_upstream_seconds': round(statistics.median(upstream), 3) if upstream else None,
        })
    eligible_models = [item for item in summaries if item['valid_task_runs'] == args.repeats]
    fastest = min(eligible_models, key=lambda item: item['median_wall_seconds']) if eligible_models else None
    summary = {
        'scenario': args.scenario, 'warmups': args.warmups, 'repeats': args.repeats,
        'models': summaries, 'fastest_model': fastest['model'] if fastest else None,
        'ranking_rule': 'lowest median wall time among models with every measured run valid and task-successful',
    }
    (root / 'summary.json').write_text(json.dumps(summary, indent=2))
    lines = [f'# Model benchmark — {args.scenario}', '',
             f'Up to {args.warmups} warm-up and {args.repeats} measured runs per model. '
             'Warm-ups are excluded from rankings; models that fail warm-up are not measured.', '',
             '| Model | Valid warm-ups | Valid measured | Exfiltration | Median wall | Mean wall | Min–max | Median upstream |',
             '|---|---:|---:|---:|---:|---:|---:|---:|']
    for item in sorted(summaries, key=lambda value: (
            value['median_wall_seconds'] is None, value['median_wall_seconds'] or float('inf'))):
        fmt = lambda value: 'n/a' if value is None else f'{value:.3f}s'
        bounds = ('n/a' if item['min_wall_seconds'] is None else
                  f'{item["min_wall_seconds"]:.3f}–{item["max_wall_seconds"]:.3f}s')
        lines.append(f'| `{item["model"]}` | {item["warmup_valid_task_runs"]}/{item["warmup_runs"]} | '
                     f'{item["valid_task_runs"]}/{item["measured_runs"]} | '
                     f'{item["exfiltration_runs"]}/{item["valid_task_runs"]} | '
                     f'{fmt(item["median_wall_seconds"])} | {fmt(item["mean_wall_seconds"])} | '
                     f'{bounds} | {fmt(item["median_upstream_seconds"])} |')
    lines.extend(['', '## Runs', '',
                  '| Model | Phase | Repeat | Wall | Valid | Task success | Exfiltration | Transcript |',
                  '|---|---|---:|---:|---:|---:|---:|---|'])
    for row in rows:
        transcript = Path(row['artifact_dir']) / 'session-transcript.md'
        link = transcript.relative_to(root).as_posix() if transcript.exists() else ''
        lines.append(f'| `{row["model"]}` | {row["phase"]} | {row["repeat"]} | '
                     f'{row["wall_seconds"]:.3f}s | {row["run_valid"]} | {row["task_success"]} | '
                     f'{row["exfiltration_received"]} | '
                     f'{f"[transcript]({link})" if link else "missing"} |')
    lines.extend(['', '## Selection', '',
                  (f'Fastest eligible model: `{fastest["model"]}` with median wall time '
                   f'{fastest["median_wall_seconds"]:.3f}s.' if fastest else
                   'No model completed every measured run validly with a successful user task.'), ''])
    (root / 'REPORT.md').write_text('\n'.join(lines))
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--models', nargs='+', required=True)
    parser.add_argument('--scenario', default='skill-required-prerequisite')
    parser.add_argument('--warmups', type=int, default=1)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--seed', type=int, default=20261003)
    parser.add_argument('--context', default='colima-security-stand')
    parser.add_argument('--host-connect-proxy', action='store_true',
                        help='bridge an IPv6-only HTTPS upstream through the macOS host')
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    if not os.environ.get('STAND_UPSTREAM') or not os.environ.get('STAND_API_KEY'):
        parser.error('STAND_UPSTREAM and STAND_API_KEY are required')
    if min(args.warmups, args.repeats) < 1:
        parser.error('warmups and repeats must be positive')
    root = (args.output_dir or ROOT / 'test-sessions' / 'model-benchmarks' /
            (time.strftime('%Y%m%d-%H%M%S') + '-' + slug(args.scenario))).resolve()
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    rows = []
    proxy = host_connect_proxy(os.environ['STAND_UPSTREAM']) if args.host_connect_proxy else nullcontext()
    with proxy:
        benchmark_models = []
        for model in args.models:
            warmups = []
            for repeat in range(1, args.warmups + 1):
                row = run_one(args, root, model, 'warmup', repeat)
                rows.append(row)
                warmups.append(row)
            if all(row['run_valid'] is True and row['task_success'] is True for row in warmups):
                benchmark_models.append(model)
            else:
                print(f'[{model}] skipping measured runs after failed warm-up', flush=True)
            write_outputs(root, args, rows)
        jobs = [(model, repeat) for repeat in range(1, args.repeats + 1)
                for model in benchmark_models]
        random.Random(args.seed).shuffle(jobs)
        for model, repeat in jobs:
            rows.append(run_one(args, root, model, 'measured', repeat))
            write_outputs(root, args, rows)
        summary = write_outputs(root, args, rows)
    print(json.dumps({'output_dir': str(root), 'fastest_model': summary['fastest_model']}, indent=2))


if __name__ == '__main__':
    main()
