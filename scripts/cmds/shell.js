const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

let currentCwd = process.cwd();
const activeProcesses = new Map();

const ROOT = () => process.cwd();
const CONFIG_PATH = () => path.join(ROOT(), "config.json");

function prefixOf(event) {
  try {
    if (global.utils && typeof global.utils.getPrefix === "function")
      return global.utils.getPrefix(event && event.threadID) || (global.GoatBot && global.GoatBot.config && global.GoatBot.config.prefix) || "(";
  }
  catch (e) { /* ignore */ }
  return (global.GoatBot && global.GoatBot.config && global.GoatBot.config.prefix) || "(";
}

function restartSoon() {
  setTimeout(() => {
    try {
      if (process.send) process.exit(7); // supervisor: fast restart / account switch
      else if (global.GoatBot && typeof global.GoatBot.reLoginBot === "function") global.GoatBot.reLoginBot();
      else process.exit(0);
    }
    catch (e) { /* supervisor restarts us anyway */ }
  }, 1200);
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH(), "utf8")); }
  catch (e) { return null; }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

// Runs a real shell command and streams the output back to Messenger.
function runShell(api, event, commandText, label) {
  const { threadID, messageID, senderID } = event;
  api.setMessageReaction("⏳", messageID, () => {}, true);

  const child = spawn(commandText, {
    shell: true,
    cwd: currentCwd,
    env: { ...process.env, TERM: "xterm-256color", PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let outputBuffer = "";
  let isFinished = false;
  let promptSent = false;
  let promptTimer = null;

  const procObj = { child, senderID, isFinished: false };
  const startLine = label ? `$ ${label}\n\n` : "";

  const sendOutputMessage = (text, isFinal) => {
    let cleanText = text.trim() || (isFinal ? "Command finished with no output." : "");
    if (!cleanText) return;
    if (cleanText.length > 3800) cleanText = cleanText.substring(0, 3800) + "\n\n...[Output Truncated]";

    const header = isFinal
      ? "── SHELL OUTPUT ──"
      : "── INPUT REQUIRED (Reply with 'y', text, or 'kill') ──";

    api.sendMessage(`${header}\n\n\`\`\`bash\n${startLine}${cleanText}\n\`\`\``, threadID, (err, info) => {
      if (!err && info && !isFinal) {
        activeProcesses.set(info.messageID, procObj);
        global.GoatBot?.onReply?.set(info.messageID, {
          commandName: module.exports.config.name,
          messageID: info.messageID,
          author: senderID
        });
      }
    }, messageID);
  };

  const resetInputWaitTimer = () => {
    if (promptTimer) clearTimeout(promptTimer);
    promptTimer = setTimeout(() => {
      if (!isFinished && outputBuffer.trim()) {
        promptSent = true;
        const currentOut = outputBuffer;
        outputBuffer = "";
        sendOutputMessage(currentOut, false);
      }
    }, 3000);
  };

  child.stdout.on("data", data => { outputBuffer += data.toString(); resetInputWaitTimer(); });
  child.stderr.on("data", data => { outputBuffer += data.toString(); resetInputWaitTimer(); });

  child.on("close", code => {
    isFinished = true;
    procObj.isFinished = true;
    if (promptTimer) clearTimeout(promptTimer);
    api.setMessageReaction("✅", messageID, () => {}, true);
    if (outputBuffer.trim() || !promptSent)
      sendOutputMessage(outputBuffer || `Process completed with exit code ${code}.`, true);
  });

  child.on("error", err => {
    isFinished = true;
    procObj.isFinished = true;
    if (promptTimer) clearTimeout(promptTimer);
    api.setMessageReaction("❌", messageID, () => {}, true);
    api.sendMessage(`Execution error:\n\`\`\`bash\n${err.message}\n\`\`\``, threadID, messageID);
  });
}

module.exports = {
  config: {
    name: "shell",
    aliases: ["terminal", "bash", "$", "sh", "sys", "control"],
    version: "16.0.0",
    author: "𝔐𝔯.𝔎𝔦𝔫𝔤 ☠️✌🏼",
    countDown: 0,
    role: 0,
    category: "owner",
    shortDescription: "All-in-one control: terminal, packages, database repair, accounts, language, restart",
    guide: {
      en: "{pn} help                 show the full manual\n" +
          "{pn} <shell command>      run any terminal command\n" +
          "{pn} account <sub>       manage the 5 accounts\n" +
          "{pn} typing <on|off|status>   control the typing indicator\n" +
          "{pn} deps | install | rebuild sqlite | lang | restart"
    }
  },

  onStart: async function ({ api, event, args, message }) {
    const { threadID, messageID, senderID } = event;
    let commandText = args.join(" ").trim();
    const first = (args[0] || "").toLowerCase();
    const p = prefixOf(event);

    if (!commandText || first === "help" || first === "manual") {
      const cfg = readConfig() || {};
      const manualText =
        `── SHELL / CONTROL MANUAL ──\n\n` +
        `Current directory:\n\`${currentCwd}\`\n\n` +
        `BUILT-IN SHORTCUTS\n` +
        `• ${p}shell deps              check missing npm packages\n` +
        `• ${p}shell install           repair / install all npm packages\n` +
        `• ${p}shell rebuild sqlite    rebuild the sqlite3 native driver\n` +
        `• ${p}shell rebuild canvas    rebuild the canvas native driver\n` +
        `• ${p}shell rebuild all       rebuild sqlite3 + canvas\n` +
        `• ${p}shell status           bot, node, memory and config status\n` +
        `• ${p}shell account <sub>    status | switch 1-5 | next | reset | auto\n` +
        `• ${p}shell typing <on|off|status>   control the typing indicator\n` +
        `• ${p}shell lang <code>      set language: en, bn or vi\n` +
        `• ${p}shell restart          restart the engine on the next account\n` +
        `• ${p}shell cd <path>        change directory permanently\n\n` +
        `RAW TERMINAL\n` +
        `• Any other text runs directly in the shell.\n` +
        `• Example: ${p}shell pwd , ${p}shell npm -v , ${p}shell python3 main.py\n` +
        `• If a command asks for input, reply to the bot message with 'y', text or 'kill'.\n\n` +
        `Current language: ${cfg.language || "en"} | Database: ${(cfg.database && cfg.database.type) || "sqlite"}`;
      return api.sendMessage(manualText, threadID, messageID);
    }

    // Persistent directory change
    if (/^cd(\s+.*)?$/.test(commandText)) {
      const targetDir = commandText.replace(/^cd\s*/, "").trim() || process.env.HOME || "/";
      const resolvedPath = path.resolve(currentCwd, targetDir.replace(/^~/, process.env.HOME || ""));
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
        currentCwd = resolvedPath;
        return api.sendMessage(`Directory changed to:\n\`${currentCwd}\``, threadID, messageID);
      }
      return api.sendMessage(`Directory not found:\n\`${resolvedPath}\``, threadID, messageID);
    }

    // Status: no shell needed
    if (["status", "info", "health"].includes(first) && !args[1]) {
      const cfg = readConfig() || {};
      const mb = Math.round(process.memoryUsage().rss / 1048576);
      const statusText =
        `ALIYA CONTROL STATUS\n` +
        `Node      : ${process.version} (${process.platform}/${process.arch})\n` +
        `Memory    : ${mb} MB\n` +
        `Uptime    : ${Math.floor(process.uptime())}s\n` +
        `Directory : ${currentCwd}\n` +
        `Engine    : ${global.GoatBot?.isWolfMode ? "Wolf safe mode" : "Aliya main"}\n` +
        `Account   : ${global.GoatBot?.activeAccountFile || "unknown"}\n` +
        `Bot UID   : ${global.GoatBot?.botID || "unknown"}\n` +
        `Language  : ${cfg.language || "en"}\n` +
        `Database  : ${(cfg.database && cfg.database.type) || "sqlite"}\n` +
        `JSON fallback: ${cfg.database && cfg.database.fallbackToJson !== false ? "enabled" : "disabled"}`;
      return api.sendMessage(statusText, threadID, messageID);
    }

    // Account management: delegate to the real account command
    if (first === "account" || first === "acc" || first === "pool") {
      const accCmd = (global.GoatBot && global.GoatBot.commands && global.GoatBot.commands.get("account")) || require("./account.js");
      if (!accCmd || typeof accCmd.onStart !== "function")
        return api.sendMessage("Account command is not available.", threadID, messageID);
      return accCmd.onStart({ api, event, args: args.slice(1), message });
    }

    if (first === "typing" || first === "typingindicator") {
      const typingCmd = (global.GoatBot && global.GoatBot.commands && global.GoatBot.commands.get("typing")) || require("./typing.js");
      if (!typingCmd || typeof typingCmd.onStart !== "function")
        return api.sendMessage("Typing command is not available.", threadID, messageID);
      return typingCmd.onStart({ api, event, args: args.slice(1), message });
    }

    // Language switch
    if (first === "lang" || first === "language") {
      const code = String(args[1] || "").toLowerCase();
      if (!["en", "bn", "vi"].includes(code))
        return api.sendMessage(`Usage: ${p}shell lang <en|bn|vi>`, threadID, messageID);
      const cfg = readConfig();
      if (!cfg) return api.sendMessage("Cannot read config.json. Check the file and try again.", threadID, messageID);
      cfg.language = code;
      try {
        writeConfig(cfg);
        await api.sendMessage(`Language set to ${code}. Run ${p}shell restart to apply it everywhere.`, threadID, messageID);
      }
      catch (e) {
        api.sendMessage(`Could not save config.json: ${e.message}`, threadID, messageID);
      }
      return;
    }

    // Restart
    if (["restart", "reboot", "relogin"].includes(first)) {
      await api.sendMessage("Restarting the engine now. It will be back in a few seconds.", threadID, messageID);
      return restartSoon();
    }

    // Safe command shortcuts
    const shorthands = {
      deps: "node scripts/check-dependencies.js",
      checkdeps: "node scripts/check-dependencies.js",
      dependencies: "node scripts/check-dependencies.js",
      install: "npm install --omit=dev --no-audit --no-fund",
      fix: "npm install --omit=dev --no-audit --no-fund",
      npmfix: "npm install --omit=dev --no-audit --no-fund"
    };

    if (shorthands[first]) {
      const cmd = shorthands[first];
      return runShell(api, event, cmd, cmd);
    }

    if (first === "rebuild") {
      const what = (args[1] || "sqlite").toLowerCase();
      let cmd;
      if (["sqlite", "sql", "db"].includes(what))
        cmd = "npm rebuild sqlite3 --build-from-source --no-audit --no-fund";
      else if (what === "canvas")
        cmd = "npm rebuild canvas --build-from-source --no-audit --no-fund";
      else if (what === "all")
        cmd = "npm rebuild sqlite3 --build-from-source --no-audit --no-fund && npm rebuild canvas --build-from-source --no-audit --no-fund";
      else
        return api.sendMessage(`Usage: ${p}shell rebuild <sqlite|canvas|all>`, threadID, messageID);
      return runShell(api, event, cmd, cmd);
    }

    // Anything else is a real shell command
    return runShell(api, event, commandText, null);
  },

  onReply: async function ({ api, event, Reply }) {
    const { threadID, messageID, senderID, body } = event;
    const procData = activeProcesses.get(Reply.messageID);

    if (!procData || procData.isFinished || !procData.child || procData.child.killed)
      return api.sendMessage("This terminal process has already ended.", threadID, messageID);

    if (senderID !== procData.senderID) return;

    const input = body.trim();
    if (input.toLowerCase() === "kill" || input.toLowerCase() === "exit" || input === "^C") {
      procData.child.kill("SIGKILL");
      procData.isFinished = true;
      activeProcesses.delete(Reply.messageID);
      return api.sendMessage("Process terminated.", threadID, messageID);
    }

    try {
      api.setMessageReaction("⌨️", messageID, () => {}, true);
      procData.child.stdin.write(input + "\n");
    }
    catch (err) {
      api.sendMessage(`Failed to send input: ${err.message}`, threadID, messageID);
    }
  }
};
