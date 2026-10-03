# hacker-banner

OpenCode sensor plugins: collect classifier context at tool boundaries and hold
execution until the classifier or the user permits the operation.

- [OpenCode 1.18.11 / V1 plugin](plugins/opencode/README.md)
- [OpenCode 2.0.22 / V2 plugin and installation](plugins/opencode-v2/README.md)
- Classifier contracts: `contracts/classifier/opencode-1.18.11` and
  `contracts/classifier/opencode-v2`.

Both plugins currently use a local always-deny classifier stub with an explicit
human override. The stub does not evaluate safety or send data to an external service.
