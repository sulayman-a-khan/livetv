# Archived tiers

This directory holds three tiers that used to be part of the SoluPlay app and are no
longer part of it. **Nothing was deleted.** Every file is here, byte for byte, at the path
it had when it was active, so restoring a tier is a move back rather than a
reconstruction from git history.

The app that remains is **Direct HLS**: the M3U catalogue, the watch page, the stream
health checks, the admin control panel, and the match fixtures on the homepage. Nothing in
this directory is imported by it, and nothing in this directory is compiled, linted, tested
or deployed while it sits here.

| Archive group | What it was | Restore it when |
| --- | --- | --- |
| `secured-hls-premium/` | The Secured HLS / Premium tier: premium channels held in the site database but played by a separate stream box that owns the provider credentials. | You want premium channels back on the site, and you have a running box to play them from. |
| `proxy-24x7/` | The 24/7 proxy control tier: the admin panel that reads and drives the box's own health, provider rows and counters. | You want the box's control panel back in the admin gate. |
| `local-server-box/` | The Local Server (the stream box on the operator's own PC): how the site learns where the box is and how the two authenticate. | You are restoring the box itself, or the tier above that needs it. |

`proxy-24x7/` and `local-server-box/` are the two halves of one system: the box is the
Local Server, and the 24/7 panel is how the site watches it. The Secured HLS tier also
depends on the box (it pushes channels onto it and signs playback URLs through it), so
restoring `secured-hls-premium/` means restoring `local-server-box/` with it.

---

## 1. What each component was, and where it came from

Paths in the "was" column are the paths the files had **before** the isolation. The file
inside this archive is at the same path, relative to its group folder.

### 1.1 `secured-hls-premium/` — the Secured HLS / Premium tier

The idea behind this tier: a premium channel's upstream URL and headers never live in the
site. The admin pastes a source line into the panel, it is pushed straight to the stream
box and discarded here, and a viewer's playlist URL is signed by the box and read on the
server. A leak of the site database hands over nothing watchable.

#### Server routes (was `app/api/…`)

| Was | Now | Purpose |
| --- | --- | --- |
| `app/api/admin/premium/channels/route.ts` | `secured-hls-premium/app/api/admin/premium/channels/route.ts` | Admin list + create of premium channels. |
| `app/api/admin/premium/channels/[id]/route.ts` | `…/channels/[id]/route.ts` | Admin edit + delete of one premium channel. The delete also took the channel's link off every fixture card that named it. |
| `app/api/admin/premium/channels/[id]/push/route.ts` | `…/channels/[id]/push/route.ts` | Pushes a pasted source line (manifest URL + at most two headers) to the box, and retracts it. |
| `app/api/admin/premium/providers/route.ts` | `…/providers/route.ts` | Admin list + create of provider accounts registered on the box. |
| `app/api/admin/premium/providers/[id]/route.ts` | `…/providers/[id]/route.ts` | Admin edit + delete of one provider account. |
| `app/api/admin/premium/providers/[id]/channels/route.ts` | `…/providers/[id]/channels/route.ts` | Reads one provider account's own channel list (names, categories, stream ids — never a credential). |
| `app/api/admin/premium/live/route.ts` | `…/live/route.ts` | The "live on the box" panel: which channels the box currently holds, and the live switch. |
| `app/api/admin/premium/session/route.ts` | `…/session/route.ts` | Admin session probe for the premium panel. |
| `app/api/premium/channels/route.ts` | `secured-hls-premium/app/api/premium/channels/route.ts` | The public channel list behind the homepage rail. |
| `app/api/premium/[id]/play/route.ts` | `…/premium/[id]/play/route.ts` | Signs a playback URL for one premium channel, server-side, and answers with a refusal code when it cannot. |

#### Pages and components (was `app/…`, `components/…`)

| Was | Purpose |
| --- | --- |
| `app/premium-admin/page.tsx` | The premium admin page (`/premium-admin`). |
| `app/premium/[id]/page.tsx` | The premium watch page (`/premium/<id>`). |
| `components/premium-admin/PremiumAdminDashboard.tsx` | The premium dashboard shell. |
| `components/premium-admin/PremiumChannelPanel.tsx` | The premium channel list and editor. |
| `components/premium-admin/ProviderPanel.tsx` | The provider account list and editor. |
| `components/premium-admin/LivePanel.tsx` | The "live on the box" panel. |
| `components/premium-admin/ProviderChannelPicker.tsx` | Picks a channel out of a provider account's own list. |
| `components/premium-admin/providerChannelPick.ts` | The pure rules of that picker (a backup must land in a backup slot). |
| `components/premium-admin/useBoxProviders.ts` | Data hook for the provider list. |
| `components/premium-admin/useProviderCatalogue.ts` | Data hook for one account's channel list. |
| `components/premium/PremiumChannelStrip.tsx` | The homepage rail of premium channels, above the direct grid. |
| `components/premium/PremiumPlayer.tsx` | The premium player and its fallback walk between a card's channels. |

#### Libraries (was `lib/…`, `models/…`)

| Was | Purpose |
| --- | --- |
| `lib/premiumStore.ts` | The storing half: reads and writes of premium channels, from MongoDB when it is reachable and from the tier's own local file when it is not. |
| `lib/premiumLocalStore.ts` | The tier's own local store file, used only when there is no MongoDB. |
| `lib/premiumFixtures.ts` | The pure half: what a valid premium channel, provider registration and source push look like. |
| `lib/premiumBoxSync.ts` | The bond with the box: what a row here says and what the box holds for it, and the failover order. |
| `lib/premiumProxy.ts` | The tier's only door to the box: signing playback URLs and pushing sources. |
| `lib/premiumReadiness.ts` | Whether the box can serve a premium stream *right now*, asked of the box's own `/healthz`. |
| `lib/premiumPlayFailure.ts` | The tier's refusals, in both the server's code vocabulary and the viewer's Bengali sentences. |
| `models/PremiumChannel.ts` | The `PremiumChannel` collection schema. |

#### Test and harness files

Were at `tests/…` and `scripts/…`:

`tests/premium-channels.test.ts`, `tests/premium-store.test.ts`,
`tests/premium-panel.test.ts`, `tests/premium-readiness.test.ts`,
`tests/premium-play-failure.test.ts`, `tests/premium-box-sync.test.ts`,
`tests/provider-catalogue.test.ts`, `tests/provider-channel-pick.test.ts`,
`scripts/premium-box-e2e.mjs`.

One file here was never in `tests/`: `tests/fixture-stale-links-premium.test.ts` was
**written for this archive**, out of the premium half of the active
`tests/fixture-stale-links.test.ts`.

Those two need a word each:

- `tests/fixture-stale-links-premium.test.ts` is the **premium half** of the stale-link
  rule, moved out of the active `tests/fixture-stale-links.test.ts` when that file was
  rewritten for Direct HLS only. It locks the behaviour that deleting a premium channel
  takes its link off every card.
- `scripts/premium-box-e2e.mjs` is the end-to-end harness that drives a real box. It is
  **never** run by CI: it needs the private ProxyServer checkout and a running box.

### 1.2 `proxy-24x7/` — the 24/7 proxy control tier

A read/write control panel for the box itself: what it holds, whether it is healthy, and a
closed table of ten actions that change a row — `refresh_vault`, `set_provider_active`,
`set_channel_active`, `probe_channel`, and the create/update/delete of a provider account
and of a channel.

| Was | Purpose |
| --- | --- |
| `app/proxy-admin/page.tsx` | The 24/7 control panel page (`/proxy-admin`). |
| `components/proxy-admin/ProxyAdminDashboard.tsx` | The panel itself. |
| `components/proxy-admin/proxyActionLabels.ts` | The ten action names and their labels. |
| `components/proxy-admin/proxyBanner.ts` | The status banner at the top of the panel. |
| `app/api/admin/proxy/status/route.ts` | The box's health and counters, projected into a fixed shape. |
| `app/api/admin/proxy/inspect/route.ts` | A read-only inspection of the box's vault. |
| `app/api/admin/proxy/session/route.ts` | Whether this server is configured to talk to a box at all. |
| `app/api/admin/proxy/action/route.ts` | Performs one of the ten write actions, server-side. |
| `app/api/admin/proxy/boxes/route.ts` | Lists enrolled boxes, and creates an enrollment. |
| `app/api/admin/proxy/boxes/[id]/revoke/route.ts` | Revokes one enrolled box. |
| `lib/proxyControl.ts` | The read half: the only place the site asks the box anything. |
| `lib/proxyActions.ts` | The write half: the only place the site holds the box's write credential. The action list is closed — a caller names one of ten actions and supplies only the arguments that action reads. |
| `tests/proxy-control.test.ts`, `tests/proxy-actions.test.ts` | Their tests. |

### 1.3 `local-server-box/` — the Local Server (the stream box)

The box lives on the operator's own PC and has an address that moves (a quick tunnel's
hostname changes every time it starts). This half is how the site learns where the box is
and how the two authenticate.

| Was | Purpose |
| --- | --- |
| `app/api/proxy/box/enroll/route.ts` | The box redeems an enrollment token it was given, once. |
| `app/api/proxy/box/register/route.ts` | The box says where it is; the site keeps that answer. |
| `lib/boxRegistry.ts` | Who may register, whether the box is admitted, and where its address is kept. |
| `lib/boxCredentials.ts` | Per-box credentials derived from one master secret. |
| `models/ProxyBox.ts` | The `ProxyBox` collection schema. |
| `tests/box-registry.test.ts` | Its test. |

#### Not here, because they were already gone before this archive

The original "local PC server" application (`local-pc-server/`) and the site-side forwarder
`lib/streamUrl.ts` were deleted from this repository in commit `b868397` (2026-10-20).
They are **not** in this archive and cannot be restored from it. They survive only in git
history. The box as it exists today is the portable ProxyServer in the separate private
repository `ProxyServer/`, and `local-server-box/` is the site's half of that
conversation.

---

## 2. What was disconnected

Nothing was deleted; these are the places that used to reach into the archived tiers and
no longer do.

### 2.1 Imports removed

| File | What it used to import | What it does now |
| --- | --- | --- |
| `app/api/fixtures/route.ts` | `listPremiumBoardChannels` from `@/lib/premiumStore`; `isPremiumReady`, `readPremiumReadiness` from `@/lib/premiumReadiness` | Reads the cards and the Direct HLS catalogue only. The response no longer carries a `securedReady` field and the route no longer probes a box. |
| `app/page.tsx` | `PremiumChannelStrip` from `@/components/premium/PremiumChannelStrip` | The homepage shows the Direct HLS grid and the fixture board. The premium rail is gone. |
| `components/AdminPanelChooser.tsx` | `Link` (for `/premium-admin` and `/proxy-admin`), `CalendarClock`, `Crown`, `Server`, `ShieldCheck` | One option: the Direct HLS control panel. |

### 2.2 Routes that no longer exist

Because their files were moved out of `app/`, Next.js no longer serves them. Every one of
these now answers 404:

- `/premium-admin`
- `/premium/<id>`
- `/premium/channels` (API)
- `/premium/<id>/play` (API)
- `/api/admin/premium/**`
- `/proxy-admin`
- `/api/admin/proxy/**`
- `/api/proxy/box/enroll`
- `/api/proxy/box/register`

### 2.3 Navigation that was removed

`components/AdminPanelChooser.tsx` used to offer three panels — Direct HLS, Secure/Premium
and 24/7 Proxy. Only Direct HLS is offered now. `app/admin-secret-gate/page.tsx` renders
the chooser and needed no change.

### 2.4 Configuration references that were removed

| File | What was removed |
| --- | --- |
| `package.json` | The scripts `test:premium-channels`, `test:premium-store`, `test:premium-panel`, `test:premium-readiness`, `test:premium-play-failure`, `test:premium-box`, `test:box-registry`, `test:proxy-control`, `test:proxy-actions`, `test:provider-catalogue`, `test:provider-pick`. |
| `tsconfig.tests.json` | The `include` entries for every archived route, component and library. |
| `tsconfig.json` | `"archive"` was added to `exclude` (the app's `include` is `**/*.ts`, so without it the archive would be type-checked). |
| `.eslintrc.js` | `"archive/"` was added to `ignorePatterns`. |
| `scripts/verify-ci-gate.mjs` | The check that required a `test:premium-box` script to exist was replaced by one that requires the harness to be **archived and inactive**; the gate now also asserts that the archive exists, carries its guide, is not compiled, and that no archived script is named by the workflow. |

### 2.5 What was deliberately left alone

- **`lib/fixtureBoard.ts`** keeps its secured branch. It is a pure module with no premium
  import, it is Phase 1's own deliverable, and with no secured channel list to resolve it
  can never produce a `/premium/…` path. Its `securedReady` argument is now always `false`
  at the one call site.
- **`lib/fixtures.ts`** keeps the `secured` source type in its vocabulary. A card written
  before Phase 1 may still carry a secured reference; the rules read it, keep it and never
  write one, and that is what stops an edit from silently dropping a link.
- **`models/Fixture.ts`** keeps the legacy `premiumChannelId` field, because
  `lib/fixtureStore.ts` reads it to understand a row written before the channels list
  existed. Removing it would strand old rows.
- **`scripts/repair-fixture-indexes.mjs`** still names `premiumChannelId`, for the same
  reason: it is a data field, not a code dependency.

---

## 3. What must stay active for Direct HLS

These are **not** part of the archive and must never be moved with it. Several of them are
also dependencies the archive needs when it is restored, so they are listed with what the
archive uses them for.

| Stays active | Why | Does the archive use it? |
| --- | --- | --- |
| `lib/db.ts` | The one database door: `connectToDatabase`, `requirePersistingStore`, `requireDatabase`. | Yes — the premium admin routes and the proxy routes call `connectToDatabase`. |
| `lib/adminAuth.ts` | The admin secret check every admin route uses. | Yes — every `/api/admin/premium/**` and `/api/admin/proxy/**` route. |
| `lib/validation.ts` | The shared input validators (`toText`, `toBool`, `toIntInRange`, `toOptionalUrl`, `isHttpUrl`). | Yes — `lib/premiumFixtures.ts` and `lib/proxyActions.ts` import from it. |
| `lib/fixtureBoard.ts` | The viewer-facing board projection, shared by the homepage and the admin panel. | Yes — `components/premium/PremiumPlayer.tsx` imports `nextFallbackChannel`. |
| `lib/fixtureStore.ts`, `lib/fixtureSources.ts`, `lib/fixtures.ts`, `models/Fixture.ts` | The Phase 1 fixture implementation: cards in MongoDB, Direct channels only. | Yes — the archived premium store reads the fixture rows to find the card that carries a premium channel. |
| `components/FixturePanel.tsx` | The Phase 1 fixture editor, inside the Direct HLS admin panel. | No. |
| `components/AdminDashboard.tsx` | The Direct HLS control panel. | No. |
| `components/AdminSection.tsx`, `components/Header.tsx`, `lib/utils.ts` | Shared shell pieces the archived pages were built from. | Yes — `AdminSection`, `Header` and `lib/utils`. |
| `lib/channelIdentity.ts`, `lib/channelMaintenance.ts`, `lib/streamHealth.ts`, `lib/inMemoryStore.ts`, `models/Channel.ts`, `models/StreamLink.ts` | The Direct HLS catalogue, its ranking and its health pass. | No. |
| `lib/ssrfGuard.ts`, `lib/safeFetch.ts` | The outbound-fetch guards the Direct HLS probes rely on. | No. |
| `lib/youtube.ts`, `lib/youtubeResolveGuard.ts`, `middleware.ts` | The bounded YouTube resolver, guarded in middleware. | No. |
| `lib/teamFlags.ts` | National-team flags for the match cards. | No. |

The Direct HLS tier's own data — `data/store.json`, the `Channel` and `StreamLink`
collections — was **not** touched by this isolation.

---

## 4. What a restoration needs

Names only. No value in this repository, this file or this guide.

### 4.1 Environment variables

| Name | Needed by | What it is |
| --- | --- | --- |
| `ADMIN_SECRET_KEY` | `secured-hls-premium`, `proxy-24x7` | The admin gate secret. The whole app's admin surface is behind it, archived tiers included. `local-server-box` does not need it: the box proves itself with an enrollment code and its own derived token, not with the admin secret. |
| `MONGODB_URI` | All three groups | The MongoDB connection string. The premium channels live in the `PremiumChannel` collection and the enrolled boxes in the `ProxyBox` collection; both collections are still in Atlas and were left untouched. |
| `PROXY_BOX_SECRET` | `secured-hls-premium`, `proxy-24x7`, `local-server-box` | The one master secret the per-box credentials are derived from. Without it the site refuses every box registration, and there is no default. |
| `PROXY_BASE_URL` | All three groups | The box's address, when it is known in advance. If it is not set, the site resolves the address from the box's own registration instead. `local-server-box` reads it too — it is the registry's own fallback address when no box has registered one. |
| `PREMIUM_STORE_FILE` | `secured-hls-premium` | Path of the premium tier's local store file, used only when there is no MongoDB. Its default path is `data/premium-store.json`. |
| `BOX_REGISTRY_FILE` | `local-server-box` | Path of the box registry's local file, used only when there is no MongoDB. Its default path is `data/proxy-box.json`. Only the runtime code in `local-server-box` reads it; the archived **tests** of the other two groups override it to a temporary file, so a restored test run never touches the real registry. |
| `SOLUPLAY_PROXY_DIR` | `secured-hls-premium` | Where the private ProxyServer checkout is, for the `test:premium-box` end-to-end harness. It points at the box's source, not at a runtime value. |

`CRON_SECRET`, `YOUTUBE_API_KEY` and `NEXT_PUBLIC_ENABLE_ADS` belong to Direct HLS and are
unaffected by this archive.

### 4.2 Services and credentials

1. **A running stream box** — the portable ProxyServer from the private `ProxyServer/`
   repository, on the operator's own PC, reachable from the deployed site. It owns the
   provider credentials; the site never holds them.
2. **A provider account** registered *on the box*, not on the site. The site can read the
   account's channel list but not its credential.
3. **The box's own configuration kit** — the master secret the box derives its three
   tokens from must match the site's `PROXY_BOX_SECRET`.
4. **The site's `ADMIN_SECRET_KEY`**, unchanged — the archived panels authenticate with the
   same secret as the Direct HLS panel.

### 4.3 Collections that must still be there

`PremiumChannel` and `ProxyBox` in Atlas were not dropped. If the database was purged
while this archive was in place, those collections have to be recreated before the tier
can be restored — `models/PremiumChannel.ts` and `models/ProxyBox.ts` carry the schemas.

---

## 5. How to restore — for the next agent

The archive is laid out so that restoration is **moving files back to the paths they came
from**. Nothing has to be rewritten.

### 5.1 Restore one group

For each group you are restoring, move its files out of the archive and back to their
original paths:

```bash
# Secured HLS / Premium tier
git mv archive/secured-hls-premium/app/api/admin/premium      app/api/admin/premium
git mv archive/secured-hls-premium/app/api/premium             app/api/premium
git mv archive/secured-hls-premium/app/premium                 app/premium
git mv archive/secured-hls-premium/app/premium-admin           app/premium-admin
git mv archive/secured-hls-premium/components/premium          components/premium
git mv archive/secured-hls-premium/components/premium-admin    components/premium-admin
git mv archive/secured-hls-premium/lib/*.ts                    lib/
git mv archive/secured-hls-premium/models/PremiumChannel.ts    models/
git mv archive/secured-hls-premium/scripts/premium-box-e2e.mjs scripts/
git mv archive/secured-hls-premium/tests/*.test.ts              tests/

# 24/7 proxy control tier
git mv archive/proxy-24x7/app/api/admin/proxy                  app/api/admin/proxy
git mv archive/proxy-24x7/app/proxy-admin                      app/proxy-admin
git mv archive/proxy-24x7/components/proxy-admin                components/proxy-admin
git mv archive/proxy-24x7/lib/*.ts                              lib/
git mv archive/proxy-24x7/tests/*.test.ts                      tests/

# Local Server (the box)
git mv archive/local-server-box/app/api/proxy                  app/api/proxy
git mv archive/local-server-box/lib/*.ts                       lib/
git mv archive/local-server-box/models/ProxyBox.ts             models/
git mv archive/local-server-box/tests/box-registry.test.ts      tests/
```

`git mv` keeps the history attached to the file, so the restored file shows as a rename
rather than a new file.

**Restore `local-server-box/` first.** Both other groups call `lib/boxRegistry.ts` and
`lib/boxCredentials.ts`; without them the restored code will not compile.

### 5.2 Put the configuration back

1. **`tsconfig.tests.json`** — add back the `include` entries for the restored files. The
   exact list is the set of paths this archive was taken from:

   ```
   "app/api/admin/premium/channels/route.ts",
   "app/api/admin/premium/channels/[id]/route.ts",
   "app/api/admin/premium/live/route.ts",
   "app/api/admin/premium/providers/route.ts",
   "app/api/admin/premium/providers/[id]/route.ts",
   "app/api/admin/premium/providers/[id]/channels/route.ts",
   "app/api/admin/proxy/action/route.ts",
   "app/api/admin/proxy/inspect/route.ts",
   "app/api/admin/proxy/session/route.ts",
   "app/api/admin/proxy/status/route.ts",
   "app/api/admin/proxy/boxes/route.ts",
   "app/api/admin/proxy/boxes/[id]/revoke/route.ts",
   "app/api/premium/[id]/play/route.ts",
   "app/api/proxy/box/enroll/route.ts",
   "app/api/proxy/box/register/route.ts",
   "components/proxy-admin/proxyActionLabels.ts",
   "components/proxy-admin/proxyBanner.ts",
   "components/premium-admin/providerChannelPick.ts",
   "lib/boxRegistry.ts",
   "lib/premiumBoxSync.ts",
   "lib/premiumFixtures.ts",
   "lib/premiumLocalStore.ts",
   "lib/premiumPlayFailure.ts",
   "lib/premiumProxy.ts",
   "lib/premiumReadiness.ts",
   "lib/premiumStore.ts",
   "lib/proxyActions.ts",
   "lib/proxyControl.ts"
   ```

2. **`package.json`** — add back the scripts for the restored tests. The names the CI gate
   expects are:

   ```
   "test:premium-channels":   "tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/premium-channels.test.js",
   "test:premium-store":      "tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/premium-store.test.js",
   "test:premium-panel":      "tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/premium-panel.test.js",
   "test:premium-readiness":  "tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/premium-readiness.test.js",
   "test:premium-play-failure":"tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/premium-play-failure.test.js",
   "test:provider-catalogue": "tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/provider-catalogue.test.js",
   "test:provider-pick":      "tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/provider-channel-pick.test.js",
   "test:proxy-control":      "tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/proxy-control.test.js",
   "test:proxy-actions":      "tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/proxy-actions.test.js",
   "test:box-registry":       "tsc -p tsconfig.tests.json && node --test .tmp-tests/tests/box-registry.test.js",
   "test:premium-box":        "node scripts/premium-box-e2e.mjs"
   ```

   `test:premium-box` is the box end-to-end harness. It is **excluded from CI** on
   purpose — it needs the private ProxyServer checkout and a running box. The CI gate
   (`scripts/verify-ci-gate.mjs`) asserts that the harness exists and that the workflow
   does not name it, so keep it out of `.github/workflows/ci.yml`.

3. **`tsconfig.json`** — remove `"archive"` from `exclude` once the archive is empty, or
   keep it while other groups remain archived.

4. **`.eslintrc.js`** — remove `"archive/"` from `ignorePatterns` for the same reason.

### 5.3 Reconnect the application

These are the four places the isolation cut, and what each one needs.

**`app/api/fixtures/route.ts`** — the public board. To restore the secured half:

- re-import `listPremiumBoardChannels` from `@/lib/premiumStore` and
  `isPremiumReady`, `readPremiumReadiness` from `@/lib/premiumReadiness`;
- read the readiness verdict again and pass it to `projectFixtures`;
- resolve the secured ids with `referencedChannelIds(resolvable, "secured")`;
- put `securedReady` back in the response body, and restore the cache rule that was
  `securedReady && publicFixtures.length > 0 ? READY_CACHE : "no-store"` — the board is
  only safe to cache for as long as the readiness verdict inside it is trustworthy.

**`app/page.tsx`** — re-import and re-render `PremiumChannelStrip` above the direct grid.

**`components/AdminPanelChooser.tsx`** — add the premium and proxy options back, with the
`Link` import and the `CalendarClock`, `Crown`, `Server` and `ShieldCheck` icons. Keep the
three panels on their own screens, their own routes and their own collections: do not
fold the premium or proxy sections into `components/AdminDashboard.tsx`.

**`tests/fixture-stale-links.test.ts`** — the premium delete-cascade test now lives at
`archive/secured-hls-premium/tests/fixture-stale-links-premium.test.ts`. Move it back to
`tests/` and add it to `tsconfig.tests.json` and to the `test:all` glob (the glob already
covers everything in `tests/`, so moving the file is enough).

### 5.4 Do not restore these

- **`lib/streamUrl.ts` and `local-pc-server/`** — deleted in `b868397`; they are not here.
- **The Direct HLS tier** — never move it into the archive. It is the product.
- **`models/Fixture.ts`'s `premiumChannelId`** — keep the legacy field; the archive's
  premium store reads it.

---

## 6. After a restoration: what to check

### 6.1 The gates

```bash
npm run typecheck        # the app's own type check; must be clean
npm run lint             # must be clean
npm run test:all         # every test in tests/ must pass
npm run check:ci-gate    # every check must pass
npm run build            # a production build must succeed
```

`npm run check:ci-gate` is the one that will tell you a restoration is incomplete: it
asserts that every `test:*` script names a test file that exists, that every test file is
inside the aggregate run, and that the workflow names no script that does not exist.

### 6.2 The restored tests

Run each restored suite on its own before running the aggregate:

```bash
npm run test:premium-store
npm run test:premium-channels
npm run test:premium-readiness
npm run test:premium-play-failure
npm run test:premium-panel
npm run test:provider-catalogue
npm run test:provider-pick
npm run test:proxy-control
npm run test:proxy-actions
npm run test:box-registry
```

`npm run test:premium-box` is the end-to-end harness against a real box. It is not part of
CI. Run it by hand, with the box up and the environment named in §4.1.

### 6.3 The live checks

1. **The Direct HLS tier is unharmed.** The homepage grid, the watch page, the stream
   health checks and the admin control panel all behave exactly as they did before the
   restoration. The fixture board still creates a card, persists it in MongoDB, and shows
   it on the homepage.
2. **The premium rail is back and honest.** The homepage shows premium channels only when
   the box answers. An unreachable box must leave the premium choices unavailable and the
   Direct HLS choices untouched.
3. **A premium channel plays.** Open `/premium/<id>`, confirm the signed URL is read on
   the server, and confirm no upstream URL, header or token is ever present in a
   viewer-facing response.
4. **The panels are separate.** `/premium-admin` and `/proxy-admin` work and reach
   nothing in the Direct HLS panel; the Direct HLS panel reaches nothing in theirs.
5. **The box registers and is revocable.** The box enrolls, registers its address, the
   site resolves it, and revoking the box stops the site from reaching it.
6. **Nothing leaked.** Check the site's environment and the box's configuration: no
   provider credential is in the site's database, in a response, or in a log line.
