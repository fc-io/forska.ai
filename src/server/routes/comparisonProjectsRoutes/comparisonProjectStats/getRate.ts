export const getRate = (numerator: number, denominator: number) => {
  return denominator === 0 ? null : numerator / denominator
}
