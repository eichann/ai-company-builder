// A plugin's tab icon: the declaration names one of the app's icons (`ui.tab.icon`, plugins.md);
// the core draws it. Only this short list is bundled (the renderer has a size budget); any other
// name gets the plugin mark.
import { Briefcase, FilmSlate, Lightbulb, ListChecks, Notebook, PuzzlePiece, Storefront, Target, Users, type Icon } from '@phosphor-icons/react'

const ICONS: Record<string, Icon> = { Briefcase, FilmSlate, Lightbulb, ListChecks, Notebook, PuzzlePiece, Storefront, Target, Users }

export function pluginIcon(name: string): Icon {
  return Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : PuzzlePiece
}
