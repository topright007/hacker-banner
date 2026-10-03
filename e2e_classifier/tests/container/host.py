"""Build/run the network-isolated test image and save a machine-readable report."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", help="Existing Docker context; does not change active context")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--scenario", action="append")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    executable = shutil.which("docker")
    if not executable:
        parser.error("Docker CLI not installed; use an available container runtime")
    docker = [executable] + (["--context", args.context] if args.context else [])
    subprocess.run([*docker, "info"], check=True, stdout=subprocess.DEVNULL)
    image = "aidr-opencode-monitor-test:2.0.22"
    if not args.skip_build:
        subprocess.run([*docker, "build", "-f", "tests/container/Dockerfile", "-t", image, "."], cwd=root, check=True)
    command = [*docker, "run", "--rm", "--network", "none", "--read-only",
               "--cap-drop", "ALL", "--cap-add", "SETUID", "--cap-add", "SETGID",
               "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE",
               "--security-opt", "no-new-privileges:true", "--memory", "2g", "--cpus", "2",
               "--pids-limit", "256", "--tmpfs", "/tmp:rw,exec,nosuid,size=1g", image]
    for scenario in args.scenario or []:
        command += ["--scenario", scenario]
    report_dir = root / "container-results"
    report_dir.mkdir(exist_ok=True)
    output = []
    with (report_dir / "latest.jsonl").open("w") as log:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            for line in process.stdout:
                log.write(line)
                log.flush()
                try:
                    value = json.loads(line)
                except ValueError:
                    print(line, end="", flush=True)
                    continue
                output.append(value)
                if "scenario" in value:
                    print(f"{value['scenario']} {'monitored' if value['monitored'] else 'control'}: {'PASS' if value['passed'] else 'FAIL'}; effect={value['effect_observed']}; reasons={value['reason_codes']}", flush=True)
                    if not value["passed"]:
                        print(value["stdout"][-4000:], value["stderr"][-3000:], flush=True)
                else:
                    print(json.dumps(value), flush=True)
            exit_code = process.wait()
        except BaseException:
            # Normal cancellation closes the Docker client. Never prune unrelated resources.
            process.terminate()
            process.wait(timeout=10)
            raise
    inspect = subprocess.check_output([*docker, "image", "inspect", image], text=True)
    report = {"recorded_at_utc": datetime.now(timezone.utc).isoformat(), "exit_code": exit_code,
              "image_id": json.loads(inspect)[0]["Id"], "docker_context": args.context,
              "runtime_network": "none", "host_mounts": [], "runs": output}
    (report_dir / "latest.json").write_text(json.dumps(report, indent=2))
    print(f"Full report: {report_dir / 'latest.json'}", flush=True)
    raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
