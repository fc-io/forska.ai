import {escapeSqlString} from '../../services/appQueryHelpers.ts'
import type {AppTx} from './dataSourcesRoutesTypes.ts'
import {getDataSourceRow} from './getDataSourceRow.ts'
import {getDataSourcesWorkloadContext} from './getDataSourcesWorkloadContext.ts'

export const updateDataSourceTx = async (tx: AppTx, params: {dataSourceId: string; updateParts: string[]}) => {
  await tx.run(
    `
    UPDATE app.data_source
    SET ${params.updateParts.join(', ')}
    WHERE id = '${escapeSqlString(params.dataSourceId)}'
  `,
    getDataSourcesWorkloadContext({operation: 'update'}),
  )

  return getDataSourceRow(tx, params.dataSourceId)
}
