"use strict";

const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const FormData = require("form-data");

const execFileAsync = promisify(execFile);

const API_BASE = "https://songfinder.gg";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const TEMP_DIR = path.join(__dirname, "cache");
const MAX_DOWNLOAD = 40 * 1024 * 1024;
const CLIP_SECONDS = 25;
const POW_MAX_ATTEMPTS = 20000000;

const SIGNATURE =
  "╭───────────────⬣\n" +
  "│ 𝐌𝐚𝐝𝐞 𝐰𝐢𝐭𝐡 🤍 𝐛𝐲 ••𝔐𝔯.𝔎𝔦𝔫𝔤\n" +
  "╰───────────────⬣";

const MEDIA_EXT_RE = /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac|mp4|webm|mov|mkv|avi|3gp|wmv|flv)(\?.*)?$/i;
const PLATFORM_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com|soundcloud\.com)$/i;
const UNSUPPORTED_TYPES = new Set(["photo", "sticker", "animated_image", "share"]);

let toolsPromise = null;
let ffmpegReady = false;
let ffprobeReady = false;
let ytdlpReady = false;

function publicError(message) {
  const error = new Error(message);
  error.publicMessage = message;
  return error;
}

function leadingZeroBits(buffer) {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0) {
      count += 8;
      continue;
    }
    let mask = 0x80;
    while (mask > 0 && (byte & mask) === 0) {
      count++;
      mask >>= 1;
    }
    break;
  }
  return count;
}

async function solvePow(challenge, timestamp, difficulty) {
  const target = Number(difficulty) || 0;
  for (let nonce = 0; nonce < POW_MAX_ATTEMPTS; nonce++) {
    const hash = crypto
      .createHash("sha256")
      .update(`${challenge}${timestamp}${nonce}`)
      .digest();
    if (leadingZeroBits(hash) >= target) return nonce;
    if (nonce % 5000 === 4999) await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("Challenge failed");
}

async function detectTools() {
  if (!toolsPromise) {
    toolsPromise = (async () => {
      try {
        await execFileAsync(FFMPEG, ["-version"], { timeout: 10000 });
        ffmpegReady = true;
      } catch (_) {}
      try {
        await execFileAsync(FFPROBE, ["-version"], { timeout: 10000 });
        ffprobeReady = true;
      } catch (_) {}
      try {
        await execFileAsync(YTDLP, ["--version"], { timeout: 10000 });
        ytdlpReady = true;
      } catch (_) {}
    })();
  }
  await toolsPromise;
}

function guessExt(url) {
  const match = String(url).match(MEDIA_EXT_RE);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function isPlatformUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, "");
    return PLATFORM_HOST_RE.test(host);
  } catch (_) {
    return false;
  }
}

async function downloadToFile(url, dest) {
  let response;
  try {
    response = await axios.get(url, {
      responseType: "stream",
      timeout: 60000,
      maxContentLength: MAX_DOWNLOAD,
      maxBodyLength: MAX_DOWNLOAD,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
      validateStatus: status => status >= 200 && status < 300
    });
  } catch (_) {
    throw publicError("❌ Could not download the media file. Please try again.");
  }

  try {
    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(dest);
      let bytes = 0;
      let failed = false;
      const fail = error => {
        if (failed) return;
        failed = true;
        try {
          response.data.destroy();
        } catch (_) {}
        try {
          writer.destroy();
        } catch (_) {}
        reject(error);
      };

      response.data.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD) fail(new Error("File too large"));
      });
      response.data.on("error", fail);
      writer.on("error", fail);
      writer.on("finish", () => {
        if (!failed) resolve();
      });
      response.data.pipe(writer);
    });
  } catch (_) {
    await fs.remove(dest).catch(() => {});
    throw publicError("❌ Could not download the media file. Please try again.");
  }

  const stat = await fs.stat(dest).catch(() => null);
  if (!stat || !stat.size) {
    await fs.remove(dest).catch(() => {});
    throw publicError("❌ The downloaded media file is empty.");
  }

  return { path: dest, contentType: String(response.headers["content-type"] || "") };
}

async function ytdlpDownload(url, destBase) {
  const outputTemplate = `${destBase}.%(ext)s`;
  await execFileAsync(
    YTDLP,
    [
      "--no-warnings",
      "--no-playlist",
      "--quiet",
      "--no-progress",
      "-f",
      "bestaudio/best",
      "-o",
      outputTemplate,
      url
    ],
    { timeout: 240000, maxBuffer: 1024 * 1024 }
  );

  const dir = path.dirname(destBase);
  const prefix = `${path.basename(destBase)}.`;
  const found = (await fs.readdir(dir)).find(
    name => name.startsWith(prefix) && !name.endsWith(".part")
  );

  if (!found) throw new Error("Download failed");
  return path.join(dir, found);
}

async function makeClip(input, output) {
  await detectTools();

  if (!ffmpegReady) {
    throw publicError("❌ Audio processing is unavailable right now. Please try again later.");
  }

  let start = 0;

  if (ffprobeReady) {
    try {
      const { stdout } = await execFileAsync(
        FFPROBE,
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input],
        { timeout: 30000 }
      );
      const duration = parseFloat(String(stdout).trim()) || 0;
      if (duration > 45) start = Math.min(20, Math.round(duration * 0.25));
    } catch (_) {}
  }

  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (start > 0) args.push("-ss", String(start));
  args.push(
    "-t",
    String(CLIP_SECONDS),
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "22050",
    "-b:a",
    "64k",
    "-f",
    "mp3",
    output
  );

  try {
    await execFileAsync(FFMPEG, args, { timeout: 120000, maxBuffer: 1024 * 1024 });
  } catch (_) {
    throw publicError("❌ Could not prepare the audio clip. Please try another audio or video.");
  }

  const stat = await fs.stat(output).catch(() => null);
  if (!stat || !stat.size) {
    throw publicError("❌ Could not prepare the audio clip. Please try another audio or video.");
  }
}

async function recognizeFile(filePath) {
  let challenge;

  try {
    const response = await axios.get(`${API_BASE}/api/challenge`, {
      timeout: 20000,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" }
    });
    challenge = response.data;
  } catch (error) {
    if (error?.response?.status === 429) {
      throw publicError("⛔ Daily recognition limit reached. Try again tomorrow.");
    }
    throw publicError("❌ Recognition is not available right now. Please try again later.");
  }

  if (!challenge || !challenge.id || !challenge.challenge) {
    throw publicError("❌ Recognition is not available right now. Please try again later.");
  }

  let nonce;
  try {
    nonce = await solvePow(challenge.challenge, challenge.timestamp, challenge.difficulty);
  } catch (_) {
    throw publicError("❌ Recognition failed. Please try again.");
  }

  const form = new FormData();
  form.append("audio", fs.createReadStream(filePath), {
    filename: "audio.mp3",
    contentType: "audio/mpeg"
  });
  form.append("challengeId", challenge.id);
  form.append("challenge", challenge.challenge);
  form.append("timestamp", String(challenge.timestamp));
  form.append("nonce", String(nonce));
  form.append("difficulty", String(challenge.difficulty));

  try {
    const response = await axios.post(`${API_BASE}/api/extension/recognize/recording`, form, {
      headers: {
        ...form.getHeaders(),
        "X-Extension-Request": "true",
        "User-Agent": USER_AGENT,
        Origin: API_BASE,
        Referer: `${API_BASE}/`
      },
      timeout: 150000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true
    });
    return { status: response.status, data: response.data };
  } catch (error) {
    if (error?.response?.status === 429) {
      throw publicError("⛔ Daily recognition limit reached. Try again tomorrow.");
    }
    if (error?.response?.status === 503) {
      throw publicError("⚠️ Recognition is temporarily unavailable. Try a 10–25 second clip and try again.");
    }
    throw publicError("❌ Recognition is not available right now. Please try again later.");
  }
}

function formatTrack(track) {
  const lines = [
    `🎵 𝐓𝐢𝐭𝐥𝐞: ${track.title || "Unknown"}`,
    `🎤 𝐀𝐫𝐭𝐢𝐬𝐭: ${track.artist || "Unknown"}`,
    `💿 𝐀𝐥𝐛𝐮𝐦: ${track.album || "Unknown"}`,
    `📅 𝐑𝐞𝐥𝐞𝐚𝐬𝐞: ${track.releaseDate || "Unknown"}`,
    `🎼 𝐆𝐞𝐧𝐫𝐞: ${track.genre || "Unknown"}`,
    `🏷️ 𝐋𝐚𝐛𝐞𝐥: ${track.label || "Unknown"}`,
    `🔖 𝐈𝐒𝐑𝐂: ${track.isrc || "Unknown"}`
  ];

  return `${lines.join("\n")}\n\n${SIGNATURE}`;
}

async function sendTrack(message, track) {
  const body = formatTrack(track);
  const cover =
    typeof track.coverArt === "string" && /^https:\/\//i.test(track.coverArt)
      ? track.coverArt
      : "";

  if (!cover) return message.reply(body);

  const coverPath = path.join(
    TEMP_DIR,
    `cover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`
  );

  try {
    await downloadToFile(cover, coverPath);
  } catch (_) {
    return message.reply(body);
  }

  try {
    return await message.reply({ body, attachment: fs.createReadStream(coverPath) });
  } catch (_) {
    return message.reply(body);
  } finally {
    setTimeout(() => {
      fs.remove(coverPath).catch(() => {});
    }, 60000);
  }
}

module.exports = {
  config: {
    name: "songfinder",
    aliases: ["songid", "musicid", "trackid", "melody"],
    version: "1.0.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤",
    countDown: 15,
    role: 0,
    shortDescription: "Identify a song from a short audio or video clip",
    longDescription: "Recognize a song and show its title, artist, album, release, genre, label, and ISRC.",
    category: "media",
    guide: {
      en:
        "{p}songfinder (reply to an audio or video message)\n" +
        "{p}songfinder <direct audio or video link>"
    }
  },

  onStart: async function ({ message, event, args, prefix }) {
    const workDir = path.join(
      TEMP_DIR,
      `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );

    try {
      await fs.ensureDir(workDir);

      const replyAttachments = Array.isArray(event?.messageReply?.attachments)
        ? event.messageReply.attachments
        : [];
      const ownAttachments = Array.isArray(event?.attachments) ? event.attachments : [];
      const allAttachments = [...replyAttachments, ...ownAttachments].filter(
        item => item && item.url
      );
      const attachment = allAttachments.find(item => !UNSUPPORTED_TYPES.has(item.type));

      if (!attachment && allAttachments.length) {
        return message.reply(
          "⚠️ That attachment is not audio or video. Reply to an audio, voice note, video, or file message."
        );
      }

      const urlArg = args.find(arg => /^https?:\/\//i.test(arg));

      if (!attachment && !urlArg) {
        return message.reply(
          "⚠️ Reply to an audio or video message with this command.\n" +
            `Example: ${prefix || ""}songfinder\n` +
            "You can also add a direct audio or video link after the command."
        );
      }

      let inputPath = null;

      if (attachment) {
        const ext = guessExt(attachment.url) || ".media";
        inputPath = path.join(workDir, `input${ext}`);
        await downloadToFile(attachment.url, inputPath);
      } else {
        const base = path.join(workDir, "input");

        if (isPlatformUrl(urlArg)) {
          await detectTools();
          if (!ytdlpReady) {
            throw publicError(
              "❌ This link cannot be processed right now. Please reply with the audio or video instead."
            );
          }
          try {
            inputPath = await ytdlpDownload(urlArg, base);
          } catch (_) {
            throw publicError("❌ Could not download audio from that link.");
          }
        } else if (MEDIA_EXT_RE.test(urlArg)) {
          inputPath = `${base}${guessExt(urlArg)}`;
          await downloadToFile(urlArg, inputPath);
        } else {
          await detectTools();
          let downloaded = false;

          if (ytdlpReady) {
            try {
              inputPath = await ytdlpDownload(urlArg, base);
              downloaded = true;
            } catch (_) {}
          }

          if (!downloaded) {
            inputPath = `${base}${guessExt(urlArg) || ".media"}`;
            const file = await downloadToFile(urlArg, inputPath);
            if (
              !/^(audio|video|application\/octet-stream|binary\/octet-stream)/i.test(
                file.contentType
              )
            ) {
              throw publicError("❌ That link does not point to an audio or video file.");
            }
          }
        }
      }

      const clipPath = path.join(workDir, "clip.mp3");
      await makeClip(inputPath, clipPath);

      const { status, data } = await recognizeFile(clipPath);

      if (status === 429) {
        return message.reply("⛔ Daily recognition limit reached. Try again tomorrow.");
      }

      if (status === 503) {
        return message.reply(
          "⚠️ Recognition is temporarily unavailable. Try a 10–25 second clip and try again."
        );
      }

      if (status < 200 || status >= 300 || !data || typeof data !== "object") {
        return message.reply("❌ Recognition failed. Please try again with another clip.");
      }

      if (data.success && data.track) {
        return sendTrack(message, data.track);
      }

      if (data.noMatch) {
        return message.reply(
          "🤷 𝐍𝐨 𝐦𝐚𝐭𝐜𝐡 𝐟𝐨𝐮𝐧𝐝.\n\n" +
            "Try a clear 10–25 second clip with less background noise."
        );
      }

      return message.reply("❌ Could not recognize the song. Please try again with another clip.");
    } catch (error) {
      console.error("[songfinder]", error?.message || error);
      return message.reply(error?.publicMessage || "❌ Something went wrong. Please try again.");
    } finally {
      setTimeout(() => {
        fs.remove(workDir).catch(() => {});
      }, 60000);
    }
  }
};
