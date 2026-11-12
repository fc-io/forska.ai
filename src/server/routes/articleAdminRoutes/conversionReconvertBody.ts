import {type as arktype} from 'arktype'

const conversionReconvertBodyType = arktype({articleId: 'string > 0'})

const getStandardIssues = (errors: InstanceType<typeof arktype.errors>) => {
  return {
    issues: Array.from(errors, ({message, path, problem}) => {
      return {message, path: [...path], problem}
    }),
  }
}

export const conversionReconvertBody = {
  '~standard': {
    types: conversionReconvertBodyType['~standard'].types,
    validate: (value: unknown) => {
      const result = conversionReconvertBodyType(value)

      return result instanceof arktype.errors ? getStandardIssues(result) : {value: result}
    },
    vendor: 'arktype',
    version: 1,
  },
} as const
