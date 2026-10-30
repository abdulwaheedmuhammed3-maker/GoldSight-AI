# Global Stock Intelligence

TradeSight now exposes a signals-only multi-market research endpoint:

`GET /api/v1/stocks/intelligence?country=NG`

Supported country codes: NG (Nigeria/NGX), US, GB, CA, ZA, IN, DE and AU. The starter universe is intentionally limited to selected liquid, widely followed companies; it is not a full exchange directory.

## Data and limitations

Daily chart history is retrieved from Yahoo Finance chart endpoints. This source can be delayed, incomplete, unavailable for a ticker, or subject to provider terms. It is not an exchange execution quote. The API returns the source, latest bar timestamp, age and per-ticker errors.

The first version calculates SMA20, SMA50, RSI14, 20-session price change, volume context and a technical score. A qualifying row is labelled TECHNICAL WATCH, never BUY. The system deliberately withholds entry, stop-loss, take-profit and long-term holding recommendations until verified financial statements, valuation, corporate actions, exchange liquidity, local fees and taxes are integrated.

The selected research capital is NGN 100,000–500,000. It is not converted into other currencies automatically. No stock orders are placed.

## Market news

Country-labelled RSS feeds include Nigeria (CBN, Nairametrics, BusinessDay), United States (Federal Reserve, BLS), United Kingdom (Bank of England), Europe (ECB) and global digital-asset coverage (CoinDesk). Feed outages are shown as unavailable. Impact and income relevance labels are keyword-based triage, not directional predictions. Income relevance includes dividend, earnings, yield, profit, cash-flow and interest-rate topics.
