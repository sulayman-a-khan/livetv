/**
 * The catalogue's five and only five channel categories.
 *
 * Every channel carries exactly ONE of these as `Channel.category` — there are
 * no subcategories and no multi-category channels. Rails, the category pages,
 * the Admin Dashboard, the Manual Channel Entry form and the health-check
 * batches all read from this file, so a category added here is a rail, a filter
 * option and a health group at the same time.
 */
export const CHANNEL_CATEGORIES = [
  "Sports",
  "Bangla",
  "Indian",
  "Pakistani",
  "Documentary",
] as const;

export type ChannelCategory = (typeof CHANNEL_CATEGORIES)[number];

/**
 * Where a channel with no sport/documentary/country/name signal lands. This is a
 * staging value only: the Admin Dashboard shows every unpinned channel with its
 * category, and an admin confirms or changes it before pinning.
 */
export const DEFAULT_CATEGORY: ChannelCategory = "Bangla";

export interface CategoryConfig {
  slug: string;
  name: string;
  title: string;
  badge: string;
  flag: string;
  subtitle: string;
  description: string;
  image: string;
  /** The exact `Channel.category` value this rail lists. */
  category: ChannelCategory;
}

export const CATEGORIES: CategoryConfig[] = [
  {
    slug: "sports",
    name: "Sports",
    title: "Sports TV",
    badge: "⚽",
    flag: "⚽",
    subtitle: "Live Sports • Football • Cricket & More",
    description:
      "Stream live sports broadcasts, football leagues, international cricket tournaments, and match highlights in crystal clear HD.",
    image: "/images/cat_sports.jpg",
    category: "Sports",
  },
  {
    slug: "bangla",
    name: "Bangla",
    title: "Bangla TV",
    badge: "🇧🇩",
    flag: "🇧🇩",
    subtitle: "News • Entertainment • Islamic & More",
    description:
      "Watch your favorite Bangladeshi TV channels live. News, drama, entertainment and more.",
    image: "/images/cat_bangladesh.jpg",
    category: "Bangla",
  },
  {
    slug: "indian",
    name: "Indian",
    title: "Indian TV",
    badge: "🇮🇳",
    flag: "🇮🇳",
    subtitle: "News • Movies • Entertainment & More",
    description:
      "Watch popular Indian TV channels live featuring 24/7 breaking news, Bollywood movies, Hindi dramas and regional entertainment.",
    image: "/images/cat_india.jpg",
    category: "Indian",
  },
  {
    slug: "pakistani",
    name: "Pakistani",
    title: "Pakistani TV",
    badge: "🇵🇰",
    flag: "🇵🇰",
    subtitle: "News • Drama • Entertainment & More",
    description:
      "Stream top Pakistani television channels live with popular dramas, talk shows, news coverage and live sports.",
    image: "/images/cat_pakistan.jpg",
    category: "Pakistani",
  },
  {
    slug: "documentary",
    name: "Documentary",
    title: "Documentary TV",
    badge: "🌍",
    flag: "🌍",
    subtitle: "Nature • Science • History & More",
    description:
      "Explore documentary channels covering wildlife, science, history, travel and the natural world in crystal clear HD.",
    image: "/images/hero_banner.jpg",
    category: "Documentary",
  },
];

/**
 * Rails are matched on the exact category value now, so a channel belongs to
 * exactly one rail. These aliases keep the old `/category/<slug>` links
 * (sports-tv, bangladeshi-tv, …) resolving to the rail that replaced them.
 */
const CATEGORY_SLUG_ALIASES: Record<string, string> = {
  "sports-tv": "sports",
  "bangladeshi-tv": "bangla",
  "bangladesh-tv": "bangla",
  "bangla-tv": "bangla",
  "indian-tv": "indian",
  "india-tv": "indian",
  "pakistani-tv": "pakistani",
  "pakistan-tv": "pakistani",
  "documentary-tv": "documentary",
  docs: "documentary",
};

export function getCategoryBySlug(slug: string): CategoryConfig | undefined {
  if (!slug) return undefined;
  const normalized = slug.toLowerCase().trim();
  const resolved = CATEGORY_SLUG_ALIASES[normalized] || normalized;
  return CATEGORIES.find((c) => c.slug === resolved);
}

/**
 * A channel is on exactly one rail: the one whose category equals its stored
 * category. The old heuristic matching (name and country regexes across six
 * overlapping rails) is gone, which is what makes the pinned board, the home
 * rails, the category page and the health batches agree on one number.
 */
export function isChannelInCategory(
  channel: { category?: string } | null | undefined,
  categoryConfig: CategoryConfig | null | undefined
): boolean {
  if (!categoryConfig || !channel) return false;
  return channel.category === categoryConfig.category;
}
export function isChannelCategory(value: unknown): value is ChannelCategory {
  return typeof value === "string" && (CHANNEL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Canonicalises any category-ish string to one of the five.
 *
 * Recognises the five values themselves (case-insensitive), then falls back to
 * classifying the free text (`legacy` is usually an old category like "Live
 * Sports" or an M3U group title) together with the channel name and country.
 * Never returns an unknown value, so no code path has to handle a sixth one.
 */
export function normalizeCategory(
  legacy: string | undefined | null,
  name = "",
  country = ""
): ChannelCategory {
  const direct = (legacy || "").trim().toLowerCase();
  const hit = CHANNEL_CATEGORIES.find((c) => c.toLowerCase() === direct);
  if (hit) return hit;
  return classifyCategory(name, legacy || "", country);
}

const SPORTS_RE =
  /sports|cricket|football|soccer|fifa|premier league|champions league|la liga|serie a|bundesliga|ipl|bpl|psl|t20|icc|world cup|willow|bein|supersport|sky sports|star sports|sony ten|ten sports|ten 1|ten 2|ten 3|sports18|dd sports|ptv sports|a sports|asports|geo super|tsports|t sports|tennis|badminton|kabaddi|hockey|boxing|ufc|wwe|racing|golf|basketball|nba|espn|fox sports|nbc sports|skynet sports|vsport/;

const DOCUMENTARY_RE =
  /documentar|discovery|national geographic|nat geo|natgeo|exploration|explores|investigation|animal planet|animal world|bbc earth|history channel|history tv|history hd|h2 hd|outdoor|lmau|travel channel|world travel|science channel|knowledge channel|facts|dhoom?|niledu?|ngc|tong? life|journey|wildlife/;

const BANGLA_RE =
  /bangla|bangladesh|\bbd\b|ananda|\batn\b|boishakhi|channel s|channel 24|channel i|\bdbc\b|deshi|deepto|duronto|ekattor|ekushey|\bgtv\b|gazi|independent|jamuna|maasranga|my tv|nagorik|\bntv\b|\brtv\b|somoy|bijoy|mohona|asian tv|sa tv|vokta|nexus|rajdhani|movie bangla|rupashi|banglavision|\bbtv\b/i;

const INDIAN_RE =
  /\bindia\b|indian|star sports|star plus|star Bharat|\bsony\b|\bzee\b|colors|aaj tak|aajtak|ndtv|republic|india today|\babp\b|\bdd\b|sony sab|sony max|zee cinema|b4u|\butv\b|sahara|bindass|dabboo/i;

const PAKISTANI_RE =
  /pakistan|\bpk\b|\bptv\b|\bgeo\b|\bary\b|hum tv|hum news|samaa|\bbol\b|express|khyber|paywish|pashto|sindh/i;

/**
 * Picks the single category for a channel from its name, its M3U group title (or
 * legacy category text) and its country. Sports and Documentary are decided by
 * content keywords first — a Bangladeshi sports channel is a Sports channel —
 * then region follows the country, then the station-name heuristics.
 */
export function classifyCategory(name = "", groupTitle = "", country = ""): ChannelCategory {
  const combined = `${name} ${groupTitle}`.toLowerCase();

  if (SPORTS_RE.test(combined)) return "Sports";
  if (DOCUMENTARY_RE.test(combined)) return "Documentary";

  const c = (country || "").trim().toLowerCase();
  if (/bangladesh|bangla/.test(c)) return "Bangla";
  if (/india/.test(c)) return "Indian";
  if (/pakistan/.test(c)) return "Pakistani";

  if (BANGLA_RE.test(combined)) return "Bangla";
  if (PAKISTANI_RE.test(combined)) return "Pakistani";
  if (INDIAN_RE.test(combined)) return "Indian";

  return DEFAULT_CATEGORY;
}
