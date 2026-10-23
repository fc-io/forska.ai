import {getProjectAccess} from './projectAccessGuard.ts'

export const projectsRoutesGetAccess = async ({params}: {params: {id: string}}) => {
  const project = await getProjectAccess(params.id)

  if (!project) {
    throw new Error('Project not found')
  }

  return {data: project}
}
