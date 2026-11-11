export const getNormalizedPromptSummaryAnswerSql = ({
  criteriaDispositionExpression,
  expression,
}: {
  criteriaDispositionExpression: string
  expression: string
}) => {
  return `
    CASE
      WHEN LOWER(TRIM(${expression})) IN ('yes', 'no', 'maybe') THEN LOWER(TRIM(${expression}))
      WHEN LOWER(TRIM(${expression})) = 'include' AND ${criteriaDispositionExpression} = 'exclude' THEN 'no'
      WHEN LOWER(TRIM(${expression})) = 'include' THEN 'yes'
      WHEN LOWER(TRIM(${expression})) = 'exclude' AND ${criteriaDispositionExpression} = 'exclude' THEN 'yes'
      WHEN LOWER(TRIM(${expression})) = 'exclude' THEN 'no'
      WHEN NULLIF(TRIM(${expression}), '') IS NOT NULL THEN 'maybe'
      ELSE NULL
    END
  `
}
