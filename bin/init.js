#!/usr/bin/env node

/**
 * agent-pipeline init — Scaffold the agent pipeline into a project.
 *
 * Usage:
 *   npx agent-pipeline init          # scaffold into current directory
 *   npx agent-pipeline init ./myapp  # scaffold into specific directory
 */

import { cpSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, '..', 'template');
const LIB_DIR = resolve(__dirname, '..', 'lib');

const args = process.argv.slice(2);
const command = args[0];

if (command !== 'init') {
  console.error('Usage: npx agent-pipeline init [target-dir]');
  console.error('');
  console.error('Scaffolds the agent pipeline into your project:');
  console.error('  .claude/commands/   — Agent slash commands (pm, build, qa, resolve, etc.)');
  console.error('  .claude/            — Agent protocol and QA loop docs');
  console.error('  lib/pipeline*.js    — Pipeline engine and CLI');
  console.error('  .goals.json         — Project state tracker');
  console.error('  .pm/memory/         — PM memory directory');
  console.error('  .qa/memory/         — QA memory directory');
  console.error('  plans/              — Plan files directory');
  process.exit(1);
}

const targetDir = resolve(args[1] || '.');

console.log(`\nScaffolding agent pipeline into: ${targetDir}\n`);

// Track what we create vs skip
const created = [];
const skipped = [];

function copyIfMissing(src, dest, label) {
  if (existsSync(dest)) {
    skipped.push(label);
  } else {
    const dir = dirname(dest);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    cpSync(src, dest, { recursive: true });
    created.push(label);
  }
}

function writeIfMissing(dest, content, label) {
  if (existsSync(dest)) {
    skipped.push(label);
  } else {
    const dir = dirname(dest);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(dest, content);
    created.push(label);
  }
}

// ── .claude/commands/ ─────────────────────────────────────────────────

const commandsDir = join(TEMPLATE_DIR, '.claude', 'commands');
const targetCommands = join(targetDir, '.claude', 'commands');

const commandFiles = [
  'pm.md', 'pm:plan.md', 'pm:handoff.md', 'pm:review.md',
  'build.md', 'qa.md', 'resolve.md', 'debug.md', 'merge.md', 'diagram.md',
];

for (const file of commandFiles) {
  copyIfMissing(
    join(commandsDir, file),
    join(targetCommands, file),
    `.claude/commands/${file}`
  );
}

// ── .claude/ protocol files ───────────────────────────────────────────

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'agent-protocol.md'),
  join(targetDir, '.claude', 'agent-protocol.md'),
  '.claude/agent-protocol.md'
);

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'ralph-loop.md'),
  join(targetDir, '.claude', 'ralph-loop.md'),
  '.claude/ralph-loop.md'
);

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'project-conventions.md'),
  join(targetDir, '.claude', 'project-conventions.md'),
  '.claude/project-conventions.md'
);

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'pm-reference.md'),
  join(targetDir, '.claude', 'pm-reference.md'),
  '.claude/pm-reference.md'
);

// ── lib/ pipeline engine ──────────────────────────────────────────────

const libFiles = [
  'pipeline.js', 'pipeline-cli.js', 'pipeline-sync.js',
  'validate-plan.js', 'merge.js', 'lessons-sync.js',
  'ship.js', 'distill-briefing.js', 'cost-tracker.js',
  'memory-hygiene.js', 'test-runner.js', 'plan-to-tasks.js',
];

for (const file of libFiles) {
  copyIfMissing(
    join(LIB_DIR, file),
    join(targetDir, 'lib', file),
    `lib/${file}`
  );
}

// ── .goals.json skeleton ──────────────────────────────────────────────

const projectName = targetDir.split('/').pop() || 'My Project';
const goalsTemplate = {
  id: crypto.randomUUID(),
  name: projectName,
  description: '',
  vision: '',
  majorPhases: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

writeIfMissing(
  join(targetDir, '.goals.json'),
  JSON.stringify(goalsTemplate, null, 2),
  '.goals.json'
);

// ── Memory directories ────────────────────────────────────────────────

const pmMemory = join(targetDir, '.pm', 'memory');
const qaMemory = join(targetDir, '.qa', 'memory');

writeIfMissing(
  join(pmMemory, 'status.md'),
  `# PM Status\n\n**Last review:** (none yet)\n**Pipeline state:** idle\n`,
  '.pm/memory/status.md'
);

writeIfMissing(
  join(pmMemory, 'decisions.md'),
  `# Architectural Decisions\n\n(none yet)\n`,
  '.pm/memory/decisions.md'
);

writeIfMissing(
  join(pmMemory, 'concerns.md'),
  `# Active Concerns\n\n(none yet)\n`,
  '.pm/memory/concerns.md'
);

writeIfMissing(
  join(pmMemory, 'reviews.md'),
  `# Review Log\n\n(none yet)\n`,
  '.pm/memory/reviews.md'
);

writeIfMissing(
  join(qaMemory, 'status.json'),
  JSON.stringify({ lastRun: null, plan: null, round: 0, verdict: null, checksTotal: 0, checksPassing: 0, criteria: [], forestWarnings: [], trajectory: [] }, null, 2),
  '.qa/memory/status.json'
);

writeIfMissing(
  join(qaMemory, 'regressions.md'),
  `# Regression Watch List\n\n(none yet)\n`,
  '.qa/memory/regressions.md'
);

writeIfMissing(
  join(qaMemory, 'patterns.md'),
  `# QA Patterns\n\n(none yet)\n`,
  '.qa/memory/patterns.md'
);

writeIfMissing(
  join(qaMemory, 'learnings.txt'),
  `# QA Learnings\n\n(none yet)\n`,
  '.qa/memory/learnings.txt'
);

// ── plans/ directory ──────────────────────────────────────────────────

const plansDir = join(targetDir, 'plans');
if (!existsSync(plansDir)) {
  mkdirSync(plansDir, { recursive: true });
  created.push('plans/');
}

// ── Diagram viewer (React Flow) ───────────────────────────────────

const vizFiles = ['page.js', 'TurboEdge.js', 'visualize.module.css'];
for (const file of vizFiles) {
  copyIfMissing(
    join(TEMPLATE_DIR, 'app', 'visualize', file),
    join(targetDir, 'app', 'visualize', file),
    `app/visualize/${file}`
  );
}

copyIfMissing(
  join(TEMPLATE_DIR, 'app', 'api', 'diagrams', 'route.js'),
  join(targetDir, 'app', 'api', 'diagrams', 'route.js'),
  'app/api/diagrams/route.js'
);

// ── CLAUDE.md starter ─────────────────────────────────────────────

writeIfMissing(
  join(targetDir, 'CLAUDE.md'),
  `# ${projectName}

## Commands

- \`npm run dev\` — dev server
- \`node --test tests/\` — unit tests

## Code Conventions

- ES modules only — no CommonJS
- Server code in \`lib/\`, routes in \`app/api/\`, UI in \`app/\`, tests in \`tests/\`

## Git Protocols

- Commit to feature branches, not main
- Never force push
- Pull before push

## Agent Pipeline

This project uses the agent pipeline for structured development:
- \`/pm\` — project status and planning
- \`/pm:plan <topic>\` — create plans with goals tracking
- \`/build <plan>\` — execute plans
- \`/qa <plan>\` — validate builds
- \`/resolve\` — fix QA failures
- \`/debug\` — diagnose pipeline issues

See \`.claude/agent-protocol.md\` for the full schema and conventions.

## Do's and Don'ts

- DO ask before committing, pushing, or writing files when the user only asked a question
- DO distinguish questions from instructions
- DON'T hardcode values that should be configurable
- DON'T create files unless necessary — edit existing ones
`,
  'CLAUDE.md'
);

// ── Report ────────────────────────────────────────────────────────────

console.log('Created:');
for (const f of created) console.log(`  + ${f}`);

if (skipped.length > 0) {
  console.log('\nSkipped (already exist):');
  for (const f of skipped) console.log(`  - ${f}`);
}

console.log(`\nDone! ${created.length} files created, ${skipped.length} skipped.`);
console.log('\nNext steps:');
console.log('  1. Add your project details to .goals.json (name, description, vision)');
console.log('  2. Run /pm to see your project status');
console.log('  3. Run /pm:plan <topic> to create your first plan');
console.log('  4. Run /build <plan> to start building');
console.log('  5. Run /qa <plan> to validate the build');
