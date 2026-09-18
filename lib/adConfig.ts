export const AD_CONFIG = {
  // Toggle ad status globally
  enabled: process.env.NEXT_PUBLIC_ENABLE_ADS === "true" || false,
  
  // Frequency cap in hours (24 hours default requirement)
  frequencyCapHours: 24,

  // Demo Video / Banner Ad URL
  adVideoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
  adTitle: "Sponsor Advertisement",
  adDurationSeconds: 15,
};

const STORAGE_KEY = "freetv_last_ad_timestamp";

/**
 * Checks whether an ad should be displayed based on 24-hour timestamp verification.
 */
export function shouldShowAd(): boolean {
  if (!AD_CONFIG.enabled) return false;

  if (typeof window === "undefined") return false;

  try {
    const lastShownStr = localStorage.getItem(STORAGE_KEY);
    if (!lastShownStr) return true;

    const lastShownTime = parseInt(lastShownStr, 10);
    if (isNaN(lastShownTime)) return true;

    const now = Date.now();
    const elapsedHours = (now - lastShownTime) / (1000 * 60 * 60);

    return elapsedHours >= AD_CONFIG.frequencyCapHours;
  } catch (err) {
    console.error("Error reading ad localStorage:", err);
    return false;
  }
}

/**
 * Record that an ad was shown right now.
 */
export function recordAdShown(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, Date.now().toString());
  } catch (err) {
    console.error("Error saving ad timestamp to localStorage:", err);
  }
}
