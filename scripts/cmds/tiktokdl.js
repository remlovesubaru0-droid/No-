"use strict";

const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const ORIGIN = "https://snaptik.app";
const PAGE_URL = `${ORIGIN}/en3`;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CHALLENGE_KEY = "sn4pt1k_v3r1fy2026";
const TEMP_DIR = path.join(__dirname, "cache");
const MAX_SIZE = 45 * 1024 * 1024;
const TIKTOK_URL_RE = /^https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/\S+$/i;

const BASE_HEADERS = {
  "user-agent": USER_AGENT,
  accept: "*/*",
  referer: PAGE_URL,
  origin: ORIGIN
};

function publicError(message) {
  const error = new Error(message);
  error.publicMessage = message;
  return error;
}

function solveChallenge(id, payload) {
  const buffer = Buffer.from(String(payload), "base64");
  if (buffer.length < 32) throw new Error("Invalid challenge");

  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    crypto.createHash("sha256").update(`${CHALLENGE_KEY}:${id}`).digest(),
    buffer.subarray(0, 16)
  );

  const json = JSON.parse(
    Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]).toString("utf8")
  );

  const extra = json._e;
  const header = json._h;
  delete json._e;
  delete json._h;

  let answer;

  switch (json.t) {
    case "b":
      answer = ((json.a ^ json.b) >> json.s) & 255;
      break;
    case "r":
      answer = json.n.reduce((total, value) => total + value, 0) * 2 + 1;
      break;
    case "c":
      answer = json.w.charCodeAt(json.i) * json.m;
      break;
    case "m":
      answer = ((json.a + json.b) % 100) * json.c;
      break;
    case "n":
      answer = json.a * json.b + json.b * json.c + json.c * json.a - json.a;
      break;
    default:
      throw new Error("Unknown challenge");
  }

  return `${id}:${answer}:${extra}:${header}`;
}

async function createToken() {
  const response = await axios.post(`${ORIGIN}/api/token`, {}, {
    timeout: 20000,
    headers: {
      ...BASE_HEADERS,
      "x-requested-with": "XMLHttpRequest",
      "content-type": "application/json"
    },
    validateStatus: () => true
  });

  const data = response.data;

  if (response.status !== 200 || !data || !data.id || !data.p) {
    throw new Error("Token request failed");
  }

  return solveChallenge(data.id, data.p);
}

async function extractVideo(url) {
  let lastStatus = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await createToken();
    const response = await axios.get(`${ORIGIN}/api/extract`, {
      timeout: 30000,
      params: { url },
      headers: {
        ...BASE_HEADERS,
        "x-requested-with": "XMLHttpRequest",
        "x-verify": token
      },
      validateStatus: () => true
    });

    lastStatus = response.status;

    if (response.status === 403 && attempt === 0) continue;
    if (response.status === 429) {
      throw publicError("⛔ Too many requests right now. Please try again in a few minutes.");
    }
    if (response.status === 404) return null;
    if (response.status !== 200 || !response.data) break;

    const body = response.data;
    if (body.success === false) return null;

    const data = body.data || body;
    if (data && typeof data === "object") return data;
    break;
  }

  if (lastStatus === 404) return null;
  throw publicError("❌ Could not fetch that video. Please check the link and try again.");
}

function downloadHeaderHints(url) {
  try {
    const token = new URL(url).searchParams.get("token");
    if (!token) return {};

    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );

    const hints = {};
    if (!payload || !payload.headers || typeof payload.headers !== "object") return hints;

    for (const [key, value] of Object.entries(payload.headers)) {
      if (typeof value === "string" && value.trim()) hints[key.toLowerCase()] = value;
    }

    return hints;
  } catch (_) {
    return {};
  }
}

async function downloadVideo(url, destination) {
  let response;

  try {
    response = await axios.get(url, {
      responseType: "stream",
      timeout: 120000,
      maxContentLength: MAX_SIZE,
      maxBodyLength: MAX_SIZE,
      headers: {
        "user-agent": USER_AGENT,
        accept: "*/*",
        ...downloadHeaderHints(url)
      },
      validateStatus: status => status >= 200 && status < 300
    });
  } catch (error) {
    if (Number(error?.response?.headers?.["content-length"] || 0) > MAX_SIZE) {
      throw publicError("⚠️ That video is too large to send in chat.");
    }
    throw publicError("❌ Could not download that video. Please try again.");
  }

  const declaredSize = Number(response.headers["content-length"] || 0);

  if (declaredSize > MAX_SIZE) {
    response.data.destroy();
    throw publicError("⚠️ That video is too large to send in chat.");
  }

  let bytes = 0;
  let tooLarge = false;

  const counter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_SIZE) {
        tooLarge = true;
        callback(new Error("Video too large"));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(response.data, counter, fs.createWriteStream(destination));
  } catch (_) {
    await fs.remove(destination).catch(() => {});
    if (tooLarge) throw publicError("⚠️ That video is too large to send in chat.");
    throw publicError("❌ Could not download that video. Please try again.");
  }

  const stat = await fs.stat(destination).catch(() => null);

  if (!stat || !stat.size) {
    await fs.remove(destination).catch(() => {});
    throw publicError("❌ The downloaded video file is empty.");
  }

  const contentType = String(response.headers["content-type"] || "").toLowerCase();

  if (
    contentType &&
    !/^(video\/|application\/mp4|application\/octet-stream|binary\/octet-stream)/.test(contentType)
  ) {
    await fs.remove(destination).catch(() => {});
    throw publicError("❌ The link did not return a playable video.");
  }
}

function videoSource(data) {
  if (typeof data.downloadUrl === "string" && /^https?:\/\//i.test(data.downloadUrl)) {
    return data.downloadUrl;
  }
  return "";
}

function formatDuration(value) {
  const seconds = Math.round(Number(value) || 0);
  if (!seconds) return "";

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function buildCaption(data) {
  const lines = [];

  if (data.title) {
    const title = String(data.title).replace(/\s+/g, " ").trim().slice(0, 180);
    if (title) lines.push(`🎬 ${title}`);
  }

  if (data.author && data.author.username) {
    lines.push(`👤 @${data.author.username}`);
  }

  const duration = formatDuration(data.videoDuration);
  if (duration) lines.push(`⏱️ ${duration}`);

  return lines.join("\n") || "🎬 Here is your video.";
}

module.exports = {
  config: {
    name: "tiktokdl",
    aliases: ["ttdl", "tikdl", "tikdown"],
    version: "1.0.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤",
    countDown: 15,
    role: 0,
    shortDescription: "Download a TikTok video without watermark",
    longDescription: "Download a public TikTok video and send it directly in the chat.",
    category: "media",
    guide: {
      en: "{p}tiktokdl <TikTok video link>"
    }
  },

  onStart: async function ({ message, args, prefix }) {
    const text = args.join(" ").trim().replace(/^["'`]+|["'`]+$/g, "");
    const match = text.match(/https?:\/\/[^\s<>"']+/i);
    const url = match ? match[0].replace(/[),.!?]+$/g, "") : "";
    const commandPrefix = prefix || "";

    if (!url || !TIKTOK_URL_RE.test(url)) {
      return message.reply(
        "⚠️ Please send a valid TikTok video link.\n" +
          `Example: ${commandPrefix}tiktokdl https://www.tiktok.com/@user/video/123`
      );
    }

    const workDir = path.join(
      TEMP_DIR,
      `tiktok_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );
    const filePath = path.join(workDir, "video.mp4");

    try {
      await fs.ensureDir(workDir);

      const data = await extractVideo(url);

      if (!data) {
        return message.reply(
          "❌ Could not find that video. Make sure the link is public and correct."
        );
      }

      const source = videoSource(data);

      if (!source) {
        return message.reply("⚠️ That link does not contain a downloadable video.");
      }

      await downloadVideo(source, filePath);

      return await message.reply({
        body: buildCaption(data),
        attachment: fs.createReadStream(filePath)
      });
    } catch (error) {
      console.error("[tiktokdl]", error?.message || error);
      return message.reply(error?.publicMessage || "❌ Something went wrong. Please try again.");
    } finally {
      setTimeout(() => {
        fs.remove(workDir).catch(() => {});
      }, 180000);
    }
  }
};
