"use strict";

const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");

const defaultQueries = [
  "anime 4k edit",
  "anime 4k edits",
  "anime x phonk",
  "goku aura",
  "anime aliya 4k editz",
  "anime amv 4k",
  "best anime edit"
];

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SNAP_ORIGIN = "https://snaptik.app";
const SNAP_PAGE = `${SNAP_ORIGIN}/en3`;
const SNAP_KEY = "sn4pt1k_v3r1fy2026";
const TEMP_DIR = path.join(__dirname, "cache");
const MAX_SIZE = 45 * 1024 * 1024;
const RECENT_LIMIT = 40;
const recentVideoIds = [];

function rememberVideo(id) {
  if (!id) return;
  const index = recentVideoIds.indexOf(id);
  if (index !== -1) recentVideoIds.splice(index, 1);
  recentVideoIds.push(id);
  while (recentVideoIds.length > RECENT_LIMIT) recentVideoIds.shift();
}

function videoIdFromUrl(url) {
  const match = String(url || "").match(/\/video\/(\d{15,25})/);
  return match ? match[1] : "";
}

const ANIME_WORDS = [
  "anime", "amv", "edit", "manga", "otaku", "naruto", "sasuke", "goku", "gojo", "sukuna",
  "luffy", "zoro", "ichigo", "eren", "levi", "mikasa", "tanjiro", "nezuko", "itachi",
  "madara", "one piece", "bleach", "jujutsu", "jjk", "demon slayer", "aot", "dragon ball",
  "chainsaw", "tokyo ghoul", "hunter", "killua", "hisoka", "satoru", "toji", "phonk",
  "4k", "aura", "mha", "deku", "bakugo", "solo leveling", "jinwoo"
];

function shuffle(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeTikTokUrl(input) {
  let url = String(input || "").trim();
  if (!url) return "";
  try {
    url = decodeURIComponent(url);
  } catch (_) {}
  url = decodeHtml(url).replace(/[),.!?]+$/g, "");
  const idMatch = url.match(/\/video\/(\d{15,25})/);
  if (!idMatch) return "";
  const id = idMatch[1];
  const userMatch = url.match(/\/@([^/?#]+)\/video\//);
  const user = userMatch && userMatch[1] && userMatch[1] !== "" ? userMatch[1] : "_";
  return `https://www.tiktok.com/@${user}/video/${id}`;
}

function extractVideoUrlsFromText(text) {
  const out = new Set();
  const source = String(text || "");

  for (const match of source.matchAll(/uddg=([^"&\s)\]]+)/g)) {
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(decoded);
    } catch (_) {}
    const normalized = normalizeTikTokUrl(decoded);
    if (normalized) out.add(normalized);
  }

  for (const match of source.matchAll(/https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[^\s"'<>\\\])]+/g)) {
    const normalized = normalizeTikTokUrl(match[0]);
    if (normalized) out.add(normalized);
  }

  for (const match of source.matchAll(/tiktok\.com\/@[^\/\s"'<>\\\])]+\/video\/\d{15,25}/g)) {
    const normalized = normalizeTikTokUrl(`https://www.${match[0].replace(/^www\./, "")}`);
    if (normalized) out.add(normalized);
  }

  for (const match of source.matchAll(/tiktok\.com\/(?:@\/)?video\/\d{15,25}/g)) {
    const normalized = normalizeTikTokUrl(`https://www.tiktok.com/${match[0].replace(/^tiktok\.com\//, "")}`);
    if (normalized) out.add(normalized);
  }

  return [...out];
}

async function fetchSearchPage(url, options = {}) {
  const response = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      "user-agent": BROWSER_UA,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "referer": "https://duckduckgo.com/",
      ...(options.headers || {})
    },
    responseType: "text",
    transformResponse: [data => data],
    validateStatus: () => true
  });

  if (response.status < 200 || response.status >= 300) return "";
  const text = typeof response.data === "string" ? response.data : String(response.data || "");
  if (!text || text.length < 500) return "";
  if (/challenge|captcha|anubis|Just a moment/i.test(text.slice(0, 500)) && !/uddg=|\/video\//.test(text)) return "";
  return text;
}

async function searchTikTokVideos(query) {
  const terms = [
    `site:tiktok.com anime ${query} amv edit`,
    `site:tiktok.com/@ anime ${query} edit video`,
    `site:tiktok.com anime ${query} 4k`
  ];

  const found = new Set();

  for (const term of terms) {
    const q = encodeURIComponent(term);
    const direct = `https://html.duckduckgo.com/html/?q=${q}`;
    const jina = `https://r.jina.ai/http://html.duckduckgo.com/html/?q=${q}`;

    try {
      const html = await fetchSearchPage(direct);
      for (const url of extractVideoUrlsFromText(html)) found.add(url);
    } catch (_) {}

    if (found.size < 6) {
      try {
        const proxied = await fetchSearchPage(jina, { headers: { referer: "https://r.jina.ai/" } });
        for (const url of extractVideoUrlsFromText(proxied)) found.add(url);
      } catch (_) {}
    }

    if (found.size >= 12) break;
  }

  return [...found];
}

async function fetchOEmbed(url) {
  try {
    const response = await axios.get("https://www.tiktok.com/oembed", {
      timeout: 15000,
      params: { url },
      headers: {
        "user-agent": BROWSER_UA,
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9"
      },
      validateStatus: () => true
    });

    if (response.status !== 200 || !response.data || typeof response.data !== "object") return null;
    return response.data;
  } catch (_) {
    return null;
  }
}

function isAnimeVideo(meta, query) {
  const text = `${meta?.title || ""} ${meta?.author_name || ""} ${meta?.author_url || ""} ${query || ""}`.toLowerCase();
  return ANIME_WORDS.some(word => text.includes(word));
}

function solveChallenge(id, payload) {
  const buffer = Buffer.from(String(payload), "base64");
  if (buffer.length < 32) throw new Error("Invalid challenge");

  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    crypto.createHash("sha256").update(`${SNAP_KEY}:${id}`).digest(),
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
  const response = await axios.post(`${SNAP_ORIGIN}/api/token`, {}, {
    timeout: 20000,
    headers: {
      "user-agent": BROWSER_UA,
      accept: "*/*",
      referer: SNAP_PAGE,
      origin: SNAP_ORIGIN,
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
    const response = await axios.get(`${SNAP_ORIGIN}/api/extract`, {
      timeout: 30000,
      params: { url },
      headers: {
        "user-agent": BROWSER_UA,
        accept: "*/*",
        referer: SNAP_PAGE,
        origin: SNAP_ORIGIN,
        "x-requested-with": "XMLHttpRequest",
        "x-verify": token
      },
      validateStatus: () => true
    });

    lastStatus = response.status;

    if (response.status === 403 && attempt === 0) continue;
    if (response.status !== 200 || !response.data) break;

    const body = response.data;
    if (body.success === false) return null;

    const data = body.data || body;
    if (data && typeof data === "object") return data;
    break;
  }

  if (lastStatus === 404) return null;
  return null;
}

function downloadHeaderHints(url) {
  try {
    const token = new URL(url).searchParams.get("token");
    if (!token) return {};
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
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
        "user-agent": BROWSER_UA,
        accept: "*/*",
        ...downloadHeaderHints(url)
      },
      validateStatus: status => status >= 200 && status < 300
    });
  } catch (_) {
    throw new Error("Download failed");
  }

  const declaredSize = Number(response.headers["content-length"] || 0);
  if (declaredSize > MAX_SIZE) {
    response.data.destroy();
    throw new Error("Video too large");
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
    if (tooLarge) throw new Error("Video too large");
    throw new Error("Download failed");
  }

  const stat = await fs.stat(destination).catch(() => null);
  if (!stat || !stat.size) {
    await fs.remove(destination).catch(() => {});
    throw new Error("Empty file");
  }

  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  if (
    contentType &&
    !/^(video\/|application\/mp4|application\/octet-stream|binary\/octet-stream)/.test(contentType)
  ) {
    await fs.remove(destination).catch(() => {});
    throw new Error("Not a video");
  }
}

function videoSource(data) {
  if (data && typeof data.downloadUrl === "string" && /^https?:\/\//i.test(data.downloadUrl)) {
    return data.downloadUrl;
  }
  return "";
}

module.exports = {
  config: {
    name: "amv",
    version: "3.0.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤",
    role: 0,
    shortDescription: "High quality anime 4K edits and AMV videos",
    longDescription: "Sends random or searched high quality 4K anime edits, phonk edits, and AMV videos.",
    category: "anime",
    guide: { en: "{p}amv [optional query]" }
  },

  onStart: async function ({ api, event, args }) {
    let query = args.join(" ").trim();

    if (!query) {
      query = defaultQueries[Math.floor(Math.random() * defaultQueries.length)];
    } else {
      query = `anime ${query}`;
    }

    api.setMessageReaction("🏯", event.messageID, () => {}, true);

    const workDir = path.join(TEMP_DIR, `amv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const filePath = path.join(workDir, "video.mp4");

    try {
      await fs.ensureDir(workDir);

      const urls = await searchTikTokVideos(query);
      const unique = [];
      const seen = new Set();

      for (const url of urls) {
        const id = videoIdFromUrl(url);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        unique.push({ url, id });
      }

      const fresh = unique.filter(item => !recentVideoIds.includes(item.id));
      const pool = shuffle(fresh.length ? fresh : unique).slice(0, 20);

      if (!pool.length) throw new Error("No anime videos found");

      let downloaded = false;
      let selectedId = "";

      for (const candidate of pool) {
        const meta = await fetchOEmbed(candidate.url);
        if (!isAnimeVideo(meta, query)) continue;

        const data = await extractVideo(candidate.url);
        if (!data) continue;

        const source = videoSource(data);
        if (!source) continue;

        try {
          await downloadVideo(source, filePath);
          downloaded = true;
          selectedId = candidate.id;
          break;
        } catch (_) {
          await fs.remove(filePath).catch(() => {});
        }
      }

      if (downloaded && selectedId) rememberVideo(selectedId);

      if (!downloaded) throw new Error("No anime videos found");

      api.setMessageReaction("🐇", event.messageID, () => {}, true);

      const infoCard =
        `╭───────────────⬣\n` +
        `│ 𝐌𝐚𝐝𝐞 𝐰𝐢𝐭𝐡 🤍 𝐛𝐲 --𝔐𝔯.𝔎𝔦𝔫𝔤\n` +
        `╰───────────────⬣`;

      api.sendMessage(
        { body: infoCard, attachment: fs.createReadStream(filePath) },
        event.threadID,
        () => fs.remove(workDir).catch(() => {}),
        event.messageID
      );
    } catch (error) {
      console.error("AMV Error:", error.message);
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      api.sendMessage("❌ Failed to fetch anime video, please try again!", event.threadID, event.messageID);
      await fs.remove(workDir).catch(() => {});
    }
  }
};
        
