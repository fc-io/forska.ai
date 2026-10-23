import {t} from 'elysia'

export const projectsRoutesGetProjectQuery = t.Object({includeImportablePrompts: t.Optional(t.String())})
