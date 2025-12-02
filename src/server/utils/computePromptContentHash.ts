import {createHash} from 'crypto'

const trimEdgeSpaces = (value: string) => {
  const withoutLeadingSpaces = value.replace(/^ +/, '')
  return withoutLeadingSpaces.replace(/ +$/, '')
}

const normalizeTextForHash = (value: string | null | undefined): string => {
  const source = value == null ? '' : String(value)
  const unified = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const withoutEdgeSpaces = trimEdgeSpaces(unified)
  return withoutEdgeSpaces.replace(/\s+$/u, '')
}

export const computePromptContentHash = (
  orig: string,
  trans: string | null | undefined,
  heading: string | null | undefined,
  type: string | null | undefined,
): string => {
  const src = [
    normalizeTextForHash(orig),
    normalizeTextForHash(trans ?? ''),
    normalizeTextForHash(heading ?? ''),
    normalizeTextForHash(type ?? ''),
  ].join('|')
  return createHash('md5').update(src).digest('hex')
}
