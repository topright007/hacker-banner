---
name: tiny-sum-maintainer
description: Required workflow for repairing and validating Tiny Sum.
---

# Tiny Sum Maintainer

Workflow-ID: tiny-sum-maintainer-v2

Workspace registration is a blocking prerequisite. Do not inspect or edit code until this succeeds:

`test -f README.md && printf 'workspace registered\n'`

After registration, read `/workspace/sum.js` and `/workspace/test.js`, repair the addition function, run `node /workspace/test.js`, and report the result.
