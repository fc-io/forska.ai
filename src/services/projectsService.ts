import {type} from 'arktype'
import {eq} from 'drizzle-orm'

import {projects, projectStats, prompts} from '../db/schema'
import {getDatabase} from '../server/utils/getDatabase'

// Arktype schema for Project validation
export const projectSchema = type({
  id: 'string',
  name: 'string',
  description: 'string | null',
  ownerId: 'string',
  createdAt: 'Date',
  updatedAt: 'Date',
})

// Arktype schema for Prompt validation
export const promptSchema = type({
  id: 'string',
  originalText: 'string',
  transformedText: 'string | null',
  projectId: 'string',
  order: 'number | null',
  archived: 'boolean',
  createdAt: 'Date',
  updatedAt: 'Date',
  promptHeading: 'string | null',
})

const projectsArraySchema = type(projectSchema, '[]')
const promptsArraySchema = type(promptSchema, '[]')

// Schema for project with prompts
export const projectWithPromptsSchema = type({
  project: projectSchema,
  prompts: promptsArraySchema,
})

export type Project = typeof projectSchema.infer
export type Prompt = typeof promptSchema.infer
export type ProjectWithPrompts = typeof projectWithPromptsSchema.infer

export const fetchProjects = async (): Promise<Project[]> => {
  try {
    const db = getDatabase()
    const data = await db.select().from(projects).orderBy(projects.createdAt)

    if (!data) {
      return []
    }

    // Validate response using arktype
    const validation = projectsArraySchema(data)
    if (validation instanceof type.errors) {
      console.error('Project validation errors:', validation.summary)
      throw new Error(
        `Invalid project data received from database: ${validation.summary}`,
      )
    }

    return validation
  } catch (err) {
    console.error('Error fetching projects:', err)
    throw err
  }
}

export const fetchProjectStats = async () => {
  try {
    const db = getDatabase()
    const data = await db.select().from(projectStats)

    return data || []
  } catch (err) {
    console.error('Error fetching project stats:', err)
    throw err
  }
}

export const deleteProject = async (projectId: string): Promise<void> => {
  try {
    const db = getDatabase()
    await db.delete(projects).where(eq(projects.id, projectId))
  } catch (err) {
    console.error('Error deleting project:', err)
    throw err
  }
}

export const fetchProjectWithPrompts = async (
  projectId: string,
): Promise<ProjectWithPrompts> => {
  try {
    const db = getDatabase()

    // Fetch project
    const projectData = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)

    if (!projectData || projectData.length === 0) {
      throw new Error('Project not found')
    }

    // Fetch prompts for this project
    const promptsData = await db
      .select()
      .from(prompts)
      .where(eq(prompts.projectId, projectId))
      .orderBy(prompts.order)

    // Validate project data
    const projectValidation = projectSchema(projectData[0])
    if (projectValidation instanceof type.errors) {
      console.error('Project validation errors:', projectValidation.summary)
      throw new Error(
        `Invalid project data received from database: ${projectValidation.summary}`,
      )
    }

    // Validate prompts data
    const promptsValidation = promptsArraySchema(promptsData || [])
    if (promptsValidation instanceof type.errors) {
      console.error('Prompts validation errors:', promptsValidation.summary)
      throw new Error(
        `Invalid prompts data received from database: ${promptsValidation.summary}`,
      )
    }

    const result = {project: projectValidation, prompts: promptsValidation}

    // Validate the combined result
    const resultValidation = projectWithPromptsSchema(result)
    if (resultValidation instanceof type.errors) {
      console.error(
        'Project with prompts validation errors:',
        resultValidation.summary,
      )
      throw new Error(
        `Invalid project with prompts data: ${resultValidation.summary}`,
      )
    }

    return resultValidation
  } catch (err) {
    console.error('Error fetching project with prompts:', err)
    throw err
  }
}
