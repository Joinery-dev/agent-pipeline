/**
 * GET /api/diagrams — Returns all diagrams from .goals.json
 *
 * Collects diagrams from every level: project, majorPhases, phases, tasks.
 * Returns a flat array with source context attached.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export async function GET() {
  const goalsPath = resolve('.goals.json');

  if (!existsSync(goalsPath)) {
    return Response.json([]);
  }

  const goals = JSON.parse(readFileSync(goalsPath, 'utf-8'));
  const diagrams = [];

  function collect(entity, context) {
    if (Array.isArray(entity.diagrams)) {
      for (const d of entity.diagrams) {
        diagrams.push({ ...d, _source: context });
      }
    }
  }

  // Project level
  collect(goals, { type: 'project', name: goals.name });

  // MajorPhase level
  if (Array.isArray(goals.majorPhases)) {
    for (const mp of goals.majorPhases) {
      collect(mp, { type: 'majorPhase', name: mp.title });

      // Phase level
      if (Array.isArray(mp.phases)) {
        for (const phase of mp.phases) {
          collect(phase, { type: 'phase', name: phase.title });

          // Task level
          if (Array.isArray(phase.tasks)) {
            for (const task of phase.tasks) {
              collect(task, { type: 'task', name: task.title });
            }
          }
        }
      }
    }
  }

  // Legacy phases[]
  if (Array.isArray(goals.phases)) {
    for (const phase of goals.phases) {
      collect(phase, { type: 'phase', name: phase.title });
      if (Array.isArray(phase.tasks)) {
        for (const task of phase.tasks) {
          collect(task, { type: 'task', name: task.title });
        }
      }
    }
  }

  return Response.json(diagrams);
}
