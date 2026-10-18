export type ConverterServerFailure = 'died' | 'refused'

export class ConversionError extends Error {
  constructor(
    message: string,
    public status?: number,
    public isPermanent = false,
    public serverFailure: ConverterServerFailure | null = null,
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}

export const getConverterServerFailure = (error: unknown): ConverterServerFailure | null => {
  return error instanceof ConversionError ? error.serverFailure : null
}
