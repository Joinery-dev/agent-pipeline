/**
 * GET /api/illustrations — Returns all illustrations from .goals.json
 *
 * Collects illustrations from every level: project, majorPhases, phases.
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
  const illustrations = [];

  function collect(entity, context) {
    if (Array.isArray(entity.illustrations)) {
      for (const ill of entity.illustrations) {
        illustrations.push({ ...ill, _source: context });
      }
    }
  }

  // Project level
  collect(goals, { type: 'project', name: goals.name });

  // MajorPhase level
  if (Array.isArray(goals.majorPhases)) {
    for (const mp of goals.majorPhases) {
      collect(mp, { type: 'majorPhase', name: mp.title });

      if (Array.isArray(mp.phases)) {
        for (const phase of mp.phases) {
          collect(phase, { type: 'phase', name: phase.title });
        }
      }
    }
  }

  // Legacy phases[]
  if (Array.isArray(goals.phases)) {
    for (const phase of goals.phases) {
      collect(phase, { type: 'phase', name: phase.title });
    }
  }

  return Response.json(illustrations);
}
