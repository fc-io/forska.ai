import type {DataSourceArticleChangeKind, DataSourceArticleChangeRunKind} from '../../../../db/schemaTypes.ts'

export const dataSourceArticleChangeKinds: DataSourceArticleChangeKind[] = [
  'article_added',
  'source_record_changed',
  'canonical_article_changed',
  'source_record_deleted',
  'source_record_restored',
]
export const dataSourceArticleChangeRunKinds: DataSourceArticleChangeRunKind[] = [
  'incremental',
  'automatic_age_bucket',
  'manual_full_range',
]
