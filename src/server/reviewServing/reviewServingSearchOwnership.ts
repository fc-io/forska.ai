export const reviewServingSearchOwnership = {
  asyncSubstringOwner: 'reviewSearchService',
  productionListOwner: 'routeServiceTokenPrefixReader',
  productionRouteServiceFiles: [
    'src/server/reviewServing/reviewServingLlmReviewRouteService.ts',
    'src/server/reviewServing/reviewServingHumanBothUnassessedRouteService.ts',
  ],
  readySearchMode: 'tokenPrefix',
  substringSearchMode: 'substringAsync',
} as const
