import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getDataSourcesWorkloadContext} from './getDataSourcesWorkloadContext.ts'
import {updateDataSourceTx} from './updateDataSourceTx.ts'

export const dataSourcesRoutesDeleteDataSource = async ({params}: {params: {id: string}}) => {
  const archived = await getAppDatabaseService().transaction(
    async (tx) => {
      return updateDataSourceTx(tx, {
        dataSourceId: params.id,
        updateParts: ['archived = TRUE', 'updated_at = current_timestamp'],
      })
    },
    getDataSourcesWorkloadContext({operation: 'archiveTransaction'}),
  )

  if (!archived) {
    throw new Error('Data source not found')
  }

  return {success: true, id: archived.id}
}
