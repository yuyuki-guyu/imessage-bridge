// imessage-line: 一条给你的 AI 用的 iMessage 线路（Photon/Spectrum 托管）。
// 这里只有「线路」本身——把手机来的消息记进 inbox.json，把要发的话真的发出去。
// 大脑不在这儿：你的 AI 通过 imessage_mcp.py 那层 MCP 来读和写，两边靠本机门（127.0.0.1:18230）说话。
// 门是唯一入口，终端里的人也能直接 curl 它。

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Spectrum, attachment, richlink, voice } from "spectrum-ts";
import { imessage } from "@spectrum-ts/imessage";

const here = (name) => new URL(`./${name}`, import.meta.url);
const env = Object.fromEntries(
  readFileSync(here(".env"), "utf8").split("\n").filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
);
for (const key of ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET", "OWNER_PHONE", "SEND_TOKEN"]) {
  if (!env[key]) throw new Error(`.env 里缺 ${key}`);
}

const OWNER = env.OWNER_NAME || "TA";
const SEND_TOKEN = env.SEND_TOKEN;
const DOOR_PORT = Number(env.DOOR_PORT) || 18230;
const MEDIA = new URL("./media/", import.meta.url).pathname;
mkdirSync(MEDIA, { recursive: true });
const run = promisify(execFile);
const STATE = here("state.json");
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const saveState = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

const digits = (value) => String(value ?? "").replace(/\D/g, "");
const isHer = (senderId) => {
  const mine = digits(env.OWNER_PHONE);
  const theirs = digits(senderId);
  return mine.length >= 7 && theirs.length >= 7 && (theirs.endsWith(mine.slice(-10)) || mine.endsWith(theirs.slice(-10)));
};

// ---------- inbox: 对方说过的话都留在这儿，等 AI 来读 ----------

const INBOX = here("inbox.json");
const inbox = existsSync(INBOX) ? JSON.parse(readFileSync(INBOX, "utf8")) : [];
const MAX_INBOX = Number(env.MAX_INBOX) || 500;
const unread = () => inbox.filter((entry) => !entry.read).length;

function remember(entry) {
  inbox.push({ at: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 19), read: false, ...entry });
  while (inbox.length > MAX_INBOX) inbox.shift();
  writeFileSync(INBOX, JSON.stringify(inbox, null, 2));
  console.log("[in]", entry.kind, entry.text?.slice(0, 60) ?? "");
}

// 可选表情包：stickers/<心情>/ 一个文件夹一种心情。
// 可选 sticker-notes.json 描述单张：{ "开心/1.jpg": ["名字", "画的是什么", "什么时候发"] }。
const STICKERS = new URL("./stickers/", import.meta.url).pathname;
const NOTES = existsSync(here("sticker-notes.json")) ? JSON.parse(readFileSync(here("sticker-notes.json"), "utf8")) : {};
const moods = () => (existsSync(STICKERS) ? readdirSync(STICKERS).filter((name) => !name.startsWith(".") && statSync(STICKERS + name).isDirectory()) : []);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/[-: ]/g, "").slice(0, 14);

// ---------- 对方发来的：图片、语音、文字 ----------

// 图片原样存进 media/（这里没人看图，只留个文件给 AI 知道「对方发了张图」）。
function keep(buffer, ext) {
  const file = `${MEDIA}${stamp()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
  writeFileSync(file, buffer);
  return file;
}

// 整条都是 [音效标签] 或 (括号) 或空白——说明一个字都没转出来
const ONLY_SOUND_TAGS = /^(\[[^\]]*\]|\([^)]*\)|\s)+$/;

// 转成 16k 单声道 wav。转写和听语气都用这一份，所以只转一次。
async function toWav(buffer) {
  const src = join(tmpdir(), `voice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  writeFileSync(src, buffer);
  const wav = `${src}.wav`;
  await run("ffmpeg", ["-nostdin", "-y", "-i", src, "-ar", "16000", "-ac", "1", wav]);
  return wav;
}

// 语音转文字，两条路：
//   elevenlabs（默认）—— 和 TTS 同一个 key，国内不用梯子，这里就叫 Scribe
//   openai    —— 任何 OpenAI 兼容的 Whisper 端点（Groq / 本机 whisper）
async function hearVoice(wav) {
  const provider = env.ASR_PROVIDER || (env.ELEVENLABS_API_KEY ? "elevenlabs" : "openai");
  const key = provider === "elevenlabs" ? env.ELEVENLABS_API_KEY : env.ASR_API_KEY;
  if (!key) throw new Error(provider === "elevenlabs" ? "没配 ELEVENLABS_API_KEY" : "没配 ASR_API_KEY");

  // 每次重试都重新拼一份 body——同一个 FormData 不一定能连发两次
  const build = () => {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(wav)]), "voice.wav");
    if (provider === "elevenlabs") {
      form.append("model_id", env.ASR_MODEL || "scribe_v1");
      form.append("language_code", env.ASR_LANG || "zh");
    } else {
      form.append("model", env.ASR_MODEL || "whisper-large-v3");
      form.append("language", env.ASR_LANG || "zh");
    }
    return form;
  };
  const url = provider === "elevenlabs"
    ? "https://api.elevenlabs.io/v1/speech-to-text"
    : `${env.ASR_BASE_URL || "https://api.groq.com/openai/v1"}/audio/transcriptions`;
  const headers = provider === "elevenlabs" ? { "xi-api-key": key } : { Authorization: `Bearer ${key}` };

  let last = "";
  for (let attempt = 1; attempt <= Math.max(1, Number(env.ASR_TRIES) || 3); attempt++) {
    const response = await fetch(url, { method: "POST", headers, body: build() });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.detail?.message || result.error?.message || `转写失败 ${response.status}`);
    const text = String(result.text ?? "").trim();
    // Scribe 偶尔会对明明有人在说话的录音整条返回「[音乐背景音乐]」这种纯标签。
    // 碰到就当没转出来，重发几次——实测同一条音频重试就正常了。
    if (text && !ONLY_SOUND_TAGS.test(text)) return { text };
    last = text;
    console.error(`[asr 第 ${attempt} 次只给了标签 ${JSON.stringify(text)}，重试]`);
  }
  return { text: last };
}

// 听语气：同一段音频再丢给全模态模型，让它说「对方是怎么说的」。
// 纯粹是锦上添花——失败就当没有，绝不影响转写。
// 注意问的是「怎么说」不是「说了什么」，免得把转写的话重复一遍。
async function hearTone(wav) {
  if (env.TONE === "0" || !env.DASHSCOPE_API_KEY) return "";
  const audio = `data:audio/wav;base64,${readFileSync(wav).toString("base64")}`;
  const ask = env.TONE_PROMPT
    || "只听语气，不要复述内容。用一句话说清对方此刻的情绪和状态（例如：平静、开心、疲惫、撒娇、敷衍、着急），要具体，别客套。";
  // 免费额度是按模型分开算的，这个用完了换下一个
  const models = (env.TONE_MODEL || "qwen3.8-omni-flash,qwen-omni-turbo").split(",").map((name) => name.trim()).filter(Boolean);
  for (const model of models) {
    try {
      const response = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: [
            { type: "input_audio", input_audio: { data: audio, format: "wav" } },
            { type: "text", text: ask },
          ] }],
        }),
        signal: AbortSignal.timeout(Number(env.TONE_TIMEOUT_MS) || 25000),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
      const said = String(result.choices?.[0]?.message?.content ?? "").trim().replace(/^["“]|["”]$/g, "");
      if (!said) throw new Error("模型没吭声");
      return said;
    } catch (error) {
      console.error(`[tone ${model} 不成]`, error.message);
    }
  }
  return "";
}

// 拼一句给 AI 看的话：转写和语气哪个缺了就少说哪个，都不缺就都带上。
function describeVoice(seconds, said, tone) {
  if (!tone) return `（${OWNER}发来一条语音${seconds}：${said ? `「${said}」` : "没转出字"}）`;
  return said
    ? `（${OWNER}发来一条语音${seconds}：「${said}」——${tone}）`
    : `（${OWNER}发来一条语音${seconds}：没转出字，不过${tone}）`;
}

async function take(content, depth = 0) {
  const type = content?.type;
  if (type === "text") {
    if (content.text?.trim()) remember({ kind: "text", text: content.text.trim() });
    return Boolean(content.text?.trim());
  }
  if (type === "group" && depth < 2) {
    let any = false;
    for (const item of content.items ?? []) any = (await take(item.content, depth + 1)) || any;
    return any;
  }
  if (type === "attachment" && /^image\//i.test(content.mimeType)) {
    const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic", "image/heif": ".heic", "image/gif": ".gif", "image/webp": ".webp" }[content.mimeType] || ".jpg";
    try {
      const file = keep(await content.read(), ext);
      remember({ kind: "image", text: `（${OWNER}发来一张图片）`, file, mimeType: content.mimeType });
    } catch (error) {
      console.error("[image failed]", error);
      remember({ kind: "image", text: `（${OWNER}发来一张图片（${content.mimeType}），但这边没存下来）` });
    }
    return true;
  }
  if (type === "voice" || (type === "attachment" && /^audio\//i.test(content.mimeType))) {
    const seconds = content.duration ? `，${Math.round(content.duration)}秒` : "";
    try {
      const buffer = await content.read();
      const file = keep(buffer, (content.name?.match(/\.\w+$/) ?? [".caf"])[0]);
      let said = "";
      let tone = "";
      try {
        const wav = await toWav(buffer);
        // 转写和听语气互不依赖，并行跑，省一趟往返
        [said, tone] = await Promise.all([
          hearVoice(wav).then((result) => result.text).catch((error) => {
            console.error("[asr failed]", error.message);
            return "";
          }),
          hearTone(wav),
        ]);
      } catch (error) {
        console.error("[voice 处理失败]", error.message);
      }
      remember({ kind: "voice", file, transcript: said, tone, text: describeVoice(seconds, said, tone) });
    } catch (error) {
      console.error("[voice failed]", error);
      remember({ kind: "voice", text: `（${OWNER}发来一条语音${seconds}，但这边没收下来）` });
    }
    return true;
  }
  if (type === "reaction") {
    const target = content.target?.content?.type === "text" ? `「${content.target.content.text.slice(0, 40)}」` : "一条消息";
    remember({ kind: "reaction", text: `（${OWNER}给你的${target}点了 ${content.emoji}）` });
    return true;
  }
  if (type === "attachment") {
    remember({ kind: "file", text: `（${OWNER}发来一个文件：${content.name || content.mimeType}，这边还打不开）` });
    return true;
  }
  if (type && !["read", "typing"].includes(type)) {
    remember({ kind: "other", text: `（${OWNER}发来一条${type}，这边还看不了）` });
    return true;
  }
  return false;
}

// ---------- 我要发的：文字、回应、链接、图片、表情、语音 ----------

const ACTION = /^\[\[(回应|链接|图片|表情|语音)[:：]\s*([\s\S]+?)\s*\]\]$/;

const recentStickers = [];
function sticker(wanted) {
  const key = wanted.trim();
  const exact = Object.entries(NOTES).find(([path, [name]]) => name === key && existsSync(STICKERS + path));
  if (exact) return attachment(STICKERS + exact[0]);
  const folder = moods().find((name) => name === key || key.includes(name) || name.includes(key));
  if (!folder) throw new Error(`没有「${wanted}」这种表情，有：${moods().join(" ") || "（一个都没有）"}`);
  const files = readdirSync(STICKERS + folder).filter((name) => /\.(jpe?g|png|gif|webp|heic)$/i.test(name));
  if (!files.length) throw new Error(`「${wanted}」那个文件夹是空的`);
  const fresh = files.filter((name) => !recentStickers.includes(`${folder}/${name}`));
  const pool = fresh.length ? fresh : files;
  const name = pool[Math.floor(Math.random() * pool.length)];
  recentStickers.push(`${folder}/${name}`);
  if (recentStickers.length > 20) recentStickers.shift();
  return attachment(`${STICKERS}${folder}/${name}`);
}

async function speak(words) {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) throw new Error("没配声音（ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID）");
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text: words, model_id: env.ELEVENLABS_MODEL || "eleven_v3" }),
  });
  if (!response.ok) throw new Error(`ElevenLabs ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const mp3 = join(tmpdir(), `voice-${Date.now()}.mp3`);
  const m4a = mp3.replace(/\.mp3$/, ".m4a");
  writeFileSync(mp3, Buffer.from(await response.arrayBuffer()));
  await run("ffmpeg", ["-nostdin", "-y", "-i", mp3, "-ac", "1", "-c:a", "aac", "-b:a", "64k", m4a]);
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", m4a]);
  return voice(readFileSync(m4a), { mimeType: "audio/x-m4a", name: `${env.VOICE_NAME || "voice"}.m4a`, duration: Number(stdout) || undefined });
}

async function fetchImage(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const mimeType = (response.headers.get("content-type") || "").split(";")[0];
  if (!response.ok || !mimeType.startsWith("image/")) throw new Error(`不是能打开的图片（${response.status} ${mimeType}）`);
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "image") || "image";
  return attachment(Buffer.from(await response.arrayBuffer()), { mimeType, name });
}

// 把一段话发成气泡；单独成行的 [[链接:…]] 之类会变成真的 iMessage 动作。返回没发成的那几条。
async function deliver(space, reply, target) {
  const bubbles = reply.split(/\n\s*\n/).flatMap((part) => {
    // 动作行可以夹在文字气泡里：拆出来，顺序不变
    const out = [];
    let words = [];
    for (const line of part.split("\n")) {
      if (ACTION.test(line.trim())) {
        if (words.join("").trim()) out.push(words.join("\n").trim());
        words = [];
        out.push(line.trim());
      } else words.push(line);
    }
    if (words.join("").trim()) out.push(words.join("\n").trim());
    return out;
  }).filter(Boolean);
  const failed = [];
  for (const [index, bubble] of bubbles.entries()) {
    const action = bubble.match(ACTION);
    try {
      if (!action) {
        if (index) await sleep(Math.min(2500, 600 + bubble.length * 25));
        await space.send(bubble);
      } else if (action[1] === "回应") {
        if (!target) throw new Error("没有可以点回应的消息");
        await target.react(action[2]);
      } else if (action[1] === "链接") {
        await space.send(richlink(new URL(action[2]).href));
      } else if (action[1] === "图片") {
        await space.send(await fetchImage(action[2]));
      } else if (action[1] === "表情") {
        await space.send(sticker(action[2]));
      } else if (action[1] === "语音") {
        await space.send(await speak(action[2]));
      }
    } catch (error) {
      console.error(`[${action?.[1] ?? "text"} failed]`, error);
      failed.push(`${bubble.slice(0, 60)} → ${error.message || error}`);
    }
  }
  return { count: bubbles.length, failed };
}

// ---------- 本机门：AI 的 MCP 和终端里的你都走这儿 ----------

let spectrum = null;
let lastSpace = null;
let lastFromHer = null; // 对方最新一条，给 [[回应:…]] 用

async function herSpace() {
  if (lastSpace) return lastSpace;
  const platform = imessage(spectrum);
  for (const id of [state.spaceId, `any;-;${env.OWNER_PHONE}`, `iMessage;-;${env.OWNER_PHONE}`].filter(Boolean)) {
    try {
      lastSpace = await platform.space.get(id);
      if (lastSpace) return lastSpace;
    } catch { /* 换下一种写法再试 */ }
  }
  throw new Error("还不知道往哪个对话发：让对方先发一条消息过来");
}

function startDoor() {
  const json = (response, code, body) => response.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const read = async (request) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    return JSON.parse(body || "{}");
  };
  createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${SEND_TOKEN}`) return json(response, 401, { error: "unauthorized" });
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (request.method === "POST" && url.pathname === "/send") {
        const text = String((await read(request)).text ?? "").trim();
        if (!text) throw new Error("文字是空的");
        const { count, failed } = await deliver(await herSpace(), text, lastFromHer);
        return json(response, 200, { sent: count, failed });
      }
      if (request.method === "GET" && url.pathname === "/recent") {
        const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
        const list = url.searchParams.get("unread_only") === "1" ? inbox.filter((entry) => !entry.read) : inbox;
        return json(response, 200, { unread: unread(), messages: list.slice(-limit) });
      }
      if (request.method === "POST" && url.pathname === "/read") {
        for (const entry of inbox) entry.read = true;
        writeFileSync(INBOX, JSON.stringify(inbox, null, 2));
        return json(response, 200, { unread: 0 });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, {
          ok: true, connected: Boolean(spectrum), space: state.spaceId ?? null,
          unread: unread(), moods: moods(),
        });
      }
      return json(response, 404, { error: "没这个路口" });
    } catch (error) {
      console.error(`[door ${url.pathname} failed]`, error);
      return json(response, 409, { error: String(error.message || error) });
    }
  }).listen(DOOR_PORT, "127.0.0.1", () => console.log(`[door] listening on 127.0.0.1:${DOOR_PORT}`));
}

async function main() {
  if (existsSync(`${STICKERS}.git`)) await run("git", ["-C", STICKERS, "pull", "--ff-only", "-q"]).catch((error) => console.error("[stickers pull failed]", error.message));
  spectrum = await Spectrum({
    projectId: env.PHOTON_PROJECT_ID,
    projectSecret: env.PHOTON_PROJECT_SECRET,
    providers: [imessage.config()],
  });
  startDoor();
  console.log(`[photon] 线路已连上，等${OWNER}说话`);
  for await (const [space, message] of spectrum.messages) {
    if (message.direction === "outbound" || message.platform !== "imessage") continue;
    if (!isHer(message.sender?.id)) continue;
    const content = message.content ?? {};
    lastSpace = space;
    if (content.type !== "reaction") lastFromHer = message;
    if (message.space?.id && state.spaceId !== message.space.id) {
      state.spaceId = message.space.id;
      saveState();
    }
    await take(content);
  }
}

main().catch((error) => {
  console.error("[fatal]", error);
  process.exit(1);
});
