import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const RETENCION_UBER = 0.1525;

async function reply(text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
  });
}

function clp(n) {
  return "$" + Math.round(Number(n)).toLocaleString("es-CL");
}

function hoyChile() {
  return new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
}

function normalizar(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[-_\s]/g, "");
}

function limiteSugerido(ops) {
  if (ops <= 0) return 250000;
  if (ops <= 3) return 500000;
  if (ops <= 9) return 1000000;
  return 2000000;
}

const AYUDA =
  "🤖 <b>Cómo usarme</b>\n\n" +
  "<b>Registrar</b> (sin comandos):\n" +
  "  <code>uber 200000</code>\n" +
  "  <code>super 45000 compras semana</code>\n" +
  "  <code>bencina 25000</code>\n\n" +
  "<b>Consultas:</b>\n" +
  "  /hoy — movimientos de hoy\n" +
  "  /mes — balance por esfera\n" +
  "  /uber — ganancia neta manejando\n" +
  "  /pendientes — palabras sin clasificar\n" +
  "  /agregar palabra esfera tipo categoria\n\n" +
  "<b>Contrapartes:</b>\n" +
  "  /check nickname\n" +
  "  /reg nickname monto [banco]\n" +
  "  /bloquear nickname motivo\n" +
  "  /ok nickname\n" +
  "  /top";

export default async (req) => {
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  let update;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  const msg = update?.message;
  if (!msg?.text) return new Response("ok");
  if (String(msg.chat?.id) !== String(TELEGRAM_CHAT_ID)) return new Response("ok");

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const partes = msg.text.trim().split(/\s+/);
  const primera = partes[0].toLowerCase().split("@")[0];

  try {
    if (primera === "/start" || primera === "/help" || primera === "/ayuda") {
      await reply(AYUDA);
      return new Response("ok");
    }

    if (primera === "/hoy") {
      const { data } = await supabase.from("finanzas").select("*")
        .eq("fecha", hoyChile()).order("id", { ascending: false });
      if (!data?.length) { await reply("No hay movimientos hoy."); return new Response("ok"); }
      const lineas = data.map((m) =>
        `${m.tipo === "ingreso" ? "🟢" : "🔴"} ${m.palabra} ${clp(m.monto_clp)}` +
        (m.descripcion ? ` — ${m.descripcion}` : ""));
      const ing = data.filter((m) => m.tipo === "ingreso").reduce((s, m) => s + Number(m.monto_clp), 0);
      const gas = data.filter((m) => m.tipo === "gasto").reduce((s, m) => s + Number(m.monto_clp), 0);
      await reply(`📅 <b>Hoy</b>\n\n${lineas.join("\n")}\n\nIngresos: ${clp(ing)}\nGastos: ${clp(gas)}\n<b>Balance: ${clp(ing - gas)}</b>`);
      return new Response("ok");
    }

    if (primera === "/mes") {
      const desde = hoyChile().slice(0, 8) + "01";
      const { data } = await supabase.from("finanzas").select("esfera,tipo,monto_clp,retencion_clp").gte("fecha", desde);
      const lista = data ?? [];
      if (!lista.length) { await reply("No hay movimientos este mes."); return new Response("ok"); }
      const bloques = ["personal", "uber", "p2p"].map((e) => {
        const f = lista.filter((m) => m.esfera === e);
        const ing = f.filter((m) => m.tipo === "ingreso").reduce((s, m) => s + Number(m.monto_clp), 0);
        const gas = f.filter((m) => m.tipo === "gasto").reduce((s, m) => s + Number(m.monto_clp), 0);
        const ret = f.reduce((s, m) => s + Number(m.retencion_clp), 0);
        return `<b>${e.toUpperCase()}</b>\n  Ingresos: ${clp(ing)}\n` +
          (ret > 0 ? `  Retención: -${clp(ret)}\n` : "") +
          `  Gastos: ${clp(gas)}\n  Balance: <b>${clp(ing - ret - gas)}</b>`;
      });
      const tI = lista.filter((m) => m.tipo === "ingreso").reduce((s, m) => s + Number(m.monto_clp), 0);
      const tG = lista.filter((m) => m.tipo === "gasto").reduce((s, m) => s + Number(m.monto_clp), 0);
      const tR = lista.reduce((s, m) => s + Number(m.retencion_clp), 0);
      await reply(`📊 <b>Mes actual</b>\n\n${bloques.join("\n\n")}\n\n━━━━━━━━\n<b>TOTAL: ${clp(tI - tR - tG)}</b>`);
      return new Response("ok");
    }

    if (primera === "/uber") {
      const desde = hoyChile().slice(0, 8) + "01";
      const { data } = await supabase.from("finanzas").select("tipo,categoria,monto_clp,retencion_clp")
        .eq("esfera", "uber").gte("fecha", desde);
      const lista = data ?? [];
      const bruto = lista.filter((m) => m.tipo === "ingreso").reduce((s, m) => s + Number(m.monto_clp), 0);
      const ret = lista.reduce((s, m) => s + Number(m.retencion_clp), 0);
      const gastos = lista.filter((m) => m.tipo === "gasto").reduce((s, m) => s + Number(m.monto_clp), 0);
      const porCat = {};
      for (const m of lista.filter((x) => x.tipo === "gasto")) {
        porCat[m.categoria] = (porCat[m.categoria] ?? 0) + Number(m.monto_clp);
      }
      const detalle = Object.entries(porCat).map(([c, v]) => `  ${c}: ${clp(v)}`).join("\n");
      await reply(`🚗 <b>Uber — mes</b>\n\nBruto: ${clp(bruto)}\nRetención SII (15,25%): -${clp(ret)}\n` +
        `Gastos:\n${detalle || "  (sin gastos)"}\nTotal gastos: -${clp(gastos)}\n\n<b>GANANCIA REAL: ${clp(bruto - ret - gastos)}</b>`);
      return new Response("ok");
    }

    if (primera === "/pendientes") {
      const { data } = await supabase.from("palabras_pendientes").select("*").order("veces", { ascending: false });
      if (!data?.length) { await reply("No hay palabras pendientes ✅"); return new Response("ok"); }
      const lineas = data.map((p) => `• <b>${p.palabra}</b> (${p.veces} veces)`);
      await reply(`⚠️ <b>Sin clasificar</b>\n\n${lineas.join("\n")}\n\n<code>/agregar palabra esfera tipo categoria</code>`);
      return new Response("ok");
    }

    if (primera === "/agregar") {
      const [, pal, esf, tip, cat] = partes;
      if (!pal || !esf || !tip || !cat) {
        await reply("Uso: <code>/agregar palabra esfera tipo categoria</code>\nesfera: personal|uber|p2p\ntipo: ingreso|gasto");
        return new Response("ok");
      }
      const p = normalizar(pal);
      await supabase.from("diccionario").upsert({ palabra: p, esfera: esf.toLowerCase(), tipo: tip.toLowerCase(), categoria: cat.toLowerCase() });
      await supabase.from("palabras_pendientes").delete().eq("palabra", p);
      await reply(`✅ Agregada: <b>${p}</b> → ${esf}/${tip}/${cat}`);
      return new Response("ok");
    }

    if (primera === "/check") {
      const nick = partes[1];
      if (!nick) { await reply("Uso: <b>/check</b> nickname"); return new Response("ok"); }
      const { data: rows } = await supabase.from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];
      if (!c) {
        await reply(`🔴 <b>NUEVO</b> — ${nick}\n\nSin historial.\nLímite máximo: <b>${clp(250000)}</b>\n\n⚠️ Verificar pago desde cuenta a su nombre.`);
      } else if (c.confiable === false) {
        await reply(`⛔ <b>BLOQUEADO</b> — ${c.nickname}\n\nMotivo: ${c.notas ?? "sin nota"}\n\n<b>NO OPERAR</b>`);
      } else {
        await reply(`🟢 <b>CONOCIDO</b> — ${c.nickname}\n\nOperaciones: <b>${c.total_operaciones}</b>\nAcumulado: ${clp(c.monto_acumulado_clp)}\nÚltima: ${c.ultima_operacion ?? "-"}\n` +
          (c.banco ? `Banco: ${c.banco}\n` : "") + `\nLímite sugerido: <b>${clp(limiteSugerido(c.total_operaciones))}</b>`);
      }
      return new Response("ok");
    }

    if (primera === "/reg") {
      const nick = partes[1];
      const monto = parseFloat(partes[2] ?? "");
      const banco = partes.slice(3).join(" ") || null;
      if (!nick || isNaN(monto) || monto <= 0) { await reply("Uso: <code>/reg nickname monto [banco]</code>"); return new Response("ok"); }
      const { data: rows } = await supabase.from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];
      if (c) {
        const ops = c.total_operaciones + 1;
        const
