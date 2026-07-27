import type { Config } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// Monitor P2P USDT/CLP en Binance con alertas por Telegram
// Se ejecuta automáticamente cada 10 minutos (ver config abajo)
// ============================================================

const BINANCE_P2P_URL =
  "https://p2p.binance.com/bapi/c2c/v2/friendly/search/adv/search";

// --- Variables de entorno (configurar en Netlify, NUNCA en el código) ---
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

// --- Umbrales de alerta (ajustables por env vars) ---
const SPREAD_ALERT_PCT = parseFloat(process.env.SPREAD_ALERT_PCT ?? "1.2");
const BUY_OPPORTUNITY_CLP = parseFloat(process.env.BUY_OPPORTUNITY_CLP ?? "0");

interface P2PAdv {
  adv: {
    price: string;
    surplusAmount: string;
    minSingleTransAmount: string;
    maxSingleTransAmount: string;
    tradeMethods: { tradeMethodName: string }[];
  };
  advertiser: {
    nickName: string;
    monthOrderCount: number;
    monthFinishRate: number;
  };
}

async function fetchP2P(tradeType: "BUY" | "SELL"): Promise<P2PAdv[]> {
  const res = await fetch(BINANCE_P2P_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fiat: "CLP",
      asset: "USDT",
      tradeType,
      page: 1,
      rows: 10,
      payTypes: [],
      countries: [],
      publisherType: null,
      proMerchantAds: false,
    }),
  });
  if (!res.ok) throw new Error(`Binance P2P HTTP ${res.status}`);
  const json = await res.json();
  return json.data ?? [];
}

function bestPrice(ads: P2PAdv[]): number | null {
  if (!ads.length) return null;
  return parseFloat(ads[0].adv.price);
}

// Precio promedio de los primeros N anuncios (más robusto que solo el mejor)
function avgTopPrices(ads: P2PAdv[], n = 5): number | null {
  const top = ads.slice(0, n).map((a) => parseFloat(a.adv.price));
  if (!top.length) return null;
  return top.reduce((s, p) => s + p, 0) / top.length;
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
    // 1. Consultar ambos lados del libro P2P
    const [buyAds, sellAds] = await Promise.all([
      fetchP2P("BUY"),
      fetchP2P("SELL"),
    ]);

    const bestBuy = bestPrice(buyAds);
    const bestSell = bestPrice(sellAds);
    const avgBuy = avgTopPrices(buyAds);
    const avgSell = avgTopPrices(sellAds);

    if (bestBuy === null || bestSell === null) {
      throw new Error("Sin datos de anuncios P2P");
    }

    // 2. Spread bruto: (venta - compra) / compra
    const spreadPct = ((bestSell - bestBuy) / bestBuy) * 100;

    // 3. Guardar snapshot en Supabase
    const { error } = await supabase.from("p2p_snapshots").insert({
      best_buy_clp: bestBuy,
      best_sell_clp: bestSell,
      avg_buy_clp: avgBuy,
      avg_sell_clp: avgSell,
      spread_pct: Number(spreadPct.toFixed(3)),
    });
    if (error) console.error("Supabase insert error:", error.message);

    // 4. Alertas
    const alerts: string[] = [];

    if (spreadPct >= SPREAD_ALERT_PCT) {
      alerts.push(
        `🟢 <b>Spread alto: ${spreadPct.toFixed(2)}%</b>\n` +
          `Compra: $${bestBuy.toLocaleString("es-CL")} CLP\n` +
          `Venta: $${bestSell.toLocaleString("es-CL")} CLP`
      );
    }

    if (BUY_OPPORTUNITY_CLP > 0 && bestBuy <= BUY_OPPORTUNITY_CLP) {
      alerts.push(
        `🔵 <b>USDT barato: $${bestBuy.toLocaleString("es-CL")} CLP</b>\n` +
          `(umbral: $${BUY_OPPORTUNITY_CLP.toLocaleString("es-CL")})`
      );
    }

    for (const msg of alerts) {
      await sendTelegram(`💱 <b>P2P USDT/CLP</b>\n\n${msg}`);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        bestBuy,
        bestSell,
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
