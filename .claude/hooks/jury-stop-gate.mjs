#!/usr/bin/env node
// jury-stop-gate.mjs
// Stop hook: the "monitor" of the jury workflow. Blocks the agent from
// finishing while code changes are unverified ("optimistic code" -> loop).
//
// Gate logic:
//   1. No uncommitted changes to MCP-Server/src/**/*.ts or MCP/**/*.cs -> allow stop.
//   2. Changed code must build (npm run build / dotnet build Release.R26),
//      otherwise block with the build output as evidence.
//   3. Build passing is not enough: the current diff must also hold a PASS
//      verdict from the `code-reviewer` subagent, recorded in
//      .claude/.jury-state.json. Missing/stale verdict -> block with
//      instructions to run the juror.
//   4. Safety valve: after MAX_BLOCKS consecutive blocks on the same diff the
//      gate gives up and allows the stop (never hard-locks a session).
//
// Written in Node (not bash+jq): jq is not installed on this machine and
// Node is already a hard dependency of MCP-Server.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_BLOCKS = 5;
const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_PATH = join(ROOT, ".claude", ".jury-state.json");

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

function tail(text, lines = 40, chars = 3000) {
  const t = (text || "").split(/\r?\n/).slice(-lines).join("\n");
  return t.length > chars ? t.slice(-chars) : t;
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function block(state, reason) {
  state.blocks = (state.blocks || 0) + 1;
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function allow() {
  process.exit(0);
}

// ---- 1. detect changed code files -----------------------------------------
const status = git(["status", "--porcelain"]);
if (status === null) allow(); // not a git repo / git error: fail open

const changed = [];
const untracked = [];
for (const line of status.split(/\r?\n/)) {
  if (!line.trim() || line.startsWith("!!")) continue;
  let file = line.slice(3);
  if (file.includes(" -> ")) file = file.split(" -> ").pop();
  file = file.replace(/^"|"$/g, "");
  if (/^MCP-Server\/src\/.+\.ts$/.test(file) || /^MCP\/.+\.cs$/.test(file)) {
    changed.push(file);
    if (line.startsWith("??")) untracked.push(file);
  }
}
if (changed.length === 0) allow();

// ---- 2. fingerprint the current diff ---------------------------------------
const hasher = createHash("sha1");
hasher.update(git(["diff", "HEAD", "--", "MCP-Server/src", "MCP"]) || "");
for (const f of untracked.sort()) {
  try {
    hasher.update(f);
    hasher.update(readFileSync(join(ROOT, f)));
  } catch {
    /* file vanished mid-check */
  }
}
const hash = hasher.digest("hex");

let state = readState();
if (state.hash !== hash) {
  // diff changed since last check: all prior verdicts are void
  state = { hash, build: "pending", review: "pending", blocks: 0 };
}

// fully verified -> allow
if (state.build === "pass" && state.review === "pass") allow();

// safety valve: never hard-lock the session
if ((state.blocks || 0) >= MAX_BLOCKS) {
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        "[jury gate] Gave up after " +
        MAX_BLOCKS +
        " blocks on the same diff. Stop allowed, but the code changes remain UNVERIFIED.",
    })
  );
  process.exit(0);
}

// ---- 3. build verification --------------------------------------------------
if (state.build !== "pass") {
  const needTs = changed.some((f) => f.startsWith("MCP-Server/"));
  const needCs = changed.some((f) => f.startsWith("MCP/"));

  if (needTs) {
    const r = spawnSync("npm", ["run", "build"], {
      cwd: join(ROOT, "MCP-Server"),
      encoding: "utf8",
      shell: true,
      timeout: 240000,
    });
    if (r.status !== 0) {
      state.build = "fail";
      block(
        state,
        "[JURY GATE] The TypeScript you changed does not build. Claiming completion now would be optimistic code. Evidence (npm run build in MCP-Server):\n\n" +
          tail((r.stdout || "") + "\n" + (r.stderr || "")) +
          "\n\nFix the build, then finish again — the gate will re-verify."
      );
    }
  }

  if (needCs) {
    const r = spawnSync(
      "dotnet",
      ["build", "-c", "Release.R26", "RevitMCP.csproj", "--nologo", "-v", "m"],
      { cwd: join(ROOT, "MCP"), encoding: "utf8", timeout: 480000 }
    );
    if (r.status !== 0) {
      state.build = "fail";
      block(
        state,
        "[JURY GATE] The C# you changed does not build. Claiming completion now would be optimistic code. Evidence (dotnet build -c Release.R26 MCP/RevitMCP.csproj):\n\n" +
          tail((r.stdout || "") + "\n" + (r.stderr || "")) +
          "\n\nFix the build, then finish again — the gate will re-verify."
      );
    }
  }

  state.build = "pass";
}

// ---- 4. independent review verdict ------------------------------------------
if (state.review !== "pass") {
  block(
    state,
    "[JURY GATE] Build passed, but the current diff has NOT been reviewed by the independent code-reviewer juror.\n\n" +
      "Changed files:\n- " +
      changed.join("\n- ") +
      "\n\nBefore you may finish:\n" +
      '1. Launch the code-reviewer subagent (Agent tool, subagent_type: "code-reviewer") with prompt: ' +
      '"Review the current uncommitted diff (git diff HEAD -- MCP-Server/src MCP, plus untracked .ts/.cs files). Return VERDICT: PASS or FAIL with findings."\n' +
      "2. If VERDICT is FAIL: fix every BLOCKER finding first. (Fixes change the diff, so the gate will re-verify automatically.)\n" +
      '3. Only if VERDICT is PASS: set "review": "pass" in .claude/.jury-state.json (change nothing else in that file), then finish again.\n\n' +
      "NEVER set review=pass without an actual PASS verdict from the code-reviewer subagent obtained in this same turn. Faking the verdict violates CLAUDE.md > Tool Call Data Honesty."
  );
}

writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
allow();
