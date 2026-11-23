// Telephony destinations (PLAN §8, rules 5 and "international SMS/voice are opt-in per country").
// Pure: maps an E.164 number to the ISO country that Twilio prices it under, and says which
// destinations SubEtha serves at all. No Cloudflare globals, so the site can bundle it.

/**
 * Countries outside the US that an account may opt into. Each is priced daily from Twilio's
 * live prices; one without a current price is not served.
 */
export const INTL_COUNTRIES: Record<string, { name: string; code: string }> = {
  CA: { name: "Canada", code: "1" },
  GB: { name: "United Kingdom", code: "44" },
  IE: { name: "Ireland", code: "353" },
  DE: { name: "Germany", code: "49" },
  FR: { name: "France", code: "33" },
  NL: { name: "Netherlands", code: "31" },
  BE: { name: "Belgium", code: "32" },
  ES: { name: "Spain", code: "34" },
  IT: { name: "Italy", code: "39" },
  PT: { name: "Portugal", code: "351" },
  AT: { name: "Austria", code: "43" },
  CH: { name: "Switzerland", code: "41" },
  SE: { name: "Sweden", code: "46" },
  NO: { name: "Norway", code: "47" },
  DK: { name: "Denmark", code: "45" },
  FI: { name: "Finland", code: "358" },
  PL: { name: "Poland", code: "48" },
  AU: { name: "Australia", code: "61" },
  NZ: { name: "New Zealand", code: "64" },
  JP: { name: "Japan", code: "81" },
  SG: { name: "Singapore", code: "65" },
  MX: { name: "Mexico", code: "52" },
  BR: { name: "Brazil", code: "55" },
  IN: { name: "India", code: "91" },
  IL: { name: "Israel", code: "972" },
  ZA: { name: "South Africa", code: "27" },
  PR: { name: "Puerto Rico", code: "1" },
};

// North American Numbering Plan area codes that are not the 50 states. Twilio prices these
// separately from US numbers, and many of them cost far more (a classic SMS-pumping target),
// so they must never be billed as US destinations.
const CA_AREA = "204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 403 416 418 428 431 437 438 450 468 474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905 942";
const OTHER_NANP: Record<string, string> = {
  "242": "BS", "246": "BB", "264": "AI", "268": "AG", "284": "VG", "340": "VI", "345": "KY", "441": "BM",
  "473": "GD", "649": "TC", "658": "JM", "664": "MS", "670": "MP", "671": "GU", "684": "AS", "721": "SX",
  "758": "LC", "767": "DM", "784": "VC", "787": "PR", "809": "DO", "829": "DO", "849": "DO", "868": "TT",
  "869": "KN", "876": "JM", "939": "PR",
};
for (const a of CA_AREA.split(" ")) OTHER_NANP[a] = "CA";
// Premium-rate, personal-communications, government and other non-geographic NANP codes: never served.
const BLOCKED_NANP = new Set(["456", "500", "521", "522", "523", "524", "525", "526", "527", "528", "529", "530", "531", "532", "533", "544", "566", "577", "588", "600", "622", "700", "710", "900"]);

const NANP = /^\+1([2-9]\d{2})[2-9]\d{6}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const BY_CODE = Object.entries(INTL_COUNTRIES).filter(([, c]) => c.code !== "1").sort((a, b) => b[1].code.length - a[1].code.length);

/**
 * The ISO country of a phone number, or null if the number isn't valid E.164 or is a destination
 * SubEtha never serves (premium and non-geographic codes, countries outside the list).
 */
export function phoneCountry(e164: string): string | null {
  if (e164.startsWith("+1")) {
    const m = NANP.exec(e164);
    if (!m) return null;
    const area = m[1]!;
    if (BLOCKED_NANP.has(area) || area.endsWith("11")) return null; // N11 aren't area codes
    const c = OTHER_NANP[area];
    return c === undefined ? "US" : c in INTL_COUNTRIES ? c : null;
  }
  if (!E164.test(e164)) return null;
  for (const [iso, c] of BY_CODE) if (e164.startsWith(`+${c.code}`)) return iso;
  return null;
}

/** Normalizes an opt-in list: upper-case, de-duplicated, every entry an INTL_COUNTRIES key. */
export function parseCountries(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map((x) => String(x).toUpperCase()))];
  return out.every((c) => c in INTL_COUNTRIES) ? out.sort() : null;
}

/** Per-country, per-tier unit prices (µ$), written by the daily cron to KV. */
export interface DestinationPrices {
  updated_at: number;
  countries: Record<string, { sms?: Record<string, number>; voice?: Record<string, number>; provider_usd: { sms?: number; voice?: number } }>;
}
export const DEST_PRICES_KEY = "twilio:dest_prices";

/** Unit price (one SMS segment or call minute) for a non-US destination, or null if unpriced. */
export function destUnitPrice(prices: DestinationPrices | null, transport: "sms" | "voice", country: string, tier: string): number | null {
  const p = prices?.countries[country]?.[transport];
  return p ? p[tier] ?? p.standard ?? null : null;
}
