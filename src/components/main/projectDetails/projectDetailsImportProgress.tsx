import {useQuery, useQueryClient} from '@tanstack/solid-query'
import {createEffect, For, on, Show} from 'solid-js'

import {apiClient} from '../../../services/apiClient.ts'
import {getApiErrorMessage} from '../../../services/utils/handleApiResponse.ts'
import {
  type DataSourceImportStatusView,
  normalizeDataSourceImportStatus,
} from '../dataSourceImportStatus/dataSourceImportStatus.ts'
import {DataSourceImportStatusDetails} from '../dataSourceImportStatus/dataSourceImportStatusDetails.tsx'

type DataSourceImportProgress = {importStatus: DataSourceImportStatusView | null; title: string}

const covidenceImportRoutePrefix = 'covidence:'

export const projectImportProgressPollIntervalMs = 5_000

export const getCovidenceDataSourceIds = (importRoutes: readonly string[]) => {
  return importRoutes
    .filter((importRoute) => {
      return importRoute.startsWith(covidenceImportRoutePrefix)
    })
    .map((importRoute) => {
      return importRoute.slice(covidenceImportRoutePrefix.length)
    })
    .filter((dataSourceId) => {
      return dataSourceId !== ''
    })
}

export const getVisibleImportStatus = (importStatus: DataSourceImportStatusView | null | undefined) => {
  return importStatus && importStatus.status !== 'completed' ? importStatus : null
}

export const getProjectImportProgressRefetchInterval = (progress: DataSourceImportProgress | undefined) => {
  return progress?.importStatus?.status === 'running' ? projectImportProgressPollIntervalMs : false
}

export const hasImportJustCompleted = (
  status: DataSourceImportStatusView['status'] | undefined,
  previousStatus: DataSourceImportStatusView['status'] | undefined,
) => {
  return previousStatus === 'running' && status === 'completed'
}

const fetchDataSourceImportProgress = async (dataSourceId: string): Promise<DataSourceImportProgress> => {
  const response = await apiClient.api.datasources({id: dataSourceId}).get()
  const entry = response.data?.data as {importStatus?: unknown; title: string} | null | undefined

  if (response.error || !entry) {
    throw new Error(getApiErrorMessage(response.error, 'Failed to load the data source import status'))
  }

  return {importStatus: normalizeDataSourceImportStatus(entry.importStatus), title: entry.title}
}

const ProjectDetailsDataSourceImportProgress = (props: {dataSourceId: string; projectId: string}) => {
  const queryClient = useQueryClient()
  const progressQuery = useQuery(() => {
    return {
      queryKey: ['datasource-import-progress', props.dataSourceId],
      queryFn: () => {
        return fetchDataSourceImportProgress(props.dataSourceId)
      },
      refetchInterval: (query: {state: {data?: DataSourceImportProgress}}) => {
        return getProjectImportProgressRefetchInterval(query.state.data)
      },
      refetchOnWindowFocus: true,
      suspense: false,
    }
  })

  createEffect(
    on(
      () => {
        return progressQuery.data?.importStatus?.status
      },
      (status, previousStatus) => {
        if (hasImportJustCompleted(status, previousStatus)) {
          void queryClient.invalidateQueries({queryKey: ['project', props.projectId]})
          void queryClient.invalidateQueries({queryKey: ['project-curated-articles', props.projectId]})
        }
      },
    ),
  )

  return (
    <Show when={getVisibleImportStatus(progressQuery.data?.importStatus)}>
      {(importStatus) => {
        return (
          <div class="bg-white rounded-lg shadow p-6">
            <h2 class="text-lg font-semibold mb-2">Covidence import: {progressQuery.data?.title}</h2>
            <DataSourceImportStatusDetails importStatus={importStatus()} />
          </div>
        )
      }}
    </Show>
  )
}

export const ProjectDetailsImportProgress = (props: {importRoutes: readonly string[]; projectId: string}) => {
  return (
    <For each={getCovidenceDataSourceIds(props.importRoutes)}>
      {(dataSourceId) => {
        return <ProjectDetailsDataSourceImportProgress dataSourceId={dataSourceId} projectId={props.projectId} />
      }}
    </For>
  )
}
