// The SoluPlay mobile app is planned to wrap this site in a WebView. Web-only UI
// (the app-download news ticker) hides itself when the app declares itself here,
// so the app must append EMBEDDED_APP_UA_TOKEN to its WebView User-Agent string.
// Deliberately an explicit token: sniffing for "wv)" would also match in-app
// browsers like Facebook/Instagram, whose users still need the download prompt.
export const EMBEDDED_APP_UA_TOKEN = "SoluPlayApp";

// Placeholder until the real app download URL exists
export const APP_DOWNLOAD_URL = "https://example.com/soluplay-app";

export function isEmbeddedApp(userAgent?: string): boolean {
  const ua = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  return ua.includes(EMBEDDED_APP_UA_TOKEN);
}
