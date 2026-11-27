import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type Time,
} from "lightweight-charts";
import { useCanonicalQuote, useCandles } from "../hooks/use-market-data";
import type { SupportedTimeframe } from "../domain/market-data/market-data-engine";
import { isSnapshotQuote } from "../domain/market-data/types";

interface PriceChartProps {
  instrumentId: string;
  timeframe: SupportedTimeframe;
  providerId: string;
}

interface CandlePoint {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface PriceLineHandle {}

interface CandleSeriesHandle {
  setData(data: CandlePoint[]): void;
  createPriceLine(options: {
    price: number;
    color: string;
    lineWidth: 1;
    lineStyle: 2;
    axisLabelVisible: boolean;
    title: string;
  }): PriceLineHandle;
  removePriceLine(line: PriceLineHandle): void;
}

export default function PriceChart({ instrumentId, timeframe, providerId }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const quote = useCanonicalQuote(instrumentId);
  const candles = useCandles(instrumentId, timeframe, providerId);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const seriesRef = useRef<CandleSeriesHandle | null>(null);
  const priceLineRef = useRef<PriceLineHandle | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      width: Math.max(320, container.clientWidth),
      height: 280,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#737c95",
        fontFamily: '"DM Sans", sans-serif',
      },
      grid: {
        vertLines: { color: "rgba(135,145,170,.12)" },
        horzLines: { color: "rgba(135,145,170,.12)" },
      },
      rightPriceScale: { borderColor: "rgba(135,145,170,.2)" },
      timeScale: { borderColor: "rgba(135,145,170,.2)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#35a987",
      downColor: "#e98783",
      borderVisible: false,
      wickUpColor: "#35a987",
      wickDownColor: "#e98783",
      priceLineVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series as unknown as CandleSeriesHandle;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) chart.applyOptions({ width });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (priceLineRef.current) {
        series.removePriceLine(
          priceLineRef.current as unknown as Parameters<typeof series.removePriceLine>[0],
        );
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(candles.map((bar) => ({
      time: bar.time as Time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })));
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (priceLineRef.current) {
      series.removePriceLine(priceLineRef.current);
      priceLineRef.current = null;
    }
    // Never plot a cached price from another provider on this feed's candles.
    if (!quote.quote || quote.quote.provider !== providerId) return;
    priceLineRef.current = series.createPriceLine({
      price: quote.quote.price,
      color: quote.freshness === "LIVE" ? "#655ee0" : "#a3a9bc",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: isSnapshotQuote(quote.quote) ? "SNAPSHOT" : quote.freshness === "LIVE" ? "LIVE" : quote.freshness,
    });
  }, [quote.quote?.price, quote.quote?.provider, quote.freshness, providerId]);

  return (
    <div className="price-chart-wrap">
      {candles.length === 0 ? (
        <div className="chart-loading">
          <span className="chart-loader" />
          <strong>Loading verified candle history</strong>
          <p>Last price remains available above while chart history loads.</p>
        </div>
      ) : null}
      <div ref={containerRef} className={"price-chart " + (candles.length === 0 ? "chart-muted" : "")} />
      <div className="chart-source-note">
        <span>ONE CANONICAL QUOTE</span>
        <span>{quote.quote ? "SOURCE TIME " + new Date(quote.quote.sourceTimeMs).toLocaleTimeString() : "WAITING FOR FIRST QUOTE"}</span>
      </div>
    </div>
  );
}
