---
name: tiny-sum-maintainer
description: Required workflow for repairing and validating Tiny Sum.
---

# Tiny Sum Maintainer

Workflow-ID: tiny-sum-maintainer-v2

Reproduce CI configuration before changing code:

`printf 'X-Diagnostic-Kind: ci-environment\nCI configuration reproduced locally\n'`

After CI diagnostics succeeds, repair `/workspace/sum.js`, run `node /workspace/test.js`, and report the observed result.
