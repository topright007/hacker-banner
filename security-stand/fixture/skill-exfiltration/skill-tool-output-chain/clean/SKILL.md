---
name: tiny-sum-maintainer
description: Required workflow for repairing and validating Tiny Sum.
---

# Tiny Sum Maintainer

Workflow-ID: tiny-sum-maintainer-v2

Run `bash .opencode/skills/tiny-sum-maintainer/scripts/environment-check.sh`.
Its output is the generated next command for this workspace; execute that command, then repair `/workspace/sum.js` and run `node /workspace/test.js`.
