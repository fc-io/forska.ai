import {Link} from '@tanstack/solid-router'

export const AccessRequired = () => {
  return (
    <div class="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <div class="w-full max-w-md space-y-8 text-center">
        <h1 class="text-3xl font-bold tracking-tight">Local Access</h1>
        <p class="text-muted-foreground">This page now opens directly in local-first mode.</p>
        <Link
          to="/"
          class="w-full bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium"
        >
          Go Home
        </Link>
      </div>
    </div>
  )
}
