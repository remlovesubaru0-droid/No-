const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

const defaultQueries = [
  "anime 4k edit",
  "anime 4k edits",
  "anime x phonk",
  "goku aura",
  "anime aliya 4k editz",
  "anime amv 4k",
  "best anime edit"
];

module.exports = {
  config: {
    name: "amv",
    version: "2.1.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤",
    countDown: 5,
    role: 0,
    shortDescription: "High quality anime 4K edits and AMV videos",
    longDescription: "Sends random or searched high quality 4K anime edits, phonk edits, and AMV videos.",
    category: "anime",
    guide: "{pn} [optional query]"
  },

  onStart: async function ({ api, message, event, args }) {
    let query = args.join(" ").trim();

    if (!query) {
      query = defaultQueries[Math.floor(Math.random() * defaultQueries.length)];
    } else if (!query.toLowerCase().includes("anime")) {
      query = `anime ${query}`;
    }

    api.setMessageReaction("🏯", event.messageID, () => {}, true);

    const baseUrl = "https://0x-mr-king-api-server-i73g.vercel.app";

    try {
      const res = await axios.get(`${baseUrl}/api/amv`, {
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
        throw new Error("No anime videos found!");
      }

      const buffer = (await axios.get(videoUrl, { responseType: "arraybuffer" })).data;
      const filePath = path.join(__dirname, "cache", `amv_${Date.now()}.mp4`);

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
      console.error("AMV Error:", error.message);
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      return message.reply("Failed to fetch anime video, please try again!");
    }
  }
};
