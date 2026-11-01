// The slot parts, loaded when a slot first shows: members of companies without plugins never
// load the frame code at start (the renderer bundle has a budget, scripts/check-bundle-size.mjs).
// Render them inside <Suspense>.
import { lazy } from 'react'

const parts = () => import('./PluginSlots')
export const LazyPluginTabPanel = lazy(() => parts().then(m => ({ default: m.PluginTabPanel })))
export const LazyPluginPeek = lazy(() => parts().then(m => ({ default: m.PluginPeek })))
export const LazyPluginRecordSections = lazy(() => parts().then(m => ({ default: m.PluginRecordSections })))
export const LazyPluginFileActionDialog = lazy(() => parts().then(m => ({ default: m.PluginFileActionDialog })))
