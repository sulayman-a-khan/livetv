# Mobile app build note

The SoluPlay mobile app is planned as a **WebView wrapper around this site** — no separate app codebase. Because the same pages are served to browsers and to the app, web-only UI is switched off by one shared signal.

## Required: declare the app in the WebView User-Agent

The site looks for a single token, defined in `lib/appRuntime.ts`:

```ts
export const EMBEDDED_APP_UA_TOKEN = "SoluPlayApp";
```

Append it to the WebView's User-Agent. The app's build **must** do this, or the web-only "download our app" promos show up inside the app.

**Android / Kotlin (WebView):**

```kotlin
val base = WebSettings.getDefaultUserAgent(context)
webView.settings.userAgentString = "$base SoluPlayApp/1.0"
```

**iOS / Swift (WKWebView):**

```swift
let config = WKWebViewConfiguration()
config.applicationNameForUserAgent = "SoluPlayApp/1.0"
let webView = WKWebView(frame: .zero, configuration: config)
```

Any other framework (Capacitor, Cordova, Tauri, etc.) is fine as long as the UA it sends ends with the same token.

**App entry URL:** _fill in the production site URL when the app shell is built._

## What the token changes today

| UI | Web | App |
| --- | --- | --- |
| App-download news ticker under the direct-HLS player (`components/NewsTicker.tsx`) | shown | hidden |
| Navbar "Download the APP NOW!" promo (`components/Header.tsx`) | shown | hidden |
| App promo above the homepage footer (`components/AppDownloadBanner.tsx`) | shown under 768px | hidden |

## Adding more web/app differences later

- Branch on `isEmbeddedApp()` from `lib/appRuntime.ts`. Keep all app-vs-web divergence behind that one function so the WebView contract never fragments.
- Client components only, and gate rendering in an effect after mount (as `NewsTicker` does). Reading `navigator` during render causes a hydration mismatch, since the server has no User-Agent.
- Do **not** sniff for `wv)` or other generic WebView markers: that pattern also matches in-app browsers like Facebook and Instagram, whose visitors are exactly the people who still need the download prompt — and iOS WKWebView exposes no marker at all.

## Verifying the app branch without the app

Spoof the UA before page scripts run, then load the homepage and any `/watch/[id]` page. In Chrome DevTools, override the User-Agent to end with `SoluPlayApp/1.0`: the navbar promo, the footer promo and the ticker should all be absent from the DOM (and never fetched), while the logo, player and rails still render.
