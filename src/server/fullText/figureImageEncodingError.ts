export const figureImageEncodingInvalidCode = 'figure_image_encoding_invalid'

export type FigureImageEncodingError = Error & {code: typeof figureImageEncodingInvalidCode}

export const getFigureImageEncodingError = (message: string): FigureImageEncodingError => {
  const fields: Pick<FigureImageEncodingError, 'code'> = {code: figureImageEncodingInvalidCode}

  return Object.assign(new Error(message), fields)
}

export const isFigureImageEncodingError = (error: unknown): error is FigureImageEncodingError => {
  return error instanceof Error && (error as {code?: unknown}).code === figureImageEncodingInvalidCode
}
