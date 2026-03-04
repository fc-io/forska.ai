export class HttpError extends Error {
  status: number

  constructor(status: number, message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.status = status
  }
}

export const isHttpError = (value: unknown): value is HttpError => {
  return value instanceof HttpError
}
