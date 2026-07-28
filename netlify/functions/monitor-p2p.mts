import type { Config } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// Monitor P2P USDT/CLP (Binance P2P vía CriptoYa)
// Se ejecuta automáticamente cada 10 minutos
// ============================================================

// CriptoYa: API pública de cotizaciones LATAM (actualiza cada 1 min)
const CRIPTOYA_URL = "https://criptoya.com/api/binancep2p/USDT/CLP/100";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const SPREAD_ALERT_PCT = parseFloat(process.env.SPREAD_ALERT_PCT ?? "1.2");
const BUY_OPPORTUNITY_CLP = parseFloat(process.env.BUY_OPPORTUNITY_CLP ?? "0");

interface CriptoYaQuote {
  ask: number;      // precio al que COMPRAS USDT
  totalAsk: number; // compra incluyendo comisiones
  bid: number;      // precio al que VENDES USDT
  totalBid: number; // venta descontando comisiones
  time: number;
}

async function fetchQuote(): Promise<CriptoYaQuote> {
  const res = await fetch(CRIPTOYA_URL);
  if (!res.ok) throw new Error(`CriptoYa HTTP ${res.status}`);
  return (await res.json()) as CriptoYaQuote;
}

async function sendTelegram(text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  });
}

export default async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // 1. Preguntar precios (una sola llamada trae ambos lados)
    const q = await fetchQuote();

    if (!q.ask || !q.bid) {
      throw new Error("CriptoYa sin datos de ask/bid");
    }

    // 2. Spread: (venta - compra) / compra
    const spreadPct = ((q.ask - q.bid) / q.bid) * 100;

    // 3. Anotar en la memoria
    const { error } = await supabase.from("p2p_snapshots").insert({
      best_buy_clp: q.ask,
      best_sell_clp: q.bid,
      avg_buy_clp: q.totalAsk,  // compra CON comisiones
      avg_sell_clp: q.totalBid, // venta CON comisiones
      spread_pct: Number(spreadPct.toFixed(3)),
    });
    if (error) console.error("Supabase insert error:", error.message);

    // 4. Avisar si corresponde
    const alerts: string[] = [];

    if (spreadPct >= SPREAD_ALERT_PCT) {
      alerts.push(
        `🟢 <b>Spread alto: ${spreadPct.toFixed(2)}%</b>\n` +
          `Compra: $${q.ask.toLocaleString("es-CL")} CLP\n` +
          `Venta: $${q.bid.toLocaleString("es-CL")} CLP`
      );
    }

    if (BUY_OPPORTUNITY_CLP > 0 && q.ask <= BUY_OPPORTUNITY_CLP) {
      alerts.push(
        `🔵 <b>USDT barato: $${q.ask.toLocaleString("es-CL")} CLP</b>\n` +
          `(umbral: $${BUY_OPPORTUNITY_CLP.toLocaleString("es-CL")})`
      );
    }

    for (const msg of alerts) {
      await sendTelegram(`💱 <b>P2P USDT/CLP</b>\n\n${msg}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        buy: q.ask,
        sell: q.bid,
        spreadPct: spreadPct.toFixed(2),
        alertsSent: alerts.length,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("Monitor error:", err.message);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
    });
  }
};

// Cron: cada 10 minutos
export const config: Config = {
  schedule: "*/10 * * * *",
};
