const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

module.exports = {
  config: {
    name: "songfinder",
    aliases: ["shazam", "findsong"],
    version: "1.0.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤",
    countDown: 5,
    role: 0,
    shortDescription: "Recognize a song from an audio/video URL or reply",
    longDescription: "Recognizes song metadata (title, artist, album, cover) from a direct media URL or replied audio/video attachment.",
    category: "media",
    guide: "{pn} [url] or reply to an audio/video message"
  },

  onStart: async function ({ api, message, event, args }) {
    let mediaUrl = args.join(" ").trim();

    if (!mediaUrl && event.messageReply && event.messageReply.attachments && event.messageReply.attachments.length > 0) {
      const att = event.messageReply.attachments.find(a => a.type === "audio" || a.type === "video");
      if (att && att.url) {
        mediaUrl = att.url;
      }
    }

    if (!mediaUrl) {
      return message.reply("Please provide an audio/video URL or reply to a voice/video message!");
    }

    api.setMessageReaction("🏯", event.messageID, () => {}, true);

    const baseUrl = "https://0x-mr-king-api-server-i73g.vercel.app";

    try {
      const res = await axios.get(`${baseUrl}/api/songfinder`, {
        params: { url: mediaUrl, media_url: mediaUrl }
      });

      const payload = res.data && res.data.data ? res.data.data : res.data;
      const track = payload && payload.result ? payload.result : payload;

      if (!res.data || res.data.success === false || !track || (!track.title && !track.song && !track.name)) {
        throw new Error("Song not recognized!");
      }

      const title = track.title || track.song || track.name || "Unknown Title";
      const artist = track.artist || track.artists || "Unknown Artist";
      const album = track.album || "Unknown Album";
      const release = track.release_date || track.released || "N/A";
      const coverUrl = track.cover || track.thumbnail || track.image || track.artwork || null;

      const infoCard =
        `╭───────────────⬣\n` +
        `│ 𝐒𝐨𝐧𝐠 : ${title}\n` +
        `│ 𝐀𝐫𝐭𝐢𝐬𝐭 : ${artist}\n` +
        `│ 𝐀𝐥𝐛𝐮𝐦 : ${album}\n` +
        `│ 𝐑𝐞𝐥𝐞𝐚𝐬𝐞 : ${release}\n` +
        `│ 𝐌𝐚𝐝𝐞 𝐰𝐢𝐭𝐡 🤍 𝐛𝐲 --𝔐𝔯.𝔎𝔦𝔫𝔤\n` +
        `╰───────────────⬣`;

      api.setMessageReaction("🐇", event.messageID, () => {}, true);

      if (coverUrl) {
        try {
          const imgBuffer = (await axios.get(coverUrl, { responseType: "arraybuffer" })).data;
          const imgPath = path.join(__dirname, "cache", `songcover_${Date.now()}.jpg`);
          await fs.ensureDir(path.dirname(imgPath));
          fs.writeFileSync(imgPath, Buffer.from(imgBuffer));

          return message.reply(
            { body: infoCard, attachment: fs.createReadStream(imgPath) },
            () => {
              if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
            }
          );
        } catch (imgErr) {
          return message.reply(infoCard);
        }
      }

      return message.reply(infoCard);
    } catch (error) {
      console.error("SongFinder Error:", error.message);
      api.setMessageReaction("❌", event.messageID, () => {}, true);
      return message.reply("Could not recognize the song! Make sure the link or audio is clear.");
    }
  }
};
        
