export class ConversionError extends Error {
  constructor(
    message: string,
    public status?: number,
    public isPermanent = false,
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}
