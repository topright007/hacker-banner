"""Policy facts come from operator configuration, not model-provided labels."""
import base64
import binascii
import fnmatch
import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import yaml


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False, allow_nan=False).encode()).hexdigest()


SECRET = re.compile(r"MONITOR_SECRET_[A-Za-z0-9_-]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b(?:sk-|AKIA)[A-Za-z0-9_-]{16,}")
PII = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
INJECTION = re.compile(r"ignore (?:all |the )?(?:previous|prior) instructions|system override|do not (?:tell|mention)|send (?:the |all |my )?(?:password|security code|secret)", re.I)
ENCODED = re.compile(r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/])")


def inspect_content(text: str) -> tuple[bool, list[str]]:
    """Bounded decoding for findings. Never execute or decrypt attacker content."""
    candidates = [text[:65536]]
    findings: list[str] = []
    for token in ENCODED.findall(candidates[0])[:8]:
        try:
            decoded = base64.b64decode(token + "=" * (-len(token) % 4), validate=True)
            if len(decoded) <= 16384:
                candidates.append(decoded.decode("utf-8"))
                findings.append("P07_ENCODED_CONTENT")
        except (ValueError, UnicodeDecodeError, binascii.Error):
            pass
    if any(INJECTION.search(c) for c in candidates):
        findings.append("P07_SUSPECTED_INJECTION")
    return any(SECRET.search(c) or PII.search(c) for c in candidates), sorted(set(findings))


@dataclass
class Assessment:
    effect: str
    reasons: list[str] = field(default_factory=list)
    findings: list[str] = field(default_factory=list)
    sensitive_read: bool = False
    requires_approval: bool = False
    target: str = ""


class Policy:
    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        self.data = yaml.safe_load(self.path.read_text())
        self.version = f"{self.data['version']}:{digest(self.data)[:12]}"

    def assess(self, run: dict, action: dict) -> Assessment:
        name, args = action["tool"], action["arguments"]
        tool = self.data["tools"].get(name)
        if not tool:
            return Assessment("unknown", ["P01_UNKNOWN_TOOL"])
        effect = tool["effect"]
        a = Assessment(effect)
        profile = self.data["profiles"][run["profile"]]
        if "allowed_tools" in profile and name not in profile["allowed_tools"]:
            a.reasons.append("P01_TOOL_OUTSIDE_TASK_PROFILE")
        workspace = Path(run["workspace"])
        _, a.findings = inspect_content(json.dumps(args, ensure_ascii=False))

        if effect == "delegate":
            a.reasons.append("P10_DELEGATION_UNSUPPORTED")
        if effect == "opaque":
            a.reasons.append("P12_UNINSPECTABLE_ACTION")
        if effect in {"write", "destructive"}:
            if not profile["mutations"]:
                a.reasons.append("P01_READ_ONLY_TASK")
            if effect == "destructive":
                a.requires_approval = True

        path_arg = tool.get("path_argument")
        if path_arg:
            raw = args.get(path_arg)
            if raw is None and name in {"glob", "grep"}:
                raw = "."
            if not isinstance(raw, str) or not raw:
                a.reasons.append("P02_MISSING_PATH")
            else:
                target = (workspace / raw).resolve()
                a.target = str(target)
                if not target.is_relative_to(workspace):
                    a.reasons.append("P02_OUTSIDE_WORKSPACE")
                else:
                    relative = target.relative_to(workspace).as_posix()
                    if target == self.path or any(fnmatch.fnmatchcase(relative, p) or
                                                (p.endswith('/**') and relative == p[:-3])
                                                for p in self.data["protected_paths"]):
                        a.reasons.append("P11_PROTECTED_RESOURCE")
                    if effect == "read" and not target.is_file():
                        a.reasons.append("P02_REGULAR_FILE_REQUIRED")
                    if any(fnmatch.fnmatchcase(relative, p) for p in self.data["sensitive_paths"]):
                        a.sensitive_read = effect == "read"
        if effect == "read":
            # All native repository reads are private by default. Fixture/public
            # tools are exceptions established by operator policy, never the agent.
            a.sensitive_read |= bool(tool.get("sensitive", True))

        if effect == "shell":
            a.target = str(args.get("command", ""))
            command = args.get("command")
            cwd = args.get("workdir", args.get("cwd", str(workspace)))
            if not isinstance(cwd, str) or not Path(cwd).is_absolute() or Path(cwd).resolve() != workspace:
                a.reasons.append("P02_SHELL_WORKSPACE")
            if not self.safe_shell(command):
                a.reasons.append("P12_UNINSPECTABLE_COMMAND")
            a.sensitive_read = True

        if effect == "outbound":
            raw = args.get(tool.get("destination_argument", ""))
            if not isinstance(raw, str) or not raw:
                a.reasons.append("P04_MISSING_DESTINATION")
            else:
                a.target = raw
                if not self.allowed_destination(raw, profile["destinations"]):
                    a.reasons.append("P04_DESTINATION_NOT_ALLOWED")
            if not profile["outbound"]:
                a.reasons.append("P01_OUTBOUND_NOT_AUTHORIZED")
            # Match obvious secrets even before a run becomes tainted.
            sensitive, _ = inspect_content(json.dumps(args, ensure_ascii=False))
            if sensitive or run["sensitive"]:
                a.requires_approval = True
                a.findings.append("P05_SENSITIVE_RUN_EGRESS")
        return a

    @staticmethod
    def allowed_destination(raw: str, allowed: list[str]) -> bool:
        if "://" not in raw:
            return raw in allowed
        try:
            parsed = urlsplit(raw)
            if parsed.scheme != "https" or parsed.username or parsed.password or not parsed.hostname:
                return False
            origin = f"https://{parsed.hostname.lower()}"
            if parsed.port and parsed.port != 443:
                origin += f":{parsed.port}"
            return origin in allowed
        except ValueError:
            return False

    @staticmethod
    def safe_shell(command) -> bool:
        # Even git status can invoke repository-configured helpers. Native shells
        # load initialization files and inherit credentials: no syntactic whitelist
        # is a security boundary. Enable only through a separately sandboxed tool.
        return False
