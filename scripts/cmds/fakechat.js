const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const FB_TOKEN = "6628568379|c1e620fa708a1d5696fb991c1bde5662";

const FONT_FILE = "HindSiliguri-Regular.ttf";
const FONT_URLS = [
  "https://github.com/google/fonts/raw/main/ofl/hindsiliguri/HindSiliguri-Regular.ttf",
  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/hindsiliguri/HindSiliguri-Regular.ttf"
];
const FONT = '"HindSiliguri", "BeVietnam", "Noto Sans", Arial, sans-serif';
const LOCAL_FONT = path.join(__dirname, "assets", "font", "BeVietnamPro-Regular.ttf");

// Twemoji images make every emoji work on every server, including flags, skin
// tones, keycaps and ZWJ sequences. Several mirrors are tried in order.
const EMOJI_CDNS = [
  c => `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${c}.png`,
  c => `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${c}.png`,
  c => `https://unpkg.com/twemoji@14.0.2/dist/72x72/${c}.png`
];

const THEMES = {
  purple:   { top: "#241640", bottom: "#5b3f8c", accent: "#8a7bff", bubble: "#353342", header: "rgba(36,22,64,0.62)", text: "#ffffff" },
  blue:     { top: "#0b1e3a", bottom: "#1c5285", accent: "#5ca9ff", bubble: "#243245", header: "rgba(11,30,58,0.62)", text: "#ffffff" },
  ocean:    { top: "#062a35", bottom: "#0e6b73", accent: "#4fd6d1", bubble: "#1d3a40", header: "rgba(6,42,53,0.60)", text: "#ffffff" },
  green:    { top: "#0d2b20", bottom: "#2f7d54", accent: "#63d69a", bubble: "#233b31", header: "rgba(13,43,32,0.62)", text: "#ffffff" },
  forest:   { top: "#13261c", bottom: "#3e6b46", accent: "#9ad07f", bubble: "#26372b", header: "rgba(19,38,28,0.62)", text: "#ffffff" },
  rose:     { top: "#3a1526", bottom: "#9a3d63", accent: "#ff87b0", bubble: "#3d2b36", header: "rgba(58,21,38,0.62)", text: "#ffffff" },
  sunset:   { top: "#3b1d2b", bottom: "#d2683f", accent: "#ffb26b", bubble: "#422f31", header: "rgba(59,29,43,0.58)", text: "#ffffff" },
  midnight: { top: "#080b18", bottom: "#1d2440", accent: "#7b8cff", bubble: "#22263a", header: "rgba(8,11,24,0.70)", text: "#ffffff" },
  light:    { top: "#dfe7f5", bottom: "#b9c9e6", accent: "#4267b2", bubble: "#ffffff", header: "rgba(255,255,255,0.60)", text: "#1c1e21" },
  pink:     { top: "#3c1738", bottom: "#a83b8f", accent: "#ff8de1", bubble: "#3c2b3a", header: "rgba(60,23,56,0.62)", text: "#ffffff" },
  gold:     { top: "#2e2410", bottom: "#8a6a20", accent: "#ffd46b", bubble: "#383226", header: "rgba(46,36,16,0.62)", text: "#ffffff" }
};
const THEME_KEYS = Object.keys(THEMES);

let fontReady = false;
let bgBuffer = null;
const emojiCache = new Map();
const avatarCache = new Map();

/* ---------------- helpers ---------------- */

async function getBuf(url, timeout = 10000) {
  const r = await axios.get(url, {
    responseType: "arraybuffer",
    timeout,
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  return Buffer.from(r.data);
}

async function ensureFont(registerFont, cacheDir) {
  if (fontReady) return;
  const file = path.join(cacheDir, FONT_FILE);
  try {
    await fs.ensureDir(cacheDir);
    if (!fs.existsSync(file) || fs.statSync(file).size < 50000) {
      for (const u of FONT_URLS) {
        try {
          await fs.writeFile(file, await getBuf(u, 20000));
          if (fs.statSync(file).size > 50000) break;
        }
        catch (e) { /* try next mirror */ }
      }
    }
    if (fs.existsSync(file) && fs.statSync(file).size > 50000) registerFont(file, { family: "HindSiliguri" });
  }
  catch (e) { console.warn("[fakechat] Bangla font load failed:", e.message); }

  try {
    if (!fontReady && fs.existsSync(LOCAL_FONT)) registerFont(LOCAL_FONT, { family: "BeVietnam" });
  }
  catch (e) { /* ignore */ }
  fontReady = true;
}

const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u;

function graphemes(str) {
  if (typeof Intl !== "undefined" && Intl.Segmenter)
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(str)].map(s => s.segment);
  return Array.from(str);
}

function toCode(g) {
  const s = g.indexOf("\u200D") < 0 ? g.replace(/\uFE0F/g, "") : g;
  return Array.from(s).map(c => c.codePointAt(0).toString(16)).join("-");
}

async function loadEmoji(loadImage, code) {
  if (emojiCache.has(code)) return emojiCache.get(code);
  let img = null;
  for (const mk of EMOJI_CDNS) {
    try { img = await loadImage(await getBuf(mk(code), 8000)); break; }
    catch (e) { /* next mirror */ }
  }
  emojiCache.set(code, img);
  return img;
}

function buildParagraphs(text) {
  return text.replace(/\r/g, "").split("\n").map(line => {
    const words = [];
    for (const w of line.split(/ +/)) {
      if (!w) continue;
      const segs = [];
      let buf = "";
      for (const g of graphemes(w)) {
        if (EMOJI_RE.test(g)) {
          if (buf) { segs.push({ t: buf }); buf = ""; }
          segs.push({ e: true, t: g });
        }
        else buf += g;
      }
      if (buf) segs.push({ t: buf });
      words.push(segs);
    }
    return words;
  });
}

function wrapText(ctx, paragraphs, maxW, fs) {
  const emojiW = fs * 1.15;
  const segW = s => (s.e ? emojiW : ctx.measureText(s.t).width);
  const wordW = w => w.reduce((a, s) => a + segW(s), 0);
  const spaceW = ctx.measureText(" ").width;
  const lines = [];

  for (const words of paragraphs) {
    if (!words.length) { lines.push({ segs: [], w: 0 }); continue; }
    let cur = [], curW = 0;
    const flush = () => { lines.push({ segs: cur, w: curW }); cur = []; curW = 0; };

    for (const word of words) {
      const ww = wordW(word);
      if (ww > maxW) {
        if (cur.length) flush();
        let part = [], pw = 0;
        for (const seg of word) {
          const units = seg.e ? [seg] : graphemes(seg.t).map(g => ({ t: g }));
          for (const u of units) {
            const uw = segW(u);
            if (pw + uw > maxW && part.length) { lines.push({ segs: part, w: pw }); part = []; pw = 0; }
            part.push(u); pw += uw;
          }
        }
        cur = part; curW = pw;
        continue;
      }
      const add = cur.length ? spaceW + ww : ww;
      if (curW + add > maxW && cur.length) { flush(); cur = [...word]; curW = ww; }
      else { if (cur.length) cur.push({ t: " " }); cur.push(...word); curW += add; }
    }
    if (cur.length) flush();
  }
  return lines;
}

function mergeSegs(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (!s.e && last && !last.e) last.t += s.t;
    else out.push({ ...s });
  }
  return out;
}

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawAvatar(ctx, img, cx, cy, size, label, font) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    const s = Math.min(img.width, img.height);
    ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, cx - size / 2, cy - size / 2, size, size);
  }
  else {
    ctx.fillStyle = "#8d8a99";
    ctx.fillRect(cx - size / 2, cy - size / 2, size, size);
    if (label) {
      ctx.fillStyle = "#ffffff";
      ctx.font = `${Math.round(size * 0.46)}px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label.toUpperCase(), cx, cy + 1);
    }
    else {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(cx, cy - size * 0.12, size * 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy + size * 0.5, size * 0.36, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

function hexToRgb(hex) {
  const m = String(hex).replace("#", "").match(/^[0-9a-f]{6}$/i);
  if (!m) return null;
  const n = parseInt(m[0], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function shade(hex, amount) {
  const c = hexToRgb(hex);
  if (!c) return hex;
  const f = v => Math.max(0, Math.min(255, Math.round(v + amount)));
  return `rgb(${f(c.r)},${f(c.g)},${f(c.b)})`;
}

function withAlpha(color, alpha) {
  const c = hexToRgb(color);
  if (c) return `rgba(${c.r},${c.g},${c.b},${alpha})`;
  const m = String(color).match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
  return "rgba(255,255,255,0.15)";
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pickTheme(threadID, threadData, requested, config) {
  if (requested && requested !== true) {
    const key = String(requested).toLowerCase();
    if (THEMES[key]) return { ...THEMES[key], name: key };
    if (/^#?[0-9a-f]{6}$/i.test(key)) {
      const hex = key.startsWith("#") ? key : `#${key}`;
      return {
        name: "custom", top: shade(hex, -55), bottom: hex, accent: shade(hex, 45),
        bubble: "#34343f", header: "rgba(0,0,0,0.55)", text: "#ffffff"
      };
    }
  }

  const stored = threadData && threadData.data &&
    (threadData.data.fakechatTheme || threadData.data.theme);
  if (stored) {
    const key = String(stored).toLowerCase();
    if (THEMES[key]) return { ...THEMES[key], name: key };
    if (/^#?[0-9a-f]{6}$/i.test(key)) {
      const hex = key.startsWith("#") ? key : `#${key}`;
      return { name: "group", top: shade(hex, -55), bottom: hex, accent: shade(hex, 45), bubble: "#34343f", header: "rgba(0,0,0,0.55)", text: "#ffffff" };
    }
  }

  if (config && config.fakechat && THEMES[String(config.fakechat.theme).toLowerCase()])
    return { ...THEMES[String(config.fakechat.theme).toLowerCase()], name: "config" };

  // Stable per-group theme: every group gets its own look without admin setup.
  const key = THEME_KEYS[hashStr(threadID || "global") % THEME_KEYS.length];
  return { ...THEMES[key], name: key };
}

function extractUid(token) {
  if (!token) return null;
  if (/^\d{6,}$/.test(token)) return token;
  const m = String(token).match(/(?:facebook\.com|fb\.com|m\.facebook\.com)\/(?:profile\.php\?id=|)([0-9]{6,})/i)
    || String(token).match(/[?&]id=([0-9]{6,})/);
  return m ? m[1] : null;
}

function parseFlags(tokens) {
  const opts = {}, rest = [];
  for (const t of tokens) {
    if (/^--[\w-]+=/.test(t)) {
      const i = t.indexOf("=");
      opts[t.slice(2, i).toLowerCase()] = t.slice(i + 1);
    }
    else if (/^--[\w-]+$/.test(t)) opts[t.slice(2).toLowerCase()] = true;
    else rest.push(t);
  }
  return { opts, rest };
}

function toEmojiCodes(paragraphs, extra) {
  const set = new Set(extra || []);
  for (const p of paragraphs) for (const w of p) for (const s of w) if (s.e) set.add(toCode(s.t));
  return set;
}

/* ---------------- command ---------------- */

module.exports = {
  config: {
    name: "fakechat",
    aliases: ["fc", "fchat", "facechat", "fakemsg"],
    version: "3.0.0",
    author: "Mr.King",
    countDown: 5,
    role: 0,
    shortDescription: "Realistic fake Messenger chat (any user + every emoji + group theme)",
    longDescription: "Create a realistic Messenger chat card by UID, profile link, reply, mention or self. All emoji and Bangla supported. Background follows the group theme.",
    category: "image",
    guide: {
      en: "{pn} <text>                       self\n" +
          "{pn} <uid|link> <text>              target by id or link\n" +
          "{pn} --name=Name <text>             custom display name\n" +
          "{pn} --theme=blue|dark|#hex <text>  force a background theme\n" +
          "{pn} --reply=Quoted text <text>     show an inline reply\n" +
          "{pn} --right <text>                 send bubble on the right\n" +
          "Reply to a message, mention someone, or use 'me' for yourself."
    }
  },

  onStart: async function ({ message, args, event, usersData, api, threadsData }) {
    const send = body =>
      message ? message.reply(body) : api.sendMessage(body, event.threadID, null, event.messageID);

    let outFile = null;
    try {
      let canvasLib;
      try { canvasLib = require("canvas"); }
      catch (e) { return send("canvas module is missing. Install it with: npm i canvas"); }
      const { createCanvas, loadImage, registerFont } = canvasLib;

      /* ---- parse options ---- */
      const { opts, rest } = parseFlags(args.slice());
      let uid = String(event.senderID);
      let targetFound = false;

      const firstUid = extractUid(rest[0]);
      if (firstUid) { uid = firstUid; rest.shift(); targetFound = true; }
      else if (rest[0] && /^(me|self)$/i.test(rest[0])) { rest.shift(); targetFound = true; }
      else if (event.messageReply && event.messageReply.senderID) {
        uid = String(event.messageReply.senderID); targetFound = true;
      }
      else if (event.mentions && Object.keys(event.mentions).length) {
        uid = Object.keys(event.mentions)[0]; targetFound = true;
      }

      // Extra ids/links anywhere in the text are removed from the visible message.
      const cleaned = [];
      for (const t of rest) {
        if (targetFound && extractUid(t) === uid) continue;
        cleaned.push(t);
      }

      let text = cleaned.join(" ").replace(/\\n/g, "\n").trim();
      if (event.mentions) for (const nm of Object.values(event.mentions)) text = text.split(nm).join("");
      if (!text && event.messageReply && event.messageReply.body) text = String(event.messageReply.body).trim();
      if (!text) return send("Give a message, a user id/link, a mention, or reply to someone. Example: fc Kheli na");
      if (text.length > 1200) text = text.slice(0, 1200) + "...";

      /* ---- name ---- */
      let name = opts.name ? String(opts.name) : "Facebook User";
      if (!opts.name) {
        try {
          if (event.mentions && event.mentions[uid]) name = event.mentions[uid];
          else if (usersData && typeof usersData.getName === "function") name = (await usersData.getName(uid)) || name;
        }
        catch (e) { /* keep fallback */ }
      }
      if (name.length > 30) name = name.slice(0, 29) + "...";

      /* ---- theme from the group ---- */
      let threadData = null;
      try {
        if (threadsData && typeof threadsData.get === "function") threadData = await threadsData.get(event.threadID);
      }
      catch (e) { /* use derived theme */ }

      let requestedTheme = opts.theme || opts.bg || opts.background;
      const storedTheme = threadData && threadData.data &&
        (threadData.data.fakechatTheme || threadData.data.theme);
      // Messenger may expose the real group theme colour; use it when available.
      if (!requestedTheme && !storedTheme && api && typeof api.getThreadInfo === "function") {
        try {
          const info = await new Promise(resolve => {
            let done = false;
            const finish = v => { if (!done) { done = true; resolve(v); } };
            try { api.getThreadInfo(event.threadID, (err, d) => finish(!err ? d : null)); }
            catch (e) { finish(null); }
            setTimeout(() => finish(null), 1500);
          });
          if (info && (info.theme || info.color)) requestedTheme = `#${String(info.theme || info.color).replace("#", "")}`;
        }
        catch (e) { /* ignore */ }
      }

      const cfg = (global.GoatBot && global.GoatBot.config) || {};
      const T = pickTheme(event.threadID, threadData, requestedTheme, cfg);

      /* ---- assets ---- */
      const cacheDir = path.join(__dirname, "cache");
      await fs.ensureDir(cacheDir);
      await ensureFont(registerFont, cacheDir);

      const paragraphs = buildParagraphs(text);
      const codes = toEmojiCodes(paragraphs, ["1f425", "2764"]);
      const rightSide = opts.right === true || opts.right === "true" || /^(1|true|yes)$/i.test(String(opts.right));
      const quoteText = opts.reply || opts.quote || null;

      const [avatarImg, bgImg, ...emojiImgs] = await Promise.all([
        (async () => {
          try {
            const key = String(uid);
            if (avatarCache.has(key)) return avatarCache.get(key);
            const url = `https://graph.facebook.com/${uid}/picture?width=512&height=512&access_token=${FB_TOKEN}`;
            const img = await loadImage(await getBuf(url, 8000));
            avatarCache.set(key, img);
            return img;
          }
          catch (e) { return null; }
        })(),
        (async () => {
          if (!requestedTheme) return null;
          try {
            if (!bgBuffer) bgBuffer = await getBuf("https://i.imgur.com/PZYjU9e.jpeg", 12000);
            return await loadImage(bgBuffer);
          }
          catch (e) { return null; }
        })(),
        ...[...codes].map(c => loadEmoji(loadImage, c))
      ]);
      const emojiMap = new Map([...codes].map((c, i) => [c, emojiImgs[i]]));

      /* ---- layout ---- */
      const W = 720;
      const FS = 30;
      const LH = 44;
      const padX = 26, padY = 18;
      const bubbleMaxW = Math.round(W * 0.76);
      const maxTextW = bubbleMaxW - padX * 2;

      const measure = createCanvas(10, 10).getContext("2d");
      measure.font = `${FS}px ${FONT}`;
      let lines = wrapText(measure, paragraphs, maxTextW, FS);
      if (lines.length > 40) lines = lines.slice(0, 40);
      const textW = Math.max(...lines.map(l => l.w), 20);
      const bubbleW = Math.min(bubbleMaxW, Math.ceil(textW + padX * 2));
      const bubbleH = padY * 2 + 40 + Math.max(0, lines.length - 1) * LH;

      const headerH = 118;
      const quoteH = quoteText ? 74 : 0;
      const bubbleY = headerH + 26 + quoteH;
      const bubbleBottom = bubbleY + bubbleH;
      const barY = bubbleBottom + 84;
      const H = Math.max(barY + 96, 500);

      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext("2d");

      /* ---- themed background ---- */
      ctx.save();
      rr(ctx, 0, 0, W, H, 36);
      ctx.clip();

      if (bgImg && !THEMES[String(requestedTheme).toLowerCase()]) {
        const sc = Math.max(W / bgImg.width, H / bgImg.height);
        const bw = bgImg.width * sc, bh = bgImg.height * sc;
        ctx.drawImage(bgImg, (W - bw) / 2, (H - bh) / 2, bw, bh);
        const ov = ctx.createLinearGradient(0, 0, 0, H);
        ov.addColorStop(0, "rgba(20,15,45,0.30)");
        ov.addColorStop(1, "rgba(30,25,70,0.78)");
        ctx.fillStyle = ov;
        ctx.fillRect(0, 0, W, H);
      }
      else {
        const grad = ctx.createLinearGradient(0, 0, W, H);
        grad.addColorStop(0, T.top);
        grad.addColorStop(1, T.bottom);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        ctx.globalAlpha = 0.10;
        ctx.fillStyle = "#ffffff";
        for (let i = -H; i < W; i += 76) {
          ctx.beginPath();
          ctx.moveTo(i, 0); ctx.lineTo(i + 30, 0); ctx.lineTo(i + 30 + H, H); ctx.lineTo(i + H, H);
          ctx.closePath(); ctx.fill();
        }
        ctx.globalAlpha = 1;

        const glow = ctx.createRadialGradient(W * 0.82, 40, 10, W * 0.82, 40, W * 0.7);
        glow.addColorStop(0, withAlpha(T.accent, 0.33));
        glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);
      }

      /* ---- status bar ---- */
      const timeNow = opts.time
        ? String(opts.time)
        : new Date().toLocaleTimeString("en-US", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" });
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.font = `22px ${FONT}`;
      ctx.fillText(timeNow, W / 2, 38);

      ctx.textAlign = "right";
      ctx.font = `18px ${FONT}`;
      ctx.fillText("100%", W - 30, 38);

      /* ---- chat header ---- */
      ctx.fillStyle = T.header;
      ctx.fillRect(0, 64, W, 54);
      drawAvatar(ctx, avatarImg, 56, 91, 40, name, FONT);
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold 25px ${FONT}`;
      ctx.fillText(name, 88, 88);
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.font = `18px ${FONT}`;
      ctx.fillText("Active now", 88, 109);

      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(W - 176, 86); ctx.lineTo(W - 190, 91); ctx.lineTo(W - 176, 96); ctx.stroke();
      ctx.beginPath(); ctx.arc(W - 128, 91, 10, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(W - 128 - 3, 91 - 3); ctx.lineTo(W - 128 + 3, 91 + 3); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(W - 66 + i * 13, 92, 2.7, 0, Math.PI * 2); ctx.fill(); }

      /* ---- inline quoted reply ---- */
      if (quoteText) {
        const q = String(quoteText).slice(0, 90);
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        rr(ctx, bubbleXFor(rightSide, bubbleW), headerH + 12, bubbleW, 60, 16); ctx.fill();
        ctx.fillStyle = T.accent;
        ctx.fillRect(bubbleXFor(rightSide, bubbleW) + 14, headerH + 24, 4, 36);
        ctx.textAlign = "left";
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold 19px ${FONT}`;
        ctx.fillText("You", bubbleXFor(rightSide, bubbleW) + 28, headerH + 38);
        ctx.fillStyle = "rgba(255,255,255,0.82)";
        ctx.font = `19px ${FONT}`;
        ctx.fillText(q, bubbleXFor(rightSide, bubbleW) + 28, headerH + 61);
      }

      /* ---- bubble ---- */
      const bx = bubbleXFor(rightSide, bubbleW);
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.30)";
      ctx.shadowBlur = 14;
      ctx.fillStyle = rightSide ? T.accent : (T.text === "#ffffff" ? "rgba(52,52,65,0.96)" : "rgba(255,255,255,0.96)");
      rr(ctx, bx, bubbleY, bubbleW, bubbleH, 32);
      ctx.fill();
      ctx.restore();

      // little tail
      ctx.fillStyle = rightSide ? T.accent : (T.text === "#ffffff" ? "rgba(52,52,65,0.96)" : "rgba(255,255,255,0.96)");
      ctx.beginPath();
      if (rightSide) { ctx.moveTo(bx + bubbleW - 4, bubbleY + 34); ctx.lineTo(bx + bubbleW + 16, bubbleY + 46); ctx.lineTo(bx + bubbleW - 4, bubbleY + 54); }
      else { ctx.moveTo(bx + 4, bubbleY + 34); ctx.lineTo(bx - 16, bubbleY + 46); ctx.lineTo(bx + 4, bubbleY + 54); }
      ctx.closePath(); ctx.fill();

      ctx.fillStyle = rightSide ? "#10121a" : T.text;
      ctx.font = `${FS}px ${FONT}`;
      const eSize = FS * 1.12;
      lines.forEach((ln, i) => {
        let x = bx + padX;
        const y = bubbleY + padY + 32 + i * LH;
        for (const s of mergeSegs(ln.segs)) {
          if (s.e) {
            const img = emojiMap.get(toCode(s.t));
            if (img) ctx.drawImage(img, x, y - eSize * 0.86, eSize, eSize);
            else ctx.fillText(s.t, x, y);
            x += FS * 1.15;
          }
          else { ctx.fillText(s.t, x, y); x += ctx.measureText(s.t).width; }
        }
      });

      // time + status under the bubble
      ctx.textAlign = rightSide ? "right" : "left";
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.font = `17px ${FONT}`;
      const statusWord = opts.seen === false || opts.seen === "false" ? "Delivered" : "Seen";
      ctx.fillText(`${timeNow}   ${rightSide ? statusWord : ""}`, rightSide ? bx + bubbleW - 6 : bx + 6, bubbleBottom + 26);

      // avatars
      drawAvatar(ctx, avatarImg, 48, bubbleBottom - 22, 44, name, FONT);
      drawAvatar(ctx, avatarImg, W - 46, bubbleBottom + 18, 22, name, FONT);

      /* ---- composer ---- */
      const cy = barY + 30;
      const blue = T.accent;
      ctx.fillStyle = blue;
      ctx.beginPath(); ctx.arc(44, cy, 18, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3.5; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(44, cy - 8); ctx.lineTo(44, cy + 8); ctx.moveTo(36, cy); ctx.lineTo(52, cy); ctx.stroke();

      ctx.fillStyle = blue;
      rr(ctx, 86, cy - 14, 40, 28, 8); ctx.fill();
      ctx.fillStyle = "rgba(30,25,70,0.9)";
      ctx.beginPath(); ctx.arc(106, cy + 1, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = blue;
      ctx.beginPath(); ctx.arc(106, cy + 1, 4.5, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = blue;
      rr(ctx, 142, cy - 17, 38, 34, 8); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.moveTo(146, cy + 13); ctx.lineTo(158, cy - 3); ctx.lineTo(166, cy + 6); ctx.lineTo(171, cy); ctx.lineTo(177, cy + 13);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.arc(167, cy - 9, 4, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = blue;
      rr(ctx, 209, cy - 18, 14, 26, 7); ctx.fill();
      ctx.strokeStyle = blue; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(216, cy - 2, 12, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(216, cy + 10); ctx.lineTo(216, cy + 17); ctx.stroke();

      const pillX = 250;
      const pillW = W - 100 - pillX;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      rr(ctx, pillX, barY, pillW, 60, 30); ctx.fill();
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(255,255,255,0.65)";
      ctx.font = `26px ${FONT}`;
      ctx.fillText("Message", pillX + 24, barY + 39);

      const sx = pillX + pillW - 34;
      ctx.fillStyle = blue;
      ctx.beginPath(); ctx.arc(sx, cy, 17, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgba(30,25,70,0.95)";
      ctx.beginPath(); ctx.arc(sx - 6, cy - 4, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx + 6, cy - 4, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(30,25,70,0.95)"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(sx, cy + 1, 8, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();

      const duck = emojiMap.get("1f425");
      if (duck) ctx.drawImage(duck, W - 84, cy - 22, 44, 44);

      ctx.fillStyle = "rgba(255,255,255,0.7)";
      rr(ctx, W / 2 - 100, H - 22, 200, 6, 3); ctx.fill();
      ctx.restore();

      /* ---- send ---- */
      outFile = path.join(cacheDir, `fakechat_${Date.now()}.png`);
      await fs.writeFile(outFile, canvas.toBuffer("image/png"));
      await send({ attachment: fs.createReadStream(outFile) });
    }
    catch (err) {
      console.error("[fakechat] error:", err);
      return send("Could not create the fake chat: " + (err.message || err));
    }
    finally {
      if (outFile) fs.remove(outFile).catch(() => {});
    }
  }
};

function bubbleXFor(rightSide, bubbleW) {
  return rightSide ? 720 - bubbleW - 84 : 84;
}
