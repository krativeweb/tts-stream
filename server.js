import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { ulawEncode } from "pcm-mulaw";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("🎧 Node TTS Stream running on", PORT);
});

/*
callSid → { twilioWs, streamSid }
*/
const sessions = new Map();
const speakers = new Map();

/* ---------------- TWILIO MEDIA STREAM ---------------- */

const wss = new WebSocketServer({ server });

wss.on("connection", (twilioWs) => {
  let callSid = null;

  twilioWs.on("message", (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch { return; }

    if (data.event === "start") {
      callSid = data.start.callSid;
      sessions.set(callSid, {
        twilioWs,
        streamSid: data.start.streamSid
      });
      console.log("📞 Call connected:", callSid);
    }

    /* Barge-in */
    if (data.event === "media" && data.media.track === "inbound") {
      const sp = speakers.get(callSid);
      if (sp) {
        console.log("🛑 Barge-in");
        sp.close();
        speakers.delete(callSid);
      }
    }

    if (data.event === "stop") {
      sessions.delete(callSid);
      speakers.delete(callSid);
      console.log("❌ Call ended:", callSid);
    }
  });
});

/* ---------------- PHP → NODE SPEAK ---------------- */

app.post("/speak", (req, res) => {
  const { callSid, text } = req.body;
  if (!callSid || !text) return res.sendStatus(400);

  const session = sessions.get(callSid);
  if (!session) return res.sendStatus(404);

  /* Stop previous speech */
  const old = speakers.get(callSid);
  if (old) old.close();

  const elevenWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVEN_VOICE_ID}/stream-input?model_id=eleven_multilingual_v2`,
    { headers: { "xi-api-key": process.env.ELEVEN_API_KEY } }
  );

  speakers.set(callSid, elevenWs);

  elevenWs.on("open", () => {
    elevenWs.send(JSON.stringify({
      text,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.8
      }
    }));
    elevenWs.send(JSON.stringify({ text: "" }));
  });

  elevenWs.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (!data.audio) return;

      // PCM → μ-law (Twilio requirement)
      const pcm = Buffer.from(data.audio, "base64");
      const mulaw = ulawEncode(pcm);

      session.twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: {
          payload: mulaw.toString("base64")
        }
      }));
    } catch {}
  });

  elevenWs.on("close", () => speakers.delete(callSid));
  elevenWs.on("error", () => speakers.delete(callSid));

  res.sendStatus(200);
});
