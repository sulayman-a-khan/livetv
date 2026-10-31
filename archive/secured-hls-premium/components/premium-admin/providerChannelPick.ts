/**
 * How a channel from an account's own list fills the form.
 *
 * The account already knows what its channels are called and what category they sit in, so
 * the admin picks a channel by its name and this decides what the form says afterwards. It
 * is kept here, apart from the panel, because these are rules and rules can be tested.
 */

/** The three stream slots one provider-backed channel has. */
export type StreamSlot = "primary" | "backup1" | "backup2";

/** The form field each stream slot is held in. */
export const SLOT_FIELD: Record<StreamSlot, "streamId" | "backup1" | "backup2"> = {
  primary: "streamId",
  backup1: "backup1",
  backup2: "backup2",
};

/** A channel as the account's own panel names it. */
export interface PickableChannel {
  streamId: string;
  name: string;
  category: string;
}

/** The form fields a pick touches. */
export interface ChannelFormFields {
  name: string;
  category: string;
  streamId: string;
  backup1: string;
  backup2: string;
}

/**
 * Fills the form from one channel of the account's own list.
 *
 * The first slot also fills in the name and the category, because the account already knows
 * them and an admin should not have to type what the account just said. A name the admin
 * wrote is left alone, and a row that is being edited keeps its own category.
 */
export function applyChannelPick<T extends ChannelFormFields>(
  form: T,
  channel: PickableChannel,
  slot: StreamSlot,
  isEdit: boolean
): T {
  if (slot !== "primary") return { ...form, [SLOT_FIELD[slot]]: channel.streamId };
  const name = form.name.trim() ? form.name : channel.name;
  const category =
    !isEdit && (!form.category.trim() || form.category === "Premium")
      ? channel.category || form.category
      : form.category;
  return { ...form, streamId: channel.streamId, name, category };
}

/** Empties one slot, so a channel can be pointed somewhere else. */
export function clearChannelSlot<T extends ChannelFormFields>(form: T, slot: StreamSlot): T {
  return { ...form, [SLOT_FIELD[slot]]: "" };
}

/** Takes a stream id typed by hand, for a stream the account's live list does not name. */
export function typeChannelSlot<T extends ChannelFormFields>(
  form: T, slot: StreamSlot, value: string
): T {
  return { ...form, [SLOT_FIELD[slot]]: value };
}
