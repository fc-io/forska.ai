import {type CanonicalDropReason} from './canonicalFullTextUnits.ts'

const shortLineMaxLength = 300
const authorNoteMaxLength = 200
const authorLineMaxLength = 400
const authorLineMinCapitalisedShare = 0.6

const sentenceWordPattern =
  /\b(?:are|be|been|being|can|could|did|does|found|had|has|have|included|including|is|may|might|not|our|remains?|reported|should|showed|shown|shows?|suggests?|that|these|this|those|was|we|were|which|will|would)\b/i
const affiliationKeywordPattern =
  /(?:\bAcademy|\bCenter|\bCentre|\bClinic|\bCollege of|\bDepartment|\bDivision|\bFaculty|\bFoundation|\bHospital|Hôpital|\bInstitut|\bKlinik|\bLaborator|\bOspedale|\bSchool of|\bUniversit)/
const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/
const frontMatterLinePatterns = [
  /^(?:©|\(c\)\s|copyright\b)/i,
  /^(?:open[- ]access\b|this (?:is an )?open[- ]access article|this article is (?:licensed|distributed) under)/i,
  /^(?:citation\b|cite this article\b|how to cite\b|to cite this article\b)/i,
  /^(?:edited by|reviewed by|handling editor|academic editor)\b/i,
  /^key ?words?\b/i,
  /^check for updates$/i,
  /^article (?:history|info(?:rmation)?)\b/i,
  /^(?:doi:\s*10\.\d{4,9}\/|https?:\/\/(?:dx\.)?doi\.org\/)\S+$/i,
  /^this article was (?:first )?published\b/i,
]
const authorNotePattern =
  /\b(?:contributed equally|co-first authors?|current address|deceased|equal(?:ly)? (?:technical )?contribut|joint first authors?|present address|project lead|senior authors?)/i

export const getHeadingKey = (text: string): string => {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/^[^a-z0-9]*(?:\d+(?:\.\d+)*\.?|[ivxlcdm]+\.|[a-z]\.)\s+/, '')
    .replace(/[^a-z]/g, '')
}

export const getHeadingNumberDepth = (text: string): number | null => {
  const match = /^(\d{1,2}(?:\.\d{1,2}){0,5}|[A-Z](?=\.)(?:\.\d{1,2}){0,5})\.?\s+\S/.exec(text)

  return match ? (match[1] as string).split('.').length : null
}

export const isCorrespondenceText = (text: string): boolean => {
  return /^[\s*†‡§¶#✉]*(?:correspondence\b|corresponding authors?\b|address for correspondence\b|address correspondence\b|address reprint requests?\b|reprint requests?\b|e-?mail\s*:)/i.test(
    text,
  )
}

const isEmailText = (text: string): boolean => {
  return text.length <= shortLineMaxLength && emailPattern.test(text)
}

const isPublicationDateText = (text: string): boolean => {
  return (
    text.length <= shortLineMaxLength
    && /^(?:received|accepted|published|revised|available online|first published)\b/i.test(text)
    && /\b(?:19|20)\d{2}\b/.test(text)
  )
}

const isShortDoiText = (text: string): boolean => {
  return text.length <= authorNoteMaxLength && /\bdoi:?\s*10\.\d{4,9}\/|doi\.org\/10\./i.test(text)
}

const isAuthorNoteText = (text: string): boolean => {
  return text.length <= authorNoteMaxLength && authorNotePattern.test(text)
}

const isAffiliationText = (text: string): boolean => {
  const isSentence = sentenceWordPattern.test(text)
  const hasInstitution = affiliationKeywordPattern.test(text)

  return (
    /^(?:author )?affiliations?\b/i.test(text)
    || (hasInstitution && !isSentence && (text.length <= shortLineMaxLength || /^From the\s/.test(text)))
  )
}

export const getFrontMatterLineDropReason = (text: string): CanonicalDropReason | null => {
  return isCorrespondenceText(text) || isEmailText(text)
    ? 'correspondence'
    : isPublicationDateText(text)
        || isAuthorNoteText(text)
        || isShortDoiText(text)
        || frontMatterLinePatterns.some((pattern) => {
          return pattern.test(text)
        })
      ? 'front_matter'
      : isAffiliationText(text)
        ? 'affiliation_line'
        : null
}

const isMarkedAuthorNoteText = (text: string): boolean => {
  return text.length <= authorNoteMaxLength && /^[∗*†‡§¶]/.test(text) && !sentenceWordPattern.test(text)
}

const isAuthorNamesText = (text: string): boolean => {
  const words = text
    .replace(/[\d*∗†‡§¶#,;()]/g, ' ')
    .split(/\s+/)
    .filter((word) => {
      return /\p{L}/u.test(word)
    })
  const capitalisedCount = words.filter((word) => {
    return /^\p{Lu}/u.test(word)
  }).length

  return (
    text.length <= authorLineMaxLength
    && !sentenceWordPattern.test(text)
    && capitalisedCount >= 2
    && capitalisedCount / words.length >= authorLineMinCapitalisedShare
  )
}

export const isAuthorBlockText = (text: string): boolean => {
  return isAuthorNamesText(text) || isMarkedAuthorNoteText(text)
}
