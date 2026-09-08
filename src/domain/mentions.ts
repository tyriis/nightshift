// Decision D-q: a mention is @handle with handle = [A-Za-z0-9][A-Za-z0-9_-]*,
// boundary-anchored (start/whitespace/open-paren) so email-shaped text never fires.
const MENTION = /(^|\s|\()@([A-Za-z0-9][A-Za-z0-9_-]*)/g

/** Distinct mentioned handles, first-seen order. */
export const extractMentions = (body: string): string[] =>
  [...body.matchAll(MENTION)].map((m) => m[2]).filter((h, i, all) => all.indexOf(h) === i)
