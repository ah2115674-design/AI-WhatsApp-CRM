// server.js
require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { MessagingResponse } = require("twilio").twiml;
const { createClient } = require("@supabase/supabase-js");

const app = express();

// 1️⃣ Check Environment Variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ MISSING SUPABASE ENV VARIABLES");
}
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ MISSING OPENAI API KEY");
}

// 2️⃣ Initialize Supabase & OpenAI
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 3️⃣ Middleware
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// 4️⃣ Root route (basic ping)
app.get("/", (req, res) => {
  res.send("Server is alive ✅");
});

// 5️⃣ Test Supabase route
app.get("/test-supabase", async (req, res) => {
  try {
    const { data, error } = await supabase.from("settings").select("*").limit(1);
    if (error) throw error;
    res.json({ status: "Connected to Supabase ✅", data });
  } catch (err) {
    res.status(500).json({ status: "Error", message: err.message });
  }
});

// 6️⃣ Twilio WhatsApp webhook
app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();

  try {
    const incomingMsg = req.body.Body;
    const businessNumber = req.body.To.replace("whatsapp:", "").replace("+", "");
    const customerNumber = req.body.From;

    console.log(`[Incoming] From: ${customerNumber} To: ${businessNumber}`);
    console.log("Message:", incomingMsg);

    // 6a. Lookup client settings
    const { data: settings, error: settingsError } = await supabase
      .from("settings")
      .select("user_id, whatsapp_number")
      .or(`whatsapp_number.eq.${businessNumber},whatsapp_number.eq.+${businessNumber}`)
      .single();

    if (settingsError || !settings) {
      console.error("❌ Lookup Failed:", settingsError?.message || "Number not found");
      twiml.message("Sorry, this business is not currently active.");
      return res.type("text/xml").send(twiml.toString());
    }

    // 6b. Fetch client products
    const { data: products, error: prodError } = await supabase
      .from("products")
      .select("name, description, detail, moq, price, delivery_info")
      .eq("user_id", settings.user_id);

    if (prodError) console.error("❌ Product Fetch Error:", prodError.message);

    const productList = products || [];
    const catalog =
      productList.length > 0
        ? productList
            .map(
              (p) =>
                `Product: ${p.name} | Price: $${p.price} | MOQ: ${p.moq} | Delivery: ${p.delivery_info}`
            )
            .join("\n")
        : "No products currently available.";

    console.log(`[Context] Found ${productList.length} products for User: ${settings.user_id}`);

    // 6c. Generate AI response
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a professional sales assistant. ${
            productList.length === 0
              ? "We are currently updating our catalog. Ask for customer details."
              : "Answer based ONLY on this catalog:\n" + catalog
          }`,
        },
        { role: "user", content: incomingMsg },
      ],
    });

    const replyText = aiResponse?.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response.";

    // 6d. Log lead asynchronously
    supabase
      .from("leads")
      .insert([
        {
          customer_phone: customerNumber,
          inquiry_text: incomingMsg,
          ai_reply: replyText,
          user_id: settings.user_id,
          status: "Inquiry",
        },
      ])
      .then(({ error }) => {
        if (error) console.error("❌ Lead Log Error:", error.message);
      });

    // 6e. Send Twilio reply
    twiml.message(replyText);
    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("🔥 Critical Error:", error);
    twiml.message("I'm having a technical moment. Please try again in a minute.");
    res.type("text/xml").send(twiml.toString());
  }
});

// 7️⃣ Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server active on port ${PORT}`));