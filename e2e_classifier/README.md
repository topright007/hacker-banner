# Agent Monitor prototype

Python runtime policy service with a thin **OpenCode V2 2.0.22** adapter. The monitor is the decision/state service; the plugin is the harness-specific interception point. Other harnesses implement the same HTTP protocol without changing Python policy code.

This is an enforcement prototype, **not a production security boundary**. Use synthetic data. The adapter has now been tested inside real OpenCode V2 2.0.22 in a network-isolated container: 14 paired scenarios, 28 passing runs. These use a scripted local provider, not a language model or an attack-success-rate benchmark. See `TEST-RESULTS.md` and `tests/container/README.md`.

## Separate Conda environment

The project environment is already created at `.conda-env`. No project dependencies were installed into the base Conda environment.

```bash
conda activate /Users/textor/Documents/ChatGPT/aidr-hackathon/.conda-env
python --version
python -m pytest -q
```

To reproduce elsewhere, from the repository:

```bash
conda env create --prefix ./.conda-env --file environment.yml
conda activate "$PWD/.conda-env"
python -m pip install --no-deps --no-build-isolation -e .
cd adapters/opencode
npm ci --ignore-scripts
npm test
```

`environment.yml` describes the Conda environment; `pyproject.toml` describes the Python package. `package-lock.json` pins adapter dependencies. Conda/Python transitive dependencies are not fully locked yet. Node and npm run from the Conda environment. The unused earlier `.venv` is ignored and is not used.

## Start and deploy

Run the service and operator CLI from this repository, in the Conda environment. Keep the monitor installation, policy, database, administrator token, and run credential file **outside the agent's writable workspace**.

```bash
umask 077
export MONITOR_ADMIN_TOKEN="$(agent-monitor token)"
agent-monitor serve
```

Default: loopback `127.0.0.1:8765`, database `.monitor/state.sqlite`, policy `config/policies.yaml`. Set `MONITOR_DB` and `MONITOR_POLICY` to absolute trusted paths to override them. Use one Uvicorn worker for the prototype. Run under a supervisor for restart; SQLite preserves sensitivity, approvals, counters and audit events.

In another trusted terminal, use the **same** administrator token and register the task:

```bash
agent-monitor register \
  --goal "Review this project; do not modify it" \
  --workspace /absolute/disposable/task \
  --profile review \
  --output /absolute/private/run.credentials.json
```

The credential file is created exclusively with mode `0600`; registration refuses a file inside the task workspace. Do not put administrator credentials in plugin options, model prompts, or the harness environment. The harness receives only run-scoped credentials through the plugin's private file.

Build the adapter and copy `adapters/opencode/opencode.example.json` into the disposable task as `opencode.json`, replacing its two absolute paths. Use a trusted adapter installation outside that task. The V2 configuration uses `plugins`, not V1's `plugin` field. [V2 plugin reference](https://opencode.ai/v2/docs/build/plugins).

Start an already-installed **V2 2.0.22** CLI with a private server:

```bash
env -u MONITOR_ADMIN_TOKEN opencode --standalone /absolute/disposable/task
```

The adapter refuses other versions. The V2 CLI package is `@opencode/cli`, not the V1 `opencode-ai` package. The container test image installs that CLI; it is not installed directly on the host. [V2 installation](https://opencode.ai/v2/docs/).

Do not share the plugin instance between unrelated sessions: one credential binds to one session. Prompt attachments and session subpaths are disabled until their scope mapping is verified. New prompts can be inspected but cannot expand the registered profile; materially changing the task requires a new registration.

For stronger deployment, put OpenCode in a separate sandbox/user/container, mount the trusted adapter/config read-only, expose only the task filesystem and approved model endpoint, and deny other egress. The monitor needs a read-only view of task paths with the same absolute path mapping. Put external service credentials in a tool gateway, not OpenCode. An in-process plugin can be bypassed if the harness, its plugin installation, or hook ordering is compromised.

## Runtime protocol

`POST /v1/runs` requires administrator authentication. All tool/event endpoints use a different run-scoped bearer token.

1. `/v1/evaluate`: exact call ID, session ID, tool and JSON arguments; returns `ALLOW`, `BLOCK`, or `REQUIRE_APPROVAL`.
2. `/v1/start`: repeat the exact request plus `X-Execution-Permit`; consumes a short-lived, single-use permit immediately before execution.
3. `/v1/results`: report completion/error and result using that permit.
4. `/v1/events`: inspect bounded prompt/context content without granting authority.

Unknown tools, unavailable monitor, invalid replies, stale permits and session mismatches prevent execution. Missing/failed result reporting stops subsequent adapter calls. Tool result text is inspected, then only its hash and findings are stored. **The registered goal is stored verbatim**, so the SQLite database remains sensitive.

Administrator commands:

```bash
agent-monitor inspect RUN_ID
agent-monitor approve APPROVAL_ID
agent-monitor approve APPROVAL_ID --reject
agent-monitor terminate RUN_ID
```

Approval binds run, call, canonical arguments, policy hash, sensitivity epoch and expiry, and is consumed once. It cannot override a hard prohibition. The plugin throws with an approval ID; it does not provide a native suspension UI. Approval does not automatically rerun anything. An integration retry using the same call ID can consume it; a new OpenCode call ID needs its own approval. For an approved operational workflow, use a launcher/gateway that preserves the exact call ID rather than relying on model retries.

## Policies actually implemented

| Policy | Prototype behavior |
| --- | --- |
| P01 task/tool scope | Operator profile controls mutations, outbound access and optional tool allowlist. Review cannot edit or call private fixture tools. No model-derived grants. |
| P02 resources | Resolve paths under registered workspace, reject symlink escapes, require regular-file reads. |
| P03 consequential actions | Simulated deletion, booking and payment changes require separate exact approval. |
| P04 destinations | Explicit recipient/HTTPS-origin allowlist; no credentials in URLs or suffix matching. This is not DNS/redirect/SSRF enforcement. |
| P05 confidentiality | Mark native file reads/private tools sensitive **before** granting execution. All later modeled outbound calls require approval, including opaque encrypted payloads. Failure does not clear sensitivity. |
| P06 semantic task adherence | Not implemented. Goal text is context for the operator, not an automatic semantic authorization judge. |
| P07 untrusted instructions | Bounded base64 inspection and simple injection/secret/PII patterns produce findings. Encoded text alone is not automatically malicious. No universal decoding or decryption. |
| P08 evasion | Record exact canonical denied-action retries. No semantic equivalence across alternate tools. |
| P09 budgets | Transactionally reserve a configured call count; no monetary/token/time budgeting yet. |
| P10 delegation | Block subagents/delegation; no scope inheritance yet. |
| P11 integrity | Authenticated API, strict schemas, session binding, protected paths, hashed content audit, single-use permits and adapter fail-closed behavior. Needs OS isolation. |
| P12 opaque commands | Deny **all native shell execution**, Code Mode, unparsed patches and recursive grep/glob. Even readable shell commands can invoke configured helpers. |

Native `read` and `write` path mappings and native `shell` blocking are now live-tested; `edit` and `webfetch` still need native schema/behavior probes. V2 file tools use `path`, not V1's `filePath`. Unrecognized native/MCP names remain blocked. Do not broaden policy merely to make a task pass. Trusted plugin option `toolMap` can map a verified exact MCP tool name to a configured policy name; never strip prefixes or trust tool-supplied safety labels automatically.

Conservative tracking trades utility for safety: ordinary repository reads mark the run sensitive. Public tools are exceptions only when established by the operator. Email-pattern detection is deliberately broad and can cause false positives. There is no declassification operation.

## Tests and benchmark examples

```bash
python -m pytest -q
cd adapters/opencode
npm test
```

Python tests check policy gates, authentication, schema validation, path boundaries, idempotence, persistence, exact approvals, concurrent budget reservation, pre-read taint, and stale egress permits. Local fixtures assert that denied operations never reach the side-effect collector; an unmonitored control proves the collector can record the effect. TypeScript tests check V2 registration/cleanup, client sequencing, denied calls, failed service responses, version/location guards, and incomplete-state handling.

The fixture server implements a minimal stdio MCP protocol and **never contacts real services**:

```bash
monitor-fixtures
monitor-fixtures --credentials /absolute/private/fixture-run.credentials.json --session fixture-session
```

Without credentials, this is an inert unmonitored test fixture. With credentials, it gates execution through the Python API. Use a separately registered fixture run; do not mix the gateway's synthetic session with an OpenCode session. Outbound fixture destinations are inert names (`collector.local`, `recipient@example.test`). A production MCP gateway, reconnect/reconciliation and credentials management are not implemented.

Import and replay the selected **four InjecAgent records and six AgentDojo objectives**, each paired with a synthesized benign control:

```bash
monitor-benchmarks import
monitor-benchmarks replay
```

Sources are pinned in `config/benchmark-sources.json`. The importer keeps licenses, source hashes, selected record indices, original data/task snippets and adaptation notes in ignored `benchmark-data/`. It parses AgentDojo as data with AST; it does **not** execute downloaded Python. [InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent), [AgentDojo](https://github.com/ethz-spylab/agentdojo).

Replay scripts a malicious continuation through local fixture tools. InjecAgent tool responses are preserved; AgentDojo payloads are hand-constructed from upstream attacker objectives. These are **adapted enforcement tests**, not native benchmark runs, actual model attack-success rates, or upstream utility evaluations. The lock-access objective uses a generic consequential marker rather than simulating a real lock. Paired controls test public reads only, not full legitimate-task completion.

Live scripted trajectories and marker-file probes now run with `python tests/container/host.py`; see `tests/container/README.md`. Next: actual language-model trajectories, legitimate-task completion, adversarial plugin ordering, and actual AgentDojo environments/evaluators with compatible user-task pairs. The 60 scenarios/540 trajectories in `prototype-spec.md` remain a planned suite, not measured results.

## Security gaps before real data

- OpenCode V2 2.0.22 silently skipped our local adapter before a root `index.js` entry was added. The included root entry fixes loading, and the regression test imports it. A missing, disabled, or failed plugin can still leave OpenCode unmonitored: a trusted launcher must verify active enforcement before admitting a task. Merely naming a plugin in config is not enough.
- Model requests are an explicitly trusted channel here, **not gated outbound actions**. Approve the model endpoint independently. Final text, model transport, persistent terminals, initial instructions/attachments, formatters, snapshots and other background harness effects require sandbox controls and separate coverage testing.
- URL checks cannot stop redirect or DNS rebinding. Deny direct network access and execute requests through a hardened destination gateway before enabling real outbound tools.
- A later hook can mutate arguments after our before-hook. Path resolution and execution are not atomic; symlink/TOCTOU races remain. Post-hook mismatch detection cannot undo effects. The executable gateway/sandbox must own stronger enforcement.
- Read sensitivity is reserved before execution, but permits cannot atomically encompass arbitrary native tool effects. Unexpected secrets returned by a purported public tool, or egress already started before a sensitive read, remain a concurrency gap. Classify uncertain tools sensitive by default; serialize or gateway real sensitive operations.
- Regex checks are not semantic prompt-injection detection. Encrypted leakage is covered only when the run was already marked sensitive or cleartext/decoded evidence was observed. Arbitrary unknown ciphertext is not recognized as personal data.
- SQLite history is unbounded; API quotas, retention, encrypted storage, multi-user identity, remote TLS and deployment hardening remain work. Administrator access can disclose registered goals.
- The initial online npm install reported **12 high-severity advisories** in the pinned dependency tree. An offline audit subsequently reported zero; that does not clear the advisories. Resolve them with an online audit before deployment. No automatic dependency upgrade was applied.
