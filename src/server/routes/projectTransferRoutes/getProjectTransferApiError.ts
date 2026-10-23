import type {ProjectTransferApiResponse} from '../../services/projectTransfer/projectTransferContracts.ts'
import type {RouteSet} from './projectTransferRouteTypes.ts'

export const getProjectTransferApiError = <TData>(
  set: RouteSet,
  status: number,
  error: string,
): ProjectTransferApiResponse<TData> => {
  set.status = status
  return {data: null, error}
}
