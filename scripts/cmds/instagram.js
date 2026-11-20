"use strict";

const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

const defaultQueries = [
  "anime 4k edit",
  "anime amv edit",
  "anime edit",
  "naruto anime edit",
  "gojo anime edit",
  "one piece anime edit",
  "demon slayer anime edit",
  "solo leveling anime edit"
];

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TEMP_DIR = path.join(__dirname, "cache");
const MAX_SIZE = 45 * 1024 * 1024;
const RECENT_LIMIT = 40;
const recentIds = [];

const ANIME_WORDS = [
  "anime", "amv", "edit", "manga", "otaku", "naruto", "sasuke", "goku", "gojo", "sukuna",
  "luffy", "zoro", "ichigo", "eren", "levi", "mikasa", "tanjiro", "nezuko", "itachi",
  "madara", "one piece", "bleach", "jujutsu", "jjk", "demon slayer", "aot", "dragon ball",
  "chainsaw", "tokyo ghoul", "hunter", "killua", "hisoka", "satoru", "toji", "phonk",
  "4k", "aura", "mha", "deku", "bakugo", "solo leveling", "jinwoo"
];

function rememberId(id) {
  if (!id) return;
  const index = recentIds.indexOf(id);
  if (index !== -1) recentIds.splice(index, 1);
  recentIds.push(id);
  while (recentIds.length > RECENT_LIMIT) recentIds.shift();
}

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

function normalizeInstagramUrl(input) {
  let url = String(input || "").trim();
  if (!url) return "";
  try { url = decodeURIComponent(url); } catch (_) {}
  url = decodeHtml(url).replace(/[),.!?]+$/g, "");
  const match = url.match(/instagram\.com\/(reel|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (!match) return "";
  const type = match[1].toLowerCase();
  const code = match[2];
  return `https://www.instagram.com/${type}/${code}/`;
}

function shortcodeFromUrl(url) {
  const match = String(url || "").match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : "";
}

function extractInstagramUrls(text) {
  const out = new Set();
  const source = decodeHtml(String(text || ""));

  for (const match of source.matchAll(/uddg=([^"&\s>\]]+)/g)) {
    let decoded = match[1];
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    const normalized = normalizeInstagramUrl(decoded);
    if (normalized) out.add(normalized);
  }

  for (const match of source.matchAll(/https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:reel|p|tv)\/[A-Za-z0-9_-]+\/?[^\s"'<>\\\])]*/gi)) {
    const normalized = normalizeInstagramUrl(match[0]);
    if (normalized) out.add(normalized);
  }

  for (const match of source.matchAll(/https?%3A%2F%2F(?:www\.|m\.)?instagram\.com%2F(?:reel|p|tv)%2F[A-Za-z0-9_-]+/gi)) {
    let decoded = match[0];
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    const normalized = normalizeInstagramUrl(decoded);
    if (normalized) out.add(normalized);
  }

  for (const match of source.matchAll(/instagram\.com(?:%2F|\/)(?:reel|p|tv)(?:%2F|\/)[A-Za-z0-9_-]+/gi)) {
    let decoded = match[0];
    try { decoded = decodeURIComponent(decoded); } catch (_) {}
    const normalized = normalizeInstagramUrl(`https://www.${decoded.replace(/^https?:\/\//i, "").replace(/^www\./i, "")}`);
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
  if (!text || text.length < 300) return "";
  if (/challenge|captcha|anubis|Just a moment/i.test(text.slice(0, 500)) && !/instagram\.com\/(?:reel|p|tv)\//i.test(text)) return "";
  return text;
}

function queryTerms(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !["anime", "edit", "video", "reel", "reels"].includes(w));
}

async function searchInstagramVideos(query) {
  const terms = [
    `site:instagram.com/reel anime ${query}`,
    `site:instagram.com/reel ${query} anime edit`,
    `site:instagram.com/p anime ${query} video`,
    `site:instagram.com ${query} anime reel`
  ];

  const found = new Set();

  for (const term of terms) {
    const q = encodeURIComponent(term);
    const sources = [
      `https://r.jina.ai/http://html.duckduckgo.com/html/?q=${q}`,
      `https://html.duckduckgo.com/html/?q=${q}`,
      `https://r.jina.ai/http://lite.duckduckgo.com/lite/?q=${q}`
    ];

    for (let i = 0; i < sources.length; i++) {
      try {
        const html = await fetchSearchPage(sources[i], i === 0 || i === 2 ? { headers: { referer: "https://r.jina.ai/" } } : {});
        for (const url of extractInstagramUrls(html)) found.add(url);
      } catch (_) {}
      if (found.size >= 10) break;
    }

    if (found.size >= 15) break;
  }

  return [...found];
}

async function fetchOEmbed(url) {
  try {
    const endpoint = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}`;
    const response = await axios.get(endpoint, {
      timeout: 15000,
      headers: {
        "user-agent": BROWSER_UA,
        "accept": "application/json, text/plain, */*"
      },
      validateStatus: () => true
    });
    if (response.status === 200 && response.data && typeof response.data === "object") return response.data;
  } catch (_) {}

  try {
    const endpoint = `https://www.instagram.com/oembed/?url=${encodeURIComponent(url)}`;
    const response = await axios.get(endpoint, {
      timeout: 15000,
      headers: {
        "user-agent": BROWSER_UA,
        "accept": "application/json, text/plain, */*"
      },
      validateStatus: () => true
    });
    if (response.status === 200 && response.data && typeof response.data === "object") return response.data;
  } catch (_) {}

  return null;
}

function isRelevantAnimeVideo(meta, query, url) {
  const text = `${meta?.title || ""} ${meta?.author_name || ""} ${meta?.author_url || ""} ${url || ""}`.toLowerCase();
  const hasAnime = ANIME_WORDS.some(word => text.includes(word));
  if (!hasAnime) return false;

  const terms = queryTerms(query);
  if (!terms.length) return true;
  return terms.some(term => text.includes(term));
}

function allowWithoutMeta(query) {
  return queryTerms(query).length === 0;
}

async function resolveFastDl(url) {
  try {
    const response = await axios.post("https://fastdl.app/api/convert", { target_url: url }, {
      timeout: 25000,
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/plain, */*",
        "user-agent": BROWSER_UA,
        "origin": "https://fastdl.app",
        "referer": "https://fastdl.app/en5IW",
        "x-requested-with": "XMLHttpRequest"
      },
      validateStatus: () => true
    });

    if (response.status !== 200 || !response.data) return "";
    const data = response.data;

    const directCandidates = [
      data.url,
      data.download_url,
      data.downloadUrl,
      data.video,
      data.video_url,
      data.videoUrl,
      data.result && data.result.url,
      data.result && data.result.video,
      data.result && data.result.download_url
    ];
    for (const c of directCandidates) {
      if (typeof c === "string" && /^https?:\/\//i.test(c) && /\.(mp4|m4v)(\?|$)/i.test(c)) return c;
    }

    const medias = Array.isArray(data.medias) ? data.medias : (Array.isArray(data.result && data.result.medias) ? data.result.medias : []);
    for (const m of medias) {
      const u = m && (m.url || m.download_url || m.downloadUrl);
      if (typeof u === "string" && /^https?:\/\//i.test(u)) return u;
    }

    const text = JSON.stringify(data);
    const match = text.match(/https?:\/\/[^"'\\\s]+\.mp4[^"'\\\s]*/i);
    if (match) return match[0].replace(/\\u0026/g, "&").replace(/\\/g, "");
  } catch (_) {}

  return "";
}

async function resolveAutoApi(url) {
  try {
    const response = await axios.get("https://xsaim8x-xxx-api.onrender.com/api/auto", {
      params: { url },
      timeout: 30000,
      headers: { "user-agent": BROWSER_UA, accept: "application/json, text/plain, */*" },
      validateStatus: () => true
    });
    if (response.status !== 200 || !response.data) return "";
    const data = response.data;
    const media = data.high_quality || data.low_quality || data.url || data.video || data.download || data.link;
    if (typeof media === "string" && /^https?:\/\//i.test(media)) return media;
  } catch (_) {}
  return "";
}

async function resolveDownloadUrl(instagramUrl) {
  const fastdl = await resolveFastDl(instagramUrl);
  if (fastdl) return fastdl;
  const auto = await resolveAutoApi(instagramUrl);
  if (auto) return auto;
  return "";
}

async function downloadVideo(url, destination) {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 120000,
    maxContentLength: MAX_SIZE,
    maxBodyLength: MAX_SIZE,
    headers: {
      "user-agent": BROWSER_UA,
      "accept": "*/*",
      "referer": "https://www.instagram.com/"
    },
    validateStatus: status => status >= 200 && status < 300
  });

  const declaredSize = Number(response.headers["content-length"] || 0);
  if (declaredSize > MAX_SIZE) {
    response.data.destroy();
    throw new Error("Video too large");
  }

  const writer = fs.createWriteStream(destination);
  let bytes = 0;
  let tooLarge = false;

  await new Promise((resolve, reject) => {
    response.data.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_SIZE && !tooLarge) {
        tooLarge = true;
        response.data.destroy();
        writer.destroy();
        reject(new Error("Video too large"));
      }
    });
    response.data.on("error", reject);
    writer.on("error", reject);
    writer.on("finish", resolve);
    response.data.pipe(writer);
  });

  if (tooLarge) {
    await fs.remove(destination).catch(() => {});
    throw new Error("Video too large");
  }

  const stat = await fs.stat(destination).catch(() => null);
  if (!stat || !stat.size) {
    await fs.remove(destination).catch(() => {});
    throw new Error("Empty file");
  }

  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  if (contentType && !/^(video\/|application\/mp4|application\/octet-stream|binary\/octet-stream)/.test(contentType)) {
    await fs.remove(destination).catch(() => {});
    throw new Error("Not a video");
  }
}

module.exports = {
  config: {
    name: "instagram",
    aliases: ["ig"],
    version: "1.0.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤",
    role: 0,
    shortDescription: "Search and send anime videos from Instagram",
    longDescription: "Searches Instagram for anime videos matching your query and sends the video.",
    category: "anime",
    guide: { en: "{p}ig [search query]" }
  },

  onStart: async function ({ api, event, args }) {
    let query = args.join(" ").trim();

    if (!query) {
      query = defaultQueries[Math.floor(Math.random() * defaultQueries.length)];
    } else {
      query = `anime ${query}`;
    }

    api.setMessageReaction("🏯", event.messageID, () => {}, true);

    const workDir = path.join(TEMP_DIR, `ig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const filePath = path.join(workDir, "video.mp4");

    try {
      await fs.ensureDir(workDir);

      const urls = await searchInstagramVideos(query);
      const unique = [];
      const seen = new Set();

      for (const url of urls) {
        const id = shortcodeFromUrl(url);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        unique.push({ url, id });
      }

      const fresh = unique.filter(item => !recentIds.includes(item.id));
      const pool = shuffle(fresh.length ? fresh : unique).slice(0, 20);

      if (!pool.length) throw new Error("No anime videos found");

      let downloaded = false;
      let selectedId = "";

      for (const candidate of pool) {
        const meta = await fetchOEmbed(candidate.url);
        if (meta) {
          if (!isRelevantAnimeVideo(meta, query, candidate.url)) continue;
        } else {
          if (!allowWithoutMeta(query)) {
            // search was already targeted to anime + user query; accept when metadata is unavailable
          }
        }

        const source = await resolveDownloadUrl(candidate.url);
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

      if (downloaded && selectedId) rememberId(selectedId);
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
      console.error("IG Error:", error.message);
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      api.sendMessage("❌ Failed to fetch anime video, please try again!", event.threadID, event.messageID);
      await fs.remove(workDir).catch(() => {});
    }
  }
};
