// import type { Config } from 'prettier'

// const config: Config = {
const config = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: false,
  singleQuote: true,
  quoteProps: 'as-needed',
  jsxSingleQuote: false,
  trailingComma: 'all',
  objectWrap: 'collapse',
  experimentalOperatorPosition: 'start',
  bracketSpacing: false,
  bracketSameLine: false,
  arrowParens: 'always',
  rangeStart: 0,
  requirePragma: false,
  insertPragma: false,
  proseWrap: 'preserve',
  htmlWhitespaceSensitivity: 'css',
  vueIndentScriptAndStyle: false,
  endOfLine: 'lf',
  embeddedLanguageFormatting: 'auto',
  singleAttributePerLine: false,
  experimentalTernaries: false,
  overrides: [
    {
      files: '*.json',
      options: {
        trailingComma: 'none',
      },
    },
    {
      files: '*.css',
      options: {
        singleQuote: false,
      },
    },
  ],
}

export default config