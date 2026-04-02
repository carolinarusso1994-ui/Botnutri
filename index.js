import { appendToSheet, getDailySummary } from './sheets.js';
import { getUserState, setUserState } from './state.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;

// ── Perfil de Carol (editá estos valores) ──────────────────────────
const CAROL = {
  nombre:       'Carol',
  edad:         30,
  peso_kg:      60,
  objetivo:     'rendimiento deportivo y salud hormonal',
  tdee_kcal:    2100,
  meta_prot_g:  120,
  meta_carb_g:  220,
  meta_gras_g:  65,
  meta_agua_ml: 2500,
  restricciones:'ninguna',
};

const SYSTEM = `Sos el asistente nutricional personal de ${CAROL.nombre}, integrado a su dashboard de salud y Strava.

PERFIL:
- Edad: ${CAROL.edad} años | Peso: ${CAROL.peso_kg}kg
- Objetivo: ${CAROL.objetivo}
- TDEE: ${CAROL.tdee_kcal} kcal/día
- Metas diarias: proteína ${CAROL.meta_prot_g}g | carbos ${CAROL.meta_carb_g}g | grasas ${CAROL.meta_gras_g}g | agua ${CAROL.meta_agua_ml}ml
- Restricciones: ${CAROL.restricciones}

ROL:
Registrás lo que Carol come de forma conversacional. Cuando describe una comida estimás los macros y confirmás el registro.

COMANDOS:
- "resumen hoy" / "cómo voy" → resumen del día
- "tomé agua Xml" → registrás hidratación
- "dormí X horas" → registrás sueño
- "energía alta/media/baja" → registrás energía
- "fase folicular/lútea/ovulación/menstruación" → registrás fase
- "ayuda" → mostrás comandos

REGLAS:
1. Respondé en español, tono cálido, conciso.
2. Siempre confirmá el registro con los macros estimados.
3. Si no sabés la porción, asumí una estándar y avisalo.
4. Emojis con moderación.
5. Estimá rangos realistas, no valores exactos inventados.
6. Si es ambiguo, preguntá UNA sola cosa.

FORMATO al registrar comida:
✓ [Alimento] registrado
📊 ~[kcal] kcal | P: [g]g | C: [g]g | G: [g]g
[Comentario breve si aplica]

IMPORTANTE: Solo texto para WhatsApp. Sin markdown ni asteriscos.`;

const EXTRACT_SYSTEM = `Extraés datos nutricionales de mensajes y devolvés JSON puro sin explicaciones ni markdown.

Comida: {"tipo":"comida","datos":[{"alimento":"nombre","gramos":null,"kcal":0,"proteina_g":0,"carbos_g":0,"grasas_g":0,"comida":"desayuno|almuerzo|merienda|cena|snack"}]}
Agua:   {"tipo":"agua","ml":0}
Sueño:  {"tipo":"sueno","horas":0}
Energía:{"tipo":"energia","nivel":"alta|media|baja"}
Ciclo:  {"tipo":"ciclo","fase":"menstruacion|folicular|ovulacion|lutea"}
Nada:   {"tipo":"ninguno"}

Solo JSON, nada más.`;

// ── Llamada a Gemini ───────────────────────────────────────────────
async function gemini(systemInstruction, contents, maxTokens = 600) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Handler principal ──────────────────────────────────────────────
export async function handleMessage(from, message) {
  const msg = message.trim().toLowerCase();

  if (msg.includes('resumen') || msg.includes('cómo voy') || msg.includes('como voy') || msg === 'hoy') {
    return await buildDailySummary(from);
  }
  if (msg === 'ayuda' || msg === 'help') {
    return buildHelp();
  }

  const state = getUserState(from);

  // Construir historial para Gemini
  const contents = [
    ...state.history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const reply = await gemini(SYSTEM, contents, 600);

  // Actualizar historial (máx 12 turnos)
  state.history.push({ role: 'user',      content: message });
  state.history.push({ role: 'assistant', content: reply   });
  if (state.history.length > 12) state.history = state.history.slice(-12);
  setUserState(from, state);

  // Extraer y guardar en Sheets
  await extractAndSave(from, message, reply, state);

  return reply;
}

// ── Extracción de datos estructurados ─────────────────────────────
async function extractAndSave(from, userMessage, botReply, state) {
  try {
    const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    const raw = await gemini(
      EXTRACT_SYSTEM,
      [{ role: 'user', parts: [{ text: `Hora: ${hora}\nUsuario: "${userMessage}"\nBot: "${botReply}"` }] }],
      400
    );

    // Limpiar posibles backticks que Gemini a veces agrega
    const clean = raw.replace(/```json|```/g, '').trim();
    const data  = JSON.parse(clean);

    if (data.tipo === 'ninguno') return;

    const now   = new Date();
    const fecha = now.toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const horaR = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

    if (data.tipo === 'comida' && data.datos?.length) {
      for (const item of data.datos) {
        await appendToSheet({
          fecha,
          hora:       horaR,
          comida:     item.comida     || 'sin clasificar',
          alimento:   item.alimento   || '',
          gramos:     item.gramos     || '',
          kcal:       item.kcal       || 0,
          proteina:   item.proteina_g || 0,
          carbos:     item.carbos_g   || 0,
          grasas:     item.grasas_g   || 0,
          agua_ml:    '',
          fase_ciclo: state.fase_ciclo || '',
          energia:    state.energia    || '',
          sueno_h:    state.sueno_h    || '',
          nota:       '',
        });
      }
    } else if (data.tipo === 'agua') {
      state.agua_ml = (state.agua_ml || 0) + data.ml;
      setUserState(from, state);
      await appendToSheet({
        fecha, hora: horaR, comida: 'hidratación', alimento: 'agua',
        gramos: '', kcal: 0, proteina: 0, carbos: 0, grasas: 0,
        agua_ml: data.ml,
        fase_ciclo: state.fase_ciclo || '', energia: '', sueno_h: '', nota: '',
      });
    } else if (data.tipo === 'sueno') {
      state.sueno_h = data.horas;
      setUserState(from, state);
    } else if (data.tipo === 'energia') {
      state.energia = data.nivel;
      setUserState(from, state);
    } else if (data.tipo === 'ciclo') {
      state.fase_ciclo = data.fase;
      setUserState(from, state);
    }

  } catch (e) {
    console.error('Error extrayendo datos:', e.message);
  }
}

// ── Resumen diario ─────────────────────────────────────────────────
async function buildDailySummary(from) {
  try {
    const summary = await getDailySummary();
    const state   = getUserState(from);

    if (!summary || summary.kcal === 0) {
      return 'Todavía no registraste nada hoy. Contame qué comiste 🥗';
    }

    const pctKcal = Math.round((summary.kcal / CAROL.tdee_kcal) * 100);
    const pctProt = Math.round((summary.proteina / CAROL.meta_prot_g) * 100);

    let msg = `Resumen de hoy 📋\n\n`;
    msg += `Calorías: ${Math.round(summary.kcal)} / ${CAROL.tdee_kcal} kcal (${pctKcal}%)\n`;
    msg += `Proteína: ${Math.round(summary.proteina)}g / ${CAROL.meta_prot_g}g (${pctProt}%)\n`;
    msg += `Carbos:   ${Math.round(summary.carbos)}g\n`;
    msg += `Grasas:   ${Math.round(summary.grasas)}g\n`;
    if (summary.agua > 0) msg += `Agua:     ${Math.round(summary.agua)}ml / ${CAROL.meta_agua_ml}ml\n`;
    if (state.sueno_h)    msg += `Sueño:    ${state.sueno_h}h\n`;

    const restante = CAROL.tdee_kcal - summary.kcal;
    msg += restante > 0
      ? `\nTe quedan ~${Math.round(restante)} kcal para el día.`
      : `\nAlcanzaste tu meta calórica del día ✓`;

    return msg;
  } catch {
    return 'No pude obtener el resumen. Revisá la conexión con Sheets.';
  }
}

// ── Ayuda ──────────────────────────────────────────────────────────
function buildHelp() {
  return [
    'Comandos disponibles:',
    '',
    'Registrar comida: describí lo que comiste',
    '"comí dos huevos con tostada"',
    '"almorcé 200g de pollo con arroz"',
    '',
    'Agua:    "tomé 500ml de agua"',
    'Sueño:   "dormí 7.5 horas"',
    'Energía: "energía alta / media / baja"',
    'Fase:    "fase folicular / lútea"',
    '',
    'Resumen: "resumen hoy" o "cómo voy"',
    '',
    'No hace falta ser exacta, el bot entiende lenguaje natural 🙌',
  ].join('\n');
}
