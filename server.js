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

// ✅ NUMBER NORMALIZER
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


// 🚀🚀🚀 MAIN FIX: SAVE WHATSAPP ROUTE 🚀🚀🚀
app.post("/save-whatsapp", async (req, res) => {
  try {
    console.log("🔥 /save-whatsapp HIT");

    const { user_id, whatsapp_number } = req.body;

    if (!user_id || !whatsapp_number) {
      return res.status(400).json({ error: "Missing user_id or whatsapp_number" });
    }

    const cleanNumber = normalizeNumber(whatsapp_number);

    const { data, error } = await supabase
      .from("settings")
      .upsert(
        [
          {
            user_id,
            whatsapp_number: cleanNumber,
            updated_at: new Date().toISOString(),
          },
        ],
        { onConflict: "user_id" }
      );

    if (error) throw error;

    console.log("✅ WhatsApp saved:", cleanNumber);

    return res.json({
      success: true,
      message: "WhatsApp number saved successfully",
      data,
    });
  } catch (err) {
    console.error("❌ SAVE ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
});


// ✅ WHATSAPP WEBHOOK
app.post("/whatsapp", async (req, res) => {
  const twiml = new MessagingResponse();

  try {
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

    // ✅ FIND USER
    const { data: settingsList, error: settingsError } = await supabase
      .from("settings")
      .select("user_id, whatsapp_number");

    if (settingsError) throw settingsError;

    const settings = settingsList?.find(
      (s) => normalizeNumber(s.whatsapp_number) === businessNumber
    );

    if (!settings) {
      console.error("❌ No matching user");
      twiml.message("Sorry, this business is not currently active.");
      return res.type("text/xml").send(twiml.toString());
    }

    // ✅ FETCH PRODUCTS
    const { data: products } = await supabase
      .from("products")
      .select("*")
      .eq("user_id", settings.user_id);

    const catalog =
      products?.length > 0
        ? products
            .map(
              (p) =>
                `Product: ${p.name} | Price: $${p.price} | MOQ: ${p.moq}`
            )
            .join("\n")
        : "No products available.";

    // ✅ AI RESPONSE
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a sales assistant. Use this catalog:\n${catalog}`,
        },
        { role: "user", content: incomingMsg },
      ],
    });

    const replyText =
      aiResponse?.choices?.[0]?.message?.content ||
      "Sorry, something went wrong.";

    // ✅ LOG LEAD
    await supabase.from("leads").insert([
      {
        customer_phone: customerNumber,
        inquiry_text: incomingMsg,
        ai_reply: replyText,
        user_id: settings.user_id,
        status: "Inquiry",
      },
    ]);

    twiml.message(replyText);
    res.type("text/xml").send(twiml.toString());

  } catch (error) {
    console.error("🔥 ERROR:", error);
    twiml.message("Server error. Try again later.");
    res.type("text/xml").send(twiml.toString());
  }
});

// ✅ START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on port ${PORT}`)
);