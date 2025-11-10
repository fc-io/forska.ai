import {getMaxNumberOfInflightRequests} from './getMaxNumberOfInflightRequests.ts'

export const isReadyToGetMoreArticles = (numberOfArticlesInReadyQueue: number): boolean => {
  return numberOfArticlesInReadyQueue < getMaxNumberOfInflightRequests() * 3
}
