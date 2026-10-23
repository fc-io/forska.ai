export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const getUnexpectedBodyKey = (value: Record<string, unknown>, allowedKeys: readonly string[]) => {
  return Object.keys(value).find((key) => {
    return !allowedKeys.includes(key)
  })
}

export const parseRequestBody = <TValue>(
  body: unknown,
  shape: (value: unknown) => unknown,
  allowedKeys: readonly string[],
): {error: string; ok: false} | {ok: true; value: TValue} => {
  const normalizedBody = body ?? {}

  if (!isRecord(normalizedBody)) {
    return {error: 'Project transfer request body must be an object', ok: false}
  }

  const unexpectedKey = getUnexpectedBodyKey(normalizedBody, allowedKeys)

  if (unexpectedKey) {
    return {error: `Project transfer request body contains unsupported field ${unexpectedKey}`, ok: false}
  }

  const parsed = shape(normalizedBody)

  return Array.isArray(parsed)
    ? {error: `Invalid project transfer request body: ${String(parsed)}`, ok: false}
    : {ok: true, value: parsed as TValue}
}
