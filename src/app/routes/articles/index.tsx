import {createFileRoute} from '@tanstack/solid-router'
import {Show} from 'solid-js'

import {ArticlesTable} from '../../../components/main/articlesTable'
import {AccessRequired} from '../../../components/ui/access-required'
import {authStore} from '../../../stores/authStore'

const Articles = () => {
  console.log('import.meta.env.DEV', import.meta.env.DEV)
  return (
    <Show
      when={!authStore.isLoading() && authStore.isAuthenticated()}
      fallback={<AccessRequired />}
    >
      <div class="min-h-screen bg-background text-foreground flex justify-center p-4">
        <div class="w-full space-y-8">
          <div class="bg-card text-card-foreground rounded-sm border shadow-lg p-8">
            <ArticlesTable />
          </div>
        </div>
      </div>
    </Show>
  )
}

export const Route = createFileRoute('/articles/')({component: Articles})
