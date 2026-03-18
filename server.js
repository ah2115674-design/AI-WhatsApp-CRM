require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const OpenAI = require("openai");
const { MessagingResponse } = require("twilio").twiml;
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ✅ CORS
app.use(cors({
  origin: "*", // replace with frontend URL in production
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

// ✅ Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ✅ ENV Check
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing Supabase env variables");
}
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OpenAI API key");
}

// ✅ Init clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Helper functions
const normalizeNumber = (num) => num ? num.replace("whatsapp:", "").replace(/\D/g, "") : "";

// ✅ AI Response generator
async function generateAIResponse(userMessage, user_id, customerNumber) {
  // Fetch products
  const { data: products } = await supabase
    .from("products")
    .select("*")
    .eq("user_id", user_id);

  // Fetch last 5 leads for conversation history
  const { data: history } = await supabase
    .from("leads")
    .select("inquiry_text, ai_reply")
    .eq("customer_phone", customerNumber)
    .order("created_at", { ascending: false })
    .limit(5);

  const formattedHistory = history?.reverse()
    .map(h => `User: ${h.inquiry_text}\nAI: ${h.ai_reply}`)
    .join("\n");

  // Catalog
  const catalog = products?.length
    ? products.map(p => ({ name: p.name, price: p.price, moq: p.moq, description: p.description }))
    : [];

  const prompt = `
You are a professional WhatsApp sales agent.
Products: ${JSON.stringify(catalog)}
Conversation history: ${formattedHistory || "No previous conversation"}
User message: ${userMessage}
Rules: Only use product data, keep replies short and friendly (under 3 lines). If product not found, say "Let me check that for you".
`;

  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return aiResponse?.choices?.[0]?.message?.content || "Sorry, something went wrong.";
}

// ✅ Routes

// Root
app.get("/", (req, res) => res.send("Server is alive ✅"));

// Signup
app.post("/api/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });

    const { data: existing } = await supabase.from("users").select("*").eq("email", email).single();
    if (existing) return res.status(400).json({ error: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const { data, error } = await supabase.from("users").insert([{ name, email, password: hashedPassword }]).select().single();
    if (error) throw error;

    res.json({ success: true, user: { id: data.id, name: data.name, email: data.email } });
  } catch (err) {
    console.error("SIGNUP ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });

    const { data: user } = await supabase.from("users").select("*").eq("email", email).single();
    if (!user) return res.status(400).json({ error: "User not found" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: "Incorrect password" });

    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// Save WhatsApp number
app.post("/save-whatsapp", async (req, res) => {
  try {
    const { user_id, whatsapp_number } = req.body;
    if (!user_id || !whatsapp_number) return res.status(400).json({ error: "Missing user_id or whatsapp_number" });

    const cleanNumber = normalizeNumber(whatsapp_number);
    const { data, error } = await supabase.from("settings")
      .upsert([{ user_id, whatsapp_number: cleanNumber, updated_at: new Date().toISOString() }], { onConflict: "user_id" });

    if (error) throw error;
    res.json({ success: true, message: "WhatsApp number saved", data });
  } catch (err) {
    console.error("SAVE WHATSAPP ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create/Update products
app.post("/api/products", async (req, res) => {
  try {
    const { user_id, products } = req.body;
    if (!user_id || !products || !Array.isArray(products)) return res.status(400).json({ error: "Missing user_id or products array" });

    const { data, error } = await supabase.from("products").upsert(products.map(p => ({ ...p, user_id })), { onConflict: "id" });
    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error("PRODUCTS ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard AI test
app.post("/api/whatsapp/test", async (req, res) => {
  try {
    const { message, user_id } = req.body;
    const reply = await generateAIResponse(message, user_id, "test-user");
    res.json({ reply });
  } catch (err) {
    console.error("TEST AI ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// Twilio WhatsApp webhook
app.post("/api/webhook", async (req, res) => {
  const twiml = new MessagingResponse();
  try {
    const { Body, To, From } = req.body;
    if (!Body || !To || !From) return res.status(400).send("Invalid payload");

    const businessNumber = normalizeNumber(To);
    const customerNumber = normalizeNumber(From);

    const { data: settingsList } = await supabase.from("settings").select("user_id, whatsapp_number");
    const settings = settingsList.find(s => normalizeNumber(s.whatsapp_number) === businessNumber);
    if (!settings) {
      twiml.message("Sorry, this business is not active.");
      return res.type("text/xml").send(twiml.toString());
    }

    const replyText = await generateAIResponse(Body, settings.user_id, customerNumber);

    await supabase.from("leads").insert([{
      customer_phone: customerNumber,
      inquiry_text: Body,
      ai_reply: replyText,
      user_id: settings.user_id,
      status: "Inquiry",
      created_at: new Date().toISOString(),
    }]);

    twiml.message(replyText);
    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    twiml.message("Something went wrong. Try again later.");
    res.type("text/xml").send(twiml.toString());
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));