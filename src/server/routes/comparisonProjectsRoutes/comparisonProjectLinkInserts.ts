import {getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {
  comparisonProjectImportRouteTable,
  comparisonProjectPromptTable,
  comparisonProjectSourceProjectTable,
  importRouteTable,
  promptTable,
} from './comparisonProjectRouteConstants.ts'
import type {AppTx, PromptSelection} from './comparisonProjectRouteTypes.ts'
import {getInClause} from './comparisonProjectSqlClauses.ts'

const insertComparisonProjectPromptLinks = async (
  tx: AppTx,
  comparisonProjectId: string,
  promptSelections: PromptSelection[],
) => {
  const promptIds = promptSelections.map((selection) => {
    return selection.promptId
  })

  if (promptIds.length === 0) {
    return
  }

  const promptRows = await tx.queryJson<{id: string}>(`
    SELECT id
    FROM ${promptTable}
    WHERE id IN (${getInClause(promptIds)})
  `)

  if (promptRows.length !== promptIds.length) {
    throw new Error('One or more selected prompts are invalid')
  }

  const [currentPromptSelection] = promptSelections

  if (!currentPromptSelection) {
    return
  }

  await tx.run(`
    INSERT INTO ${comparisonProjectPromptTable} (
      id,
      comparison_project_id,
      prompt_id,
      prompt_order,
      criteria_disposition,
      criteria_section_key,
      criteria_section_label
    )
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(comparisonProjectId)},
      ${getSqlLiteral(currentPromptSelection.promptId)},
      ${currentPromptSelection.order},
      ${getSqlLiteral(currentPromptSelection.criteriaDisposition ?? null)},
      ${getSqlLiteral(currentPromptSelection.criteriaSectionKey ?? null)},
      ${getSqlLiteral(currentPromptSelection.criteriaSectionLabel ?? null)}
    )
  `)

  return insertComparisonProjectPromptLinks(tx, comparisonProjectId, promptSelections.slice(1))
}

const insertComparisonProjectRouteLinks = async (tx: AppTx, comparisonProjectId: string, importRoutes: string[]) => {
  if (importRoutes.length === 0) {
    return
  }

  const routeRows = await tx.queryJson<{id: string; route: string}>(`
    SELECT id, route
    FROM ${importRouteTable}
    WHERE route IN (${getInClause(importRoutes)})
  `)

  if (routeRows.length !== importRoutes.length) {
    throw new Error('One or more selected import routes are invalid')
  }

  const [currentRouteRow] = routeRows

  if (!currentRouteRow) {
    return
  }

  await tx.run(`
    INSERT INTO ${comparisonProjectImportRouteTable} (id, comparison_project_id, import_route_id)
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(comparisonProjectId)},
      ${getSqlLiteral(currentRouteRow.id)}
    )
  `)

  return insertComparisonProjectRouteLinks(
    tx,
    comparisonProjectId,
    routeRows.slice(1).map((routeRow) => {
      return routeRow.route
    }),
  )
}

const insertComparisonProjectSourceProjectLinks = async (
  tx: AppTx,
  comparisonProjectId: string,
  sourceProjectIds: string[],
) => {
  const [currentSourceProjectId] = sourceProjectIds

  if (!currentSourceProjectId) {
    return
  }

  await tx.run(`
    INSERT INTO ${comparisonProjectSourceProjectTable} (id, comparison_project_id, source_project_id)
    VALUES (
      ${getSqlLiteral(crypto.randomUUID())},
      ${getSqlLiteral(comparisonProjectId)},
      ${getSqlLiteral(currentSourceProjectId)}
    )
  `)

  return insertComparisonProjectSourceProjectLinks(tx, comparisonProjectId, sourceProjectIds.slice(1))
}

export {
  insertComparisonProjectPromptLinks,
  insertComparisonProjectRouteLinks,
  insertComparisonProjectSourceProjectLinks,
}
