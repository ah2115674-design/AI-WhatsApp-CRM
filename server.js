// server.js
require("dotenv").config({ path: "C:/Users/HP/openai.env" });

const express = require("express");
const OpenAI = require("openai");
const { MessagingResponse } = require("twilio").twiml;

const app = express();

// Important: parse Twilio form data
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Test route
app.get("/", (req, res) => {
  res.send("AI CRM running");
});

// WhatsApp webhook route
app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = req.body.Body;
    console.log("Received message from WhatsApp:", incomingMsg);

    // OpenAI call
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a sales assistant for a manufacturing company. Provide MOQ, pricing, and product details."
        },
        {
          role: "user",
          content: incomingMsg
        }
      ]
    });

    const replyText = aiResponse.choices[0].message.content;
    console.log("AI reply:", replyText);

    // Respond to Twilio
    const twiml = new MessagingResponse();
    twiml.message(replyText);

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());

  } catch (error) {
    console.error(error);
    res.status(500).send("Error generating response");
  }
});

// Start server
app.listen(3000, () => console.log("Server running on port 3000"));