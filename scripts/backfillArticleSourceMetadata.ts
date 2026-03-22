import {getAppDatabaseService} from '../src/server/services/appDatabaseService.ts'
import {withDuckdbMaintenanceAccess} from '../src/server/utils/duckdbScriptAccess.ts'

const bucketCount = 128

const getNormalizedSourceSql = (expression: string) => {
  return `CASE
    WHEN lower(trim(coalesce(${expression}, ''))) IN ('arxiv', 'arxiv.org') THEN 'arxiv'
    WHEN lower(trim(coalesce(${expression}, ''))) IN ('medrxiv', 'medrxiv.org') THEN 'medrxiv'
    WHEN lower(trim(coalesce(${expression}, ''))) IN ('biorxiv', 'biorxiv.org') THEN 'biorxiv'
    WHEN lower(trim(coalesce(${expression}, ''))) = 'ppr' THEN 'ppr'
    ELSE NULL
  END`
}

const getFirstFullTextUrlFieldSql = (field: string) => {
  return `coalesce(
    json_extract_string(original_data, '$.fullTextUrlList.fullTextUrl[0].${field}'),
    json_extract_string(original_data, '$.fullTextUrlList.fullTextUrl.${field}')
  )`
}

const journalTitleSql = `coalesce(
  nullif(trim(json_extract_string(original_data, '$.journalInfo.journal.title')), ''),
  nullif(trim(json_extract_string(original_data, '$.journalInfo.title')), ''),
  nullif(trim(json_extract_string(original_data, '$.journal.title')), ''),
  nullif(trim(json_extract_string(original_data, '$."container-title"[0]')), ''),
  nullif(trim(json_extract_string(original_data, '$.containerTitle[0]')), ''),
  nullif(trim(json_extract_string(original_data, '$.host_venue.display_name')), ''),
  nullif(trim(json_extract_string(original_data, '$.primary_location.source.display_name')), ''),
  nullif(trim(json_extract_string(original_data, '$.primary_location.source.host_organization_name')), ''),
  nullif(trim(json_extract_string(original_data, '$.journalTitle')), '')
)`

const preprintSourceSql = `coalesce(
  ${getNormalizedSourceSql("json_extract_string(original_data, '$.bookOrReportDetails.publisher')")},
  ${getNormalizedSourceSql("json_extract_string(original_data, '$.server')")},
  ${getNormalizedSourceSql("json_extract_string(original_data, '$.source')")},
  ${getNormalizedSourceSql("json_extract_string(original_data, '$.src')")},
  ${getNormalizedSourceSql(getFirstFullTextUrlFieldSql('site'))},
  ${getNormalizedSourceSql(getFirstFullTextUrlFieldSql('documentStyle'))},
  CASE
    WHEN lower(coalesce(article_id, '')) LIKE 'oai:arxiv.org:%' THEN 'arxiv'
    WHEN lower(split_part(coalesce(article_id, ''), ':', 1)) IN ('arxiv', 'medrxiv', 'biorxiv', 'ppr')
      THEN lower(split_part(coalesce(article_id, ''), ':', 1))
    WHEN lower(coalesce(import_route, '')) LIKE '%/arxiv%' THEN 'arxiv'
    WHEN lower(coalesce(import_route, '')) LIKE '%/medrxiv%' THEN 'medrxiv'
    WHEN lower(coalesce(import_route, '')) LIKE '%/biorxiv%' THEN 'biorxiv'
    WHEN lower(coalesce(import_route, '')) LIKE '%/europe-pmc-ppr%' THEN 'ppr'
    ELSE NULL
  END
)`

const getPreprintHostLabelSql = (expression: string) => {
  return `CASE
    WHEN lower(trim(coalesce(${expression}, ''))) IN ('arxiv', 'arxiv.org') THEN 'arXiv'
    WHEN lower(trim(coalesce(${expression}, ''))) IN ('medrxiv', 'medrxiv.org') THEN 'medRxiv'
    WHEN lower(trim(coalesce(${expression}, ''))) IN ('biorxiv', 'biorxiv.org') THEN 'bioRxiv'
    WHEN lower(trim(coalesce(${expression}, ''))) IN ('ppr', 'doi', 'doi.org', 'europe pmc', 'europepmc') THEN NULL
    ELSE nullif(trim(coalesce(${expression}, '')), '')
  END`
}

const preprintHostLabelSql = `coalesce(
  ${getPreprintHostLabelSql("json_extract_string(original_data, '$.bookOrReportDetails.publisher')")},
  ${getPreprintHostLabelSql("json_extract_string(original_data, '$.server')")},
  ${getPreprintHostLabelSql(getFirstFullTextUrlFieldSql('site'))},
  ${getPreprintHostLabelSql(getFirstFullTextUrlFieldSql('documentStyle'))},
  ${getPreprintHostLabelSql("json_extract_string(original_data, '$.source')")},
  ${getPreprintHostLabelSql("json_extract_string(original_data, '$.src')")},
  CASE
    WHEN ${preprintSourceSql} = 'arxiv' THEN 'arXiv'
    WHEN ${preprintSourceSql} = 'medrxiv' THEN 'medRxiv'
    WHEN ${preprintSourceSql} = 'biorxiv' THEN 'bioRxiv'
    ELSE NULL
  END
)`

const isPreprintSql = `(
  ${preprintSourceSql} IS NOT NULL
  OR lower(trim(coalesce(json_extract_string(original_data, '$.source'), ''))) = 'ppr'
  OR lower(trim(coalesce(json_extract_string(original_data, '$.src'), ''))) = 'ppr'
  OR lower(coalesce(cast(json_extract(original_data, '$.pubTypeList.pubType') AS varchar), '')) LIKE '%preprint%'
  OR lower(coalesce(cast(json_extract(original_data, '$.versionList.version') AS varchar), '')) LIKE '%preprint%'
)`

const fullTextLinksSql = `coalesce(json_extract(original_data, '$.fullTextUrlList.fullTextUrl'), json('[]'))`

const getRemainingCount = async () => {
  const [row] = await getAppDatabaseService().queryJson<{remainingCount: number}>(`
    SELECT COUNT(*) AS remainingCount
    FROM app.article
    WHERE source_metadata IS NULL
      AND original_data IS NOT NULL
  `)

  return Number(row?.remainingCount ?? 0)
}

const getBackfillBucketSql = (bucketIndex: number) => {
  return `
    WITH source_rows AS (
      SELECT
        id,
        json_object(
          'journalTitle', ${journalTitleSql},
          'preprintSource', ${preprintSourceSql},
          'preprintHostLabel', ${preprintHostLabelSql},
          'isPreprint', ${isPreprintSql},
          'fullTextLinks', ${fullTextLinksSql}
        ) AS source_metadata_json
      FROM app.article
      WHERE source_metadata IS NULL
        AND original_data IS NOT NULL
        AND hash(id) % ${bucketCount} = ${bucketIndex}
    )
    UPDATE app.article AS article
    SET source_metadata = source_rows.source_metadata_json
    FROM source_rows
    WHERE article.id = source_rows.id;
  `
}

const processBucket = async (bucketIndex: number): Promise<void> => {
  if (bucketIndex >= bucketCount) {
    return
  }

  console.log(`[backfillArticleSourceMetadata] bucket ${bucketIndex + 1}/${bucketCount}`)
  await getAppDatabaseService().run(getBackfillBucketSql(bucketIndex))

  if ((bucketIndex + 1) % 8 === 0 || bucketIndex === bucketCount - 1) {
    console.log(`[backfillArticleSourceMetadata] remaining rows: ${await getRemainingCount()}`)
  }

  return processBucket(bucketIndex + 1)
}

const runBackfillArticleSourceMetadata = async () => {
  await withDuckdbMaintenanceAccess('backfill article source metadata', async () => {
    const beforeCount = await getRemainingCount()

    if (beforeCount === 0) {
      console.log('[backfillArticleSourceMetadata] no rows need backfill')
      return
    }

    console.log(`[backfillArticleSourceMetadata] rows before backfill: ${beforeCount}`)
    await getAppDatabaseService().run('SET threads = 4')
    await processBucket(0)
    await getAppDatabaseService().maintenance('checkpoint')
    console.log(`[backfillArticleSourceMetadata] rows after backfill: ${await getRemainingCount()}`)
  })
}

if (import.meta.main) {
  await runBackfillArticleSourceMetadata()
}
