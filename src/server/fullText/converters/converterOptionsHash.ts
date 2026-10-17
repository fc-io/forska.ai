import {createHash} from 'node:crypto'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getSortedValue = (value: unknown): unknown => {
  return Array.isArray(value)
    ? value.map(getSortedValue)
    : isRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => {
              return [key, getSortedValue(value[key])]
            }),
        )
      : value
}

export const getConverterOptionsHash = (options: Record<string, unknown>): string => {
  return createHash('sha256')
    .update(JSON.stringify(getSortedValue(options)))
    .digest('hex')
}
