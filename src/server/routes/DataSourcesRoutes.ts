import {Elysia, t} from 'elysia'

import {getAppDatabaseService} from '../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getSqlLiteral} from '../services/appQueryHelpers.ts'
import {getCovidencePackageConfig} from '../services/covidenceImportService.ts'
import {getStructuredFileImportConfig} from '../services/structuredFileImportService.ts'
import {withErrorHandler} from '../utils/routeErrorHandler'

type AppDatabaseService = ReturnType<typeof getAppDatabaseService>
type AppTx = Parameters<AppDatabaseService['transaction']>[0] extends (runner: infer T) => Promise<unknown> ? T : never
type AppQueryRunner = Pick<AppTx, 'queryJson'>
type DataSourceRow = {
  id: string
  title: string
  description: string | null
  importRoute: string | null
  cursor: string | null
  lastImportAt: unknown
  itemsAfterLastImport: number | null
  createdAt: unknown
  updatedAt: unknown
  dateFrom: unknown
  dateTo: unknown
  archived: boolean
}

type CovidenceProjectLinkRow = {importRoute: string; projectId: string}
type CovidencePromptLinkRow = {importRoute: string; promptId: string}
type StructuredFileConfig = NonNullable<ReturnType<typeof getSafeStructuredFileImportConfig>>
type CovidencePackageConfig = NonNullable<ReturnType<typeof getSafeCovidencePackageConfig>>
type DataSourceImportState = {
  covidencePackageConfig: CovidencePackageConfig | null
  immutable: boolean
  linkedProjectId: string | null
  linkedPromptIds: string[]
  reimportable: boolean
  structuredFileConfig: StructuredFileConfig | null
}

const parseOptionalDate = (value?: string | null) => {
  if (!value) {
    return null
  }
  const trimmedValue = value.trim()
  if (!trimmedValue) {
    return null
  }
  const isoDateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/
  const hasIsoDateOnlyMatch = isoDateOnlyPattern.exec(trimmedValue)
  const normalizedValue = hasIsoDateOnlyMatch ? `${trimmedValue}T00:00:00.000Z` : trimmedValue
  const parsedDate = new Date(normalizedValue)
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error('Invalid date value provided')
  }
  return parsedDate
}

const getSafeStructuredFileImportConfig = (cursorValue: unknown) => {
  if (typeof cursorValue !== 'string') {
    return null
  }

  try {
    return getStructuredFileImportConfig(cursorValue)
  } catch {
    return null
  }
}

const getSafeCovidencePackageConfig = (cursorValue: unknown) => {
  return typeof cursorValue === 'string' ? getCovidencePackageConfig(cursorValue) : null
}

const hasMutableDataSourceChanges = (body: {
  title?: string
  description?: string | null
  importRoute?: string | null
  dateFrom?: string | null
  dateTo?: string | null
  archived?: boolean
}) => {
  return [body.title, body.description, body.importRoute, body.dateFrom, body.dateTo].some((value) => {
    return value !== undefined
  })
}

const getCovidenceProjectIdByImportRoute = async (db: AppQueryRunner, importRoutes: string[]) => {
  const rows =
    importRoutes.length === 0
      ? []
      : await db.queryJson<CovidenceProjectLinkRow>(`
        SELECT
          ir.route AS importRoute,
          pir.project_id AS projectId
        FROM app.project_import_route pir
        INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
        WHERE ir.route IN (${importRoutes
          .map((importRoute) => {
            return getSqlLiteral(importRoute)
          })
          .join(', ')})
      `)

  return new Map(
    rows.map((row) => {
      return [row.importRoute, row.projectId]
    }),
  )
}

const getCovidencePromptIdsByImportRoute = async (db: AppQueryRunner, importRoutes: string[]) => {
  const rows =
    importRoutes.length === 0
      ? []
      : await db.queryJson<CovidencePromptLinkRow>(`
        SELECT
          ir.route AS importRoute,
          pp.prompt_id AS promptId
        FROM app.project_import_route pir
        INNER JOIN app.import_route ir ON ir.id = pir.import_route_id
        INNER JOIN app.project_prompt pp ON pp.project_id = pir.project_id
        WHERE ir.route IN (${importRoutes
          .map((importRoute) => {
            return getSqlLiteral(importRoute)
          })
          .join(', ')})
          AND pp.archived = FALSE
          AND pp.enabled = TRUE
        ORDER BY pp.prompt_order ASC, pp.prompt_id ASC
      `)

  return rows.reduce<Map<string, string[]>>((promptIdsByImportRoute, row) => {
    const existingPromptIds = promptIdsByImportRoute.get(row.importRoute) ?? []

    promptIdsByImportRoute.set(row.importRoute, [...existingPromptIds, row.promptId])

    return promptIdsByImportRoute
  }, new Map())
}

const getDataSourceImportState = (params: {
  covidenceProjectIdByImportRoute: Map<string, string>
  covidencePromptIdsByImportRoute: Map<string, string[]>
  importRoute: string | null
  cursor: string | null
}): DataSourceImportState => {
  const structuredFileConfig = getSafeStructuredFileImportConfig(params.cursor)
  const covidencePackageConfig = getSafeCovidencePackageConfig(params.cursor)
  const linkedProjectId =
    covidencePackageConfig && params.importRoute
      ? (params.covidenceProjectIdByImportRoute.get(params.importRoute) ?? null)
      : null
  const linkedPromptIds =
    covidencePackageConfig && params.importRoute
      ? (params.covidencePromptIdsByImportRoute.get(params.importRoute) ?? [])
      : []

  return {
    covidencePackageConfig,
    immutable: Boolean(structuredFileConfig || covidencePackageConfig),
    linkedProjectId,
    linkedPromptIds,
    reimportable: Boolean(covidencePackageConfig),
    structuredFileConfig,
  }
}

const normalizeDataSourceRow = <TRow extends Record<string, unknown>>(
  row: TRow,
  importState: DataSourceImportState,
) => {
  const {cursor, ...safeRow} = row

  return {
    ...safeRow,
    ...importState,
    createdAt: getDateValue(row['createdAt']),
    updatedAt: getDateValue(row['updatedAt']),
    dateFrom: getDateValue(row['dateFrom']),
    dateTo: getDateValue(row['dateTo']),
    lastImportAt: getDateValue(row['lastImportAt']),
  }
}

const normalizeDataSourceRows = async <TRow extends DataSourceRow>(db: AppQueryRunner, rows: TRow[]) => {
  const covidenceImportRoutes = rows.flatMap((row) => {
    return row.importRoute && getSafeCovidencePackageConfig(row.cursor) ? [row.importRoute] : []
  })
  const [covidenceProjectIdByImportRoute, covidencePromptIdsByImportRoute] = await Promise.all([
    getCovidenceProjectIdByImportRoute(db, covidenceImportRoutes),
    getCovidencePromptIdsByImportRoute(db, covidenceImportRoutes),
  ])

  return rows.map((row) => {
    return normalizeDataSourceRow(
      row,
      getDataSourceImportState({
        covidenceProjectIdByImportRoute,
        covidencePromptIdsByImportRoute,
        cursor: row.cursor,
        importRoute: row.importRoute,
      }),
    )
  })
}

const getDataSourceRowSql = (dataSourceId: string) => {
  return `
    SELECT
      id,
      title,
      description,
      import_route AS importRoute,
      cursor,
      last_import_at AS lastImportAt,
      items_after_last_import AS itemsAfterLastImport,
      created_at AS createdAt,
      updated_at AS updatedAt,
      date_from AS dateFrom,
      date_to AS dateTo,
      archived
    FROM app.data_source
    WHERE id = '${escapeSqlString(dataSourceId)}'
    LIMIT 1
  `
}

const getDataSourceRow = async (db: AppQueryRunner, dataSourceId: string) => {
  const [row] = await db.queryJson<DataSourceRow>(getDataSourceRowSql(dataSourceId))
  return row ?? null
}

const updateDataSourceTx = async (tx: AppTx, params: {dataSourceId: string; updateParts: string[]}) => {
  await tx.run(`
    UPDATE app.data_source
    SET ${params.updateParts.join(', ')}
    WHERE id = '${escapeSqlString(params.dataSourceId)}'
  `)

  return getDataSourceRow(tx, params.dataSourceId)
}

export const dataSourcesRoutes = new Elysia()
  .use(withErrorHandler())
  .get('/api/datasources', async () => {
    const rows = await getAppDatabaseService().queryJson<{
      archived: boolean
      id: string
      title: string
      description: string | null
      createdAt: unknown
      updatedAt: unknown
      dateFrom: unknown
      dateTo: unknown
      lastImportAt: unknown
      itemsAfterLastImport: number | null
      importRoute: string | null
      cursor: string | null
    }>(`
      SELECT
        id,
        title,
        description,
        created_at AS createdAt,
        updated_at AS updatedAt,
        date_from AS dateFrom,
        date_to AS dateTo,
        last_import_at AS lastImportAt,
        items_after_last_import AS itemsAfterLastImport,
        import_route AS importRoute,
        cursor,
        archived
      FROM app.data_source
      WHERE archived = FALSE
      ORDER BY created_at DESC
    `)
    return {data: await normalizeDataSourceRows(getAppDatabaseService(), rows)}
  })
  .get('/api/datasources/archived', async () => {
    const rows = await getAppDatabaseService().queryJson<{
      archived: boolean
      id: string
      title: string
      description: string | null
      createdAt: unknown
      updatedAt: unknown
      dateFrom: unknown
      dateTo: unknown
      lastImportAt: unknown
      itemsAfterLastImport: number | null
      importRoute: string | null
      cursor: string | null
    }>(`
      SELECT
        id,
        title,
        description,
        created_at AS createdAt,
        updated_at AS updatedAt,
        date_from AS dateFrom,
        date_to AS dateTo,
        last_import_at AS lastImportAt,
        items_after_last_import AS itemsAfterLastImport,
        import_route AS importRoute,
        cursor,
        archived
      FROM app.data_source
      WHERE archived = TRUE
      ORDER BY created_at DESC
    `)
    return {data: await normalizeDataSourceRows(getAppDatabaseService(), rows)}
  })
  .get('/api/datasources/:id', async ({params}) => {
    const [entry] = await getAppDatabaseService().queryJson<{
      archived: boolean
      id: string
      title: string
      description: string | null
      importRoute: string | null
      cursor: string | null
      lastImportAt: unknown
      itemsAfterLastImport: number | null
      createdAt: unknown
      updatedAt: unknown
      dateFrom: unknown
      dateTo: unknown
    }>(`
      SELECT
        id,
        title,
        description,
        import_route AS importRoute,
        cursor,
        last_import_at AS lastImportAt,
        items_after_last_import AS itemsAfterLastImport,
        created_at AS createdAt,
        updated_at AS updatedAt,
        date_from AS dateFrom,
        date_to AS dateTo,
        archived
      FROM app.data_source
      WHERE id = '${escapeSqlString(params.id)}'
      LIMIT 1
    `)

    if (!entry) {
      throw new Error('Data source not found')
    }

    const [normalizedEntry] = await normalizeDataSourceRows(getAppDatabaseService(), [entry])

    return {data: normalizedEntry}
  })
  .post(
    '/api/datasources',
    async ({body}) => {
      const dateFrom = parseOptionalDate(body.dateFrom)
      const dateTo = parseOptionalDate(body.dateTo)
      if (dateFrom && dateTo && dateFrom > dateTo) {
        throw new Error('date_from must be on or before date_to')
      }

      const [created] = await getAppDatabaseService().queryJson<{
        id: string
        title: string
        description: string | null
        importRoute: string | null
        lastImportAt: unknown
        itemsAfterLastImport: number | null
        createdAt: unknown
        updatedAt: unknown
        dateFrom: unknown
        dateTo: unknown
        archived: boolean
      }>(`
        INSERT INTO app.data_source (id, title, description, import_route, date_from, date_to)
        VALUES (
          '${escapeSqlString(crypto.randomUUID())}',
          ${getSqlLiteral(body.title)},
          ${getSqlLiteral(body.description ?? null)},
          ${getSqlLiteral(body.importRoute ?? null)},
          ${getSqlLiteral(dateFrom)},
          ${getSqlLiteral(dateTo)}
        )
        RETURNING
          id,
          title,
          description,
          import_route AS importRoute,
          last_import_at AS lastImportAt,
          items_after_last_import AS itemsAfterLastImport,
          created_at AS createdAt,
          updated_at AS updatedAt,
          date_from AS dateFrom,
          date_to AS dateTo,
          archived
      `)

      return {
        data: created
          ? normalizeDataSourceRow(created, {
              covidencePackageConfig: null,
              immutable: false,
              linkedProjectId: null,
              linkedPromptIds: [],
              reimportable: false,
              structuredFileConfig: null,
            })
          : null,
      }
    },
    {
      body: t.Object({
        title: t.String(),
        description: t.Optional(t.String()),
        importRoute: t.Optional(t.String()),
        dateFrom: t.Optional(t.String()),
        dateTo: t.Optional(t.String()),
      }),
    },
  )
  .patch(
    '/api/datasources/:id',
    async ({params, body}) => {
      const existing = await getDataSourceRow(getAppDatabaseService(), params.id)

      if (!existing) {
        throw new Error('Data source not found')
      }

      if (
        (getSafeStructuredFileImportConfig(existing.cursor) || getSafeCovidencePackageConfig(existing.cursor))
        && hasMutableDataSourceChanges(body)
      ) {
        throw new Error('Imported XML/JSON data sources are immutable and can only be archived')
      }

      const parsedDateFrom = body.dateFrom === undefined ? undefined : parseOptionalDate(body.dateFrom)
      const parsedDateTo = body.dateTo === undefined ? undefined : parseOptionalDate(body.dateTo)
      if (parsedDateFrom && parsedDateTo && parsedDateFrom > parsedDateTo) {
        throw new Error('date_from must be on or before date_to')
      }
      const updateParts = [
        `updated_at = current_timestamp`,
        body.title !== undefined ? `title = ${getSqlLiteral(body.title)}` : null,
        body.description !== undefined ? `description = ${getSqlLiteral(body.description)}` : null,
        body.importRoute !== undefined ? `import_route = ${getSqlLiteral(body.importRoute)}` : null,
        body.archived !== undefined ? `archived = ${body.archived ? 'TRUE' : 'FALSE'}` : null,
        parsedDateFrom !== undefined ? `date_from = ${getSqlLiteral(parsedDateFrom)}` : null,
        parsedDateTo !== undefined ? `date_to = ${getSqlLiteral(parsedDateTo)}` : null,
      ].filter((part): part is string => {
        return part !== null
      })

      const updated = (await getAppDatabaseService().transaction(async (tx) => {
        return updateDataSourceTx(tx, {dataSourceId: params.id, updateParts})
      })) as DataSourceRow | null

      if (!updated) {
        throw new Error('Data source not found')
      }

      const [normalizedUpdated] = await normalizeDataSourceRows(getAppDatabaseService(), [updated])

      return {data: normalizedUpdated}
    },
    {
      body: t.Object({
        title: t.Optional(t.String()),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        importRoute: t.Optional(t.Union([t.String(), t.Null()])),
        dateFrom: t.Optional(t.Union([t.String(), t.Null()])),
        dateTo: t.Optional(t.Union([t.String(), t.Null()])),
        archived: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete('/api/datasources/:id', async ({params}) => {
    const archived = (await getAppDatabaseService().transaction(async (tx) => {
      return updateDataSourceTx(tx, {
        dataSourceId: params.id,
        updateParts: ['archived = TRUE', 'updated_at = current_timestamp'],
      })
    })) as DataSourceRow | null

    if (!archived) {
      throw new Error('Data source not found')
    }

    return {success: true, id: archived.id}
  })
