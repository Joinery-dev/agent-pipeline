#!/usr/bin/env node

/**
 * merge.js — Automated branch merge lifecycle
 *
 * Usage:
 *   node lib/merge.js <branch> [--to <target>] [--dry-run] [--tag <name>] [--no-push]
 *
 * Exit codes:
 *   0 — success
 *   1 — conflict detected
 *   2 — tests failed
 *   3 — usage / argument error
 *   4 — unexpected error
 */

import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    to:       { type: 'string',  default: 'main' },
    'dry-run': { type: 'boolean', default: false },
    tag:      { type: 'string',  default: '' },
    'no-push': { type: 'boolean', default: false },
  },
});

const branch  = positionals[0];
const target  = flags.to;
const dryRun  = flags['dry-run'];
const tagName = flags.tag;
const noPush  = flags['no-push'];

if (!branch) {
  console.error('Usage: node lib/merge.js <branch> [--to <target>] [--dry-run] [--tag <name>] [--no-push]');
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a git (or any) command, return trimmed stdout. */
function run(cmd, { silent = false, allowFail = false } = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: silent ? 'pipe' : ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

/** Print a step header to stderr (keeps stdout clean for JSON). */
function step(n, msg) {
  process.stderr.write(`[step ${n}] ${msg}\n`);
}

/** Emit the final JSON report to stdout and exit. */
function report(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

/** Record which branch we started on so cleanup can restore it. */
const originalBranch = run('git rev-parse --abbrev-ref HEAD');

/** Track merge-in-progress so cleanup knows whether to abort. */
let mergeInProgress = false;

/** Cleanup: abort dangling merge, return to original branch. */
function cleanup() {
  try {
    if (mergeInProgress) {
      run('git merge --abort', { silent: true, allowFail: true });
      mergeInProgress = false;
    }
  } catch { /* best effort */ }
  try {
    const current = run('git rev-parse --abbrev-ref HEAD', { silent: true });
    if (current !== originalBranch) {
      run(`git checkout ${originalBranch}`, { silent: true, allowFail: true });
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Main lifecycle
// ---------------------------------------------------------------------------

async function main() {
  let commitsAhead = 0;
  const resolvedTag = tagName || `release/${branch}`;

  try {
    // ------------------------------------------------------------------
    // Step 1 — Verify branch exists and has commits ahead of target
    // ------------------------------------------------------------------
    step(1, `Verify branch "${branch}" exists and is ahead of "${target}"`);

    const branchExists = run(`git rev-parse --verify ${branch}`, { allowFail: true });
    if (branchExists === null) {
      process.stderr.write(`Error: branch "${branch}" does not exist.\n`);
      report({ merged: false, branch, target, error: `Branch "${branch}" does not exist` });
      process.exit(3);
    }

    const targetExists = run(`git rev-parse --verify ${target}`, { allowFail: true });
    if (targetExists === null) {
      process.stderr.write(`Error: target branch "${target}" does not exist.\n`);
      report({ merged: false, branch, target, error: `Target branch "${target}" does not exist` });
      process.exit(3);
    }

    const aheadBehind = run(`git rev-list --left-right --count ${target}...${branch}`);
    const [behind, ahead] = aheadBehind.split(/\s+/).map(Number);
    commitsAhead = ahead;

    if (commitsAhead === 0) {
      process.stderr.write(`Branch "${branch}" has no commits ahead of "${target}". Nothing to merge.\n`);
      report({ merged: false, branch, target, commitsAhead: 0, error: 'No commits ahead of target' });
      process.exit(0);
    }

    step(1, `${commitsAhead} commit(s) ahead, ${behind} behind`);

    // ------------------------------------------------------------------
    // Step 2 — Fetch
    // ------------------------------------------------------------------
    step(2, 'git fetch origin');
    run('git fetch origin', { allowFail: true });

    // ------------------------------------------------------------------
    // Step 3 — Conflict check
    // ------------------------------------------------------------------
    step(3, 'Conflict check (merge --no-commit --no-ff)');

    // Checkout target temporarily for the trial merge
    run(`git checkout ${target}`, { silent: true });

    const trialResult = run(`git merge --no-commit --no-ff ${branch}`, { allowFail: true });
    const conflictCheck = run('git diff --name-only --diff-filter=U', { silent: true, allowFail: true });

    // Always abort the trial merge
    mergeInProgress = true;
    run('git merge --abort', { silent: true, allowFail: true });
    mergeInProgress = false;

    // Go back to original branch for now
    run(`git checkout ${originalBranch}`, { silent: true });

    if (trialResult === null && conflictCheck && conflictCheck.length > 0) {
      const conflictingFiles = conflictCheck.split('\n').filter(Boolean);
      process.stderr.write(`Conflicts detected in ${conflictingFiles.length} file(s):\n`);
      conflictingFiles.forEach(f => process.stderr.write(`  - ${f}\n`));
      report({
        merged: false,
        branch,
        target,
        commitsAhead,
        error: 'Merge conflicts detected',
        conflictingFiles,
      });
      process.exit(1);
    }

    // If trial merge failed but no unmerged files detected, do a deeper check
    if (trialResult === null) {
      // Try merge-tree as a fallback conflict detector
      const mergeBase = run(`git merge-base ${target} ${branch}`, { allowFail: true });
      if (mergeBase) {
        const treeResult = run(`git merge-tree ${mergeBase} ${target} ${branch}`, { allowFail: true, silent: true });
        if (treeResult && treeResult.includes('<<<<<<')) {
          process.stderr.write('Conflicts detected via merge-tree.\n');
          report({
            merged: false,
            branch,
            target,
            commitsAhead,
            error: 'Merge conflicts detected',
          });
          process.exit(1);
        }
      }
    }

    step(3, 'No conflicts detected');

    // ------------------------------------------------------------------
    // Step 4 — Run test suite on feature branch
    // ------------------------------------------------------------------
    step(4, `Run tests on "${branch}"`);
    run(`git checkout ${branch}`, { silent: true });

    const testResult = run('node --test tests/', { allowFail: true });
    const testsPassed = testResult !== null;

    // Return to original branch
    run(`git checkout ${originalBranch}`, { silent: true });

    if (!testsPassed) {
      process.stderr.write(`Tests failed on branch "${branch}".\n`);
      report({
        merged: false,
        branch,
        target,
        commitsAhead,
        testsPassed: false,
        error: 'Tests failed on feature branch',
      });
      process.exit(2);
    }

    step(4, 'Tests passed');

    // ------------------------------------------------------------------
    // Dry-run stops here
    // ------------------------------------------------------------------
    if (dryRun) {
      step('--', 'Dry run — stopping before merge');
      report({
        merged: false,
        dryRun: true,
        branch,
        target,
        commitsAhead,
        tag: tagName ? resolvedTag : null,
        testsPassed: true,
        wouldMerge: true,
      });
      process.exit(0);
    }

    // ------------------------------------------------------------------
    // Step 5 — Checkout target and pull
    // ------------------------------------------------------------------
    step(5, `Checkout "${target}" and pull`);
    run(`git checkout ${target}`);
    run(`git pull origin ${target}`, { allowFail: true });

    // ------------------------------------------------------------------
    // Step 6 — Merge
    // ------------------------------------------------------------------
    step(6, `Merge "${branch}" into "${target}" (--no-ff)`);
    const mergeMsg = `Merge ${branch} into ${target}`;
    run(`git merge --no-ff ${branch} -m "${mergeMsg}"`);

    // ------------------------------------------------------------------
    // Step 7 — Post-merge test verification
    // ------------------------------------------------------------------
    step(7, 'Post-merge test verification');
    const postTestResult = run('node --test tests/', { allowFail: true });
    const postTestsPassed = postTestResult !== null;

    if (!postTestsPassed) {
      process.stderr.write('Post-merge tests failed — rolling back merge commit.\n');
      run('git reset --hard HEAD~1');
      // Return to original branch
      run(`git checkout ${originalBranch}`, { silent: true });
      report({
        merged: false,
        branch,
        target,
        commitsAhead,
        testsPassed: true,
        postMergeTestsPassed: false,
        error: 'Post-merge tests failed; merge rolled back',
      });
      process.exit(2);
    }

    step(7, 'Post-merge tests passed');

    // ------------------------------------------------------------------
    // Step 8 — Tag
    // ------------------------------------------------------------------
    let createdTag = null;
    if (tagName) {
      step(8, `Create tag "${resolvedTag}"`);
      run(`git tag -a "${resolvedTag}" -m "Release: ${resolvedTag}"`);
      createdTag = resolvedTag;
    } else {
      step(8, 'No tag requested — skipping');
    }

    // ------------------------------------------------------------------
    // Step 9 — Push
    // ------------------------------------------------------------------
    if (!noPush) {
      step(9, `Push "${target}" to origin`);
      run(`git push origin ${target}`);
      if (createdTag) {
        run(`git push origin "${createdTag}"`);
      }
    } else {
      step(9, '--no-push specified — skipping push');
    }

    // ------------------------------------------------------------------
    // Step 10 — Report
    // ------------------------------------------------------------------
    step(10, 'Done');

    // Return to original branch if we're still on target
    const currentAfter = run('git rev-parse --abbrev-ref HEAD', { silent: true });
    if (currentAfter !== originalBranch) {
      run(`git checkout ${originalBranch}`, { silent: true, allowFail: true });
    }

    report({
      merged: true,
      branch,
      target,
      commitsAhead,
      tag: createdTag,
      testsPassed: true,
    });

  } catch (err) {
    process.stderr.write(`Unexpected error: ${err.message}\n`);
    cleanup();
    report({
      merged: false,
      branch,
      target,
      commitsAhead,
      error: err.message,
    });
    process.exit(4);
  }
}

main();
