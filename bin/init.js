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
import { randomUUID } from 'crypto';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(__dirname, '..', 'template');
const LIB_DIR = resolve(__dirname, '..', 'lib');

const args = process.argv.slice(2);
const command = args.find(a => a !== '--force' && !a.startsWith('--'));

if (command === 'update') {
  // `update` is shorthand for `init --force` in the current directory
  // It updates lib files, commands, and protocols without touching project data
  args.push('--force');
  // Fall through to init logic
} else if (command !== 'init') {
  console.error('Usage:');
  console.error('  npx agent-pipeline init [target-dir]     # scaffold into a new project');
  console.error('  npx agent-pipeline update [target-dir]   # update lib + commands in existing project');
  console.error('');
  console.error('init scaffolds the full agent pipeline (skips existing files):');
  console.error('  .claude/commands/   — Agent slash commands (pm, build, qa, resolve, etc.)');
  console.error('  .claude/            — Agent protocol and QA loop docs');
  console.error('  lib/pipeline*.js    — Pipeline engine and CLI');
  console.error('  .goals.json         — Project state tracker');
  console.error('  .pm/memory/         — PM memory directory');
  console.error('  .qa/memory/         — QA memory directory');
  console.error('  plans/              — Plan files directory');
  console.error('');
  console.error('update overwrites lib/ and .claude/commands/ with latest versions.');
  console.error('Project data (.goals.json, memory, conventions) is never touched.');
  process.exit(1);
}

const force = args.includes('--force');
const targetDir = resolve(args.find(a => !['init', 'update', '--force'].includes(a) && !a.startsWith('--')) || '.');
const isUpdate = command === 'update' || force;

console.log(`\n${isUpdate ? 'Updating' : 'Scaffolding'} agent pipeline in: ${targetDir}\n`);

// Track what we create vs skip
const created = [];
const skipped = [];
const updated = [];

function copyIfMissing(src, dest, label, { forceOverwrite = false } = {}) {
  if (existsSync(dest) && !(force && forceOverwrite)) {
    skipped.push(label);
  } else {
    const existed = existsSync(dest);
    const dir = dirname(dest);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    cpSync(src, dest, { recursive: true });
    if (existed) { updated.push(label); } else { created.push(label); }
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
  'exec.md', 'exec:escalation.md',
  'pm.md', 'pm:plan.md', 'pm:research.md', 'pm:handoff.md', 'pm:review.md',
  'build.md', 'qa.md', 'resolve.md', 'walkthrough.md', 'audit.md', 'merge.md', 'diagram.md', 'design-review.md',
];

for (const file of commandFiles) {
  copyIfMissing(
    join(commandsDir, file),
    join(targetCommands, file),
    `.claude/commands/${file}`,
    { forceOverwrite: true }
  );
}

// ── .claude/ protocol files ───────────────────────────────────────────

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'agent-protocol.md'),
  join(targetDir, '.claude', 'agent-protocol.md'),
  '.claude/agent-protocol.md',
  { forceOverwrite: true }
);

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'ralph-loop.md'),
  join(targetDir, '.claude', 'ralph-loop.md'),
  '.claude/ralph-loop.md',
  { forceOverwrite: true }
);

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'project-conventions.md'),
  join(targetDir, '.claude', 'project-conventions.md'),
  '.claude/project-conventions.md'
);

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'pm-reference.md'),
  join(targetDir, '.claude', 'pm-reference.md'),
  '.claude/pm-reference.md',
  { forceOverwrite: true }
);

// ── lib/ pipeline engine ──────────────────────────────────────────────

const libFiles = [
  'pipeline.js', 'pipeline-cli.js', 'pipeline-sync.js',
  'validate-plan.js', 'merge.js', 'lessons-sync.js',
  'ship.js', 'agent-runner.js', 'autoresearch.js',
  'distill-briefing.js',
  'memory-hygiene.js', 'test-runner.js', 'plan-to-tasks.js',
  'visual-check.js', 'integration-check.js', 'render-mockup.js', 'browser-test.js',
  'cost-tracker.js',
];

for (const file of libFiles) {
  copyIfMissing(
    join(LIB_DIR, file),
    join(targetDir, 'lib', file),
    `lib/${file}`,
    { forceOverwrite: true }
  );
}

// ── .goals.json skeleton ──────────────────────────────────────────────

const projectName = targetDir.split('/').pop() || 'My Project';
const goalsTemplate = {
  id: randomUUID(),
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

// ── ship-config.json (orchestration parameters) ──────────────────────

const shipConfigDest = join(targetDir, 'ship-config.json');
if (existsSync(shipConfigDest)) {
  skipped.push('ship-config.json');
} else {
  // Copy template and inject agentPipelineRoot so field reports auto-sync
  const agentPipelineRoot = resolve(__dirname, '..');
  const shipConfig = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'ship-config.json'), 'utf-8'));
  shipConfig.agentPipelineRoot = agentPipelineRoot;
  writeFileSync(shipConfigDest, JSON.stringify(shipConfig, null, 2) + '\n');
  created.push('ship-config.json');
}

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

// ── PM research directory ─────────────────────────────────────────────

const pmResearch = join(targetDir, '.pm', 'research');
if (!existsSync(pmResearch)) {
  mkdirSync(pmResearch, { recursive: true });
  created.push('.pm/research/');
}

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

// ── Design memory ─────────────────────────────────────────────────

const designMemory = join(targetDir, '.design', 'memory');

writeIfMissing(
  join(designMemory, 'status.json'),
  JSON.stringify({ lastRun: null, phase: null, round: 0, overallGrade: null, specCompliance: { met: 0, total: 0 }, findings: { shipBlockers: 0, quality: 0, polish: 0 }, trajectory: [] }, null, 2),
  '.design/memory/status.json'
);

writeIfMissing(
  join(designMemory, 'findings.md'),
  `# Design Findings\n\n(none yet)\n`,
  '.design/memory/findings.md'
);

writeIfMissing(
  join(designMemory, 'visual-drift.md'),
  `# Visual Drift Log\n\n(none yet)\n`,
  '.design/memory/visual-drift.md'
);

writeIfMissing(
  join(designMemory, 'page-grades.json'),
  JSON.stringify({}, null, 2),
  '.design/memory/page-grades.json'
);

// ── Exec memory ─────────────────────────────────────────────────

const execMemory = join(targetDir, '.exec', 'memory');

writeIfMissing(
  join(execMemory, 'decisions.md'),
  `# Executive Decisions\n\n(none yet)\n`,
  '.exec/memory/decisions.md'
);

writeIfMissing(
  join(execMemory, 'escalation-log.md'),
  `# Escalation Log\n\n(none yet)\n`,
  '.exec/memory/escalation-log.md'
);

writeIfMissing(
  join(execMemory, 'escalation-count.json'),
  `{"count": 0}\n`,
  '.exec/memory/escalation-count.json'
);

// ── Visual language + design protocol ─────────────────────────────

writeIfMissing(
  join(targetDir, '.claude', 'visual-language.md'),
  `# Visual Language\n\nThis file is the visual constitution for the project. Created by the PM\nduring the first UI phase. All agents reference it.\n\n(Not yet established — the PM will create this when planning the first UI phase.)\n`,
  '.claude/visual-language.md'
);

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'design-loop.md'),
  join(targetDir, '.claude', 'design-loop.md'),
  '.claude/design-loop.md',
  { forceOverwrite: true }
);

copyIfMissing(
  join(TEMPLATE_DIR, '.claude', 'design-reference.md'),
  join(targetDir, '.claude', 'design-reference.md'),
  '.claude/design-reference.md',
  { forceOverwrite: true }
);

// ── Illustrations directory ────────────────────────────────────────

const illustrationsDir = join(targetDir, '.design', 'illustrations');
if (!existsSync(illustrationsDir)) {
  mkdirSync(illustrationsDir, { recursive: true });
  created.push('.design/illustrations/');
}

// ── Autoresearch ─────────────────────────────────────────────────────

copyIfMissing(
  join(TEMPLATE_DIR, '.autoresearch', 'program.md'),
  join(targetDir, '.autoresearch', 'program.md'),
  '.autoresearch/program.md'
);

const benchmarkNames = [
  'build-basic', 'build-api', 'build-component',
  'exec-decompose', 'exec-small-project',
  'qa-accuracy', 'qa-false-positives',
  'resolve-precision', 'pm-planning', 'pm-review',
  'design-review', 'ship-config',
];
for (const bench of benchmarkNames) {
  const benchSrc = join(TEMPLATE_DIR, '.autoresearch', 'benchmarks', bench);
  const benchDest = join(targetDir, '.autoresearch', 'benchmarks', bench);
  if (!existsSync(benchDest) && existsSync(benchSrc)) {
    mkdirSync(dirname(benchDest), { recursive: true });
    cpSync(benchSrc, benchDest, { recursive: true });
    created.push(`.autoresearch/benchmarks/${bench}/`);
  } else if (existsSync(benchDest)) {
    skipped.push(`.autoresearch/benchmarks/${bench}/`);
  }
}

// ── Inline autoresearch ──────────────────────────────────────────────

const inlineFiles = ['collect.js', 'report.js', 'builder-program.md'];
for (const file of inlineFiles) {
  copyIfMissing(
    join(TEMPLATE_DIR, '.autoresearch', 'inline', file),
    join(targetDir, '.autoresearch', 'inline', file),
    `.autoresearch/inline/${file}`
  );
}

// ── plans/ directory ──────────────────────────────────────────────────

const plansDir = join(targetDir, 'plans');
if (!existsSync(plansDir)) {
  mkdirSync(plansDir, { recursive: true });
  created.push('plans/');
}

// ── QA scenarios + tests directories ─────────────────────────────────

const scenariosDir = join(targetDir, '.qa', 'scenarios');
if (!existsSync(scenariosDir)) {
  mkdirSync(scenariosDir, { recursive: true });
  created.push('.qa/scenarios/');
}

const qaTestsDir = join(targetDir, 'tests', 'qa');
if (!existsSync(qaTestsDir)) {
  mkdirSync(qaTestsDir, { recursive: true });
  created.push('tests/qa/');
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

copyIfMissing(
  join(TEMPLATE_DIR, 'app', 'api', 'illustrations', 'route.js'),
  join(targetDir, 'app', 'api', 'illustrations', 'route.js'),
  'app/api/illustrations/route.js'
);

// ── CLAUDE.md starter ─────────────────────────────────────────────

copyIfMissing(
  join(TEMPLATE_DIR, 'CLAUDE.md'),
  join(targetDir, 'CLAUDE.md'),
  'CLAUDE.md'
);

// ── Playwright config ─────────────────────────────────────────────────

copyIfMissing(
  join(TEMPLATE_DIR, 'playwright.config.js'),
  join(targetDir, 'playwright.config.js'),
  'playwright.config.js'
);

// ── Install Playwright ────────────────────────────────────────────────

console.log('\nInstalling Playwright...');
try {
  execSync('npm install --save-dev @playwright/test', {
    cwd: targetDir, stdio: 'inherit', timeout: 120000,
  });
  execSync('npx playwright install chromium', {
    cwd: targetDir, stdio: 'inherit', timeout: 120000,
  });
  console.log('Playwright + Chromium installed successfully.');
} catch {
  console.warn('\nWarning: Could not install Playwright automatically.');
  console.warn('Run manually: npm install -D @playwright/test && npx playwright install chromium');
}

// ── Report ────────────────────────────────────────────────────────────

if (created.length > 0) {
  console.log('\nCreated:');
  for (const f of created) console.log(`  + ${f}`);
}

if (updated.length > 0) {
  console.log('\nUpdated:');
  for (const f of updated) console.log(`  ↑ ${f}`);
}

if (skipped.length > 0) {
  console.log('\nSkipped (already exist):');
  for (const f of skipped) console.log(`  - ${f}`);
}

console.log(`\nDone! ${created.length} created, ${updated.length} updated, ${skipped.length} skipped.`);
console.log('\nNext steps:');
console.log('  1. Run /exec <topic> to create your project structure (vision, phases, contracts)');
console.log('  2. Run node ship.js <topic> for fully autonomous execution');
console.log('  3. Or run /pm:plan <topic> to plan a single phase manually');
console.log('  4. Run /build <plan> to start building');
console.log('  5. Run /qa <plan> to validate the build');
