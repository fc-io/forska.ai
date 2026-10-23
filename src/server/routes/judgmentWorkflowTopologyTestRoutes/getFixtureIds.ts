export const getFixtureIds = (fixtureId: string) => {
  return {
    articleIds: [`${fixtureId}-article-a`, `${fixtureId}-article-b`],
    connectionId: `${fixtureId}-connection`,
    modelId: `${fixtureId}-model`,
    projectIds: [`${fixtureId}-project-a`, `${fixtureId}-project-b`],
    promptIds: [`${fixtureId}-prompt-a`, `${fixtureId}-prompt-b`],
  }
}
