import { normalizeChannelName, detectCategoryAndCountry, getChannelLogo } from "./utils";

export interface ParsedM3uChannel {
  name: string;
  normalizedName: string;
  logo: string;
  category: string;
  subCategory: string;
  country: string;
  streamUrl: string;
}

/**
 * Parses raw M3U text content into structured objects.
 */
export function parseM3uContent(content: string): ParsedM3uChannel[] {
  const lines = content.split(/\r?\n/);
  const channels: ParsedM3uChannel[] = [];

  let currentMeta: {
    name?: string;
    logo?: string;
    groupTitle?: string;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXTINF:")) {
      currentMeta = {};

      // Extract tvg-logo
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      if (logoMatch) currentMeta.logo = logoMatch[1];

      // Extract tvg-name or fallback to comma separated display name
      const nameMatch = line.match(/tvg-name="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      if (groupMatch) currentMeta.groupTitle = groupMatch[1];

      // Extract display name after comma
      const commaIndex = line.lastIndexOf(",");
      const displayName = commaIndex !== -1 ? line.substring(commaIndex + 1).trim() : "";

      currentMeta.name = nameMatch && nameMatch[1] ? nameMatch[1] : displayName || "Unknown Channel";
    } else if (line.startsWith("http://") || line.startsWith("https://")) {
      if (currentMeta && currentMeta.name) {
        const rawName = currentMeta.name;
        const normalized = normalizeChannelName(rawName);

        if (normalized) {
          const { category, subCategory, country } = detectCategoryAndCountry(
            rawName,
            currentMeta.groupTitle || ""
          );

          // Resolve logo online if tvg-logo attribute was missing or empty
          const logo = getChannelLogo(rawName, currentMeta.logo || "");

          channels.push({
            name: rawName,
            normalizedName: normalized,
            logo,
            category,
            subCategory,
            country,
            streamUrl: line,
          });
        }
      }
      currentMeta = null;
    }
  }

  return channels;
}
