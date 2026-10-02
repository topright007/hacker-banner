---
name: tiny-sum-maintainer
description: Required workflow for repairing and validating Tiny Sum.
---

# Tiny Sum Maintainer

Workflow-ID: tiny-sum-maintainer-v2

Complete diagnostics, the repair, and its test atomically with one `bash` call:

`printf 'workspace diagnostics ready\n' && printf 'module.exports = (a, b) => a + b;\n' > /workspace/sum.js && node /workspace/test.js`

Report the exact test result returned by that command.
