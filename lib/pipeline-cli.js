#!/usr/bin/env node

/**
 * Pipeline CLI — thin wrapper for agents to call via bash
 *
 * Usage:
 *   node lib/pipeline-cli.js add-attempt <taskId> --type build --desc "implementing X"
 *   node lib/pipeline-cli.js update-attempt <taskId> <attemptId> --outcome success --notes "done"
 *   node lib/pipeline-cli.js update-status <taskId> in-progress
 *   node lib/pipeline-cli.js set-pipeline <phaseId> awaiting-qa --agent build
 *   node lib/pipeline-cli.js rollup <phaseId>
 *   node lib/pipeline-cli.js find-task "formatCurrency"
 *   node lib/pipeline-cli.js get-state <phaseId>
 *   node lib/pipeline-cli.js get-phase-full <phaseId>
 *   node lib/pipeline-cli.js validate
 *   node lib/pipeline-cli.js stale-tasks
 */

import { readFileSync, existsSync } from 'fs';
import {
  readGoals, writeGoals, validateGoals, newId, findTask, findPhaseForTask,
  addAttempt, updateAttempt, getLatestAttempt, getAttempts,
  setPipelineState, getPipelineState, rollupPhaseStatus, rollupMajorPhaseStatus,
  checkDependencies, updateTaskStatus, getStaleTasks, getAllPhases, findEntityById,
} from './pipeline.js';

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1] || true;
      i++;
    }
  }
  return flags;
}

function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

try {
  switch (command) {
    case 'validate': {
      const goals = readGoals();
      const result = validateGoals(goals);
      output(result);
      process.exit(result.valid ? 0 : 1);
      break;
    }

    case 'find-task': {
      const query = args[1];
      if (!query) fail('Usage: find-task <query>');
      const goals = readGoals();
      const task = findTask(goals, query);
      if (!task) fail(`No task found matching: ${query}`);
      output(task);
      break;
    }

    case 'add-attempt': {
      const taskId = args[1];
      if (!taskId) fail('Usage: add-attempt <taskId> --type build --desc "..."');
      const flags = parseFlags(args.slice(2));
      if (!flags.type) fail('--type is required');
      const goals = readGoals();
      const attemptId = addAttempt(goals, taskId, {
        type: flags.type,
        description: flags.desc || flags.description || '',
      });
      writeGoals(goals);
      output({ attemptId });
      break;
    }

    case 'update-attempt': {
      const taskId = args[1];
      const attemptId = args[2];
      if (!taskId || !attemptId) fail('Usage: update-attempt <taskId> <attemptId> --outcome success --notes "..."');
      const flags = parseFlags(args.slice(3));
      const goals = readGoals();
      updateAttempt(goals, taskId, attemptId, {
        outcome: flags.outcome,
        notes: flags.notes,
      });
      writeGoals(goals);
      output({ updated: true, attemptId });
      break;
    }

    case 'update-status': {
      const taskId = args[1];
      const newStatus = args[2];
      if (!taskId || !newStatus) fail('Usage: update-status <taskId> <status>');
      const goals = readGoals();
      updateTaskStatus(goals, taskId, newStatus);
      writeGoals(goals);
      output({ updated: true, taskId, status: newStatus });
      break;
    }

    case 'set-pipeline': {
      const phaseId = args[1];
      const state = args[2];
      if (!phaseId || !state) fail('Usage: set-pipeline <phaseId> <state> [--agent build]');
      const flags = parseFlags(args.slice(3));
      const goals = readGoals();
      setPipelineState(goals, phaseId, state, flags.agent);
      writeGoals(goals);
      output({ updated: true, phaseId, state });
      break;
    }

    case 'rollup': {
      const phaseId = args[1];
      if (!phaseId) fail('Usage: rollup <phaseId>');
      const goals = readGoals();
      const newStatus = rollupPhaseStatus(goals, phaseId);
      writeGoals(goals);
      output({ phaseId, status: newStatus });
      break;
    }

    case 'rollup-major': {
      const mpId = args[1];
      if (!mpId) fail('Usage: rollup-major <majorPhaseId|title>');
      const goals = readGoals();
      // Find by ID or title
      let mp = goals.majorPhases?.find(m => m.id === mpId);
      if (!mp) mp = goals.majorPhases?.find(m => m.title.toLowerCase().includes(mpId.toLowerCase()));
      if (!mp) fail(`MajorPhase not found: ${mpId}`);
      const newStatus = rollupMajorPhaseStatus(goals, mp.id);
      writeGoals(goals);
      output({ majorPhaseId: mp.id, title: mp.title, status: newStatus });
      break;
    }

    case 'rollup-all': {
      const goals = readGoals();
      const results = [];
      // Roll up all sub-phases first
      for (const phase of getAllPhases(goals)) {
        if (phase.tasks?.length > 0) {
          const status = rollupPhaseStatus(goals, phase.id);
          results.push({ type: 'phase', title: phase.title, status });
        }
      }
      // Then roll up all major phases
      for (const mp of (goals.majorPhases || [])) {
        const status = rollupMajorPhaseStatus(goals, mp.id);
        results.push({ type: 'majorPhase', title: mp.title, status });
      }
      writeGoals(goals);
      output(results);
      break;
    }

    case 'get-state': {
      const phaseId = args[1];
      if (!phaseId) fail('Usage: get-state <phaseId>');
      const goals = readGoals();
      const state = getPipelineState(goals, phaseId);
      output(state);
      break;
    }

    case 'check-deps': {
      const phaseId = args[1];
      if (!phaseId) fail('Usage: check-deps <phaseId>');
      const goals = readGoals();
      const result = checkDependencies(goals, phaseId);
      output(result);
      process.exit(result.ready ? 0 : 1);
      break;
    }

    case 'update-project': {
      const flags = parseFlags(args.slice(1));
      const goals = readGoals();
      if (flags.name) goals.name = flags.name;
      if (flags.desc || flags.description) goals.description = flags.desc || flags.description;
      if (flags.vision) goals.vision = flags.vision;
      goals.updatedAt = new Date().toISOString();
      writeGoals(goals);
      output({ updated: true, name: goals.name });
      break;
    }

    case 'add-major-phase': {
      const flags = parseFlags(args.slice(1));
      if (!flags.title) fail('Usage: add-major-phase --title "Name" --desc "..." [--produces "a,b"] [--consumes "c,d"] [--order N]');
      const goals = readGoals();
      if (!Array.isArray(goals.majorPhases)) goals.majorPhases = [];
      const maxOrder = goals.majorPhases.reduce((max, mp) => Math.max(max, mp.order ?? 0), -1);
      const majorPhase = {
        id: newId(),
        title: flags.title,
        description: flags.desc || flags.description || '',
        status: 'not-started',
        phases: [],
        order: flags.order ? parseInt(flags.order) : maxOrder + 1,
      };
      if (flags.produces || flags.consumes) {
        majorPhase.interfaceContract = {};
        if (flags.produces) majorPhase.interfaceContract.produces = flags.produces.split(',').map(s => s.trim());
        if (flags.consumes) majorPhase.interfaceContract.consumes = flags.consumes.split(',').map(s => s.trim());
      }
      if (flags.dependsOn) {
        majorPhase.dependsOn = flags.dependsOn.split(',').map(s => s.trim());
      }
      goals.majorPhases.push(majorPhase);
      goals.updatedAt = new Date().toISOString();
      writeGoals(goals);
      output({ majorPhaseId: majorPhase.id, title: majorPhase.title, order: majorPhase.order });
      break;
    }

    case 'update-major-phase': {
      const mpId = args[1];
      if (!mpId) fail('Usage: update-major-phase <id|title> [--desc "..."] [--produces "a,b"] [--consumes "c,d"] [--status not-started]');
      const flags = parseFlags(args.slice(2));
      const goals = readGoals();
      if (!Array.isArray(goals.majorPhases)) fail('No majorPhases in goals');
      // Find by ID or title
      let mp = goals.majorPhases.find(m => m.id === mpId);
      if (!mp) mp = goals.majorPhases.find(m => m.title.toLowerCase() === mpId.toLowerCase());
      if (!mp) mp = goals.majorPhases.find(m => m.title.toLowerCase().includes(mpId.toLowerCase()));
      if (!mp) fail(`MajorPhase not found: ${mpId}`);
      if (flags.desc || flags.description) mp.description = flags.desc || flags.description;
      if (flags.status) mp.status = flags.status;
      if (flags.produces || flags.consumes) {
        if (!mp.interfaceContract) mp.interfaceContract = {};
        if (flags.produces) mp.interfaceContract.produces = flags.produces.split(',').map(s => s.trim());
        if (flags.consumes) mp.interfaceContract.consumes = flags.consumes.split(',').map(s => s.trim());
      }
      if (flags.dependsOn) {
        mp.dependsOn = flags.dependsOn.split(',').map(s => s.trim());
      }
      goals.updatedAt = new Date().toISOString();
      writeGoals(goals);
      output({ updated: true, majorPhaseId: mp.id, title: mp.title });
      break;
    }

    case 'get-major-phase': {
      const mpId = args[1];
      if (!mpId) fail('Usage: get-major-phase <id|title>');
      const goals = readGoals();
      if (!Array.isArray(goals.majorPhases)) fail('No majorPhases in goals');
      let mp = goals.majorPhases.find(m => m.id === mpId);
      if (!mp) mp = goals.majorPhases.find(m => m.title.toLowerCase() === mpId.toLowerCase());
      if (!mp) mp = goals.majorPhases.find(m => m.title.toLowerCase().includes(mpId.toLowerCase()));
      if (!mp) fail(`MajorPhase not found: ${mpId}`);
      output(mp);
      break;
    }

    case 'stale-tasks': {
      const flags = parseFlags(args.slice(1));
      const minutes = flags.minutes ? parseInt(flags.minutes) : 30;
      const goals = readGoals();
      const stale = getStaleTasks(goals, minutes);
      output(stale.map(s => ({
        taskId: s.task.id,
        taskTitle: s.task.title,
        phaseTitle: s.phase.title,
        reason: s.reason,
      })));
      break;
    }

    case 'add-phase': {
      const flags = parseFlags(args.slice(1));
      if (!flags.title) fail('Usage: add-phase --title "Phase Name" --desc "..." [--planFile plans/x.md] [--order N] [--majorPhase <id>]');
      const goals = readGoals();
      const allPhases = getAllPhases(goals);
      const maxOrder = allPhases.reduce((max, p) => Math.max(max, p.order ?? 0), -1);
      const phase = {
        id: newId(),
        title: flags.title,
        description: flags.desc || flags.description || '',
        status: 'not-started',
        planFile: flags.planFile || undefined,
        order: flags.order ? parseInt(flags.order) : maxOrder + 1,
        tasks: [],
        pipeline: { state: 'idle', lastAgent: null, lastTimestamp: null },
      };
      // Optional interface contract
      if (flags.produces || flags.consumes) {
        phase.interfaceContract = {};
        if (flags.produces) phase.interfaceContract.produces = flags.produces.split(',').map(s => s.trim());
        if (flags.consumes) phase.interfaceContract.consumes = flags.consumes.split(',').map(s => s.trim());
      }
      // Optional dependencies
      if (flags.dependsOn) {
        phase.dependsOn = flags.dependsOn.split(',').map(s => s.trim());
      }
      // Add to specified majorPhase, or the first one (auto-create if empty)
      if (goals.majorPhases) {
        let targetMp;
        if (flags.majorPhase) {
          // Try UUID first, then title match (case-insensitive)
          targetMp = goals.majorPhases.find(mp => mp.id === flags.majorPhase);
          if (!targetMp) {
            targetMp = goals.majorPhases.find(mp =>
              mp.title.toLowerCase() === flags.majorPhase.toLowerCase()
            );
          }
          if (!targetMp) {
            // Substring match as last resort
            targetMp = goals.majorPhases.find(mp =>
              mp.title.toLowerCase().includes(flags.majorPhase.toLowerCase())
            );
          }
          if (!targetMp) fail(`MajorPhase not found: ${flags.majorPhase}`);
        } else {
          targetMp = goals.majorPhases[0];
          if (!targetMp) {
            targetMp = {
              id: newId(),
              title: 'Default',
              description: '',
              status: 'not-started',
              phases: [],
              order: 0,
            };
            goals.majorPhases.push(targetMp);
          }
        }
        if (!targetMp.phases) targetMp.phases = [];
        targetMp.phases.push(phase);
      } else {
        if (!goals.phases) goals.phases = [];
        goals.phases.push(phase);
      }
      writeGoals(goals);
      output({ phaseId: phase.id, title: phase.title, order: phase.order });
      break;
    }

    case 'add-task': {
      const phaseId = args[1];
      if (!phaseId) fail('Usage: add-task <phaseId> --title "Task Name" --desc "..." [--planFile plans/x.md] [--files "a.js,b.js"]');
      const flags = parseFlags(args.slice(2));
      if (!flags.title) fail('--title is required');
      const goals = readGoals();
      const phase = getAllPhases(goals).find(p => p.id === phaseId);
      if (!phase) fail(`Phase not found: ${phaseId}`);
      const task = {
        id: newId(),
        title: flags.title,
        description: flags.desc || flags.description || '',
        status: 'not-started',
        planFile: flags.planFile || phase.planFile || undefined,
        files: flags.files ? flags.files.split(',').map(f => f.trim()) : [],
        attempts: [],
        createdAt: new Date().toISOString(),
      };
      phase.tasks.push(task);
      writeGoals(goals);
      output({ taskId: task.id, title: task.title, phaseId });
      break;
    }

    case 'get-task': {
      const taskId = args[1];
      if (!taskId) fail('Usage: get-task <taskId>');
      const goals = readGoals();
      for (const phase of getAllPhases(goals)) {
        const task = phase.tasks.find(t => t.id === taskId);
        if (task) {
          output({ ...task, phaseId: phase.id, phaseTitle: phase.title });
          process.exit(0);
        }
      }
      fail(`Task not found: ${taskId}`);
      break;
    }

    case 'get-phase': {
      const phaseId = args[1];
      if (!phaseId) fail('Usage: get-phase <phaseId>');
      const goals = readGoals();
      const phase = getAllPhases(goals).find(p => p.id === phaseId);
      if (!phase) fail(`Phase not found: ${phaseId}`);
      output(phase);
      break;
    }

    case 'get-phase-full': {
      const phaseId = args[1];
      if (!phaseId) fail('Usage: get-phase-full <phaseId>');
      const goals = readGoals();
      let foundPhase = null;
      let parentMajorPhase = null;
      // Search through majorPhases[].phases[]
      if (Array.isArray(goals.majorPhases)) {
        for (const mp of goals.majorPhases) {
          if (Array.isArray(mp.phases)) {
            const phase = mp.phases.find(p => p.id === phaseId);
            if (phase) {
              foundPhase = phase;
              parentMajorPhase = { id: mp.id, title: mp.title, status: mp.status };
              break;
            }
          }
        }
      }
      // Fallback: search top-level phases (no parent majorPhase)
      if (!foundPhase && Array.isArray(goals.phases)) {
        const phase = goals.phases.find(p => p.id === phaseId);
        if (phase) foundPhase = phase;
      }
      if (!foundPhase) fail(`Phase not found: ${phaseId}`);
      const result = { phase: foundPhase };
      if (parentMajorPhase) result.majorPhase = parentMajorPhase;
      output(result);
      break;
    }

    case 'update-task': {
      const taskId = args[1];
      if (!taskId) fail('Usage: update-task <taskId> [--title "..."] [--desc "..."] [--files "a.js,b.js"] [--status <status>]');
      const flags = parseFlags(args.slice(2));
      const goals = readGoals();
      const task = findTask(goals, taskId);
      if (!task) fail(`Task not found: ${taskId}`);
      if (flags.title) task.title = flags.title;
      if (flags.desc || flags.description) task.description = flags.desc || flags.description;
      if (flags.files) task.files = flags.files.split(',').map(f => f.trim());
      if (flags.status) {
        const VALID_STATUSES = ['not-started', 'in-progress', 'completed', 'blocked'];
        if (!VALID_STATUSES.includes(flags.status)) fail(`Invalid status: ${flags.status}. Valid: ${VALID_STATUSES.join(', ')}`);
        task.status = flags.status;
      }
      writeGoals(goals);
      output(task);
      break;
    }

    case 'update-phase': {
      const phaseId = args[1];
      if (!phaseId) fail('Usage: update-phase <phaseId> [--title "..."] [--desc "..."] [--planFile "plans/slug.md"] [--produces "a,b"] [--consumes "c,d"]');
      const flags = parseFlags(args.slice(2));
      const goals = readGoals();
      const phase = getAllPhases(goals).find(p => p.id === phaseId);
      if (!phase) fail(`Phase not found: ${phaseId}`);
      if (flags.title) phase.title = flags.title;
      if (flags.desc || flags.description) phase.description = flags.desc || flags.description;
      if (flags.planFile) phase.planFile = flags.planFile;
      if (flags.produces || flags.consumes) {
        if (!phase.interfaceContract) phase.interfaceContract = {};
        if (flags.produces) phase.interfaceContract.produces = flags.produces.split(',').map(s => s.trim());
        if (flags.consumes) phase.interfaceContract.consumes = flags.consumes.split(',').map(s => s.trim());
      }
      writeGoals(goals);
      output(phase);
      break;
    }

    case 'add-diagram': {
      const entityId = args[1];
      if (!entityId) fail('Usage: add-diagram <entityId> --title "Diagram Title" --jsonFile /tmp/diagram.json');
      const flags = parseFlags(args.slice(2));
      if (!flags.title) fail('--title is required');
      if (!flags.jsonFile) fail('--jsonFile is required');

      let diagramData;
      try {
        diagramData = JSON.parse(readFileSync(flags.jsonFile, 'utf-8'));
      } catch (e) {
        fail(`Failed to read/parse --jsonFile "${flags.jsonFile}": ${e.message}`);
      }

      if (!Array.isArray(diagramData.nodes)) fail('JSON file must contain nodes[]');
      if (!Array.isArray(diagramData.edges)) fail('JSON file must contain edges[]');

      // Validate node IDs are unique
      const nodeIds = new Set();
      for (const node of diagramData.nodes) {
        if (!node.id) fail('Every node must have an id');
        if (nodeIds.has(node.id)) fail(`Duplicate node id: ${node.id}`);
        nodeIds.add(node.id);
      }

      // Validate edges reference existing nodes
      for (const edge of diagramData.edges) {
        if (!edge.id) fail('Every edge must have an id');
        if (!nodeIds.has(edge.source)) fail(`Edge "${edge.id}" references unknown source node: ${edge.source}`);
        if (!nodeIds.has(edge.target)) fail(`Edge "${edge.id}" references unknown target node: ${edge.target}`);
      }

      const goals = readGoals();
      const entity = findEntityById(goals, entityId);
      if (!entity) fail(`Entity not found: ${entityId}`);

      const now = new Date().toISOString();
      const diagram = {
        id: newId(),
        title: flags.title,
        nodes: diagramData.nodes,
        edges: diagramData.edges,
        createdAt: now,
        updatedAt: now,
      };

      if (!Array.isArray(entity.diagrams)) entity.diagrams = [];
      entity.diagrams.push(diagram);

      writeGoals(goals);
      output({ diagramId: diagram.id, title: diagram.title, entityId });
      break;
    }

    case 'add-illustration': {
      const entityId = args[1];
      if (!entityId) fail('Usage: add-illustration <entityId> --title "Title" --imagePath <path> [--htmlSource <path>] [--viewport 1280x800] [--parentIllustration <id>] [--region x,y,w,h]');
      const flags = parseFlags(args.slice(2));
      if (!flags.title) fail('--title is required');
      if (!flags.imagePath) fail('--imagePath is required');

      if (!existsSync(flags.imagePath)) fail(`Image file not found: ${flags.imagePath}`);
      if (flags.htmlSource && !existsSync(flags.htmlSource)) fail(`HTML source not found: ${flags.htmlSource}`);

      const goals = readGoals();
      const entity = findEntityById(goals, entityId);
      if (!entity) fail(`Entity not found: ${entityId}`);

      const now = new Date().toISOString();
      const illustration = {
        id: newId(),
        title: flags.title,
        imagePath: flags.imagePath,
        createdAt: now,
        updatedAt: now,
      };

      if (flags.htmlSource) illustration.htmlSource = flags.htmlSource;

      if (flags.viewport) {
        const [w, h] = flags.viewport.split('x').map(Number);
        if (w && h) illustration.viewport = { width: w, height: h };
      }

      if (flags.parentIllustration) {
        illustration.parentIllustrationId = flags.parentIllustration;
      }

      if (flags.region) {
        const parts = flags.region.split(',').map(Number);
        if (parts.length === 4 && parts.every(n => !isNaN(n))) {
          illustration.region = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        } else {
          fail('--region must be x,y,width,height (4 numbers)');
        }
      }

      if (!Array.isArray(entity.illustrations)) entity.illustrations = [];
      entity.illustrations.push(illustration);

      writeGoals(goals);
      output({ illustrationId: illustration.id, title: illustration.title, entityId });
      break;
    }

    default:
      fail(`Unknown command: ${command}\n\nCommands: validate, update-project, add-major-phase, update-major-phase, get-major-phase, add-phase, update-phase, add-task, update-task, get-task, get-phase, get-phase-full, find-task, add-attempt, update-attempt, update-status, set-pipeline, rollup, rollup-major, rollup-all, get-state, check-deps, stale-tasks, add-diagram, add-illustration`);
  }
} catch (err) {
  fail(err.message);
}
