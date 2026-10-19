/** A message to start a new conversation with, set by another page (the Overview briefing). */
let pendingAsk: string | null = null;

/** Opens Chat on a new conversation with `text` ready to send (the person still sends it). */
export function askInChat(text: string): void {
  pendingAsk = text;
}

/** The waiting message. Read it in a state initializer, which React may call twice. */
export function peekAsk(): string | null {
  return pendingAsk;
}

/** Done with the waiting message: a later visit to Chat opens as usual. */
export function clearAsk(): void {
  pendingAsk = null;
}
