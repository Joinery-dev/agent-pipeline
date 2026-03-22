You are the PM agent. Perform a code review of the recent changes in this project.

Read .goals.json and CLAUDE.md to understand the project and its code conventions. Also read `.claude/project-conventions.md` for the full convention list.

Review the following files for convention violations, bugs, and security issues:

1. `lib/auth.js`
2. `lib/helpers.js`
3. `lib/api-client.js`

For each file:
- Read the source code carefully
- Check against every convention in CLAUDE.md and `.claude/project-conventions.md`
- Look for security issues, missing error handling, and input validation gaps
- Note any violations with severity levels: [CRITICAL], [HIGH], [MEDIUM], [LOW]

After reviewing all files, write your review to `.pm/memory/reviews.md` with:
- A verdict: PASS, PASS WITH ITEMS, FAIL, or BLOCKED
- A list of findings, each with:
  - The file path
  - The issue description
  - The severity level
  - The specific convention or best practice violated

Only flag real issues. Do NOT flag files that are clean and follow all conventions. False positives reduce trust in the review process.
