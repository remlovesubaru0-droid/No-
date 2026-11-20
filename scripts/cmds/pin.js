const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

module.exports = {
  config: {
    name: "pin",
    aliases: ["pinterest"],
    version: "1.0.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤",
    countDown: 5,
    role: 0,
    shortDescription: "Search and download Pinterest images or videos",
    longDescription: "Searches Pinterest for images or videos by keyword using 0xMr_King API.",
    category: "media",
    guide: "{pn} [query] or {pn} [query] -v (for video)"
  },

  onStart: async function ({ api, message, event, args }) {
    if (!args[0]) {
      return message.reply("Please provide a search query! (Ex: pin anime wallpaper or pin nature -v)");
    }

    let isVideo = false;
    let queryArgs = [];

    for (const arg of args) {
      if (arg.toLowerCase() === "-v" || arg.toLowerCase() === "--video" || arg.toLowerCase() === "type=video") {
        isVideo = true;
      } else {
        queryArgs.push(arg);
      }
    }

    const query = queryArgs.join(" ").trim();
    if (!query) {
      return message.reply("Please provide a valid search keyword!");
    }

    api.setMessageReaction("🏯", event.messageID, () => {}, true);

    const baseUrl = "https://0x-mr-king-api-server-i73g.vercel.app";

    try {
      const params = { query: query };
      if (isVideo) {
        params.type = "video";
      }

      const res = await axios.get(`${baseUrl}/api/pin`, { params });

      const payload = res.data && res.data.data ? res.data.data : res.data;
      const results = Array.isArray(payload)
        ? payload
        : payload && Array.isArray(payload.results)
        ? payload.results
        : payload && Array.isArray(payload.pins)
        ? payload.pins
        : payload && Array.isArray(payload.images)
        ? payload.images
        : payload && Array.isArray(payload.videos)
        ? payload.videos
        : payload
        ? [payload]
        : [];

      if (!res.data || res.data.success === false || results.length === 0) {
        throw new Error("No Pinterest results found!");
      }

      const attachments = [];
      const tempFiles = [];
      const cacheDir = path.join(__dirname, "cache");
      await fs.ensureDir(cacheDir);

      if (isVideo) {
        const picked = results[Math.floor(Math.random() * results.length)];
        const mediaUrl = typeof picked === "string"
          ? picked
          : picked.download_api_url
          ? `${baseUrl}${picked.download_api_url}`
          : picked.video_url || picked.download_url || picked.url || picked.media_url;

        if (!mediaUrl) throw new Error("Video URL not found!");

        const buffer = (await axios.get(mediaUrl, { responseType: "arraybuffer" })).data;
        const filePath = path.join(cacheDir, `pin_${Date.now()}.mp4`);
        fs.writeFileSync(filePath, Buffer.from(buffer));

        attachments.push(fs.createReadStream(filePath));
        tempFiles.push(filePath);
      } else {
        const shuffled = results.sort(() => 0.5 - Math.random()).slice(0, 6);

        for (let i = 0; i < shuffled.length; i++) {
          const item = shuffled[i];
          const imgUrl = typeof item === "string"
            ? item
            : item.image_url || item.download_url || item.url || item.media_url || item.image;

          if (!imgUrl) continue;

          try {
            const buffer = (await axios.get(imgUrl, { responseType: "arraybuffer" })).data;
            const filePath = path.join(cacheDir, `pin_${Date.now()}_${i}.jpg`);
            fs.writeFileSync(filePath, Buffer.from(buffer));

            attachments.push(fs.createReadStream(filePath));
            tempFiles.push(filePath);
          } catch (e) {}
        }
      }

      if (attachments.length === 0) {
        throw new Error("Failed to download Pinterest media!");
      }

      api.setMessageReaction("🐇", event.messageID, () => {}, true);

      const infoCard =
        `╭───────────────⬣\n` +
        `│ 𝐌𝐚𝐝𝐞 𝐰𝐢𝐭𝐡 🤍 𝐛𝐲 --𝔐𝔯.𝔎𝔦𝔫𝔤\n` +
        `╰───────────────⬣`;

      return message.reply(
        { body: infoCard, attachment: attachments },
        () => {
          for (const file of tempFiles) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
          }
        }
      );
    } catch (error) {
      console.error("Pin Error:", error.message);
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      return message.reply("Failed to fetch Pinterest media, please try again!");
    }
  }
};
                                            
