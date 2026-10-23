import type {ProjectBound} from './subprojectTypes.ts'

export const getSubprojectUseMetadata = (projectBounds: ProjectBound[]) => {
  return (
    projectBounds.length > 0
    && projectBounds.every((project) => {
      return project.useMetadata
    })
  )
}
