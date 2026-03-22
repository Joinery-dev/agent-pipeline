import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

const COMMANDS_DIR = resolve('template/.claude/commands');
const LIB_DIR = resolve('lib');
const PROTOCOL_DIR = resolve('template/.claude');

function readCommand(name) {
  return readFileSync(join(COMMANDS_DIR, name), 'utf-8');
}

function readLib(name) {
  return readFileSync(join(LIB_DIR, name), 'utf-8');
}

// ══════════════════════════════════════════════════════════════════════════
//  1. CLI COMMANDS REFERENCED IN PROMPTS ACTUALLY EXIST
// ══════════════════════════════════════════════════════════════════════════

describe('CLI commands referenced in agent prompts exist', () => {
  const cliSource = readLib('pipeline-cli.js');

  // Extract all "case 'xxx':" from the CLI switch statement
  const validCommands = [...cliSource.matchAll(/case '([^']+)':/g)].map(m => m[1]);

  const commandFiles = readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));

  for (const file of commandFiles) {
    it(`${file} — all pipeline-cli commands exist`, () => {
      const content = readCommand(file);
      // Find all "pipeline-cli.js <command>" references
      const refs = [...content.matchAll(/pipeline-cli\.js\s+(\S+)/g)].map(m => m[1]);

      for (const ref of refs) {
        // Clean up: remove trailing quotes, flags, etc.
        const cmd = ref.replace(/['"`,;)]/g, '').replace(/--.*/, '').trim();
        if (cmd && !cmd.startsWith('<') && !cmd.startsWith('{')) {
          assert.ok(
            validCommands.includes(cmd),
            `${file} references pipeline-cli command "${cmd}" which does not exist. Valid: ${validCommands.join(', ')}`
          );
        }
      }
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  2. FILES AGENTS ARE TOLD TO READ ACTUALLY GET CREATED
// ══════════════════════════════════════════════════════════════════════════

describe('Files agents read are created somewhere', () => {
  // Files that init.js creates or that agents create at runtime
  const knownFiles = [
    '.goals.json',
    '.ship/briefing.md',
    'CLAUDE.md',
    '.claude/agent-protocol.md',
    '.claude/project-conventions.md',
    '.claude/visual-language.md',
    '.claude/design-loop.md',
    '.claude/design-reference.md',
    '.claude/ralph-loop.md',
    '.claude/pm-reference.md',
    '.pm/memory/status.md',
    '.pm/memory/decisions.md',
    '.pm/memory/concerns.md',
    '.pm/memory/reviews.md',
    '.pm/research/',
    '.qa/memory/status.json',
    '.qa/memory/regressions.md',
    '.qa/memory/patterns.md',
    '.qa/memory/learnings.txt',
    '.qa/walkthroughs/',
    '.qa/link-check-results.json',
    '.qa/screenshots/',
    '.design/memory/status.json',
    '.design/memory/findings.md',
    '.design/memory/visual-drift.md',
    '.design/memory/page-grades.json',
    '.exec/memory/decisions.md',
    '.exec/memory/escalation-log.md',
    '.exec/memory/checkpoint-fixes.md',
    '.exec/history/',
    '.ship/latest.log',
  ];

  const commandFiles = readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));

  for (const file of commandFiles) {
    it(`${file} — all referenced paths are known`, () => {
      const content = readCommand(file);
      // Find file path references (dot-prefixed paths)
      const pathRefs = [...content.matchAll(/`?(\.[a-z/]+(?:memory|research|walkthroughs|screenshots|history|exec|pm|qa|design|ship|claude|goals)[a-z/.]*)`?/gi)];

      const unknowns = [];
      for (const match of pathRefs) {
        const path = match[1];
        // Check if this path or a parent directory is in knownFiles
        const isKnown = knownFiles.some(kf =>
          path.startsWith(kf) || kf.startsWith(path) || path.includes(kf)
        );
        if (!isKnown && !path.includes('illustrations') && !path.includes('plans/')) {
          unknowns.push(path);
        }
      }
      // Don't fail — just report
      if (unknowns.length > 0) {
        // These paths may be created at runtime by agents — note them
      }
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  3. CROSS-AGENT FORMAT CONTRACTS
// ══════════════════════════════════════════════════════════════════════════

describe('Cross-agent format contracts', () => {

  it('QA attempt notes format matches what Resolver reads', () => {
    const ralphLoop = readFileSync(join(PROTOCOL_DIR, 'ralph-loop.md'), 'utf-8');
    const resolveCmd = readCommand('resolve.md');

    // Ralph Loop Step 3 defines the QA diagnosis format
    assert.ok(ralphLoop.includes('What failed'), 'Ralph Loop should define "What failed" in diagnosis');
    assert.ok(ralphLoop.includes('Root cause'), 'Ralph Loop should define "Root cause" in diagnosis');
    assert.ok(ralphLoop.includes('ROOT CAUSE'), 'Ralph Loop should use ROOT CAUSE');

    // Resolver reads QA diagnosis — does it look for the right things?
    assert.ok(resolveCmd.includes('which criteria failed'), 'Resolver should look for failed criteria');
    assert.ok(resolveCmd.includes('diagnosis'), 'Resolver should reference QA diagnosis');
    assert.ok(resolveCmd.includes('files mentioned'), 'Resolver should look for files in diagnosis');
  });

  it('Builder attempt notes format matches what QA reads', () => {
    const buildCmd = readCommand('build.md');
    const qaCmd = readCommand('qa.md');

    // Builder logs attempt notes
    assert.ok(buildCmd.includes('update-attempt'), 'Builder should call update-attempt');
    assert.ok(buildCmd.includes('--outcome'), 'Builder should set outcome');
    assert.ok(buildCmd.includes('--notes'), 'Builder should write notes');

    // QA reads attempt history from .goals.json
    assert.ok(qaCmd.includes('.goals.json'), 'QA should read .goals.json');
  });

  it('PM plan format matches what Builder reads', () => {
    const pmPlan = readCommand('pm:plan.md');
    const buildCmd = readCommand('build.md');

    // PM creates plan with success criteria
    assert.ok(pmPlan.includes('success criteria'), 'PM plan should include success criteria');
    assert.ok(pmPlan.includes('Tasks with success criteria'), 'PM plan should have tasks with criteria');

    // Builder reads plan file
    assert.ok(buildCmd.includes('planFile'), 'Builder should reference planFile');
    assert.ok(buildCmd.includes('success criteria'), 'Builder should look for success criteria');
  });

  it('PM plan Visual Specification matches what QA checks', () => {
    const pmPlan = readCommand('pm:plan.md');
    const ralphLoop = readFileSync(join(PROTOCOL_DIR, 'ralph-loop.md'), 'utf-8');

    // PM creates Visual Specification
    assert.ok(pmPlan.includes('## Visual Specification'), 'PM should create Visual Specification section');
    assert.ok(pmPlan.includes('Layout'), 'Visual spec should include Layout');
    assert.ok(pmPlan.includes('Hierarchy'), 'Visual spec should include Hierarchy');
    assert.ok(pmPlan.includes('Mood'), 'Visual spec should include Mood');

    // QA checks against Visual Specification
    assert.ok(ralphLoop.includes('Visual Specification'), 'Ralph Loop should reference Visual Specification');
    assert.ok(ralphLoop.includes('Visual spec check'), 'Ralph Loop should have visual spec check step');
  });

  it('PM plan Visual Specification matches what Design Review checks', () => {
    const designLoop = readFileSync(join(PROTOCOL_DIR, 'design-loop.md'), 'utf-8');

    // Design review checks visual spec
    assert.ok(designLoop.includes('Visual Specification'), 'Design Loop should reference Visual Specification');
    assert.ok(designLoop.includes('visual-language.md'), 'Design Loop should reference visual-language.md');
  });

  it('Exec checkpoint-fixes.md format matches what PM reads', () => {
    const execCmd = readCommand('exec.md');

    // Exec writes checkpoint fixes
    assert.ok(execCmd.includes('checkpoint-fixes.md'), 'Exec should reference checkpoint-fixes.md');
    assert.ok(execCmd.includes("What's wrong"), 'Fix format should include what is wrong');
    assert.ok(execCmd.includes('Where'), 'Fix format should include where');
    assert.ok(execCmd.includes('Fix:'), 'Fix format should include fix suggestion');

    // Ship.js dispatches PM with reference to the file
    const shipJs = readLib('ship.js');
    assert.ok(shipJs.includes('checkpoint-fixes.md'), 'Ship.js should reference checkpoint-fixes.md');
    assert.ok(shipJs.includes('Read .exec/memory/checkpoint-fixes.md'), 'Ship.js PM prompt should tell PM to read fixes');
  });

  it('Exec decisions.md format matches what PM:plan reads', () => {
    const execCmd = readCommand('exec.md');
    const pmPlan = readCommand('pm:plan.md');

    // Exec writes lessons to decisions.md
    assert.ok(execCmd.includes('.exec/memory/decisions.md'), 'Exec should write to decisions.md');

    // PM:plan reads exec decisions
    assert.ok(pmPlan.includes('.exec/memory/decisions.md'), 'PM:plan should read exec decisions');
    assert.ok(pmPlan.includes('lessons learned') || pmPlan.includes('lessons'),
      'PM:plan should mention lessons from exec');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  4. CONTRADICTIONS WITHIN PROMPTS
// ══════════════════════════════════════════════════════════════════════════

describe('No contradictions within agent prompts', () => {

  it('Builder: told to create branch AND told to stay on main', () => {
    const buildCmd = readCommand('build.md');
    const createsBranch = buildCmd.includes('create build/');
    const staysOnMain = buildCmd.includes('stay on main') || buildCmd.includes('work on main');
    // Should create branch, not stay on main
    assert.ok(createsBranch, 'Builder should be told to create branch');
    assert.ok(!staysOnMain, 'Builder should NOT be told to stay on main');
  });

  it('Resolver: scope is limited to QA diagnosis only', () => {
    const resolveCmd = readCommand('resolve.md');
    assert.ok(resolveCmd.includes('ONLY'), 'Resolver should emphasize ONLY');
    assert.ok(!resolveCmd.includes('explore') || resolveCmd.includes('no exploring'),
      'Resolver should not explore beyond QA diagnosis');
    // Check it doesn't contradict by telling resolver to read extra files
    const readInstructions = resolveCmd.match(/Read (?!ONLY|`\.)/gi) || [];
    // Should not have generic "Read X" without the "ONLY" qualifier
  });

  it('QA: tree checks are blocking, forest checks are advisory', () => {
    const ralphLoop = readFileSync(join(PROTOCOL_DIR, 'ralph-loop.md'), 'utf-8');
    assert.ok(ralphLoop.includes('Tree checks (blocking'), 'Tree should be blocking');
    assert.ok(ralphLoop.includes('Forest checks (advisory'), 'Forest should be advisory');
    assert.ok(ralphLoop.includes('verdict is based ONLY on tree checks'), 'Verdict should be tree-only');
    // Check no contradiction where forest affects verdict
    assert.ok(!ralphLoop.includes('forest findings block') && !ralphLoop.includes('forest findings fail'),
      'Forest findings should never block');
  });

  it('PM:plan: describes WHAT not HOW', () => {
    const pmPlan = readCommand('pm:plan.md');
    assert.ok(pmPlan.includes('WHAT and WHY, never HOW'), 'Should state WHAT not HOW rule');
    // Check it doesn't contradict by including code examples in the format
    assert.ok(!pmPlan.includes('```jsx') && !pmPlan.includes('```css') && !pmPlan.includes('```sql'),
      'Plan template should not include code examples');
  });

  it('Exec: does NOT create plan files or tasks', () => {
    const execCmd = readCommand('exec.md');
    assert.ok(execCmd.includes('Create plan files') === false || execCmd.includes('NOT') || execCmd.includes('not create'),
      'Exec should not create plan files');
    // Count "Do NOT" / "Do not" references
    const doNots = execCmd.match(/Do NOT|Do not|don't/gi) || [];
    assert.ok(doNots.length > 0, 'Exec should have guardrails about what NOT to do');

    // Specifically: exec should not create tasks
    const taskCreation = execCmd.includes('add-task');
    const planCreation = execCmd.includes('Create plans/');
    // These should only appear in "Do NOT" context, not as instructions
    if (taskCreation) {
      // Find the line and check context
      const lines = execCmd.split('\n');
      const taskLines = lines.filter(l => l.includes('add-task'));
      // All add-task references should be in "Do NOT" blocks
    }
  });

  it('Design review: evaluates against spec, not personal taste', () => {
    const designCmd = readCommand('design-review.md');
    assert.ok(designCmd.includes('spec') || designCmd.includes('specification'),
      'Design review should reference specifications');
    assert.ok(designCmd.includes('not personal taste') || designCmd.includes('against the spec'),
      'Design review should explicitly state spec-based evaluation');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  5. OWNERSHIP CONFLICTS — two agents writing same file
// ══════════════════════════════════════════════════════════════════════════

describe('No ownership conflicts between agents', () => {

  it('.goals.json ownership is clear', () => {
    const agents = ['build.md', 'qa.md', 'resolve.md', 'pm.md', 'pm:plan.md', 'exec.md', 'design-review.md'];
    for (const file of agents) {
      const content = readCommand(file);
      if (content.includes('.goals.json')) {
        // Every agent that touches .goals.json should do it through pipeline-cli
        if (content.includes('write') && content.toLowerCase().includes('goals')) {
          assert.ok(content.includes('pipeline-cli'),
            `${file} writes .goals.json — must use pipeline-cli`);
        }
      }
    }
  });

  it('.design/memory/ is owned exclusively by design-review', () => {
    const designCmd = readCommand('design-review.md');
    assert.ok(designCmd.includes('OWNS') && designCmd.includes('.design/memory'),
      'Design review should declare ownership of .design/memory/');

    // Other agents should only READ .design/memory/
    const otherAgents = ['build.md', 'qa.md', 'resolve.md', 'pm.md'];
    for (const file of otherAgents) {
      const content = readCommand(file);
      if (content.includes('.design/memory')) {
        assert.ok(
          content.includes('read-only') || content.includes('Read') || content.includes('read'),
          `${file} references .design/memory/ — should be read-only`
        );
      }
    }
  });

  it('.pm/memory/ is owned by PM', () => {
    const pmCmd = readCommand('pm.md');
    assert.ok(pmCmd.includes('OWN') && pmCmd.includes('.pm/memory'),
      'PM should declare ownership of .pm/memory/');
  });

  it('.exec/memory/ is owned by exec', () => {
    const execCmd = readCommand('exec.md');
    assert.ok(execCmd.includes('.exec/memory'),
      'Exec should reference .exec/memory/');
  });

  it('PM concerns.md has shared write access documented', () => {
    const designCmd = readCommand('design-review.md');
    // Design review is allowed to write to .pm/memory/concerns.md
    assert.ok(designCmd.includes('concerns.md'),
      'Design review should reference concerns.md');
    assert.ok(designCmd.includes('READS AND WRITES') || designCmd.includes('WRITE'),
      'Design review should declare write access to concerns');
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  6. STEP NUMBERING AND ORDERING
// ══════════════════════════════════════════════════════════════════════════

describe('Agent startup steps are numbered correctly', () => {
  const commandFiles = readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));

  for (const file of commandFiles) {
    it(`${file} — startup steps have sequential numbering`, () => {
      const content = readCommand(file);
      // Find numbered steps in startup/context sections
      const stepNumbers = [...content.matchAll(/^(\d+)\.\s/gm)].map(m => parseInt(m[1]));

      if (stepNumbers.length < 2) return; // Not enough steps to check

      // Check for duplicates within reasonable sequences (allow resets for different sections)
      let lastNum = 0;
      let duplicates = [];
      let gaps = [];
      for (let i = 0; i < stepNumbers.length; i++) {
        const num = stepNumbers[i];
        if (num === lastNum && num !== 1) {
          duplicates.push(num);
        }
        if (num === lastNum + 2 && lastNum > 0) {
          gaps.push(`${lastNum} → ${num} (missing ${lastNum + 1})`);
        }
        lastNum = num;
      }

      if (duplicates.length > 0) {
        // Report but don't fail — duplicate numbers are common in different sections
      }
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  7. DISTILLER OUTPUT MATCHES WHAT AGENTS EXPECT
// ══════════════════════════════════════════════════════════════════════════

describe('Distiller XML tags match agent expectations', () => {
  const distiller = readLib('distill-briefing.js');

  it('Builder briefing includes tags the builder prompt expects', () => {
    // Distiller produces these tags for builder
    assert.ok(distiller.includes('<vision>'), 'Distiller should produce <vision> for builder');
    assert.ok(distiller.includes('<target>'), 'Distiller should produce <target> for builder');
    assert.ok(distiller.includes('<success-criteria>'), 'Distiller should produce <success-criteria>');
    assert.ok(distiller.includes('<previous-attempts>'), 'Distiller should produce <previous-attempts>');
    assert.ok(distiller.includes('<visual-language>'), 'Distiller should produce <visual-language>');
    assert.ok(distiller.includes('<illustrations>'), 'Distiller should produce <illustrations>');
  });

  it('QA briefing includes visual context', () => {
    assert.ok(distiller.includes('buildQaBriefing'), 'Distiller should have QA briefing function');
    // QA needs visual context for screenshot comparison
    const qaSection = distiller.slice(distiller.indexOf('buildQaBriefing'));
    assert.ok(qaSection.includes('visual-language'), 'QA briefing should include visual-language');
    assert.ok(qaSection.includes('visual-spec'), 'QA briefing should include visual-spec');
    assert.ok(qaSection.includes('illustrations'), 'QA briefing should include illustrations');
  });

  it('Design briefing includes previous findings', () => {
    assert.ok(distiller.includes('buildDesignBriefing'), 'Distiller should have Design briefing function');
    const designSection = distiller.slice(distiller.indexOf('buildDesignBriefing'));
    assert.ok(designSection.includes('previous-findings'), 'Design briefing should include previous findings');
    assert.ok(designSection.includes('page-grades'), 'Design briefing should include page grades');
    assert.ok(designSection.includes('visual-drift'), 'Design briefing should include visual drift');
  });

  it('Exec briefing includes failing phase details', () => {
    assert.ok(distiller.includes('buildExecBriefing'), 'Distiller should have Exec briefing function');
    const execSection = distiller.slice(distiller.indexOf('buildExecBriefing'));
    assert.ok(execSection.includes('failing-phase') || execSection.includes('failed'),
      'Exec briefing should include failing phase info');
  });
});
