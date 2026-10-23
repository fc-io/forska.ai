import {getUniqueSortedStrings} from './getUniqueSortedStrings.ts'

export const hasSameStringSet = (left: string[], right: string[]) => {
  const leftValues = getUniqueSortedStrings(left)
  const rightValues = getUniqueSortedStrings(right)
  return (
    leftValues.length === rightValues.length
    && leftValues.every((value, index) => {
      return value === rightValues[index]
    })
  )
}
