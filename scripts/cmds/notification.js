/**
 * notification - broadcast a notice only to groups the bot is actually in.
 *
 * threadsData can contain old groups the bot was once added to. Those groups
 * must NOT receive the notice. Every candidate thread is verified with a live
 * getThreadInfo call: if the bot's own ID is not in participantIDs, the thread
 * is skipped. If the info cannot be read, the thread is skipped too.
 */
"use strict";

function callApi(fn, args, timeoutMs = 8000) {
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ err: err || null, data: data === undefined ? null : data });
    };

    let returned;
    try { returned = fn(...args, (err, data) => finish(err, data)); }
    catch (e) { return finish(e, null); }

    if (returned && typeof returned.then === "function")
      returned.then(data => finish(null, data)).catch(e => finish(e, null));

    timer = setTimeout(() => finish(null, null), timeoutMs);
  });
}

function buildMentions(ids, max = 50) {
  let prefix = "";
  const mentions = [];
  for (const raw of ids.slice(0, max)) {
    const uid = String(raw);
    const tag = `@${uid}`;
    mentions.push({ tag, id: uid, fromIndex: prefix.length });
    prefix += tag + " ";
  }
  return { prefix: prefix ? prefix + "\n\n" : "", mentions };
}

module.exports = {
  config: {
    name: "notification",
    aliases: ["notice", "noti", "announce"],
    version: "2.0.0",
    author: "Mr.king",
    countDown: 5,
    role: 2,
    shortDescription: {
      en: "Send a notice only to groups the bot is currently a member of"
    },
    category: "owner",
    guide: {
      en: "   {pn} <notice message>"
    }
  },

  onStart: async function ({ api, event, args, threadsData, usersData, message }) {
    const { senderID, messageID } = event;
    const noticeMsg = args.join(" ").trim();

    const reply = text => (message && typeof message.reply === "function")
      ? message.reply(text)
      : api.sendMessage(text, event.threadID, messageID);

    if (!noticeMsg)
      return reply("Please provide a notice message.\nExample: (notification Bot will be updated tonight at 10 PM.");

    try { api.setMessageReaction("📢", messageID, () => {}, true); }
    catch (e) { /* reaction is optional */ }

    try {
      let ownerName = "Mr.king";
      try {
        if (usersData && typeof usersData.getName === "function")
          ownerName = (await usersData.getName(senderID)) || ownerName;
        else {
          const u = await callApi(api.getUserInfo.bind(api), [senderID], 6000);
          if (u.data && u.data[senderID]) ownerName = u.data[senderID].name || ownerName;
        }
      }
      catch (e) { /* keep the default name */ }

      const allThreads = await threadsData.getAll();
      const candidates = allThreads.filter(t =>
        t && t.isGroup !== false && String(t.threadID || "").length > 8
      );

      if (!candidates.length)
        return reply("The bot has no group records to check.");

      const botID = String(api.getCurrentUserID());
      let successCount = 0, skippedCount = 0, failCount = 0;

      const footerText =
        `Notice: "${noticeMsg}"\n\n` +
        `- From: "${ownerName}"\n\n` +
        "Made with care by Mr.king";

      for (const thread of candidates) {
        const tid = thread.threadID;

        // Live membership check. This is the core fix: stale groups are skipped.
        const info = await callApi(api.getThreadInfo.bind(api), [tid], 8000);
        const participants = info.data && info.data.participantIDs;
        if (info.err || !Array.isArray(participants) || !participants.some(id => String(id) === botID)) {
          skippedCount++;
          continue;
        }

        const members = participants
          .map(String)
          .filter(id => id !== botID);

        const { prefix, mentions } = buildMentions(members);
        const body = "Aliya V4 Notice\n\n" + prefix + footerText;

        const sent = await callApi(api.sendMessage.bind(api), [{ body, mentions }, tid], 10000);
        if (sent.err) failCount++;
        else successCount++;

        await new Promise(resolve => setTimeout(resolve, 1200));
      }

      try { api.setMessageReaction("✅", messageID, () => {}, true); }
      catch (e) { /* ignore */ }

      return reply(
        "Notice report\n\n" +
        `Sent to groups where the bot is a member: ${successCount}\n` +
        `Skipped (bot not in group or group unavailable): ${skippedCount}\n` +
        `Failed to send: ${failCount}`
      );
    }
    catch (error) {
      try { api.setMessageReaction("❌", messageID, () => {}, true); }
      catch (e) { /* ignore */ }
      return reply("Could not send the notice: " + (error.message || error));
    }
  }
};
