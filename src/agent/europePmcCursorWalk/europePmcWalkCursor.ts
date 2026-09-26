const europePmcDateSort = 'FIRST_PDATE_D asc'

export type EuropePmcCursorPosition = {cursorMark: string; fetchedOffset: number | null; sort: string | null}

const europePmcStartCursorMark = '*'
const dateSortedCursorPrefix = 'v2'
const dateSortedCursorPattern = /^v2:(\d+):(\S+)$/u

const getDateSortedPosition = (fetchedOffset: string, cursorMark: string): EuropePmcCursorPosition => {
  return {cursorMark, fetchedOffset: Number.parseInt(fetchedOffset, 10), sort: europePmcDateSort}
}

const getLegacyRelevancePosition = (cursorMark: string): EuropePmcCursorPosition => {
  return {cursorMark, fetchedOffset: null, sort: null}
}

const getSavedCursorPosition = (savedCursor: string): EuropePmcCursorPosition => {
  const match = dateSortedCursorPattern.exec(savedCursor)

  return match?.[1] && match[2] ? getDateSortedPosition(match[1], match[2]) : getLegacyRelevancePosition(savedCursor)
}

export const getEuropePmcCursorPosition = (savedCursor?: string | null): EuropePmcCursorPosition => {
  const normalized = savedCursor?.trim() || europePmcStartCursorMark

  return normalized === europePmcStartCursorMark
    ? getDateSortedPosition('0', europePmcStartCursorMark)
    : getSavedCursorPosition(normalized)
}

export const getSavedEuropePmcCursor = (position: EuropePmcCursorPosition): string => {
  const isDateSortedAfterStart = position.sort !== null && position.cursorMark !== europePmcStartCursorMark

  return isDateSortedAfterStart
    ? `${dateSortedCursorPrefix}:${position.fetchedOffset ?? 0}:${position.cursorMark}`
    : position.cursorMark
}
