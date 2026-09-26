# imessage-bridge

A managed iMessage line for your AI agent, exposed as an MCP server.

Give your agent its own phone number. Messages that arrive from the person on the
other end land in an inbox your agent can read; messages your agent sends are
actually delivered — text, voice notes, stickers, links, images, and reactions.

No Mac is required. The line is hosted by [Spectrum / Photon](https://photon.codes),
not by a local `Messages.app` install.

```
your phone  ⇄  Spectrum Cloud (managed iMessage line)
                   │
          imessage-line   node line.mjs      — holds the line, receives, sends
                   │  127.0.0.1:18230  (local "door", Bearer SEND_TOKEN)
          imessage-mcp   python FastMCP :8515  — the MCP interface your agent calls
                   │  Bearer MCP_TOKEN
            your agent (Claude Code / Claude Desktop / any MCP client)
```

## Features

- **Read & write iMessage** — inbound text / image / voice / reaction / file all land
  in an inbox; outbound goes out for real.
- **Voice notes, both ways** — send voice in a voice of your choice (ElevenLabs TTS);
  incoming voice is transcribed to text (ElevenLabs Scribe by default, or any
  OpenAI-compatible Whisper endpoint).
- **Tone detection (optional)** — incoming voice notes are also described by a
  multimodal model ("sounds tired, speaking softly"), so the agent knows *how*
  something was said, not just *what*.
- **Reactions, links, images, stickers** — react to a message, send a link card,
  an image by URL, or a sticker by mood.
- **Safe by default** — the MCP endpoint requires a bearer token unless you
  explicitly opt out.

## How it works

Two processes, one shared `.env`:

1. **`line.mjs`** (Node) — the only thing that talks to Spectrum. It receives inbound
   messages, stores them in `inbox.json`, and sends outbound messages. It exposes a
   tiny HTTP "door" on `127.0.0.1:18230` guarded by
   `SEND_TOKEN`. Nothing else is allowed to talk to the line directly.
2. **`imessage_mcp.py`** (Python, FastMCP) — the MCP server your agent connects to.
   Every tool is a thin proxy over the door. It is the only thing that can reach the
   door from the outside, and it is itself guarded by `MCP_TOKEN`.

The "brain" is deliberately not here. Your agent lives wherever it lives (Claude Code,
Claude Desktop, your own harness) and uses this MCP server the same way it would use
any other tool.

## Prerequisites

- Node.js ≥ 18 (for `spectrum-ts`)
- Python ≥ 3.10 (for the MCP server)
- `ffmpeg` on PATH (voice ↔ audio conversion)
- A [Photon](https://app.photon.codes) project with a managed iMessage line

## Quick start

```bash
# 1. install node deps
npm install

# 2. install python deps
python -m venv .venv
.venv/bin/pip install -r requirements.txt   # Windows: .venv\Scripts\pip

# 3. configure
cp .env.example .env
# fill in PHOTON_PROJECT_ID, PHOTON_PROJECT_SECRET, OWNER_PHONE, SEND_TOKEN, MCP_TOKEN
```

Run both processes. With pm2:

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

Or by hand:

```bash
node line.mjs                    # terminal A
.venv/bin/python imessage_mcp.py # terminal B
```

### `.env` — the important fields

| Key | Meaning |
|---|---|
| `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` | Your Photon project credentials |
| `OWNER_PHONE` | **The other person's** number (the recipient), not the line number. The line number is discovered by Spectrum from the project credentials. |
| `SEND_TOKEN` | Shared secret between `line.mjs` and the MCP layer (the door) |
| `MCP_TOKEN` | Bearer token MCP clients must send |
| `PUBLIC_HOST` | The public hostname the MCP server is served under (used for the tunnel's Host allow-list) |

> **First-time gotcha**: the sender's identity must be registered under
> **Project → Users** in the Photon dashboard, or Photon rejects the message with
> "This number didn't recognize yours". Add the recipient's number there.

## Connect your agent

**Claude Code:**

```bash
claude mcp add --transport http imessage https://<your-host>/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

**Claude Desktop / any JSON-based client** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "imessage": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

The transport is **streamable-http**, endpoint `/mcp`.

## Tools

| Tool | What it does |
|---|---|
| `imessage_send` | Send text. Blank lines split into separate bubbles. |
| `imessage_send_voice` | Send a voice note in your configured voice. |
| `imessage_send_sticker` | Send a sticker by mood. |
| `imessage_send_link` | Send a link card with a preview. |
| `imessage_send_image` | Send an image by URL. |
| `imessage_send_react` | React to their latest message. |
| `imessage_recent` | Read recent inbound messages (optionally unread only). |
| `imessage_mark_read` | Mark all inbound messages read. |
| `imessage_status` | Line health, unread count, moods. |

## Action lines

Inside `imessage_send`, a line that matches an action keyword is
turned into a real iMessage action instead of being sent as text. The keywords are
Chinese (the code matches them literally); put one action per line:

| Action | Effect |
|---|---|
| `[[回应:❤️]]` | React to the last inbound message (❤️ 👍 👎 😂 ‼️ ❓ are safest) |
| `[[链接:https://…]]` | Send a link card with preview |
| `[[图片:https://…]]` | Send an image from the web |
| `[[表情:开心]]` | Send a random sticker from the `开心` mood folder |
| `[[语音:要说的话]]` | Send a voice note in your own voice |

## Voice

- **TTS (outbound)** — ElevenLabs. Set `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
  `ELEVENLABS_MODEL` (default `eleven_v3`), `VOICE_NAME`.
- **ASR (inbound)** — default ElevenLabs **Scribe** (`scribe_v1`). With no
  `ELEVENLABS_API_KEY` it falls back to an OpenAI-compatible Whisper endpoint
  (`ASR_PROVIDER=openai`, `ASR_BASE_URL`, `ASR_API_KEY`).
- **Tone (inbound, optional)** — the same audio is also sent to an Alibaba DashScope
  multimodal model (`qwen3.8-omni-flash`, `qwen-omni-turbo`, …) which describes the
  speaker's mood in one sentence. Set `DASHSCOPE_API_KEY`; `TONE=0` disables it. Tone
  failure silently degrades — the transcript is unaffected.

The inbound transcript and tone are stored on the inbox entry (`transcript`, `tone`)
and folded into the `text` the agent reads.

## Stickers

`[[表情:开心]]` picks a random image from `stickers/开心/`. One mood = one folder:

```
stickers/
  开心/  1.gif  2.jpg …
  想你/  a.png …
```

An optional `sticker-notes.json` describes individual stickers:
`{ "开心/1.jpg": ["name", "what it shows", "when to send"] }`.

## Security

- The MCP endpoint requires `MCP_TOKEN` (`Authorization: Bearer …`). Set
  `ALLOW_NO_AUTH=1` only if you understand that anyone who reaches the URL could
  send iMessage on your agent's behalf.
- `SEND_TOKEN` is the internal secret between the two processes; keep `.env`
  `chmod 600` and out of version control (it's in `.gitignore`).
- If you expose this behind Cloudflare Tunnel, FastMCP's DNS-rebinding protection
  must allow the public host — set `PUBLIC_HOST` to your domain so the tunnel's
  `Host` header is accepted.

## Deploying behind a tunnel (VPS + Cloudflare)

A common setup is a cheap VPS + a Cloudflare Tunnel (no public 80/443 on the box):

```bash
# on the VPS
git clone https://github.com/yuyuki-guyu/imessage-bridge.git
cd imessage-bridge
npm install
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
sudo apt-get install -y ffmpeg
cp .env.example .env   # fill it in
npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save
```

Then add an ingress in your tunnel config pointing `imessage.<your-domain>` at
`http://127.0.0.1:8515`, and set `PUBLIC_HOST=imessage.<your-domain>` in `.env`.

See `README.zh-CN.md` for a Chinese walkthrough that covers the same steps with the
China-specific pitfalls (GitHub egress, package mirrors, the tunnel Host header).

## License

AGPL-3.0 — see [LICENSE](LICENSE).
