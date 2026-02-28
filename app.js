const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

/**
 * 🔹 Verificación del webhook (Meta GET)
 */
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

/**
 * 🔹 Recepción de mensajes
 */
app.post('/', async (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message) {
      const from = message.from;
      const text = message.text?.body || "";

      console.log("Mensaje:", text);

      const response = handleMessage(text, from);

      await sendWhatsAppMessage(from, response);
    }

    res.status(200).end();

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    res.status(500).end();
  }
});

/**
 * 🔹 Lógica básica del bot (MVP demo)
 */
function handleMessage(text, from) {
  const lower = text.toLowerCase();

  if (lower.includes("hola")) {
    return `👋 Hola, soy el asistente del Taller Diesel X.
¿En qué puedo ayudarte?

1️⃣ Consultar repuesto
2️⃣ Agendar cita
3️⃣ Hablar con asesor`;
  }

  if (lower.includes("stock")) {
    return `📦 Stock actual:
🔩 Inyector NPR 2014
Cantidad disponible: 3 unidades (Demo MVP)`;
  }

  if (lower.includes("inyector")) {
    return `🔩 Inyector Isuzu NPR 2014
💲 Precio: $120
📦 Stock: 3 unidades
¿Desea apartarlo o instalarlo?`;
  }

  return "Gracias por tu mensaje. Un asesor te responderá pronto 👨‍🔧";
}

/**
 * 🔹 Enviar mensaje usando Cloud API
 */
async function sendWhatsAppMessage(to, message) {
  const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: message }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});