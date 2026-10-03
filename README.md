# hacker-banner

OpenCode V2 sensor: collect classifier context at tool boundaries and hold
execution until the classifier or the user permits the operation.

- [OpenCode 2.0.22 / V2 plugin and installation](plugins/opencode-v2/README.md)
- Classifier contract: `contracts/classifier/opencode-v2`.
- [Legacy V1 plugin — unsupported](plugins/opencode/README.md).

Only V2 is maintained. V1 remains for reference and receives no further development
or fixes. Use V2 for new installations.

V2 release **0.4.1** uses classifier contract **2.3.0** for its default
`backend: "stub"`. This always-deny local stub does not evaluate safety or send
data to a service.

In stub mode, warnings appear as native session forms inside Desktop 2.0.22 or the
interactive terminal interface, using this text:

> Зафиксирована хакерская атака. Выберите возможные варианты действий

The form does not display the tool name or classifier reason. With the always-deny
stub, this is fixed interface copy, not evidence of a detected attack. Two
predefined choices are available:

1. **«Продолжить в режиме карантина»** — persist chat-only quarantine for this
   session and its descendants linked by `parentID`. Later tools are blocked
   automatically without further approvals. Quarantine survives service restarts;
   unrelated new sessions remain available. Fork provenance alone does not imply
   parent-child inheritance.
2. **«Принять риски и продолжить»** — permit this bound checkpoint once. Pre and post
   approvals are independent, so the stub can ask again before releasing a result.

Desktop 2.0.22 also displays a custom-answer option. Submitted free text selects
quarantine, including words such as `allow` or the trust button's label. Each form
uses an opaque per-form value for the actual trust option; the native API does not
identify input origin, so manually submitting that exact value is indistinguishable
from selecting the button. Blank input leaves the form pending.

Post blocking replaces the complete result or error; completed side effects and
already running external processes are not undone. Closing a form or a technical
stub sensor failure rejects the affected operation without selecting persistent
quarantine. Unanswered forms remain pending. Stub classifier outages remain fail-open
under native permissions, except that existing quarantine continues to block tools.

Stub mode uses no browser or separate approval server. The sensor connects to its existing
OpenCode service. Noninteractive `opencode run` cancels forms; use the interactive
interface for human approval. The local quarantine store is shared across sensor
instances at `~/.local/state/opencode-sensor-v2/quarantine`, separately from
per-instance audit files. Explicit `options.enabled: false` disables enforcement
after restarting OpenCode but does not delete saved quarantine markers.

The standalone V2 sensor can also connect directly to the Python Agent Monitor in
`e2e_classifier` using `backend: "agent_monitor"` and a private run-credentials file.
Monitor mode uses contract **2.2.0**, enforces policy blocks, consumes execution
permits, and reports results to the service. Exact-call approvals come from the
trusted `agent-monitor approve` CLI while the original tool call waits. Policy
blocks reject the current call without local override; incomplete monitor state
stops further execution until a new run is registered and OpenCode restarts. See the V2 installation guide for service setup and supported tools.

For optional pretrained fastText shadow scoring, follow the [embedding download and setup instructions](e2e_classifier/README.md#download-pretrained-fasttext-embeddings). The large pretrained binary is downloaded separately and is not included in Git.

The two native choices belong only to stub mode. They do not bypass Agent Monitor
policy or replace trusted CLI approval. Existing local session quarantine remains
enforced after changing backend, independently of monitor permits.

See the [installation guide](plugins/opencode-v2/README.md) for configuration,
custom state paths, verification, and coverage limitations.
