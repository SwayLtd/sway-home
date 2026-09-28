/**
 * How the agent interface looks, chosen in Réglages and kept in this browser.
 *
 * Every variant of the Beautiful UI kit stays available; these are only the defaults the
 * console uses when a component could take several shapes.
 */

export type LoaderVariant = 'Drive' | 'Dots' | 'Orbit' | 'Surfer'
export type PromptShape = 'Rounded' | 'Pill'
export type TaskLayout = 'Capsules' | 'List'

export interface AiPreferences {
  loader: LoaderVariant
  prompt: PromptShape
  tasks: TaskLayout
}

const KEY = 'sway-ai-ui'
const DEFAULTS: AiPreferences = { loader: 'Orbit', prompt: 'Rounded', tasks: 'List' }

export const LOADER_VARIANTS: { value: LoaderVariant; label: string; hint: string }[] = [
  { value: 'Drive', label: 'Drive', hint: 'Grille de pixels carrés, vague en chevron qui avance.' },
  { value: 'Dots', label: 'Dots', hint: 'La même vague, en pixels ronds.' },
  { value: 'Orbit', label: 'Orbit', hint: 'Une comète qui fait le tour de la grille.' },
  { value: 'Surfer', label: 'Surfer', hint: 'Drive et une vidéo mème, chargée depuis beautifului.dev.' },
]

export const PROMPT_SHAPES: { value: PromptShape; label: string; hint: string }[] = [
  { value: 'Rounded', label: 'Arrondie', hint: 'Coins arrondis comme les cartes.' },
  { value: 'Pill', label: 'Pilule', hint: "Entièrement arrondie, bouton d'envoi rond." },
]

export const TASK_LAYOUTS: { value: TaskLayout; label: string; hint: string }[] = [
  { value: 'List', label: 'Liste', hint: 'Lignes compactes les unes sous les autres.' },
  { value: 'Capsules', label: 'Capsules', hint: 'Chaque tâche dans sa capsule.' },
]

function read(): AiPreferences {
  if (!import.meta.client) return { ...DEFAULTS }
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<AiPreferences>
    return {
      loader: LOADER_VARIANTS.some((entry) => entry.value === stored.loader) ? stored.loader! : DEFAULTS.loader,
      prompt: PROMPT_SHAPES.some((entry) => entry.value === stored.prompt) ? stored.prompt! : DEFAULTS.prompt,
      tasks: TASK_LAYOUTS.some((entry) => entry.value === stored.tasks) ? stored.tasks! : DEFAULTS.tasks,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function useAiPreferences() {
  const preferences = useState<AiPreferences>('ai-preferences', () => ({ ...DEFAULTS }))
  const loaded = useState('ai-preferences-loaded', () => false)
  if (import.meta.client && !loaded.value) {
    preferences.value = read()
    loaded.value = true
  }

  function set<K extends keyof AiPreferences>(key: K, value: AiPreferences[K]) {
    preferences.value = { ...preferences.value, [key]: value }
    if (import.meta.client) localStorage.setItem(KEY, JSON.stringify(preferences.value))
  }

  return { preferences, set }
}
