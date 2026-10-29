import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boxLogoProblem,
  providerHandleFromLabel,
  validatePremiumChannelInput,
  validateProviderInput,
} from "../lib/premiumFixtures";
import { boxShapeOf, changedBoxFields, rollbackPatch } from "../lib/premiumBoxSync";

/**
 * A provider account, as the admin enters it.
 */
const GOOD_PROVIDER = {
  label: "Example Sports",
  serverUrl: "http://panel.example:8080",
  username: "user_one",
  password: "secret-one",
};

test("a provider needs a name, an address and a credential", () => {
  const { value, errors } = validateProviderInput(GOOD_PROVIDER, true);
  assert.deepEqual(errors, []);
  assert.equal(value.label, "Example Sports");
  assert.equal(value.serverUrl, "http://panel.example:8080");
  assert.equal(value.username, "user_one");
  assert.equal(value.password, "secret-one");
});

test("a provider without a password is refused, and an edit without one keeps the old one", () => {
  const created = validateProviderInput({ ...GOOD_PROVIDER, password: "" }, true);
  assert.deepEqual(created.errors, ["Password is required"]);

  // An edit that does not touch the credential sends no credential, so the box keeps the one it
  // already holds — and the admin never has to type a password he did not just receive.
  const edited = validateProviderInput({ label: "Renamed" }, false);
  assert.deepEqual(edited.errors, []);
  assert.equal(edited.value.password, undefined);
  assert.equal(edited.value.label, "Renamed");
});

test("a provider address is refused the way the box refuses it", () => {
  const cases: Array<[string, string]> = [
    ["not-a-url", "Server URL must be an absolute http(s) URL"],
    ["ftp://panel.example", "Server URL must be an http(s) URL"],
    ["http://panel.example?token=1", "Server URL must not carry a query"],
    ["http://panel.example#x", "Server URL must not carry a fragment"],
    ["http://user:pw@panel.example", "Server URL must not embed a username or password"],
  ];
  for (const [serverUrl, expected] of cases) {
    const { errors } = validateProviderInput({ ...GOOD_PROVIDER, serverUrl }, true);
    assert.ok(
      errors.includes(expected),
      `${serverUrl} should be refused with "${expected}", got ${JSON.stringify(errors)}`
    );
  }
});

test("a credential with a slash in it is refused, because the box builds an address out of it", () => {
  const user = validateProviderInput({ ...GOOD_PROVIDER, username: "user/one" }, true);
  assert.deepEqual(user.errors, ["Username must not contain a slash"]);

  const pass = validateProviderInput({ ...GOOD_PROVIDER, password: "secret/one" }, true);
  assert.deepEqual(pass.errors, ["Password must not contain a slash"]);
});

test("the handle a name implies is a handle the box will take", () => {
  assert.equal(providerHandleFromLabel("Example Sports"), "example-sports");
  assert.equal(providerHandleFromLabel("BAN vs IND"), "ban-vs-ind");
  // The box's rule is two to sixty-four characters starting with a letter or a digit, so a name
  // with nothing to keep in it makes no handle and the admin has to give an id of their own.
  assert.equal(providerHandleFromLabel("!!!"), "");

  const { value, errors } = validateProviderInput(GOOD_PROVIDER, true);
  assert.deepEqual(errors, []);
  assert.equal(value.providerId, "example-sports");

  const typed = validateProviderInput({ ...GOOD_PROVIDER, providerId: "My_Provider" }, true);
  assert.equal(typed.value.providerId, "my_provider");

  const bad = validateProviderInput({ ...GOOD_PROVIDER, providerId: "_leading" }, true);
  assert.ok(bad.errors.includes("Provider ID must be 2-64 characters of letters, digits, - or _"));
});

test("a channel on the box carries an https logo, and a channel with no provider does not", () => {
  assert.equal(boxLogoProblem("https://host.example/logo.png", "example"), null);
  assert.equal(
    boxLogoProblem("http://host.example/logo.png", "example"),
    "Logo URL must be https for a channel that plays from the box"
  );
  // A row with no provider has no lane on the box yet, so its picture is not the box's business.
  assert.equal(boxLogoProblem("http://host.example/logo.png", ""), null);
});

test("a channel names one provider, one stream and the streams it falls back to", () => {
  const { value, errors } = validatePremiumChannelInput(
    {
      name: "Example Sports HD",
      providerId: "example-sports",
      streamId: "1234",
      backupStreamIds: ["1235", "1236"],
    },
    true
  );
  assert.deepEqual(errors, []);
  assert.equal(value.providerId, "example-sports");
  assert.equal(value.streamId, "1234");
  assert.deepEqual(value.backupStreamIds, ["1235", "1236"]);

  const sameStream = validatePremiumChannelInput(
    {
      name: "Example Sports HD",
      providerId: "example-sports",
      streamId: "1234",
      backupStreamIds: ["1234"],
    },
    true
  );
  assert.deepEqual(sameStream.errors, ["Backup stream IDs must not name the primary stream"]);

  const badStream = validatePremiumChannelInput(
    { name: "Example Sports HD", providerId: "example-sports", streamId: "12 34" },
    true
  );
  assert.deepEqual(badStream.errors, ["Stream ID must be 1-32 characters of letters, digits, - or _"]);
});

const ROW = {
  _id: "pc_one",
  name: "Example Sports HD",
  category: "Premium",
  logoUrl: "https://host.example/logo.png",
  providerId: "example-sports",
  streamId: "1234",
  backupStreamIds: ["1235", "1236"],
  proxyChannelKey: "prem-pc_one",
};

test("only the fields that changed are written to the box", () => {
  const before = boxShapeOf(ROW);

  const renamed = boxShapeOf({ ...ROW, name: "Example Sports 2" });
  assert.deepEqual(changedBoxFields(before, renamed), ["displayName"]);

  // A rename must not drop the failover order, so the backups are not in the write at all.
  const reordered = boxShapeOf({ ...ROW, backupStreamIds: ["1236", "1235"] });
  assert.deepEqual(changedBoxFields(before, reordered), ["backupStreamIds"]);

  const moved = boxShapeOf({ ...ROW, providerId: "other-provider" });
  assert.deepEqual(changedBoxFields(before, moved), ["providerId"]);

  // An admin who opened the form and pressed save without changing anything has changed
  // nothing about the channel, and the box must not be told otherwise.
  assert.deepEqual(changedBoxFields(before, boxShapeOf(ROW)), []);
});

test("a refused write is put back exactly as it was", () => {
  const before = boxShapeOf(ROW);
  const after = boxShapeOf({ ...ROW, name: "Example Sports 2", streamId: "9999" });
  const fields = changedBoxFields(before, after);

  const patch = rollbackPatch(before, fields);
  assert.deepEqual(patch, { name: "Example Sports HD", streamId: "1234" });
});

test("a row keeps the handle it was filed under", () => {
  assert.equal(boxShapeOf(ROW).proxyChannelKey, "prem-pc_one");
  assert.equal(boxShapeOf({ ...ROW, proxyChannelKey: "" }).proxyChannelKey, "");
});
