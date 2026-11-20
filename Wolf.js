/**
 * ============================================================================
 * 🐺 WOLF.JS v2 - SAFE MODE FOR ALIYA OFFICIAL V4        (Maintained by Mr.king)
 *
 * index.js starts Wolf.js INSTEAD of Aliya.js when Aliya.js keeps crashing. Wolf does two jobs:
 *
 *   1. DOCTOR   finds out WHY the bot crashes and repairs what can be repaired safely:
 *               missing / broken node_modules · one missing package · native module built for another Node
 *               version · corrupted config.json / configCommands.json (last good copy is restored) ·
 *               corrupted SQLite file (moved aside) · full disk · syntax errors in core files (reported).
 *               If something was repaired, Wolf hands control straight back to Aliya.js.
 *
 *   2. ENGINE   if nothing could be repaired, Wolf keeps the BOT ONLINE meanwhile. It logs in with the same
 *               account pool (account.txt ... account5.txt) and answers messages in three layers:
 *                 Layer 1 FULL      the project's own loadData + loadScripts + handlerAction (everything works)
 *                 Layer 2 BUILT-IN  Wolf's own command loader/dispatcher (roles, cooldown, onChat/onReply/...)
 *                 Layer 3 MINIMAL   ping / help / account, even when every command file is broken
 *               Every few minutes it hands control back to Aliya.js (exit code 3) - sooner when the core
 *               files are healthy, later (never) while a core file still has a syntax error.
 *
 * Exit codes   3 = every account failed -> index.js shows the "Restarting / Offline" page
 *              7 = fast restart requested (hand-back to Aliya.js / admin account switch)
 *              5 = active account died -> restart on the next account
 *              6 = npm package missing -> index.js installs it
 *              2 = restart Wolf (listener keeps failing / session lost)
 *              anything else = crash (index.js applies back-off)
 * Needs only Node itself until the engine starts, so it works even with an empty node_modules.
 * ============================================================================
 */

"use strict";

// ───────────── 0. shared state (defined FIRST - the old Wolf read it before it existed) ───────────── //
const state = {
	started: false, layer: "starting", offline: false, reason: "", active: null, uid: null,
	phase: "checking", table: [], lastEvent: Date.now(), handled: 0, errors: 0, retryAt: 0
};
const steps = [];
let fixedSomething = false;
let coreBroken = false;
let handBackAt = 0;
let handingBack = false;

const supervised = typeof process.send === "function";
const send = msg => { if (supervised) { try { process.send(msg); } catch (e) { /* launcher gone */ } } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toTimeString().split(" ")[0];
const say = (tag, msg) => console.log(`\x1b[33m[${stamp()}] 🐺 [WOLF::${tag}]\x1b[0m ${msg}`);

try { process.stdout.write("\x1b]2;Aliya V4 - Wolf Safe Mode\x1b\x5c"); } catch (e) { /* no tty */ }
require("events").EventEmitter.defaultMaxListeners = 150;
process.setMaxListeners(150);

const crashTimes = [];
process.on("unhandledRejection", e => say("REJECTION", e && e.message ? e.message : String(e)));
process.on("uncaughtException", e => {
	say("UNCAUGHT", e && e.stack ? e.stack : String(e));
	const t = Date.now();
	crashTimes.push(t);
	while (crashTimes.length && t - crashTimes[0] > 60000) crashTimes.shift();
	if (crashTimes.length >= 8) { say("LOOP", "Too many errors in 60s - restarting"); process.exit(1); }
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

const hb = () => send({ type: "HEARTBEAT", rss: process.memoryUsage().rss });
hb();
setInterval(hb, 15000).unref();

const RSS_LIMIT_MB = Number(process.env.ALIYA_RSS_LIMIT_MB) || 0;
if (RSS_LIMIT_MB > 0) {
	let over = 0;
	let cleaning = false;
	const autoFreshCleanup = (() => {
		try { return require("./bot/login/autoFresh.js"); }
		catch (e) { return null; }
	})();
	setInterval(async () => {
		const mb = process.memoryUsage().rss / 1048576;
		if (mb > RSS_LIMIT_MB) {
			over++;
			say("MEMORY", `RSS ${Math.round(mb)}MB is above ${RSS_LIMIT_MB}MB (${over}/2)`);
			if (over >= 2 && !cleaning) {
				cleaning = true;
				say("MEMORY", "Memory limit reached. Cleaning temporary data and restarting fresh...");
				try { if (typeof autoFreshCleanup === "function") await autoFreshCleanup(); } catch (e) {}
				process.exit(2);
			}
		}
		else over = 0;
	}, 30000).unref();
}

// ───────────── imports (built-ins only until the engine starts) ───────────── //
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const CRASH_LOG = process.env.ALIYA_CRASH_LOG || path.join(DATA_DIR, "last-crash.log");
const STATE_FILE = path.join(DATA_DIR, "wolf.json");
const SAFE_MS = Number(process.env.ALIYA_SAFE_MS) || 10 * 60 * 1000;
const RETRY_MS = Number(process.env.ALIYA_RETRY_MS) || 30000;
const DRY_RUN = process.env.ALIYA_WOLF_DRYRUN === "1";         // tests only: print repair commands instead of running them
const NO_ENGINE = process.env.ALIYA_WOLF_NO_ENGINE === "1";    // tests / "doctor only"
const NPM_LIMIT_PER_HOUR = 3;

// ───────────── account pool (shared truth with index.js / Aliya.js) ───────────── //
let pool = null;
try { pool = require("./bot/login/accountPool.js"); }
catch (e) { say("POOL", `accountPool.js not usable (${e.message}). The engine is disabled, the doctor still works.`); }

let typing = null;
try { typing = require("./bot/handler/typingIndicator.js"); }
catch (e) { typing = null; }

let commandLanguage = null;
try { commandLanguage = require("./bot/handler/commandLanguage.js"); }
catch (e) { commandLanguage = null; }

// ═════════════════════════════════ 1. DOCTOR ═════════════════════════════════ //

function clean(text) {
	return String(text || "")
		.replace(/\b(c_user|xs|datr|fr|sb|fbstate|appstate|access_token|password|secret|token)\s*[=:]\s*\S+/gi, "$1=…")
		.replace(/[A-Za-z0-9%_\-.]{28,}/g, "…")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}

function addStep(name, status, detail) {
	const step = { name, status, detail: detail ? clean(detail) : "" };
	steps.push(step);
	const icon = { ok: "✅", fixed: "🔧", problem: "❌", info: "ℹ️" }[status] || "•";
	say("DOCTOR", `${icon} ${name}${step.detail ? " - " + step.detail : ""}`);
	return step;
}

function loadWolfState() {
	try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return { npmRuns: [], handBacks: [], sessionStart: 0 }; }
}
function saveWolfState(s) {
	try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

function readJson(file) {
	try { return { ok: true, data: JSON.parse(fs.readFileSync(file, "utf8")) }; }
	catch (e) { return { ok: false, error: e.code === "ENOENT" ? "missing" : "invalid JSON" }; }
}

function runNpm(args, timeoutMs = 12 * 60 * 1000) {
	return new Promise(resolve => {
		if (DRY_RUN) {
			say("DOCTOR", `[dry-run] npm ${args.join(" ")}`);
			return resolve({ ok: true, code: 0, tail: "" });
		}
		let tail = [];
		let proc;
		try {
			proc = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
				cwd: ROOT,
				shell: process.platform === "win32",
				env: { ...process.env, npm_config_loglevel: "error", npm_config_audit: "false", npm_config_fund: "false" }
			});
		}
		catch (e) { return resolve({ ok: false, code: -1, tail: e.message }); }
		const collect = d => { tail.push(...String(d).split("\n").filter(Boolean)); tail = tail.slice(-12); };
		proc.stdout.on("data", collect);
		proc.stderr.on("data", collect);
		const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (e) { /* ignore */ } }, timeoutMs);
		proc.on("error", e => { clearTimeout(killer); resolve({ ok: false, code: -1, tail: e.message }); });
		proc.on("exit", code => { clearTimeout(killer); resolve({ ok: code === 0, code, tail: tail.join(" | ") }); });
	});
}

// npm repairs are limited (3 per hour) so a bad network can never turn Wolf into an install loop
function npmAllowed() {
	const st = loadWolfState();
	st.npmRuns = (st.npmRuns || []).filter(t => Date.now() - t < 3600 * 1000);
	return st.npmRuns.length < NPM_LIMIT_PER_HOUR;
}
function npmCounted() {
	const st = loadWolfState();
	st.npmRuns = (st.npmRuns || []).filter(t => Date.now() - t < 3600 * 1000);
	st.npmRuns.push(Date.now());
	saveWolfState(st);
}

async function repairWithNpm(label, args) {
	if (!npmAllowed()) {
		addStep(label, "problem", `skipped: npm already ran ${NPM_LIMIT_PER_HOUR}x in the last hour`);
		return false;
	}
	npmCounted();
	state.phase = "repairing";
	say("DOCTOR", `running: npm ${args.join(" ")}`);
	const r = await runNpm(args);
	if (r.ok) {
		fixedSomething = true;
		addStep(label, "fixed", "done");
		return true;
	}
	addStep(label, "problem", `npm failed (code ${r.code}) ${r.tail}`);
	return false;
}

function checkNode() {
	const major = Number(process.versions.node.split(".")[0]);
	if (major >= 20) addStep("Node.js version", "ok", process.version);
	else if (major >= 18) addStep("Node.js version", "info", `${process.version} works, Node 20+ is recommended`);
	else addStep("Node.js version", "problem", `${process.version} is too old - install Node 20 or newer`);
}

function checkDisk() {
	try {
		fs.mkdirSync(DATA_DIR, { recursive: true });
		const probe = path.join(DATA_DIR, ".wolf-probe");
		fs.writeFileSync(probe, "ok");
		fs.unlinkSync(probe);
		addStep("Disk is writable", "ok");
	}
	catch (e) {
		addStep("Disk is writable", "problem", `${e.code || e.message} - the host disk is full or read-only`);
	}
	const freeMB = Math.round(os.freemem() / 1048576);
	addStep("Free memory", freeMB < 60 ? "problem" : "info", `${freeMB}MB free of ${Math.round(os.totalmem() / 1048576)}MB`);
}

function cleanTempFiles() {
	let removed = 0;
	for (const dir of ["scripts/cmds/cache", "scripts/cmds/tmp"]) {
		const full = path.join(ROOT, dir);
		let files;
		try { files = fs.readdirSync(full); } catch (e) { continue; }
		for (const name of files) {
			try {
				const file = path.join(full, name);
				if (fs.statSync(file).isFile()) { fs.unlinkSync(file); removed++; }
			}
			catch (e) { /* ignore */ }
		}
	}
	return removed;
}

function checkConfigs() {
	for (const name of ["config.json", "configCommands.json"]) {
		const file = path.join(ROOT, name);
		const now = readJson(file);
		if (now.ok) { addStep(name, "ok"); continue; }

		const backup = path.join(DATA_DIR, "backup", name);
		if (readJson(backup).ok) {
			try {
				if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.broken-${Date.now()}`); // never destroy the broken one
				fs.copyFileSync(backup, file);
				fixedSomething = true;
				addStep(name, "fixed", `was ${now.error} - restored the last good copy`);
			}
			catch (e) {
				addStep(name, "problem", `was ${now.error}, restore failed: ${e.code || e.message}`);
			}
		}
		else addStep(name, "problem", `${now.error} and there is no backup. Re-upload it from your GitHub repo.`);
	}
}

function dependencyNames() {
	const pkg = readJson(path.join(ROOT, "package.json"));
	if (!pkg.ok) {
		addStep("package.json", "problem", pkg.error);
		return [];
	}
	addStep("package.json", "ok");
	return Object.keys(pkg.data.dependencies || {});
}

const missingModules = names => names.filter(n => !fs.existsSync(path.join(ROOT, "node_modules", n, "package.json")));

const NATIVE_MISMATCH = /NODE_MODULE_VERSION|compiled against a different Node\.js version|ERR_DLOPEN_FAILED|invalid ELF header|not a valid Win32 application|did not self-register|Could not locate the bindings file/i;
const SQLITE_BROKEN = /SQLITE_CORRUPT|database disk image is malformed|SQLITE_NOTADB|file is not a database/i;
const OUT_OF_MEMORY = /heap out of memory|ENOMEM|Allocation failed|JavaScript heap/i;
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function readCrashLog() {
	try { return fs.readFileSync(CRASH_LOG, "utf8"); } catch (e) { return ""; }
}

async function analyzeCrash(log) {
	if (!log.trim()) {
		addStep("Last crash", "info", "no crash log saved yet");
		return;
	}
	const headline = log.split("\n").find(l => /Error|Cannot find|FATAL|SyntaxError|ERR_/.test(l)) || log.split("\n")[1] || "";
	addStep("Last crash", "info", headline);

	const mm = log.match(/Cannot find module '([^']+)'/);
	if (mm) {
		const spec = mm[1];
		if (spec.startsWith(".") || spec.startsWith("/")) {
			addStep("Project file missing", "problem", `${path.basename(spec)} is not in your project - re-upload it from GitHub`);
		}
		else {
			const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
			if (!PACKAGE_NAME.test(pkgName)) addStep("Missing module", "problem", "unusual module name, not touching it");
			else if (!fs.existsSync(path.join(ROOT, "node_modules", pkgName, "package.json")))
				await repairWithNpm(`Install missing package ${pkgName}`, ["install", pkgName, "--no-audit", "--no-fund"]);
		}
	}

	if (NATIVE_MISMATCH.test(log))
		await repairWithNpm("Rebuild native modules for this Node version", ["rebuild"]);

	if (SQLITE_BROKEN.test(log)) {
		const dbFile = path.join(ROOT, "database", "data", "data.sqlite");
		if (fs.existsSync(dbFile)) {
			const tag = `.corrupt-${Date.now()}`;
			try {
				for (const ext of ["", "-wal", "-shm"]) if (fs.existsSync(dbFile + ext)) fs.renameSync(dbFile + ext, dbFile + ext + tag);
				fixedSomething = true;
				addStep("SQLite database is corrupted", "fixed", `moved aside as data.sqlite${tag}; a fresh one is created on start (old data stays in that file)`);
			}
			catch (e) { addStep("SQLite database is corrupted", "problem", `could not move it: ${e.code || e.message}`); }
		}
		else addStep("SQLite database is corrupted", "info", "database file not found at database/data/data.sqlite");
	}

	if (/ENOSPC/.test(log)) {
		const n = cleanTempFiles();
		if (n) fixedSomething = true;
		addStep("Disk is full", n ? "fixed" : "problem", n ? `deleted ${n} old temp file(s)` : "nothing to delete - the host disk is full");
	}

	if (OUT_OF_MEMORY.test(log)) {
		const n = cleanTempFiles();
		addStep("Ran out of memory", "info", `${n ? `cleared ${n} temp file(s); ` : ""}use a bigger plan, or set ALIYA_MAX_MEM_MB, or remove heavy commands`);
	}

	if (/EACCES|EPERM/.test(log)) addStep("Permission problem", "info", "the bot cannot read/write a file or folder (EACCES/EPERM)");
	if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/.test(log)) addStep("Network problem", "info", "the host could not reach the internet for a moment");
}

// `node --check` every core file: a syntax error there is the most common reason Aliya.js cannot start
const CORE_FILES = [
	"Aliya.js", "utils.js",
	"bot/login/login.js", "bot/login/loadData.js", "bot/login/loadScripts.js", "bot/login/accountPool.js", "bot/login/accountManager.js",
	"bot/handler/handlerAction.js", "bot/handler/handlerEvents.js", "bot/handler/handlerCheckData.js", "bot/handler/typingIndicator.js",
	"database/connectDB/connectSqlite.js", "database/controller/index.js", "bot/handler/commandLanguage.js"
];

function syntaxCheck(file) {
	return new Promise(resolve => {
		let out = "";
		let proc;
		try { proc = spawn(process.execPath, ["--check", path.join(ROOT, file)], { stdio: ["ignore", "ignore", "pipe"] }); }
		catch (e) { return resolve({ ok: true }); }
		proc.stderr.on("data", d => { out += d; });
		const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch (e) { /* ignore */ } }, 15000);
		proc.on("error", () => { clearTimeout(killer); resolve({ ok: true }); });
		proc.on("exit", code => {
			clearTimeout(killer);
			if (code === 0) return resolve({ ok: true });
			const line = out.split("\n").find(l => /:\d+/.test(l)) || "";
			const msg = out.split("\n").find(l => /Error/.test(l)) || "syntax error";
			const m = line.match(/:(\d+)/);
			resolve({ ok: false, line: m ? m[1] : "?", message: msg });
		});
	});
}

async function checkCoreFiles(quiet) {
	const broken = [];
	for (const file of CORE_FILES) {
		if (!fs.existsSync(path.join(ROOT, file))) continue;
		const r = await syntaxCheck(file);
		if (!r.ok) broken.push(`${file}:${r.line} ${r.message}`);
	}
	coreBroken = broken.length > 0;
	if (!quiet) {
		if (broken.length) for (const b of broken) addStep("Syntax error in core file", "problem", b);
		else addStep("Core files", "ok", "no syntax errors");
	}
	return broken;
}

function checkAccounts() {
	if (!pool) return;
	try {
		const { usable, deadOnes } = pool.candidates();
		if (!usable.length && !deadOnes.length) addStep("Account cookies", "problem", "no valid cookie in account.txt ... account5.txt");
		else addStep("Account cookies", "ok", `${usable.length} ready${deadOnes.length ? `, ${deadOnes.length} resting after a failed login` : ""}`);
	}
	catch (e) { /* optional */ }
}

async function diagnoseAndRepair() {
	say("DOCTOR", "Safe mode started. Looking for the problem...");
	checkNode();
	checkDisk();
	checkConfigs();

	const names = dependencyNames();
	if (missingModules(names).length) {
		const miss = missingModules(names);
		addStep("node_modules", "problem", `${miss.length} package(s) missing (${miss.slice(0, 4).join(", ")}${miss.length > 4 ? ", ..." : ""})`);
		await repairWithNpm("Reinstall dependencies", ["install", "--omit=dev", "--no-audit", "--no-fund"]);
	}
	else if (names.length) addStep("node_modules", "ok", `${names.length} packages present`);

	await analyzeCrash(readCrashLog());
	await checkCoreFiles();
	checkAccounts();
}

// ═════════════════════════════════ 2. STATUS PAGE ═════════════════════════════════ //

function esc(s) {
	return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
}

function page() {
	const icon = { ok: "✅", fixed: "🔧", problem: "❌", info: "ℹ️" };
	let title;
	let sub;
	if (state.offline) {
		title = "Restarting…";
		const left = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
		sub = `${state.reason || "No account could log in."} Checking again in ${left}s. Replace the cookie to bring the bot back now.`;
	}
	else if (state.phase === "checking") { title = "Checking…"; sub = "Wolf is looking for the problem."; }
	else if (state.phase === "repairing") { title = "Repairing…"; sub = "Wolf is fixing the problem."; }
	else if (state.started) { title = "Online (safe mode)"; sub = `Running on ${state.active} · ${state.layer.toUpperCase()} layer. The main engine is tried again automatically.`; }
	else { title = "Starting…"; sub = "Logging in…"; }

	const rows = steps.map(s => `<div class="row"><span>${icon[s.status] || "•"} ${esc(s.name)}</span><span>${esc(s.detail)}</span></div>`).join("");
	let acc = "";
	if (pool) {
		try { acc = pool.statusTable({ active: state.active }).map(r => `<div class="row"><span>${esc(r.file)}</span><span>${esc(r.status)}</span></div>`).join(""); } catch (e) { /* ignore */ }
	}
	const left = handBackAt ? Math.max(0, Math.ceil((handBackAt - Date.now()) / 1000)) : 0;
	const next = handBackAt && !handingBack ? `<div class="row"><span>Back to main engine</span><span>${coreBroken ? "waiting for a fix" : `in ${Math.floor(left / 60)}m ${left % 60}s`}</span></div>` : "";
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>Aliya · Safe mode</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:18px;background:radial-gradient(circle at 20% 20%,#16213e,#0b0c1a 55%,#000);font-family:system-ui,"Segoe UI",sans-serif;color:#fff}
.card{width:min(96vw,520px);padding:28px 22px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:22px;box-shadow:0 20px 60px rgba(76,201,240,.25)}
h1{text-align:center;font-size:26px;background:linear-gradient(90deg,#4cc9f0,#b5179e);-webkit-background-clip:text;background-clip:text;color:transparent}
.pill{display:block;width:max-content;margin:14px auto 6px;padding:7px 16px;border-radius:999px;font-weight:600;background:rgba(76,201,240,.14);border:1px solid rgba(76,201,240,.5);color:#8be3ff}
.sub{text-align:center;font-size:14px;opacity:.8;line-height:1.5;margin:6px 0 14px}.row{display:flex;justify-content:space-between;gap:12px;padding:8px 2px;font-size:13px;border-top:1px solid rgba(255,255,255,.1)}
.row span:last-child{opacity:.7;text-align:right;word-break:break-word}h2{font-size:12px;letter-spacing:2px;opacity:.5;margin:16px 0 2px;text-transform:uppercase}.foot{margin-top:14px;text-align:center;font-size:12px;opacity:.45}</style></head>
<body><div class="card"><h1>🐺 WOLF · SAFE MODE</h1><span class="pill">${esc(title)}</span><div class="sub">${esc(sub)}</div>
${rows ? `<h2>Checks</h2>${rows}` : ""}${acc ? `<h2>Accounts</h2>${acc}` : ""}${next}<div class="foot">Aliya Official V4 · Made with ❤️ by Mr.king</div></div></body></html>`;
}

function startServer() {
	const port = Number(process.env.PORT) || 3001;
	const host = process.env.ALIYA_NO_PROXY === "1" ? "0.0.0.0" : "127.0.0.1";
	const server = http.createServer((req, res) => {
		const url = (req.url || "/").split("?")[0];
		if (url === "/health" || url === "/uptime" || url === "/status.json") {
			const online = state.started && !state.offline;
			res.writeHead(online || url === "/status.json" ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
			return res.end(JSON.stringify({
				status: state.offline ? "offline" : "online", engine: "Wolf.js", phase: state.phase, layer: state.layer, activeAccount: state.active,
				handled: state.handled, errors: state.errors, uptime: Math.floor(process.uptime()), steps: steps.map(s => ({ name: s.name, status: s.status }))
			}));
		}
		if (url === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			return res.end(req.method === "HEAD" ? undefined : page());
		}
		res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "10" });
		res.end(JSON.stringify({ status: "safe-mode" }));
	});
	server.on("clientError", (err, socket) => socket.destroy());
	server.on("error", e => say("WEB", `Status server not started: ${e.message}`));
	server.listen(port, host, () => say("WEB", `Status server on ${host}:${port}`));
}

// ═════════════════════════════════ 3. ENGINE ═════════════════════════════════ //

let config = { prefix: "/", language: "en", adminBot: [], optionsFca: { listenEvents: true, logLevel: "silent", forceLogin: true } };
let configCommands = { envGlobal: {}, envCommands: {}, envEvents: {}, commandBanned: [] };
let U = null;
let prefixOf = () => config.prefix || "/";

function readConfigSafe(base, fallback) {
	for (const f of [`${base}.dev.json`, `${base}.json`]) {
		const full = path.join(ROOT, f);
		if (!fs.existsSync(full)) continue;
		try { return JSON.parse(fs.readFileSync(full, "utf8")); }
		catch (e) { say("CONFIG", `${f} has a JSON error (${e.message}). Using safe defaults.`); }
	}
	return fallback;
}

function prepareGlobals() {
	config = Object.assign(config, readConfigSafe("config", {}));
	configCommands = Object.assign(configCommands, readConfigSafe("configCommands", {}));
	global.GoatBot = global.GoatBot || {};
	Object.assign(global.GoatBot, {
		startTime: Date.now() - process.uptime() * 1000,
		commands: new Map(), eventCommands: new Map(), aliases: new Map(),
		commandFilesPath: [], eventCommandsFilesPath: [],
		onFirstChat: [], onChat: [], onEvent: [], onReply: new Map(), onReaction: new Map(), onAnyEvent: [],
		config, configCommands,
		envCommands: configCommands.envCommands || {}, envEvents: configCommands.envEvents || {}, envGlobal: configCommands.envGlobal || {},
		reLoginBot() { }, Listening: null, oldListening: [], callbackListenTime: {}, storage5Message: [],
		fcaApi: null, botID: null, activeAccountFile: "account.txt", accountPoolStatus: {}, startupDone: false, isWolfMode: true
	});
	global.db = global.db || { allThreadData: [], allUserData: [], allDashBoardData: [], allGlobalData: [], receivedTheFirstMessage: {} };
	global.client = global.client || {
		dirConfig: path.join(ROOT, "config.json"), dirConfigCommands: path.join(ROOT, "configCommands.json"), dirAccount: path.join(ROOT, "account.txt"),
		countDown: {}, cache: {}, database: { creatingThreadData: [], creatingUserData: [], creatingDashBoardData: [], creatingGlobalData: [] },
		commandBanned: configCommands.commandBanned || []
	};
	global.temp = global.temp || { createThreadData: [], createUserData: [], createThreadDataError: [], filesOfGoogleDrive: { arraybuffer: {}, stream: {}, fileNames: {} }, contentScripts: { cmds: {}, events: {} } };

	try { global.utils = require("./utils.js"); }
	catch (e) {
		say("UTILS", `utils.js not usable (${e.message}). Using a light replacement.`);
		const L = (c, tag, m) => console.log(`${c}[${tag}]\x1b[0m ${m}`);
		const log = { info: (t, m) => L("\x1b[36m", t, m), warn: (t, m) => L("\x1b[33m", t, m), err: (t, m) => L("\x1b[31m", t, m), error: (t, m) => L("\x1b[31m", t, m), success: (t, m) => L("\x1b[32m", t, m), master: (t, m) => L("\x1b[35m", t, m) };
		global.utils = {
			log, getPrefix: () => config.prefix || "/", getText: (g, k) => `${g}:${k}`, convertTime: ms => `${Math.round(ms / 1000)}s`,
			colors: new Proxy({}, { get: () => s => s }), randomString: n => Math.random().toString(36).slice(2, 2 + (n || 8)), loadScripts: null
		};
	}
	U = global.utils;
	prefixOf = tid => { try { return U.getPrefix(tid) || config.prefix || "/"; } catch (e) { return config.prefix || "/"; } };
}

// ───────────── Layer 2: built-in loader and dispatcher ───────────── //
function loadScriptsBuiltIn() {
	let ok = 0;
	let bad = 0;
	for (const [dirName, kind] of [["cmds", "cmd"], ["events", "event"]]) {
		const dir = path.join(ROOT, "scripts", dirName);
		if (!fs.existsSync(dir)) continue;
		for (const file of fs.readdirSync(dir)) {
			if (!file.endsWith(".js") || file.endsWith(".eg.js")) continue;
			const full = path.join(dir, file);
			try {
				delete require.cache[require.resolve(full)];
				const mod = require(full);
				const name = mod && mod.config && mod.config.name;
				if (!name) throw new Error("no config.name");
				const key = String(name).toLowerCase();
				if (kind === "cmd") {
					if (global.GoatBot.commands.has(key)) throw new Error(`duplicate command name "${key}"`);
					global.GoatBot.commands.set(key, mod);
					for (const al of mod.config.aliases || []) global.GoatBot.aliases.set(String(al).toLowerCase(), key);
					if (typeof mod.onChat === "function") global.GoatBot.onChat.push(key);
					if (typeof mod.onEvent === "function") global.GoatBot.onEvent.push(key);
					if (typeof mod.onFirstChat === "function") global.GoatBot.onFirstChat.push(key);
					if (typeof mod.onLoad === "function") { try { mod.onLoad({ api: global.GoatBot.fcaApi }); } catch (e) { /* optional */ } }
				}
				else global.GoatBot.eventCommands.set(key, mod);
				ok++;
			}
			catch (e) { bad++; say("SKIP", `${dirName}/${file}: ${e.message}`); }
		}
	}
	say("SCRIPTS", `Built-in loader: ${global.GoatBot.commands.size} commands, ${global.GoatBot.eventCommands.size} events (${bad} skipped)`);
	return ok;
}

function makeGetLang(mod, folder = "cmds") {
	const code = config.language || "en";
	if (commandLanguage && typeof commandLanguage.createGetText2 === "function")
		return commandLanguage.createGetText2(code, folder, prefixOf(), mod || { config: {} });

	return (key, ...a) => {
		const langs = (mod && mod.langs) || {};
		let text = (langs[code] && langs[code][key]) || (langs.en && langs.en[key]) || key;
		a.forEach((v, i) => { text = text.replace(new RegExp(`%${i + 1}`, "g"), () => String(v)); });
		return text;
	};
}

const cooldowns = new Map();
const dedupe = new Set();
const spam = new Map();

function makeMessage(api, event) {
	const to = event.threadID;
	return {
		send: (m, cb) => new Promise(res => api.sendMessage(m, to, (e, i) => { if (cb) cb(e, i); res(i); })),
		reply: (m, cb) => new Promise(res => api.sendMessage(m, to, (e, i) => { if (cb) cb(e, i); res(i); }, event.messageID)),
		unsend: id => new Promise(res => api.unsendMessage(id, res)),
		reaction: (emoji, id) => new Promise(res => api.setMessageReaction(emoji, id || event.messageID, res, true)),
		err: m => new Promise(res => api.sendMessage(`⚠️ ${m}`, to, () => res(), event.messageID))
	};
}

const stubData = {
	get: async () => ({ data: {}, settings: {}, name: "", members: [], adminIDs: [] }),
	set: async () => { }, create: async () => ({}), getAll: async () => [], getName: async () => "User", refreshInfo: async () => ({})
};

async function roleOf(api, event, mod) {
	const id = String(event.senderID);
	if ((config.adminBot || []).map(String).includes(id)) return 2;
	if (mod && Number(mod.config.role || 0) === 1 && event.isGroup) {
		try { const info = await api.getThreadInfo(event.threadID); if ((info.adminIDs || []).some(a => String(a.id || a) === id)) return 1; } catch (e) { /* not an admin */ }
	}
	return 0;
}

async function dispatchBuiltIn(api, event) {
	const type = event.type;
	// the role is worked out PER EVENT (a shared variable could hand an admin's role to the next user)
	const roleCache = {};
	const getRole = async mod => (roleCache[mod && mod.config.name || "_"] = roleCache[mod && mod.config.name || "_"] ?? await roleOf(api, event, mod));
	const ctx = async (mod, extra, folder = "cmds") => {
		const msg = makeMessage(api, event);
		return Object.assign({
			api, event, message: msg, threadsData: stubData, usersData: stubData, globalData: stubData, dashBoardData: stubData,
			getLang: makeGetLang(mod, folder), role: await getRole(mod), commandName: mod.config.name, args: [], envCommands: global.GoatBot.envCommands,
			envGlobal: global.GoatBot.envGlobal, threadModel: null, userModel: null, prefix: prefixOf(event.threadID)
		}, extra);
	};
	const startTyping = kind => (typing ? typing.start(api, event.threadID, kind) : { stop() { } });

	if (type === "message" || type === "message_reply") {
		const body = String(event.body || "");
		const prefix = prefixOf(event.threadID);
		try {
			if (global.dailyMessageTracker && String(event.senderID) !== String(state.uid))
				global.dailyMessageTracker(event.senderID);
		} catch (e) { }

		if (type === "message_reply" && event.messageReply) {
			const rep = global.GoatBot.onReply.get(event.messageReply.messageID);
			const mod = rep && global.GoatBot.commands.get(rep.commandName);
			if (mod && typeof mod.onReply === "function") {
				const handle = startTyping("reply");
				try { await mod.onReply(await ctx(mod, { Reply: rep, args: body.split(/\s+/) })); }
				finally { handle.stop(); }
				return;
			}
		}
		if (body.startsWith(prefix)) {
			const args = body.slice(prefix.length).trim().split(/\s+/);
			const name = (args.shift() || "").toLowerCase();
			if (!name) return;
			const mod = global.GoatBot.commands.get(name) || global.GoatBot.commands.get(global.GoatBot.aliases.get(name));
			if (!mod || (global.client.commandBanned || []).includes(mod.config.name)) return;
			const role = await getRole(mod);
			if (Number(mod.config.role || 0) > role) return api.sendMessage("⛔ You do not have permission to use this command.", event.threadID, undefined, event.messageID);
			const cdKey = `${mod.config.name}:${event.senderID}`;
			const wait = Number(mod.config.countDown || 0) * 1000;
			if (wait && cooldowns.get(cdKey) > Date.now()) return api.sendMessage(`⏳ Wait ${Math.ceil((cooldowns.get(cdKey) - Date.now()) / 1000)}s.`, event.threadID, undefined, event.messageID);
			if (wait) cooldowns.set(cdKey, Date.now() + wait);
			const handle = startTyping("command");
			try {
				try {
					if (typeof global.dailyTaskTracker === "function")
						global.dailyTaskTracker(event.senderID, mod.config.name);
				}
				catch (e) { /* task tracking must never break a command */ }
				await (mod.onStart || mod.run)(await ctx(mod, { args }));
			}
			finally { handle.stop(); }
			return;
		}
		for (const key of global.GoatBot.onChat) {
			const mod = global.GoatBot.commands.get(key);
			try { await mod.onChat(await ctx(mod, { args: body.split(/\s+/) })); } catch (e) { /* one bad onChat must not stop the others */ }
		}
	}
	else if (type === "message_reaction") {
		const rec = global.GoatBot.onReaction.get(event.messageID);
		const mod = rec && global.GoatBot.commands.get(rec.commandName);
		if (mod && typeof mod.onReaction === "function") {
			const handle = startTyping("reaction");
			try { await mod.onReaction(await ctx(mod, { Reaction: rec })); }
			finally { handle.stop(); }
		}
	}
	for (const key of global.GoatBot.onEvent) {
		const mod = global.GoatBot.commands.get(key);
		try { await mod.onEvent(await ctx(mod, {})); } catch (e) { /* ignore */ }
	}
	if (type === "event") {
		for (const mod of global.GoatBot.eventCommands.values()) {
			try { if (typeof mod.onStart === "function") await mod.onStart(await ctx(mod, {}, "events")); } catch (e) { /* ignore */ }
		}
	}
}

// ───────────── Layer 3: minimal commands (work even if every command file is broken) ───────────── //
function quickEngineRestart() {
	setTimeout(() => process.exit(supervised ? 7 : 0), 1200);
}

async function minimal(api, event) {
	if (event.type !== "message" && event.type !== "message_reply") return;
	const body = String(event.body || "").trim();
	const prefix = prefixOf(event.threadID);
	if (!body.startsWith(prefix)) return;
	const parts = body.slice(prefix.length).trim().split(/\s+/);
	const cmd = (parts.shift() || "").toLowerCase();
	const reply = t => api.sendMessage(t, event.threadID, undefined, event.messageID);
	const isAdmin = (config.adminBot || []).map(String).includes(String(event.senderID));

	if (cmd === "ping") return reply("Pong (Wolf safe mode)");
	if (cmd === "help" || cmd === "wolf") {
		return reply(
			`Wolf safe mode is running (layer: ${state.layer}).\n` +
			`Account: ${state.active || "none"}\n` +
			`The main engine is retried automatically.\n` +
			`Commands: ${prefix}ping | ${prefix}help${isAdmin && pool ? ` | ${prefix}account` : ""}`
		);
	}
	if (cmd !== "account" || !isAdmin || !pool) return;

	const sub = (parts[0] || "status").toLowerCase();
	const arg = parts[1];
	if (["status", "list", "info"].includes(sub)) {
		const rows = pool.statusTable({ active: state.active });
		const forced = pool.getForced();
		let out = "ALIYA ACCOUNT POOL STATUS (Wolf safe mode)\n=============================\n";
		out += `Active now : ${state.active || "none"}\n`;
		out += `Forced slot: ${forced || "none (auto order)"}\n`;
		out += "=============================\n";
		for (const r of rows) out += `${r.slot}. ${r.icon} ${r.file}\n   status : ${r.status}${r.detail ? `\n   info   : ${r.detail}` : ""}\n`;
		out += `Commands: ${prefix}account switch <1-5> | ${prefix}account next | ${prefix}account reset <1-5|all> | ${prefix}account auto`;
		return reply(out);
	}
	if (["switch", "use", "set"].includes(sub)) {
		const r = pool.switchTo(arg || "");
		if (!r.ok) return reply(`Cannot switch: ${r.reason}. Use ${prefix}account status to see the slots.`);
		await reply(`Switching to slot ${r.slot} (${r.file}). Restarting now...`);
		return quickEngineRestart();
	}
	if (["next", "rotate", "skip"].includes(sub)) {
		const n = pool.nextAvailable(state.active);
		if (!n) return reply("No other healthy account available right now.");
		const r = pool.switchTo(n.slot);
		if (!r.ok) return reply(`Cannot switch to ${n.file}: ${r.reason}`);
		await reply(`Rotating to slot ${n.slot} (${n.file}). Restarting now...`);
		return quickEngineRestart();
	}
	if (sub === "reset") {
		if (String(arg).toLowerCase() === "all") {
			for (let n = 1; n <= pool.SLOTS; n++) pool.resetSlot(n);
			await reply("All slots reset. Every account will be tried again.");
			return quickEngineRestart();
		}
		const n = pool.slotOf(arg) || (Number(arg) >= 1 && Number(arg) <= pool.SLOTS ? Number(arg) : 0);
		if (!n) return reply(`Usage: ${prefix}account reset <1-5|all>`);
		pool.resetSlot(n);
		await reply(`Slot ${n} (${pool.FILES[n - 1]}) was reset. Restarting now...`);
		return quickEngineRestart();
	}
	if (sub === "auto" || sub === "clear") {
		pool.clearPreferred();
		await reply("Forced switch removed. Login order is account.txt first again. Restarting now...");
		return quickEngineRestart();
	}
	return reply(`Unknown option. Use ${prefix}account status | switch <1-5> | next | reset <1-5|all> | auto`);
}

// ───────────── login with the pool ───────────── //
async function loginFromPool() {
	// Healthy slots first; resting/failed slots are still tried as a last resort.
	const { usable, deadOnes } = pool.candidates();
	const attemptOrder = [...usable, ...deadOnes];
	const results = {};
	let api = null;
	let file = null;
	let tried = 0;
	let netFails = 0;
	for (const name of attemptOrder) {
		let appState;
		try { appState = await pool.parse(pool.readText(name), { iUser: (config.facebookAccount || {}).i_user }); }
		catch (e) { results[name] = { status: "INVALID FORMAT", detail: pool.short(e.message, 80) }; continue; }
		tried++;
		say("AUTH", `Trying ${name}${deadOnes.includes(name) ? " (last resort)" : ""}...`);
		let r = null;
		for (let i = 1; i <= 2; i++) {
			r = await pool.tryLogin(appState, config.optionsFca || {}, 45000);
			if (r.ok) break;
			if (r.fatal) { say("FCA", "No Facebook chat library installed - asking index.js to install it."); return process.exit(supervised ? 6 : 1); }
			if (pool.classify(r.error).kind !== "network") break;
			await sleep(i * 4000);
		}
		if (r.ok) { api = r.api; file = name; pool.markOk(name); break; }
		const c = pool.classify(r.error);
		if (c.kind === "suspended" || c.kind === "expired") {
			pool.markDead(name, c.kind, c.text);
			results[name] = { status: c.kind === "suspended" ? "SUSPENDED / LOCKED" : "LOGGED OUT / EXPIRED", detail: pool.short(c.text, 80) };
		}
		else if (c.kind === "network") { netFails++; results[name] = { status: "FAILED", detail: `network: ${pool.short(c.text, 70)}` }; }
		else { pool.markFailed(name, c.text); results[name] = { status: "FAILED", detail: pool.short(c.text, 80) }; }
		say("FAIL", `${name}: ${pool.short(c.text, 90)} -> next account`);
	}
	state.table = pool.statusTable({ active: file, results });
	global.GoatBot.accountPoolStatus = pool.toObject(state.table);
	for (const row of state.table) console.log(`  • ${row.file.padEnd(13)} => ${row.status} (${row.detail})`);
	return { api, file, tried, netFails, count: attemptOrder.length };
}

function goOffline(why) {
	state.offline = true;
	state.reason = why;
	state.layer = "offline";
	state.retryAt = Date.now() + RETRY_MS;
	global.GoatBot.poolOffline = true;
	say("OFFLINE", `${why}. The Restarting / Offline page is live.`);
	send({ type: "ALL_ACCOUNTS_FAILED", pool: state.table, reason: why });
	if (supervised) {
		// Let index.js own the retry back-off and the offline page.
		setTimeout(() => process.exit(3), 700);
		return;
	}
	// Standalone (no index.js): keep this process alive and retry by itself.
	say("OFFLINE", `Checking the cookie files again in ${Math.round(RETRY_MS / 1000)}s.`);
	setTimeout(() => { state.offline = false; engineMain().catch(fatal); }, RETRY_MS);
}

function fatal(e) {
	say("FATAL", e && e.stack ? e.stack : String(e));
	process.exit(1);
}

// ───────────── the listener (no stale callbacks, no reconnect loops) ───────────── //
let gen = 0;
let activeApi = null;
let stopFn = null;
let relistenTimer = null;
let lastActivity = Date.now();
let dying = false;
const failTimes = [];

function stopListening() {
	gen++; // silence the old callback FIRST: its "Connection closed" must not count as a new failure
	const api = activeApi;
	try {
		if (api && typeof api.stopListening === "function") api.stopListening(() => { });
		else if (typeof stopFn === "function") stopFn();
	}
	catch (e) { /* already closed */ }
	stopFn = null;
}

function die(file, kind, reason) {
	if (dying) return;
	dying = true;
	say("SESSION_LOST", `${file} ${kind === "suspended" ? "is SUSPENDED / LOCKED" : "got LOGGED OUT"}: ${pool.short(reason, 100)}. Next account...`);
	try { pool.markDead(file, kind, reason); } catch (e) { /* ignore */ }
	try { stopListening(); } catch (e) { /* ignore */ }
	setTimeout(() => process.exit(supervised ? 5 : 1), 800); // 5 = next account (index.js keeps the server online)
}

function recover(why, handle, file) {
	if (relistenTimer || dying) return;
	const t = Date.now();
	failTimes.push(t);
	while (failTimes.length && t - failTimes[0] > 10 * 60 * 1000) failTimes.shift();
	if (failTimes.length >= 4) { say("LISTEN", "Keeps failing - restarting the engine"); return process.exit(supervised ? 7 : 1); }
	const delay = 5000 * failTimes.length;
	say("LISTEN", `Lost (${why}). Reconnecting in ${delay / 1000}s...`);
	relistenTimer = setTimeout(() => {
		relistenTimer = null;
		try { stopListening(); } catch (e) { /* ignore */ }
		setTimeout(() => listen(handle, file), 1000);
	}, delay);
}

function listen(handle, file) {
	const api = activeApi;
	const my = ++gen;
	lastActivity = Date.now();
	try {
		stopFn = api.listenMqtt(async (err, event) => {
			if (my !== gen || dying) return; // stale listener
			if (err) {
				const text = pool.errText(err);
				if (/connection closed/i.test(text)) return recover("connection closed", handle, file);
				if (/not logged in/i.test(text)) return die(file, "expired", text);
				if (pool.classify(text).kind === "suspended") return die(file, "suspended", text);
				state.errors++;
				return recover(pool.short(text, 60), handle, file);
			}
			if (!event) return;
			lastActivity = Date.now();
			state.lastEvent = lastActivity;
			if (event.messageID && event.type === "message") {
				if (dedupe.has(event.messageID)) return;
				dedupe.add(event.messageID);
				if (dedupe.size > 2000) dedupe.clear();
			}
			// anti-spam: more than 12 events from one sender in 10 s are ignored
			if (event.senderID) {
				const n = Date.now();
				const list = (spam.get(event.senderID) || []).filter(x => n - x < 10000);
				list.push(n);
				spam.set(event.senderID, list);
				if (list.length > 12) return;
				if (spam.size > 5000) spam.clear();
			}
			if (String(event.senderID) === String(state.uid)) return; // never answer ourselves
			try { state.handled++; await handle(event); }
			catch (e) { state.errors++; say("HANDLER", pool.short(e && e.message, 160)); }
		});
	}
	catch (e) { say("LISTEN", `Could not start listener: ${e.message}`); recover("start failed", handle, file); }
}

// ───────────── engine main ───────────── //
async function buildHandler(api) {
	// Layer 1: the project's own pipeline
	try {
		const loadData = require("./bot/login/loadData.js");
		const loadScripts = require("./bot/login/loadScripts.js");
		const makeHandler = require("./bot/handler/handlerAction.js");
		const line = () => "─".repeat(40);
		const d = await loadData(api, line);
		try { if (fs.existsSync(path.join(ROOT, "bot", "custom.js"))) await require("./bot/custom.js")({ api, ...d, getText: U.getText }); } catch (e) { say("CUSTOM", e.message); }
		await loadScripts(api, d.threadModel, d.userModel, d.dashBoardModel, d.globalModel, d.threadsData, d.usersData, d.dashBoardData, d.globalData, line);
		const act = makeHandler(api, d.threadModel, d.userModel, d.dashBoardModel, d.globalModel, d.usersData, d.threadsData, d.dashBoardData, d.globalData);
		return { layer: "full", handle: ev => act(ev) };
	}
	catch (e) {
		say("LAYER1", `Full project loader not available (${e.message}). Using the built-in loader.`);
	}
	// Layer 2: Wolf's own loader
	global.GoatBot.commands = new Map(); global.GoatBot.aliases = new Map(); global.GoatBot.eventCommands = new Map();
	global.GoatBot.onChat = []; global.GoatBot.onEvent = []; global.GoatBot.onFirstChat = [];
	try {
		if (loadScriptsBuiltIn() > 0) return { layer: "built-in", handle: ev => dispatchBuiltIn(api, ev) };
	}
	catch (e) { say("LAYER2", `Built-in loader failed: ${e.message}`); }
	// Layer 3: minimal
	return { layer: "minimal", handle: ev => minimal(api, ev) };
}

async function engineMain() {
	if (handingBack) return;
	state.offline = false;
	global.GoatBot.poolOffline = false;

	const { api, file, tried, netFails, count } = await loginFromPool();
	if (!api) {
		let why = "All accounts failed or are suspended.";
		if (!count) why = "No usable account cookie (account.txt ... account5.txt).";
		else if (tried && netFails === tried) why = "Facebook is not reachable (network problem).";
		return goOffline(why);
	}

	const uid = api.getCurrentUserID();
	activeApi = api;
	state.active = file;
	state.uid = uid;
	Object.assign(global.GoatBot, { fcaApi: api, botID: uid, activeAccountFile: file });
	global.botID = uid;
	global.client.dirAccount = pool.filePath(file);
	pool.setActive(file, uid);
	pool.clearPreferred();
	send({ type: "POOL", pool: state.table, active: file });
	say("SUCCESS", `Logged in with ${file} (UID ${uid})`);

	// keep the cookie fresh without ever overwriting a cookie you just pasted
	let knownHash = pool.hashText(pool.readText(file));
	setInterval(() => {
		try {
			const st = pool.filterKeys(api.getAppState());
			if (!pool.appStateIsHealthy(st) || pool.hashText(pool.readText(file)) !== knownHash) return;
			const text = JSON.stringify(st, null, 2);
			if (pool.writeText(file, text)) knownHash = pool.hashText(text);
		}
		catch (e) { /* ignore */ }
	}, 30 * 60 * 1000).unref();

	const { layer, handle } = await buildHandler(api);
	state.layer = layer;
	say("LAYER", `Running in layer: ${layer.toUpperCase()}`);

	listen(handle, file);
	setInterval(() => {
		if (Date.now() - lastActivity > 20 * 60 * 1000) { lastActivity = Date.now(); recover("no activity for 20 min", handle, file); }
	}, 60000).unref();

	global.GoatBot.reLoginBot = () => process.exit(supervised ? 2 : 1);
	global.GoatBot.startupDone = true;
	state.started = true;
	state.phase = "online";
	say("READY", `Wolf is online on ${file} | layer ${layer}`);
	send({ type: "READY", account: file, pool: state.table });
}

// ═════════════════════════════════ 4. LIFECYCLE ═════════════════════════════════ //

async function handBack(reason) {
	if (handingBack) return;
	handingBack = true;
	say("HANDBACK", `${reason} -> starting Aliya.js again.`);
	const st = loadWolfState();
	st.handBacks = (st.handBacks || []).filter(t => Date.now() - t < 2 * 3600 * 1000);
	st.handBacks.push(Date.now());
	st.sessionStart = 0;
	saveWolfState(st);
	try { stopListening(); } catch (e) { /* ignore */ }
	try { if (pool) pool.setActive(null); } catch (e) { /* ignore */ }
	send({ type: "ENGINE_HANDBACK" });
	// 7 is a planned fast restart, NOT "all accounts failed" (code 3).
	setTimeout(() => process.exit(supervised ? 7 : 0), 700);
}

(async () => {
	startServer();

	try { await diagnoseAndRepair(); }
	catch (e) { addStep("Wolf itself", "problem", e && e.message); }

	// Something was repaired: the main engine deserves another try right now
	if (fixedSomething) {
		state.phase = "repaired";
		handBackAt = Date.now() + 1500;
		return handBack("Repairs done");
	}

	// How long may Wolf stay? 3 min the first time; longer when Aliya.js crashed again right after a hand-back.
	const st = loadWolfState();
	st.handBacks = (st.handBacks || []).filter(t => Date.now() - t < 2 * 3600 * 1000);
	if (!st.sessionStart || Date.now() - st.sessionStart > 45 * 60 * 1000) st.sessionStart = Date.now();
	saveWolfState(st);
	const base = Math.min(SAFE_MS, 3 * 60 * 1000);
	const stayMs = Math.min(SAFE_MS, base * 2 ** st.handBacks.length);
	handBackAt = st.sessionStart + stayMs;
	say("PLAN", `Staying in safe mode about ${Math.round(Math.max(0, handBackAt - Date.now()) / 1000)}s (Aliya.js crashed ${st.handBacks.length}x recently).`);

	// Watcher: hand back when the time is up and the core files are healthy
	setInterval(async () => {
		if (handingBack || Date.now() < handBackAt) return;
		if (coreBroken) {
			const broken = await checkCoreFiles(true);
			if (broken.length) { handBackAt = Date.now() + 60000; return; } // still broken: Aliya.js would just crash again
			addStep("Core files", "fixed", "syntax errors are gone");
		}
		handBack("Safe-mode time is over");
	}, 5000);

	if (NO_ENGINE || !pool) {
		state.phase = "waiting";
		return say("ENGINE", pool ? "Engine disabled (doctor only)." : "No account pool: engine disabled.");
	}

	state.phase = "starting";
	prepareGlobals();
	try { pool.seedFromEnv(); } catch (e) { /* ignore */ }
	try { await engineMain(); }
	catch (e) { fatal(e); }
})();
