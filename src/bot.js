import { appendToSheet, getDailySummary } from './sheets.js';
import { getUserState, setUserState } from './state.js';

const OR_KEY = process.env.OPENROUTER_API_KEY;
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Lista de modelos gratuitos — prueba en orden hasta que uno funcione
const FREE_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat:free',
  'google/gemma-3-27b-it:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'microsoft/phi-4:free',
];

const CAROL = {
  tdee_kcal:    2100,
  meta_prot_g:  120,
  meta_carb_g:  220,
  meta_gras_g:  65,
  meta_agua_ml: 2500,
};

const SYSTEM = `Sos el asistente nutricional de Carol, atleta argentina (running, ciclismo, gym).
Metas diarias: proteína ${CAROL.meta_prot_g}g, carbos ${CAROL.meta_carb_g}g, grasas ${CAROL.meta_gras_g}g, agua ${CAROL.meta_agua_ml}ml, ${CAROL.tdee_kcal} kcal.

Cuando Carol describe una comida, estimás los macros y confirmás el registro.
Respondé en español, tono cálido, sin markdown ni asteriscos.
Formato al registrar:
✓ [Alimento] registrado
📊 ~[kcal] kcal | P: [g]g | C: [g]g | G: [g]g`;

const EXTRACT_SYSTEM = `Extraé datos nutricionales y devolvé SOLO JSON sin explicaciones ni markdown.
Comida: {"tipo":"comida","datos":[{"alimento":"nombre","gramos":null,"kcal":0,"proteina_g":0,"carbos_g":0,"grasas_g":0,"comida":"desayuno|almuerzo|merienda|cena|snack"}]}
Agua: {"tipo":"agua","ml":0}
Sueno: {"tipo":"sueno","horas":0}
Energia: {"tipo":"energia","nivel":"alta|media|baja"}
Ciclo: {"tipo":"ciclo","fase":"menstruacion|folicular|ovulacion|lutea"}
Nada: {"tipo":"ninguno"}`;

async function callAI(messages, maxTokens = 600) {
  let lastError = null;
  for (const model of FREE_MODELS) {
    try {
      const res = await fetch(OR_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OR_KEY}`,
          'HTTP-Referer': 'https://botnutri-z3la.onrender.com',
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 }),
      });
      const data = await res.json();
      if (data.error) {
        lastError = data.error.message;
        console.log(`Modelo ${model} falló: ${lastError}`);
        continue;
      }
      const text = data.choices?.[0]?.message?.content;
      if (text) {
        console.log(`Modelo ${model} OK`);
        return text;
      }
    } catch (e) {
      lastError = e.message;
      console.log(`Modelo ${model} error: ${lastError}`);
    }
  }
  throw new Error(`Todos los modelos fallaron. Último error: ${lastError}`);
}

export async function handleMessage(from, message) {
  const msg = message.trim().toLowerCase();

  if (msg.includes('resumen') || msg.includes('como voy') || msg.includes('cómo voy') || msg === 'hoy') {
    return await buildDailySummary(from);
  }
  if (msg === 'ayuda' || msg === 'help') {
    return 'Comandos:\nComida: "comi dos huevos con tostada"\nAgua: "tome 500ml de agua"\nSueno: "dormi 7.5 horas"\nEnergia: "energia alta/media/baja"\nFase: "fase folicular/lutea"\nResumen: "resumen hoy"';
  }

  const state = getUserState(from);
  const messages = [
    { role: 'system', content: SYSTEM },
    ...state.history.slice(-10).map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: message },
  ];

  const reply = await callAI(messages, 400);

  state.history.push({ role: 'user', content: message });
  state.history.push({ role: 'assistant', content: reply });
  if (state.history.length > 12) state.history = state.history.slice(-12);
  setUserState(from, state);

  // Extraer y guardar en Sheets en segundo plano
  extractAndSave(from, message, reply, state).catch(e => console.error('Error guardando:', e.message));

  return reply;
}

async function extractAndSave(from, userMessage, botReply, state) {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const messages = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `Hora: ${hora}\nUsuario: "${userMessage}"\nBot: "${botReply}"` },
  ];

  const raw = await callAI(messages, 300);
  const clean = raw.replace(/```json|```/g, '').trim();
  let data;
  try { data = JSON.parse(clean); } catch { return; }
  if (data.tipo === 'ninguno') return;

  const now = new Date();
  const fecha = now.toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const horaR = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

  if (data.tipo === 'comida' && data.datos?.length) {
    for (const item of data.datos) {
      await appendToSheet({ fecha, hora: horaR, comida: item.comida || 'sin clasificar', alimento: item.alimento || '', gramos: item.gramos || '', kcal: item.kcal || 0, proteina: item.proteina_g || 0, carbos: item.carbos_g || 0, grasas: item.grasas_g || 0, agua_ml: '', fase_ciclo: state.fase_ciclo || '', energia: state.energia || '', sueno_h: state.sueno_h || '', nota: '' });
    }
  } else if (data.tipo === 'agua') {
    state.agua_ml = (state.agua_ml || 0) + data.ml;
    setUserState(from, state);
    await appendToSheet({ fecha, hora: horaR, comida: 'hidratacion', alimento: 'agua', gramos: '', kcal: 0, proteina: 0, carbos: 0, grasas: 0, agua_ml: data.ml, fase_ciclo: state.fase_ciclo || '', energia: '', sueno_h: '', nota: '' });
  } else if (data.tipo === 'sueno') {
    state.sueno_h = data.horas; setUserState(from, state);
  } else if (data.tipo === 'energia') {
    state.energia = data.nivel; setUserState(from, state);
  } else if (data.tipo === 'ciclo') {
    state.fase_ciclo = data.fase; setUserState(from, state);
  }
}

async function buildDailySummary(from) {
  try {
    const summary = await getDailySummary();
    const state = getUserState(from);
    if (!summary || summary.kcal === 0) return 'Todavia no registraste nada hoy. Contame que comiste 🥗';
    const restante = CAROL.tdee_kcal - summary.kcal;
    let msg = `Resumen de hoy 📋\n\nCalorias: ${Math.round(summary.kcal)} / ${CAROL.tdee_kcal} kcal\nProteina: ${Math.round(summary.proteina)}g / ${CAROL.meta_prot_g}g\nCarbos: ${Math.round(summary.carbos)}g\nGrasas: ${Math.round(summary.grasas)}g\n`;
    if (summary.agua > 0) msg += `Agua: ${Math.round(summary.agua)}ml\n`;
    if (state.sueno_h) msg += `Sueno: ${state.sueno_h}h\n`;
    msg += restante > 0 ? `\nTe quedan ~${Math.round(restante)} kcal para el dia.` : `\nAlcanzaste tu meta calorica ✓`;
    return msg;
  } catch { return 'No pude obtener el resumen. Intenta de nuevo.'; }
}
