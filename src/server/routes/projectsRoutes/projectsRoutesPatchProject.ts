import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getProjectValue} from './getProjectValue.ts'
import {assertProjectIsActive} from './projectAccessGuard.ts'
import type {projectsRoutesPatchProjectBody} from './projectsRoutesPatchProjectBody.ts'
import {updateProjectTx} from './updateProjectTx.ts'

export const projectsRoutesPatchProject = async ({
  params,
  body,
}: {
  params: {id: string}
  body: typeof projectsRoutesPatchProjectBody.static
}) => {
  await assertProjectIsActive(params.id)

  const updateParts = [
    `updated_at = current_timestamp`,
    body.name !== undefined ? `name = ${getSqlLiteral(body.name)}` : null,
    body.description !== undefined ? `description = ${getSqlLiteral(body.description)}` : null,
  ].filter((part): part is string => {
    return part !== null
  })

  const updatedProject = await getAppDatabaseService().transaction(async (tx) => {
    return updateProjectTx(tx, {projectId: params.id, updateParts})
  })

  if (!updatedProject) {
    throw new Error('Project not found')
  }

  return {data: getProjectValue(updatedProject)}
}
