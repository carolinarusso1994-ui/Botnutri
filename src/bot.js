import { appendToSheet, getDailySummary } from './sheets.js';
import { getUserState, setUserState } from './state.js';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;

const CAROL = {
  nombre: 'Carol', edad: 30, peso_kg: 60,
  tdee_kcal: 2100, meta_prot_g: 120, meta_carb_g: 220,
  meta_gras_g: 65, meta_agua_ml: 2500,
};

const SYSTEM = `Sos el asistente nutricional personal de Carol integrado a su dashboard de salud y Strava.
Metas diarias: proteina 120g, carbos 220g, grasas 65g, agua 2500ml, TDEE 2100 kcal.
Cuando Carol describe una comida estimás los macros y confirmás el registro.
Respondé en español, tono cálido, sin markdown ni asteriscos.
Formato al registrar: ✓ [Alimento] registrado\n📊 ~[kcal] kcal | P: [g]g | C: [g]g | G: [g]g`;

const EXTRACT_SYSTEM = `Extraés datos nutricionales y devolvés JSON puro sin explicaciones.
Comida: {"tipo":"comida","datos":[{"alimento":"nombre","gramos":null,"kcal":0,"proteina_g":0,"carbos_g":0,"grasas_g":0,"comida":"desayuno|almuerzo|merienda|cena|snack"}]}
Agua: {"tipo":"agua","ml":0}
Sueno: {"tipo":"sueno","horas":0}
Energia: {"tipo":"energia","nivel":"alta|media|baja"}
Ciclo: {"tipo":"ciclo","fase":"menstruacion|folicular|ovulacion|lutea"}
Nada: {"tipo":"ninguno"}
Solo JSON, nada mas.`;

async function gemini(systemInstruction, contents, maxTokens) {
  const res = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: { maxOutputTokens: maxTokens || 600, temperature: 0.7 },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.candidates[0].content.parts[0].text || '';
}

export async function handleMessage(from, message) {
  const msg = message.trim().toLowerCase();
  if (msg.includes('resumen') || msg.includes('como voy') || msg === 'hoy') {
    return await buildDailySummary(from);
  }
  if (msg === 'ayuda' || msg === 'help') {
    return 'Comandos:\nComida: "comi dos huevos con tostada"\nAgua: "tome 500ml de agua"\nSueno: "dormi 7.5 horas"\nEnergia: "energia alta/media/baja"\nFase: "fase folicular/lutea"\nResumen: "resumen hoy"';
  }
  const state = getUserState(from);
  const contents = [
    ...state.history.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: message }] }
  ];
  const reply = await gemini(SYSTEM, contents, 600);
  state.history.push({ role: 'user', content: message });
  state.history.push({ role: 'assistant', content: reply });
  if (state.history.length > 12) state.history = state.history.slice(-12);
  setUserState(from, state);
  await extractAndSave(from, message, reply, state);
  return reply;
}

async function extractAndSave(from, userMessage, botReply, state) {
  try {
    const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    const raw = await gemini(EXTRACT_SYSTEM, [{ role: 'user', parts: [{ text: `Hora: ${hora}\nUsuario: "${userMessage}"\nBot: "${botReply}"` }] }], 400);
    const data = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (data.tipo === 'ninguno') return;
    const now = new Date();
    const fecha = now.toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const horaR = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    if (data.tipo === 'comida' && data.datos && data.datos.length) {
      for (const item of data.datos) {
        await appendToSheet({ fecha, hora: horaR, comida: item.comida || 'sin clasificar', alimento: item.alimento || '', gramos: item.gramos || '', kcal: item.kcal || 0, proteina: item.proteina_g || 0, carbos: item.carbos_g || 0, grasas: item.grasas_g || 0, agua_ml: '', fase_ciclo: state.fase_ciclo || '', energia: state.energia || '', sueno_h: state.sueno_h || '', nota: '' });
      }
    } else if (data.tipo === 'agua') {
      state.agua_ml = (state.agua_ml || 0) + data.ml;
      setUserState(from, state);
      await appendToSheet({ fecha, hora: horaR, comida: 'hidratacion', alimento: 'agua', gramos: '', kcal: 0, proteina: 0, carbos: 0, grasas: 0, agua_ml: data.ml, fase_ciclo: state.fase_ciclo || '', energia: '', sueno_h: '', nota: '' });
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

async function buildDailySummary(from) {
  try {
    const summary = await getDailySummary();
    const state = getUserState(from);
    if (!summary || summary.kcal === 0) return 'Todavia no registraste nada hoy. Contame que comiste';
    const restante = 2100 - summary.kcal;
    let msg = `Resumen de hoy\n\nCalorias: ${Math.round(summary.kcal)} / 2100 kcal\nProteina: ${Math.round(summary.proteina)}g / 120g\nCarbos: ${Math.round(summary.carbos)}g\nGrasas: ${Math.round(summary.grasas)}g\n`;
    if (summary.agua > 0) msg += `Agua: ${Math.round(summary.agua)}ml\n`;
    if (state.sueno_h) msg += `Sueno: ${state.sueno_h}h\n`;
    msg += restante > 0 ? `\nTe quedan ~${Math.round(restante)} kcal para el dia.` : `\nAlcanzaste tu meta calorica del dia`;
    return msg;
  } catch (e) {
    return 'No pude obtener el resumen.';
  }
}
