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

export const createProject = async (
  name: string,
  description: string | null,
  ownerId: string,
  promptTexts: string[],
): Promise<Project> => {
  try {
    const db = getDatabase()

    // Create the project
    const projectData = await db
      .insert(projects)
      .values({name, description, ownerId})
      .returning()

    if (!projectData || projectData.length === 0) {
      throw new Error('Failed to create project')
    }

    const project = projectData[0]

    // Create prompts if provided
    if (promptTexts.length > 0) {
      const promptInserts = promptTexts.map((text, index) => {
        return {originalText: text, projectId: project.id, order: index}
      })

      await db.insert(prompts).values(promptInserts)
    }

    // Validate and return the project
    const validation = projectSchema(project)
    if (validation instanceof type.errors) {
      console.error('Project validation errors:', validation.summary)
      throw new Error(`Invalid project data created: ${validation.summary}`)
    }

    return validation
  } catch (err) {
    console.error('Error creating project:', err)
    throw err
  }
}

export const updatePrompts = async (
  projectId: string,
  promptUpdates: Array<{
    id?: string
    originalText: string
    order: number
    isNew?: boolean
  }>,
): Promise<void> => {
  try {
    const db = getDatabase()

    // Get existing prompts
    const existingPrompts = await db
      .select()
      .from(prompts)
      .where(eq(prompts.projectId, projectId))

    // Archive prompts that were removed or changed
    const toArchive = existingPrompts.filter((existing) => {
      const update = promptUpdates.find((u) => {
        return u.id === existing.id
      })
      return !update || update.originalText !== existing.originalText
    })

    if (toArchive.length > 0) {
      await db
        .update(prompts)
        .set({archived: true, updatedAt: new Date()})
        .where(eq(prompts.projectId, projectId))
    }

    // Insert new and updated prompts
    const toInsert = promptUpdates.map((p) => {
      return {
        originalText: p.originalText,
        projectId,
        order: p.order,
        archived: false,
      }
    })

    if (toInsert.length > 0) {
      await db.insert(prompts).values(toInsert)
    }
  } catch (err) {
    console.error('Error updating prompts:', err)
    throw err
  }
}

export const updateProject = async (
  projectId: string,
  updates: Partial<{name: string; description: string | null}>,
): Promise<Project> => {
  try {
    const db = getDatabase()

    const updatedData = await db
      .update(projects)
      .set({...updates, updatedAt: new Date()})
      .where(eq(projects.id, projectId))
      .returning()

    if (!updatedData || updatedData.length === 0) {
      throw new Error('Project not found or update failed')
    }

    const validation = projectSchema(updatedData[0])
    if (validation instanceof type.errors) {
      console.error('Project validation errors:', validation.summary)
      throw new Error(
        `Invalid project data after update: ${validation.summary}`,
      )
    }

    return validation
  } catch (err) {
    console.error('Error updating project:', err)
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
