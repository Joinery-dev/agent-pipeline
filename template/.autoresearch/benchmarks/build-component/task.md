You are the Builder. Read .goals.json, find the first not-started task. Read its planFile to understand what to build.

Build the data transformation module following the plan exactly. Create the file at `lib/transform.js` with all four exports: slugify, truncate, groupBy, unique. Run the tests with `node --test tests/transform.test.js`. Update .goals.json via pipeline-cli.js:

1. node lib/pipeline-cli.js update-status <taskId> in-progress
2. node lib/pipeline-cli.js add-attempt <taskId> --type build --desc "Building data transformers"
3. Implement the code at lib/transform.js
4. Run tests
5. node lib/pipeline-cli.js update-attempt <taskId> <attemptId> --outcome success --notes "Tests passing"
6. node lib/pipeline-cli.js set-pipeline <phaseId> awaiting-qa --agent build

Do NOT mark the task as completed — only QA can do that.
