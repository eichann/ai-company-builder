// A plugin's tab icon: the declaration names one of the app's icons (`ui.tab.icon`, plugins.md);
// the core draws it. Only this short list is bundled; any other name gets the plugin mark.
import {
  Briefcase, Calendar, ChartBar, ClipboardText, Envelope, FilmSlate, Handshake, Kanban, Lightbulb, ListChecks,
  Megaphone, Notebook, PuzzlePiece, Storefront, Target, Users, type Icon,
} from '@phosphor-icons/react'

const ICONS: Record<string, Icon> = {
  Briefcase, Calendar, ChartBar, ClipboardText, Envelope, FilmSlate, Handshake, Kanban, Lightbulb, ListChecks,
  Megaphone, Notebook, PuzzlePiece, Storefront, Target, Users,
}

export function pluginIcon(name: string): Icon {
  return Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : PuzzlePiece
}
