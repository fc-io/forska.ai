import type {PromptRecord} from '../../../db/schemaTypes.ts'

export type PromptRow = Pick<PromptRecord, 'id' | 'originalText' | 'transformedText' | 'promptHeading' | 'type'>
