import {t} from 'elysia'

export const subprojectsRoutesPostCreateBody = t.Object({
  name: t.String(),
  description: t.Optional(t.String()),
  modelId: t.String(),
  dateFrom: t.Optional(t.String()),
  dateTo: t.Optional(t.String()),
  promptSelections: t.Array(t.Object({promptId: t.String(), types: t.Array(t.String())})),
  sourceProjectIds: t.Array(t.String()),
})
