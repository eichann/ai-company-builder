/** Only same-origin paths, so ?redirect= cannot send people to another site. */
export function safeRedirect(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/dashboard'
  return value
}
