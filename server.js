import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("Node TTS Stream running on port", PORT);
});

/* ---------------- WEBSOCKET SERVER ---------------- */

const wss = new WebSocketServer({ server });

const sessions = new Map(); // callSid → Twilio WS
const speakers = new Map(); // callSid → ElevenLabs WS

/* ---------------- TWILIO MEDIA STREAM ---------------- */

wss.on("connection", (twilioWs) => {
  let callSid = null;

  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    if (data.event === "start") {
      callSid = data.start.callSid;
      sessions.set(callSid, twilioWs);
      console.log("📞 Call connected:", callSid);
    }

    /* ---------- USER INTERRUPT (BARGE-IN) ---------- */
    if (data.event === "media" && data.media.track === "inbound") {
      const elevenWs = speakers.get(callSid);
      if (elevenWs) {
        console.log("🛑 User interrupted – stopping TTS");
        elevenWs.close();
        speakers.delete(callSid);
      }
    }

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
  if (!callSid || !text) return res.sendStatus(400);

  const twilioWs = sessions.get(callSid);
  if (!twilioWs) return res.sendStatus(404);

  /* Stop previous speech */
  const oldSpeaker = speakers.get(callSid);
  if (oldSpeaker) {
    oldSpeaker.close();
    speakers.delete(callSid);
  }

  const elevenWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}/stream-input?model_id=eleven_multilingual_v2`,
    {
      headers: { "xi-api-key": process.env.ELEVEN_API_KEY },
    }
  );

  speakers.set(callSid, elevenWs);

  elevenWs.on("open", () => {
    elevenWs.send(JSON.stringify({
      text,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8,
      },
    }));

    elevenWs.send(JSON.stringify({ text: "" }));
  });

  elevenWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.audio) {
        twilioWs.send(JSON.stringify({
          event: "media",
          media: { payload: data.audio },
        }));
      }
    } catch {}
  });

  elevenWs.on("close", () => speakers.delete(callSid));
  elevenWs.on("error", () => speakers.delete(callSid));

  res.sendStatus(200);
});
