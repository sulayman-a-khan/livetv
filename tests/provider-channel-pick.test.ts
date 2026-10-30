/**
 * Tests for how a channel from an account's own list fills the add-channel form.
 *
 * Run with `npm run test:provider-pick`. These are the rules the panel follows when an
 * admin picks a channel by its name instead of typing a stream id they cannot see.
 *
 * The case that matters most is the mapping itself: a backup must land in a backup slot and
 * never in the slot that plays first, because a channel that plays its own backup is a
 * channel with no fallback at all.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

type Pick = typeof import("../components/premium-admin/providerChannelPick");
const pick: Pick = require("../components/premium-admin/providerChannelPick");
const { applyChannelPick, clearChannelSlot, typeChannelSlot, SLOT_FIELD } = pick;

/** The form as the panel holds it when a new channel is being written. */
function emptyForm() {
  return {
    name: "",
    category: "Premium",
    logoUrl: "",
    sortOrder: "99",
    note: "",
    proxyChannelKey: "",
    active: true,
    providerId: "provider-alpha",
    streamId: "",
    backup1: "",
    backup2: "",
  };
}

const CHANNEL = { streamId: "4411", name: "Alpha Sports", category: "Sports" };

test("picking the first stream fills the id, the name and the category", () => {
  const form = applyChannelPick(emptyForm(), CHANNEL, "primary", false);
  assert.equal(form.streamId, "4411");
  assert.equal(form.name, "Alpha Sports");
  assert.equal(form.category, "Sports");
});

test("a name the admin wrote is not overwritten", () => {
  const form = applyChannelPick({ ...emptyForm(), name: "My Own Name" }, CHANNEL, "primary", false);
  assert.equal(form.name, "My Own Name");
  assert.equal(form.streamId, "4411");
});

test("a row that is being edited keeps its own category", () => {
  const form = applyChannelPick({ ...emptyForm(), category: "Cricket" }, CHANNEL, "primary", true);
  assert.equal(form.category, "Cricket");
  assert.equal(form.name, "Alpha Sports", "an empty name is still filled in");
});

test("an account that names no category leaves the form's own alone", () => {
  const form = applyChannelPick(emptyForm(), { ...CHANNEL, category: "" }, "primary", false);
  assert.equal(form.category, "Premium");
});

test("a backup lands in a backup slot and never in the one that plays first", () => {
  const withPrimary = { ...emptyForm(), streamId: "4411" };

  const first = applyChannelPick(withPrimary, { ...CHANNEL, streamId: "4412" }, "backup1", false);
  assert.equal(first.backup1, "4412");
  assert.equal(first.streamId, "4411", "the first stream must not move");
  assert.equal(first.backup2, "");

  const second = applyChannelPick(first, { ...CHANNEL, streamId: "4413" }, "backup2", false);
  assert.equal(second.backup2, "4413");
  assert.equal(second.backup1, "4412");
  assert.equal(second.streamId, "4411");

  // No slot may write to a field the form does not have, or to another slot.
  for (const slot of ["primary", "backup1", "backup2"] as const) {
    const filled = applyChannelPick(emptyForm(), CHANNEL, slot, false);
    assert.equal(filled[SLOT_FIELD[slot]], CHANNEL.streamId, `slot ${slot} must land in its own field`);
    for (const other of ["primary", "backup1", "backup2"] as const) {
      if (other === slot) continue;
      assert.equal(filled[SLOT_FIELD[other]], "", `slot ${slot} wrote into ${other}`);
    }
  }
});

test("a slot can be emptied and typed by hand again", () => {
  const filled = applyChannelPick(emptyForm(), CHANNEL, "primary", false);
  const cleared = clearChannelSlot(filled, "primary");
  assert.equal(cleared.streamId, "");
  assert.equal(cleared.name, "Alpha Sports", "clearing a stream does not undo the name");

  const typed = typeChannelSlot(cleared, "primary", "9999");
  assert.equal(typed.streamId, "9999");
  assert.equal(typed.backup1, "");
  assert.equal(typed.backup2, "");

  const backupTyped = typeChannelSlot(typed, "backup2", "8888");
  assert.equal(backupTyped.backup2, "8888");
  assert.equal(backupTyped.streamId, "9999");
});

test("every slot names the field it is held in", () => {
  assert.equal(SLOT_FIELD.primary, "streamId");
  assert.equal(SLOT_FIELD.backup1, "backup1");
  assert.equal(SLOT_FIELD.backup2, "backup2");
});
