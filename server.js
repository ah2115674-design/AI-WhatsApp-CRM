require("dotenv").config();

const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { MessagingResponse } = require("twilio").twiml;
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ✅ CORS
app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

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

// ✅ NUMBER NORMALIZER
const normalizeNumber = (num) =>
  num ? num.replace("whatsapp:", "").replace(/\D/g, "") : "";

// ✅ ROOT
app.get("/", (req, res) => res.send("Server is alive ✅"));

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

// 🔥 AI CORE FUNCTION
async function generateAIResponse(userMessage, user_id, customerNumber) {
  // 1. Fetch products
  const { data: products } = await supabase
    .from("products")
    .select("*")
    .eq("user_id", user_id);

  // 2. Fetch last 5 messages
  const { data: history } = await supabase
    .from("leads")
    .select("inquiry_text, ai_reply")
    .eq("customer_phone", customerNumber)
    .order("created_at", { ascending: false })
    .limit(5);

  const formattedHistory = history
    ?.reverse()
    .map(h => `User: ${h.inquiry_text}\nAI: ${h.ai_reply}`)
    .join("\n");

  // 3. Structured catalog
  const catalog = products?.length
    ? products.map(p => ({
        name: p.name,
        price: p.price,
        moq: p.moq,
        description: p.description
      }))
    : [];

  // 4. Prompt for OpenAI
  const prompt = `
You are a professional WhatsApp sales agent.

Goals:
- Answer product questions clearly
- Suggest relevant products
- Be short, friendly, human
- Encourage buying

Products:
${JSON.stringify(catalog)}

Conversation history:
${formattedHistory || "No previous conversation"}

User message:
${userMessage}

Rules:
- ONLY use product data
- If product not found, say: "Let me check that for you"
- Keep replies under 3 lines
`;

  // 5. OpenAI call
  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return aiResponse?.choices?.[0]?.message?.content || "Sorry, something went wrong.";
}

// 🚀 SAVE WHATSAPP NUMBER
app.post("/save-whatsapp", async (req, res) => {
  try {
    const { user_id, whatsapp_number } = req.body;

    if (!user_id || !whatsapp_number) {
      return res.status(400).json({ error: "Missing user_id or whatsapp_number" });
    }

    const cleanNumber = normalizeNumber(whatsapp_number);

    const { data, error } = await supabase
      .from("settings")
      .upsert(
        [{ user_id, whatsapp_number: cleanNumber, updated_at: new Date().toISOString() }],
        { onConflict: "user_id" }
      );

    if (error) throw error;

    console.log("✅ WhatsApp saved:", cleanNumber);

    res.json({ success: true, message: "WhatsApp number saved successfully", data });

  } catch (err) {
    console.error("❌ SAVE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ WHATSAPP WEBHOOK
app.post("/api/webhook", async (req, res) => {
  const twiml = new MessagingResponse();

  try {
    if (!req.body.Body || !req.body.To || !req.body.From) {
      return res.status(400).send("Invalid Twilio payload");
    }

    const incomingMsg = req.body.Body;
    const businessNumber = normalizeNumber(req.body.To);
    const customerNumber = normalizeNumber(req.body.From);

    // FIND USER
    const { data: settingsList } = await supabase
      .from("settings")
      .select("user_id, whatsapp_number");

    const settings = settingsList?.find(
      (s) => normalizeNumber(s.whatsapp_number) === businessNumber
    );

    if (!settings) {
      twiml.message("Sorry, this business is not currently active.");
      return res.type("text/xml").send(twiml.toString());
    }

    // AI RESPONSE
    const replyText = await generateAIResponse(
      incomingMsg,
      settings.user_id,
      customerNumber
    );

    // LOG LEAD
    await supabase.from("leads").insert([
      {
        customer_phone: customerNumber,
        inquiry_text: incomingMsg,
        ai_reply: replyText,
        user_id: settings.user_id,
        status: "Inquiry",
        created_at: new Date().toISOString()
      },
    ]);

    twiml.message(replyText);
    res.type("text/xml").send(twiml.toString());

  } catch (error) {
    console.error("🔥 ERROR:", error);
    twiml.message("Something went wrong. Please try again in a moment.");
    res.type("text/xml").send(twiml.toString());
  }
});

// ✅ DASHBOARD / TEST ENDPOINT
app.post("/api/whatsapp/test", async (req, res) => {
  try {
    const { message, user_id } = req.body;
    const reply = await generateAIResponse(message, user_id, "test-user");
    res.json({ reply });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));