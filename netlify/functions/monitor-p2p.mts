import type { Config } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// Monitor multi-par / multi-exchange (CriptoYa)
// USDT/CLP: negocio maker + arbitraje
// BTC/CLP y ETH/CLP: estudio de arbitraje cripto
// ============================================================

const PARES = [
  { par: "USDT/CLP", url: "https://criptoya.com/api/USDT/CLP/100" },
  { par: "BTC/CLP", url: "https://criptoya.com/api/BTC/CLP/0.01" },
  { par: "ETH/CLP", url: "https://criptoya.com/api/ETH/CLP/0.1" },
  { par: "XRP/CLP", url: "https://criptoya.com/api/XRP/CLP/1000" },
];

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const SPREAD_ALERT_PCT = parseFloat(process.env.SPREAD_ALERT_PCT ?? "0.8");
const ARB_ALERT_PCT = parseFloat(process.env.ARB_ALERT_PCT ?? "0.6");
const ARB_CRYPTO_ALERT_PCT = parseFloat(process.env.ARB_CRYPTO_ALERT_PCT ?? "1.5");
const BUY_OPPORTUNITY_CLP = parseFloat(process.env.BUY_OPPORTUNITY_CLP ?? "0");
const SELL_OPPORTUNITY_CLP = parseFloat(process.env.SELL_OPPORTUNITY_CLP ?? "0");

// Exchanges chilenos con liquidez real
const CONFIABLES = [
  "binancep2p",
  "buda",
  "cryptomkt",
  "cryptomktpro",
  "bybitp2p",
  "vitawallet",
  "orionx",
];

const MAX_DESVIO_PCT = 1.5;

interface Quote {
  ask: number;
  totalAsk: number;
  bid: number;
  totalBid: number;
  time: number;
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

function mediana(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export default async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const alerts: string[] = [];
  const resumen: any[] = [];

  try {
    for (const { par, url } of PARES) {
      let all: Record<string, Quote>;

      // 1. Consultar el par
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        all = (await res.json()) as Record<string, Quote>;
      } catch (e: any) {
        console.error(`Error consultando ${par}:`, e.message);
        continue;
      }

      // 2. Cotizaciones completas
      const valid = Object.entries(all).filter(
        ([, q]) => q && q.ask > 0 && q.bid > 0 && q.totalAsk > 0 && q.totalBid > 0
      );
      if (!valid.length) {
        console.error(`${par}: sin cotizaciones validas`);
        continue;
      }

      // 3. Guardar datos crudos
      const rows = valid.map(([name, q]) => ({
        par,
        exchange: name,
        ask: q.ask,
        total_ask: q.totalAsk,
        bid: q.bid,
        total_bid: q.totalBid,
      }));
      const { error: eIns } = await supabase.from("exchange_quotes").insert(rows);
      if (eIns) console.error(`insert ${par}:`, eIns.message);

      // 4. Solo USDT/CLP: serie historica maker + alertas de precio
      if (par === "USDT/CLP") {
        const b = all["binancep2p"];
        if (b && b.ask > 0 && b.bid > 0) {
          const makerPct = ((b.ask - b.bid) / b.bid) * 100;
          const { error: eSnap } = await supabase.from("p2p_snapshots").insert({
            best_buy_clp: b.ask,
            best_sell_clp: b.bid,
            avg_buy_clp: b.totalAsk,
            avg_sell_clp: b.totalBid,
            spread_pct: Number(makerPct.toFixed(3)),
          });
          if (eSnap) console.error("p2p_snapshots insert:", eSnap.message);

          if (makerPct >= SPREAD_ALERT_PCT) {
            alerts.push(
              `🟢 <b>Margen maker Binance: ${makerPct.toFixed(2)}%</b>\n` +
                `Mercado compra a: $${b.ask.toLocaleString("es-CL")}\n` +
                `Mercado vende a: $${b.bid.toLocaleString("es-CL")}`
            );
          }
          if (BUY_OPPORTUNITY_CLP > 0 && b.ask <= BUY_OPPORTUNITY_CLP) {
            alerts.push(
              `🔵 <b>USDT barato: $${b.ask.toLocaleString("es-CL")}</b>\n` +
                `(tu objetivo: $${BUY_OPPORTUNITY_CLP.toLocaleString("es-CL")})`
            );
          }
          if (SELL_OPPORTUNITY_CLP > 0 && b.bid >= SELL_OPPORTUNITY_CLP) {
            alerts.push(
              `🟠 <b>Precio de venta alcanzado: $${b.bid.toLocaleString("es-CL")}</b>\n` +
                `(tu objetivo: $${SELL_OPPORTUNITY_CLP.toLocaleString("es-CL")})`
            );
          }
        }
      }

      // 5. Arbitraje del par, con filtro anti-outlier
      const candidatos = valid.filter(
        ([name, q]) => CONFIABLES.includes(name) && q.totalBid < q.totalAsk
      );

      if (candidatos.length >= 3) {
        const medios = candidatos.map(([, q]) => (q.totalAsk + q.totalBid) / 2);
        const ref = mediana(medios);

        const arbitrables = candidatos.filter(([, q]) => {
          const dAsk = Math.abs((q.totalAsk - ref) / ref) * 100;
          const dBid = Math.abs((q.totalBid - ref) / ref) * 100;
          return dAsk <= MAX_DESVIO_PCT && dBid <= MAX_DESVIO_PCT;
        });

        if (arbitrables.length >= 2) {
          let buyEx = arbitrables[0][0];
          let buyPrice = arbitrables[0][1].totalAsk;
          let sellEx = arbitrables[0][0];
          let sellPrice = arbitrables[0][1].totalBid;

          for (const [name, q] of arbitrables) {
            if (q.totalAsk < buyPrice) { buyPrice = q.totalAsk; buyEx = name; }
            if (q.totalBid > sellPrice) { sellPrice = q.totalBid; sellEx = name; }
          }

          const arbPct = ((sellPrice - buyPrice) / buyPrice) * 100;
          const umbral = par === "USDT/CLP" ? ARB_ALERT_PCT : ARB_CRYPTO_ALERT_PCT;

          resumen.push({ par, buyEx, sellEx, arbPct: arbPct.toFixed(3) });

          if (arbPct >= umbral && buyEx !== sellEx) {
            alerts.push(
              `⚡ <b>Arbitraje ${par}: ${arbPct.toFixed(2)}%</b>\n` +
                `Comprar en <b>${buyEx}</b> a $${buyPrice.toLocaleString("es-CL")}\n` +
                `Vender en <b>${sellEx}</b> a $${sellPrice.toLocaleString("es-CL")}\n` +
                `Referencia: $${ref.toLocaleString("es-CL")}\n` +
                `(bruto; falta descontar red y movimiento de precio)`
            );
          }
        }
      }
    }

    // 6. Enviar alertas
    for (const msg of alerts) {
      await sendTelegram(`💱 <b>Monitor Cripto CLP</b>\n\n${msg}`);
    }

    return new Response(
      JSON.stringify({ ok: true, resumen, alertsSent: alerts.length }),
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
