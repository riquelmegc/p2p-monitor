import type { Config } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// Monitor multi-par / multi-exchange (CriptoYa)
// USDT/CLP: maker con profundidad Binance + metodos de pago
// USDT LATAM: referencia internacional (solo recoleccion)
// BTC/ETH/XRP CLP: estudio de arbitraje cripto
// ============================================================

const PARES = [
  { par: "USDT/CLP", url: "https://criptoya.com/api/USDT/CLP/100" },
  { par: "BTC/CLP", url: "https://criptoya.com/api/BTC/CLP/0.01" },
  { par: "ETH/CLP", url: "https://criptoya.com/api/ETH/CLP/0.1" },
  { par: "XRP/CLP", url: "https://criptoya.com/api/XRP/CLP/1000" },
  { par: "USDT/ARS", url: "https://criptoya.com/api/USDT/ARS/100" },
  { par: "USDT/COP", url: "https://criptoya.com/api/USDT/COP/100" },
  { par: "USDT/PEN", url: "https://criptoya.com/api/USDT/PEN/100" },
  { par: "USDT/VES", url: "https://criptoya.com/api/USDT/VES/100" },
];

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID!;

const SPREAD_ALERT_PCT = parseFloat(process.env.SPREAD_ALERT_PCT ?? "0.45");
const ARB_ALERT_PCT = parseFloat(process.env.ARB_ALERT_PCT ?? "1.5");
const ARB_CRYPTO_ALERT_PCT = parseFloat(process.env.ARB_CRYPTO_ALERT_PCT ?? "1.5");
const BUY_OPPORTUNITY_CLP = parseFloat(process.env.BUY_OPPORTUNITY_CLP ?? "0");
const SELL_OPPORTUNITY_CLP = parseFloat(process.env.SELL_OPPORTUNITY_CLP ?? "0");

// Profundidad Binance
const MIN_ANUNCIO_CLP = parseFloat(process.env.MIN_ANUNCIO_CLP ?? "500000");
const TOP_N = parseInt(process.env.TOP_N ?? "5", 10);

// Alerta de expansion
const EXPANSION_FACTOR = parseFloat(process.env.EXPANSION_FACTOR ?? "1.25");
const EXPANSION_MIN_PCT = parseFloat(process.env.EXPANSION_MIN_PCT ?? "0.3");
const EXPANSION_MIN_MUESTRAS = 6;

// Exchanges chilenos con liquidez real (solo para arbitraje CLP)
const CONFIABLES = [
  "binancep2p",
  "buda",
  "cryptomkt",
  "cryptomktpro",
  "bybitp2p",
  "vitawallet",
  "orionx",
];

// Pares que solo se recolectan, sin alertas
const SOLO_RECOLECTAR = ["USDT/ARS", "USDT/COP", "USDT/PEN", "USDT/VES"];

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
      chat_id: TELEGRAM_ALERT_CHAT_ID,
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

// ============================================================
// Profundidad real del libro P2P de Binance
// tradeType "BUY"  = anuncios donde TU compras USDT  -> lado ask
// tradeType "SELL" = anuncios donde TU vendes USDT   -> lado bid
// ============================================================
async function binanceP2P(tradeType: "BUY" | "SELL") {
  const res = await fetch(
    "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "es-CL,es;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Origin: "https://p2p.binance.com",
        Referer: "https://p2p.binance.com/es/trade/all-payments/USDT?fiat=CLP",
      },
      body: JSON.stringify({
        fiat: "CLP",
        asset: "USDT",
        tradeType,
        page: 1,
        rows: 20,
        transAmount: String(MIN_ANUNCIO_CLP),
        countries: [],
        payTypes: [],
        proMerchantAds: false,
        publisherType: null,
      }),
    }
  );

  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

  const j: any = await res.json();
  const lista = (j?.data ?? [])
    .map((d: any) => ({
      precio: parseFloat(d?.adv?.price),
      nick: d?.advertiser?.nickName ?? "?",
      disponible: parseFloat(d?.adv?.surplusAmount ?? "0"),
      pagos: (d?.adv?.tradeMethods ?? [])
        .map((m: any) => m?.identifier ?? m?.tradeMethodName)
        .filter(Boolean),
    }))
    .filter((x: any) => x.precio > 0);

  if (!lista.length) throw new Error(`Binance sin anuncios (${tradeType})`);

  lista.sort((a: any, b: any) =>
    tradeType === "BUY" ? a.precio - b.precio : b.precio - a.precio
  );

  return lista.slice(0, TOP_N);
}

export default async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const alerts: string[] = [];
  const resumen: any[] = [];

  try {
    for (const { par, url } of PARES) {
      let all: Record<string, Quote>;

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        all = (await res.json()) as Record<string, Quote>;
      } catch (e: any) {
        console.error(`Error consultando ${par}:`, e.message);
        continue;
      }

      const valid = Object.entries(all).filter(
        ([, q]) => q && q.ask > 0 && q.bid > 0 && q.totalAsk > 0 && q.totalBid > 0
      );
      if (!valid.length) {
        console.error(`${par}: sin cotizaciones validas`);
        continue;
      }

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

      // Pares internacionales: solo se guardan, sin analisis ni alertas
      if (SOLO_RECOLECTAR.includes(par)) continue;

      // ====== USDT/CLP: profundidad + alertas maker ======
      if (par === "USDT/CLP") {
        const b = all["binancep2p"];

        let topBuy: any[] = [];
        let topSell: any[] = [];
        let medBuy = 0;
        let medSell = 0;
        let fuente = "binance_depth";

        try {
          [topBuy, topSell] = await Promise.all([
            binanceP2P("BUY"),
            binanceP2P("SELL"),
          ]);
          medBuy = mediana(topBuy.map((x) => x.precio));
          medSell = mediana(topSell.map((x) => x.precio));
        } catch (e: any) {
          console.error("Binance profundidad fallo:", e.message);
          fuente = "criptoya_fallback";
          if (b && b.ask > 0 && b.bid > 0) {
            medBuy = b.ask;
            medSell = b.bid;
          }
        }

        if (medBuy > 0 && medSell > 0) {
          const makerPct = ((medBuy - medSell) / medSell) * 100;

          const desde = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
          const { data: hist } = await supabase
            .from("p2p_snapshots")
            .select("spread_pct")
            .eq("fuente", "binance_depth")
            .gte("created_at", desde)
            .order("created_at", { ascending: false })
            .limit(40);

          const serie = (hist ?? [])
            .map((h: any) => Number(h.spread_pct))
            .filter((n) => !isNaN(n));

          const previo = serie.length ? serie[0] : null;
          const promedio6h = serie.length
            ? serie.reduce((s, n) => s + n, 0) / serie.length
            : null;

          const { error: eSnap } = await supabase.from("p2p_snapshots").insert({
            best_buy_clp: topBuy[0]?.precio ?? b?.ask ?? null,
            best_sell_clp: topSell[0]?.precio ?? b?.bid ?? null,
            avg_buy_clp: b?.totalAsk ?? null,
            avg_sell_clp: b?.totalBid ?? null,
            median_buy_clp: Number(medBuy.toFixed(2)),
            median_sell_clp: Number(medSell.toFixed(2)),
            buy_top: topBuy.length ? topBuy : null,
            sell_top: topSell.length ? topSell : null,
            fuente,
            spread_pct: Number(makerPct.toFixed(3)),
          });
          if (eSnap) console.error("p2p_snapshots insert:", eSnap.message);

          resumen.push({
            par,
            fuente,
            makerPct: makerPct.toFixed(3),
            promedio6h: promedio6h ? promedio6h.toFixed(3) : null,
            muestras: serie.length,
          });

          // --- ALERTA 1: umbral fijo (solo flanco de subida) ---
          const cruzoUmbral =
            makerPct >= SPREAD_ALERT_PCT &&
            (previo === null || previo < SPREAD_ALERT_PCT);

          if (cruzoUmbral) {
            alerts.push(
              `🟢 <b>Margen maker: ${makerPct.toFixed(2)}%</b>\n` +
                `Compra (mediana top ${TOP_N}): $${medBuy.toLocaleString("es-CL")}\n` +
                `Venta (mediana top ${TOP_N}): $${medSell.toLocaleString("es-CL")}\n` +
                `Umbral: ${SPREAD_ALERT_PCT}% · Fuente: ${fuente}`
            );
          }

          // --- ALERTA 2: expansion sobre promedio 6h ---
          if (
            promedio6h !== null &&
            serie.length >= EXPANSION_MIN_MUESTRAS &&
            makerPct >= EXPANSION_MIN_PCT
          ) {
            const gatillo = promedio6h * EXPANSION_FACTOR;
            const expandio = makerPct >= gatillo;
            const previoExpandio = previo !== null && previo >= gatillo;

            if (expandio && !previoExpandio && !cruzoUmbral) {
              const veces = (makerPct / promedio6h).toFixed(2);
              alerts.push(
                `📈 <b>Expansión del spread</b>\n` +
                  `Ahora: <b>${makerPct.toFixed(2)}%</b>\n` +
                  `Promedio 6h: ${promedio6h.toFixed(2)}% (${serie.length} muestras)\n` +
                  `Está ${veces}× sobre lo normal\n` +
                  `Compra $${medBuy.toLocaleString("es-CL")} / Venta $${medSell.toLocaleString("es-CL")}`
              );
            }
          }

          if (BUY_OPPORTUNITY_CLP > 0 && medBuy <= BUY_OPPORTUNITY_CLP) {
            alerts.push(
              `🔵 <b>USDT barato: $${medBuy.toLocaleString("es-CL")}</b> (mediana)\n` +
                `(tu objetivo: $${BUY_OPPORTUNITY_CLP.toLocaleString("es-CL")})`
            );
          }
          if (SELL_OPPORTUNITY_CLP > 0 && medSell >= SELL_OPPORTUNITY_CLP) {
            alerts.push(
              `🟠 <b>Precio de venta alcanzado: $${medSell.toLocaleString("es-CL")}</b> (mediana)\n` +
                `(tu objetivo: $${SELL_OPPORTUNITY_CLP.toLocaleString("es-CL")})`
            );
          }
        }
      }

      // ====== Arbitraje con filtro anti-outlier ======
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