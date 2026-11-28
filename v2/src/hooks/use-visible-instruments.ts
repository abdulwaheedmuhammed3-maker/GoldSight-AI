import { useEffect, useState } from "react";
import {
  FEED_SELECTION_CHANGED_EVENT,
  readVisibleInstrumentSymbols,
  type VisibleInstrumentSymbol,
} from "../domain/market-data/feed-preferences";

/** Keep every instrument selector and list in sync with Settings. */
export function useVisibleInstrumentSymbols(): VisibleInstrumentSymbol[] {
  const [symbols, setSymbols] = useState<VisibleInstrumentSymbol[]>(readVisibleInstrumentSymbols);

  useEffect(() => {
    const refresh = () => setSymbols(readVisibleInstrumentSymbols());
    window.addEventListener(FEED_SELECTION_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(FEED_SELECTION_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return symbols;
}
