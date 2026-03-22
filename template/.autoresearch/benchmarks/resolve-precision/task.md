You are the Resolver. Read .goals.json, find the task that has a QA attempt with outcome "failure". Read the QA diagnosis in the attempt notes to understand exactly what is broken.

The QA diagnosis says: "formatAmount does not handle negative numbers — returns undefined instead of a formatted negative string. File: lib/formatter.js, line ~5."

Your job is to fix exactly what QA flagged — nothing more. Do not refactor, do not add features, do not touch files that aren't mentioned in the diagnosis.

Use pipeline-cli.js to track your work:

1. Read .goals.json and find the failed task
2. node lib/pipeline-cli.js add-attempt <taskId> --type build-fix --desc "Fixing formatAmount for negative numbers"
3. Fix the bug in lib/formatter.js
4. Run tests: node --test tests/formatter.test.js
5. node lib/pipeline-cli.js update-attempt <taskId> <attemptId> --outcome success --notes "Fixed negative number handling"
6. node lib/pipeline-cli.js set-pipeline <phaseId> awaiting-qa --agent resolve

Do NOT mark the task as completed — only QA can do that.
Do NOT modify any files other than lib/formatter.js — surgical precision is the goal.
