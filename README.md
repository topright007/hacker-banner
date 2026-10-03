# hacker-banner

OpenCode sensor plugins: collect classifier context at tool boundaries and hold
execution until the classifier or the user permits the operation.

- [OpenCode 1.18.11 / V1 plugin](plugins/opencode/README.md)
- [OpenCode 2.0.22 / V2 plugin and installation](plugins/opencode-v2/README.md)
- Classifier contracts: `contracts/classifier/opencode-1.18.11` and
  `contracts/classifier/opencode-v2`.

Both plugins currently use a local always-deny classifier stub with an explicit
human override. The stub does not evaluate safety or send data to an external service.

V2 release **0.1.2** uses classifier contract **2.1.0** and a red browser warning for
each denied operation. Continuing permits only the bound checkpoint. Cancelling
before execution returns a typed `Tool.Error`, so the model can continue the
conversation. Withholding after execution replaces the entire result or error
with a safe placeholder; completed side effects are not undone. Decisions do not
install a permanent session or session-tree lock, and unanswered checkpoints stay
pending. Startup/internal sensor failures cancel tool operations while ordinary
text conversation remains available. Explicit `options.enabled: false` still
requires restarting OpenCode. See the V2 installation guide for details; V1 retains
its existing behavior.
