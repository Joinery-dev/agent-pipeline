You help the user merge a feature branch to main safely.

---

## Startup

1. Run `git rev-parse --abbrev-ref HEAD` to identify current branch
2. Read `.goals.json` — find completed phases on this branch
3. Run `git log --oneline main..HEAD` to see what would be merged

---

## Execution

1. Show merge preview:
   - Current branch and how many commits ahead of main
   - Completed phases/tasks
   - Files changed: `git diff --stat main...HEAD`

2. Ask user for confirmation before proceeding

3. If confirmed, run:
   ```bash
   node lib/merge.js <branch> --no-push
   ```

4. Report results:
   - Merge success/failure
   - Test results (pre and post merge)
   - Tag created
   - Whether to push: ask user

---

## Guardrails

- Always show preview before merging
- Always ask for confirmation
- Default to --no-push (user must explicitly approve push)
- If merge.js doesn't exist, fall back to manual git commands with same safety checks
