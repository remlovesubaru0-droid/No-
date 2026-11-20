 
const util = require("util");
const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const { exec, execSync } = require("child_process");

module.exports = {
	config: {
		name: "eval",
		version: "5.1.0",
		author: "𝔐𝔯.𝔎𝔦𝔫𝔤 ☠️✌🏼",
		countDown: 0,
		role: 0,
		description: {
			en: "Advanced ultimate JavaScript evaluation engine with auto markdown-URL cleaner"
		},
		category: "owner",
		guide: {
			en: "   {pn} <javascript_code>\n   {pn} help or manual (Show A to Z guide)"
		}
	},

	onStart: async function ({ api, event, args, models, usersData, threadsData, globalData, commandName, role }) {
		const { threadID, messageID, senderID } = event;

		if (args.length === 0 || args[0].toLowerCase() === "help" || args[0].toLowerCase() === "manual") {
			const manualText = 
				`📚 ── ͟͟͞͞Eᴠᴀʟ Cᴏｍｍａ𝐧ｄ Mᴀɴᴜᴀʟ (A to Z) ── 📚\n\n` +
				`✨ What You Can Do:\n` +
				`• Execute any raw JavaScript code, async/await functions, database queries, and bot tests.\n` +
				`• Access built-in shortcuts and fully injected context variables.\n\n` +
				`🛠️ Available Context & Shortcuts:\n` +
				`• \`api\`, \`event\`, \`args\`, \`threadID\`, \`messageID\`, \`senderID\`\n` +
				`• \`out(data)\` or \`output(data)\`: Inspect and send any data or object as a message.\n` +
				`• \`reply(text)\`: Reply directly to the command message.\n` +
				`• \`send(text, targetID)\`: Send message to any thread ID.\n` +
				`• \`react(emoji)\`: React to the message with an emoji.\n` +
				`• \`models\`, \`usersData\`, \`threadsData\`, \`globalData\`: Bot data handlers.\n` +
				`• \`axios\`, \`fs\`, \`fs-extra\`, \`path\`, \`exec\`, \`execSync\`, \`util\`, \`require\`: Full Node.js power libraries.\n\n` +
				`💡 Examples:\n` +
				`• \`{pn} 2 + 2\`\n` +
				`• \`{pn} out(await usersData.get(senderID))\`\n` +
				`• \`{pn} return "Hello from JS!"\``;

			return api.sendMessage(manualText, threadID, messageID);
		}

		const out = (data) => {
			let strData = typeof data !== "string" ? util.inspect(data, { depth: 3 }) : data;
			return api.sendMessage(strData, threadID, messageID);
		};
		const output = out;

		const react = (emoji) => api.setMessageReaction(emoji, messageID, () => {}, true);
		const reply = (text) => api.sendMessage(text, threadID, messageID);
		const send = (text, targetID = threadID) => api.sendMessage(text, targetID);

		// Auto-clean accidental Markdown links like [https://...](https://...)
		let code = args.join(" ").replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, "$2");

		try {
			const context = {
				api,
				event,
				args,
				models,
				usersData,
				threadsData,
				globalData,
				role,
				threadID,
				messageID,
				senderID,
				out,
				output,
				react,
				reply,
				send,
				axios,
				fs,
				path,
				exec,
				execSync,
				util,
				require
			};

			const argNames = Object.keys(context);
			const argValues = Object.values(context);

			let result = await eval(`(async (${argNames.join(", ")}) => { ${code} })`) (...argValues);

			if (result === undefined || result === "undefined") {
				return;
			}

			if (typeof result !== "string") {
				result = util.inspect(result, { depth: 2 });
			}

			if (result.length > 3800) {
				result = result.slice(0, 3800) + "\n\n...[Truncated]";
			}

			return api.sendMessage(`✨ ── ͟͟͞͞Eᴠᴀʟ Rᴇsᴜʟᴛ ── ✧\n\n\`\`\`javascript\n${result}\n\`\`\``, threadID, messageID);
		} catch (err) {
			return api.sendMessage(`❌ ── ͟͟͞͞Eᴠᴀʟ Eʀʀᴏʀ ── ✧\n\n\`\`\`javascript\n${err.stack || err.message || err}\n\`\`\``, threadID, messageID);
		}
	}
};