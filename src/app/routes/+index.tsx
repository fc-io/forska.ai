import '../index.css'

import {useQuery} from '@tanstack/solid-query'
import {createFileRoute} from '@tanstack/solid-router'
import {type JSX} from 'solid-js'

import {fetchSession} from '../../services/fetchSession'
import {LatestArticlesPage} from './+latest-articles/+index'
import {ProjectsPage} from './+projects/+index'

const renderProjects = (): JSX.Element => {
  return <ProjectsPage />
}

const renderLatestArticles = (): JSX.Element => {
  return <LatestArticlesPage />
}

const Index = (): JSX.Element => {
  const sessionQuery = useQuery(() => {
    return {queryKey: ['session'], queryFn: fetchSession}
  })

  return sessionQuery.data?.user ? renderProjects() : renderLatestArticles()
}

export const Route = createFileRoute('/')({component: Index})
