import express from 'express';
import { handleMessage } from './bot.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get('/', (req, res) => res.send('carol.bot activo ✓'));

// Twilio webhook — recibe cada mensaje de WhatsApp
app.post('/webhook', async (req, res) => {
  const from    = req.body.From;   // número del usuario
  const message = req.body.Body;   // texto del mensaje

  console.log(`[${new Date().toLocaleTimeString('es-AR')}] ${from}: ${message}`);

  try {
    const reply = await handleMessage(from, message);
    // Twilio espera TwiML como respuesta
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${reply}</Message>
</Response>`);
  } catch (err) {
    console.error('Error procesando mensaje:', err);
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Ups, algo salió mal. Intentá de nuevo 🙏</Message>
</Response>`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`carol.bot escuchando en puerto ${PORT}`));
