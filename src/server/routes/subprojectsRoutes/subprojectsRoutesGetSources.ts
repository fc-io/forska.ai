import {getAppDatabaseService} from '../../services/appDatabaseService.ts'

type ProjectWithPrompts = {
  id: string
  name: string
  description: string | null
  modelId: string
  modelName: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
  useMetadata: boolean
  prompts: Array<{id: string; promptHeading: string | null; originalText: string; type: string | null}>
}

export const subprojectsRoutesGetSources = async () => {
  const appDatabaseService = getAppDatabaseService()
  const [projectsList, projectPromptsList] = await Promise.all([
    appDatabaseService.queryJson<{
      id: string
      name: string
      description: string | null
      modelId: string
      modelName: string | null
      useTitle: boolean | null
      useAbstract: boolean | null
      useFulltext: boolean | null
      useFulltextNoImages: boolean | null
      useMetadata: boolean | null
    }>(`
        SELECT
          p.id AS id,
          p.name AS name,
          p.description AS description,
          p.model_id AS modelId,
          COALESCE(m.display_name, m.name, m.remote_model_id) AS modelName,
          p.use_title AS useTitle,
          p.use_abstract AS useAbstract,
          p.use_fulltext AS useFulltext,
          p.use_fulltext_no_images AS useFulltextNoImages,
          COALESCE(p.use_metadata, FALSE) AS useMetadata
        FROM app.project p
        INNER JOIN app.model m ON p.model_id = m.id
        WHERE p.archived = FALSE
        ORDER BY p.name ASC
      `),
    appDatabaseService.queryJson<{
      projectId: string
      id: string
      promptHeading: string | null
      originalText: string
      type: string | null
    }>(`
        SELECT
          pp.project_id AS projectId,
          p.id AS id,
          p.prompt_heading AS promptHeading,
          p.original_text AS originalText,
          p.type AS type
        FROM app.project_prompt pp
        INNER JOIN app.prompt p ON pp.prompt_id = p.id
        WHERE pp.enabled = TRUE
        ORDER BY pp.prompt_order ASC NULLS LAST
      `),
  ])
  const promptsByProjectId = projectPromptsList.reduce<Map<string, typeof projectPromptsList>>((map, row) => {
    const currentRows = map.get(row.projectId) ?? []
    currentRows.push(row)
    map.set(row.projectId, currentRows)
    return map
  }, new Map<string, typeof projectPromptsList>())
  const projectsWithPrompts = projectsList.reduce<ProjectWithPrompts[]>((result, project) => {
    const projectPrompts = promptsByProjectId.get(project.id) ?? []

    return projectPrompts.length > 0
      ? [
          ...result,
          {
            id: project.id,
            name: project.name,
            description: project.description,
            modelId: project.modelId,
            modelName: project.modelName,
            useTitle: project.useTitle ?? true,
            useAbstract: project.useAbstract ?? true,
            useFulltext: project.useFulltext ?? false,
            useFulltextNoImages: project.useFulltextNoImages ?? false,
            useMetadata: project.useMetadata ?? false,
            prompts: projectPrompts.map((prompt) => {
              return {
                id: prompt.id,
                promptHeading: prompt.promptHeading,
                originalText: prompt.originalText,
                type: prompt.type,
              }
            }),
          },
        ]
      : result
  }, [])

  return {data: projectsWithPrompts}
}
