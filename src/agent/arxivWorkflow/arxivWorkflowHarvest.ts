import {type} from 'arktype'
import {XMLParser} from 'fast-xml-parser'

import {sleep} from '../../utils/sleep.ts'
import {arxivWorkflowGetQuery} from './arxivWorkflowGetQuery.ts'
import {arxivEntry} from './arxivWorkflowStoreEntires.ts'
import {arxivWorkflowStoreEntires} from './arxivWorkflowStoreEntires.ts'

export type InputData = {fromDate: string; toDate: string; importRoute: string}
type HarvestOptions = {cursor?: string | null; onCursorUpdate?: (cursor: string | null) => Promise<void>}
type HarvestInput = InputData & HarvestOptions

const fxp = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  removeNSPrefix: true,
  parseAttributeValue: true,
})

const fetchArxivQueryStepSchema = type({arxivQueryUrl: 'string'})

// Export the feed schema that's expected by other files
const arxivFeedSchema = type({'resumptionToken?': 'string', records: arxivEntry.array()})

// OAI-PMH response structure
const OaiPmhResponseSchema = type({
  '?xml?': {'@_version': 'number', '@_encoding': 'string'},
  'OAI-PMH': {
    responseDate: 'string',
    request: 'string | object',
    'ListRecords?': {'record?': 'object | object[]', 'resumptionToken?': 'string | object'},
    'error?': 'object | object[]',
    '@_schemaLocation?': 'string',
  },
})

// Transform OAI-PMH response to match the expected format
const transformOaiResponse = (oaiResponse: typeof OaiPmhResponseSchema.infer): typeof arxivFeedSchema.infer => {
  const records = oaiResponse['OAI-PMH']?.ListRecords?.record || []
  const recordArray = Array.isArray(records) ? records : [records]
  const resumptionTokenRaw = oaiResponse['OAI-PMH']?.ListRecords?.resumptionToken

  // Extract resumption token text if it's an object
  let resumptionToken: string | undefined
  if (resumptionTokenRaw) {
    if (typeof resumptionTokenRaw === 'string') {
      resumptionToken = resumptionTokenRaw
    } else if (typeof resumptionTokenRaw === 'object' && resumptionTokenRaw !== null && '#text' in resumptionTokenRaw) {
      resumptionToken = safeString((resumptionTokenRaw as Record<string, unknown>)['#text'])
    }
  }

  return {
    ...(resumptionToken && {resumptionToken}),
    records: recordArray
      .filter((record: unknown) => {
        return record && typeof record === 'object' && 'metadata' in record
      })
      .map((record: unknown) => {
        return transformRecord(record)
      }),
  }
}

const safeString = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    // Better object stringification - handle specific object types
    if (Array.isArray(value)) {
      return value.join(', ')
    }
    try {
      return JSON.stringify(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return ''
}

const transformRecord = (oaiRecord: unknown) => {
  if (!oaiRecord || typeof oaiRecord !== 'object') {
    throw new Error('Invalid record format')
  }

  const record = oaiRecord as Record<string, unknown>
  const header = (record.header as Record<string, unknown>) || {}
  const metadata = (record.metadata as Record<string, unknown>)?.arXiv || record.metadata || {}
  const metadataObj = metadata as Record<string, unknown>

  const identifier = safeString(header.identifier)

  return {
    id: identifier,
    title: safeString(metadataObj.title) || 'No title',
    summary: safeString(metadataObj.abstract),
    updated: safeString(header.datestamp),
    published: safeString(header.datestamp),
    author: transformAuthors(metadataObj.authors),
    link: [`http://arxiv.org/abs/${extractArxivId(identifier)}`],
    primary_category: extractPrimaryCategory(metadataObj.categories),
    category: extractCategories(metadataObj.categories),
    comment: metadataObj.comments ? safeString(metadataObj.comments) : undefined,
  }
}

const transformAuthors = (authors: unknown) => {
  if (!authors) return []

  // Handle the case where authors is a string (fallback)
  if (typeof authors === 'string') {
    return [{name: authors}]
  }

  // Handle the actual arXiv author structure
  if (typeof authors === 'object' && authors !== null) {
    const authorsObj = authors as Record<string, unknown>
    const authorData = authorsObj.author

    if (!authorData) return []

    // Handle array of authors
    if (Array.isArray(authorData)) {
      return authorData
        .map((author) => {
          if (typeof author === 'object' && author !== null) {
            const authorObj = author as Record<string, unknown>
            const keyname = safeString(authorObj.keyname)
            const forenames = safeString(authorObj.forenames)

            // Combine forenames and keyname into a full name
            if (forenames && keyname) {
              return {name: `${forenames} ${keyname}`}
            } else if (keyname) {
              return {name: keyname}
            } else if (forenames) {
              return {name: forenames}
            }
          }
          return {name: safeString(author)}
        })
        .filter((author) => {
          return author.name
        }) // Remove empty names
    }

    // Handle single author
    if (typeof authorData === 'object' && authorData !== null) {
      const authorObj = authorData as Record<string, unknown>
      const keyname = safeString(authorObj.keyname)
      const forenames = safeString(authorObj.forenames)

      if (forenames && keyname) {
        return [{name: `${forenames} ${keyname}`}]
      } else if (keyname) {
        return [{name: keyname}]
      } else if (forenames) {
        return [{name: forenames}]
      }
    }

    // Handle string author data
    if (typeof authorData === 'string') {
      return [{name: authorData}]
    }
  }

  // Fallback
  return [{name: safeString(authors)}]
}

const extractArxivId = (identifier: string): string => {
  // Extract arXiv ID from OAI identifier (e.g., "oai:arXiv.org:1234.5678")
  const match = identifier.match(/arXiv\.org:(.+)$/)
  if (match?.[1]) {
    return match[1]
  }

  // Fallback to the original logic for other formats
  const fallbackMatch = identifier.match(/arXiv[:.]([\w-]+(?:\/\d+)?(?:v\d+)?)/)
  return fallbackMatch?.[1] ?? identifier.replace(/^oai:arXiv\.org:/, '')
}

const extractPrimaryCategory = (categories: unknown): string => {
  if (!categories) return ''
  const catString = safeString(categories)
  if (catString) return catString.split(' ')[0] ?? catString
  if (Array.isArray(categories)) return safeString(categories[0])
  return ''
}

const extractCategories = (categories: unknown): string | string[] => {
  if (!categories) return []
  if (typeof categories === 'string') {
    const cats = categories.split(/[,\s]+/).filter(Boolean)
    return cats.length === 1 ? (cats[0] ?? '') : cats
  }
  if (Array.isArray(categories)) return categories.map(safeString)
  const catString = safeString(categories)
  return catString ? [catString] : []
}

const fetchRecords = async (arxivQueryUrl: string): Promise<typeof arxivFeedSchema.infer> => {
  console.log('Fetching ArXiv URL:', decodeURIComponent(arxivQueryUrl))
  const response = await fetch(arxivQueryUrl)
  console.log('ArXiv response:', response.status, response.statusText)
  const xml = await response.text()
  const raw: unknown = fxp.parse(xml)

  try {
    const validated = OaiPmhResponseSchema.assert(raw)

    // Check for errors in OAI-PMH response
    if (validated['OAI-PMH'].error) {
      throw new Error(`OAI-PMH Error: ${JSON.stringify(validated['OAI-PMH'].error)}`)
    }

    const result = transformOaiResponse(validated)

    console.log('fetched, # entries:', result.records.length)
    // debugger
    return result
  } catch (error) {
    throw new Error(`Schema validation failed: ${String(error)}`)
  }
}

const getStartResumptionToken = (cursor?: string | null) => {
  const trimmed = cursor?.trim() ?? ''
  return trimmed || undefined
}

const arxivWorkflowHarvest = async (input: HarvestInput, resumptionToken?: string): Promise<void> => {
  console.log('Arxiv harvest start', input)
  const token = resumptionToken ?? getStartResumptionToken(input.cursor)
  const arxivQueryUrl = arxivWorkflowGetQuery(input, token)
  const result = await fetchRecords(arxivQueryUrl)
  await arxivWorkflowStoreEntires(result.records, input.importRoute)
  await input.onCursorUpdate?.(result.resumptionToken ?? null)

  if (result.resumptionToken) {
    await sleep(5000)
    await arxivWorkflowHarvest(input, result.resumptionToken)
  }
  console.log('Arxiv Workflow harvest complete')
}

export {arxivFeedSchema, arxivWorkflowHarvest, fetchArxivQueryStepSchema, OaiPmhResponseSchema}
