import type { Config } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// Monitor multi-par / multi-exchange (CriptoYa)
// USDT/CLP: dos segmentos de mercado (grande $500k / chico $100k)
// Alertas MAKER: ventana abierta / cerrada / recordatorio, con
// margen NETO (descontada la comision maker) y precios sugeridos.
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

// --- Maker: comision por lado y margen neto minimo para avisar ---
const MAKER_FEE_PCT = parseFloat(process.env.MAKER_FEE_PCT ?? "0.2"); // 0,2% por lado (anuncio)
const MAKER_NET_MIN_PCT = parseFloat(process.env.MAKER_NET_MIN_PCT ?? "0.35"); // neto minimo por ciclo

const ARB_ALERT_PCT = parseFloat(process.env.ARB_ALERT_PCT ?? "1.5");
const ARB_CRYPTO_ALERT_PCT = parseFloat(process.env.ARB_CRYPTO_ALERT_PCT ?? "1.5");
const BUY_OPPORTUNITY_CLP = parseFloat(process.env.BUY_OPPORTUNITY_CLP ?? "0");
const SELL_OPPORTUNITY_CLP = parseFloat(process.env.SELL_OPPORTUNITY_CLP ?? "0");

// Dos segmentos de mercado
const MONTO_GRANDE = parseFloat(process.env.MONTO_GRANDE ?? "500000");
const MONTO_CHICO = parseFloat(process.env.MONTO_CHICO ?? "100000");
const TOP_N = parseInt(process.env.TOP_N ?? "5", 10);

// Alerta de expansion (bruta, sin comision): apagada por defecto porque avisaba margenes que no rinden
const EXPANSION_ACTIVA = (process.env.EXPANSION_ACTIVA ?? "false") === "true";
const EXPANSION_FACTOR = parseFloat(process.env.EXPANSION_FACTOR ?? "1.25");
const EXPANSION_MIN_PCT = parseFloat(process.env.EXPANSION_MIN_PCT ?? "0.3");
const EXPANSION_MIN_MUESTRAS = 6;

// Recordatorio de ventana: cada N ciclos (12 x 10min = 2h)
const RECORDATORIO_CADA = parseInt(process.env.RECORDATORIO_CADA ?? "12", 10);

// Tiempo maximo por consulta externa (evita que una API lenta bloquee todo)
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS ?? "8000", 10);

const CONFIABLES = [
  "binancep2p",
  "buda",
  "cryptomkt",
  "cryptomktpro",
  "bybitp2p",
  "vitawallet",
  "orionx",
];

// Exchanges que nunca se consideran (ni arbitraje ni registro)
const EXCLUIR = ["bingx", "bingxp2p"];

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
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmt(n: number): string {
  return n.toLocaleString("es-CL", { maximumFractionDigits: 2 });
}

// Margen neto de un ciclo maker (compra + venta), descontando la comision de ambos lados
function netoMaker(spreadPct: number): number {
  return spreadPct - 2 * MAKER_FEE_PCT;
}

// ============================================================
// Libro P2P de Binance para un monto (segmento) especifico
// ============================================================
async function binanceP2P(tradeType: "BUY" | "SELL", transAmount: number) {
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
        transAmount: String(transAmount),
        countries: [],
        payTypes: [],
        proMerchantAds: false,
        publisherType: null,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }
  );

  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);

  const j: any = await res.json();
  const lista = (j?.data ?? [])
    .map((d: any) => ({
      precio: parseFloat(d?.adv?.price),
      nick: d?.advertiser?.nickName ?? "?",
      disponible: parseFloat(d?.adv?.surplusAmount ?? "0"),
      min: parseFloat(d?.adv?.minSingleTransAmount ?? "0"),
      max: parseFloat(d?.adv?.maxSingleTransAmount ?? "0"),
      pagos: (d?.adv?.tradeMethods ?? [])
        .map((m: any) => m?.identifier ?? m?.tradeMethodName)
        .filter(Boolean),
    }))
    .filter((x: any) => x.precio > 0);

  if (!lista.length) throw new Error(`Binance sin anuncios (${tradeType}/${transAmount})`);

  lista.sort((a: any, b: any) =>
    tradeType === "BUY" ? a.precio - b.precio : b.precio - a.precio
  );

  return lista.slice(0, TOP_N);
}

// ============================================================
// Evaluacion maker de un segmento
//   topB: anuncios donde la gente COMPRA (ahi compite tu anuncio de VENTA), mas barato primero
//   topS: anuncios donde la gente VENDE (ahi compite tu anuncio de COMPRA), mas caro primero
//   serie: spreads brutos de ciclos anteriores de ESTE segmento (mas reciente primero)
// ============================================================
function evaluarSegmento(
  etiqueta: string,
  spreadPct: number,
  serie: (number | null)[],
  topB: any[],
  topS: any[],
  medB: number,
  medS: number
): { msgs: string[]; cerro: boolean } {
  const out: string[] = [];
  let cerro = false;
  const neto = netoMaker(spreadPct);
  const abierta = neto >= MAKER_NET_MIN_PCT;

  const previo = serie.length && serie[0] !== null ? netoMaker(serie[0] as number) : null;
  const previaAbierta = previo !== null && previo >= MAKER_NET_MIN_PCT;

  let racha = 0;
  for (const v of serie) {
    if (v !== null && netoMaker(v) >= MAKER_NET_MIN_PCT) racha++;
    else break;
  }
  const rachaActual = abierta ? racha + 1 : 0;

  // Precios sugeridos para tus anuncios
  const ventaComp = r2(topB[0].precio - 0.01);
  const compraComp = r2(topS[0].precio + 0.01);
  const netComp = netoMaker(((ventaComp - compraComp) / compraComp) * 100);
  const ventaMed = r2(medB - 0.01);
  const compraMed = r2(medS + 0.01);
  const netMed = netoMaker(((ventaMed - compraMed) / compraMed) * 100);

  const lineasPrecios =
    `Precios para tus anuncios:\n` +
    (netComp >= MAKER_NET_MIN_PCT
      ? `• <b>Primer lugar</b>: venta $${fmt(ventaComp)} / compra $${fmt(compraComp)} → neto ${netComp.toFixed(2)}%\n`
      : `• Primer lugar: venta $${fmt(ventaComp)} / compra $${fmt(compraComp)} → neto ${netComp.toFixed(2)}% ⚠️ bajo el mínimo\n`) +
    `• <b>Precio medio</b> (se llena más lento): venta $${fmt(ventaMed)} / compra $${fmt(compraMed)} → neto ${netMed.toFixed(2)}%`;

  const cabecera =
    `Spread: ${spreadPct.toFixed(2)}% · Comisión: −${(2 * MAKER_FEE_PCT).toFixed(2)}%\n` +
    `Neto: <b>${neto.toFixed(2)}%</b> (mínimo ${MAKER_NET_MIN_PCT}%)`;

  if (abierta && !previaAbierta) {
    out.push(
      `🟢 <b>Ventana maker ABIERTA — ${etiqueta}</b>\n` +
        `${cabecera}\n\n${lineasPrecios}\n\n` +
        `👉 Pon tus anuncios <b>en línea</b> si puedes estar atento.`
    );
  } else if (abierta && rachaActual > 1 && rachaActual % RECORDATORIO_CADA === 0) {
    const horas = ((rachaActual * 10) / 60).toFixed(1);
    out.push(
      `🔔 <b>Ventana maker sigue abierta — ${etiqueta} (${horas}h)</b>\n` +
        `${cabecera}\n\n${lineasPrecios}\n\n` +
        `Revisa que tus precios sigan competitivos.`
    );
  } else if (!abierta && previaAbierta) {
    cerro = true;
    out.push(
      `🔴 <b>Ventana maker CERRADA — ${etiqueta}</b>\n` +
        `${cabecera}\n\n` +
        `👉 <b>Apaga tus anuncios</b> (ya no cubre la comisión).`
    );
  }

  return { msgs: out, cerro };
}

// ============================================================
// Vigilancia de TUS precios (los registras con /precios en el bot)
//   topB[0]: el anuncio de venta mas barato del mercado (compite con tu VENTA)
//   topS[0]: el anuncio de compra que mas paga (compite con tu COMPRA)
// Avisa una sola vez por cada precio nuevo del competidor.
// ============================================================
async function vigilarMisPrecios(supabase: any, topB: any[], topS: any[]): Promise<string[]> {
  const { data: cfg } = await supabase.from("config_p2p").select("clave,valor");
  const val = (k: string) => Number(cfg?.find((c: any) => c.clave === k)?.valor ?? 0);
  if (val("mis_precios_activo") !== 1) return [];

  const miVenta = val("mi_precio_venta");
  const miCompra = val("mi_precio_compra");
  const refVenta = val("aviso_venta_ref");
  const refCompra = val("aviso_compra_ref");
  const out: string[] = [];
  const cambios: { clave: string; valor: number }[] = [];

  const veredicto = (dif: number, base: number) => {
    const neto = netoMaker((dif / base) * 100);
    if (neto >= MAKER_NET_MIN_PCT) return `✅ Ajusta: sigues con buen margen (neto ${neto.toFixed(2)}%)`;
    if (neto > 0) return `⚠️ Casi sin ganancia (neto ${neto.toFixed(2)}%): ajusta solo si quieres sumar órdenes`;
    return `❌ No lo sigas: perderías plata (neto ${neto.toFixed(2)}%). Quédate en tu precio o apaga`;
  };

  // --- Tu VENTA ---
  const rivalV = topB[0];
  if (miVenta > 0 && rivalV && rivalV.precio < miVenta - 0.001) {
    if (Math.abs(rivalV.precio - refVenta) > 0.001) {
      const nuevo = r2(rivalV.precio - 0.01);
      const dif = nuevo - miCompra;
      out.push(
        `⚠️ <b>Te ganaron en VENTA</b>\n` +
          `Tu precio: $${fmt(miVenta)} · ${rivalV.nick}: $${fmt(rivalV.precio)}\n` +
          `Para quedar primero: <b>$${fmt(nuevo)}</b>\n` +
          `Diferencia con tu compra ($${fmt(miCompra)}): ${dif.toFixed(2)} pesos\n` +
          `${veredicto(dif, miCompra)}\n` +
          `Si ajustas, avísale al bot: <code>/precios venta ${nuevo}</code>`
      );
      cambios.push({ clave: "aviso_venta_ref", valor: rivalV.precio });
    }
  } else if (refVenta !== 0) {
    cambios.push({ clave: "aviso_venta_ref", valor: 0 });
  }

  // --- Tu COMPRA ---
  const rivalC = topS[0];
  if (miCompra > 0 && rivalC && rivalC.precio > miCompra + 0.001) {
    if (Math.abs(rivalC.precio - refCompra) > 0.001) {
      const nuevo = r2(rivalC.precio + 0.01);
      const dif = miVenta - nuevo;
      out.push(
        `⚠️ <b>Te ganaron en COMPRA</b>\n` +
          `Tu precio: $${fmt(miCompra)} · ${rivalC.nick}: $${fmt(rivalC.precio)}\n` +
          `Para quedar primero: <b>$${fmt(nuevo)}</b>\n` +
          `Diferencia con tu venta ($${fmt(miVenta)}): ${dif.toFixed(2)} pesos\n` +
          `${veredicto(dif, nuevo)}\n` +
          `Si ajustas, avísale al bot: <code>/precios compra ${nuevo}</code>`
      );
      cambios.push({ clave: "aviso_compra_ref", valor: rivalC.precio });
    }
  } else if (refCompra !== 0) {
    cambios.push({ clave: "aviso_compra_ref", valor: 0 });
  }

  if (cambios.length) {
    const ahora = new Date().toISOString();
    await supabase.from("config_p2p").upsert(cambios.map((c) => ({ ...c, updated_at: ahora })));
  }
  return out;
}

export default async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const alerts: string[] = [];
  const resumen: any[] = [];

  try {
    // ====== 1. Pares CriptoYa en paralelo (cada uno con timeout propio) ======
    const respuestas = await Promise.all(
      PARES.map(async ({ par, url }) => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return { par, all: (await res.json()) as Record<string, Quote> };
        } catch (e: any) {
          console.error(`Error consultando ${par}:`, e.message);
          return { par, all: null };
        }
      })
    );

    // ====== 2. Binance: dos segmentos, cuatro consultas en paralelo ======
    let topBuy: any[] = [];
    let topSell: any[] = [];
    let topBuyChico: any[] = [];
    let topSellChico: any[] = [];
    let fuente = "binance_depth";

    try {
      [topBuy, topSell] = await Promise.all([
        binanceP2P("BUY", MONTO_GRANDE),
        binanceP2P("SELL", MONTO_GRANDE),
      ]);
    } catch (e: any) {
      console.error("Binance segmento grande fallo:", e.message);
      fuente = "criptoya_fallback";
    }

    try {
      [topBuyChico, topSellChico] = await Promise.all([
        binanceP2P("BUY", MONTO_CHICO),
        binanceP2P("SELL", MONTO_CHICO),
      ]);
    } catch (e: any) {
      console.error("Binance segmento chico fallo:", e.message);
    }

    // ====== 3. Procesar cada par ======
    for (const { par, all } of respuestas) {
      if (!all) continue;

      const valid = Object.entries(all).filter(
        ([name, q]) =>
          !EXCLUIR.includes(name.toLowerCase()) &&
          q && q.ask > 0 && q.bid > 0 && q.totalAsk > 0 && q.totalBid > 0
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

      if (SOLO_RECOLECTAR.includes(par)) continue;

      // ====== USDT/CLP ======
      if (par === "USDT/CLP") {
        const b = all["binancep2p"];

        let medBuy = 0;
        let medSell = 0;

        if (topBuy.length && topSell.length) {
          medBuy = mediana(topBuy.map((x) => x.precio));
          medSell = mediana(topSell.map((x) => x.precio));
        } else if (b && b.ask > 0 && b.bid > 0) {
          medBuy = b.ask;
          medSell = b.bid;
        }

        // Segmento chico
        let medBuyCh = 0;
        let medSellCh = 0;
        let makerPctCh: number | null = null;

        if (topBuyChico.length && topSellChico.length) {
          medBuyCh = mediana(topBuyChico.map((x) => x.precio));
          medSellCh = mediana(topSellChico.map((x) => x.precio));
          if (medBuyCh > 0 && medSellCh > 0) {
            makerPctCh = ((medBuyCh - medSellCh) / medSellCh) * 100;
          }
        }

        if (medBuy > 0 && medSell > 0) {
          const makerPct = ((medBuy - medSell) / medSell) * 100;

          const desde = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
          const { data: hist } = await supabase
            .from("p2p_snapshots")
            .select("spread_pct,spread_pct_chico")
            .eq("fuente", "binance_depth")
            .gte("created_at", desde)
            .order("created_at", { ascending: false })
            .limit(60);

          const aNum = (v: any): number | null => {
            const n = v === null || v === undefined ? NaN : Number(v);
            return isNaN(n) ? null : n;
          };
          const serieGrande = (hist ?? []).map((h: any) => aNum(h.spread_pct));
          const serieChico = (hist ?? []).map((h: any) => aNum(h.spread_pct_chico));

          const { error: eSnap } = await supabase.from("p2p_snapshots").insert({
            best_buy_clp: topBuy[0]?.precio ?? b?.ask ?? null,
            best_sell_clp: topSell[0]?.precio ?? b?.bid ?? null,
            avg_buy_clp: b?.totalAsk ?? null,
            avg_sell_clp: b?.totalBid ?? null,
            median_buy_clp: Number(medBuy.toFixed(2)),
            median_sell_clp: Number(medSell.toFixed(2)),
            buy_top: topBuy.length ? topBuy : null,
            sell_top: topSell.length ? topSell : null,
            median_buy_chico: medBuyCh > 0 ? Number(medBuyCh.toFixed(2)) : null,
            median_sell_chico: medSellCh > 0 ? Number(medSellCh.toFixed(2)) : null,
            spread_pct_chico: makerPctCh !== null ? Number(makerPctCh.toFixed(3)) : null,
            buy_top_chico: topBuyChico.length ? topBuyChico : null,
            sell_top_chico: topSellChico.length ? topSellChico : null,
            fuente,
            spread_pct: Number(makerPct.toFixed(3)),
          });
          if (eSnap) console.error("p2p_snapshots insert:", eSnap.message);

          resumen.push({
            par,
            fuente,
            grande: makerPct.toFixed(3),
            netoGrande: netoMaker(makerPct).toFixed(3),
            chico: makerPctCh !== null ? makerPctCh.toFixed(3) : null,
            netoChico: makerPctCh !== null ? netoMaker(makerPctCh).toFixed(3) : null,
          });

          // --- ALERTAS MAKER por segmento (solo con datos directos de Binance) ---
          if (fuente === "binance_depth" && topBuy.length && topSell.length) {
            alerts.push(
              ...evaluarSegmento(
                `montos grandes ($${fmt(MONTO_GRANDE)})`,
                makerPct, serieGrande, topBuy, topSell, medBuy, medSell
              ).msgs
            );
          }
          if (makerPctCh !== null && topBuyChico.length && topSellChico.length) {
            const ch = evaluarSegmento(
              `montos chicos ($${fmt(MONTO_CHICO)})`,
              makerPctCh, serieChico, topBuyChico, topSellChico, medBuyCh, medSellCh
            );
            alerts.push(...ch.msgs);

            if (ch.cerro) {
              // Ventana chica cerrada: se apaga la vigilancia de tus precios
              await supabase.from("config_p2p").upsert([
                { clave: "mis_precios_activo", valor: 0, updated_at: new Date().toISOString() },
              ]);
            } else {
              try {
                alerts.push(...(await vigilarMisPrecios(supabase, topBuyChico, topSellChico)));
              } catch (e: any) {
                console.error("Vigilancia de precios fallo:", e.message);
              }
            }
          }

          // --- Expansion bruta (opcional, apagada por defecto) ---
          const serie6h = serieGrande.slice(0, 36).filter((n): n is number => n !== null);
          const promedio6h = serie6h.length ? serie6h.reduce((s, n) => s + n, 0) / serie6h.length : null;
          const previo = serieGrande[0] ?? null;
          if (
            EXPANSION_ACTIVA &&
            promedio6h !== null &&
            serie6h.length >= EXPANSION_MIN_MUESTRAS &&
            makerPct >= EXPANSION_MIN_PCT
          ) {
            const gatillo = promedio6h * EXPANSION_FACTOR;
            const expandio = makerPct >= gatillo;
            const previoExpandio = previo !== null && previo >= gatillo;
            if (expandio && !previoExpandio) {
              alerts.push(
                `📈 <b>Expansión del spread (bruto)</b>\n` +
                  `Ahora: <b>${makerPct.toFixed(2)}%</b> · neto ${netoMaker(makerPct).toFixed(2)}%\n` +
                  `Promedio 6h: ${promedio6h.toFixed(2)}% (${serie6h.length} muestras)`
              );
            }
          }

          if (BUY_OPPORTUNITY_CLP > 0 && medBuy <= BUY_OPPORTUNITY_CLP) {
            alerts.push(
              `🔵 <b>USDT barato: $${fmt(medBuy)}</b> (mediana)\n` +
                `(tu objetivo: $${fmt(BUY_OPPORTUNITY_CLP)})`
            );
          }
          if (SELL_OPPORTUNITY_CLP > 0 && medSell >= SELL_OPPORTUNITY_CLP) {
            alerts.push(
              `🟠 <b>Precio de venta alcanzado: $${fmt(medSell)}</b> (mediana)\n` +
                `(tu objetivo: $${fmt(SELL_OPPORTUNITY_CLP)})`
            );
          }
        }
      }

      // ====== Arbitraje ======
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
                `Comprar en <b>${buyEx}</b> a $${fmt(buyPrice)}\n` +
                `Vender en <b>${sellEx}</b> a $${fmt(sellPrice)}\n` +
                `Referencia: $${fmt(ref)}\n` +
                `(bruto; falta descontar red y movimiento de precio)`
            );
          }
        }
      }
    }

    for (const msg of alerts) {
      try {
        await sendTelegram(`💱 <b>Monitor Cripto CLP</b>\n\n${msg}`);
      } catch (e: any) {
        console.error("Telegram fallo:", e.message);
      }
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
