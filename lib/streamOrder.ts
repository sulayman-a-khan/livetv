/**
 * The order a viewer's browser walks a channel's links in.
 *
 * A pinned link leads the ladder, whatever the speed ranking says about it: the
 * pin is an admin's deliberate choice and outranks the ranking rule. The order
 * inside each group is untouched, so the links that are not pinned are still
 * walked in exactly the order the ranking rule gave them.
 *
 * This is the whole of the pinned-link rule, and it is deliberately separate
 * from the ranking rule itself — the ranking decides which link is "best",
 * this decides what is tried first.
 */
export function orderStreamsForPlayback<T extends { pinned?: boolean }>(streams: T[]): T[] {
  if (!streams.some((stream) => stream.pinned)) return streams;
  return [
    ...streams.filter((stream) => stream.pinned),
    ...streams.filter((stream) => !stream.pinned),
  ];
}
