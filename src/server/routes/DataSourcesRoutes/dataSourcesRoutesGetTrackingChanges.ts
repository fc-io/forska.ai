import {getDataSourceArticleChangeLogRepository} from '../../services/dataSourceTrackingRepository.ts'
import {
  dataSourceArticleChangeKinds,
  dataSourceArticleChangeRunKinds,
} from './dataSourcesRoutesGetTrackingChanges/dataSourceArticleChangeKinds.ts'
import {parseBoundedInteger, parseEnumList} from './dataSourcesRoutesGetTrackingChanges/queryParsers.ts'
import {
  decodeTrackingChangeCursor,
  encodeTrackingChangeCursor,
} from './dataSourcesRoutesGetTrackingChanges/trackingChangeCursor.ts'

export const dataSourcesRoutesGetTrackingChanges = async ({
  params,
  query,
}: {
  params: {id: string}
  query: {after?: string; changeKind?: string; limit?: string; runKind?: string}
}) => {
  const limit = parseBoundedInteger(query.limit, 50, 1, 100)
  const after = decodeTrackingChangeCursor(query.after)
  const changes = await getDataSourceArticleChangeLogRepository().listChanges({
    after,
    changeKinds: parseEnumList(query.changeKind, dataSourceArticleChangeKinds),
    dataSourceId: params.id,
    limit: limit + 1,
    runKinds: parseEnumList(query.runKind, dataSourceArticleChangeRunKinds),
  })
  const items = changes.slice(0, limit)
  const hasMore = changes.length > limit
  const lastItem = items.at(-1)

  return {
    data: {
      after: query.after ?? null,
      hasMore,
      items,
      limit,
      nextCursor: hasMore && lastItem ? encodeTrackingChangeCursor(lastItem) : null,
    },
  }
}
