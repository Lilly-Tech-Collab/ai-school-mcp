# AI School MCP server

Gives any MCP client - Claude Code, Claude Desktop, or anything else speaking the
protocol - the ability to search and read the free [AI School](https://lillytechsystems.com/ai-school/)
curriculum: 550+ tracks covering AI engineering, governance, security, and applied
AI by profession.

The point is not "an AI that knows about AI". It is that when an assistant answers a
question about, say, chunking strategy or the EU AI Act, it can point at a specific
lesson you can go and read, instead of producing a fluent paragraph you have no way
to check.

## Install

Node 20+ required (it uses the global `fetch`). Nothing else: no API key, no
account, no server to run.

**Claude Code**

```bash
claude mcp add ai-school -- npx -y ai-school-mcp
```

**Claude Desktop** - add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-school": {
      "command": "npx",
      "args": ["-y", "ai-school-mcp"]
    }
  }
}
```

### From a clone instead

For contributing, or to run against a local copy of the site:

```bash
git clone https://github.com/Lilly-Tech-Collab/ai-school-mcp.git
cd ai-school-mcp
npm install
npm test          # smoke-tests the handshake, tools and a live API call
```

```bash
claude mcp add ai-school -- node "$PWD/server.js"
```

Set `AI_SCHOOL_SITE` to point the server at a different host; it defaults to
`https://lillytechsystems.com`.

No API key. No account. The server reads the public static curriculum API at
`https://lillytechsystems.com/ai-school/api/v1/`, which is a set of JSON files on
the same host as the site.

## Tools

| Tool | What it does |
|---|---|
| `search_lessons` | Search lesson titles across the whole curriculum. Returns titles and URLs. |
| `list_tracks` | List course tracks, optionally filtered. |
| `get_track` | One track with its full lesson list, so you can see a course's structure. |
| `read_lesson` | Fetch a lesson's full text as readable markdown-ish output. |

## Resources

| URI | Contents |
|---|---|
| `aischool://catalogue` | Counts, licence terms, endpoint list. |
| `aischool://tracks` | Every track with lesson counts. |

## Notes

- **`read_lesson` only fetches `lillytechsystems.com`.** A "read this URL" tool that
  accepts arbitrary hosts is an SSRF primitive handed to whoever wrote the prompt, so
  the host check is deliberate and should stay.
- **Search is title-only** and deliberately simple. The full-text index is 4 MB and
  belongs in the browser, not in an MCP round trip; if title matching does not find
  it, `list_tracks` then `get_track` usually will.
- **The catalogue is cached per process.** A long-running client fetches it once. Restart
  the server to pick up newly published lessons.
- **Content licence.** Lessons are free to read, link to and quote with attribution.
  Republishing whole lessons is not permitted. The metadata (titles, descriptions,
  URLs) may be used freely with attribution. See `aischool://catalogue`.

## Local development

```bash
npm run inspect     # opens the MCP Inspector against this server
```

The server writes only to stderr; stdout is the protocol channel.
