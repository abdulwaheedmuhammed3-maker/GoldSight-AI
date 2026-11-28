export const COMMODITY_SYMBOLS = [
  "XAUUSD",
  "XAGUSD",
  "XPTUSD",
  "XPDUSD",
  "XALUSD",
  "XCUUSD",
  "XNIUSD",
  "XPBUSD",
  "XZNUSD",
  "WTIUSD",
  "UKOUSD",
  "NATGAS",
] as const;

export type CommoditySymbol = (typeof COMMODITY_SYMBOLS)[number];

export interface CommodityInstrumentDetails {
  readonly label: string;
  /** Exness MT5 CFD symbol; SiftingIO reference symbol can differ. */
  readonly exnessSymbol: string;
  readonly category: "PRECIOUS METALS" | "INDUSTRIAL METALS" | "ENERGY";
  readonly accent: "gold" | "silver" | "violet" | "coral" | "blue" | "mint";
  readonly unit: string;
}

export const COMMODITY_DETAILS: Record<CommoditySymbol, CommodityInstrumentDetails> = {
  XAUUSD: {
    label: "Gold",
    exnessSymbol: "XAUUSD",
    category: "PRECIOUS METALS",
    accent: "gold",
    unit: "USD per troy ounce",
  },
  XAGUSD: {
    label: "Silver",
    exnessSymbol: "XAGUSD",
    category: "PRECIOUS METALS",
    accent: "silver",
    unit: "USD per troy ounce",
  },
  XPTUSD: {
    label: "Platinum",
    exnessSymbol: "XPTUSD",
    category: "PRECIOUS METALS",
    accent: "violet",
    unit: "USD per troy ounce",
  },
  XPDUSD: {
    label: "Palladium",
    exnessSymbol: "XPDUSD",
    category: "PRECIOUS METALS",
    accent: "coral",
    unit: "USD per troy ounce",
  },
  XALUSD: {
    label: "Aluminium",
    exnessSymbol: "XALUSD",
    category: "INDUSTRIAL METALS",
    accent: "silver",
    unit: "USD per metric tonne",
  },
  XCUUSD: {
    label: "Copper",
    exnessSymbol: "XCUUSD",
    category: "INDUSTRIAL METALS",
    accent: "coral",
    unit: "USD per metric tonne",
  },
  XNIUSD: {
    label: "Nickel",
    exnessSymbol: "XNIUSD",
    category: "INDUSTRIAL METALS",
    accent: "blue",
    unit: "USD per metric tonne",
  },
  XPBUSD: {
    label: "Lead",
    exnessSymbol: "XPBUSD",
    category: "INDUSTRIAL METALS",
    accent: "violet",
    unit: "USD per metric tonne",
  },
  XZNUSD: {
    label: "Zinc",
    exnessSymbol: "XZNUSD",
    category: "INDUSTRIAL METALS",
    accent: "mint",
    unit: "USD per metric tonne",
  },
  WTIUSD: {
    label: "WTI Crude Oil",
    exnessSymbol: "USOIL",
    category: "ENERGY",
    accent: "blue",
    unit: "USD per barrel",
  },
  UKOUSD: {
    label: "Brent Crude Oil",
    exnessSymbol: "UKOIL",
    category: "ENERGY",
    accent: "mint",
    unit: "USD per barrel",
  },
  NATGAS: {
    label: "Natural Gas",
    exnessSymbol: "XNGUSD",
    category: "ENERGY",
    accent: "gold",
    unit: "USD reference price",
  },
};

export const SIFTING_IO_FOREX_SYMBOLS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "USDCAD",
  "USDCHF",
  "NZDUSD",
  "EURGBP",
] as const;

/** Every instrument currently supported by TradeSight's SiftingIO adapter. */
export const SIFTING_IO_INSTRUMENTS = [
  ...COMMODITY_SYMBOLS,
  ...SIFTING_IO_FOREX_SYMBOLS,
] as const;

export type SiftingIoInstrument = (typeof SIFTING_IO_INSTRUMENTS)[number];
