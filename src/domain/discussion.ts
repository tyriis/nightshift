// Discussion vocabulary (spec §6.5/§6.6). Pure — the domain layer imports nothing (spec §9).

export const THREAD_KINDS = ['note', 'question'] as const
export type ThreadKind = (typeof THREAD_KINDS)[number]

export const QUESTION_STATES = ['open', 'answered', 'resolved', 'wont_fix'] as const
export type QuestionState = (typeof QUESTION_STATES)[number]

// Decision D-n: open → {answered, wont_fix}; answered → {resolved, wont_fix};
// resolved/wont_fix terminal. Full matrix pinned exhaustively in tests.
const TRANSITIONS: Record<QuestionState, readonly QuestionState[]> = {
  open: ['answered', 'wont_fix'],
  answered: ['resolved', 'wont_fix'],
  resolved: [],
  wont_fix: [],
}

export const canTransitionQuestion = (from: QuestionState, to: QuestionState): boolean =>
  TRANSITIONS[from].includes(to)

export const LINK_KINDS = ['pr', 'commit', 'doc', 'other'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

// Decision D-r: the inbox kinds actually built — claim_conflict stays deferred (D-s).
export const INBOX_ITEM_KINDS = ['assigned', 'mentioned', 'question_assigned'] as const
export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number]
