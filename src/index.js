import express from 'express';
import { handleMessage } from './bot.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => res.send('carol.bot activo'));

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const message = req.body.Body;
  try {
    const reply = await handleMessage(from, message);
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
  } catch (err) {
    console.error('Error:', err);
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>Error, intentá de nuevo</Message></Response>`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`carol.bot escuchando en puerto ${PORT}`);
});
