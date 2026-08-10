#!/usr/bin/env node
/**
 * AI School MCP server
 *
 * Exposes the AI School curriculum to any MCP client - Claude Code, Claude
 * Desktop, or anything else that speaks the protocol - so an assistant can look
 * up and read lessons instead of guessing at AI topics from memory.
 *
 * Talks to the public static curriculum API at
 * https://lillytechsystems.com/ai-school/api/v1/, so there is nothing to host
 * and no key to configure.
 *
 * Install:
 *   npx -y @modelcontextprotocol/inspector node server.js     # to try it
 *
 * Claude Desktop / Claude Code config:
 *   {
 *     "mcpServers": {
 *       "ai-school": { "command": "node", "args": ["/path/to/server.js"] }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SITE = process.env.AI_SCHOOL_SITE || 'https://lillytechsystems.com';
const API = `${SITE}/ai-school/api/v1`;
const UA = 'ai-school-mcp/1.0 (+https://lillytechsystems.com/ai-school/)';

/* The catalogue is a few hundred KB and changes at deploy cadence, so fetch it
   once per process rather than per call. A long-lived client would otherwise
   re-download it on every search. */
const cache = new Map();

async function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const json = await res.json();
  cache.set(url, json);
  return json;
}

/** Strip a lesson page down to readable text. */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|tr|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<pre[^>]*>/gi, '\n```\n')
    .replace(/<\/pre>/gi, '\n```\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'").replace(/&mdash;/g, '-').replace(/&ndash;/g, '-')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function scoreEntry(title, terms) {
  const low = title.toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (low === t) s += 20;
    else if (low.startsWith(t)) s += 8;
    else if (low.includes(t)) s += 4;
  }
  return s;
}

const server = new Server(
  { name: 'ai-school', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    name: 'search_lessons',
    description:
      'Search the AI School curriculum (500+ tracks, thousands of free lessons on AI ' +
      'engineering, governance, security, and applied AI by profession). Returns matching ' +
      'lesson titles and URLs. Use this before answering an AI-topic question when a ' +
      'concrete, citable lesson would help, then read_lesson to get the text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for, e.g. "prompt injection defence"' },
        limit: { type: 'integer', description: 'Max results (default 10, max 50)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_tracks',
    description:
      'List AI School course tracks, optionally filtered by a substring of the title or slug. ' +
      'Each track is a structured course on one subject. Use this to find the right course ' +
      'before drilling into its lessons.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional substring filter' },
        limit: { type: 'integer', description: 'Max results (default 40)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_track',
    description:
      'Get one track with its full lesson list, so you can see the structure of a course ' +
      'and pick the right lesson to read.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Track slug, e.g. "rag"' } },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_lesson',
    description:
      'Fetch the full text of a lesson by its URL (as returned by search_lessons or ' +
      'get_track). Returns readable markdown-ish text with headings and code blocks.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Lesson URL on lillytechsystems.com' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    if (name === 'search_lessons') {
      const terms = String(args.query || '').toLowerCase().split(/\s+/).filter(w => w.length > 1);
      if (!terms.length) throw new Error('Give me something to search for.');
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);

      const { entries } = await getJSON(`${API}/search.json`);
      const hits = [];
      for (const [title, path] of entries) {
        const s = scoreEntry(title, terms);
        if (s > 0) hits.push({ title, url: SITE + path, score: s });
      }
      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, limit);

      if (!top.length) {
        return {
          content: [{
            type: 'text',
            text: `No lessons matched "${args.query}". Try broader terms, or call list_tracks to browse.`,
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: `${hits.length} lessons matched; showing ${top.length}:\n\n` +
            top.map(h => `- ${h.title}\n  ${h.url}`).join('\n'),
        }],
      };
    }

    if (name === 'list_tracks') {
      const { tracks } = await getJSON(`${API}/tracks.json`);
      const f = String(args.filter || '').toLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 40, 1), 200);
      const list = (f
        ? tracks.filter(t => t.slug.includes(f) || t.title.toLowerCase().includes(f))
        : tracks
      ).slice(0, limit);

      return {
        content: [{
          type: 'text',
          text: `${list.length} track(s):\n\n` + list.map(t =>
            `- ${t.title} (${t.slug})\n  ${t.lessonCount} lessons` +
            (t.hasQuizzes ? `, ${t.quizTopics} quiz topics` : '') + `\n  ${t.url}`
          ).join('\n'),
        }],
      };
    }

    if (name === 'get_track') {
      const slug = String(args.slug || '').replace(/[^a-z0-9-]/gi, '');
      if (!slug) throw new Error('Missing track slug.');
      const data = await getJSON(`${API}/tracks/${slug}.json`);
      const t = data.track;
      return {
        content: [{
          type: 'text',
          text: `# ${t.title}\n${t.description}\n${t.url}\n\n` +
            `${data.lessons.length} lessons:\n\n` +
            data.lessons.map((l, i) => `${i + 1}. ${l.title}\n   ${l.url}`).join('\n'),
        }],
      };
    }

    if (name === 'read_lesson') {
      const url = String(args.url || '');
      // Only ever fetch from this site: an MCP tool that will fetch any URL on
      // request is an SSRF primitive handed to whatever wrote the prompt.
      if (!url.startsWith(SITE + '/')) {
        throw new Error(`read_lesson only fetches pages on ${SITE}.`);
      }
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const text = htmlToText(await res.text());
      const capped = text.length > 40000 ? text.slice(0, 40000) + '\n\n[...truncated]' : text;
      return { content: [{ type: 'text', text: `Source: ${url}\n\n${capped}` }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `AI School lookup failed: ${err.message}` }],
    };
  }
});

/* -------------------------------------------------------------- resources */

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'aischool://catalogue',
      name: 'AI School catalogue',
      description: 'Counts, licence terms and endpoint list for the curriculum API.',
      mimeType: 'application/json',
    },
    {
      uri: 'aischool://tracks',
      name: 'All AI School tracks',
      description: 'Every course track with lesson counts.',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  const map = {
    'aischool://catalogue': `${API}/index.json`,
    'aischool://tracks': `${API}/tracks.json`,
  };
  if (!map[uri]) throw new Error(`Unknown resource: ${uri}`);
  const data = await getJSON(map[uri]);
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }],
  };
});

/* ------------------------------------------------------------------ start */

const transport = new StdioServerTransport();
await server.connect(transport);
// Never write to stdout: it is the protocol channel.
console.error('AI School MCP server ready on stdio.');
