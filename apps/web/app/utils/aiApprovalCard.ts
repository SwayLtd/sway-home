/**
 * Types and pure helpers for AiApprovalCard - human-in-the-loop clarification, one question
 * at a time (Beautiful UI). Also used for a single yes/no confirmation of a critical action:
 * pass one question with two options and no `multiple`, so picking either one auto-advances
 * and sends immediately.
 */

export type ApprovalOption = {
  id: string
  label: string
  hint?: string
}

export type ApprovalQuestion = {
  id: string
  title: string
  description?: string
  options: ApprovalOption[]
  /** Multi-select: picks accumulate and the person confirms with "Continuer". Single-select (default) auto-advances on pick. */
  multiple?: boolean
  /** Shows a free-text row under the options, for an answer that is not one of them. */
  allowOther?: boolean
}

/** One answer per question: the picked option ids, or the free-text answer typed instead. */
export type ApprovalAnswer = string[] | string

export type ApprovalCardLabels = {
  skip: string
  continueLabel: string
  send: string
  otherPlaceholder: string
  sentMessage: string
  startOver: string
  reopen: string
  dismiss: string
}

export const APPROVAL_CARD_DEFAULT_LABELS: ApprovalCardLabels = {
  skip: 'Passer',
  continueLabel: 'Continuer',
  send: 'Envoyer',
  otherPlaceholder: 'Autre chose...',
  sentMessage: 'Envoyé',
  startOver: 'Recommencer',
  reopen: 'Ouvrir la demande',
  dismiss: 'Fermer',
}

/** True once an answer has a pick or non-empty free text - gates the footer's Continue button. */
export function approvalHasAnswer(answer: ApprovalAnswer | undefined): boolean {
  if (!answer) return false
  return Array.isArray(answer) ? answer.length > 0 : answer.trim().length > 0
}
