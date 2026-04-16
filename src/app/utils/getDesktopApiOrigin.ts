const getTrimmedValue = (value: string | null | undefined): string | null => {
  const normalizedValue = String(value ?? '').trim()

  return normalizedValue === '' ? null : normalizedValue
}

const trimTrailingSlash = (value: string | null): string | null => {
  return value ? value.replace(/\/+$/, '') : null
}

const getDesktopApiOriginFromLocation = (): string | null => {
  if (typeof window === 'undefined') {
    return null
  }

  return trimTrailingSlash(getTrimmedValue(new URLSearchParams(window.location.search).get('apiOrigin')))
}

export const getDesktopApiOrigin = (): string | null => {
  if (typeof window === 'undefined') {
    return null
  }

  return trimTrailingSlash(getTrimmedValue(window.__FORSKA_DESKTOP_API_ORIGIN__)) ?? getDesktopApiOriginFromLocation()
}
