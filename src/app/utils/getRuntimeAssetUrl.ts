import {getApiRequestUrl} from './getApiRequestUrl.ts'

export const getRuntimeAssetUrl = (assetPath: string, locationOrigin?: string | null) => {
  const query = new URLSearchParams({path: assetPath}).toString()

  return `${getApiRequestUrl('/api/runtime-asset', locationOrigin)}?${query}`
}
