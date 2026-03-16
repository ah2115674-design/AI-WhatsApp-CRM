// server.js
require("dotenv").config(); // Render will provide the variables automatically

const express = require("express");
const OpenAI = require("openai");
const { MessagingResponse } = require("twilio").twiml;
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Initialize Supabase with Service Role Key (bypasses RLS for backend)
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = req.body.Body;
    const businessNumber = req.body.To; // The WhatsApp number receiving the message
    const customerNumber = req.body.From; // The customer's WhatsApp number

    console.log(`Inquiry from ${customerNumber} to ${businessNumber}: ${incomingMsg}`);

    // 1. Find which Client (User) owns this WhatsApp number
    const { data: settings } = await supabase
      .from('settings')
      .select('user_id')
      .eq('whatsapp_number', businessNumber)
      .single();

    if (!settings) {
      console.error("No client found for number:", businessNumber);
      return res.status(404).send("Number not registered in dashboard");
    }

    // 2. Fetch the Client's real-time product list from Supabase
    const { data: products } = await supabase
      .from('products')
      .select('name, description, detail, moq, price, delivery_info')
      .eq('user_id', settings.user_id);

    // 3. Create the AI Context
    const catalog = products.map(p => 
      `Product: ${p.name}\nDesc: ${p.description}\nDetails: ${p.detail}\nPrice: $${p.price}\nMOQ: ${p.moq}\nDelivery: ${p.delivery_info}\n---`
    ).join('\n');

    // 4. Get AI Response
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a professional sales assistant. Answer based ONLY on this catalog:\n${catalog}`
        },
        { role: "user", content: incomingMsg }
      ]
    });

    const replyText = aiResponse.choices[0].message.content;

    // 5. Log the Lead back to the Dashboard
    await supabase.from('leads').insert([{
      customer_phone: customerNumber,
      customer_name: "WhatsApp User",
      inquiry_text: incomingMsg,
      ai_reply: replyText,
      user_id: settings.user_id,
      status: 'Inquiry'
    }]);

    // 6. Send TwiML response to Twilio
    const twiml = new MessagingResponse();
    twiml.message(replyText);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());

  } catch (error) {
    console.error("Critical Error:", error);
    res.status(500).send("Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server active on port ${PORT}`));