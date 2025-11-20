import {createHash} from 'crypto'

const normalizeTextForHash = (t: string | null | undefined): string => {
  const s = t == null ? '' : String(t)
  const unified = s.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const trimmed = unified.trim()
  return trimmed.replace(/\s+$/u, '')
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
