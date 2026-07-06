#!/usr/bin/env node
// jury-stop-gate.mjs  (generalized, config-driven)
// Stop hook: blocks the agent from finishing while uncommitted code changes are
// unverified ("optimistic code" -> loop). All project-specific behavior comes from
// .claude/jury-gate.config.json, so the same script works in any repo.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CONFIG_PATH = join(ROOT, ".claude", "jury-gate.config.json");
const STATE_PATH = join(ROOT, ".claude", ".jury-state.json");

function allow() {
  process.exit(0);
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const config = readJson(CONFIG_PATH);
if (!config) allow(); // not installed here -> fail open

const codeGlobs = Array.isArray(config.codeGlobs) ? config.codeGlobs : [];
const verify = Array.isArray(config.verify) ? config.verify : [];
const requireReview = config.requireReview !== false;
const maxBlocks = Number.isInteger(config.maxBlocks) ? config.maxBlocks : 5;

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}
function tail(text, lines = 40, chars = 3000) {
  const t = (text || "").split(/\r?\n/).slice(-lines).join("\n");
  return t.length > chars ? t.slice(-chars) : t;
}
// glob -> RegExp: supports **, *, ? over '/'-separated paths (git uses '/').
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}
const matchers = codeGlobs.map(globToRegExp);
const matches = (file) => matchers.length === 0 || matchers.some((m) => m.test(file));

function block(state, reason) {
  state.blocks = (state.blocks || 0) + 1;
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

// 1. detect changed code files
const status = git(["status", "--porcelain"]);
if (status === null) allow(); // not a git repo / git error: fail open

const changed = [];
const untracked = [];
for (const line of status.split(/\r?\n/)) {
  if (!line.trim() || line.startsWith("!!")) continue;
  let file = line.slice(3);
  if (file.includes(" -> ")) file = file.split(" -> ").pop();
  file = file.replace(/^"|"$/g, "");
  if (matches(file)) {
    changed.push(file);
    if (line.startsWith("??")) untracked.push(file);
  }
}
if (changed.length === 0) allow();

// 2. fingerprint the current diff
const hasher = createHash("sha1");
hasher.update(git(["diff", "HEAD", "--", ...changed.filter((f) => !untracked.includes(f))]) || "");
for (const f of untracked.sort()) {
  try {
    hasher.update(f);
    hasher.update(readFileSync(join(ROOT, f)));
  } catch {
    /* file vanished mid-check */
  }
}
const hash = hasher.digest("hex");

let state = readJson(STATE_PATH) || {};
if (state.hash !== hash) {
  state = { hash, verify: "pending", review: "pending", blocks: 0 };
}
if (state.verify === "pass" && (!requireReview || state.review === "pass")) allow();

// safety valve
if ((state.blocks || 0) >= maxBlocks) {
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        "[jury gate] Gave up after " +
        maxBlocks +
        " blocks on the same diff. Stop allowed, but the code changes remain UNVERIFIED.",
    })
  );
  process.exit(0);
}

// 3. verify commands
if (state.verify !== "pass") {
  for (const step of verify) {
    const cwd = join(ROOT, step.cwd || ".");
    const r = spawnSync(step.command, {
      cwd,
      encoding: "utf8",
      shell: true,
      timeout: (step.timeoutSec || 300) * 1000,
    });
    if (r.status !== 0) {
      state.verify = "fail";
      block(
        state,
        "[JURY GATE] Verification step '" +
          (step.name || step.command) +
          "' failed. Claiming completion now would be optimistic code.\n\nCommand: " +
          step.command +
          "  (cwd: " +
          (step.cwd || ".") +
          ")\n\nEvidence:\n" +
          tail((r.stdout || "") + "\n" + (r.stderr || "")) +
          "\n\nFix the problem, then finish again — the gate will re-verify."
      );
    }
  }
  state.verify = "pass";
}

// 4. independent review verdict
if (requireReview && state.review !== "pass") {
  block(
    state,
    "[JURY GATE] Verification passed, but the current diff has NOT been reviewed by the independent code-reviewer juror.\n\nChanged files:\n- " +
      changed.join("\n- ") +
      '\n\nBefore you may finish:\n1. Launch the code-reviewer subagent (Agent tool, subagent_type: "code-reviewer") with prompt: ' +
      '"Review the current uncommitted diff (git diff HEAD, plus untracked code files). Return VERDICT: PASS or FAIL with findings."\n' +
      "2. If VERDICT is FAIL: fix every BLOCKER finding first. (Fixes change the diff, so the gate re-verifies automatically.)\n" +
      '3. Only if VERDICT is PASS: set "review": "pass" in .claude/.jury-state.json (change nothing else), then finish again.\n\n' +
      "NEVER set review=pass without an actual PASS verdict from the code-reviewer subagent obtained in this same turn."
  );
}

writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
allow();
