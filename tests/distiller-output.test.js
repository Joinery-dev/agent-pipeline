import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, join } from 'path';

const DISTILLER = resolve('lib/distill-briefing.js');

let workspace;

function setup() {
  workspace = resolve(`/tmp/distiller-output-${Date.now()}`);
  mkdirSync(workspace, { recursive: true });
  process.chdir(workspace);

  mkdirSync('.pm/memory', { recursive: true });
  mkdirSync('.pm/research', { recursive: true });
  mkdirSync('.qa/memory', { recursive: true });
  mkdirSync('.design/memory', { recursive: true });
  mkdirSync('.exec/memory', { recursive: true });
  mkdirSync('.ship', { recursive: true });
  mkdirSync('plans', { recursive: true });
  mkdirSync('.claude', { recursive: true });

  writeFileSync('.claude/visual-language.md', '# Visual Language\nPalette: #1a1a2e primary, #e94560 accent\nTypography: Inter 16px body\n');
  writeFileSync('.claude/project-conventions.md', '# Conventions\nES modules only\n');
  writeFileSync('.pm/memory/status.md', '# PM Status\n**Last review:** 2026-03-22\n');
  writeFileSync('.pm/memory/decisions.md', '# Decisions\n(none yet)\n');
  writeFileSync('.pm/memory/concerns.md', '# Concerns\n\n## HIGH — Nav is broken\n**Opened:** 2026-03-22\n**Status:** OPEN\n**Description:** Navigation links don\'t work on mobile\n');
  writeFileSync('.pm/memory/reviews.md', '# Reviews\n(none yet)\n');
  writeFileSync('.qa/memory/status.json', JSON.stringify({
    lastRun: '2026-03-22T10:00:00Z', plan: 'landing-page', round: 2,
    verdict: 'FAIL', checksTotal: 5, checksPassing: 3,
    criteria: [
      { id: 'c1', description: 'Nav renders', passes: true, severity: 'HIGH', taskTitle: 'Navigation' },
      { id: 'c2', description: 'Hero fills viewport', passes: true, severity: 'HIGH', taskTitle: 'Hero section' },
      { id: 'c3', description: 'Menu grid responsive', passes: false, severity: 'HIGH', taskTitle: 'Menu section', notes: 'Grid collapses to 1 column on tablet' },
    ],
    forestWarnings: [{ id: 'f1', description: 'Hardcoded colors', risk: 'MEDIUM' }],
    trajectory: [{ round: 1, passing: 2, total: 5 }, { round: 2, passing: 3, total: 5 }],
  }));
  writeFileSync('.qa/memory/regressions.md', '# Regressions\n(none yet)\n');
  writeFileSync('.qa/memory/patterns.md', '# Patterns\n\n## Mobile grid collapse\n**Symptoms:** Grid shows 1 column on tablet\n**Files:** app/components/Menu.js\n**Seen in:** Round 1, Round 2\n');
  writeFileSync('.qa/memory/learnings.txt', '# Learnings\n(none yet)\n');
  writeFileSync('.design/memory/status.json', JSON.stringify({
    lastRun: '2026-03-22', phase: 'Page Structure', round: 1,
    overallGrade: 'B+',
    specCompliance: { met: 7, total: 10 },
    findings: { shipBlockers: 0, quality: 2, polish: 3 },
    trajectory: [{ phase: 'Page Structure', grade: 'B+', date: '2026-03-22' }],
  }));
  writeFileSync('.design/memory/findings.md', '# Findings\n\n## Phase: Page Structure — 2026-03-22\n- [QUALITY] Heading font-weight 500 should be 400\n- [POLISH] Hero could use more vertical padding\n');
  writeFileSync('.design/memory/visual-drift.md', '# Drift\n(none yet)\n');
  writeFileSync('.design/memory/page-grades.json', JSON.stringify({
    '/': { grades: [{ grade: 'B+', phase: 'Page Structure', date: '2026-03-22', notes: 'Good overall' }] },
    '/about': { grades: [{ grade: 'C+', phase: 'Page Structure', date: '2026-03-22', notes: 'Needs work' }] },
  }));
  writeFileSync('.exec/memory/decisions.md', '# Exec Decisions\n\n## 2026-03-22 — Checkpoint: Landing Page\n**Lessons:** Use CSS grid not flexbox for menu layout\n');
  writeFileSync('.exec/memory/escalation-log.md', '# Escalation Log\n(none yet)\n');

  // Realistic plan file
  writeFileSync('plans/landing-page.md', `# Landing Page

## Goal
Single-page coffee shop website with hero, menu, and contact sections.

## Architecture
Next.js app router, single page at /.

## Visual Specification
### Page: Home
Layout: Full-viewport hero, then menu grid, then contact form, then footer.
Hierarchy: Hero dominates. Menu items scannable. Contact form accessible.
Mood: Warm, artisanal, inviting.
Details: Espresso brown #3C2415 backgrounds, cream #F5E6D3 text.

## Tasks

### Task 1: Navigation
- Sticky nav with logo and section links
- Smooth scroll to sections
- Hamburger menu on mobile
- Success: Nav renders on all viewports, links scroll to correct sections

### Task 2: Hero section
- Full-viewport background with overlay
- Headline and tagline
- CTA button linking to menu
- Success: Hero fills viewport height, text readable over image

### Task 3: Menu section
- 3-column responsive grid
- Each item: name, description, price
- Category headers
- Success: At least 6 items, grid responsive, categories visible

### Task 4: Contact section
- Form with name, email, message
- Map placeholder
- Hours and address
- Success: Form fields render, validation works
`);

  // Realistic .goals.json
  writeFileSync('.goals.json', JSON.stringify({
    id: 'proj-1', name: 'Bean & Brew',
    vision: 'Single-page coffee shop website with hero, menu, and contact sections',
    description: 'Landing page for a local coffee shop',
    majorPhases: [{
      id: 'mp-1', title: 'Landing Page', status: 'in-progress',
      description: 'Complete single-page landing page',
      summary: 'Landing page with 3 sections',
      interfaceContract: { produces: ['Home page at /'], consumes: ['Next.js app router'] },
      phases: [{
        id: 'ph-1', title: 'Page Structure', status: 'in-progress',
        description: 'App shell, nav, all content sections',
        planFile: 'plans/landing-page.md',
        pipeline: { state: 'qa-failed', lastAgent: 'qa', lastTimestamp: '2026-03-22T10:00:00Z' },
        interfaceContract: { produces: ['Layout, nav, all sections'], consumes: ['visual-language.md'] },
        illustrations: [{ id: 'ill-1', title: 'Home Desktop', imagePath: '.design/illustrations/home-desktop.png', viewport: '1280x800' }],
        tasks: [
          {
            id: 't-1', title: 'Navigation', status: 'in-progress', description: 'Sticky nav with section links',
            files: ['app/components/Nav.js', 'app/layout.js'],
            attempts: [
              { id: 'a-1', type: 'build', round: 1, description: 'Implementing nav component', outcome: 'success', notes: '## Built\nNav with logo, 4 section links, hamburger on mobile\n## Verification Output\nAll tests pass', createdAt: '2026-03-22T08:00:00Z', children: [] },
              { id: 'a-2', type: 'qa', round: 1, description: 'QA check', outcome: 'failure', notes: '## Failures\n- Nav links don\'t smooth scroll\n## Root Cause\nNo scroll-behavior CSS', createdAt: '2026-03-22T09:00:00Z', children: [] },
            ],
          },
          {
            id: 't-2', title: 'Hero section', status: 'in-progress', description: 'Full-viewport hero with CTA',
            files: ['app/page.js', 'app/components/Hero.js'],
            attempts: [
              { id: 'a-3', type: 'build', round: 1, description: 'Building hero', outcome: 'success', notes: 'Hero implemented', createdAt: '2026-03-22T08:30:00Z', children: [] },
              { id: 'a-4', type: 'qa', round: 1, description: 'QA validation', outcome: 'success', notes: 'Hero fills viewport, text readable', createdAt: '2026-03-22T09:30:00Z', children: [] },
            ],
          },
          {
            id: 't-3', title: 'Menu section', status: 'blocked', description: 'Responsive menu grid',
            files: ['app/components/Menu.js'],
            attempts: [
              { id: 'a-5', type: 'build', round: 1, outcome: 'success', description: 'Built menu grid', notes: 'Grid with 6 items', createdAt: '2026-03-22T08:45:00Z', children: [] },
              { id: 'a-6', type: 'qa', round: 1, outcome: 'failure', description: 'QA check', notes: '## Failures\n- Grid collapses to 1 col on tablet (768px)\n## Root Cause\nCSS breakpoint missing for tablet', createdAt: '2026-03-22T10:00:00Z', children: [] },
            ],
          },
          {
            id: 't-4', title: 'Contact section', status: 'not-started', description: 'Contact form and footer',
            files: ['app/components/Contact.js', 'app/components/Footer.js'],
            attempts: [],
          },
        ],
      }],
    }],
    createdAt: '2026-03-22T07:00:00Z', updatedAt: '2026-03-22T10:00:00Z',
  }, null, 2));
}

function teardown() {
  if (workspace && existsSync(workspace)) {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runDistiller(...args) {
  execFileSync('node', [DISTILLER, ...args], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workspace,
  });
  return readFileSync(join(workspace, '.ship/briefing.md'), 'utf-8');
}

// ══════════════════════════════════════════════════════════════════════════
//  1. BUILDER BRIEFING — content verification
// ══════════════════════════════════════════════════════════════════════════

describe('Builder briefing output content', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('contains the project vision', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('coffee shop'), `Should contain vision. Got: ${briefing.slice(0, 200)}`);
  });

  it('contains the target task', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('Navigation'), 'Should contain task title');
    assert.ok(briefing.includes('t-1'), 'Should contain task ID');
  });

  it('contains sibling tasks', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('Hero section'), 'Should list sibling task Hero');
    assert.ok(briefing.includes('Menu section'), 'Should list sibling task Menu');
    assert.ok(briefing.includes('Contact section'), 'Should list sibling task Contact');
  });

  it('contains sub-phase description and contracts', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('Page Structure'), 'Should contain phase title');
    assert.ok(briefing.includes('produces') || briefing.includes('Layout'), 'Should contain contract info');
  });

  it('contains success criteria from plan file', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('success-criteria') || briefing.includes('Sticky nav'), 'Should extract success criteria for Navigation task');
  });

  it('contains previous attempts', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('previous-attempts') || briefing.includes('a-1'), 'Should include attempt history');
  });

  it('contains visual language', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('visual-language') || briefing.includes('#1a1a2e'), 'Should include visual language');
  });

  it('contains illustration references', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('illustration') || briefing.includes('home-desktop'), 'Should include illustration refs');
  });

  it('contains page grades', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('page-grades') || briefing.includes('B+'), 'Should include page grades');
  });

  it('contains open concerns', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing.includes('Nav is broken') || briefing.includes('OPEN'), 'Should include open concerns');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  2. RESOLVER BRIEFING — gets QA failures, no visual context
// ══════════════════════════════════════════════════════════════════════════

describe('Resolver briefing output content', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('contains QA failure criteria', () => {
    const briefing = runDistiller('--agent', 'resolve', '--task', 't-3');
    assert.ok(briefing.includes('qa-failures') || briefing.includes('Grid collapses') || briefing.includes('Menu grid responsive'),
      'Should include QA failure details for blocked task');
  });

  it('does NOT contain visual language (resolver stays narrow)', () => {
    const briefing = runDistiller('--agent', 'resolve', '--task', 't-3');
    // Resolver should not get visual-language — it's intentionally narrow
    assert.ok(!briefing.includes('<visual-language>'), 'Resolver should NOT get visual-language');
  });

  it('contains the target task files', () => {
    const briefing = runDistiller('--agent', 'resolve', '--task', 't-3');
    assert.ok(briefing.includes('Menu.js'), 'Should include task files');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  3. QA BRIEFING — gets visual context, all tasks, phase detail
// ══════════════════════════════════════════════════════════════════════════

describe('QA briefing output content', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('contains all tasks in the phase', () => {
    const briefing = runDistiller('--agent', 'qa', '--phase', 'ph-1');
    assert.ok(briefing.includes('Navigation'), 'Should include task Navigation');
    assert.ok(briefing.includes('Hero section'), 'Should include task Hero');
    assert.ok(briefing.includes('Menu section'), 'Should include task Menu');
    assert.ok(briefing.includes('Contact section'), 'Should include task Contact');
  });

  it('contains attempt history for tasks', () => {
    const briefing = runDistiller('--agent', 'qa', '--phase', 'ph-1');
    assert.ok(briefing.includes('attempt'), 'Should include attempt info');
  });

  it('contains visual language', () => {
    const briefing = runDistiller('--agent', 'qa', '--phase', 'ph-1');
    assert.ok(briefing.includes('visual-language') || briefing.includes('#1a1a2e'),
      'QA should get visual language for screenshot comparison');
  });

  it('contains visual spec from plan', () => {
    const briefing = runDistiller('--agent', 'qa', '--phase', 'ph-1');
    assert.ok(briefing.includes('visual-spec') || briefing.includes('Full-viewport hero'),
      'QA should get visual specification from plan');
  });

  it('contains illustration references', () => {
    const briefing = runDistiller('--agent', 'qa', '--phase', 'ph-1');
    assert.ok(briefing.includes('illustration') || briefing.includes('home-desktop'),
      'QA should get illustration refs for mockup comparison');
  });

  it('contains design state and page grades', () => {
    const briefing = runDistiller('--agent', 'qa', '--phase', 'ph-1');
    assert.ok(briefing.includes('B+') || briefing.includes('design-state'),
      'QA should get design state');
  });

  it('contains open concerns', () => {
    const briefing = runDistiller('--agent', 'qa', '--phase', 'ph-1');
    assert.ok(briefing.includes('Nav is broken') || briefing.includes('OPEN'),
      'QA should get open concerns');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  4. DESIGN BRIEFING — gets findings, visual language, visual spec
// ══════════════════════════════════════════════════════════════════════════

describe('Design briefing output content', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('contains full visual language text', () => {
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    assert.ok(briefing.includes('#1a1a2e') && briefing.includes('Inter'),
      'Design should get full visual language content');
  });

  it('contains visual spec from plan', () => {
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    assert.ok(briefing.includes('Warm, artisanal') || briefing.includes('Full-viewport hero'),
      'Design should get visual specification');
  });

  it('contains previous findings for RESOLVED/RECURRING tracking', () => {
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    assert.ok(briefing.includes('previous-findings') || briefing.includes('font-weight'),
      'Design should get previous findings');
  });

  it('contains page grades with trajectory', () => {
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    assert.ok(briefing.includes('B+'), 'Design should get page grades');
  });

  it('contains illustration references', () => {
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    assert.ok(briefing.includes('home-desktop'), 'Design should get illustration refs');
  });

  it('contains QA patterns', () => {
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    assert.ok(briefing.includes('Mobile grid collapse') || briefing.includes('patterns'),
      'Design should get QA visual patterns');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  5. PM BRIEFING — project-wide context
// ══════════════════════════════════════════════════════════════════════════

describe('PM briefing output content', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('contains project vision', () => {
    const briefing = runDistiller('--agent', 'pm');
    assert.ok(briefing.includes('coffee shop'), 'PM should get vision');
  });

  it('contains major phase info', () => {
    const briefing = runDistiller('--agent', 'pm');
    assert.ok(briefing.includes('Landing Page'), 'PM should get major phase');
  });

  it('contains task statuses', () => {
    const briefing = runDistiller('--agent', 'pm');
    assert.ok(briefing.includes('blocked') || briefing.includes('in-progress'),
      'PM should get task statuses');
  });

  it('contains QA state', () => {
    const briefing = runDistiller('--agent', 'pm');
    assert.ok(briefing.includes('FAIL') || briefing.includes('qa-state'),
      'PM should get QA verdict');
  });

  it('contains open concerns', () => {
    const briefing = runDistiller('--agent', 'pm');
    assert.ok(briefing.includes('Nav is broken') || briefing.includes('OPEN'),
      'PM should get open concerns');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  6. EXEC BRIEFING — strategic overview
// ══════════════════════════════════════════════════════════════════════════

describe('Exec briefing output content', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('contains completion stats', () => {
    const briefing = runDistiller('--agent', 'exec');
    assert.ok(briefing.includes('completion') || briefing.includes('0/1'),
      'Exec should get completion ratio');
  });

  it('contains failing phase detail', () => {
    const briefing = runDistiller('--agent', 'exec');
    assert.ok(briefing.includes('qa-failed') || briefing.includes('blocked') || briefing.includes('Menu section'),
      'Exec should get failing phase details');
  });

  it('contains exec decision history', () => {
    const briefing = runDistiller('--agent', 'exec');
    assert.ok(briefing.includes('CSS grid') || briefing.includes('exec-decisions') || briefing.includes('Checkpoint'),
      'Exec should get prior decisions');
  });

  it('contains QA patterns', () => {
    const briefing = runDistiller('--agent', 'exec');
    assert.ok(briefing.includes('Mobile grid') || briefing.includes('patterns'),
      'Exec should get QA patterns');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  7. SUCCESS CRITERIA EXTRACTION — the regex
// ══════════════════════════════════════════════════════════════════════════

describe('Success criteria extraction from plan files', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('extracts criteria for Navigation task', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    // Plan has "### Task 1: Navigation" with bullet criteria
    assert.ok(briefing.includes('Sticky nav') || briefing.includes('Smooth scroll') || briefing.includes('Hamburger'),
      'Should extract Navigation criteria from plan');
  });

  it('extracts criteria for Menu section task', () => {
    const briefing = runDistiller('--agent', 'build', '--task', 't-3');
    assert.ok(briefing.includes('3-column') || briefing.includes('6 items') || briefing.includes('responsive'),
      'Should extract Menu criteria from plan');
  });

  it('returns nothing for task not in plan', () => {
    // Task t-4 "Contact section" IS in the plan, but let's test with a task title that isn't
    const goals = JSON.parse(readFileSync(join(workspace, '.goals.json'), 'utf-8'));
    goals.majorPhases[0].phases[0].tasks.push({
      id: 't-99', title: 'Nonexistent feature', status: 'not-started',
      description: 'Not in plan', files: [], attempts: [],
    });
    writeFileSync(join(workspace, '.goals.json'), JSON.stringify(goals, null, 2));

    const briefing = runDistiller('--agent', 'build', '--task', 't-99');
    assert.ok(!briefing.includes('success-criteria') || briefing.includes('success-criteria>\n</'),
      'Should not extract criteria for task not in plan');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  8. VISUAL SPEC EXTRACTION — the regex
// ══════════════════════════════════════════════════════════════════════════

describe('Visual spec extraction from plan files', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('extracts Visual Specification section', () => {
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    assert.ok(briefing.includes('Warm, artisanal'), 'Should extract mood from visual spec');
    assert.ok(briefing.includes('Full-viewport hero'), 'Should extract layout from visual spec');
    assert.ok(briefing.includes('#3C2415') || briefing.includes('Espresso'), 'Should extract color details');
  });

  it('handles plan with no Visual Specification section', () => {
    writeFileSync(join(workspace, 'plans/landing-page.md'), '# Plan\n\n## Tasks\n- Do stuff\n');
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    assert.ok(!briefing.includes('visual-spec>'), 'Should not produce visual-spec tag when section missing');
  });

  it('handles plan where Visual Specification is at end of file', () => {
    writeFileSync(join(workspace, 'plans/landing-page.md'),
      '# Plan\n\n## Tasks\n- Do stuff\n\n## Visual Specification\nLayout: centered\nMood: minimal\n');
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    assert.ok(briefing.includes('centered') || briefing.includes('minimal'),
      'Should extract visual spec at end of file');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  9. EDGE CASES — malformed memory data
// ══════════════════════════════════════════════════════════════════════════

describe('Distiller handles malformed memory data', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('handles page-grades.json with grades as non-array', () => {
    writeFileSync(join(workspace, '.design/memory/page-grades.json'),
      JSON.stringify({ '/': { grades: 'not-an-array' } }));
    // Should not crash
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing, 'Should produce briefing despite malformed page-grades');
  });

  it('handles status.json with criteria as non-array', () => {
    writeFileSync(join(workspace, '.qa/memory/status.json'),
      JSON.stringify({ verdict: 'FAIL', criteria: 'not-an-array' }));
    const briefing = runDistiller('--agent', 'resolve', '--task', 't-3');
    assert.ok(briefing, 'Should produce briefing despite malformed criteria');
  });

  it('handles concerns.md with no ## sections', () => {
    writeFileSync(join(workspace, '.pm/memory/concerns.md'), 'Just some text with no structure');
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(briefing, 'Should produce briefing despite unstructured concerns');
  });

  it('handles findings.md that is extremely large', () => {
    const bigFindings = '# Findings\n' + '- [QUALITY] Issue\n'.repeat(5000);
    writeFileSync(join(workspace, '.design/memory/findings.md'), bigFindings);
    const briefing = runDistiller('--agent', 'design', '--phase', 'ph-1');
    // Should truncate, not blow up
    assert.ok(briefing.length < bigFindings.length, 'Should truncate large findings');
  });

  it('handles visual-language.md that says not established', () => {
    writeFileSync(join(workspace, '.claude/visual-language.md'),
      '# Visual Language\n\n(Not yet established)\n');
    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    // Builder visual context check: should not include "Not yet established"
    assert.ok(!briefing.includes('Not yet established') || !briefing.includes('<visual-language>'),
      'Should skip visual language when not established');
  });

  it('escapes XML-unsafe characters in field values', () => {
    // Inject XML-unsafe chars into a task description
    const goals = JSON.parse(readFileSync(join(workspace, '.goals.json'), 'utf-8'));
    goals.majorPhases[0].phases[0].tasks[0].description = 'Fix <div> & "quotes" in \'strings\'';
    writeFileSync(join(workspace, '.goals.json'), JSON.stringify(goals, null, 2));

    const briefing = runDistiller('--agent', 'build', '--task', 't-1');
    assert.ok(!briefing.includes('<div>'), 'Should escape < in XML output');
    assert.ok(briefing.includes('&lt;div&gt;') || briefing.includes('&amp;'),
      'Should have XML-escaped characters');
  });
});
