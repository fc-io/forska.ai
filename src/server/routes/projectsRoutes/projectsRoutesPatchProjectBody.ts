import {t} from 'elysia'

export const projectsRoutesPatchProjectBody = t.Object({
  name: t.Optional(t.String()),
  description: t.Optional(t.Union([t.String(), t.Null()])),
})
