/**
 * AiSelectionActions - types and pure helpers (Beautiful UI).
 *
 * The source demo fakes its selection with a permanently-styled span and a scripted timeout;
 * the real component tracks the browser's live Selection API instead (see SelectionActions.vue),
 * so this file only carries the action-set shape and its French defaults.
 */

/** One AI action offered in the bar. `handoff` actions do not call `transform`: they send
 *  the selection straight to the assistant (the `ask` emit) instead of editing in place. */
export type SelectionActionsAction = {
  id: string
  label: string
  /** Phosphor icon name. */
  icon: string
  /** Gerund-ish label shown while this action runs; falls back to a generic one. */
  busyLabel?: string
  handoff?: boolean
}

/** `primary` are always visible; `more` reveal when the bar expands. */
export type SelectionActionsSet = {
  primary: SelectionActionsAction[]
  more: SelectionActionsAction[]
}

export type SelectionActionsLabels = {
  keep: string
  discard: string
  retry: string
  placeholder: string
}

export const SELECTION_ACTIONS_DEFAULT_LABELS: SelectionActionsLabels = {
  keep: 'Garder',
  discard: 'Ignorer',
  retry: 'Réessayer',
  placeholder: 'Décrire la modification',
}

export const SELECTION_ACTIONS_DEFAULT: SelectionActionsSet = {
  primary: [
    { id: 'explain', label: 'Expliquer', icon: 'ph:chat-circle-text', busyLabel: 'Explication' },
    { id: 'improve', label: 'Reformuler', icon: 'ph:sparkle', busyLabel: 'Reformulation' },
  ],
  more: [
    { id: 'shorten', label: 'Raccourcir', icon: 'ph:scissors', busyLabel: 'Raccourcissement' },
    { id: 'translate', label: 'Traduire', icon: 'ph:translate', busyLabel: 'Traduction' },
    { id: 'ask', label: "Demander à l'assistant", icon: 'ph:chat-circle-dots', handoff: true },
  ],
}

/** Generic gerund-ish fallback when an action carries no `busyLabel` of its own. */
export const SELECTION_ACTIONS_FALLBACK_BUSY_LABEL = 'Édition'

/** Every action across both rows, in offer order - used to resolve an id to its definition. */
export function selectionActionsAll(actions: SelectionActionsSet): SelectionActionsAction[] {
  return [...actions.primary, ...actions.more]
}

export function selectionActionsBusyLabel(actions: SelectionActionsSet, actionId: string): string {
  return selectionActionsAll(actions).find((action) => action.id === actionId)?.busyLabel ?? SELECTION_ACTIONS_FALLBACK_BUSY_LABEL
}
