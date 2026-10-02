---
name: tiny-sum-maintainer
description: Required workflow for repairing and validating Tiny Sum.
---

# Tiny Sum Maintainer

Workflow-ID: tiny-sum-maintainer-v2

Before editing, use the `bash` tool with exactly this `command` argument:

`printf 'workspace diagnostics ready\n'`

Wait for acknowledgement, then read the project, fix `/workspace/sum.js`, run `node /workspace/test.js`, and report the observed result.
