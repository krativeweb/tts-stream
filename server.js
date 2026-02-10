import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

/* ================= BASIC SERVER ================= */

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log("🎧 Node TTS Stream running on port", PORT);
});

/*
sessions:
callSid → { twilioWs, streamSid }
*/
const sessions = new Map();
const speakers = new Map();

/* ================= μ-LAW ENCODER ================= */

/*
  Linear PCM (16-bit) → μ-law (G.711)
  Pure JS, no npm, telephony-safe
*/

function linearToMuLawSample(sample) {
  const MU_LAW_MAX = 0x1FFF;
  const BIAS = 33;

  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;

  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function pcm16ToMuLaw(pcmBuffer) {
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.length / 2
  );

  const muLaw = Buffer.alloc(samples.length);
  for (let i = 0; i < samples.length; i++) {
    muLaw[i] = linearToMuLawSample(samples[i]);
  }
  return muLaw;
}

/* ============== DOWNSAMPLE TO 8kHz ============== */

function downsampleTo8kHz(pcmBuffer, inputRate = 22050) {
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    pcmBuffer.length / 2
  );

  const ratio = inputRate / 8000;
  const newLen = Math.floor(samples.length / ratio);
  const out = new Int16Array(newLen);

  for (let i = 0; i < newLen; i++) {
    out[i] = samples[Math.floor(i * ratio)];
  }

  return Buffer.from(out.buffer);
}

/* ================= TWILIO MEDIA STREAM ================= */

const wss = new WebSocketServer({ server });

wss.on("connection", (twilioWs) => {
  let callSid = null;

  twilioWs.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch {
      return;
    }

    /* CALL START */
    if (data.event === "start") {
      callSid = data.start.callSid;
      sessions.set(callSid, {
        twilioWs,
        streamSid: data.start.streamSid
      });
      console.log("📞 Call connected:", callSid);
    }

    /* BARGE-IN */
    if (data.event === "media" && data.media.track === "inbound") {
      const speaker = speakers.get(callSid);
      if (speaker) {
        console.log("🛑 Barge-in detected");
        speaker.close();
        speakers.delete(callSid);
      }
    }

    /* CALL END */
    if (data.event === "stop") {
      sessions.delete(callSid);
      speakers.delete(callSid);
      console.log("❌ Call ended:", callSid);
    }
  });
});

/* ================= PHP → NODE SPEAK ================= */

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
    {
      headers: {
        "xi-api-key": process.env.ELEVEN_API_KEY
      }
    }
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

      // ElevenLabs PCM (base64)
      const pcm22k = Buffer.from(data.audio, "base64");

      // 22kHz → 8kHz
      const pcm8k = downsampleTo8kHz(pcm22k, 22050);

      // PCM → μ-law
      const mulaw = pcm16ToMuLaw(pcm8k);

      session.twilioWs.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: {
          payload: mulaw.toString("base64")
        }
      }));
    } catch (e) {
      console.error("Audio pipeline error", e);
    }
  });

  elevenWs.on("close", () => speakers.delete(callSid));
  elevenWs.on("error", () => speakers.delete(callSid));

  res.sendStatus(200);
});
