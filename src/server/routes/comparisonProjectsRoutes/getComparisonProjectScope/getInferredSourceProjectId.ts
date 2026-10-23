import {projectImportRouteTable, projectPromptTable, projectTable} from '../comparisonProjectRouteConstants.ts'
import {appDatabaseService} from '../comparisonProjectRouteServices.ts'
import type {AppQueryRunner} from '../comparisonProjectRouteTypes.ts'
import type {ComparisonProjectPromptConfig} from '../comparisonProjectScopeTypes.ts'
import {getBooleanLiteral, getInClause} from '../comparisonProjectSqlClauses.ts'

const getSortedUniqueStringValues = (values: string[]) => {
  return Array.from(new Set(values)).sort((left, right) => {
    return left.localeCompare(right)
  })
}

const getHasSameStringValues = (left: string[], right: string[]) => {
  const leftValues = getSortedUniqueStringValues(left)
  const rightValues = getSortedUniqueStringValues(right)

  return (
    leftValues.length === rightValues.length
    && leftValues.every((value, index) => {
      return value === rightValues[index]
    })
  )
}

const getNormalizedComparisonScopeName = (value: string) => {
  return value.trim().toLowerCase()
}

export const getInferredSourceProjectId = async (
  comparisonProjectRow: {
    name: string
    useTitle: boolean
    useAbstract: boolean
    useFulltext: boolean
    useFulltextNoImages: boolean
  },
  promptConfigs: ComparisonProjectPromptConfig[],
  importRouteIds: string[],
  queryRunner: AppQueryRunner = appDatabaseService,
) => {
  if (promptConfigs.length === 0) {
    return null
  }

  const candidateProjects = await queryRunner.queryJson<{id: string; name: string}>(`
    SELECT
      id,
      name
    FROM ${projectTable}
    WHERE use_title = ${getBooleanLiteral(comparisonProjectRow.useTitle)}
      AND use_abstract = ${getBooleanLiteral(comparisonProjectRow.useAbstract)}
      AND use_fulltext = ${getBooleanLiteral(comparisonProjectRow.useFulltext)}
      AND use_fulltext_no_images = ${getBooleanLiteral(comparisonProjectRow.useFulltextNoImages)}
  `)

  if (candidateProjects.length === 0) {
    return null
  }

  const candidateProjectIds = candidateProjects.map((candidateProject) => {
    return candidateProject.id
  })
  const candidatePromptRows = await queryRunner.queryJson<{projectId: string; promptId: string}>(`
      SELECT project_id AS projectId, prompt_id AS promptId
      FROM ${projectPromptTable}
      WHERE project_id IN (${getInClause(candidateProjectIds)})
        AND enabled = TRUE
    `)
  const candidateRouteRows = await queryRunner.queryJson<{projectId: string; importRouteId: string}>(`
      SELECT project_id AS projectId, import_route_id AS importRouteId
      FROM ${projectImportRouteTable}
      WHERE project_id IN (${getInClause(candidateProjectIds)})
    `)
  const promptIdsByProjectId = candidatePromptRows.reduce<Map<string, string[]>>((rowMap, promptRow) => {
    const currentPromptIds = rowMap.get(promptRow.projectId) ?? []
    currentPromptIds.push(promptRow.promptId)
    rowMap.set(promptRow.projectId, currentPromptIds)
    return rowMap
  }, new Map<string, string[]>())
  const routeIdsByProjectId = candidateRouteRows.reduce<Map<string, string[]>>((rowMap, routeRow) => {
    const currentRouteIds = rowMap.get(routeRow.projectId) ?? []
    currentRouteIds.push(routeRow.importRouteId)
    rowMap.set(routeRow.projectId, currentRouteIds)
    return rowMap
  }, new Map<string, string[]>())
  const comparisonPromptIds = promptConfigs.map((promptConfig) => {
    return promptConfig.id
  })
  const exactCandidates = candidateProjects.filter((candidateProject) => {
    const candidatePromptIds = promptIdsByProjectId.get(candidateProject.id) ?? []
    const candidateRouteIds = routeIdsByProjectId.get(candidateProject.id) ?? []

    return (
      getHasSameStringValues(candidatePromptIds, comparisonPromptIds)
      && getHasSameStringValues(candidateRouteIds, importRouteIds)
    )
  })
  const comparisonProjectName = getNormalizedComparisonScopeName(comparisonProjectRow.name)
  const nameMatchedCandidates = exactCandidates.filter((candidateProject) => {
    const candidateProjectName = getNormalizedComparisonScopeName(candidateProject.name)

    return (
      candidateProjectName.length > 0
      && (comparisonProjectName === candidateProjectName
        || comparisonProjectName.startsWith(`${candidateProjectName} |`)
        || comparisonProjectName.includes(candidateProjectName))
    )
  })
  const [matchedCandidate] = nameMatchedCandidates

  return nameMatchedCandidates.length === 1 ? (matchedCandidate?.id ?? null) : null
}
