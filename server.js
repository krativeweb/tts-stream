import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log("Node TTS Stream running on port", PORT);
});

const wss = new WebSocketServer({ server });

const sessions = new Map(); // callSid → Twilio WS
const speakers = new Map(); // callSid → Eleven WS

/* ---------------- TWILIO MEDIA STREAM ---------------- */

wss.on("connection", (twilioWs) => {
  let callSid = null;

  twilioWs.on("message", async (msg) => {
    const data = JSON.parse(msg);

    /* ---- CALL STARTED ---- */
    if (data.event === "start") {
      callSid = data.start.callSid;
      sessions.set(callSid, twilioWs);

      console.log("📞 Call connected:", callSid);

      // 🔥 TRIGGER FIRST QUESTION FROM PHP (DB)
   try {
  const res = await fetch(
    "https://thekreativeweb.com/codes/ivr-ai/start.php",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Render-Node-Service",
      },
      body: `CallSid=${callSid}`,
      timeout: 8000, // 🔥 VERY IMPORTANT
    }
  );

  // 🔥 Force response to finish
  await res.text();
} catch (e) {
  console.error("Failed to trigger first question", e);
}

    /* ---- USER INTERRUPT ---- */
    if (data.event === "media" && data.media.track === "inbound") {
      const eleven = speakers.get(callSid);
      if (eleven) {
        console.log("🛑 User interrupted – stopping TTS");
        eleven.close();
        speakers.delete(callSid);
      }
    }

    /* ---- CALL ENDED ---- */
    if (data.event === "stop") {
      sessions.delete(callSid);
      speakers.delete(callSid);
      console.log("❌ Call ended:", callSid);
    }
  });

  twilioWs.on("close", () => {
    if (callSid) {
      sessions.delete(callSid);
      speakers.delete(callSid);
    }
  });
});

/* ---------------- PHP → NODE SPEAK ---------------- */

app.post("/speak", (req, res) => {
  const { callSid, text } = req.body;
  const twilioWs = sessions.get(callSid);

  if (!twilioWs) return res.sendStatus(404);

  // Stop previous speech if any
  const old = speakers.get(callSid);
  if (old) old.close();

  const elevenWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}/stream-input?model_id=eleven_multilingual_v2`,
    {
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY,
      },
    },
  );

  speakers.set(callSid, elevenWs);

  elevenWs.on("open", () => {
    elevenWs.send(
      JSON.stringify({
        text,
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8,
        },
      }),
    );
    elevenWs.send(JSON.stringify({ text: "" }));
  });

  elevenWs.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.audio) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          media: { payload: data.audio },
        }),
      );
    }
  });

  elevenWs.on("close", () => {
    speakers.delete(callSid);
    res.sendStatus(200);
  });
});

