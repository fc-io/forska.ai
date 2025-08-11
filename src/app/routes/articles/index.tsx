import {createFileRoute} from '@tanstack/solid-router'

import {ArticlesTable} from '../../../components/main/articlesTable'

const Articles = () => {
  return (
    <div class="min-h-screen bg-background text-foreground flex justify-center p-4">
      <div class="w-full space-y-8">
        <div class="bg-card text-card-foreground rounded-sm border shadow-lg p-8">
          <ArticlesTable />
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/articles/')({component: Articles})
