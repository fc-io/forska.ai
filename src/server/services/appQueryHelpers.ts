export const escapeSqlString = (value: string) => {
  return value.replaceAll("'", "''")
}

export const getQuotedStringList = (values: string[]) => {
  return values.map((value) => {
    return `'${escapeSqlString(value)}'`
  })
}

export const getTimestampLiteral = (value: Date) => {
  return `TIMESTAMPTZ '${escapeSqlString(value.toISOString())}'`
}

export const getSqlLiteral = (value: unknown): string => {
  return value === null || value === undefined
    ? 'NULL'
    : typeof value === 'string'
      ? `'${escapeSqlString(value)}'`
      : typeof value === 'boolean'
        ? value
          ? 'TRUE'
          : 'FALSE'
        : typeof value === 'number'
          ? Number.isFinite(value)
            ? String(value)
            : 'NULL'
          : typeof value === 'bigint'
            ? String(value)
            : value instanceof Date
              ? getTimestampLiteral(value)
              : Array.isArray(value)
                ? `[${value
                    .map((entry) => {
                      return getSqlLiteral(entry)
                    })
                    .join(', ')}]`
                : `'${escapeSqlString(JSON.stringify(value))}'`
}

export const getProjectScopeClause = (params: {articleAlias: string; importRouteIds: string[]; projectId: string}) => {
  const routeClause =
    params.importRouteIds.length > 0
      ? `EXISTS (
          SELECT 1
          FROM app.article_import_route air
          WHERE air.article_id = ${params.articleAlias}.id
            AND air.import_route_id IN (${getQuotedStringList(params.importRouteIds).join(', ')})
        )`
      : null
  const curatedClause = `EXISTS (
    SELECT 1
    FROM app.project_article pa
    WHERE pa.article_id = ${params.articleAlias}.id
      AND pa.project_id = '${escapeSqlString(params.projectId)}'
  )`

  return routeClause ? `(${routeClause} OR ${curatedClause})` : curatedClause
}

type JudgmentConfig = {
  modelId: string | null
  useTitle: boolean
  useAbstract: boolean
  useFulltext: boolean
  useFulltextNoImages: boolean
}

export const getAndClause = (parts: Array<string | null | undefined | false>) => {
  const filteredParts = parts.filter((part): part is string => {
    return Boolean(part)
  })

  return filteredParts.length > 1 ? `(${filteredParts.join(' AND ')})` : (filteredParts[0] ?? null)
}

export const getOrClause = (parts: Array<string | null | undefined | false>) => {
  const filteredParts = parts.filter((part): part is string => {
    return Boolean(part)
  })

  return filteredParts.length > 1 ? `(${filteredParts.join(' OR ')})` : (filteredParts[0] ?? null)
}

export const getJudgmentConfigClause = (params: {judgmentAlias: string; configs: JudgmentConfig[]}) => {
  return getOrClause(
    params.configs.map((config) => {
      return getAndClause([
        `${params.judgmentAlias}.model_id = ${getSqlLiteral(config.modelId)}`,
        `${params.judgmentAlias}.use_title = ${getSqlLiteral(config.useTitle)}`,
        `${params.judgmentAlias}.use_abstract = ${getSqlLiteral(config.useAbstract)}`,
        `${params.judgmentAlias}.use_fulltext = ${getSqlLiteral(config.useFulltext)}`,
        `${params.judgmentAlias}.use_fulltext_no_images = ${getSqlLiteral(config.useFulltextNoImages)}`,
      ])
    }),
  )
}

export const getDateValue = (value: unknown) => {
  const parsedDate =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
        ? new Date(typeof value === 'bigint' ? Number(value) : value)
        : null

  return parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null
}

export const getJsonValue = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value
  }

  try {
    return getJsonValue(JSON.parse(value) as unknown)
  } catch {
    return value
  }
}
