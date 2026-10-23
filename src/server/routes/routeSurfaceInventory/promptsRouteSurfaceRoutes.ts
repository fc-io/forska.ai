import type {RouteSurfaceRoute} from './routeSurfaceInventoryTypes.ts'
import {ownerDependentMaintenance, ownerDependentProduct} from './routeSurfaceRouteGroups.ts'

export const promptsRouteSurfaceRoutes: RouteSurfaceRoute[] = [
  ...ownerDependentProduct('PromptsRoutes.ts', [
    ['GET', '/api/prompts'],
    ['GET', '/api/prompts/archived'],
    ['PATCH', '/api/prompts/:id'],
  ]),
  ...ownerDependentMaintenance(
    'PromptsRoutes.ts',
    'Prompt deduplication, hash regeneration, merge, delete, and invalid judgment cleanup.',
    [
      ['GET', '/api/prompts/duplicates'],
      ['POST', '/api/prompts/regenerate-hashes'],
      ['DELETE', '/api/prompts/:id'],
      ['GET', '/api/prompts/orphans'],
      ['POST', '/api/prompts/merge'],
      ['GET', '/api/prompts/invalid-judgments'],
      ['POST', '/api/prompts/delete-invalid-judgments'],
    ],
  ),
]
