/**
 * ============================================================================
 * COMMAND: account  (Multi-account switcher and pool inspector)
 *
 *   <prefix>account status          all 5 slots: active, standby, resting, failed, suspended
 *   <prefix>account switch <1-5>    force an immediate switch to that slot
 *   <prefix>account next            switch to the next healthy standby slot
 *   <prefix>account reset <1-5|all> clear a failure record so it is tried at once
 *   <prefix>account auto            remove a forced switch, back to account.txt first
 *
 * Admin only. All replies are plain English.
 * ============================================================================
 */
"use strict";

const pool = require("../../bot/login/accountPool.js");

function prefixOf(event) {
	try {
		if (global.utils && typeof global.utils.getPrefix === "function")
			return global.utils.getPrefix(event && event.threadID) || global.GoatBot.config.prefix || "/";
	} catch (e) { /* ignore */ }
	return (global.GoatBot.config && global.GoatBot.config.prefix) || "/";
}

function restartSoon(reason) {
	setTimeout(() => {
		try {
			if (process.send) process.exit(7); // 7 = request a fast engine restart / account switch
			else if (global.GoatBot && typeof global.GoatBot.reLoginBot === "function") global.GoatBot.reLoginBot();
		}
		catch (e) { /* the supervisor will restart us anyway */ }
	}, 1200);
	return reason;
}

module.exports = {
	config: {
		name: "account",
		aliases: ["acc", "switchacc", "accounts", "pool"],
		version: "4.0.3",
		author: "Mr.king",
		countDown: 3,
		role: 2,
		description: {
			en: "Show, switch, rotate or reset the 5 bot accounts (account.txt to account5.txt)",
			vi: "Xem, đổi, luân chuyển hoặc đặt lại 5 tài khoản bot"
		},
		category: "owner",
		guide: {
			en: "{pn} status | {pn} switch <1-5> | {pn} next | {pn} reset <1-5|all> | {pn} auto"
		}
	},

	onStart: async function ({ message, event, args }) {
		const p = prefixOf(event);
		const sub = String(args[0] || "status").toLowerCase();
		const state = pool.manager.loadState();
		const active = global.GoatBot.activeAccountFile || (state.active ? pool.FILES[state.active - 1] : null);
		const reply = text => message.reply(text);

		if (["status", "list", "info", ""].includes(sub)) {
			const rows = pool.describeAll(active);
			let out = "ALIYA ACCOUNT POOL STATUS\n";
			out += "=============================\n";
			out += `Active now : ${active || "none"}\n`;
			out += `Engine     : ${global.GoatBot.isWolfMode ? "Wolf safe mode" : "Aliya main"}\n`;
			out += `Bot UID    : ${global.GoatBot.botID || "unknown"}\n`;
			out += `Forced slot: ${state.forced ? `${state.forced} (${pool.FILES[state.forced - 1]})` : "none (auto order)"}\n`;
			out += "=============================\n";
			for (const r of rows) {
				out += `${r.slot}. ${r.icon} ${r.file}\n`;
				out += `   status : ${r.status}\n`;
				if (r.detail) out += `   info   : ${r.detail}\n`;
			}
			out += "=============================\n";
			out += `Legend: green active | blue available | orange failed or expired | red suspended\n`;
			out += `Commands: ${p}account switch <1-5> | ${p}account next | ${p}account reset <1-5|all> | ${p}account auto`;
			return reply(out);
		}

		if (["switch", "use", "set"].includes(sub)) {
			const wanted = String(args[1] || "").trim();
			const result = pool.switchTo(wanted);
			if (!result.ok) {
				const known = pool.FILES.map((f, i) => `${i + 1}=${f}`).join(", ");
				return reply(`Cannot switch to "${wanted || "empty"}": ${result.reason}.\nSlots: ${known}`);
			}
			await reply(`Switching to slot ${result.slot} (${result.file}).\nRestarting the engine now. The bot will be back in a few seconds.`);
			return restartSoon("switch");
		}

		if (["next", "rotate", "skip"].includes(sub)) {
			const next = pool.nextAvailable(active);
			if (!next) return reply("No other healthy account is available right now. Add a cookie or reset a slot first.");
			const result = pool.switchTo(next.slot);
			if (!result.ok) return reply(`Cannot switch to ${next.file}: ${result.reason}`);
			await reply(`Rotating to slot ${next.slot} (${next.file}). Restarting now...`);
			return restartSoon("rotate");
		}

		if (sub === "reset") {
			const raw = String(args[1] || "").toLowerCase();
			if (raw === "all") {
				for (let n = 1; n <= pool.SLOTS; n++) pool.resetSlot(n);
				await reply("All 5 slots were reset. Every account will be tried again on the next login.");
				return restartSoon("reset all");
			}
			const n = pool.slotOf(raw) || (Number(raw) >= 1 && Number(raw) <= pool.SLOTS ? Number(raw) : 0);
			if (!n) return reply(`Usage: ${p}account reset <1-5|all>`);
			pool.resetSlot(n);
			await reply(`Slot ${n} (${pool.FILES[n - 1]}) was reset and will be tried again immediately.`);
			return restartSoon("reset");
		}

		if (sub === "auto" || sub === "clear") {
			pool.clearPreferred();
			await reply("Forced switch removed. Login order is back to account.txt first, then account2.txt to account5.txt.");
			return restartSoon("auto");
		}

		return reply(
			`Unknown option: ${sub}\n` +
			`Usage:\n` +
			`${p}account status\n` +
			`${p}account switch <1-5>\n` +
			`${p}account next\n` +
			`${p}account reset <1-5|all>\n` +
			`${p}account auto`
		);
	}
};
