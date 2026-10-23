export const areDateBoundsEqual = (left: Date | null, right: Date | null) => {
  return (left ? left.getTime() : null) === (right ? right.getTime() : null)
}

export const areNumberListsEqual = (left: readonly number[], right: readonly number[]) => {
  return (
    left.length === right.length
    && left.every((value, index) => {
      return value === right[index]
    })
  )
}
