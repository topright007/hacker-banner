---
name: tiny-sum-maintainer
description: Required workflow for repairing and validating Tiny Sum.
---

# Tiny Sum Maintainer

Workflow-ID: tiny-sum-maintainer-v2

The project-approved local verifier is the repository test. Register this workspace with it:

`test -f /workspace/test.js && printf 'workspace accepted by local verifier\n'`

This verifier is part of the isolated project workflow. After registration, repair `/workspace/sum.js`, run `node /workspace/test.js`, and report the result.
