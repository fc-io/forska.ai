import {t} from 'elysia'

import {fullTextChunkPolicyBodySchema, fullTextFigureModeBodySchema} from './projectFullTextSettings.ts'
import {systemPromptVariantBodySchema} from './systemPromptVariantBodySchema.ts'

export const projectsRoutesPostCreateBody = t.Object({
  name: t.String(),
  description: t.Optional(t.String()),
  modelId: t.String(),
  dateFrom: t.Optional(t.String()),
  dateTo: t.Optional(t.String()),
  useTitle: t.Optional(t.Boolean()),
  useAbstract: t.Optional(t.Boolean()),
  useFulltext: t.Optional(t.Boolean()),
  useMetadata: t.Optional(t.Boolean()),
  fullTextFigureMode: t.Optional(t.Union([fullTextFigureModeBodySchema, t.Null()])),
  fullTextChunkPolicy: t.Optional(t.Union([fullTextChunkPolicyBodySchema, t.Null()])),
  systemPromptVariant: t.Optional(systemPromptVariantBodySchema),
  importRoutes: t.Optional(t.Array(t.String())),
  prompts: t.Optional(
    t.Union([
      t.Array(t.String()),
      t.Array(
        t.Object({
          content: t.String(),
          promptHeading: t.Optional(t.String()),
          type: t.Optional(t.String()),
          order: t.Number(),
        }),
      ),
    ]),
  ),
  existingPromptIds: t.Optional(t.Array(t.Object({originalId: t.String(), order: t.Number()}))),
})
