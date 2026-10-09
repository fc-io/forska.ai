import {getRouterHistoryMode} from '../app/getRouterHistoryMode.ts'

type LocationSearchSource = {hash: string; pathname: string; protocol: string; search: string}

type HashRouteParts = {fragment: string; path: string; search: string}

const getHashRouteParts = (hash: string): HashRouteParts => {
  const [pathAndSearch = '', ...fragmentParts] = hash.split('#').slice(1)
  const searchIndex = pathAndSearch.indexOf('?')
  const path = searchIndex === -1 ? pathAndSearch : pathAndSearch.slice(0, searchIndex)
  const search = searchIndex === -1 ? '' : pathAndSearch.slice(searchIndex)
  const fragment = fragmentParts.length === 0 ? '' : `#${fragmentParts.join('#')}`

  return {fragment, path: path === '' ? '/' : path, search}
}

const getSearchSuffix = (search: string) => {
  const normalizedSearch = search.startsWith('?') ? search.slice(1) : search

  return normalizedSearch === '' ? '' : `?${normalizedSearch}`
}

const getIsHashLocation = (location: LocationSearchSource) => {
  return getRouterHistoryMode(location.protocol) === 'hash'
}

export const getLocationSearch = (location: LocationSearchSource): string => {
  return getIsHashLocation(location) ? getHashRouteParts(location.hash).search : location.search
}

const getHashLocationHrefWithSearch = (location: LocationSearchSource, search: string) => {
  const hashRouteParts = getHashRouteParts(location.hash)

  return `${location.pathname}${location.search}#${hashRouteParts.path}${getSearchSuffix(search)}${hashRouteParts.fragment}`
}

export const getLocationHrefWithSearch = (location: LocationSearchSource, search: string): string => {
  return getIsHashLocation(location)
    ? getHashLocationHrefWithSearch(location, search)
    : `${location.pathname}${getSearchSuffix(search)}`
}
