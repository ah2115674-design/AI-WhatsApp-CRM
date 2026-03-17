require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { MessagingResponse } = require("twilio").twiml;
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ✅ ENV CHECK
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ MISSING SUPABASE ENV VARIABLES");
}
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ MISSING OPENAI API KEY");
}

// ✅ INIT
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ MIDDLEWARE
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ✅ NUMBER NORMALIZER (VERY IMPORTANT)
const normalizeNumber = (num) =>
  num ? num.replace("whatsapp:", "").replace(/\D/g, "") : "";

// ✅ ROOT
app.get("/", (req, res) => {
  res.send("Server is alive ✅");
});

// ✅ TEST SUPABASE
app.get("/test-supabase", async (req, res) => {
  try {
    const { data, error } = await supabase.from("settings").select("*").limit(1);
    if (error) throw error;
    res.json({ status: "Connected to Supabase ✅", data });
  } catch (err) {
    res.status(500).json({ status: "Error", message: err.message });
  }
});

// ✅ WHATSAPP WEBHOOK
app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();

  try {
    // ✅ VALIDATE PAYLOAD
    if (!req.body.Body || !req.body.To || !req.body.From) {
      console.error("❌ Invalid Twilio payload");
      return res.status(400).send("Invalid request");
    }

    const incomingMsg = req.body.Body;
    const businessNumber = normalizeNumber(req.body.To);
    const customerNumber = normalizeNumber(req.body.From);

    console.log("------ NEW MESSAGE ------");
    console.log("From:", customerNumber);
    console.log("To:", businessNumber);
    console.log("Message:", incomingMsg);

    // ✅ FETCH ALL SETTINGS (ROBUST MATCHING)
    const { data: allSettings, error: settingsError } = await supabase
      .from("settings")
      .select("user_id, whatsapp_number");

    if (settingsError) throw settingsError;

    const settings = allSettings?.find(
      (s) => normalizeNumber(s.whatsapp_number) === businessNumber
    );

    if (!settings) {
      console.error("❌ No matching user for number:", businessNumber);
      twiml.message("Sorry, this business is not currently active.");
      return res.type("text/xml").send(twiml.toString());
    }

    // ✅ FETCH PRODUCTS
    const { data: products, error: prodError } = await supabase
      .from("products")
      .select("name, description, detail, moq, price, delivery_info")
      .eq("user_id", settings.user_id);

    if (prodError) console.error("❌ Product Fetch Error:", prodError.message);

    const productList = products || [];

    if (productList.length === 0) {
      console.log("⚠️ No products found for this user");
    }

    const catalog =
      productList.length > 0
        ? productList
            .map(
              (p) =>
                `Product: ${p.name} | Price: $${p.price} | MOQ: ${p.moq} | Delivery: ${p.delivery_info}`
            )
            .join("\n")
        : "No products currently available.";

    console.log(
      `[Context] Found ${productList.length} products for User: ${settings.user_id}`
    );

    // ✅ AI RESPONSE WITH TIMEOUT
    const aiResponse = await Promise.race([
      openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a professional WhatsApp sales assistant.

Rules:
- Be short, clear, and persuasive
- Help the customer choose a product
- If product exists → recommend it
- If no products → ask for customer details (name, requirement)

Catalog:
${catalog}`,
          },
          { role: "user", content: incomingMsg },
        ],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AI Timeout")), 8000)
      ),
    ]);

    const replyText =
      aiResponse?.choices?.[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    // ✅ LOG LEAD (ASYNC)
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

    // ✅ SEND RESPONSE
    twiml.message(replyText);
    res.type("text/xml").send(twiml.toString());
  } catch (error) {
    console.error("🔥 Critical Error:", error);

    twiml.message(
      "I'm having a technical moment. Please try again in a minute."
    );
    res.type("text/xml").send(twiml.toString());
  }
});

// ✅ START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server active on port ${PORT}`)
);