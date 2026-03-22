#!/usr/bin/env node

/**
 * agent-runner.js — Shared Claude agent spawning logic.
 *
 * Extracted from ship.js so both ship.js and autoresearch.js can spawn
 * Claude sessions with consistent behavior: streaming output, heartbeat
 * monitoring, timeout enforcement, and graceful kill.
 *
 * Usage:
 *   import { spawnAgent } from './agent-runner.js';
 *   const result = await spawnAgent('/build my-plan', {
 *     cwd: '/tmp/workspace',
 *     timeoutMs: 300000,
 *     onToolUse: (toolName) => console.log(`Using: ${toolName}`),
 *   });
 */

import { spawn } from 'child_process';

// ── Defaults ─────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;       // 5 minutes
const DEFAULT_HEARTBEAT_MS = 30 * 1000;          // 30 seconds

// ── Core Agent Spawner ──────────────────────────────────────────────────

/**
 * Spawn a Claude agent session and return the result.
 *
 * @param {string} command - The prompt or slash command to run (e.g., '/build plan-name')
 * @param {object} options
 * @param {string} [options.cwd] - Working directory for the agent (default: process.cwd())
 * @param {number} [options.timeoutMs] - Kill agent after this many ms (default: 300000)
 * @param {number} [options.heartbeatMs] - Heartbeat check interval (default: 30000)
 * @param {boolean} [options.verbose] - Log full stream-json events via onVerbose
 * @param {function} [options.onToolUse] - Called with tool name on each tool use event
 * @param {function} [options.onHeartbeat] - Called with { silenceMs, elapsedMs } on each heartbeat
 * @param {function} [options.onVerbose] - Called with raw event JSON string in verbose mode
 * @param {function} [options.onProgress] - Called periodically with { elapsedMs } for external progress checks
 * @param {number} [options.progressCheckMs] - How often to call onProgress (default: disabled)
 * @param {function} [options.shouldKill] - Called on progress check; return true to kill the agent
 * @param {boolean} [options.interactive] - Run interactively (inherit terminal stdio, no -p flag).
 *   Used for exec initial planning where the agent needs to chat with the human.
 *   When interactive, output capture, heartbeat, and progress monitoring are disabled.
 * @returns {Promise<{ success: boolean, output: string, durationMs: number, exitCode: number }>}
 */
export function spawnAgent(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    verbose = false,
    interactive = false,
    onToolUse = null,
    onHeartbeat = null,
    onVerbose = null,
    onProgress = null,
    progressCheckMs = 0,
    shouldKill = null,
  } = options;

  const startTime = Date.now();

  // ── Interactive mode: inherit terminal, no monitoring ──
  // The human chats directly with the agent. Used for exec initial planning
  // where the agent needs to ask questions and get answers.
  if (interactive) {
    return new Promise((resolve) => {
      const proc = spawn('claude', [
        '-p', command,
        '--dangerously-skip-permissions',
        '--allowedTools', 'AskUserQuestion,Read,Write,Edit,Bash,Glob,Grep,WebSearch,WebFetch,Agent',
      ], {
        cwd,
        stdio: 'inherit',
      });

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          output: '',
          durationMs: Date.now() - startTime,
          exitCode: code,
          killed: false,
        });
      });
    });
  }

  // ── Non-interactive mode: capture output, monitor progress ──
  return new Promise((resolve) => {
    const proc = spawn('claude', [
      '-p', command,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let lastActivityAt = Date.now();
    let output = '';
    let lastToolMsg = '';
    let killed = false;

    // ── stdout: collect output + parse stream-json events ──

    proc.stdout.on('data', (chunk) => {
      lastActivityAt = Date.now();
      const text = chunk.toString();
      output += text;

      for (const line of text.split('\n').filter(Boolean)) {
        try {
          const event = JSON.parse(line);

          if (verbose && onVerbose) {
            onVerbose(JSON.stringify(event));
          }

          if (event.type === 'assistant' && event.tool && onToolUse) {
            const toolName = event.tool.name || 'working';
            if (toolName !== lastToolMsg) {
              onToolUse(toolName);
              lastToolMsg = toolName;
            }
          }
        } catch {
          // Not valid JSON — ignore
        }
      }
    });

    // ── stderr: keep activity tracker alive ──

    proc.stderr.on('data', () => {
      lastActivityAt = Date.now();
    });

    // ── Timeout: hard kill after budget ──

    const timeout = setTimeout(() => {
      if (!killed) {
        killed = true;
        proc.kill('SIGTERM');
      }
    }, timeoutMs);

    // ── Heartbeat: periodic status checks ──

    let lastProgressCheck = Date.now();

    const heartbeat = setInterval(() => {
      const silenceMs = Date.now() - lastActivityAt;
      const elapsedMs = Date.now() - startTime;

      if (onHeartbeat) {
        onHeartbeat({ silenceMs, elapsedMs });
      }

      // External progress check (used by ship.js for git-based monitoring)
      if (progressCheckMs > 0 && (Date.now() - lastProgressCheck >= progressCheckMs)) {
        lastProgressCheck = Date.now();

        if (onProgress) {
          onProgress({ elapsedMs, silenceMs });
        }

        if (shouldKill && shouldKill({ elapsedMs, silenceMs })) {
          if (!killed) {
            killed = true;
            proc.kill('SIGTERM');
          }
        }
      }
    }, heartbeatMs);

    // ── Close: resolve promise ──

    proc.on('close', (code) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);

      resolve({
        success: code === 0,
        output,
        durationMs: Date.now() - startTime,
        exitCode: code,
        killed,
      });
    });
  });
}
