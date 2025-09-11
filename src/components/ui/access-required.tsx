import {Link} from '@tanstack/solid-router'

export const AccessRequired = () => {
  return (
    <div class="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <div class="w-full max-w-md space-y-8 text-center">
        <h1 class="text-3xl font-bold tracking-tight">Access Required</h1>
        <p class="text-muted-foreground">Please sign in to access Paper Agent.</p>
        <Link
          to="/login"
          class="w-full bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium"
        >
          Sign In
        </Link>
      </div>
    </div>
  )
}
