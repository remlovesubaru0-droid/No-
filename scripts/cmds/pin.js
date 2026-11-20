"use strict";

const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const execFileAsync = promisify(execFile);

const SEARCH_URL = "https://www.pinterest.com/resource/BaseSearchResource/get/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TEMP_DIR = path.join(__dirname, "cache");
const RESULT_COUNT = 6;
const SESSION_MS = 10 * 60 * 1000;
const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
const MAX_VIDEO_SIZE = 45 * 1024 * 1024;
const MAX_VIDEO_DURATION = 300000;

const SEARCH_HEADERS = {
  "user-agent": USER_AGENT,
  accept: "application/json, text/javascript, */*; q=0.01",
  "accept-language": "en-US,en;q=0.9",
  "x-pinterest-appstate": "active",
  "x-pinterest-pws-handler": "www/search/pins.js",
  "x-requested-with": "XMLHttpRequest"
};

const DOWNLOAD_HEADERS = {
  "user-agent": USER_AGENT,
  accept: "*/*",
  referer: "https://www.pinterest.com/"
};

function publicError(message) {
  const error = new Error(message);
  error.publicMessage = message;
  return error;
}

function sizeError(kind) {
  const error = publicError(
    kind === "image"
      ? "⚠️ This image is too large to send in chat."
      : "⚠️ This video is too large to send in chat."
  );
  error.tooLarge = true;
  return error;
}

async function searchPins(query, videoMode) {
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}`;
  const payload = JSON.stringify({
    options: {
      query,
      scope: videoMode ? "videos" : "pins",
      page: null,
      page_size: 24,
      bookmarks: [],
      top_pin_id: null,
      top_pin_ids: null,
      filters: "",
      appliedProductFilters: "---",
      price_max: null,
      price_min: null,
      selected_guide: null,
      article: null
    },
    context: {}
  });
  const url = `${SEARCH_URL}?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(payload)}`;
  const response = await axios.get(url, {
    timeout: 30000,
    headers: {
      ...SEARCH_HEADERS,
      referer: `https://www.pinterest.com${sourceUrl}`
    },
    validateStatus: () => true
  });

  if (response.status !== 200 || !response.data) {
    throw publicError("❌ Search failed. Please try again.");
  }

  const results = response.data?.resource_response?.data?.results;
  if (!Array.isArray(results)) {
    throw publicError("❌ Search failed. Please try again.");
  }

  return results;
}

function cleanTitle(pin) {
  const raw = pin?.title || pin?.grid_title || pin?.seo_alt_text || pin?.description || "";
  const text = String(raw)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bpinterest\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "Untitled";
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function videoInfo(pin) {
  const list = pin?.videos?.video_list;
  if (!list || typeof list !== "object") return null;

  const entries = Object.values(list).filter(
    value =>
      value &&
      typeof value === "object" &&
      typeof value.url === "string" &&
      /^https?:\/\//i.test(value.url)
  );

  if (!entries.length) return null;

  const hls = entries.find(value => /\.m3u8(?:$|\?)/i.test(value.url));
  const chosen = hls || entries[0];
  const durationEntry = entries.find(value => Number(value.duration) > 0);
  const duration = Number(chosen.duration) || Number(durationEntry?.duration) || 0;
  const thumbnail =
    chosen.thumbnail ||
    entries.find(value => value.thumbnail)?.thumbnail ||
    pin?.images?.["474x"]?.url ||
    pin?.images?.["236x"]?.url ||
    pin?.images?.orig?.url ||
    "";

  return {
    url: chosen.url,
    isHls: /\.m3u8(?:$|\?)/i.test(chosen.url),
    duration,
    thumbnail
  };
}

function normalizeResults(results, videoMode) {
  const items = [];
  const seen = new Set();

  for (const pin of results) {
    if (!pin || pin.type !== "pin" || pin.is_promoted) continue;

    const id = String(pin.id || pin.node_id || "");
    if (!id || seen.has(id)) continue;

    if (videoMode) {
      const video = videoInfo(pin);
      if (!video || !video.duration || video.duration > MAX_VIDEO_DURATION) continue;

      seen.add(id);
      items.push({
        id,
        title: cleanTitle(pin),
        thumbnail: video.thumbnail,
        videoUrl: video.url,
        isHls: video.isHls,
        duration: video.duration
      });
    } else {
      if (pin.videos) continue;

      const image =
        pin?.images?.orig?.url ||
        pin?.images?.["736x"]?.url ||
        pin?.images?.["474x"]?.url ||
        "";

      if (!image) continue;

      seen.add(id);
      items.push({
        id,
        title: cleanTitle(pin),
        thumbnail: pin?.images?.["474x"]?.url || pin?.images?.["236x"]?.url || image,
        image
      });
    }

    if (items.length >= RESULT_COUNT) break;
  }

  return items;
}

async function fetchText(url) {
  const response = await axios.get(url, {
    timeout: 30000,
    headers: DOWNLOAD_HEADERS,
    validateStatus: status => status >= 200 && status < 300
  });
  return String(response.data || "");
}

async function fetchStream(url) {
  if (global.utils && typeof global.utils.getStreamFromURL === "function") {
    return await global.utils.getStreamFromURL(url);
  }

  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 30000,
    headers: DOWNLOAD_HEADERS,
    validateStatus: status => status >= 200 && status < 300
  });
  return response.data;
}

async function downloadFile(url, destination, maxSize, kind) {
  let response;

  try {
    response = await axios.get(url, {
      responseType: "stream",
      timeout: 120000,
      maxContentLength: maxSize,
      maxBodyLength: maxSize,
      headers: DOWNLOAD_HEADERS,
      validateStatus: status => status >= 200 && status < 300
    });
  } catch (error) {
    if (/maxContentLength/i.test(String(error?.message || ""))) throw sizeError(kind);
    throw publicError(
      kind === "image" ? "❌ Could not download this image." : "❌ Could not download this video."
    );
  }

  const declared = Number(response.headers["content-length"] || 0);
  if (declared > maxSize) {
    response.data.destroy();
    throw sizeError(kind);
  }

  let bytes = 0;
  let tooLarge = false;

  const counter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxSize) {
        tooLarge = true;
        callback(new Error("File too large"));
        return;
      }
      callback(null, chunk);
    }
  });

  try {
    await pipeline(response.data, counter, fs.createWriteStream(destination));
  } catch (_) {
    await fs.remove(destination).catch(() => {});
    if (tooLarge) throw sizeError(kind);
    throw publicError(
      kind === "image" ? "❌ Could not download this image." : "❌ Could not download this video."
    );
  }

  const stat = await fs.stat(destination).catch(() => null);
  if (!stat || !stat.size) {
    await fs.remove(destination).catch(() => {});
    throw publicError(
      kind === "image" ? "❌ The downloaded image is empty." : "❌ The downloaded video is empty."
    );
  }

  return String(response.headers["content-type"] || "");
}

function parseVariants(playlist, baseUrl) {
  const lines = playlist.split(/\r?\n/);
  const variants = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;

    let uri = "";
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next].trim();
      if (!candidate || candidate.startsWith("#")) continue;
      uri = candidate;
      break;
    }

    if (!uri) continue;

    const attrs = line.slice(line.indexOf(":") + 1);
    const bandwidth = Number((attrs.match(/BANDWIDTH=(\d+)/i) || [])[1]) || 0;
    const resolution = attrs.match(/RESOLUTION=(\d+)x(\d+)/i);

    variants.push({
      url: new URL(uri, baseUrl).toString(),
      bandwidth,
      width: Number(resolution?.[1]) || 0,
      height: Number(resolution?.[2]) || 0
    });
  }

  return variants;
}

function orderVariants(variants, duration) {
  if (!variants.length) return [];

  const seconds = Math.max(1, Math.round(Number(duration) / 1000));
  const estimated = variants.map(variant => ({
    ...variant,
    estimate: variant.bandwidth ? (variant.bandwidth / 8) * seconds : 0
  }));
  const fitting = estimated.filter(
    variant => !variant.estimate || variant.estimate <= MAX_VIDEO_SIZE
  );
  const pool = fitting.length ? fitting : estimated;

  return pool.sort((a, b) => {
    const aScore = a.width ? Math.abs(720 - a.width) : Number.MAX_SAFE_INTEGER;
    const bScore = b.width ? Math.abs(720 - b.width) : Number.MAX_SAFE_INTEGER;
    return aScore - bScore || (b.bandwidth || 0) - (a.bandwidth || 0);
  });
}

function mapUri(playlist) {
  for (const line of playlist.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-MAP:")) continue;
    const match = line.match(/URI="([^"]+)"/i);
    if (match) return match[1];
  }
  return "";
}

function audioUri(master) {
  for (const line of master.split(/\r?\n/)) {
    if (!line.startsWith("#EXT-X-MEDIA:") || !/TYPE=AUDIO/i.test(line)) continue;
    const match = line.match(/URI="([^"]+)"/i);
    if (match) return match[1];
  }
  return "";
}

async function ffmpegMux(videoInput, audioInput, output) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoInput,
      "-i",
      audioInput,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output
    ],
    { timeout: 180000 }
  );
}

async function ffmpegMuxStream(videoInput, audioUrl, output) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      videoInput,
      "-user_agent",
      USER_AGENT,
      "-i",
      audioUrl,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output
    ],
    { timeout: 180000 }
  );
}

async function ffmpegSingle(input, output) {
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output
    ],
    { timeout: 180000 }
  );
}

async function downloadVideo(item, workDir) {
  const videoPath = path.join(workDir, "video.mp4");

  if (!item.isHls) {
    await downloadFile(item.videoUrl, videoPath, MAX_VIDEO_SIZE, "video");
    return videoPath;
  }

  const master = await fetchText(item.videoUrl);
  const variants = orderVariants(parseVariants(master, item.videoUrl), item.duration);
  const candidates = variants.length ? variants.slice(0, 3) : [{ url: item.videoUrl }];
  const audioRelative = audioUri(master);
  let lastError = null;

  for (const candidate of candidates) {
    const sourcePath = path.join(workDir, "source.cmfv");
    const audioPath = path.join(workDir, "audio.cmfa");

    try {
      const playlist = await fetchText(candidate.url);
      const videoMap = mapUri(playlist);
      const audioPlaylistUrl = audioRelative
        ? new URL(audioRelative, item.videoUrl).toString()
        : "";
      let audioMapUrl = "";

      if (audioPlaylistUrl) {
        try {
          const audioPlaylist = await fetchText(audioPlaylistUrl);
          const audioMap = mapUri(audioPlaylist);
          if (audioMap) audioMapUrl = new URL(audioMap, audioPlaylistUrl).toString();
        } catch (_) {
          audioMapUrl = "";
        }
      }

      if (videoMap) {
        await downloadFile(
          new URL(videoMap, candidate.url).toString(),
          sourcePath,
          MAX_VIDEO_SIZE,
          "video"
        );

        if (audioMapUrl) {
          try {
            await downloadFile(audioMapUrl, audioPath, MAX_VIDEO_SIZE, "video");
            await ffmpegMux(sourcePath, audioPath, videoPath);
          } catch (error) {
            if (error?.tooLarge) throw error;
            await fs.remove(videoPath).catch(() => {});
            await ffmpegSingle(sourcePath, videoPath);
          }
        } else if (audioPlaylistUrl) {
          try {
            await ffmpegMuxStream(sourcePath, audioPlaylistUrl, videoPath);
          } catch (_) {
            await fs.remove(videoPath).catch(() => {});
            await ffmpegSingle(sourcePath, videoPath);
          }
        } else {
          await ffmpegSingle(sourcePath, videoPath);
        }
      } else {
        const args = [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-user_agent",
          USER_AGENT,
          "-i",
          candidate.url
        ];

        if (audioPlaylistUrl) {
          args.push("-i", audioPlaylistUrl, "-map", "0:v:0", "-map", "1:a:0?");
        }

        args.push("-c", "copy", "-movflags", "+faststart", videoPath);
        await execFileAsync("ffmpeg", args, { timeout: 180000 });
      }

      const stat = await fs.stat(videoPath).catch(() => null);
      if (!stat || !stat.size) throw publicError("❌ Could not prepare this video.");
      return videoPath;
    } catch (error) {
      lastError = error;
      await fs.remove(sourcePath).catch(() => {});
      await fs.remove(audioPath).catch(() => {});
      await fs.remove(videoPath).catch(() => {});
      if (!error?.tooLarge) break;
    }
  }

  throw lastError || publicError("❌ Could not download this video.");
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function buildListBody(query, items, videoMode) {
  const shown = query.length > 80 ? `${query.slice(0, 77)}...` : query;
  const lines = items.map((item, index) => {
    const suffix =
      videoMode && item.duration ? ` (${formatDuration(item.duration / 1000)})` : "";
    return `${index + 1}. ${item.title}${suffix}`;
  });

  return [
    `${videoMode ? "🎬 Video" : "🖼️ Image"} results for "${shown}"`,
    "━━━━━━━━━━━━━━",
    ...lines,
    "━━━━━━━━━━━━━━",
    `Reply with a number from 1 to ${items.length} to get your ${videoMode ? "video" : "image"}.`
  ].join("\n");
}

function buildMediaCaption(item, videoMode) {
  const lines = [];

  if (item.title && item.title !== "Untitled") {
    lines.push(`${videoMode ? "🎬" : "🖼️"} ${item.title}`);
  } else {
    lines.push(videoMode ? "🎬 Here is your video." : "🖼️ Here is your image.");
  }

  if (videoMode && item.duration) {
    lines.push(`⏱️ ${formatDuration(item.duration / 1000)}`);
  }

  return lines.join("\n");
}

function extensionForType(contentType) {
  if (/png/i.test(contentType)) return ".png";
  if (/webp/i.test(contentType)) return ".webp";
  if (/gif/i.test(contentType)) return ".gif";
  return ".jpg";
}

async function loadThumbnails(items) {
  const streams = await Promise.all(
    items.map(async item => {
      if (!item.thumbnail) return null;
      try {
        return await fetchStream(item.thumbnail);
      } catch (_) {
        return null;
      }
    })
  );

  return streams.filter(Boolean);
}

module.exports = {
  config: {
    name: "pin",
    aliases: ["pins", "pinsearch"],
    version: "1.0.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤",
    countDown: 10,
    role: 0,
    shortDescription: "Search and send images or videos",
    longDescription: "Search for images or videos by keyword and choose a result by number.",
    category: "media",
    guide: {
      en: "{p}pin <search query>\n{p}pin -v <search query>"
    }
  },

  onStart: async function ({ api, event, message, args, prefix }) {
    const { threadID, messageID } = event;
    const parts = [...args];
    let videoMode = false;

    if (parts[0] && /^(?:-v|--video)$/i.test(parts[0])) {
      videoMode = true;
      parts.shift();
    }

    const query = parts
      .join(" ")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s+/g, " ");

    if (!query) {
      return message.reply(
        `⚠️ Please enter a search query.\n` +
          `Example: ${prefix || ""}pin cat aesthetic\n` +
          `For videos: ${prefix || ""}pin -v nature`
      );
    }

    try {
      const results = await searchPins(query, videoMode);
      const items = normalizeResults(results, videoMode);

      if (!items.length) {
        return message.reply("❌ No results found. Please try a different search.");
      }

      const thumbnails = await loadThumbnails(items);
      const body = buildListBody(query, items, videoMode);
      let info;

      if (thumbnails.length) {
        try {
          info = await api.sendMessage(
            { body, attachment: thumbnails },
            threadID,
            undefined,
            messageID
          );
        } catch (_) {
          for (const stream of thumbnails) {
            try {
              stream.destroy();
            } catch (_) {}
          }
          info = await api.sendMessage(body, threadID, undefined, messageID);
        }
      } else {
        info = await api.sendMessage(body, threadID, undefined, messageID);
      }

      if (!info || !info.messageID) return;

      const replyData = {
        commandName: this.config.name,
        messageID: info.messageID,
        author: event.senderID,
        items,
        videoMode,
        expiresAt: Date.now() + SESSION_MS
      };

      if (global.GoatBot && global.GoatBot.onReply) {
        global.GoatBot.onReply.set(info.messageID, replyData);

        const timer = setTimeout(() => {
          const store = global.GoatBot?.onReply;
          if (store && store.get(info.messageID) === replyData) {
            store.delete(info.messageID);
          }
        }, SESSION_MS);

        if (timer.unref) timer.unref();
      }
    } catch (error) {
      console.error("[pin]", error?.message || error);
      return message.reply(error?.publicMessage || "❌ Search failed. Please try again.");
    }
  },

  onReply: async function ({ api, event, message, Reply }) {
    const { threadID, messageID } = event;

    if (String(event.senderID) !== String(Reply.author)) {
      return message.reply("⚠️ This selection belongs to someone else. Please run the command yourself.");
    }

    if (Date.now() > Reply.expiresAt) {
      if (global.GoatBot && global.GoatBot.onReply) {
        global.GoatBot.onReply.delete(Reply.messageID);
      }
      return message.reply("⌛ This selection has expired. Please search again.");
    }

    const choice = Number(String(event.body || "").trim());
    if (!Number.isInteger(choice) || choice < 1 || choice > Reply.items.length) {
      return message.reply(`❌ Please reply with a number from 1 to ${Reply.items.length}.`);
    }

    const item = Reply.items[choice - 1];

    if (global.GoatBot && global.GoatBot.onReply) {
      global.GoatBot.onReply.delete(Reply.messageID);
    }

    const workDir = path.join(
      TEMP_DIR,
      `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );

    try {
      await fs.ensureDir(workDir);

      if (api.setMessageReaction) {
        api.setMessageReaction("⏳", messageID, () => {}, true);
      }

      let filePath;
      let caption;

      if (Reply.videoMode) {
        filePath = await downloadVideo(item, workDir);
        caption = buildMediaCaption(item, true);
      } else {
        const rawPath = path.join(workDir, "image.bin");
        const contentType = await downloadFile(item.image, rawPath, MAX_IMAGE_SIZE, "image");

        if (contentType && !/^image\//i.test(contentType)) {
          throw publicError("❌ The selection did not return an image.");
        }

        filePath = path.join(workDir, `image${extensionForType(contentType)}`);
        await fs.move(rawPath, filePath, { overwrite: true });
        caption = buildMediaCaption(item, false);
      }

      await api.sendMessage(
        { body: caption, attachment: fs.createReadStream(filePath) },
        threadID,
        undefined,
        messageID
      );

      if (api.setMessageReaction) {
        api.setMessageReaction("✅", messageID, () => {}, true);
      }
    } catch (error) {
      console.error("[pin]", error?.message || error);

      if (api.setMessageReaction) {
        api.setMessageReaction("❌", messageID, () => {}, true);
      }

      return message.reply(error?.publicMessage || "❌ Something went wrong. Please try again.");
    } finally {
      const timer = setTimeout(() => {
        fs.remove(workDir).catch(() => {});
      }, 120000);

      if (timer.unref) timer.unref();
    }
  }
};
