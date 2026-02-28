const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

/* ===============================
   🗄️ BASE DE DATOS LOCAL (DEMO)
================================ */

const products = [
  {
    id: 1,
    name: "Inyector Isuzu NPR 2014",
    keywords: ["inyector", "npr", "isuzu"],
    price: 120,
    stock: 3
  },
  {
    id: 2,
    name: "Bomba de Inyección Cummins 6BT",
    keywords: ["bomba", "inyeccion", "cummins", "6bt"],
    price: 450,
    stock: 2
  },
  {
    id: 3,
    name: "Turbo Ford F-350 6.0",
    keywords: ["turbo", "ford", "f350"],
    price: 680,
    stock: 1
  }
];

/* ===============================
   👑 CONFIGURACIÓN ADMIN
================================ */

const ADMIN_NUMBER = process.env.ADMIN_NUMBER; // Número del dueño sin +

/* ===============================
   🔐 VERIFICACIÓN WEBHOOK
================================ */

app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

/* ===============================
   📩 RECEPCIÓN MENSAJES
================================ */

app.post('/', async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (message) {
      const from = message.from;
      const text = message.text?.body || "";

      console.log("Mensaje recibido:", text);

      let response;

      if (from === ADMIN_NUMBER) {
        response = handleAdmin(text);
      } else {
        response = handleClient(text);
      }

      await sendWhatsAppMessage(from, response);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

/* ===============================
   🤖 LÓGICA CLIENTE
================================ */

function handleClient(text) {
  const lower = text.toLowerCase();

  if (lower.includes("hola")) {
    return `👋 *Bienvenido a Laboratorio Diesel JVH*
¿En qué podemos ayudarte?

1️⃣ Consultar repuesto
2️⃣ Agendar cita
3️⃣ Hablar con asesor`;
  }

  // Buscar producto
  const foundProduct = products.find(product =>
    product.keywords.some(keyword => lower.includes(keyword))
  );

  if (foundProduct) {
    return `🔧 *${foundProduct.name}*
💰 Precio: *$${foundProduct.price}*
📦 Stock disponible: *${foundProduct.stock} unidades*

¿Desea apartarlo o instalarlo en el taller?`;
  }

  if (lower.includes("cita")) {
    return `📅 Para agendar una cita, por favor envíanos:
• Modelo del vehículo
• Año
• Tipo de servicio requerido`;
  }

  return "Gracias por escribirnos. Un asesor te responderá pronto 👨‍🔧";
}

/* ===============================
   👑 LÓGICA ADMIN
================================ */

function handleAdmin(text) {
  const lower = text.toLowerCase();

  if (lower.includes("stock")) {
    const report = products
      .map(p => `🔩 ${p.name} → ${p.stock} unidades`)
      .join("\n");

    return `📊 *Reporte de Stock Actual:*\n\n${report}`;
  }

  if (lower.includes("ventas")) {
    return "📈 Ventas del día (demo): $1,240";
  }

  return "👑 Modo administrador activo.";
}

/* ===============================
   📤 ENVIAR MENSAJE
================================ */

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
  console.log(`Servidor corriendo en puerto ${port}`);
});