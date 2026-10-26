"use strict";

const { execFile } = require("child_process");
const { createDecipheriv, pbkdf2Sync } = require("crypto");
const { homedir, platform } = require("os");
const { join } = require("path");

const SAFE_PREFIX = "cursor-safe-storage:v1:";
const SAFE_VERSION = "v10";
const KEYCHAIN_SERVICE = "Cursor Safe Storage";
const KEYCHAIN_ACCOUNT = "Cursor Key";

let encryptionKeyPromise = null;

function stateDbPath() {
  if (platform() === "darwin") {
    return join(homedir(), "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  }
  if (platform() === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Cursor/User/globalStorage/state.vscdb");
  }
  return join(homedir(), ".config/Cursor/User/globalStorage/state.vscdb");
}

function sqliteUri(dbPath) {
  const encoded = dbPath.split("/").map((part, index) => (index === 0 ? part : encodeURIComponent(part))).join("/");
  return `file:${encoded}?mode=ro`;
}

function readStoredAuth() {
  const uri = sqliteUri(stateDbPath());
  const sql = "SELECT key, value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/cachedEmail')";
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/sqlite3", ["-json", uri, sql], { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      let rows;
      try {
        rows = JSON.parse(stdout || "[]");
      } catch (parseError) {
        reject(parseError);
        return;
      }
      const values = {};
      for (const row of rows) {
        if (row && typeof row.key === "string") {
          values[row.key] = row.value;
        }
      }
      const token = values["cursorAuth/accessToken"];
      if (typeof token !== "string" || token.length < 20) {
        reject(new Error("no-session"));
        return;
      }
      const email = typeof values["cursorAuth/cachedEmail"] === "string" ? values["cursorAuth/cachedEmail"] : null;
      resolve({ token, email });
    });
  });
}

function macEncryptionKey() {
  if (encryptionKeyPromise) {
    return encryptionKeyPromise;
  }
  encryptionKeyPromise = new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { timeout: 15000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        const password = error ? "" : String(stdout).replace(/\n$/, "");
        if (!password) {
          reject(new Error("keychain"));
          return;
        }
        resolve(pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"));
      }
    );
  }).catch((error) => {
    encryptionKeyPromise = null;
    throw error;
  });
  return encryptionKeyPromise;
}

async function unwrapStoredToken(stored) {
  if (!stored.startsWith(SAFE_PREFIX)) {
    return stored;
  }
  if (platform() !== "darwin") {
    throw new Error("encrypted-session");
  }
  const payload = Buffer.from(stored.slice(SAFE_PREFIX.length), "base64");
  if (payload.length < 4 || payload.subarray(0, 3).toString("utf8") !== SAFE_VERSION) {
    throw new Error("bad-session");
  }
  const key = await macEncryptionKey();
  const iv = Buffer.alloc(16, 0x20);
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([decipher.update(payload.subarray(3)), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new Error("bad-session");
  }
}

function readAuth() {
  return readStoredAuth().then(async ({ token, email }) => {
    const plain = await unwrapStoredToken(token);
    if (typeof plain !== "string" || plain.length < 20) {
      throw new Error("no-session");
    }
    return { token: plain, email };
  });
}

module.exports = { readAuth };
