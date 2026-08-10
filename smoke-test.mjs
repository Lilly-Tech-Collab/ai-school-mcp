#!/usr/bin/env node
/**
 * Pre-publish smoke test for the AI School MCP server.
 *
 * Publishing a broken MCP server is worse than not publishing one: the client
 * shows a red "failed to connect" and the user never tries again. So before
 * `npm publish`, prove over real stdio that the server starts, completes the
 * MCP handshake, advertises its tools, and can actually answer a call against
 * the live curriculum API.
 *
 * Exits non-zero on any failure, so CI can gate the publish on it.
 *
 *   node smoke-test.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "server.js");
const TIMEOUT_MS = 30_000;

const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  // MCP stdio frames are newline-delimited JSON.
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not a frame; ignore rather than fail the run
    }
    const resolver = pending.get(msg.id);
    if (resolver) {
      pending.delete(msg.id);
      resolver(msg);
    }
  }
});

child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${method}`)),
      TIMEOUT_MS,
    );
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? "  " + detail : ""}`);
}

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "1.0.0" },
  });
  check("initialize handshake", !!init?.serverInfo?.name, init?.serverInfo?.name);
  notify("notifications/initialized", {});

  const tools = await send("tools/list", {});
  const names = (tools?.tools || []).map((t) => t.name).sort();
  const expected = ["get_track", "list_tracks", "read_lesson", "search_lessons"];
  check("tools/list advertises all four tools", expected.every((e) => names.includes(e)),
        names.join(", "));

  // Every tool needs a description and a schema, or clients render it unusably.
  const described = (tools?.tools || []).every(
    (t) => t.description && t.inputSchema && t.inputSchema.type === "object");
  check("every tool has a description and an object input schema", described);

  const resources = await send("resources/list", {});
  check("resources/list responds", Array.isArray(resources?.resources),
        `${resources?.resources?.length ?? 0} resource(s)`);

  // The one that exercises the live API rather than just the plumbing.
  const called = await send("tools/call", {
    name: "search_lessons",
    arguments: { query: "prompt caching", limit: 3 },
  });
  const text = called?.content?.[0]?.text || "";
  check("search_lessons returns results from the live API",
        !called?.isError && text.length > 0,
        text.split("\n")[0]?.slice(0, 70));

  // read_lesson must return the LESSON, not the page furniture around it.
  //
  // The first version of htmlToText stripped <nav>/<header>/<footer>, none of
  // which is how this site's chrome is marked up: the header is empty until
  // main.js fills it, the lesson list is an <aside>, and the affiliate block is
  // a <section> inside <main>. Every call therefore shipped a few hundred
  // characters of whitespace, orphaned bullets and a hosting advert before the
  // content. Nothing failed - it just quietly wasted the caller's context on
  // every single call, which is exactly the kind of regression a "does it
  // return something" assertion cannot see. Hence these.
  const lesson = await send("tools/call", {
    name: "read_lesson",
    arguments: {
      url: "https://lillytechsystems.com/ai-frontier/mechanistic-interpretability/activation-patching.html",
    },
  });
  const body = (lesson?.content?.[0]?.text || "").replace(/^Source:.*\n+/, "");
  check("read_lesson returns the lesson body", !lesson?.isError && body.length > 1000,
        `${body.length} chars`);
  // The heading should be within the first line or two (a difficulty tag may
  // precede it), not after a wall of collapsed chrome.
  const toHeading = body.indexOf("\n# ");
  check("read_lesson opens at the content, not blank chrome",
        body.trimStart().startsWith("#") || (toHeading >= 0 && toHeading < 80),
        JSON.stringify(body.slice(0, 48)));
  check("read_lesson excludes the affiliate block", !/DigitalOcean/.test(body));
  check("read_lesson excludes the sidebar lesson list", !/Topic Progress/.test(body));

  // The host lock is the only thing standing between this tool and an SSRF
  // primitive, so it is asserted rather than assumed.
  const blocked = await send("tools/call", {
    name: "read_lesson",
    arguments: { url: "https://example.com/" },
  });
  check("read_lesson refuses hosts other than lillytechsystems.com",
        blocked?.isError === true,
        (blocked?.content?.[0]?.text || "").slice(0, 60));
} catch (err) {
  check("run completed without throwing", false, err.message);
} finally {
  child.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
