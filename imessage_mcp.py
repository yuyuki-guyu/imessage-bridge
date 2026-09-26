#!/usr/bin/env python3
"""
imessage-bridge MCP server.

An MCP server that gives an AI agent its own iMessage line. The agent can
send text, voice notes, stickers, links and images, read what the other
person recently said, and react to a message.

This layer is a thin shell: the actual line lives in line.mjs (pm2:
imessage-line). A local "door" on 127.0.0.1:18230 is the only entry point;
the two sides authenticate each other with SEND_TOKEN from the shared .env.

License: AGPL-3.0
"""

import os
import json
import urllib.request
import urllib.error
from pathlib import Path
from typing import Annotated, Optional

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field

# ── config ─────────────────────────────────────────────────────

def _load_env(path: Path) -> None:
    """Read the same .env that line.mjs reads. Existing env vars win (setdefault)."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_env(Path(__file__).parent / ".env")

_port = int(os.environ.get("PORT", "8515"))
_host = os.environ.get("HOST", "127.0.0.1")
_public_host = os.environ.get("PUBLIC_HOST", "imessage.example.com")
_door = os.environ.get("DOOR_URL", "http://127.0.0.1:18230")
_token = os.environ.get("SEND_TOKEN", "")
_mcp_token = os.environ.get("MCP_TOKEN", "")

if not _token:
    raise RuntimeError("missing SEND_TOKEN: it must match line.mjs (same .env)")

# Once this MCP is exposed publicly, anyone with the URL could send iMessage
# messages as the agent. So a bearer token is required by default; set
# ALLOW_NO_AUTH=1 to explicitly accept that risk.
if not _mcp_token and os.environ.get("ALLOW_NO_AUTH") != "1":
    raise RuntimeError(
        "missing MCP_TOKEN. Anyone who reaches this URL could send iMessage "
        "messages on the agent's behalf, so auth is not optional.\n"
        "Either set one (recommended): export MCP_TOKEN=$(openssl rand -hex 24)\n"
        "Or explicitly accept the risk: export ALLOW_NO_AUTH=1"
    )

# FastMCP enables DNS-rebinding protection by default: it rejects any Host
# header that isn't the local machine. Behind a Cloudflare Tunnel the Host is
# the public domain, so allow it explicitly.
_ALLOWED_HOSTS = [
    "127.0.0.1:*",
    "localhost:*",
    "[::1]:*",
    _public_host,
    f"{_public_host}:*",
]

mcp = FastMCP(
    "imessage_bridge",
    host=_host,
    port=_port,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=_ALLOWED_HOSTS,
        allowed_origins=[f"https://{_public_host}"],
    ),
)


# ── talk to the line (the local door) ───────────────────────────

def _door_call(path: str, method: str = "GET", payload: Optional[dict] = None, timeout: int = 120) -> dict:
    """Knock on the local door. Any failure becomes {"error": ...} rather than raising."""
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(f"{_door}{path}", data=data, method=method)
    request.add_header("Authorization", f"Bearer {_token}")
    if data:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        try:
            return {"error": json.loads(body).get("error", body)}
        except Exception:
            return {"error": f"line returned HTTP {error.code}: {body[:300]}"}
    except Exception as error:
        return {"error": f"couldn't reach the line (is imessage-line running?): {error}"}


def _send(text: str) -> str:
    result = _door_call("/send", "POST", {"text": text})
    if result.get("error"):
        return f"not sent: {result['error']}"
    if result.get("failed"):
        return json.dumps({"status": "sent, but some bubbles failed", "sent": result.get("sent"), "failed": result["failed"]}, ensure_ascii=False)
    return json.dumps({"status": "sent", "bubbles": result.get("sent", 1)}, ensure_ascii=False)


# ── tools ───────────────────────────────────────────────────────

@mcp.tool(name="imessage_send")
async def imessage_send(
    text: Annotated[str, Field(description="What to say. Blank line = a new bubble; keep it short")],
) -> str:
    """Send text to the other person's iMessage.

    Write it like a text message: no markdown, no headings or bullet lists,
    one message not too long. Separate messages with a blank line to send
    them as separate bubbles.

    You may also put an action on its own line — that line becomes a real
    iMessage action instead of being sent as text (actions are Chinese-keyword):
      [[回应:❤️]]  react to their last message (❤️ 👍 👎 😂 ‼️ ❓ are safest)
      [[链接:https://...]]  send a link card with a preview (for songs; use a real URL, don't invent one)
      [[图片:https://...]]  send an image from the web (a real, loadable image URL)
      [[表情:开心]]  send a random sticker from the folder for that mood
      [[语音:要说的话]]  send a voice note in your own voice
    """
    return _send(text)


@mcp.tool(name="imessage_send_voice")
async def imessage_send_voice(
    text: Annotated[str, Field(description="What to say out loud; keep it short")],
) -> str:
    """Send a voice note in your own voice. For good-night, being cute, or
    when text doesn't carry the feeling."""
    return _send(f"[[语音:{text}]]")


@mcp.tool(name="imessage_send_sticker")
async def imessage_send_sticker(
    mood: Annotated[str, Field(description="A mood or sticker name, e.g. 开心 (happy) or 想你 (miss you)")],
) -> str:
    """Send a sticker. To see which moods are available, call imessage_status first."""
    return _send(f"[[表情:{mood}]]")


@mcp.tool(name="imessage_send_link")
async def imessage_send_link(
    url: Annotated[str, Field(description="A real, loadable URL")],
) -> str:
    """Send a link card with a preview. Use for songs — but the URL must be real."""
    return _send(f"[[链接:{url}]]")


@mcp.tool(name="imessage_send_image")
async def imessage_send_image(
    url: Annotated[str, Field(description="A real, loadable image URL (jpg/png/gif/webp)")],
) -> str:
    """Send an image from the web."""
    return _send(f"[[图片:{url}]]")


@mcp.tool(name="imessage_send_react")
async def imessage_send_react(
    emoji: Annotated[str, Field(description="Pick one of ❤️ 👍 👎 😂 ‼️ ❓ (safest)")],
) -> str:
    """React to their latest message. For "seen, no words needed" moments."""
    return _send(f"[[回应:{emoji}]]")


@mcp.tool(name="imessage_recent")
async def imessage_recent(
    limit: Annotated[int, Field(description="How many recent messages", ge=1, le=100)] = 20,
    unread_only: Annotated[bool, Field(description="Only show unread ones")] = False,
) -> str:
    """Read the other person's recent messages.

    kind is one of text/image/voice/reaction; voice notes carry a transcript
    (and, when tone detection is on, a `tone`). Images only keep a file path —
    you can't see the image itself.
    Prefer unread_only=True to check for new messages, then mark_read after replying.
    """
    return json.dumps(_door_call(f"/recent?limit={limit}&unread_only={1 if unread_only else 0}"), ensure_ascii=False, indent=2)


@mcp.tool(name="imessage_mark_read")
async def imessage_mark_read() -> str:
    """Mark all their messages read. Call after replying, not before."""
    return json.dumps(_door_call("/read", "POST", {}), ensure_ascii=False)


@mcp.tool(name="imessage_status")
async def imessage_status() -> str:
    """Line health: connected or not, unread count, and available sticker moods."""
    return json.dumps(_door_call("/health"), ensure_ascii=False, indent=2)


# ── entry point ─────────────────────────────────────────────────

class _AuthGate:
    """Pure-ASGI auth shell: reject unless the Authorization header matches.

    Not Starlette's BaseHTTPMiddleware — that buffers streaming responses,
    and streamable-http needs the stream. This only passes through, no body touch."""

    def __init__(self, app, token: str):
        self.app = app
        self.expected = f"Bearer {token}".encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        if headers.get(b"authorization") != self.expected:
            await send({
                "type": "http.response.start",
                "status": 401,
                "headers": [(b"content-type", b"application/json; charset=utf-8")],
            })
            await send({"type": "http.response.body", "body": b'{"error":"unauthorized"}'})
            return
        await self.app(scope, receive, send)


if __name__ == "__main__":
    import sys
    import uvicorn

    app = mcp.streamable_http_app()
    if _mcp_token:
        app = _AuthGate(app, _mcp_token)
    else:
        print("[warn] ALLOW_NO_AUTH=1: this port is open to anyone, and it can send iMessage on the agent's behalf.", file=sys.stderr)

    # streamable-http by default (endpoint at /mcp)
    print(f"[imessage-mcp] http://{_host}:{_port}/mcp  → door {_door}", file=sys.stderr)
    uvicorn.run(app, host=_host, port=_port, log_level="info")
