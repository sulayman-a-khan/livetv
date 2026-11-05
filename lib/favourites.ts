/**
 * The pure rules of a saved channel list: the key a list travels under, and the
 * ids a list may hold.
 *
 * The app has no accounts and never will, so a list is kept on the device and
 * copied to the site under a key the viewer carries. This module is the one
 * place that says what a key is and what a list may hold, so the route, the
 * store and the app can never disagree about what a valid request is.
 *
 * Nothing here touches the database: the storing half lives in
 * `lib/favouriteList.ts`.
 */

/** How many characters a key has. */
export const FAVOURITE_KEY_LENGTH = 8;

/**
 * The alphabet a key is written from.
 *
 * It leaves out the characters that are read wrong over the phone — I, O,
 * zero and one — so a key that is read aloud is the key that was written.
 */
export const FAVOURITE_KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * The most channels one list may hold.
 *
 * A list is a viewer's own picks, not a catalogue: past this number it is a
 * body that was written by something other than the app.
 */
export const MAX_FAVOURITE_IDS = 500;

/** The longest one channel id may be. */
export const MAX_FAVOURITE_ID_LENGTH = 64;

/**
 * True when the text is a key the app could have written.
 *
 * A key is the whole identity of a list, so a key that is not one is refused
 * rather than repaired: repairing it would put a viewer's list under a key
 * nobody typed.
 */
export function isFavouriteKey(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim().toUpperCase();
  if (trimmed.length !== FAVOURITE_KEY_LENGTH) return false;
  for (const character of trimmed) {
    if (!FAVOURITE_KEY_ALPHABET.includes(character)) return false;
  }
  return true;
}

/**
 * The key as it is written down, or an empty string when it is not one.
 *
 * Lower case is read the same way as upper case, because a key is read aloud
 * and typed in by hand.
 */
export function normaliseFavouriteKey(text: unknown): string {
  if (typeof text !== "string") return "";
  const trimmed = text.trim().toUpperCase();
  return isFavouriteKey(trimmed) ? trimmed : "";
}

/** A list that was accepted, or the reason it was not. */
export type FavouriteIdList =
  | { ok: true; ids: string[] }
  | { ok: false; error: string };

/**
 * The ids a list may hold, in the order they were given.
 *
 * A blank id is nothing and is dropped; the same id twice is one channel and
 * is kept once. The order is the viewer's and is kept as it was given.
 *
 * A body that is not a list of short strings is refused whole: a request that
 * does not make sense must not be answered by quietly storing part of it.
 */
export function parseFavouriteIds(value: unknown): FavouriteIdList {
  if (!Array.isArray(value)) {
    return { ok: false, error: "The list of channels is not a list." };
  }

  if (value.length > MAX_FAVOURITE_IDS) {
    return { ok: false, error: "The list of channels is too long." };
  }

  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { ok: false, error: "The list of channels holds something that is not a channel." };
    }
    const id = entry.trim();
    if (!id) continue;
    if (id.length > MAX_FAVOURITE_ID_LENGTH) {
      return { ok: false, error: "The list of channels holds a channel id that is too long." };
    }
    if (ids.includes(id)) continue;
    ids.push(id);
  }

  return { ok: true, ids };
}
