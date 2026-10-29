/**
 * Team recognition for the match board.
 *
 * A card names two teams, and the flag a viewer recognises them by should not be
 * something an admin has to find, crop and upload. This module is the pure half of
 * that: it turns a name or a common abbreviation into a country code, and it turns a
 * title like "BAN vs IND" into the two teams the title stands for. Nothing here
 * touches the network, the database or React, so `npm run test:team-flags` executes the
 * same rules the board renders.
 *
 * A name that is not recognised is not an error: the card falls back to the team's
 * initials, which is what it did before this module existed. Guessing a country for a
 * club or a domestic side would put the wrong flag on a real match, so the rule is
 * strict — a name names a national team, or it names nothing.
 */

/** Where a country flag is drawn from. The board falls back to initials if it cannot load. */
const FLAG_BASE = "https://flagcdn.com/w80";

/**
 * Every name and abbreviation this panel can place a flag on.
 *
 * The key is the normalised name (lower case, no punctuation) and the value is the
 * country code the flag is drawn from. Codes are the ones the flag service uses, which
 * are ISO 3166-1 alpha-2 for countries and the four Home Nations' own codes for the
 * United Kingdom's parts — a card that says "England" must not be given the Union flag.
 *
 * The cricket abbreviations come first because a card is usually a cricket card, and
 * `SA` means South Africa in that context while `KSA` names Saudi Arabia. Two letters
 * that could plausibly mean two different countries are simply left out.
 */
const TEAM_ALIASES: Record<string, string> = {
  // --- cricket nations ---
  bangladesh: "bd",
  india: "in",
  pakistan: "pk",
  england: "gb-eng",
  australia: "au",
  "new zealand": "nz",
  "south africa": "za",
  "sri lanka": "lk",
  "west indies": "wi",
  zimbabwe: "zw",
  afghanistan: "af",
  ireland: "ie",
  netherlands: "nl",
  scotland: "gb-sct",
  wales: "gb-wls",
  nepal: "np",
  oman: "om",
  qatar: "qa",
  bahrain: "bh",
  kuwait: "kw",
  "saudi arabia": "sa",
  "united arab emirates": "ae",
  namibia: "na",
  kenya: "ke",
  nigeria: "ng",
  tanzania: "tz",
  uganda: "ug",
  rwanda: "rw",
  singapore: "sg",
  malaysia: "my",
  "hong kong": "hk",
  "united states": "us",
  "united states of america": "us",
  "republic of ireland": "ie",

  // --- football nations ---
  algeria: "dz",
  angola: "ao",
  argentina: "ar",
  austria: "at",
  belgium: "be",
  bolivia: "bo",
  brazil: "br",
  bulgaria: "bg",
  cambodia: "kh",
  cameroon: "cm",
  canada: "ca",
  chile: "cl",
  china: "cn",
  colombia: "co",
  "costa rica": "cr",
  "cote divoire": "ci",
  "ivory coast": "ci",
  croatia: "hr",
  czechia: "cz",
  "czech republic": "cz",
  denmark: "dk",
  ecuador: "ec",
  egypt: "eg",
  "el salvador": "sv",
  estonia: "ee",
  finland: "fi",
  france: "fr",
  germany: "de",
  greece: "gr",
  guatemala: "gt",
  honduras: "hn",
  hungary: "hu",
  iceland: "is",
  indonesia: "id",
  iran: "ir",
  iraq: "iq",
  israel: "il",
  italy: "it",
  jamaica: "jm",
  japan: "jp",
  "korea republic": "kr",
  "south korea": "kr",
  laos: "la",
  latvia: "lv",
  lithuania: "lt",
  luxembourg: "lu",
  mali: "ml",
  mexico: "mx",
  mongolia: "mn",
  morocco: "ma",
  myanmar: "mm",
  "north macedonia": "mk",
  "northern ireland": "gb-nir",
  norway: "no",
  panama: "pa",
  paraguay: "py",
  peru: "pe",
  poland: "pl",
  portugal: "pt",
  romania: "ro",
  russia: "ru",
  "salvador": "sv",
  "saudi": "sa",
  senegal: "sn",
  serbia: "rs",
  slovakia: "sk",
  slovenia: "si",
  spain: "es",
  sweden: "se",
  switzerland: "ch",
  taiwan: "tw",
  thailand: "th",
  tunisia: "tn",
  turkey: "tr",
  turkmenistan: "tm",
  ukraine: "ua",
  uruguay: "uy",
  venezuela: "ve",
  vietnam: "vn",
  zambia: "zm",

  // --- cricket and football abbreviations ---
  ban: "bd",
  bgd: "bd",
  ind: "in",
  pak: "pk",
  eng: "gb-eng",
  aus: "au",
  nz: "nz",
  nzl: "nz",
  sa: "za",
  rsa: "za",
  sl: "lk",
  sri: "lk",
  wi: "wi",
  win: "wi",
  zim: "zw",
  afg: "af",
  ire: "ie",
  ned: "nl",
  sco: "gb-sct",
  wal: "gb-wls",
  npl: "np",
  oma: "om",
  qat: "qa",
  brn: "bh",
  kuw: "kw",
  ksa: "sa",
  are: "ae",
  uae: "ae",
  nam: "na",
  sin: "sg",
  mas: "my",
  hkg: "hk",
  can: "ca",
  usa: "us",
  gbr: "gb-eng",

  // --- football abbreviations ---
  alg: "dz",
  ang: "ao",
  arg: "ar",
  aut: "at",
  bel: "be",
  bol: "bo",
  bra: "br",
  bul: "bg",
  cam: "kh",
  cmr: "cm",
  chi: "cl",
  chn: "cn",
  col: "co",
  crc: "cr",
  civ: "ci",
  cro: "hr",
  cze: "cz",
  den: "dk",
  ecu: "ec",
  egy: "eg",
  fin: "fi",
  fra: "fr",
  ger: "de",
  gre: "gr",
  hon: "hn",
  hun: "hu",
  ice: "is",
  idn: "id",
  irn: "ir",
  irq: "iq",
  isr: "il",
  ita: "it",
  jam: "jm",
  jpn: "jp",
  kor: "kr",
  lao: "la",
  mar: "ma",
  mex: "mx",
  myn: "mm",
  nor: "no",
  pan: "pa",
  par: "py",
  per: "pe",
  pol: "pl",
  por: "pt",
  rom: "ro",
  rus: "ru",
  sen: "sn",
  srb: "rs",
  slo: "sk",
  esp: "es",
  swe: "se",
  sui: "ch",
  swi: "ch",
  thai: "th",
  tun: "tn",
  tur: "tr",
  ukr: "ua",
  ury: "uy",
  ven: "ve",
  vie: "vn",
  zam: "zm",
};

/**
 * Words that qualify a team rather than name it. "Bangladesh Women" and "Bangladesh"
 * are the same country and get the same flag, so the qualifier is dropped before the
 * name is looked up.
 */
const QUALIFIERS = new Set([
  "women",
  "woman",
  "womens",
  "w",
  "men",
  "man",
  "mens",
  "m",
  "squad",
  "u19",
  "u20",
  "u21",
  "u22",
  "u23",
  "u16",
  "u17",
  "u18",
  "test",
  "odi",
  "t20",
  "t20i",
  "first",
  "second",
  "third",
  "xi",
  "a",
  "b",
]);

/**
 * A name as this module looks it up: lower case, without accents, without punctuation,
 * and with its spaces kept — "South Africa" and "South-Africa" are one name, and
 * "SouthAfrica" is not.
 */
export function normalizeTeamName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'’`_]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The country a team name stands for, or null when the name is not one this module knows.
 *
 * The lookup is tried in three steps, from the most specific to the least: the whole
 * name, the name without its qualifiers, and then the first word of what is left — which
 * is how "England Lions" still finds England and "New Zealand" is found whole rather
 * than by its first word.
 */
export function resolveTeamCountry(raw: string): string | null {
  const name = normalizeTeamName(raw);
  if (!name) return null;

  const direct = TEAM_ALIASES[name];
  if (direct) return direct;

  const words = name.split(" ").filter((word) => !QUALIFIERS.has(word));
  if (words.length === 0) return null;
  const withoutQualifier = words.join(" ");
  const qualified = TEAM_ALIASES[withoutQualifier];
  if (qualified) return qualified;

  // A single leading word is only tried when the whole thing did not match, so a name
  // that is itself an alias is never shortened into a different country.
  if (words.length > 1) {
    const first = TEAM_ALIASES[words[0]];
    if (first) return first;
  }
  return null;
}

/**
 * The flag to draw for a team, or null when the team is not recognised.
 *
 * The URL is only a suggestion: the board asks the image whether it loaded and falls
 * back to the team's initials when it did not, so a flag service that is slow or down
 * costs the card a picture and nothing else.
 */
export function teamFlagUrl(raw: string): string | null {
  const code = resolveTeamCountry(raw);
  return code ? `${FLAG_BASE}/${code}.png` : null;
}

/**
 * The two teams a title stands for, or null when the title does not name two.
 *
 * A card's title is what an admin types first — "Bangladesh vs India", "Brazil vs
 * Argentina", "BAN vs IND" — so the split is deliberately forgiving about the separator
 * and strict about the result: both halves have to be there, or the title is left alone.
 */
export function parseMatchTitle(raw: string): { teamA: string; teamB: string } | null {
  const title = raw.trim();
  if (!title) return null;

  const separated = title.split(/\s+(?:vs\.?|v\.?|x)\s+|\s*[-–—]\s*/i);
  if (separated.length !== 2) return null;

  const teamA = separated[0].trim();
  const teamB = separated[1].trim();
  if (!teamA || !teamB) return null;
  return { teamA, teamB };
}
