# imessage-bridge

给你的 AI 一条自己的 iMessage 线路，包成一个 MCP 服务器。

你的 AI 可以主动发文字、发语音、发表情包、发链接、发图片、点回应，也可以读对方
最近说了什么。

不需要 Mac。线路由 [Spectrum / Photon](https://photon.codes) 托管，不是读本地
`Messages.app` 的数据库。

```
你的手机  ⇄  Spectrum Cloud（托管 iMessage 线路）
                   │
          imessage-line   node line.mjs       — 握住线路：收消息、发消息
                   │  127.0.0.1:18230  （本机门，Bearer SEND_TOKEN）
          imessage-mcp   python FastMCP :8515 — 你的 AI 调的 MCP 接口
                   │  Bearer MCP_TOKEN
            你的 AI（Claude Code / Claude Desktop / 任何 MCP 客户端）
```

## 能干什么

- **收发 iMessage** — 对方发来的文字/图片/语音/回应/文件都会进 inbox；你发出去的
  真的会送达。
- **语音双向** — 用自己的声音发语音（ElevenLabs TTS）；对方发来的语音自动转成文字
  （默认 ElevenLabs Scribe，也能换任何 OpenAI 兼容的 Whisper 端点）。
- **听语气（可选）** — 对方发来的语音还会被一个全模态模型用一句话描述情绪
  （"声音有点低，像没睡好"），让 AI 不只是知道"说了什么"，还知道"怎么说的"。
- **回应 / 链接 / 图片 / 表情包** — 点回应、发链接卡片、按 URL 发图、按心情发表情。
- **默认安全** — MCP 入口必须带 Bearer token，除非你显式关掉。

## 架构

两个进程，共用同一个 `.env`：

1. **`line.mjs`**（Node）— 唯一跟 Spectrum 说话的东西。收消息存进 `inbox.json`、
   发消息。它在 `127.0.0.1:18230` 开了一个小 HTTP "门"，用 `SEND_TOKEN`
   守着。除了它，谁都不能直接碰线路。
2. **`imessage_mcp.py`**（Python，FastMCP）— 你的 AI 连的 MCP 服务器。每个工具都是
   对"门"的一层薄代理。它是唯一能从外面够到"门"的东西，自己又用 `MCP_TOKEN` 守着。

**大脑刻意不在这里**。你的 AI 住在它自己住的地方（Claude Code、Claude Desktop、
你自己的 harness），像调任何工具一样调这个 MCP。

## 前置条件

- Node.js ≥ 18（`spectrum-ts` 需要）
- Python ≥ 3.10（MCP 服务器）
- `ffmpeg` 在 PATH 里（语音 ↔ 音频转换）
- 一个 [Photon](https://app.photon.codes) 项目 + 托管 iMessage 线路

## 快速开始

```bash
# 1. 装 node 依赖
npm install

# 2. 装 python 依赖
python -m venv .venv
.venv/bin/pip install -r requirements.txt   # Windows: .venv\Scripts\pip

# 3. 配置
cp .env.example .env
# 填 PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET / OWNER_PHONE / SEND_TOKEN / MCP_TOKEN
```

用 pm2 跑两个进程：

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

或者手动两个终端：

```bash
node line.mjs                    # 终端 A
.venv/bin/python imessage_mcp.py # 终端 B
```

### `.env` 关键字段

| 字段 | 含义 |
|---|---|
| `PHOTON_PROJECT_ID` / `PHOTON_PROJECT_SECRET` | 你的 Photon 项目凭据 |
| `OWNER_PHONE` | **对方的号码**（收消息那个人），不是线路号。线路号由 Spectrum 用 projectId+secret 自己发现 |
| `SEND_TOKEN` | `line.mjs` 和 MCP 层之间的暗号（守"门"） |
| `MCP_TOKEN` | MCP 客户端要带的 Bearer token |
| `PUBLIC_HOST` | MCP 服务器对外的主机名（给隧道的 Host 放行用） |

> **第一次必踩的坑**：发信方的身份必须登记在 Photon 面板的 **Project → Users** 里，
> 否则 Photon 回一条「This number didn't recognize yours」然后把消息丢掉。把对方的
> 号码加进去。

## 连接你的 AI

**Claude Code：**

```bash
claude mcp add --transport http imessage https://<你的域名>/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

**Claude Desktop / 任何 JSON 客户端**（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "imessage": {
      "type": "http",
      "url": "https://<你的域名>/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

传输是 **streamable-http**，端点在 `/mcp`。

## 工具

| 工具 | 干什么 |
|---|---|
| `imessage_send` | 发文字。空行分段 = 拆成几条气泡发。 |
| `imessage_send_voice` | 用你自己的声音发一条语音。 |
| `imessage_send_sticker` | 按心情发表情包。 |
| `imessage_send_link` | 发带封面的链接卡片。 |
| `imessage_send_image` | 按 URL 发一张图。 |
| `imessage_send_react` | 给对方最新那条点回应。 |
| `imessage_recent` | 读对方最近的消息（可只看未读）。 |
| `imessage_mark_read` | 把消息都标成已读。 |
| `imessage_status` | 线路通没通、未读数、表情包。 |

## 动作行

在 `imessage_send` 里，单独占一行、匹配动作关键字的行会变成真的
iMessage 动作，而不是当文字发出去。关键字是中文的（代码按字面匹配），一行一个：

| 动作 | 效果 |
|---|---|
| `[[回应:❤️]]` | 给对方最后一条点回应（❤️ 👍 👎 😂 ‼️ ❓ 最稳） |
| `[[链接:https://…]]` | 发带封面的链接卡片 |
| `[[图片:https://…]]` | 发一张网上的图 |
| `[[表情:开心]]` | 从 `开心` 文件夹随机发一张表情 |
| `[[语音:要说的话]]` | 用自己的声音发一条语音 |

## 语音

- **TTS（发语音）** — ElevenLabs。配 `ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID`、
  `ELEVENLABS_MODEL`（默认 `eleven_v3`）、`VOICE_NAME`。
- **ASR（听语音）** — 默认 ElevenLabs **Scribe**（`scribe_v1`）。没配 `ELEVENLABS_API_KEY`
  就回落到 OpenAI 兼容的 Whisper 端点（`ASR_PROVIDER=openai`、`ASR_BASE_URL`、`ASR_API_KEY`）。
- **语气（听语音，可选）** — 同一段音频还会发给阿里百炼的全模态模型
  （`qwen3.8-omni-flash`、`qwen-omni-turbo` 等），让它用一句话描述说话人的情绪。配
  `DASHSCOPE_API_KEY`；`TONE=0` 整个关掉。语气失败静默降级，不影响转写。

转写和语气都存在 inbox 条目的 `transcript` / `tone` 字段里，也拼进了 AI 读到的 `text`。

## 表情包

`[[表情:开心]]` 从 `stickers/开心/` 随机挑一张。一种心情 = 一个文件夹：

```
stickers/
  开心/  1.gif  2.jpg …
  想你/  a.png …
```

可选 `sticker-notes.json` 描述单张：`{ "开心/1.jpg": ["名字", "画的是什么", "什么时候发"] }`。

## 安全

- MCP 入口要 `MCP_TOKEN`（`Authorization: Bearer …`）。只有当你清楚"谁拿到这个 URL 就
  能以你的 AI 的身份发 iMessage"时才设 `ALLOW_NO_AUTH=1`。
- `SEND_TOKEN` 是两个进程之间的内部暗号；`.env` 要 `chmod 600`，别进版本控制（已在
  `.gitignore`）。
- 走 Cloudflare Tunnel 时，FastMCP 的 DNS-rebinding 防护必须放行公网 Host——把
  `PUBLIC_HOST` 设成你的域名，隧道转发过来的 `Host` 头才会被接受。

## 部署到 VPS + Cloudflare Tunnel

国内常见做法：一台便宜 VPS + Cloudflare Tunnel（机器上不开公网 80/443）：

```bash
# 在 VPS 上
git clone https://github.com/yuyuki-guyu/imessage-bridge.git
cd imessage-bridge
npm install
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
sudo apt-get install -y ffmpeg
cp .env.example .env   # 填好
npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save
```

然后在隧道配置里加一条 ingress，把 `imessage.<你的域名>` 指向
`http://127.0.0.1:8515`，并在 `.env` 里设 `PUBLIC_HOST=imessage.<你的域名>`。

### 墙内部署的几个坑

- **GitHub 直连会被 reset**（`github.com` 返回 `Connection reset`）。clone 要么走代理，
  要么用镜像。GitHub 推代码见下。
- **`bun` 装不上**：`bun.sh` 能通，但它的安装脚本要从 github.com 下二进制，墙内会挂。
  用 npm/npx 就行。
- **apt/pip 镜像源**：某些云厂商的镜像（如 `mirrors.tencentyun.com`）在个别机器上解析
  不了，装什么都失败。改成阿里云源（`mirrors.aliyun.com`）一般能救。
- **GitHub 推代码（Windows 本机）**：直连被墙；GCM 不支持 socks5；`gh auth git-credential`
  当 helper 会死锁。可行的办法是用 `GIT_ASKPASS` + 关掉 credential helper + 走 socks5：

  ```bash
  GIT_ASKPASS=/tmp/askpass.sh GIT_TERMINAL_PROMPT=0 \
  git -c credential.helper= -c http.proxy=socks5://127.0.0.1:1080 \
      -c https.proxy=socks5://127.0.0.1:1080 push -u origin main
  ```

  其中 `/tmp/askpass.sh` 的 username 输出你的 GitHub 用户名、password 输出
  `gh auth token` 的结果，用完删掉。

## License

AGPL-3.0 — 见 [LICENSE](LICENSE)。
