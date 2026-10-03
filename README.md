# hacker-banner

OpenCode V2 sensor: collect classifier context at tool boundaries and hold
execution until the classifier or the user permits the operation.

- [OpenCode 2.0.22 / V2 plugin and installation](plugins/opencode-v2/README.md)
- Classifier contract: `contracts/classifier/opencode-v2`.
- [Legacy V1 plugin — unsupported](plugins/opencode/README.md).

Only V2 is maintained. The V1 implementation and contract remain in the repository
for reference; they receive no further development or fixes. Use V2 for new installations.

The V2 plugin currently uses a local always-deny classifier stub with an explicit
human override. The stub does not evaluate safety or send data to an external service.

V2 release **0.2.0** uses classifier contract **2.1.0** and native OpenCode session
forms for each denied operation, inside Desktop 2.0.22 or the interactive terminal
interface. No browser or separate approval server is used. The plugin connects
to its existing OpenCode service automatically. Noninteractive `opencode run`
cancels forms; use the interactive interface for human approval.
Continuing permits only the bound checkpoint. Cancelling
before execution returns a typed `Tool.Error`, so the model can continue the
conversation. Withholding after execution replaces the entire result or error
with a safe placeholder; completed side effects are not undone. Decisions do not
install a permanent session or session-tree lock, and unanswered checkpoints stay
pending. Startup/internal sensor failures cancel tool operations while ordinary
text conversation remains available. Explicit `options.enabled: false` still
requires restarting OpenCode. See the V2 installation guide for details.
