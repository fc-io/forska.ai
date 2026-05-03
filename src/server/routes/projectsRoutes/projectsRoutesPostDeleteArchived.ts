import {Elysia, t} from 'elysia'

import {getArchivedProjectCleanupService} from '../../services/archivedProjectCleanupService.ts'

export const projectsRoutesPostDeleteArchived = new Elysia().post(
  '/api/projects/delete-archived',
  async ({body}) => {
    await getArchivedProjectCleanupService().requestArchivedProjectDeletePending(body.projectIds)

    return {success: true}
  },
  {body: t.Object({projectIds: t.Array(t.String())})},
)
