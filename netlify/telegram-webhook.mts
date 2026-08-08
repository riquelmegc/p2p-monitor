import { createClient } from "@supabase/supabase-js";

// ============================================================
// Bot conversacional: finanzas personales + contrapartes P2P
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET!;

// Retencion SII para conductores de plataformas (vigente 2026)
const RETENCION_UBER = 0.1525;

async function reply(text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
    }),
  });
}

function clp(n: number): string {
  return "$" + Math.round(Number(n)).toLocaleString("es-CL");
}

function hoyChile(): string {
  return new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
}

// Normaliza: minusculas, sin acentos, sin guiones ni espacios
function normalizar(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[-_\s]/g, "");
}

function limiteSugerido(ops: number): number {
  if (ops <= 0) return 250000;
  if (ops <= 3) return 500000;
  if (ops <= 9) return 1000000;
  return 2000000;
}

const AYUDA =
  "🤖 <b>Cómo usarme</b>\n\n" +
  "<b>Registrar movimientos</b> (sin comandos):\n" +
  "  <code>uber 200000</code>\n" +
  "  <code>super 45000 compre para la casa</code>\n" +
  "  <code>bencina 25000 turno tarde</code>\n\n" +
  "<b>Consultas:</b>\n" +
  "  /hoy — movimientos de hoy\n" +
  "  /mes — balance del mes por esfera\n" +
  "  /uber — ganancia neta manejando\n" +
  "  /pendientes — palabras sin clasificar\n" +
  "  /agregar palabra esfera tipo categoria\n\n" +
  "<b>Contrapartes P2P:</b>\n" +
  "  /check nickname\n" +
  "  /reg nickname monto [banco]\n" +
  "  /bloquear nickname motivo\n" +
  "  /ok nickname\n" +
  "  /top";

export default async (req: Request) => {
  // Seguridad: solo Telegram con el secreto correcto
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  const msg = update?.message;
  if (!msg?.text) return new Response("ok");

  // Seguridad: solo tu chat
  if (String(msg.chat?.id) !== String(TELEGRAM_CHAT_ID)) {
    return new Response("ok");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const partes = msg.text.trim().split(/\s+/);
  const primera = partes[0].toLowerCase().split("@")[0];

  try {
    // ============ COMANDOS ============

    if (primera === "/start" || primera === "/help" || primera === "/ayuda") {
      await reply(AYUDA);
      return new Response("ok");
    }

    if (primera === "/hoy") {
      const { data } = await supabase
        .from("finanzas")
        .select("*")
        .eq("fecha", hoyChile())
        .order("id", { ascending: false });

      if (!data?.length) {
        await reply("No hay movimientos registrados hoy.");
        return new Response("ok");
      }

      const lineas = data.map(
        (m: any) =>
          `${m.tipo === "ingreso" ? "🟢" : "🔴"} ${m.palabra} ${clp(m.monto_clp)}` +
          (m.descripcion ? ` — ${m.descripcion}` : "")
      );
      const ing = data.filter((m: any) => m.tipo === "ingreso")
        .reduce((s: number, m: any) => s + Number(m.monto_clp), 0);
      const gas = data.filter((m: any) => m.tipo === "gasto")
        .reduce((s: number, m: any) => s + Number(m.monto_clp), 0);

      await reply(
        `📅 <b>Hoy</b>\n\n${lineas.join("\n")}\n\n` +
          `Ingresos: ${clp(ing)}\nGastos: ${clp(gas)}\n` +
          `<b>Balance: ${clp(ing - gas)}</b>`
      );
      return new Response("ok");
    }

    if (primera === "/mes") {
      const desde = hoyChile().slice(0, 8) + "01";
      const { data } = await supabase
        .from("finanzas")
        .select("esfera,tipo,monto_clp,retencion_clp")
        .gte("fecha", desde);

      const lista = data ?? [];
      if (!lista.length) {
        await reply("No hay movimientos este mes.");
        return new Response("ok");
      }

      const esferas = ["personal", "uber", "p2p"];
      const bloques = esferas.map((e) => {
        const f = lista.filter((m: any) => m.esfera === e);
        const ing = f.filter((m: any) => m.tipo === "ingreso")
          .reduce((s: number, m: any) => s + Number(m.monto_clp), 0);
        const gas = f.filter((m: any) => m.tipo === "gasto")
          .reduce((s: number, m: any) => s + Number(m.monto_clp), 0);
        const ret = f.reduce((s: number, m: any) => s + Number(m.retencion_clp), 0);
        return (
          `<b>${e.toUpperCase()}</b>\n` +
          `  Ingresos: ${clp(ing)}\n` +
          (ret > 0 ? `  Retención: -${clp(ret)}\n` : "") +
          `  Gastos: ${clp(gas)}\n` +
          `  Balance: <b>${clp(ing - ret - gas)}</b>`
        );
      });

      const totalIng = lista.filter((m: any) => m.tipo === "ingreso")
        .reduce((s: number, m: any) => s + Number(m.monto_clp), 0);
      const totalGas = lista.filter((m: any) => m.tipo === "gasto")
        .reduce((s: number, m: any) => s + Number(m.monto_clp), 0);
      const totalRet = lista.reduce((s: number, m: any) => s + Number(m.retencion_clp), 0);

      await reply(
        `📊 <b>Mes actual</b>\n\n${bloques.join("\n\n")}\n\n` +
          `━━━━━━━━\n<b>TOTAL: ${clp(totalIng - totalRet - totalGas)}</b>`
      );
      return new Response("ok");
    }

    if (primera === "/uber") {
      const desde = hoyChile().slice(0, 8) + "01";
      const { data } = await supabase
        .from("finanzas")
        .select("tipo,categoria,monto_clp,retencion_clp")
        .eq("esfera", "uber")
        .gte("fecha", desde);

      const lista = data ?? [];
      const bruto = lista.filter((m: any) => m.tipo === "ingreso")
        .reduce((s: number, m: any) => s + Number(m.monto_clp), 0);
      const ret = lista.reduce((s: number, m: any) => s + Number(m.retencion_clp), 0);
      const gastos = lista.filter((m: any) => m.tipo === "gasto")
        .reduce((s: number, m: any) => s + Number(m.monto_clp), 0);

      const porCat: Record<string, number> = {};
      for (const m of lista.filter((x: any) => x.tipo === "gasto")) {
        porCat[m.categoria] = (porCat[m.categoria] ?? 0) + Number(m.monto_clp);
      }
      const detalle = Object.entries(porCat)
        .map(([c, v]) => `  ${c}: ${clp(v)}`)
        .join("\n");

      await reply(
        `🚗 <b>Uber — mes actual</b>\n\n` +
          `Bruto: ${clp(bruto)}\n` +
          `Retención SII (15,25%): -${clp(ret)}\n` +
          `Gastos:\n${detalle || "  (sin gastos)"}\n` +
          `Total gastos: -${clp(gastos)}\n\n` +
          `<b>GANANCIA REAL: ${clp(bruto - ret - gastos)}</b>`
      );
      return new Response("ok");
    }

    if (primera === "/pendientes") {
      const { data } = await supabase
        .from("palabras_pendientes")
        .select("*")
        .order("veces", { ascending: false });

      if (!data?.length) {
        await reply("No hay palabras pendientes. Todo clasificado ✅");
        return new Response("ok");
      }

      const lineas = data.map((p: any) => `• <b>${p.palabra}</b> (${p.veces} veces)`);
      await reply(
        `⚠️ <b>Palabras sin clasificar</b>\n\n${lineas.join("\n")}\n\n` +
          `Para agregar:\n<code>/agregar palabra esfera tipo categoria</code>\n` +
          `Ej: <code>/agregar peluqueria personal gasto cuidado</code>`
      );
      return new Response("ok");
    }

    if (primera === "/agregar") {
      const [, pal, esf, tip, cat] = partes;
      if (!pal || !esf || !tip || !cat) {
        await reply(
          "Uso: <code>/agregar palabra esfera tipo categoria</code>\n" +
            "esfera: personal | uber | p2p\n" +
            "tipo: ingreso | gasto"
        );
        return new Response("ok");
      }
      const p = normalizar(pal);
      await supabase.from("diccionario").upsert({
        palabra: p,
        esfera: esf.toLowerCase(),
        tipo: tip.toLowerCase(),
        categoria: cat.toLowerCase(),
      });
      await supabase.from("palabras_pendientes").delete().eq("palabra", p);
      await reply(`✅ Agregada: <b>${p}</b> → ${esf}/${tip}/${cat}`);
      return new Response("ok");
    }

    // ============ CONTRAPARTES ============

    if (primera === "/check") {
      const nick = partes[1];
      if (!nick) {
        await reply("Uso: <b>/check</b> nickname");
        return new Response("ok");
      }
      const { data: rows } = await supabase
        .from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];

      if (!c) {
        await reply(
          `🔴 <b>NUEVO</b> — ${nick}\n\nSin historial.\n` +
            `Límite máximo: <b>${clp(250000)}</b>\n\n` +
            `⚠️ Verificar que el pago venga de cuenta a su nombre.`
        );
      } else if (c.confiable === false) {
        await reply(
          `⛔ <b>BLOQUEADO</b> — ${c.nickname}\n\nMotivo: ${c.notas ?? "sin nota"}\n\n<b>NO OPERAR</b>`
        );
      } else {
        await reply(
          `🟢 <b>CONOCIDO</b> — ${c.nickname}\n\n` +
            `Operaciones: <b>${c.total_operaciones}</b>\n` +
            `Acumulado: ${clp(c.monto_acumulado_clp)}\n` +
            `Última: ${c.ultima_operacion ?? "-"}\n` +
            (c.banco ? `Banco: ${c.banco}\n` : "") +
            `\nLímite sugerido: <b>${clp(limiteSugerido(c.total_operaciones))}</b>`
        );
      }
      return new Response("ok");
    }

    if (primera === "/reg") {
      const nick = partes[1];
      const monto = parseFloat(partes[2] ?? "");
      const banco = partes.slice(3).join(" ") || null;
      if (!nick || isNaN(monto) || monto <= 0) {
        await reply("Uso: <code>/reg nickname monto [banco]</code>");
        return new Response("ok");
      }
      const { data: rows } = await supabase
        .from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];

      if (c) {
        const ops = c.total_operaciones + 1;
        const acum = Number(c.monto_acumulado_clp) + monto;
        await supabase.from("contrapartes").update({
          total_operaciones: ops,
          monto_acumulado_clp: acum,
          ultima_operacion: hoyChile(),
          banco: banco ?? c.banco,
        }).eq("id", c.id);
        await reply(
          `✅ <b>Registrado</b> — ${c.nickname}\n` +
            `Operaciones: ${ops}\nAcumulado: ${clp(acum)}\n` +
            `Nuevo límite: <b>${clp(limiteSugerido(ops))}</b>`
        );
      } else {
        await supabase.from("contrapartes").insert({
          nickname: nick, banco,
          total_operaciones: 1,
          monto_acumulado_clp: monto,
          ultima_operacion: hoyChile(),
        });
        await reply(`✅ <b>Nueva contraparte</b> — ${nick}\nPrimera operación: ${clp(monto)}`);
      }
      return new Response("ok");
    }

    if (primera === "/bloquear") {
      const nick = partes[1];
      const motivo = partes.slice(2).join(" ") || "sin motivo";
      if (!nick) {
        await reply("Uso: <code>/bloquear nickname motivo</code>");
        return new Response("ok");
      }
      const { data: rows } = await supabase
        .from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];
      if (c) {
        await supabase.from("contrapartes")
          .update({ confiable: false, notas: motivo }).eq("id", c.id);
      } else {
        await supabase.from("contrapartes")
          .insert({ nickname: nick, confiable: false, notas: motivo });
      }
      await reply(`⛔ <b>Bloqueado</b> — ${nick}\nMotivo: ${motivo}`);
      return new Response("ok");
    }

    if (primera === "/ok") {
      const nick = partes[1];
      if (!nick) {
        await reply("Uso: <code>/ok nickname</code>");
        return new Response("ok");
      }
      const { data: rows } = await supabase
        .from("contrapartes").select("*").ilike("nickname", nick).limit(1);
      const c = rows && rows[0];
      if (!c) {
        await reply(`No encontré a ${nick}`);
        return new Response("ok");
      }
      await supabase.from("contrapartes")
        .update({ confiable: true, notas: null }).eq("id", c.id);
      await reply(`🟢 <b>Desbloqueado</b> — ${c.nickname}`);
      return new Response("ok");
    }

    if (primera === "/top") {
      const { data } = await supabase
        .from("contrapartes")
        .select("nickname,total_operaciones,monto_acumulado_clp")
        .eq("confiable", true)
        .order("total_operaciones", { ascending: false })
        .limit(10);
      if (!data?.length) {
        await reply("Aún no hay contrapartes registradas.");
        return new Response("ok");
      }
      const lineas = data.map(
        (c: any, i: number) =>
          `${i + 1}. <b>${c.nickname}</b> — ${c.total_operaciones} ops · ${clp(c.monto_acumulado_clp)}`
      );
      await reply(`🏆 <b>Mejores clientes</b>\n\n${lineas.join("\n")}`);
      return new Response("ok");
    }

    // Comando desconocido
    if (primera.startsWith("/")) {
      await reply(`No conozco ese comando.\n\n${AYUDA}`);
      return new Response("ok");
    }

    // ============ REGISTRO DE MOVIMIENTO ============
    // Formato: palabra monto [descripcion opcional]

    const palabraRaw = partes[0];
    const monto = parseFloat((partes[1] ?? "").replace(/[.,]/g, ""));
    const descripcion = partes.slice(2).join(" ") || null;

    if (isNaN(monto) || monto <= 0) {
      await reply(
        `No entendí. Formato:\n<code>palabra monto [descripción]</code>\n\n` +
          `Ej: <code>almuerzo 8500 con los cabros</code>\n\n` +
          `Escribe /help para ver todo.`
      );
      return new Response("ok");
    }

    const palabra = normalizar(palabraRaw);

    // Buscar en diccionario
    const { data: dicRows } = await supabase
      .from("diccionario").select("*").eq("palabra", palabra).limit(1);
    const dic = dicRows && dicRows[0];

    let esfera = "personal";
    let tipo = "gasto";
    let categoria = "otros";
    let clasificado = true;

    if (dic) {
      esfera = dic.esfera;
      tipo = dic.tipo;
      categoria = dic.categoria;
    } else {
      clasificado = false;
      // Registrar la palabra como pendiente
      const { data: pend } = await supabase
        .from("palabras_pendientes").select("*").eq("palabra", palabra).limit(1);
      if (pend && pend[0]) {
        await supabase.from("palabras_pendientes")
          .update({ veces: pend[0].veces + 1, ultima_vez: new Date().toISOString() })
          .eq("palabra", palabra);
      } else {
        await supabase.from("palabras_pendientes").insert({ palabra });
      }
    }

    // Retencion solo para ingresos de Uber
    let retencion = 0;
    if (esfera === "uber" && tipo === "ingreso" && categoria === "uber") {
      retencion = Math.round(monto * RETENCION_UBER);
    }
    const neto = tipo === "ingreso" ? monto - retencion : monto;

    await supabase.from("finanzas").insert({
      fecha: hoyChile(),
      esfera, tipo, categoria,
      palabra,
      descripcion,
      monto_clp: monto,
      retencion_clp: retencion,
      neto_clp: neto,
      clasificado,
    });

    const icono = tipo === "ingreso" ? "🟢" : "🔴";
    let respuesta =
      `${icono} <b>${palabra}</b> ${clp(monto)}\n` +
      `${esfera} · ${categoria}` +
      (descripcion ? `\n"${descripcion}"` : "");

    if (retencion > 0) {
      respuesta +=
        `\n\nRetención SII (15,25%): -${clp(retencion)}\n` +
        `<b>Neto: ${clp(neto)}</b>`;
    }

    if (!clasificado) {
      respuesta +=
        `\n\n⚠️ Palabra nueva, guardada en <i>otros</i>.\n` +
        `Usa /pendientes para clasificarla después.`;
    }

    await reply(respuesta);
    return new Response("ok");
  } catch (err: any) {
    console.error("Webhook error:", err.message);
    await reply(`⚠️ Error: ${err.message}`);
    return new Response("ok");
  }
};
