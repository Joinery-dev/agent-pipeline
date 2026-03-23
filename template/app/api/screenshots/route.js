/**
 * GET /api/screenshots — Returns all screenshots from .goals.json
 *
 * Collects screenshots from phases, grouped by phase.
 * Returns a flat array with phase context attached.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export async function GET() {
  const goalsPath = resolve('.goals.json');

  if (!existsSync(goalsPath)) {
    return Response.json([]);
  }

  const goals = JSON.parse(readFileSync(goalsPath, 'utf-8'));
  const screenshots = [];

  // Collect from all phases
  if (Array.isArray(goals.majorPhases)) {
    for (const mp of goals.majorPhases) {
      for (const phase of mp.phases || mp.subPhases || []) {
        if (Array.isArray(phase.screenshots)) {
          for (const ss of phase.screenshots) {
            screenshots.push({
              ...ss,
              _phase: { id: phase.id, title: phase.title },
              _majorPhase: { title: mp.title },
            });
          }
        }
      }
    }
  }

  // Legacy phases[]
  if (Array.isArray(goals.phases)) {
    for (const phase of goals.phases) {
      if (Array.isArray(phase.screenshots)) {
        for (const ss of phase.screenshots) {
          screenshots.push({
            ...ss,
            _phase: { id: phase.id, title: phase.title },
          });
        }
      }
    }
  }

  return Response.json(screenshots);
}
