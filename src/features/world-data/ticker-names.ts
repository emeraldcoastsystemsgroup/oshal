/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — ticker -> company-name map for the default trading universe, so world feeds search the NAME (what the press writes) not a thin "<SYM> stock".
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Add SKHY -> "SK Hynix" (Nasdaq ADR IPO 2026-07-10, in DEFAULT_UNIVERSE + held live as core) so the world news pulse searches the press name and firehose entities attribute to the ticker.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Press names for the 34 up-and-comer names (universe 106 → 140) so the every-5-min world pulse and firehose entity attribution cover the expanded rotation pool from day one.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Press names for the 19 regime-reweight names (universe 140 → 159): materials/mining, data-storage/memory, Buffett-13F gaps, politician-disclosure gaps — world-pulse coverage from day one of the expanded pool.
 */

/**
 * Ticker -> company name for the default trading universe.
 *
 * The world layer pulled finance news with the query "<SYM> stock" (e.g. "AAPL stock") — a weak,
 * low-recall search the press never actually uses. News writes "Apple", "JPMorgan", "Eli Lilly". Mapping
 * each monitored symbol to the common name the media uses is the single biggest lever on coverage quality
 * for the 100 names the autopilot trades, so the finance query plan (feed-sources.ts) searches the name.
 *
 * Names are the COMMON press form (not the legal entity): "Alphabet" not "Alphabet Inc. Class A". Keep in
 * sync with DEFAULT_UNIVERSE (src/features/trading/services/multi-timeframe.ts); an unmapped symbol falls
 * back to the bare ticker (still works, just thinner).
 */

/** Symbol (upper-case) -> common company name the financial press uses. */
export const TICKER_COMPANY_NAMES: Readonly<Record<string, string>> = {
  // Technology
  AAPL: 'Apple', MSFT: 'Microsoft', NVDA: 'Nvidia', GOOGL: 'Alphabet', AMZN: 'Amazon',
  META: 'Meta Platforms', AVGO: 'Broadcom', ORCL: 'Oracle', CRM: 'Salesforce', ADBE: 'Adobe',
  AMD: 'AMD', INTC: 'Intel', CSCO: 'Cisco', QCOM: 'Qualcomm', TXN: 'Texas Instruments',
  IBM: 'IBM', NOW: 'ServiceNow', INTU: 'Intuit', AMAT: 'Applied Materials', MU: 'Micron',
  PANW: 'Palo Alto Networks', SNOW: 'Snowflake', SHOP: 'Shopify', UBER: 'Uber', PLTR: 'Palantir',
  SKHY: 'SK Hynix',
  // Up-and-comers (2026-07-10 universe expansion to 140) — press names so the world pulse
  // searches what the media writes and firehose entities attribute to the ticker.
  ARM: 'Arm Holdings', MRVL: 'Marvell', TSM: 'TSMC', ASML: 'ASML', LRCX: 'Lam Research',
  KLAC: 'KLA', MPWR: 'Monolithic Power', ANET: 'Arista Networks', SMCI: 'Super Micro',
  VRT: 'Vertiv', CRWD: 'CrowdStrike', DDOG: 'Datadog', NET: 'Cloudflare', MDB: 'MongoDB',
  ZS: 'Zscaler', APP: 'AppLovin', COIN: 'Coinbase', HOOD: 'Robinhood', SOFI: 'SoFi',
  NU: 'Nubank', AFRM: 'Affirm', DASH: 'DoorDash', ABNB: 'Airbnb', RBLX: 'Roblox',
  CVNA: 'Carvana', DUOL: 'Duolingo', AXON: 'Axon', RKLB: 'Rocket Lab', PWR: 'Quanta Services',
  ETN: 'Eaton', VST: 'Vistra', CEG: 'Constellation Energy', GEV: 'GE Vernova', NRG: 'NRG Energy',
  // Financials
  JPM: 'JPMorgan Chase', BAC: 'Bank of America', WFC: 'Wells Fargo', GS: 'Goldman Sachs', MS: 'Morgan Stanley',
  C: 'Citigroup', SCHW: 'Charles Schwab', BLK: 'BlackRock', AXP: 'American Express', SPGI: 'S&P Global',
  BX: 'Blackstone', V: 'Visa', MA: 'Mastercard', PYPL: 'PayPal', COF: 'Capital One',
  USB: 'U.S. Bancorp', PNC: 'PNC Financial', TFC: 'Truist', CB: 'Chubb', MMC: 'Marsh McLennan',
  // Blue-chip / consumer
  WMT: 'Walmart', COST: 'Costco', PG: 'Procter & Gamble', KO: 'Coca-Cola', PEP: 'PepsiCo',
  MCD: "McDonald's", DIS: 'Disney', NKE: 'Nike', HD: 'Home Depot', LOW: "Lowe's",
  SBUX: 'Starbucks', TGT: 'Target', CAT: 'Caterpillar', GE: 'GE Aerospace', HON: 'Honeywell',
  UPS: 'UPS', BA: 'Boeing', MMM: '3M', CL: 'Colgate-Palmolive', PM: 'Philip Morris',
  // Energy
  XOM: 'ExxonMobil', CVX: 'Chevron', COP: 'ConocoPhillips', SLB: 'SLB', EOG: 'EOG Resources',
  PSX: 'Phillips 66', MPC: 'Marathon Petroleum', VLO: 'Valero', OXY: 'Occidental Petroleum', WMB: 'Williams Companies',
  KMI: 'Kinder Morgan', HAL: 'Halliburton', DVN: 'Devon Energy', HES: 'Hess', BKR: 'Baker Hughes',
  // Pharma / health
  JNJ: 'Johnson & Johnson', LLY: 'Eli Lilly', PFE: 'Pfizer', MRK: 'Merck', ABBV: 'AbbVie',
  TMO: 'Thermo Fisher', ABT: 'Abbott', DHR: 'Danaher', BMY: 'Bristol Myers Squibb', AMGN: 'Amgen',
  GILD: 'Gilead', CVS: 'CVS Health', UNH: 'UnitedHealth', MDT: 'Medtronic', ISRG: 'Intuitive Surgical',
  VRTX: 'Vertex Pharmaceuticals', REGN: 'Regeneron', ZTS: 'Zoetis', BIIB: 'Biogen', MRNA: 'Moderna',
  // Regime-change reweight (2026-07-26, universe 140 → 159)
  // Materials / mining
  FCX: 'Freeport-McMoRan', NEM: 'Newmont', LIN: 'Linde', APD: 'Air Products', SCCO: 'Southern Copper',
  NUE: 'Nucor', STLD: 'Steel Dynamics', ALB: 'Albemarle', MP: 'MP Materials',
  // Data storage / memory
  STX: 'Seagate', WDC: 'Western Digital', SNDK: 'SanDisk', PSTG: 'Pure Storage', NTAP: 'NetApp',
  // Buffett-13F gaps
  MCO: "Moody's", VRSN: 'Verisign', KHC: 'Kraft Heinz',
  // Politician-disclosure gaps (Pelosi 2025-26 filings)
  TEM: 'Tempus AI', AB: 'AllianceBernstein',
};

/** @description Common press name for a symbol, or the bare upper-cased ticker when unmapped. */
export function tickerName(symbol: string): string {
  const sym = String(symbol || '').trim().toUpperCase();
  return TICKER_COMPANY_NAMES[sym] || sym;
}

/** Normalize a company name for matching: lowercase, strip common corporate suffixes + punctuation. */
function normName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(inc|incorporated|corp|corporation|company|co|plc|ltd|limited|holdings|group|the|platforms|technologies|systems)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reverse index: normalized company name → ticker symbol (for firehose entity→ticker resolution). */
const NAME_TO_SYMBOL: ReadonlyMap<string, string> = new Map(
  Object.entries(TICKER_COMPANY_NAMES).map(([sym, name]) => [normName(name), sym]),
);

/**
 * @description Resolve a free-text company name (e.g. an extracted entity like "Apple Inc.") to a universe
 * ticker symbol, or null if it isn't one of the monitored names. Exact normalized match only — keeps
 * firehose attribution precise (no fuzzy false-positives bolting unrelated stories onto a name).
 */
export function symbolForName(name: string): string | null {
  const n = normName(name);
  if (!n) return null;
  return NAME_TO_SYMBOL.get(n) ?? null;
}
