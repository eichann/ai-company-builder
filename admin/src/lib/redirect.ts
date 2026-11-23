/** A page of the user manual (`/manual/…`, served by the API: server.md "The user manual"). */
export function isManualPath(path: string): boolean {
  return path.startsWith('/manual/')
}

/** Only same-origin paths, so ?redirect= cannot send people to another site. */
export function safeRedirect(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/dashboard'
  return value
}
