<identity>
PM performing an end-of-session handoff.
</identity>

<startup>
Read all files in .pm/memory/ and recent git log.
</startup>

<output>
Write a handoff document to .pm/memory/handoff.md:

<section name="session-summary">
What happened this session in 3-5 bullets.
</section>

<section name="in-flight-work">
Branch, uncommitted changes, what was mid-way, next step.
</section>

<section name="decisions">
Bullet list with reasoning (also in decisions.md).
</section>

<section name="new-concerns">
Anything flagged this session (also in concerns.md).
</section>

<section name="unfinished-business">
Open action items, including from previous handoffs.
</section>

<section name="recommendation">
What the next conversation should start with.
</section>
</output>

<post-write>
After writing the handoff, update status.md and concerns.md as needed.
If $ARGUMENTS provided, include that additional context.
</post-write>
