import {getClickhouseClient} from './clickhouseClient.ts'

export const ensureClickhouseArticlesTable = async (): Promise<void> => {
  const client = getClickhouseClient()

  await client.command({query: 'CREATE DATABASE IF NOT EXISTS forska'})

  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS forska.articles (
        id String,
        created_at DateTime64(6, 'UTC'),
        updated_at DateTime64(6, 'UTC'),
        article_title String,
        article_created_at Nullable(DateTime64(6, 'UTC')),
        article_updated_at Nullable(DateTime64(6, 'UTC')),
        article_id Nullable(String),
        article_summary Nullable(String),
        article_version Nullable(Int32),
        arxiv_id Nullable(String),
        doi Nullable(String),
        pubmed_id Nullable(String),
        url Nullable(String),
        content_hash Nullable(String),
        import_route Nullable(String),
        imported_by Nullable(String),
        publication_status Nullable(String),
        full_text Nullable(String),
        full_text_source Nullable(String),
        full_text_original_format Nullable(String),
        full_text_pdf Nullable(String),
        full_text_fetched_at Nullable(DateTime64(6, 'UTC')),
        openalex_id Nullable(String),
        biorxiv_id Nullable(String),
        medrxiv_id Nullable(String),
        full_text_conversion_status Nullable(String),
        full_text_conversion_error Nullable(String),
        full_text_conversion_attempts Nullable(Int32),
        full_text_char_count Nullable(Int32),
        full_text_html Nullable(String),
        full_text_pdf_uploaded_by Nullable(String)
      ) ENGINE = ReplacingMergeTree(updated_at)
      PARTITION BY toYYYYMM(created_at)
      ORDER BY (id)
    `,
  })

  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS forska.articles_stats (
        month UInt32,
        uniqueCount AggregateFunction(uniqCombined64, UInt64),
        maxUpdatedAt AggregateFunction(max, DateTime64(6, 'UTC'))
      ) ENGINE = AggregatingMergeTree()
      PARTITION BY month
      ORDER BY month
    `,
  })

  await client.command({
    query: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS forska.articles_stats_mv
      TO forska.articles_stats
      POPULATE
      AS
      SELECT
        toYYYYMM(created_at) as month,
        uniqCombined64State(cityHash64(id)) as uniqueCount,
        maxState(updated_at) as maxUpdatedAt
      FROM forska.articles
      GROUP BY month
    `,
  })
}
