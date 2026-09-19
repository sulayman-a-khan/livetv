import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Normalizes channel names for deduplication & multi-source consolidation.
 * Strips resolutions (1080p, 720p, 480p, 360p, 576p, 4k), broadcast tags (HD, FHD, UHD, SD),
 * server/stream tags, and punctuation.
 * e.g., "Ananda TV (480p)" -> "anandatv", "T Sports HD 1080p" -> "tsports"
 */
export function normalizeChannelName(name: string): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "") // remove parenthetical like (480p), (BD Server), [HD]
    .replace(/\b(hd|fhd|uhd|4k|sd|1080p|720p|576p|480p|360p|240p|server\s*\d*|stream\s*\d*|bd|in|pk|live|tv|network|channel)\b/gi, "")
    .replace(/[^a-z0-9]/g, "")
    .trim() || name.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

/**
 * Auto-detects category and subCategory from channel name or M3U group title.
 */
export function detectCategoryAndCountry(name: string, groupTitle: string = ""): {
  category: string;
  subCategory: string;
  country: string;
} {
  const combined = `${name} ${groupTitle}`.toLowerCase();

  // Country Detection
  let country = "Global";
  if (
    /bangladesh|\bbd\b|bangla|ananda|atn|boishakhi|channel s|channel 24|channel i|dbc|deshi|deepto|duronto|ekattor|ekushey|gtv|gazi|independent|jamuna|maasranga|my tv|nagorik|ntv|rtv|somoy|t sports|tsports|bijoy|mohona|asian tv|sa tv|vokta|nexus|rajdhani|movie bangla/i.test(
      combined
    )
  ) {
    country = "Bangladesh";
  } else if (
    /india|\bin\b|star sports|sony ten|sports18|zee|aaj tak|colors|star plus|ndtv|republic|india today|sony sab|abp|dd sports|ten 1|ten 2|ten 3|sony six|sony max/i.test(
      combined
    )
  ) {
    country = "India";
  } else if (
    /pakistan|\bpk\b|ptv sports|ten sports pk|geo|ary|hum tv|samaa|bol|express|a sports|asports/i.test(
      combined
    )
  ) {
    country = "Pakistan";
  }

  // Category & SubCategory Detection
  let category = "General";
  let subCategory = "Others";

  if (
    /sports|cricket|football|ptv sports|ten sports|star sports|sony ten|t sports|tsports|sports18|willow|bein|sky sports|premier league|icc|a sports|dd sports|sony six/i.test(
      combined
    )
  ) {
    category = "Live Sports";
    if (/cricket|willow|star sports|ptv sports|icc|ipl|bpl|psl|dd sports/i.test(combined)) {
      subCategory = "Cricket";
    } else if (/football|premier league|la liga|champions league|bein|supersport/i.test(combined)) {
      subCategory = "Football";
    } else {
      subCategory = "Others";
    }
  } else if (/news|somoy|jamuna|aaj tak|geo news|cnn|bbc|al jazeera|republic|dbc|channel 24|ekattor|independent|abp|ndtv|india today|ary news|samaa/i.test(combined)) {
    category = "News";
    subCategory = "News";
  } else if (/movie|cinema|hbo|action|film|star movies|sony max|zee cinema|movie bangla/i.test(combined)) {
    category = "Movies";
    subCategory = "Movies";
  } else if (/entertainment|drama|colors|star plus|zee tv|sony tv|hum tv|ary digital|ntv|channel i|boishakhi|deepto|ananda|my tv|deshi|nagorik|atn/i.test(combined)) {
    category = "Entertainment";
    subCategory = "Entertainment";
  }

  return { category, subCategory, country };
}

/**
 * Resolves a high-quality logo URL for a TV channel automatically.
 * Uses official, verified Wikipedia / Wikimedia Commons and high-resolution CDN assets.
 */
export function getChannelLogo(name: string, existingLogo?: string): string {
  // 1. Primary Check: If a custom logo URL or uploaded base64/URL exists, use it FIRST!
  if (
    existingLogo &&
    existingLogo.trim().length > 5 &&
    (existingLogo.trim().startsWith("http") || existingLogo.trim().startsWith("data:image"))
  ) {
    return existingLogo.trim();
  }

  const lower = (name || "").toLowerCase();

  // 2. Specific High-Fidelity Fallback Match Dictionary
  // Bangladesh Channels
  if (lower.includes("t sports") || lower.includes("tsports")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/T_Sports_logo.svg/330px-T_Sports_logo.svg.png";
  }
  if (lower.includes("gtv") || lower.includes("gazi")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/f/f1/Logo_of_GTV_%28Bangladesh%29.svg/330px-Logo_of_GTV_%28Bangladesh%29.svg.png";
  }
  if (lower.includes("somoy")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/c/c4/SOMOY_TV_Logo.svg/330px-SOMOY_TV_Logo.svg.png";
  }
  if (lower.includes("jamuna")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/1/15/Jamuna_Television_Logo.svg/330px-Jamuna_Television_Logo.svg.png";
  }
  if (lower.includes("dbc")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/9/93/%E0%A6%A1%E0%A6%BF%E0%A6%AC%E0%A6%BF%E0%A6%B8%E0%A6%BF_%E0%A6%A8%E0%A6%BF%E0%A6%89%E0%A6%9C%E2%80%93%E0%A6%8F%E0%A6%B0_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B.svg/330px-%E0%A6%A1%E0%A6%BF%E0%A6%AC%E0%A6%BF%E0%A6%B8%E0%A6%BF_%E0%A6%A8%E0%A6%BF%E0%A6%89%E0%A6%9C%E2%80%93%E0%A6%8F%E0%A6%B0_%E0%A6%B2%E0%A7%8B%E0%A6%97%E0%A7%8B.svg.png";
  }
  if (lower.includes("ekattor")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/b/b3/Ekattor_TV_Logo.svg/330px-Ekattor_TV_Logo.svg.png";
  }
  if (lower.includes("independent")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/c/c1/Independent_Television_Logo.svg/330px-Independent_Television_Logo.svg.png";
  }
  if (lower.includes("channel 24") || lower.includes("channel24")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/9/9b/Logo_of_Channel_24_%28Bangladesh%29.svg/330px-Logo_of_Channel_24_%28Bangladesh%29.svg.png";
  }
  if (lower.includes("channel i") || lower.includes("channel-i") || lower.includes("channeli")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/8/88/Channel-i.svg/330px-Channel-i.svg.png";
  }
  if (lower.includes("ntv")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/e/ef/NTV_%28Bangladesh%29_logo.svg/330px-NTV_%28Bangladesh%29_logo.svg.png";
  }
  if (lower.includes("rtv")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/4/4e/Rtv_bangladesh.svg/330px-Rtv_bangladesh.svg.png";
  }
  if (lower.includes("maasranga")) {
    return "https://upload.wikimedia.org/wikipedia/en/3/39/Maasranga_Television_Logo.jpg";
  }
  if (lower.includes("bangla vision") || lower.includes("banglavision")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/1/1d/Banglavision.svg/330px-Banglavision.svg.png";
  }
  if (lower.includes("boishakhi")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/c/c7/Boishakhi_TV_logo.svg/330px-Boishakhi_TV_logo.svg.png";
  }
  if (lower.includes("deepto")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/0/00/Logo_of_Deepto_TV.svg/330px-Logo_of_Deepto_TV.svg.png";
  }
  if (lower.includes("duronto")) {
    return "https://upload.wikimedia.org/wikipedia/en/d/d7/Duronto_TV_Logo.png";
  }
  if (lower.includes("atn bangla") || lower.includes("atn music") || lower.includes("atn")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/9/95/ATN_Bangla_Logo_without_slogan.svg/330px-ATN_Bangla_Logo_without_slogan.svg.png";
  }
  if (lower.includes("ekushey") || lower.includes("etv")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/d/d9/Ekushey_Television_Logo.svg/330px-Ekushey_Television_Logo.svg.png";
  }
  if (lower.includes("btv")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/0/02/Bangladesh_Television_Logo.svg/330px-Bangladesh_Television_Logo.svg.png";
  }
  if (lower.includes("ananda")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/7/77/Ananda_TV_logo.png/330px-Ananda_TV_logo.png";
  }
  if (lower.includes("channel s")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/f/f6/Channel_S_logo.png/330px-Channel_S_logo.png";
  }
  if (lower.includes("deshi")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/d/d5/Deshi_TV_Logo.png/330px-Deshi_TV_Logo.png";
  }
  if (lower.includes("ekhon")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/5/53/Ekhon_TV_Logo.png/330px-Ekhon_TV_Logo.png";
  }
  if (lower.includes("green tv") || lower.includes("greentv")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Green_TV_Logo.png/330px-Green_TV_Logo.png";
  }
  if (lower.includes("movie bangla")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Movie_Bangla_TV_logo.png/330px-Movie_Bangla_TV_logo.png";
  }
  if (lower.includes("my tv") || lower.includes("mytv")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/2/25/My_TV_Bangladesh_Logo.png/330px-My_TV_Bangladesh_Logo.png";
  }
  if (lower.includes("nagorik")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/4/4e/Nagorik_TV_logo.svg/330px-Nagorik_TV_logo.svg.png";
  }
  if (lower.includes("nexus")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/Nexus_Television_Logo.png/330px-Nexus_Television_Logo.png";
  }
  if (lower.includes("rajdhani")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/0/07/Rajdhani_TV_Logo.png/330px-Rajdhani_TV_Logo.png";
  }
  if (lower.includes("rupashi bangla") || lower.includes("rupashibangla")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/Rupashi_Bangla_Logo.png/330px-Rupashi_Bangla_Logo.png";
  }
  if (lower.includes("vokta")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/Vokta_TV_Logo.png/330px-Vokta_TV_Logo.png";
  }
  if (lower.includes("bijoy")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Bijoy_TV_Logo.svg/330px-Bijoy_TV_Logo.svg.png";
  }
  if (lower.includes("mohona")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Mohona_TV_Logo.svg/330px-Mohona_TV_Logo.svg.png";
  }
  if (lower.includes("asian tv") || lower.includes("asiantv")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7b/Asian_TV_Logo.svg/330px-Asian_TV_Logo.svg.png";
  }
  if (lower.includes("sa tv") || lower.includes("satv")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/6/6f/SA_TV_Logo.svg/330px-SA_TV_Logo.svg.png";
  }

  // Indian Channels
  if (lower.includes("star sports")) {
    return "https://upload.wikimedia.org/wikipedia/en/2/22/Star_Sports_Network_logo.png";
  }
  if (lower.includes("sony ten") || lower.includes("sony sports") || lower.includes("sony six") || lower.includes("ten 1") || lower.includes("ten 2") || lower.includes("ten 3")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/c/cd/Sony_Sports_Network.svg/330px-Sony_Sports_Network.svg.png";
  }
  if (lower.includes("sports18") || lower.includes("sports 18")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1d/Sports18_Logo.svg/330px-Sports18_Logo.svg.png";
  }
  if (lower.includes("dd sports") || lower.includes("ddsports")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/DD_Sports_logo_2023.svg/330px-DD_Sports_logo_2023.svg.png";
  }
  if (lower.includes("aaj tak") || lower.includes("aajtak")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/7/77/Aaj_Tak_logo.svg/330px-Aaj_Tak_logo.svg.png";
  }
  if (lower.includes("ndtv")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/NDTV_logo.svg/330px-NDTV_logo.svg.png";
  }
  if (lower.includes("india today")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/8/84/India_Today_logo.svg/330px-India_Today_logo.svg.png";
  }
  if (lower.includes("zee")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/8/8e/Zee_Entertainment_Enterprises_logo.svg/330px-Zee_Entertainment_Enterprises_logo.svg.png";
  }
  if (lower.includes("colors")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/3/30/Colors_TV_logo.svg/330px-Colors_TV_logo.svg.png";
  }
  if (lower.includes("star plus")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/6/6b/Star_Plus_logo_2020.svg/330px-Star_Plus_logo_2020.svg.png";
  }
  if (lower.includes("sony sab") || lower.includes("sab tv")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/7/70/Sony_SAB_Logo_2022.svg/330px-Sony_SAB_Logo_2022.svg.png";
  }
  if (lower.includes("sony max")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/e/e0/Sony_Max_logo.svg/330px-Sony_Max_logo.svg.png";
  }
  if (lower.includes("abp")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/ABP_News_Logo.svg/330px-ABP_News_Logo.svg.png";
  }
  if (lower.includes("republic")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/0/05/Republic_TV_logo.svg/330px-Republic_TV_logo.svg.png";
  }

  // Pakistani Channels
  if (lower.includes("ptv sports") || lower.includes("ptv")) {
    return "https://upload.wikimedia.org/wikipedia/en/e/e4/PTV_Sports.png";
  }
  if (lower.includes("a sports") || lower.includes("asports")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/d/da/A_Sports_HD.png/330px-A_Sports_HD.png";
  }
  if (lower.includes("geo news") || lower.includes("geo super") || lower.includes("geo")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f7/GEO_News_logo_in_Urdu.png/330px-GEO_News_logo_in_Urdu.png";
  }
  if (lower.includes("ary news") || lower.includes("ary digital") || lower.includes("ary")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/4/4c/ARY_Digital_Network_logo.svg/330px-ARY_Digital_Network_logo.svg.png";
  }
  if (lower.includes("hum tv") || lower.includes("hum news") || lower.includes("hum")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/9/90/Hum_TV_Logo.svg/330px-Hum_TV_Logo.svg.png";
  }
  if (lower.includes("ten sports")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/8/87/Ten_Sports_Logo.svg/330px-Ten_Sports_Logo.svg.png";
  }
  if (lower.includes("samaa")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/4/48/Samaa_TV_logo.png/330px-Samaa_TV_logo.png";
  }
  if (lower.includes("bol news") || lower.includes("bol network") || lower.includes("bol")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/3/30/BOL_Network_logo.png/330px-BOL_Network_logo.png";
  }

  // International Sports & News
  if (lower.includes("willow")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/8/87/Willow_TV_logo.svg/330px-Willow_TV_logo.svg.png";
  }
  if (lower.includes("sky sports")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/b/be/Sky_Sports_logo_2020.svg/330px-Sky_Sports_logo_2020.svg.png";
  }
  if (lower.includes("bein sports") || lower.includes("bein")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b3/BeIN_Sports_logo.svg/330px-BeIN_Sports_logo.svg.png";
  }
  if (lower.includes("supersport")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/5/5e/SuperSport_logo_2020.svg/330px-SuperSport_logo_2020.svg.png";
  }
  if (lower.includes("cnn")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b1/CNN.svg/330px-CNN.svg.png";
  }
  if (lower.includes("bbc")) {
    return "https://upload.wikimedia.org/wikipedia/commons/thumb/4/41/BBC_Logo_2021.svg/330px-BBC_Logo_2021.svg.png";
  }
  if (lower.includes("al jazeera") || lower.includes("aljazeera")) {
    return "https://upload.wikimedia.org/wikipedia/en/thumb/f/f2/Al_Jazeera_English_logo.svg/330px-Al_Jazeera_English_logo.svg.png";
  }

  // 3. Fallback: Clean Dynamic TV Logo Badge with Channel Title
  const cleanName = name.replace(/\(.*?\)|\[.*?\]/g, "").trim() || name;
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(
    cleanName
  )}&background=0284c7&color=ffffff&size=256&bold=true&font-size=0.3&rounded=true`;
}

/** Maps a channel/category country name to its flag emoji (falls back to a globe icon). */
export function getCountryFlag(country?: string): string {
  const key = (country || "").trim().toLowerCase();
  const flags: Record<string, string> = {
    bangladesh: "🇧🇩",
    india: "🇮🇳",
    pakistan: "🇵🇰",
    global: "🌍",
  };
  return flags[key] || "🌐";
}
