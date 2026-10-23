import {t} from 'elysia'

import {fullTextChunkPolicyBodySchema, fullTextFigureModeBodySchema} from './projectFullTextSettings.ts'
import {systemPromptVariantBodySchema} from './systemPromptVariantBodySchema.ts'

export const projectsRoutesPatchEditBody = t.Object({
  name: t.Optional(t.String()),
  description: t.Optional(t.Union([t.String(), t.Null()])),
  dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
  dateTo: t.Optional(t.Union([t.String(), t.Null()])),
  modelId: t.Optional(t.String()),
  humanJudgmentMode: t.Optional(t.Union([t.Literal('prompt'), t.Literal('summary')])),
  systemPromptVariant: t.Optional(systemPromptVariantBodySchema),
  useTitle: t.Optional(t.Boolean()),
  useAbstract: t.Optional(t.Boolean()),
  useFulltext: t.Optional(t.Boolean()),
  useMetadata: t.Optional(t.Boolean()),
  fullTextFigureMode: t.Optional(t.Union([fullTextFigureModeBodySchema, t.Null()])),
  fullTextChunkPolicy: t.Optional(t.Union([fullTextChunkPolicyBodySchema, t.Null()])),
  recordCurrentFullTextStrategy: t.Optional(t.Boolean()),
  importRoutes: t.Optional(t.Array(t.String())),
  prompts: t.Optional(
    t.Array(
      t.Object({
        originalId: t.Optional(t.String()),
        originalText: t.String(),
        promptHeading: t.Optional(t.String()),
        type: t.Optional(t.String()),
        order: t.Number(),
        archived: t.Optional(t.Boolean()),
        enabled: t.Optional(t.Boolean()),
      }),
    ),
  ),
})
