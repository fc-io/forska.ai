import {useQuery} from '@tanstack/solid-query'
import {useNavigate} from '@tanstack/solid-router'
import {type Accessor, createEffect} from 'solid-js'

import {fetchProjectAccess} from '../../../services/projectsService.ts'
import {appQueryClient} from '../../queryClient'

export const useProjectAccessQuery = (
  projectId: () => string,
  queryClient: Accessor<typeof appQueryClient> = () => {
    return appQueryClient
  },
) => {
  return useQuery(() => {
    return {
      queryKey: ['project', projectId(), 'access'],
      queryFn: () => {
        return fetchProjectAccess(projectId())
      },
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    }
  }, queryClient)
}

export const useArchivedProjectRedirect = (projectAccessQuery: ReturnType<typeof useProjectAccessQuery>) => {
  const navigate = useNavigate()

  createEffect(() => {
    if (projectAccessQuery.data?.archived) {
      void navigate({to: '/projects/archived'})
    }
  })
}
