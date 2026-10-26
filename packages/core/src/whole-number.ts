/** The number `text` spells as plain digits (an id, a count, a port), or null for anything else. */
export function wholeNumber(text: string | undefined): number | null {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
}
