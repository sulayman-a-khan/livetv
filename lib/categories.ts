export interface CategoryConfig {
  slug: string;
  name: string;
  title: string;
  badge: string;
  flag: string;
  subtitle: string;
  description: string;
  image: string;
  filterType: "category" | "country";
  filterValues: string[];
}

export const CATEGORIES: CategoryConfig[] = [
  {
    slug: "sports-tv",
    name: "Sports TV",
    title: "Sports TV",
    badge: "⚽",
    flag: "⚽",
    subtitle: "Live Sports • Football • Cricket & More",
    description: "Stream live sports broadcasts, football leagues, international cricket tournaments, and match highlights in crystal clear HD.",
    image: "/images/cat_sports.jpg",
    filterType: "category",
    filterValues: ["Live Sports", "Sports"],
  },
  {
    slug: "bangladeshi-tv",
    name: "Bangladeshi TV",
    title: "Bangladeshi TV",
    badge: "🇧🇩",
    flag: "🇧🇩",
    subtitle: "News • Entertainment • Islamic & More",
    description: "Watch your favorite Bangladeshi TV channels live. News, drama, entertainment and more.",
    image: "/images/cat_bangladesh.jpg",
    filterType: "country",
    filterValues: ["Bangladesh"],
  },
  {
    slug: "indian-tv",
    name: "Indian TV",
    title: "Indian TV",
    badge: "🇮🇳",
    flag: "🇮🇳",
    subtitle: "News • Movies • Entertainment & More",
    description: "Watch popular Indian TV channels live featuring 24/7 breaking news, Bollywood movies, Hindi dramas and regional entertainment.",
    image: "/images/cat_india.jpg",
    filterType: "country",
    filterValues: ["India"],
  },
  {
    slug: "pakistani-tv",
    name: "Pakistani TV",
    title: "Pakistani TV",
    badge: "🇵🇰",
    flag: "🇵🇰",
    subtitle: "News • Drama • Entertainment & More",
    description: "Stream top Pakistani television channels live with popular dramas, talk shows, news coverage and live sports.",
    image: "/images/cat_pakistan.jpg",
    filterType: "country",
    filterValues: ["Pakistan"],
  },
  {
    slug: "news-tv",
    name: "News TV",
    title: "News TV",
    badge: "📰",
    flag: "📰",
    subtitle: "Breaking News • World Coverage",
    description: "Stay updated with 24/7 live news channels covering breaking stories from Bangladesh, India, Pakistan and around the world.",
    image: "/images/cat_sports.jpg",
    filterType: "category",
    filterValues: ["News"],
  },
  {
    slug: "global-tv",
    name: "Global TV",
    title: "Global TV",
    badge: "🌍",
    flag: "🌍",
    subtitle: "International Channels Worldwide",
    description: "Explore international television channels from around the world in crystal clear HD.",
    image: "/images/hero_banner.jpg",
    filterType: "country",
    filterValues: ["Global"],
  },
];

export function getCategoryBySlug(slug: string): CategoryConfig | undefined {
  if (!slug) return undefined;
  const normalized = slug.toLowerCase().trim();
  return (
    CATEGORIES.find((c) => c.slug === normalized) ||
    CATEGORIES.find((c) => c.slug.replace("-tv", "") === normalized)
  );
}

export function isChannelInCategory(
  channel: { category?: string; country?: string; name?: string },
  categoryConfig: CategoryConfig
): boolean {
  if (!categoryConfig || !channel) return false;

  if (categoryConfig.filterType === "category") {
    const chCat = (channel.category || "").toLowerCase();
    const chName = (channel.name || "").toLowerCase();

    if (categoryConfig.filterValues.some((v) => chCat.includes(v.toLowerCase()))) {
      return true;
    }

    // Heuristic name-based fallback, scoped to the specific category so it
    // doesn't leak matches (e.g. sports channels) into unrelated categories.
    const isSportsCategory = categoryConfig.filterValues.some((v) => /sports/i.test(v));
    if (isSportsCategory) {
      return /sports|cricket|football|ptv sports|ten sports|star sports|sony ten|t sports|sports18|willow|bein|supersport/i.test(
        chName
      );
    }

    const isNewsCategory = categoryConfig.filterValues.some((v) => /news/i.test(v));
    if (isNewsCategory) {
      return /news|somoy|jamuna|aaj tak|geo news|dbc|channel 24|ekattor|independent|abp|india today|ndtv|ary news|samaa|news 21|trt world|cnn|bbc|al jazeera|dw news|bloomberg|cnbc|wion|republic/i.test(
        chName
      );
    }

    return false;
  }

  if (categoryConfig.filterType === "country") {
    const chCountry = (channel.country || "").toLowerCase();
    const isMatchingCountry = categoryConfig.filterValues.some((v) =>
      chCountry.includes(v.toLowerCase())
    );
    if (isMatchingCountry) return true;

    // Fallback heuristic based on station names
    const chName = (channel.name || "").toLowerCase();
    if (categoryConfig.slug === "bangladeshi-tv") {
      return /bangla|ananda|atn|boishakhi|channel s|channel 24|channel i|dbc|deshi|deepto|duronto|ekattor|ekushey|gtv|gazi|independent|jamuna|maasranga|my tv|nagorik|ntv|rtv|somoy|t sports|tsports|bijoy|mohona|asian tv|sa tv/i.test(
        chName
      );
    }
    if (categoryConfig.slug === "indian-tv") {
      return /star sports|sony ten|sports18|zee|aaj tak|colors|star plus|ndtv|republic|india today|sony sab|abp/i.test(
        chName
      );
    }
    if (categoryConfig.slug === "pakistani-tv") {
      return /ptv|ten sports pk|geo|ary|hum tv|samaa|bol|express|a sports|asports/i.test(
        chName
      );
    }
  }

  return false;
}

export type GenreFilter = "all" | "news" | "entertainment" | "sports";

export const GENRE_FILTERS: { id: GenreFilter; label: string; icon: string }[] = [
  { id: "all", label: "All Channels", icon: "🌟" },
  { id: "news", label: "News", icon: "📰" },
  { id: "entertainment", label: "Entertainment", icon: "🎬" },
  { id: "sports", label: "Sports", icon: "⚽" },
];

export function matchesGenreFilter(
  channel: { name?: string; category?: string; subCategory?: string },
  genre: GenreFilter
): boolean {
  if (genre === "all") return true;

  const name = (channel.name || "").toLowerCase();
  const cat = (channel.category || "").toLowerCase();
  const subCat = (channel.subCategory || "").toLowerCase();

  if (genre === "news") {
    return (
      cat.includes("news") ||
      subCat.includes("news") ||
      /news|somoy|jamuna|aaj tak|geo news|dbc|channel 24|ekattor|independent|abp|india today|ndtv|ary news|samaa|news 21|probashi tv news|trt world|cnn|bbc|al jazeera|dw news|bloomberg|cnbc|wion|republic/i.test(
        name
      )
    );
  }

  if (genre === "sports") {
    return (
      cat.includes("sports") ||
      subCat.includes("cricket") ||
      subCat.includes("football") ||
      subCat.includes("sports") ||
      /sports|cricket|football|ptv sports|ten sports|star sports|sony ten|t sports|tsports|sports18|willow|bein|sky sports|premier league|icc|a sports|geo super|fifa|racing|fight|tennis/i.test(
        name
      )
    );
  }

  if (genre === "entertainment") {
    const isNews =
      cat.includes("news") ||
      subCat.includes("news") ||
      /news|somoy|jamuna|aaj tak|geo news|dbc|channel 24|ekattor|independent|abp|india today|ndtv|ary news|samaa|news 21|probashi tv news|trt world|cnn|bbc|al jazeera|dw news|bloomberg|cnbc|wion|republic/i.test(
        name
      );
    const isSports =
      cat.includes("sports") ||
      subCat.includes("cricket") ||
      subCat.includes("football") ||
      subCat.includes("sports") ||
      /sports|cricket|football|ptv sports|ten sports|star sports|sony ten|t sports|tsports|sports18|willow|bein|sky sports|premier league|icc|a sports|geo super|fifa|racing|fight|tennis/i.test(
        name
      );

    if (isNews || isSports) return false;
    return true;
  }

  return true;
}

