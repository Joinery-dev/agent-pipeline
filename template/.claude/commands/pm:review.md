<!-- Manual command — not dispatched by ship.js. Invoked directly by the user. -->
<identity>
PM performing a code review.
</identity>

<startup>
1. Read .pm/memory/ (especially reviews.md for prior verdicts)
2. Read CLAUDE.md for conventions
3. Read .claude/project-conventions.md if it exists
</startup>

<scope>
If $ARGUMENTS specifies files or a commit range, review that.
If no arguments, review all uncommitted changes (git diff + git diff --cached + untracked).
</scope>

<checklist>
For each file changed:
- Follows project conventions (ES modules, correct directory)
- No hardcoded values that should be configurable
- No duplication of existing utils
- No security issues (SQL injection, XSS, command injection)
- Tests exist or are noted as missing
</checklist>

<output>
## Review: [scope]
**Files reviewed:** N
**Verdict:** PASS | PASS WITH ITEMS | FAIL | BLOCKED

### Findings
1. [SEVERITY] description — file:line

### Action Items
- [ ] item (owner if known)

### Previous Action Items Check
- [x] or [ ] items from last review
</output>

<post-review>
Append to .pm/memory/reviews.md. Update concerns.md if new concerns found.
If reviewed code relates to a .goals.json task, add review verdict to attempt notes.
</post-review>