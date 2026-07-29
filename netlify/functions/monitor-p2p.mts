import type { Config } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// Monitor multi-exchange USDT/CLP (CriptoYa) + arbitraje
// + vigilancia de errores de Telegram
// ============================================================

const CRIPTOYA_ALL = "https://criptoya.com/api/USDT/CLP/100";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const SPREAD_ALERT_PCT = parseFloat(process.env.SPREAD_ALERT_PCT ?? "0.8");
const ARB_ALERT_PCT = parseFloat(process.env.ARB_ALERT_PCT ?? "1.0");
const BUY_OPPORTUNITY_CLP = parseFloat(process.env.BUY_OPPORTUNITY_CLP ?? "0");
const SELL_OPPORTUNITY_CLP = parseFloat(process.env.SELL_OPPORTUNITY_CLP ?? "0");
interface Quote {
  ask: number;
  totalAsk: number;
  bid: number;
  totalBid: number;
  time: number;
}

async function fetchAllExchanges(): Promise<Record<string, Quote>> {
  const res = await fetch(CRIPTOYA_ALL);
  if (!res.ok) throw new Error(`CriptoYa HTTP ${res.status}`);
  return (await res.json()) as Record<string, Quote>;
}

async function sendTelegram(text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  });
  if (!res.ok) {
    const detalle = await res.text();
    console.error("Telegram error:", res.status, detalle);
  }
}

export default async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  try {
    // 1. Mercado completo en una sola llamada
    const all = await fetchAllExchanges();

    // 2. Filtrar cotizaciones válidas
    const valid = Object.entries(all).filter(
      ([, q]) => q && q.ask > 0 && q.bid > 0 && q.totalAsk > 0 && q.totalBid > 0
    );
    if (!valid.length) throw new Error("CriptoYa sin cotizaciones válidas");

    // 3. Guardar TODAS las cotizaciones
    const rows = valid.map(([name, q]) => ({
      exchange: name,
      ask: q.ask,
      total_ask: q.totalAsk,
      bid: q.bid,
      total_bid: q.totalBid,
    }));
    const { error: e1 } = await supabase.from("exchange_quotes").insert(rows);
    if (e1) console.error("exchange_quotes insert error:", e1.message);

    const alerts: string[] = [];

    // 4. Binance P2P: serie histórica + margen maker
    const b = all["binancep2p"];
    if (b && b.ask > 0 && b.bid > 0) {
      const makerPct = ((b.ask - b.bid) / b.bid) * 100;
      const { error: e2 } = await supabase.from("p2p_snapshots").insert({
        best_buy_clp: b.ask,
        best_sell_clp: b.bid,
        avg_buy_clp: b.totalAsk,
        avg_sell_clp: b.totalBid,
        spread_pct: Number(makerPct.toFixed(3)),
      });
      if (e2) console.error("p2p_snapshots insert error:", e2.message);

      if (makerPct >= SPREAD_ALERT_PCT) {
        alerts.push(
          `🟢 <b>Margen maker Binance: ${makerPct.toFixed(2)}%</b>\n` +
            `Mercado compra a: $${b.ask.toLocaleString("es-CL")}\n` +
            `Mercado vende a: $${b.bid.toLocaleString("es-CL")}`
        );
      }
      if (BUY_OPPORTUNITY_CLP > 0 && b.ask <= BUY_OPPORTUNITY_CLP) {
        alerts.push(
          `🔵 <b>USDT barato en Binance: $${b.ask.toLocaleString("es-CL")}</b>`
        );
      }
    }
if (SELL_OPPORTUNITY_CLP > 0 && b.bid >= SELL_OPPORTUNITY_CLP) {
        alerts.push(
          `🟠 <b>Precio de venta alcanzado: $${b.bid.toLocaleString("es-CL")}</b>\n` +
            `(tu objetivo: $${SELL_OPPORTUNITY_CLP.toLocaleString("es-CL")})`
        );
      }

    // 5. Mejor ruta de arbitraje (precios CON comisiones)
    let buyEx = valid[0][0], buyPrice = valid[0][1].totalAsk;
    let sellEx = valid[0][0], sellPrice = valid[0][1].totalBid;
    for (const [name, q] of valid) {
      if (q.totalAsk < buyPrice) { buyPrice = q.totalAsk; buyEx = name; }
      if (q.totalBid > sellPrice) { sellPrice = q.totalBid; sellEx = name; }
    }
    const arbPct = ((sellPrice - buyPrice) / buyPrice) * 100;

    if (arbPct >= ARB_ALERT_PCT && buyEx !== sellEx) {
      alerts.push(
        `⚡ <b>Arbitraje: ${arbPct.toFixed(2)}%</b>\n` +
          `Comprar en <b>${buyEx}</b> a $${buyPrice.toLocaleString("es-CL")}\n` +
          `Vender en <b>${sellEx}</b> a $${sellPrice.toLocaleString("es-CL")}\n` +
          `(bruto; falta descontar red y transferencias)`
      );
    }

    // 6. Enviar alertas
    for (const msg of alerts) {
      await sendTelegram(`💱 <b>P2P USDT/CLP</b>\n\n${msg}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        exchanges: valid.length,
        arb: { buyEx, buyPrice, sellEx, sellPrice, arbPct: arbPct.toFixed(2) },
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

export const config: Config = {
  schedule: "*/10 * * * *",
};
