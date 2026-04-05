import { appendToSheet, getDailySummary } from './sheets.js';
import { getUserState, setUserState } from './state.js';

const OR_KEY = process.env.OPENROUTER_API_KEY;

const CAROL = {
  tdee_kcal: 2100, meta_prot_g: 120, meta_carb_g: 220,
  meta_gras_g: 65, meta_agua_ml: 2500,
};

const SYSTEM = `Sos el asistente nutricional personal de Carol, atleta argentina que hace running, ciclismo y gym.
Metas diarias: proteina ${CAROL.meta_prot_g}g, carbos ${CAROL.meta_carb_g}g, grasas ${CAROL.meta_gras_g}g, agua ${CAROL.meta_agua_ml}ml, TDEE ${CAROL.tdee_kcal} kcal.
Cuando describe una comida o manda una foto, estimas los macros y confirmas el registro.
Si recibis una imagen, analizas lo que ves y estimas la comida.
Responde en español, tono calido y directo, sin markdown ni asteriscos.
Formato al registrar:
✓ [Alimento] registrado
📊 ~[kcal] kcal | P: [g]g | C: [g]g | G: [g]g
[Comentario breve si aplica]`;

const EXTRACT_SYSTEM = `Extrae datos nutricionales y devuelve SOLO JSON sin explicaciones ni markdown.
Comida: {"tipo":"comida","datos":[{"alimento":"nombre","gramos":null,"kcal":0,"proteina_g":0,"carbos_g":0,"grasas_g":0,"comida":"desayuno|almuerzo|merienda|cena|snack"}]}
Agua: {"tipo":"agua","ml":0}
Sueno: {"tipo":"sueno","horas":0}
Energia: {"tipo":"energia","nivel":"alta|media|baja"}
Ciclo: {"tipo":"ciclo","fase":"menstruacion|folicular|ovulacion|lutea"}
Nada: {"tipo":"ninguno"}
Solo JSON, nada mas.`;

async function callAI(messages, maxTokens = 400, needsVision = false) {
  // Para imágenes usar modelo con visión, sino usar auto
  const model = needsVision ? 'google/gemini-flash-1.5:free' : 'openrouter/auto';
  
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
      'HTTP-Referer': 'https://botnutri-z3la.onrender.com',
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.choices?.[0]?.message?.content || '';
}

export async function handleMessage(from, message, mediaUrl = null) {
  const msg = message.trim().toLowerCase();

  if (msg.includes('resumen') || msg.includes('como voy') || msg === 'hoy') {
    return await buildDailySummary(from);
  }
  if (msg === 'ayuda' || msg === 'help') {
    return 'Comandos:\nComida: "comi dos huevos con tostada"\nFoto: manda una imagen de tu comida\nAgua: "tome 500ml de agua"\nSueno: "dormi 7.5 horas"\nEnergia: "energia alta/media/baja"\nResumen: "resumen hoy"';
  }

  const state = getUserState(from);
  
  // Construir el mensaje con o sin imagen
  let userContent;
  if (mediaUrl) {
    userContent = [
      { type: 'image_url', image_url: { url: mediaUrl } },
      { type: 'text', text: message || 'Que es esta comida? Registrala.' },
    ];
  } else {
    userContent = message;
  }

  const messages = [
    { role: 'system', content: SYSTEM },
    ...state.history.slice(-8).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userContent },
  ];

  const reply = await callAI(messages, 400, !!mediaUrl);

  state.history.push({ role: 'user', content: message || '[imagen]' });
  state.history.push({ role: 'assistant', content: reply });
  if (state.history.length > 12) state.history = state.history.slice(-12);
  setUserState(from, state);

  // Guardar en sheet
  try {
    await extractAndSave(from, message || 'foto de comida', reply, state);
  } catch(e) {
    console.error('Error guardando en Sheet:', e.message);
  }

  return reply;
}

async function extractAndSave(from, userMessage, botReply, state) {
  const hora = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const messages = [
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: `Hora: ${hora}\nUsuario: "${userMessage}"\nBot: "${botReply}"` },
  ];
  const raw = await callAI(messages, 300);
  let data;
  try { data = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch(e) {
    console.error('JSON parse error:', raw);
    return;
  }
  if (!data || data.tipo === 'ninguno') return;

  const now = new Date();
  const fecha = now.toLocaleDateString('es-AR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const horaR = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

  if (data.tipo === 'comida' && data.datos?.length) {
    for (const item of data.datos) {
      await appendToSheet({
        fecha, hora: horaR, comida: item.comida || 'sin clasificar',
        alimento: item.alimento || '', gramos: item.gramos || '',
        kcal: item.kcal || 0, proteina: item.proteina_g || 0,
        carbos: item.carbos_g || 0, grasas: item.grasas_g || 0,
        agua_ml: '', fase_ciclo: state.fase_ciclo || '',
        energia: state.energia || '', sueno_h: state.sueno_h || '', nota: '',
      });
    }
    console.log('Guardado en Sheet:', data.datos.map(d => d.alimento).join(', '));
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
    if (!summary || summary.kcal === 0) return 'Todavia no registraste nada hoy 🥗\nContame que comiste o manda una foto!';
    const restante = CAROL.tdee_kcal - summary.kcal;
    let msg = `Resumen de hoy 📋\n\nCalorias: ${Math.round(summary.kcal)} / ${CAROL.tdee_kcal} kcal\nProteina: ${Math.round(summary.proteina)}g / ${CAROL.meta_prot_g}g\nCarbos: ${Math.round(summary.carbos)}g\nGrasas: ${Math.round(summary.grasas)}g\n`;
    if (summary.agua > 0) msg += `Agua: ${Math.round(summary.agua)}ml\n`;
    if (state.sueno_h) msg += `Sueno: ${state.sueno_h}h\n`;
    msg += restante > 0 ? `\nTe quedan ~${Math.round(restante)} kcal.` : `\nMeta calorica alcanzada ✓`;
    return msg;
  } catch(e) {
    console.error('Error summary:', e.message);
    return 'No pude obtener el resumen. Intenta de nuevo.';
  }
}
