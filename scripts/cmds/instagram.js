const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

const defaultQueries = [
  "gojo edit",
  "anime reel edit",
  "aesthetic reel",
  "phonk edit",
  "attitude reel",
  "lofi edit",
  "viral reel",
  "goku aura editz",
  "aliya anime"
];

module.exports = {
  config: {
    name: "instagram",
    aliases: ["ig"],
    version: "1.0.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤",
    countDown: 5,
    role: 0,
    shortDescription: "Fetch and send random or searched Instagram reels",
    longDescription: "Sends random or searched Instagram reel videos using 0xMr_King API.",
    category: "media",
    guide: "{pn} [optional query]"
  },

  onStart: async function ({ api, message, event, args }) {
    let query = args.join(" ").trim();

    if (!query) {
      query = defaultQueries[Math.floor(Math.random() * defaultQueries.length)];
    }

    api.setMessageReaction("🏯", event.messageID, () => {}, true);

    const baseUrl = "https://0x-mr-king-api-server-i73g.vercel.app";

    try {
      const res = await axios.get(`${baseUrl}/api/instagram`, {
        params: { query: query }
      });

      const payload = res.data && res.data.data ? res.data.data : null;
      const candidate = Array.isArray(payload)
        ? payload[Math.floor(Math.random() * payload.length)]
        : payload;

      const videoUrl = candidate
        ? (candidate.download_api_url
            ? `${baseUrl}${candidate.download_api_url}`
            : candidate.download_url || candidate.video_url)
        : null;

      if (!res.data || !res.data.success || !videoUrl) {
        throw new Error("No Instagram videos found!");
      }

      const buffer = (await axios.get(videoUrl, { responseType: "arraybuffer" })).data;
      const filePath = path.join(__dirname, "cache", `ig_${Date.now()}.mp4`);

      await fs.ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, Buffer.from(buffer));

      api.setMessageReaction("🐇", event.messageID, () => {}, true);

      const infoCard =
        `╭───────────────⬣\n` +
        `│ 𝐌𝐚𝐝𝐞 𝐰𝐢𝐭𝐡 🤍 𝐛𝐲 --𝔐𝔯.𝔎𝔦𝔫𝔤\n` +
        `╰───────────────⬣`;

      return message.reply(
        { body: infoCard, attachment: fs.createReadStream(filePath) },
        () => {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      );
    } catch (error) {
      console.error("Instagram Error:", error.message);
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      return message.reply("Failed to fetch Instagram video, please try again!");
    }
  }
};
        
