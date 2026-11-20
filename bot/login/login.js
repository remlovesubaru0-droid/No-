/**
 * ============================================================================
 * ALIYA OFFICIAL V4 - LOGIN ENGINE (multi-account pool + self healing)
 * Maintained by Mr.king
 *
 *  - Tries account.txt first, then account2.txt ... account5.txt
 *  - Account suspended / logged out (even in the middle of a session)
 *      -> marked dead (cookie file is NEVER wiped) -> bot restarts on the next account
 *  - All accounts dead -> tells index.js (exit code 3) -> website shows offline page
 *    and index.js retries with back-off (or instantly when you change a cookie file)
 *  - MQTT dropped / silent -> reconnects by itself
 * ============================================================================
 */

// set bash title
process.stdout.write("\x1b]2;Aliya Official V4 - Ultra Hybrid Master (Maintained by Mr.king)\x1b\x5c");

const axios = require("axios");
const net = require("net");
const path = require("path");
const fs = require("fs-extra");

const pool = require("./accountPool.js");
const handlerWhenListenHasError = require("./handlerWhenListenHasError.js");

// optional helper: older/newer GoatBot builds may not ship it
let checkLiveCookie = null;
try { checkLiveCookie = require("./checkLiveCookie.js"); } catch (e) { checkLiveCookie = null; }

const { callbackListenTime, storage5Message } = global.GoatBot;
const { log, logColor, getPrefix, jsonStringifyColor, getText, convertTime, colors, randomString } = global.utils;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = msg => { if (process.send) { try { process.send(msg); } catch (e) { /* supervisor gone */ } } };

const currentVersion = require("../../package.json").version;
const facebookAccount = global.GoatBot.config.facebookAccount || {};

// ───────────────────────────── small helpers ───────────────────────────── //

let widthConsole = process.stdout.columns || 50;
if (widthConsole > 50) widthConsole = 50;

function createLine(content, isMaxWidth = false) {
	const width = isMaxWidth ? (process.stdout.columns || 50) : widthConsole;
	if (!content) return Array(width).fill("─").join("");
	content = ` ${content.trim()} `;
	let left = Math.floor((width - content.length) / 2);
	if (left < 0 || isNaN(left)) left = 0;
	return Array(left).fill("─").join("") + content + Array(left).fill("─").join("");
}

async function getUtcNow() {
	try {
		const res = await axios.get("https://worldtimeapi.org/api/timezone/UTC", { timeout: 8000 });
		return new Date(res.data.utc_datetime).getTime();
	}
	catch (e) { return Date.now(); }
}

async function getName(userID) {
	try {
		const user = await axios.post(`https://www.facebook.com/api/graphql/?q=${`node(${userID}){name}`}`, undefined, { timeout: 10000 });
		return user.data[userID].name;
	}
	catch (e) { return null; }
}

async function hasInternet() {
	try {
		await axios.get("https://www.facebook.com/", { timeout: 8000, validateStatus: () => true, maxRedirects: 2 });
		return true;
	}
	catch (e) { return false; }
}

function responseUptimeSuccess(req, res) {
	res.type("json").send({
		status: "success",
		activeAccount: global.GoatBot.activeAccountFile,
		pool: global.GoatBot.accountPoolStatus,
		uptime: process.uptime(),
		unit: "seconds"
	});
}

function responseUptimeError(req, res) {
	res.status(503).type("json").send({
		status: "error",
		uptime: process.uptime(),
		statusAccountBot: global.statusAccountBot,
		pool: global.GoatBot.accountPoolStatus
	});
}

global.responseUptimeCurrent = responseUptimeSuccess;
global.responseUptimeSuccess = responseUptimeSuccess;
global.responseUptimeError = responseUptimeError;
global.statusAccountBot = "good";

let lastIntentionalStop = 0;

function stopListening(keyListen) {
	keyListen = keyListen || Object.keys(callbackListenTime).pop();
	lastIntentionalStop = Date.now();
	return new Promise(resolve => {
		if (!global.GoatBot.Listening) return resolve(); // nothing is listening
		const timer = setTimeout(resolve, 4000);
		try {
			const api = global.GoatBot.fcaApi;
			if (api && typeof api.stopListening === "function") {
				api.stopListening(() => {
					if (callbackListenTime[keyListen]) callbackListenTime[keyListen] = () => { };
					clearTimeout(timer);
					resolve();
				});
				return;
			}
		}
		catch (e) { /* fall through */ }
		clearTimeout(timer);
		resolve();
	});
}

// Fallback website: only started if the dashboard did not open the port
function startUptimeServer(port) {
	if (global.serverUptimeRunning) return;
	try {
		const http = require("http");
		const express = require("express");
		const app = express();
		const server = http.createServer(app);
		const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

		app.get("/health", (req, res) => {
			const offline = !!global.GoatBot.poolOffline;
			res.status(200).json({
				status: offline ? "offline" : "online",
				activeAccount: global.GoatBot.activeAccountFile,
				pool: global.GoatBot.accountPoolStatus,
				uptime: process.uptime()
			});
		});
		app.get("/uptime", (req, res) => global.responseUptimeCurrent(req, res));
		app.get("/", (req, res) => {
			if (global.GoatBot.poolOffline) {
				return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>Aliya Bot - Restarting / Offline</title></head>
<body style="background:#0f051d;color:#fff;font-family:sans-serif;text-align:center;padding:90px 16px 0">
<h1 style="color:#ff4d6d">⚠️ Aliya Bot Server Restarting / Offline</h1>
<p>All accounts (account.txt to account5.txt) failed or are suspended. Update a cookie to resume.</p></body></html>`);
			}
			res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aliya Official V4</title></head>
<body style="background:#0f051d;color:#fff;font-family:sans-serif;text-align:center;padding:90px 16px 0">
<h1 style="color:#4cc9f0">👑 ALIYA OFFICIAL V4 — ONLINE</h1>
<p>Active Account: <b>${esc(global.GoatBot.activeAccountFile || "-")}</b> | Bot UID: <b>${esc(global.GoatBot.botID || "-")}</b></p></body></html>`);
		});
		server.on("error", err => log.warn("UPTIME", `Fallback server not started: ${err.message}`));
		server.listen(port, "0.0.0.0", () => {
			global.serverUptimeRunning = true;
			log.info("UPTIME", `Fallback status server active on port ${port}`);
		});
	}
	catch (err) {
		log.warn("UPTIME", `Fallback server failed: ${err.message}`);
	}
}

function botHttpPort() {
	const cfg = global.GoatBot.config;
	return Number(process.env.PORT) || Number(cfg.dashBoard && cfg.dashBoard.port) || Number(cfg.serverUptime && cfg.serverUptime.port) || 3001;
}

// Some dashboards listen on config.dashBoard.port instead of process.env.PORT.
// Cloud hosts only look at PORT, so: if nothing answers on PORT, open the small fallback server.
function ensureBotHttp() {
	const port = botHttpPort();
	setTimeout(() => {
		const sock = net.connect(port, "127.0.0.1");
		let settled = false;
		const done = ok => { if (settled) return; settled = true; try { sock.destroy(); } catch (e) { /* */ } if (!ok) startUptimeServer(port); };
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
		sock.setTimeout(4000, () => done(false));
	}, 20000);
}

// ───────────────────────────── MAIN ───────────────────────────── //

async function startBot() {
	console.log(colors.hex("#f5ab00")(createLine("MULTI-ACCOUNT LOGIN POOL", true)));
	global.GoatBot.poolOffline = false;

	// old session (when relogin is called inside the same process)
	if (global.GoatBot.Listening) {
		await stopListening();
		global.GoatBot.Listening = null;
	}
	clearInterval(global.intervalRestartListenMqtt);
	clearInterval(global.intervalListenWatchdog);
	clearInterval(global.intervalSaveAppState);

	pool.seedFromEnv();
	const { usable, deadOnes } = pool.candidates();
	const attemptOrder = [...usable, ...deadOnes];
	const fcaOptions = global.GoatBot.config.optionsFca || {};
	const results = {};
	let api = null;
	let activeFile = null;
	let triedCount = 0;
	let networkFails = 0;

	for (const filename of attemptOrder) {
		let appState;
		try {
			appState = await pool.parse(pool.readText(filename), { iUser: facebookAccount.i_user });
		}
		catch (e) {
			results[filename] = { status: "INVALID FORMAT", detail: pool.short(e.message, 90) };
			log.warn("ACCOUNT POOL", `${filename} skipped: ${e.message}`);
			continue;
		}

		triedCount++;
		const lastResort = deadOnes.includes(filename);
		log.info("ACCOUNT POOL", `Trying login with ${filename}${lastResort ? " (last resort - failed before)" : ""}...`);

		let result = null;
		for (let attempt = 1; attempt <= 2; attempt++) {
			result = await pool.tryLogin(appState, fcaOptions, 45000);
			if (result.ok) break;
			if (result.fatal) throw Object.assign(new Error(result.error), { code: "NO_FCA" });
			if (pool.classify(result.error).kind !== "network") break;
			log.warn("ACCOUNT POOL", `${filename}: network problem (${pool.short(result.error, 60)}). Retrying in ${attempt * 4}s...`);
			await sleep(attempt * 4000);
		}

		if (result.ok) {
			api = result.api;
			activeFile = filename;
			const uid = api.getCurrentUserID();
			pool.markOk(filename);
			pool.setActive(filename, uid);
			log.master("ACCOUNT POOL", `Connected via ${filename} (UID: ${uid})`);
			break;
		}

		const cls = pool.classify(result.error);
		if (cls.kind === "suspended" || cls.kind === "expired") {
			pool.markDead(filename, cls.kind, cls.text);
			results[filename] = {
				status: cls.kind === "suspended" ? "SUSPENDED / LOCKED" : "LOGGED OUT / EXPIRED",
				detail: pool.short(cls.text, 90)
			};
		}
		else if (cls.kind === "network") {
			networkFails++;
			results[filename] = { status: "FAILED", detail: `network: ${pool.short(cls.text, 80)}` };
		}
		else {
			pool.markFailed(filename, cls.text);
			results[filename] = { status: "FAILED", detail: pool.short(cls.text, 90) };
		}
		log.warn("ACCOUNT POOL", `${filename} failed (${pool.short(cls.text, 100)}). Trying next account...`);
	}

	const table = pool.statusTable({ active: activeFile, results });
	global.GoatBot.accountPoolStatus = pool.toObject(table);
	for (const row of table) console.log(`  • ${row.file.padEnd(13)} => ${row.status} (${row.detail})`);
	send({ type: "POOL", pool: table, active: activeFile });

	if (!api) {
		const allNetwork = triedCount > 0 && networkFails === triedCount;
		const reason = attemptOrder.length === 0
			? "No cookie found in account.txt ... account5.txt"
			: allNetwork ? "Network problem - Facebook not reachable" : "All accounts failed or are suspended";
		return allAccountsFailed(table, reason);
	}

	// ───────────── logged in ───────────── //
	global.GoatBot.fcaApi = api;
	global.GoatBot.botID = api.getCurrentUserID();
	global.GoatBot.activeAccountFile = activeFile;
	global.client.dirAccount = pool.filePath(activeFile);
	global.botID = global.GoatBot.botID;
	pool.clearPreferred(); // a manual "account switch" is a one-time request
	send({ type: "ACCOUNT_CONNECTED", account: activeFile, uid: global.botID });

	global.GoatBot.commands = new Map();
	global.GoatBot.eventCommands = new Map();
	global.GoatBot.aliases = new Map();
	global.GoatBot.onChat = [];
	global.GoatBot.onEvent = [];
	global.GoatBot.onReply = new Map();
	global.GoatBot.onReaction = new Map();

	let hasBanned = false;
	logColor("#f5ab00", createLine("BOT INFO"));
	log.info("NODE VERSION", process.version);
	log.info("PROJECT VERSION", currentVersion);
	log.info("ACTIVE ACCOUNT", `${activeFile} (${global.botID} - ${await getName(global.botID)})`);
	log.info("PREFIX", global.GoatBot.config.prefix);
	log.info("LANGUAGE", global.GoatBot.config.language);

	let dataGban = {};
	try {
		const item = await axios.get("https://raw.githubusercontent.com/Savage-Army/gban/refs/heads/main/gban.json", { timeout: 15000 });
		dataGban = item.data || {};
		if (dataGban[global.botID] && (!dataGban[global.botID].toDate || (await getUtcNow()) < new Date(dataGban[global.botID].date).getTime())) {
			log.err("GBAN", getText("login", "gbanMessage", dataGban[global.botID].date, dataGban[global.botID].reason));
			hasBanned = true;
		}
		if (hasBanned) process.exit(1);
	}
	catch (e) {
		log.warn("GBAN", getText("login", "checkGbanError"));
	}

	// keep the cookie fresh (never overwrite a cookie you just pasted yourself, never save a broken session)
	let knownHash = pool.hashText(pool.readText(activeFile));
	const saveAppState = () => {
		try {
			const state = pool.filterKeys(api.getAppState());
			if (!pool.appStateIsHealthy(state)) return;
			if (pool.hashText(pool.readText(activeFile)) !== knownHash) return; // file was edited by you
			const text = JSON.stringify(state, null, 2);
			if (pool.writeText(activeFile, text)) knownHash = pool.hashText(text.trim());
		}
		catch (e) { /* ignore */ }
	};
	if (global.GoatBot.config.autoRefreshFbstate == true) {
		saveAppState();
		global.intervalSaveAppState = setInterval(saveAppState, 30 * 60 * 1000);
	}

	const { threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData } =
		await require(process.env.NODE_ENV === "development" ? "./loadData.dev.js" : "./loadData.js")(api, createLine);

	if (fs.existsSync(path.join(__dirname, "../custom.js"))) {
		await require("../custom.js")({ api, threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData, getText });
	}

	await require(process.env.NODE_ENV === "development" ? "./loadScripts.dev.js" : "./loadScripts.js")(
		api, threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData, createLine
	);

	// auto reload of command files (config.autoLoadScripts)
	if (global.GoatBot.config.autoLoadScripts && global.GoatBot.config.autoLoadScripts.enable == true && !global.autoLoadScriptsWatching) {
		global.autoLoadScriptsWatching = true;
		const cfg = global.GoatBot.config.autoLoadScripts;
		const splitList = v => String(v || "").replace(/[ ,]+/g, " ").trim().split(" ").filter(Boolean);
		for (const [folder, ignore] of [["cmds", splitList(cfg.ignoreCmds)], ["events", splitList(cfg.ignoreEvents)]]) {
			const dir = path.join(__dirname, "../../scripts", folder);
			try {
				fs.watch(dir, (event, filename) => {
					if (!filename || !filename.endsWith(".js") || filename.endsWith(".eg.js") || ignore.includes(filename)) return;
					const full = path.join(dir, filename);
					if ((event !== "change" && event !== "rename") || !fs.existsSync(full)) return;
					try {
						const store = global.temp.contentScripts[folder];
						const content = fs.readFileSync(full, "utf-8");
						if (store[filename] === content) return;
						store[filename] = content;
						const name = filename.replace(".js", "");
						const info = global.utils.loadScripts(folder, name, log, global.GoatBot.configCommands, api, threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData);
						if (info.status == "success") log.master("AUTO LOAD SCRIPTS", `${filename} (${info.command.config.name}) has been reloaded`);
						else log.err("AUTO LOAD SCRIPTS", `Error when reload ${filename}`, info.error);
					}
					catch (err) { log.err("AUTO LOAD SCRIPTS", `Error when reload ${filename}`, err); }
				});
			}
			catch (e) { /* folder watch not supported on this host */ }
		}
	}

	if (global.GoatBot.config.dashBoard && global.GoatBot.config.dashBoard.enable == true && !global.dashBoardIsRunning) {
		try {
			await require("../../dashboard/app.js")(api);
			global.dashBoardIsRunning = true;
		}
		catch (err) {
			log.err("DASHBOARD", getText("login", "openDashboardError"), err);
		}
	}

	// ───────────── listener + self healing ───────────── //
	let lastListenActivity = Date.now();
	let relistenTimer = null;
	let dying = false;
	let verifying = false;
	let sentNotiError = false;
	const listenFailTimes = [];

	function restartSelf(code) {
		if (process.send) return process.exit(code);
		// no index.js supervisor (node Aliya.js directly): do the account switch inside this process
		log.warn("RESTART", "No supervisor detected - running the account pool again inside this process");
		startBot().catch(fatal);
	}

	function handleAccountDead(kind, reason) {
		if (dying) return;
		dying = true;
		log.err("SESSION_LOST", `${activeFile} ${kind === "suspended" ? "is SUSPENDED / LOCKED" : "got LOGGED OUT"}: ${pool.short(reason, 120)}`);
		log.err("SESSION_LOST", "Switching to the next available account...");
		pool.markDead(activeFile, kind, reason);
		global.statusAccountBot = kind === "suspended" ? "account_suspended" : "account_logged_out";
		global.responseUptimeCurrent = responseUptimeError;
		send({ type: "POOL", pool: pool.statusTable({ active: null }), active: null });
		setTimeout(() => restartSelf(5), 1000);
	}

	async function verifySession(error, errStr) {
		if (verifying || dying) return;
		verifying = true;
		try {
			if (!sentNotiError) {
				sentNotiError = true;
				try { await handlerWhenListenHasError({ api, threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData, error }); }
				catch (e) { /* notification is optional */ }
			}
			global.statusAccountBot = "can't login";

			if (!(await hasInternet())) {
				log.warn("SESSION", "Facebook not reachable (network problem) - keeping the account, reconnecting later");
				verifying = false;
				return recoverListener("network down");
			}

			let live = null;
			if (typeof checkLiveCookie === "function") {
				const cookie = pool.cookieString(api.getAppState());
				for (let i = 0; i < 3; i++) {
					try { live = (await checkLiveCookie(cookie, facebookAccount.userAgent)) ? true : false; }
					catch (e) { live = null; }
					if (live === true) break;
					if (i < 2) await sleep(5000);
				}
			}

			verifying = false;
			if (live === true) {
				log.warn("SESSION", "Cookie is still alive - it was only an MQTT glitch. Reconnecting...");
				sentNotiError = false;
				return recoverListener("session glitch");
			}
			if (live === false) return handleAccountDead("expired", errStr);
			// cannot verify -> do not kill the account, just start a fresh session
			return recoverListener("session lost (could not verify cookie)");
		}
		catch (e) {
			verifying = false;
			return recoverListener("verify error");
		}
	}

	function recoverListener(reason) {
		if (relistenTimer || dying) return;
		const nowMs = Date.now();
		listenFailTimes.push(nowMs);
		while (listenFailTimes.length && nowMs - listenFailTimes[0] > 10 * 60 * 1000) listenFailTimes.shift();
		if (listenFailTimes.length >= 4) {
			log.err("LISTEN_MQTT", "Listener keeps failing - restarting the whole bot...");
			return restartSelf(2);
		}
		const delay = 5000 * listenFailTimes.length;
		log.warn("LISTEN_MQTT", `Listener lost (${reason}). Reconnecting in ${delay / 1000}s...`);
		relistenTimer = setTimeout(async () => {
			relistenTimer = null;
			try {
				await stopListening();
				await sleep(1000);
				lastListenActivity = Date.now();
				global.GoatBot.Listening = api.listenMqtt(createCallBackListen());
				log.info("LISTEN_MQTT", "Reconnected.");
			}
			catch (e) {
				log.err("LISTEN_MQTT", "Reconnect failed - restarting the whole bot", e);
				restartSelf(2);
			}
		}, delay);
	}

	async function callBackListen(error, event) {
		if (error) {
			global.responseUptimeCurrent = responseUptimeError;
			const errStr = pool.errText(error);

			if (/connection closed/i.test(errStr)) {
				// closed by stopListening() on purpose -> ignore. Closed by Facebook/network -> reconnect.
				if (Date.now() - lastIntentionalStop < 20000) return;
				return recoverListener("MQTT connection closed unexpectedly");
			}
			if (pool.classify(errStr).kind === "suspended") return handleAccountDead("suspended", errStr);
			if (/not logged in|server unavailable|connection refused/i.test(errStr)) return verifySession(error, errStr);

			try { await handlerWhenListenHasError({ api, threadModel, userModel, dashBoardModel, globalModel, threadsData, usersData, dashBoardData, globalData, error }); }
			catch (e) { /* optional */ }
			log.err("LISTEN_MQTT", getText("login", "callBackError"), error);
			recoverListener("MQTT error");
			return;
		}

		global.responseUptimeCurrent = responseUptimeSuccess;
		global.statusAccountBot = "good";
		sentNotiError = false;
		lastListenActivity = Date.now();

		const wlUser = global.GoatBot.config.whiteListMode;
		const wlThread = global.GoatBot.config.whiteListModeThread;
		const isAdmin = (global.GoatBot.config.adminBot || []).includes(event.senderID);
		if (wlUser && wlUser.enable == true && wlThread && wlThread.enable == true && !isAdmin) {
			if (!wlUser.whiteListIds.includes(event.senderID) && !wlThread.whiteListThreadIds.includes(event.threadID)) return;
		}
		else if (wlUser && wlUser.enable == true && !wlUser.whiteListIds.includes(event.senderID) && !isAdmin) {
			return;
		}
		else if (wlThread && wlThread.enable == true && !wlThread.whiteListThreadIds.includes(event.threadID) && !isAdmin) {
			return;
		}

		if (event.messageID && event.type == "message") {
			if (storage5Message.includes(event.messageID)) {
				Object.keys(callbackListenTime).slice(0, -1).forEach(key => { callbackListenTime[key] = () => { }; });
			}
			else {
				storage5Message.push(event.messageID);
			}
			if (storage5Message.length > 5) storage5Message.shift();
		}

		const configLog = global.GoatBot.config.logEvents;
		if (configLog && configLog.disableAll === false && configLog[event.type] !== false) {
			const participantIDs_ = [...(event.participantIDs || [])];
			if (event.participantIDs) event.participantIDs = "Array(" + event.participantIDs.length + ")";
			console.log(colors.green((event.type || "").toUpperCase() + ":"), jsonStringifyColor(event, null, 2));
			if (event.participantIDs) event.participantIDs = participantIDs_;
		}

		if ((event.senderID && dataGban[event.senderID]) || (event.userID && dataGban[event.userID])) {
			if (event.body && event.threadID && event.body.startsWith(getPrefix(event.threadID))) {
				return api.sendMessage(getText("login", "userBanned"), event.threadID);
			}
			return;
		}

		const handlerAction = require("../handler/handlerAction.js")(
			api, threadModel, userModel, dashBoardModel, globalModel, usersData, threadsData, dashBoardData, globalData
		);
		if (!hasBanned) handlerAction(event);
	}

	function createCallBackListen(key) {
		key = randomString(10) + (key || Date.now());
		for (const oldKey of Object.keys(callbackListenTime))
			delete callbackListenTime[oldKey];
		callbackListenTime[key] = callBackListen;
		return (error, event) => callbackListenTime[key](error, event);
	}

	await stopListening();
	global.GoatBot.Listening = api.listenMqtt(createCallBackListen());
	global.GoatBot.callBackListen = callBackListen;

	const restartCfg = global.GoatBot.config.restartListenMqtt;
	if (restartCfg && restartCfg.enable == true && Number(restartCfg.timeRestart) > 0) {
		global.intervalRestartListenMqtt = setInterval(async () => {
			try {
				await stopListening();
				await sleep(Number(restartCfg.delayAfterStopListening) || 1000);
				lastListenActivity = Date.now();
				global.GoatBot.Listening = api.listenMqtt(createCallBackListen());
			}
			catch (e) { recoverListener("scheduled restart failed"); }
		}, Number(restartCfg.timeRestart));
	}

	// nothing heard for 20 min -> reconnect (quiet nights are fine, a reconnect is cheap)
	global.intervalListenWatchdog = setInterval(() => {
		if (Date.now() - lastListenActivity > 20 * 60 * 1000) {
			lastListenActivity = Date.now();
			recoverListener("no MQTT activity for 20 min");
		}
	}, 60 * 1000);

	ensureBotHttp();
	if (fs.existsSync(path.join(__dirname, "../autoUptime.js"))) {
		try { require("../autoUptime.js"); } catch (e) { log.warn("AUTO UPTIME", e.message); }
	}

	log.master("SUCCESS", getText("login", "runBot"));
	log.master("LOAD TIME", `${convertTime(Date.now() - global.GoatBot.startTime)}`);
	global.GoatBot.startupDone = true;
	send({ type: "READY", account: activeFile, uid: global.botID, pool: table });

	// tell the admin if an account was lost and we switched
	try {
		const notices = pool.takeNotices();
		if (notices.length) {
			const adminId = (global.GoatBot.config.adminBot || [])[0];
			if (adminId) {
				const lines = notices.map(n => `• ${pool.short(n.text, 120)}`);
				const prefix = (global.GoatBot.config && global.GoatBot.config.prefix) || "/";
				const msg = `Account alert\n${lines.join("\n")}\n\nBot is now running on: ${activeFile}\nUse "${prefix}account status" to see all 5 accounts.`;
				setTimeout(() => { try { api.sendMessage(msg, adminId, () => { }); } catch (e) { /* admin not reachable */ } }, 8000);
			}
		}
	}
	catch (e) { /* ignore */ }
}

function allAccountsFailed(table, reason) {
	log.err("ACCOUNT POOL", `${reason}! Entering Server Offline / Restarting mode...`);
	global.statusAccountBot = "all_accounts_failed";
	global.responseUptimeCurrent = responseUptimeError;
	global.GoatBot.poolOffline = true;
	pool.setActive(null);
	send({ type: "ALL_ACCOUNTS_FAILED", pool: table, reason });

	if (process.send) {
		// index.js shows the offline page, waits (back-off) and starts us again
		setTimeout(() => process.exit(3), 600);
		return;
	}
	// standalone mode: stay alive, show offline page, retry every 5 min
	startUptimeServer(botHttpPort());
	log.warn("ACCOUNT POOL", "Standalone mode: will try the account pool again in 5 minutes.");
	setTimeout(() => startBot().catch(fatal), 5 * 60 * 1000);
}

function fatal(err) {
	console.error("[LOGIN_FATAL]", err && err.stack ? err.stack : err);
	if (err && err.code === "NO_FCA") {
		log.err("LOGIN", "No Facebook chat library installed (ws3-fca / fb-chat-api). Run: npm install");
		return process.exit(4);
	}
	process.exit(1);
}

global.GoatBot.reLoginBot = () => startBot().catch(fatal);
startBot().catch(fatal);
