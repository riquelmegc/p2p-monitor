import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const RETENCION_UBER = 0.1525;
const IMPUESTO_P2P = 0.20;
const LIMITE_NUEVO = 200000;
const META_MAKER = 20;
const STOCK_INICIAL = "stock_inicial"; // saldo previo cargado a mano: no cuenta como orden

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

function fechaChile(d = new Date()) {
  return new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
}

function hoyChile() {
  return fechaChile();
}

function normalizar(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[-_\s]/g, "");
}

function limiteSugerido(ops) {
  if (ops <= 0) return LIMITE_NUEVO;
  if (ops <= 2) return 2000000;
  return 5000000;
}

// Monto en pesos: acepta 50000, 50.000, 49433.79, 49433,79 y 49.433,79
function parseCLP(s) {
  s = (s || "").replace(/\$/g, "");
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return parseFloat(s.replace(/[.,]/g, ""));
  if (s.includes(".") && s.includes(",")) return parseFloat(s.replace(/\./g, "").replace(",", "."));
  return parseFloat(s.replace(",", "."));
}

// Monto en USDT: acepta 51.93 y 51,93
function parseUSDT(s) {
  return parseFloat((s || "").replace(",", "."));
}

async function tg(metodo, body) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

// Foto normal (la más grande) o imagen enviada como archivo
function extraerFoto(msg) {
  if (msg.photo?.length) return msg.photo[msg.photo.length - 1];
  if (msg.document?.mime_type?.startsWith("image/")) return msg.document;
  return null;
}

// Guarda el file_id de Telegram y una copia en Supabase Storage (bucket "vouchers")
async function guardarVoucher(supabase, ordenId, foto) {
  let path = null;
  try {
    const info = await tg("getFile", { file_id: foto.file_id });
    const fp = info?.result?.file_path;
    if (fp) {
      const bin = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fp}`).then((r) => r.arrayBuffer());
      const ext = (fp.split(".").pop() || "jpg").toLowerCase();
      path = `orden-${ordenId}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from("vouchers").upload(path, bin, { contentType: ext === "png" ? "image/png" : "image/jpeg" });
      if (error) { console.error("Storage:", error.message); path = null; }
    }
  } catch (e) {
    console.error("Voucher:", e.message);
    path = null;
  }
  await supabase.from("vouchers").insert({ orden_id: ordenId, file_id: foto.file_id, storage_path: path });
  const { count } = await supabase.from("vouchers").select("id", { count: "exact", head: true }).eq("orden_id", ordenId);
  return { respaldada: !!path, total: count ?? 1 };
}

async function ordenes30d(supabase) {
  const desde = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const { count } = await supabase.from("ordenes_p2p").select("id", { count: "exact", head: true }).neq("nickname", STOCK_INICIAL).gte("created_at", desde);
  return count ?? 0;
}

const AYUDA =
  "🤖 <b>Cómo usarme</b>\n\n" +
  "<b>Finanzas</b> (sin comandos):\n" +
  "  <code>uber 200000</code>\n" +
  "  <code>super 45000 compras semana</code>\n\n" +
  "<b>Autopistas:</b>\n" +
  "  <code>tag central 20896 07-09</code>\n" +
  "  /tags — pendientes ordenadas\n" +
  "  /pague apodo — marcar pagada\n\n" +
  "<b>Consultas finanzas:</b>\n" +
  "  /hoy /mes /uber\n" +
  "  /pendientes /diccionario\n" +
  "  /agregar palabra esfera tipo categoria\n\n" +
  "<b>Órdenes P2P:</b>\n" +
  "  <code>/compra nick pesos usdt banco</code>\n" +
  "  <code>/venta nick pesos usdt banco</code>\n" +
  "  /ganancia — ganancia, stock y avance a 20\n" +
  "  /capital — saldo en USDT y en pesos\n" +
  "  <code>/capital ajustar 9500000</code> — corrige los pesos (depósitos/retiros)\n\n" +
  "<b>Vouchers (fotos):</b>\n" +
  "  Foto con el /compra o /venta como texto → registra y guarda\n" +
  "  Foto sin texto → se agrega a la última orden\n" +
  "  Foto con <code>/foto 12</code> → se agrega a la orden #12\n" +
  "  /fotos [n°] — ver fotos (última orden si no pones n°)\n\n" +
  "<b>Contrapartes P2P:</b>\n" +
  "  /check nickname\n" +
  "  /bloquear /ok /top /impuesto";

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
  if (!msg) return new Response("ok");
  if (String(msg.chat?.id) !== String(TELEGRAM_CHAT_ID)) return new Response("ok");

  const foto = extraerFoto(msg);
  const textoMsg = (msg.text ?? msg.caption ?? "").trim();
  if (!textoMsg && !foto) return new Response("ok");

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const partes = textoMsg ? textoMsg.split(/\s+/) : [""];
  const primera = partes[0].toLowerCase().split("@")[0];

  try {
    // ── Foto sin /compra ni /venta: se adjunta a una orden existente ──
    if (foto && primera !== "/compra" && primera !== "/venta") {
      let orden;
      if (primera === "/foto") {
        const id = parseInt(partes[1], 10);
        if (!id) { await reply("Uso: foto con texto <code>/foto 12</code>"); return new Response("ok"); }
        const { data } = await supabase.from("ordenes_p2p").select("id,tipo,nickname").eq("id", id).limit(1);
        orden = data?.[0];
        if (!orden) { await reply(`No existe la orden #${id}.`); return new Response("ok"); }
      } else {
        const { data } = await supabase.from("ordenes_p2p").select("id,tipo,nickname").neq("nickname", STOCK_INICIAL).order("id", { ascending: false }).limit(1);
        orden = data?.[0];
        if (!orden) { await reply("Aún no hay órdenes para adjuntar la foto."); return new Response("ok"); }
      }
      const v = await guardarVoucher(supabase, orden.id, foto);
      await reply(`📎 Voucher guardado en orden <b>#${orden.id}</b> (${orden.tipo} · ${orden.nickname})\nFotos en esta orden: ${v.total}` + (v.respaldada ? "" : "\n⚠️ No se pudo respaldar en Storage (quedó el enlace de Telegram)."));
      return new Response("ok");
    }

    if (primera === "/fotos") {
      let id = parseInt(partes[1], 10);
      if (!id) {
        const { data } = await supabase.from("ordenes_p2p").select("id").neq("nickname", STOCK_INICIAL).order("id", { ascending: false }).limit(1);
        id = data?.[0]?.id;
      }
      if (!id) { await reply("Aún no hay órdenes."); return new Response("ok"); }
      const { data: vs } = await supabase.from("vouchers").select("file_id").eq("orden_id", id).order("id");
      if (!vs?.length) { await reply(`La orden #${id} no tiene fotos.`); return new Response("ok"); }
      for (const [i, v] of vs.entries()) {
        await tg("sendPhoto", { chat_id: TELEGRAM_CHAT_ID, photo: v.file_id, caption: `Orden #${id} · foto ${i + 1}/${vs.length}` });
      }
      return new Response("ok");
    }

    if (primera === "/start" || primera === "/help" || primera === "/ayuda") {
      await reply(AYUDA);
      return new Response("ok");
    }

    if (primera === "/diccionario") {
      const { data } = await supabase.from("diccionario").select("palabra,esfera,categoria").order("esfera").order("categoria");
      if (!data?.length) { await reply("El diccionario está vacío."); return new Response("ok"); }
      const porEsfera = {};
      for (const d of data) {
        if (!porEsfera[d.esfera]) porEsfera[d.esfera] = {};
        if (!porEsfera[d.esfera][d.categoria]) porEsfera[d.esfera][d.categoria] = [];
        porEsfera[d.esfera][d.categoria].push(d.palabra);
      }
      let texto = "📖 <b>Diccionario</b>\n";
      for (const esfera of Object.keys(porEsfera)) {
        texto += `\n<b>━ ${esfera.toUpperCase()} ━</b>\n`;
        for (const cat of Object.keys(porEsfera[esfera])) {
          texto += `<b>${cat}:</b> ${porEsfera[esfera][cat].join(", ")}\n`;
        }
      }
      await reply(texto);
      return new Response("ok");
    }

    if (primera === "/tags") {
      const verPagadas = (partes[1] || "").toLowerCase() === "pagadas";
      const { data } = await supabase.from("autopistas").select("*").eq("pagada", verPagadas).order("vencimiento");
      if (!data?.length) {
        await reply(verPagadas ? "No hay boletas pagadas registradas." : "🎉 No tienes autopistas pendientes.");
        return new Response("ok");
      }
      if (verPagadas) {
        const lineas = data.map((a) => `✅ ${a.apodo} — ${clp(a.monto_clp)} (pagada ${a.fecha_pago})`);
        await reply(`<b>Autopistas pagadas</b>\n\n${lineas.join("\n")}`);
        return new Response("ok");
      }
      const hoy = new Date(hoyChile() + "T00:00:00");
      let total = 0;
      const lineas = data.map((a) => {
        total += Number(a.monto_clp);
        const venc = new Date(a.vencimiento + "T00:00:00");
        const dias = Math.round((venc - hoy) / (1000 * 3600 * 24));
        let urgencia = "🟢";
        if (dias < 0) urgencia = "⛔";
        else if (dias <= 3) urgencia = "🔴";
        else if (dias <= 7) urgencia = "🟡";
        const txtDias = dias < 0 ? `VENCIDA hace ${-dias}d` : dias === 0 ? "VENCE HOY" : `en ${dias} días`;
        return `${urgencia} <b>${a.apodo}</b> — ${clp(a.monto_clp)}\n   vence ${a.vencimiento} (${txtDias})`;
      });
      await reply(`🛣️ <b>Autopistas pendientes</b>\n\n${lineas.join("\n\n")}\n\n━━━━━━━━\n<b>TOTAL: ${clp(total)}</b>`);
      return new Response("ok");
    }

    if (primera === "/pague") {
      const apodo = (partes[1] || "").toLowerCase();
      if (!apodo) { await reply("Uso: <code>/pague apodo</code>\nEj: /pague central"); return new Response("ok"); }
      const { data: rows } = await supabase.from("autopistas").select("*").ilike("apodo", apodo).eq("pagada", false).limit(1);
      const a = rows && rows[0];
      if (!a) { await reply(`No encontré una boleta pendiente con apodo "${apodo}".\nUsa /tags para ver las pendientes.`); return new Response("ok"); }
      await supabase.from("autopistas").update({ pagada: true, fecha_pago: hoyChile() }).eq("id", a.id);
      await reply(`✅ <b>Pagada</b> — ${a.apodo} (${clp(a.monto_clp)})\nSalió de tus pendientes.`);
      return new Response("ok");
    }

    if (primera === "/hoy") {
      const { data } = await supabase.from("finanzas").select("*").eq("fecha", hoyChile()).order("id", { ascending: false });
      if (!data?.length) { await reply("No hay movimientos hoy."); return new Response("ok"); }
      const lineas = data.map((m) => `${m.tipo === "ingreso" ? "🟢" : "🔴"} ${m.palabra} ${clp(m.monto_clp)}` + (m.descripcion ? ` — ${m.descripcion}` : ""));
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
        return `<b>${e.toUpperCase()}</b>\n  Ingresos: ${clp(ing)}\n` + (ret > 0 ? `  Retención: -${clp(ret)}\n` : "") + `  Gastos: ${clp(gas)}\n  Balance: <b>${clp(ing - ret - gas)}</b>`;
      });
      const tI = lista.filter((m) => m.tipo === "ingreso").reduce((s, m) => s + Number(m.monto_clp), 0);
      const tG = lista.filter((m) => m.tipo === "gasto").reduce((s, m) => s + Number(m.monto_clp), 0);
      const tR = lista.reduce((s, m) => s + Number(m.retencion_clp), 0);
      await reply(`📊 <b>Mes actual</b>\n\n${bloques.join("\n\n")}\n\n━━━━━━━━\n<b>TOTAL: ${clp(tI - tR - tG)}</b>`);
      return new Response("ok");
    }

    if (primera === "/uber") {
      const desde = hoyChile().slice(0, 8) + "01";
      const { data } = await supabase.from("finanzas").select("tipo,categoria,monto_clp,retencion_clp").eq("esfera", "uber").gte("fecha", desde);
      const lista = data ?? [];
      const bruto = lista.filter((m) => m.tipo === "ingreso").reduce((s, m) => s + Number(m.monto_clp), 0);
      const ret = lista.reduce((s, m) => s + Number(m.retencion_clp), 0);
      const gastos = lista.filter((m) => m.tipo === "gasto").reduce((s, m) => s + Number(m.monto_clp), 0);
      const porCat = {};
      for (const m of lista.filter((x) => x.tipo === "gasto")) { porCat[m.categoria] = (porCat[m.categoria] ?? 0) + Number(m.monto_clp); }
      const detalle = Object.entries(porCat).map(([c, v]) => `  ${c}: ${clp(v)}`).join("\n");
      await reply(`🚗 <b>Uber — mes</b>\n\nBruto: ${clp(bruto)}\nRetención SII (15,25%): -${clp(ret)}\nGastos:\n${detalle || "  (sin gastos)"}\nTotal gastos: -${clp(gastos)}\n\n<b>GANANCIA REAL: ${clp(bruto - ret - gastos)}</b>`);
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
      if (!pal || !esf || !tip || !cat) { await reply("Uso: <code>/agregar palabra esfera tipo categoria</code>\nesfera: personal|uber|p2p\ntipo: ingreso|gasto"); return new Response("ok"); }
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
        await reply(`🔴 <b>NUEVO</b> — ${nick}\n\nSin historial.\nLímite máximo: <b>${clp(LIMITE_NUEVO)}</b>\n\n⚠️ Verificar pago desde cuenta a su nombre.`);
      } else if (c.confiable === false) {
        await reply(`⛔ <b>BLOQUEADO</b> — ${c.nickname}\n\nMotivo: ${c.notas ?? "sin nota"}\n\n<b>NO OPERAR</b>`);
      } else {
        await reply(`🟢 <b>CONOCIDO</b> — ${c.nickname}\n\nOperaciones: <b>${c.total_operaciones}</b>\nAcumulado: ${clp(c.monto_acumulado_clp)}\nÚltima: ${c.ultima_operacion ?? "-"}\n` + (c.banco ? `Banco: ${c.banco}\n` : "") + `\nLímite sugerido: <b>${clp(limiteSugerido(c.total_operaciones))}</b>`);
      }
      return new Response("ok");
    }

    // ── Órdenes P2P: /compra y /venta escriben en ordenes_p2p ──
    if (primera === "/compra" || primera === "/venta") {
      const tipo = primera === "/compra" ? "compra" : "venta";
      const nick = (partes[1] || "").toLowerCase();
      const monto = parseCLP(partes[2]);
      const usdt = parseUSDT(partes[3]);
      const banco = partes.slice(4).join(" ").toLowerCase() || null;
      if (!nick || !(monto > 0) || !(usdt > 0)) {
        await reply(`Uso: <code>${primera} nick pesos usdt banco</code>\nEj: <code>${primera} finansmart 50000 51.93 mercadopago</code>`);
        return new Response("ok");
      }

      const { data: ins, error } = await supabase
        .from("ordenes_p2p")
        .insert({ tipo, nickname: nick, banco, monto_clp: monto, usdt })
        .select("id,precio_efectivo")
        .single();
      if (error) throw new Error(error.message);

      const voucher = foto ? await guardarVoucher(supabase, ins.id, foto) : null;

      let ganancia = null;
      if (tipo === "venta") {
        const { data: g } = await supabase.from("ganancias_p2p").select("ganancia_clp").eq("id", ins.id).single();
        ganancia = Math.round(Number(g?.ganancia_clp ?? 0));
        await supabase.from("impuesto_apartado").insert({
          fecha: hoyChile(), nickname: nick, monto_operado_clp: monto,
          ganancia_clp: ganancia, impuesto_clp: Math.round(ganancia * IMPUESTO_P2P),
        });
      }

      const { data: rows } = await supabase.from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];
      let ops = 1;
      let aviso = "";
      if (c) {
        ops = c.total_operaciones + 1;
        if (c.confiable === false) aviso = "\n⛔ <b>Ojo: esta contraparte está bloqueada.</b>";
        await supabase.from("contrapartes").update({
          total_operaciones: ops,
          monto_acumulado_clp: Number(c.monto_acumulado_clp) + monto,
          ganancia_acumulada_clp: Number(c.ganancia_acumulada_clp || 0) + (ganancia ?? 0),
          ultima_operacion: hoyChile(),
          banco: banco ?? c.banco,
        }).eq("id", c.id);
      } else {
        await supabase.from("contrapartes").insert({
          nickname: nick, banco, total_operaciones: 1, monto_acumulado_clp: monto,
          ganancia_acumulada_clp: ganancia ?? 0, primera_operacion: hoyChile(), ultima_operacion: hoyChile(),
        });
      }

      const n = await ordenes30d(supabase);
      let texto = `${tipo === "compra" ? "🟦 <b>Compra</b>" : "🟧 <b>Venta</b>"} registrada <b>#${ins.id}</b> — ${nick}${c ? "" : " (nueva)"}\n` +
        `${clp(monto)} · ${usdt.toFixed(2)} USDT\nPrecio efectivo: ${Number(ins.precio_efectivo).toLocaleString("es-CL")}` +
        (banco ? `\nBanco: ${banco}` : "");
      if (ganancia !== null) texto += `\n\n${ganancia >= 0 ? "🟢" : "🔴"} Ganancia: <b>${clp(ganancia)}</b>\n💰 Apartado impuesto: ${clp(Math.max(0, ganancia * IMPUESTO_P2P))}`;
      if (voucher) texto += `\n📎 Voucher guardado`;
      texto += `\n\nOperaciones con ${nick}: ${ops} · límite: ${clp(limiteSugerido(ops))}`;
      texto += `\n📈 Órdenes 30 días: <b>${n} de ${META_MAKER}</b>` + (n >= META_MAKER ? " ✅ ¡Meta maker!" : "");
      await reply(texto + aviso);
      return new Response("ok");
    }

    if (primera === "/capital") {
      if ((partes[1] || "").toLowerCase() === "ajustar") {
        const nuevo = parseCLP(partes[2]);
        if (!(nuevo >= 0)) { await reply("Uso: <code>/capital ajustar 9500000</code>\nPon los pesos que tienes HOY para operar."); return new Response("ok"); }
        const { data: ult } = await supabase.from("ordenes_p2p").select("id").order("id", { ascending: false }).limit(1);
        const ultId = ult?.[0]?.id ?? 0;
        await supabase.from("config_p2p").upsert([
          { clave: "clp_inicial", valor: nuevo, nota: `Ajustado por Telegram ${hoyChile()}`, updated_at: new Date().toISOString() },
          { clave: "clp_desde_orden_id", valor: ultId, nota: `Ajustado por Telegram ${hoyChile()}`, updated_at: new Date().toISOString() },
        ]);
        await reply(`✅ Pesos para operar ajustados a <b>${clp(nuevo)}</b>.`);
        return new Response("ok");
      }
      const { data: cfg } = await supabase.from("config_p2p").select("clave,valor");
      const val = (k) => Number(cfg?.find((c) => c.clave === k)?.valor ?? 0);
      const { data: ords } = await supabase.from("ordenes_p2p").select("tipo,monto_clp").gt("id", val("clp_desde_orden_id")).neq("nickname", STOCK_INICIAL);
      let pesos = val("clp_inicial");
      for (const o of ords ?? []) pesos += o.tipo === "venta" ? Number(o.monto_clp) : -Number(o.monto_clp);
      const { data: g } = await supabase.from("ganancias_p2p").select("stock_usdt,costo_promedio_clp").order("created_at").order("id");
      const ult = g?.[g.length - 1] ?? {};
      const stock = Number(ult.stock_usdt || 0);
      const costo = Number(ult.costo_promedio_clp || 0);
      const valorUsdt = stock * costo;
      await reply(
        `💼 <b>Capital P2P</b>\n\n` +
        `USDT: <b>${stock.toFixed(2)}</b> (costo prom. ${costo.toLocaleString("es-CL")})\n` +
        `   ≈ ${clp(valorUsdt)} a costo\n` +
        `Pesos: <b>${clp(pesos)}</b>\n\n` +
        `━━━━━━━━\n<b>TOTAL a costo: ${clp(valorUsdt + pesos)}</b>`
      );
      return new Response("ok");
    }

    if (primera === "/ganancia") {
      const { data } = await supabase.from("ganancias_p2p").select("*").order("created_at").order("id");
      const lista = data ?? [];
      if (!lista.length) { await reply("Aún no hay órdenes registradas."); return new Response("ok"); }
      const ventas = lista.filter((o) => o.tipo === "venta");
      const total = ventas.reduce((s, o) => s + Number(o.ganancia_clp || 0), 0);
      const hoy = hoyChile();
      const hoyGan = ventas
        .filter((o) => fechaChile(o.created_at) === hoy)
        .reduce((s, o) => s + Number(o.ganancia_clp || 0), 0);
      const ult = lista[lista.length - 1];
      const n = await ordenes30d(supabase);
      await reply(
        `📊 <b>Ganancia P2P</b>\n\n` +
        `Hoy: <b>${clp(hoyGan)}</b>\nTotal: <b>${clp(total)}</b> (${ventas.length} ventas)\n\n` +
        `Stock: ${Number(ult.stock_usdt || 0).toFixed(2)} USDT\nCosto promedio: ${Number(ult.costo_promedio_clp || 0).toLocaleString("es-CL")}\n\n` +
        `📈 Órdenes 30 días: <b>${n} de ${META_MAKER}</b>`
      );
      return new Response("ok");
    }

    // /reg queda por compatibilidad; lo nuevo es /compra y /venta
    if (primera === "/reg") {
      const nick = partes[1];
      const monto = parseFloat((partes[2] ?? "").replace(/[.,]/g, ""));
      const ganancia = parseFloat((partes[3] ?? "").replace(/[.,]/g, ""));
      const banco = partes.slice(4).join(" ") || null;
      if (!nick || isNaN(monto) || monto <= 0 || isNaN(ganancia)) {
        await reply("Uso: <code>/reg nickname monto ganancia [banco]</code>\n\n👉 Mejor usa <code>/compra</code> o <code>/venta</code>: registran la orden y calculan la ganancia solos.");
        return new Response("ok");
      }
      const impuesto = Math.round(ganancia * IMPUESTO_P2P);
      await supabase.from("impuesto_apartado").insert({ nickname: nick, monto_operado_clp: monto, ganancia_clp: ganancia, impuesto_clp: impuesto });
      const { data: rows } = await supabase.from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];
      if (c) {
        const ops = c.total_operaciones + 1;
        const acum = Number(c.monto_acumulado_clp) + monto;
        const gAcum = Number(c.ganancia_acumulada_clp || 0) + ganancia;
        await supabase.from("contrapartes").update({ total_operaciones: ops, monto_acumulado_clp: acum, ganancia_acumulada_clp: gAcum, ultima_operacion: hoyChile(), banco: banco ?? c.banco }).eq("id", c.id);
        await reply(`✅ <b>Registrado</b> — ${c.nickname}\nOperaciones: ${ops}\nMonto: ${clp(monto)} · Ganancia: ${clp(ganancia)}\n💰 Apartado impuesto (20%): ${clp(impuesto)}\nNuevo límite: <b>${clp(limiteSugerido(ops))}</b>`);
      } else {
        await supabase.from("contrapartes").insert({ nickname: nick, banco, total_operaciones: 1, monto_acumulado_clp: monto, ganancia_acumulada_clp: ganancia, ultima_operacion: hoyChile() });
        await reply(`✅ <b>Nueva contraparte</b> — ${nick}\nMonto: ${clp(monto)} · Ganancia: ${clp(ganancia)}\n💰 Apartado impuesto (20%): ${clp(impuesto)}`);
      }
      return new Response("ok");
    }

    if (primera === "/bloquear") {
      const nick = partes[1];
      const motivo = partes.slice(2).join(" ") || "sin motivo";
      if (!nick) { await reply("Uso: <code>/bloquear nickname motivo</code>"); return new Response("ok"); }
      const { data: rows } = await supabase.from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];
      if (c) { await supabase.from("contrapartes").update({ confiable: false, notas: motivo }).eq("id", c.id); }
      else { await supabase.from("contrapartes").insert({ nickname: nick, confiable: false, notas: motivo }); }
      await reply(`⛔ <b>Bloqueado</b> — ${nick}\nMotivo: ${motivo}`);
      return new Response("ok");
    }

    if (primera === "/ok") {
      const nick = partes[1];
      if (!nick) { await reply("Uso: <code>/ok nickname</code>"); return new Response("ok"); }
      const { data: rows } = await supabase.from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];
      if (!c) { await reply(`No encontré a ${nick}`); return new Response("ok"); }
      await supabase.from("contrapartes").update({ confiable: true, notas: null }).eq("id", c.id);
      await reply(`🟢 <b>Desbloqueado</b> — ${c.nickname}`);
      return new Response("ok");
    }

    if (primera === "/top") {
      const { data } = await supabase.from("contrapartes").select("nickname,total_operaciones,monto_acumulado_clp").eq("confiable", true).order("total_operaciones", { ascending: false }).limit(10);
      if (!data?.length) { await reply("Aún no hay contrapartes."); return new Response("ok"); }
      const lineas = data.map((c, i) => `${i + 1}. <b>${c.nickname}</b> — ${c.total_operaciones} ops · ${clp(c.monto_acumulado_clp)}`);
      await reply(`🏆 <b>Mejores clientes</b>\n\n${lineas.join("\n")}`);
      return new Response("ok");
    }

    if (primera === "/impuesto") {
      const { data } = await supabase.from("impuesto_apartado").select("ganancia_clp,impuesto_clp,monto_operado_clp");
      const lista = data ?? [];
      if (!lista.length) { await reply("Aún no has registrado operaciones con ganancia."); return new Response("ok"); }
      const totalOp = lista.reduce((s, r) => s + Number(r.monto_operado_clp), 0);
      const totalGan = lista.reduce((s, r) => s + Number(r.ganancia_clp), 0);
      const totalImp = Math.max(0, lista.reduce((s, r) => s + Number(r.impuesto_clp), 0));
      await reply(`🧾 <b>Impuesto apartado</b>\n\nOperaciones: ${lista.length}\nVolumen operado: ${clp(totalOp)}\nGanancia total: ${clp(totalGan)}\n\n<b>💰 Apartado para SII (20%): ${clp(totalImp)}</b>\n<i>No tocar este dinero.</i>`);
      return new Response("ok");
    }

    // Registro de boleta de autopista: tag apodo monto dd-mm
    if (primera === "tag") {
      const apodo = (partes[1] || "").toLowerCase();
      const monto = parseFloat((partes[2] || "").replace(/[.,]/g, ""));
      const fechaRaw = partes[3] || "";
      if (!apodo || isNaN(monto) || monto <= 0 || !fechaRaw) { await reply("Uso: <code>tag apodo monto dd-mm</code>\nEj: <code>tag central 20896 07-09</code>"); return new Response("ok"); }
      const m = fechaRaw.match(/^(\d{1,2})[-\/](\d{1,2})$/);
      if (!m) { await reply("Fecha inválida. Usa formato dd-mm\nEj: 07-09"); return new Response("ok"); }
      const dd = m[1].padStart(2, "0");
      const mm = m[2].padStart(2, "0");
      const anio = new Date().getFullYear();
      const venc = `${anio}-${mm}-${dd}`;
      await supabase.from("autopistas").insert({ apodo, monto_clp: monto, vencimiento: venc });
      await reply(`🛣️ <b>Boleta registrada</b>\n${apodo} — ${clp(monto)}\nVence: ${venc}\n\nUsa /tags para ver todas.`);
      return new Response("ok");
    }

    if (primera.startsWith("/")) {
      await reply(`No conozco ese comando.\n\n${AYUDA}`);
      return new Response("ok");
    }

    // Registro de movimiento financiero: palabra monto [descripcion]
    const monto = parseFloat((partes[1] ?? "").replace(/[.,]/g, ""));
    const descripcion = partes.slice(2).join(" ") || null;
    if (isNaN(monto) || monto <= 0) {
      await reply(`No entendí. Formato:\n<code>palabra monto [descripción]</code>\n\nEj: <code>almuerzo 8500 con los cabros</code>\n\n/help para ver todo.`);
      return new Response("ok");
    }

    const palabra = normalizar(partes[0]);
    const { data: dicRows } = await supabase.from("diccionario").select("*").eq("palabra", palabra).limit(1);
    const dic = dicRows && dicRows[0];

    let esfera = "personal", tipo = "gasto", categoria = "otros", clasificado = true;
    if (dic) { esfera = dic.esfera; tipo = dic.tipo; categoria = dic.categoria; }
    else {
      clasificado = false;
      const { data: pend } = await supabase.from("palabras_pendientes").select("*").eq("palabra", palabra).limit(1);
      if (pend && pend[0]) { await supabase.from("palabras_pendientes").update({ veces: pend[0].veces + 1, ultima_vez: new Date().toISOString() }).eq("palabra", palabra); }
      else { await supabase.from("palabras_pendientes").insert({ palabra }); }
    }

    let retencion = 0;
    if (esfera === "uber" && tipo === "ingreso" && categoria === "uber") { retencion = Math.round(monto * RETENCION_UBER); }
    const neto = tipo === "ingreso" ? monto - retencion : monto;

    await supabase.from("finanzas").insert({ fecha: hoyChile(), esfera, tipo, categoria, palabra, descripcion, monto_clp: monto, retencion_clp: retencion, neto_clp: neto, clasificado });

    let respuesta = `${tipo === "ingreso" ? "🟢" : "🔴"} <b>${palabra}</b> ${clp(monto)}\n${esfera} · ${categoria}` + (descripcion ? `\n"${descripcion}"` : "");
    if (retencion > 0) respuesta += `\n\nRetención SII (15,25%): -${clp(retencion)}\n<b>Neto: ${clp(neto)}</b>`;
    if (!clasificado) respuesta += `\n\n⚠️ Palabra nueva, guardada en <i>otros</i>.\nUsa /pendientes para clasificarla.`;

    await reply(respuesta);
    return new Response("ok");
  } catch (err) {
    console.error("Webhook error:", err.message);
    await reply(`⚠️ Error: ${err.message}`);
    return new Response("ok");
  }
};
