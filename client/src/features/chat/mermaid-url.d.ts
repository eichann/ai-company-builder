// Vite's `?url` import of the mermaid file: its address in the build (dist/vendor/), never its code in the bundle.
declare module '@mermaid-js/tiny/dist/mermaid.tiny.js?url' {
  const url: string
  export default url
}
