import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendFile, copyFile, mkdir, readFile as readFile$1, readdir, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";
import * as zlib from "node:zlib";
// src/intro.ts
/**
* 内置介绍页：固定在插件里，任何用户初始化库时都会补进库根
* （对齐 WorkBuddy 资料库的内置介绍 HTML）。
* 缺了就补（重启后删除会被还原）；已存在的内容绝不覆盖，用户改过的保留。
*/
const STYLE = `
  <style>
    body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 48px 56px; color: #1f2329; line-height: 1.75; background: #fff; }
    h1 { font-size: 26px; margin: 0 0 8px; }
    h2 { font-size: 17px; margin: 32px 0 8px; padding-left: 10px; border-left: 3px solid #3370ff; }
    p, li { font-size: 14px; color: #4e5566; }
    .sub { color: #8f959e; font-size: 14px; margin: 0 0 24px; }
    .card { background: #f5f6f7; border-radius: 10px; padding: 16px 20px; margin: 12px 0; }
    .card b { color: #1f2329; }
    code { background: #eff0f1; border-radius: 4px; padding: 1px 6px; font-size: 13px; }
  </style>`;
const INTRO_FILES = [{
	name: "欢迎使用资料库.html",
	html: `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>欢迎使用资料库</title>${STYLE}</head>
<body>
  <h1>欢迎使用资料库</h1>
  <p class="sub">dsh-wb-desk · 你的 Agent 产物自动归档处</p>

  <h2>这是什么</h2>
  <p>资料库是 Agent 工作产物的家。Agent 在对话中生成的文件会自动收进来，你在这里统一查看、预览、整理，不用再到处找文件。</p>

  <h2>三分钟上手</h2>
  <div class="card"><b>本地产物</b> —— 左侧菜单点「本地产物」，按工作区 → 会话分组看 Agent 刚生成的文件，点任意文件右侧抽屉直接预览内容。</div>
  <div class="card"><b>我的资料</b> —— 库里的全部文件。支持搜索、按类型筛选、收藏、重命名、移动、删除（删除进回收站，可恢复）。</div>
  <div class="card"><b>新建</b> —— 左侧菜单点「新建」，直接创建 Markdown / CSV / HTML / Word / Excel / PPT，也能上传文件、添加链接、新建文件夹。</div>

  <h2>文件从哪来</h2>
  <p>Agent 用写入工具产出的文件，会自动复制一份到本库的 <code>inbox/</code> 目录，原处的文件不受影响。只有插件安装之后产生的会话产物才会收录，历史产物不回填。</p>
</body>
</html>`
}, {
	name: "功能指南.html",
	html: `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>功能指南</title>${STYLE}</head>
<body>
  <h1>功能指南</h1>
  <p class="sub">dsh-wb-desk · 进阶能力一览</p>

  <h2>修改要确认，绝不直接覆盖</h2>
  <p>Agent 想改库里<b>已有</b>的文件时，改动不会直接落盘，而是进入左侧菜单的「待确认」队列。你逐条看过之后，接受才写入，拒绝就丢弃。新文件则免确认直接进来。</p>

  <h2>固定引用（pin）</h2>
  <p>你引用了某个文件之后它又被改了？读取时插件会给你 pin 时刻的版本并提示漂移，避免基于过期内容做决策。在面板底部「固定引用」里可以查看和释放。</p>

  <h2>云同步（腾讯云 COS）</h2>
  <p>左侧菜单底部「云同步」里填入 COS 的地址、Bucket、密钥即可启用。语义刻意简单：本地永远是主库，云端是镜像；按修改时间新盖旧；删除不传播（任一端删文件不会影响另一端）。开启自动推送后，每次写入 5 秒后自动同步。</p>

  <h2>回收站</h2>
  <p>删除的文件先进 <code>.dsh-library/.trash/</code>，误删可以手动捞回；清空回收站才彻底删除。</p>

  <h2>这两个介绍页</h2>
  <p>它们是普通 HTML 文件，就在库根目录。看完可以直接删除，插件不会重新生成。</p>
</body>
</html>`
}];
// src/store.ts
/**
* dsh-wb-desk 存储层：文件本体直存，元数据收在 .dsh-library/ 隐藏目录。
*
* 布局：
*   $DSH_HOME/library/            库根（可配置覆盖）
*     *.html                      内置的两个介绍页（首次初始化时补，用户可删可改）
*     inbox/                      Agent 自动归位的落点（有产物时才出现，不预建空目录）
*     .dsh-library/               插件元数据（不与用户文件混放）
*       pending/                  待确认队列（持久化，崩溃不丢）
*       pins/                     固定修订引用快照
*
* 初始化"原地收编"：只补建缺失内容，绝不移动/改写已有文件。
*/
/** 库根：DSH_LIBRARY_ROOT 覆盖 > DSH_HOME/library > ~/.dsh/library */
const LIBRARY_ROOT = process.env.DSH_WB_DESK_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "library");
/** 插件元数据目录（隐藏，与用户文件分离）。 */
const META_DIR = join(LIBRARY_ROOT, ".dsh-library");
const PENDING_DIR = join(META_DIR, "pending");
const PINS_DIR = join(META_DIR, "pins");
/** 回收站：删除的文件移到这里可恢复，不参与树与搜索。 */
const TRASH_DIR = join(META_DIR, ".trash");
/**
* 初始化库：mkdir recursive 对已存在目录是幂等 no-op；
* 两个介绍页是插件固定内置内容，缺了就补、已有不覆盖。
*/
async function initLibrary() {
	await mkdir(META_DIR, { recursive: true });
	await mkdir(PENDING_DIR, { recursive: true });
	await mkdir(PINS_DIR, { recursive: true });
	for (const file of INTRO_FILES) {
		const abs = join(LIBRARY_ROOT, file.name);
		if (!existsSync(abs)) await writeFile(abs, file.html, "utf8");
	}
}
/** 库内相对路径 → 绝对路径（调用方需已校验无 .. 越界）。 */
function inLibrary(relativePath) {
	return join(LIBRARY_ROOT, relativePath);
}
/** 判断绝对路径是否落在库内。 */
function isInsideLibrary(absolutePath) {
	const norm = absolutePath.replaceAll("\\", "/");
	const root = LIBRARY_ROOT.replaceAll("\\", "/");
	return norm.startsWith(root.endsWith("/") ? root : root + "/");
}
// src/pending.ts
/**
* 待确认队列（需求文档 3.1）：Agent 对库内已有文件的修改不直接落盘，
* 先持久化到 .dsh-library/pending/，用户接受后才写入正文。
*
* 持久化是硬要求：DSH 重启/崩溃后队列不能丢——"Agent 产出丢失"
* 恰恰是本产品要解决的原始痛点，队列自身不能成为新的丢失源。
* 拒绝的内容也保留（移入 rejected.jsonl），可追溯找回。
*/
/** 队列文件命名：pending/<createdAt 时间戳>-<id前8位>.json */
function pendingFile(change) {
	return join(PENDING_DIR, `${change.createdAt.replace(/[:.]/g, "-")}-${change.id.slice(0, 8)}.json`);
}
/** 新增一条待确认修改并立即持久化。 */
async function enqueue(input) {
	await mkdir(PENDING_DIR, { recursive: true });
	const change = {
		id: randomUUID(),
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		...input
	};
	await writeFile(pendingFile(change), JSON.stringify(change, null, 2), "utf8");
	return change;
}
/** 列出当前所有待确认修改（按创建时间升序）。 */
async function listPending() {
	const { readdir } = await import("node:fs/promises");
	await mkdir(PENDING_DIR, { recursive: true });
	const files = (await readdir(PENDING_DIR)).filter((f) => f.endsWith(".json")).sort();
	const changes = [];
	for (const f of files) try {
		changes.push(JSON.parse(await readFile$1(join(PENDING_DIR, f), "utf8")));
	} catch {}
	return changes;
}
/** 处置一条待确认修改：接受则落盘，拒绝则归档。返回是否找到该条。 */
async function resolvePending(id, action) {
	const found = (await listPending()).find((c) => c.id === id || c.id.startsWith(id));
	if (!found) return false;
	const file = pendingFile(found);
	if (action === "accept") {
		await writeFile(found.targetPath, found.content, "utf8");
		await rename(file, file + ".resolved");
	} else await rename(file, file + ".rejected");
	return true;
}
/** 从工具参数中提取摘要与完整内容（不同工具参数名不同，宽松匹配）。 */
function extractContent(args) {
	const content = typeof args.content === "string" ? args.content : typeof args.new_string === "string" ? args.new_string : "";
	return {
		content,
		summary: content.length > 200 ? content.slice(0, 200) + "…" : content
	};
}
// src/sessionmeta.ts
/**
* 会话元数据解析：把台账里的 sessionId 翻译成人类可读的
* 「DSH 工作区名 + 会话标题」（本地产物按 工作区/会话/文件 三级分组）。
*
* 数据源：$DSH_HOME/sessions/<编码工作区>/<sessionId>/session.v4.jsonl.zstd
*   - 第 1 帧第 1 行是 session 元信息（cwd → 工作区名）
*   - 后续帧里的 session/title 事件给出标题，取最后一条（LLM 精修会覆盖兜底标题）
*
* 文件是多帧拼接的 zstd（按 magic 0xFD2FB528 切帧）；运行时不支持 zstd
* 或文件缺失时返回 null，调用方走兜底展示。结果按文件 mtime 缓存。
*/
/** Node ≥22.15 才有 zstd；运行时没有就整体降级为「解析不到」（兜底展示），不能拖垮插件加载。 */
const zstdDecompress$1 = zlib.zstdDecompressSync;
const SESSIONS_ROOT$1 = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
const ZSTD_MAGIC$1 = Buffer.from("28b52ffd", "hex");
const metaCache = /* @__PURE__ */ new Map();
/** sessionId → 会话目录绝对路径（目录清单按 TTL 缓存，避免每次全量扫） */
const dirCache = /* @__PURE__ */ new Map();
let dirListCache = null;
const DIR_LIST_TTL = 6e4;
async function workspaceDirs() {
	if (dirListCache && Date.now() - dirListCache.time < DIR_LIST_TTL) return dirListCache.dirs;
	let dirs = [];
	try {
		dirs = (await readdir(SESSIONS_ROOT$1, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(SESSIONS_ROOT$1, e.name));
	} catch {
		dirs = [];
	}
	dirListCache = {
		time: Date.now(),
		dirs
	};
	return dirs;
}
/** 定位某个 sessionId 的日志文件；找不到返回 null。 */
async function locateSessionFile(sessionId) {
	const hit = dirCache.get(sessionId);
	if (hit) return hit;
	for (const wsDir of await workspaceDirs()) {
		const file = join(wsDir, sessionId, "session.v4.jsonl.zstd");
		try {
			await stat(file);
			dirCache.set(sessionId, file);
			return file;
		} catch {}
	}
	return null;
}
/** 逐帧解压并提取 cwd（工作区名）与最后的会话标题。 */
function parseSessionFile(buf) {
	if (!zstdDecompress$1) return null;
	const offsets = [0];
	for (let i = buf.indexOf(ZSTD_MAGIC$1, 4); i !== -1; i = buf.indexOf(ZSTD_MAGIC$1, i + 4)) offsets.push(i);
	let cwd = "";
	let title = "";
	for (let k = 0; k < offsets.length; k++) {
		const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
		let out;
		try {
			out = zstdDecompress$1(buf.subarray(offsets[k], end));
		} catch {
			continue;
		}
		for (const line of out.toString("utf8").split("\n")) {
			if (!line) continue;
			if (!cwd && line.startsWith("{\"type\":\"session\"")) {
				try {
					const meta = JSON.parse(line);
					if (typeof meta.cwd === "string") cwd = meta.cwd;
				} catch {}
				continue;
			}
			if (line.startsWith("{\"type\":\"session/title\"")) try {
				const ev = JSON.parse(line);
				if (typeof ev.data?.title === "string" && ev.data.title) title = ev.data.title;
			} catch {}
		}
	}
	if (!cwd && !title) return null;
	const norm = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
	return {
		wsName: cwd ? norm.toLowerCase() === homedir().replaceAll("\\", "/").toLowerCase() ? "主目录" : basename(norm) : "",
		title
	};
}
/**
* 解析 sessionId → 工作区名 + 会话标题。
* 任何一步失败都返回 null（调用方用 sessionId 截断展示兜底）。
*/
async function resolveSessionMeta(sessionId) {
	if (!sessionId || sessionId === "未知会话") return null;
	const file = await locateSessionFile(sessionId);
	if (!file) return null;
	let mtimeMs;
	try {
		mtimeMs = (await stat(file)).mtimeMs;
	} catch {
		return null;
	}
	const cached = metaCache.get(sessionId);
	if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
	let meta = null;
	try {
		meta = parseSessionFile(await readFile$1(file));
	} catch {
		meta = null;
	}
	metaCache.set(sessionId, {
		mtimeMs,
		meta
	});
	return meta;
}
/** 会话日志的最后活动时间（mtime）；会话结束后不再增长。定位不到返回 null。 */
async function sessionLastActive(sessionId) {
	if (!sessionId || sessionId === "未知会话") return null;
	const file = await locateSessionFile(sessionId);
	if (!file) return null;
	try {
		return (await stat(file)).mtimeMs;
	} catch {
		return null;
	}
}
// src/pins.ts
/**
* 固定修订引用（需求文档 3.3）：Agent 首次读取库内文件时打快照（pin），
* 之后同会话再次读取时，若文件已漂移，Agent 拿到的仍是 pin 时刻版本并收到漂移提示。
*
* 存储布局（.dsh-library/pins/）：
*   <hash8>-<ts>.json   pin 快照本体（内容 + 元数据）
*   active.json         { [库内相对路径]: { pinId, hash, createdAt } } 当前生效 pin 索引
*
* 生命周期跟随会话：v0.1 由 UI「释放」或用户手动清理 active.json 条目；
* 后续接入宿主会话生命周期事件后自动清理。
*/
const ACTIVE_FILE = join(PINS_DIR, "active.json");
function hashOf(content) {
	return createHash("sha256").update(content, "utf8").digest("hex");
}
async function readActiveIndex() {
	try {
		return JSON.parse(await readFile$1(ACTIVE_FILE, "utf8"));
	} catch {
		return {};
	}
}
async function writeActiveIndex(index) {
	await mkdir(PINS_DIR, { recursive: true });
	await writeFile(ACTIVE_FILE, JSON.stringify(index, null, 2), "utf8");
}
/**
* 读取库内文件时的 pin 语义：
* - 无 pin → 以当前内容新建（首次固定）；
* - 有 pin 且未漂移 → 直接复用；
* - 有 pin 且已漂移 → 保持旧 pin，返回漂移信息（Agent 拿固定版本 + 提示）。
*/
async function pinForRead(absPath, relPath, sessionId = "") {
	if (!existsSync(absPath)) return null;
	const current = await readFile$1(absPath, "utf8");
	const currentHash = hashOf(current);
	const index = await readActiveIndex();
	const active = index[relPath];
	if (!active) {
		const pin = {
			id: randomUUID(),
			relPath,
			content: current,
			hash: currentHash,
			createdAt: (/* @__PURE__ */ new Date()).toISOString(),
			...sessionId && sessionId !== "未知会话" ? { sessionId } : {}
		};
		await mkdir(PINS_DIR, { recursive: true });
		await writeFile(join(PINS_DIR, `${pin.hash.slice(0, 8)}-${Date.now()}.json`), JSON.stringify(pin, null, 2), "utf8");
		index[relPath] = {
			pinId: pin.id,
			hash: pin.hash,
			createdAt: pin.createdAt,
			...pin.sessionId ? { sessionId: pin.sessionId } : {}
		};
		await writeActiveIndex(index);
		return {
			pin,
			created: true,
			drifted: false
		};
	}
	if (active.hash === currentHash) return {
		pin: {
			id: active.pinId,
			relPath,
			content: current,
			hash: active.hash,
			createdAt: active.createdAt,
			...active.sessionId ? { sessionId: active.sessionId } : {}
		},
		created: false,
		drifted: false
	};
	const pinFile = await findPinFile(active.hash);
	return {
		pin: pinFile ? JSON.parse(await readFile$1(pinFile, "utf8")) : {
			id: active.pinId,
			relPath,
			content: "",
			hash: active.hash,
			createdAt: active.createdAt
		},
		created: false,
		drifted: true,
		current: {
			content: current,
			hash: currentHash
		}
	};
}
/** 快照文件按内容 hash 前 8 位命名，按 hash 定位（历史上曾误用 pinId 前缀，兜底也试一次）。 */
async function findPinFile(hash) {
	try {
		const files = await readdir(PINS_DIR);
		const prefix = hash.slice(0, 8).toLowerCase();
		const hit = files.find((f) => f.endsWith(".json") && f !== "active.json" && f.toLowerCase().startsWith(prefix + "-"));
		return hit ? join(PINS_DIR, hit) : null;
	} catch {
		return null;
	}
}
/** 列出全部生效 pin（相对路径 + 元数据，不含内容）。 */
async function listActivePins() {
	const index = await readActiveIndex();
	const out = [];
	for (const [relPath, active] of Object.entries(index)) {
		let drifted = true;
		try {
			drifted = hashOf(await readFile$1(inLibrary(relPath), "utf8")) !== active.hash;
		} catch {
			drifted = true;
		}
		out.push({
			relPath,
			pinId: active.pinId,
			hash: active.hash,
			createdAt: active.createdAt,
			drifted
		});
	}
	return out;
}
/** 释放（重新固定入口）：删除 pin 索引条目与快照文件；下次读取会重新固定。 */
async function releasePin(relPath) {
	const index = await readActiveIndex();
	const active = index[relPath];
	if (!active) return false;
	delete index[relPath];
	await writeActiveIndex(index);
	const file = await findPinFile(active.hash);
	if (file) try {
		await unlink(file);
	} catch {}
	return true;
}
const DAY_MS$1 = 864e5;
/** 没有被索引引用的快照文件超过这个天数就删掉。 */
const ORPHAN_SNAPSHOT_DAYS = 30;
/**
* 自动清理：会话最后活动时间（定位不到会话时退回 pin 创建时间）超过保留期即释放。
* 同时清掉已无索引引用、且超过 30 天的孤儿快照文件。
*/
async function cleanupPins(retentionDays) {
	const index = await readActiveIndex();
	const now = Date.now();
	const keepMs = Math.min(365, Math.max(1, retentionDays)) * DAY_MS$1;
	let removed = 0;
	for (const [relPath, active] of Object.entries(index)) {
		const lastActive = active.sessionId ? await sessionLastActive(active.sessionId) ?? Date.parse(active.createdAt) : Date.parse(active.createdAt);
		if (!Number.isFinite(lastActive) || now - lastActive <= keepMs) continue;
		delete index[relPath];
		const file = await findPinFile(active.hash);
		if (file) try {
			await unlink(file);
		} catch {}
		removed++;
	}
	if (removed > 0) await writeActiveIndex(index);
	try {
		const pinnedPrefixes = new Set(Object.values(index).map((a) => a.hash.slice(0, 8).toLowerCase()));
		for (const f of await readdir(PINS_DIR)) {
			if (f === "active.json" || !f.endsWith(".json")) continue;
			if (pinnedPrefixes.has(f.slice(0, 8).toLowerCase())) continue;
			const p = join(PINS_DIR, f);
			if (now - (await stat(p)).mtimeMs > ORPHAN_SNAPSHOT_DAYS * DAY_MS$1) {
				await unlink(p);
				removed++;
			}
		}
	} catch {}
	return removed;
}
// src/artifacts.ts
/**
* 产物台账（对标 WorkBuddy「本地产物」按会话列产物）：
* Agent 每次产出被归位/确认入库时，记录会话、工具、来源与库内落点，
* JSONL 追加写（.dsh-library/provenance.jsonl），供面板按会话分组展示。
*/
const LEDGER = join(META_DIR, "provenance.jsonl");
/**
* 从 exec.agent 防御式提取会话标识。
* 宿主 Agent 类型未公开稳定字段，按常见命名逐个试探，取不到给"未知会话"。
*/
function sessionIdOf(agent) {
	if (agent && typeof agent === "object") {
		const a = agent;
		for (const key of [
			"sessionId",
			"session_id",
			"sessionKey",
			"id",
			"name"
		]) if (typeof a[key] === "string" && a[key].length > 0) return a[key];
		const session = a.session;
		if (session && typeof session === "object") for (const key of [
			"id",
			"sessionId",
			"session_id"
		]) {
			const v = session[key];
			if (typeof v === "string" && v.length > 0) return v;
		}
	}
	return "未知会话";
}
/** 追加一条台账（失败静默：台账不能影响归位主流程）。 */
async function appendArtifact(record) {
	try {
		await appendFile(LEDGER, JSON.stringify({
			...record,
			time: (/* @__PURE__ */ new Date()).toISOString()
		}) + "\n", "utf8");
	} catch {}
}
/** 读取全部台账，最新在前。 */
async function readArtifacts() {
	try {
		const text = await readFile$1(LEDGER, "utf8");
		return text.trim() ? text.trim().split("\n").map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		}).filter((r) => r !== null).reverse() : [];
	} catch {
		return [];
	}
}
// src/cloud.ts
/**
* dsh-wb-desk 云同步：单用户、本地优先、云端镜像。
*
* 语义（刻意简单，单用户场景够用）：
*   - 本地库永远是主库，读写都走本地；云端是镜像
*   - syncUp：本地新/改 → 传云端；syncDown：云端新/改 → 拉回本地（按最后修改时间比较）
*   - 删除不传播（任何一端删文件不会同步删另一端，防误删）
*   - 插件元数据目录 .dsh-library/ 不参与同步（pending/pins 是本地语义）
*
* 支持两种「云存储地址」：
*   - S3 兼容：阿里 OSS / 腾讯 COS / AWS S3 / Cloudflare R2 / MinIO（SigV4 签名，纯 crypto 实现）
*   - WebDAV：坚果云 / NAS / Nextcloud（Basic auth + PROPFIND/GET/PUT/MKCOL）
*
* 配置存 META_DIR/cloud.json（本机明文，与 npmrc 同级风险；别提交进 git）。
*/
const CONFIG_FILE$1 = join(META_DIR, "cloud.json");
async function loadCloudConfig() {
	try {
		const cfg = JSON.parse(await readFile$1(CONFIG_FILE$1, "utf8"));
		if (!cfg.endpoint || !cfg.accessKey) return null;
		return cfg;
	} catch {
		return null;
	}
}
async function saveCloudConfig(cfg) {
	await mkdir(META_DIR, { recursive: true });
	await writeFile(CONFIG_FILE$1, JSON.stringify(cfg, null, 2), "utf8");
}
function prefixOf(cfg) {
	const p = (cfg.prefix || "dsh-library").replace(/^\/+|\/+$/g, "");
	return p ? p + "/" : "";
}
/** 列表键统一为去掉前缀的相对键；上传/下载键统一加前缀。 */
function toRelKey(cfg, key) {
	const k = key.replace(/^\/+/, "");
	const p = prefixOf(cfg);
	return k.startsWith(p) ? k.slice(p.length) : k;
}
function sha256hex(buf) {
	return createHash("sha256").update(buf).digest("hex");
}
function hmac(key, data) {
	return createHmac("sha256", key).update(data).digest();
}
function s3Host(cfg) {
	const u = new URL(cfg.endpoint);
	return {
		host: cfg.bucket ? `${cfg.bucket}.${u.host}` : u.host,
		basePath: u.pathname.replace(/\/+$/, "")
	};
}
/**
* 请求目标：默认 virtual-hosted（bucket 进域名），pathStyle 时 bucket 进路径
* （七牛 Kodo / 多数自建 MinIO 只支持这种）。
*/
function s3Target(cfg) {
	const u = new URL(cfg.endpoint);
	const pathStyle = !!cfg.pathStyle && !!cfg.bucket;
	return {
		host: cfg.bucket && !pathStyle ? `${cfg.bucket}.${u.host}` : u.host,
		basePath: u.pathname.replace(/\/+$/, ""),
		bucketPath: pathStyle ? "/" + encodeKey(cfg.bucket) : ""
	};
}
function s3Region(cfg) {
	if (cfg.region && cfg.region.trim()) return cfg.region.trim();
	const m = s3Host(cfg).host.match(/(?:oss|cos)\.([a-z0-9-]+)\./) || s3Host(cfg).host.match(/\.([a-z0-9-]+)\.amazonaws\./);
	return m ? m[1] : "us-east-1";
}
function encodeKey(key) {
	return key.split("/").map(encodeURIComponent).join("/");
}
async function s3Request(cfg, method, key, query, body) {
	const { host, basePath, bucketPath } = s3Target(cfg);
	const region = s3Region(cfg);
	const amzDate = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = sha256hex(body ?? "");
	const path = basePath + bucketPath + (key ? "/" + encodeKey(key) : bucketPath ? "" : "/");
	const sortedQuery = Object.keys(query).sort().map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(query[k])).join("&");
	const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
	const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
	const canonicalRequest = [
		method,
		path,
		sortedQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash
	].join("\n");
	const scope = `${dateStamp}/${region}/s3/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256hex(canonicalRequest)
	].join("\n");
	const kSigning = hmac(hmac(hmac(hmac("AWS4" + cfg.secretKey, dateStamp), region), "s3"), "aws4_request");
	const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
	const res = await fetch(`https://${host}${path}${sortedQuery ? "?" + sortedQuery : ""}`, {
		method,
		headers: {
			"x-amz-date": amzDate,
			"x-amz-content-sha256": payloadHash,
			authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
		},
		body
	});
	return {
		status: res.status,
		buffer: Buffer.from(await res.arrayBuffer())
	};
}
async function s3List(cfg) {
	const out = [];
	let token = "";
	for (;;) {
		const query = {
			"list-type": "2",
			"max-keys": "1000",
			prefix: prefixOf(cfg)
		};
		if (token) query["continuation-token"] = token;
		const r = await s3Request(cfg, "GET", "", query);
		const text = r.buffer.toString("utf8");
		if (r.status !== 200) throw new Error(`列出失败（HTTP ${r.status}）：${text.slice(0, 200)}`);
		const blocks = text.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
		for (const b of blocks) {
			const relKey = toRelKey(cfg, decodeURIComponent(b.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? ""));
			const size = Number(b.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
			const lastmod = Date.parse(b.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? "") || 0;
			if (relKey && !relKey.endsWith("/")) out.push({
				key: relKey,
				size,
				lastmod
			});
		}
		const truncated = /<IsTruncated>true<\/IsTruncated>/.test(text);
		token = text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? "";
		if (!truncated || !token) break;
	}
	return out;
}
function sha1hex(s) {
	return createHash("sha1").update(s).digest("hex");
}
async function cosRequest(cfg, method, key, query, body) {
	if (!cfg.bucket) throw new Error("COS 需要填 Bucket（存储桶名-APPID）");
	const host = `${cfg.bucket}.${new URL(cfg.endpoint).host}`;
	const signPath = key ? "/" + key : "/";
	const wirePath = key ? "/" + encodeKey(key) : "/";
	const paramPairs = Object.keys(query).sort().map((k) => [k.toLowerCase(), query[k]]);
	const headerPairs = [["host", host]];
	const fmt = (pairs) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
	const list = (pairs) => pairs.map(([k]) => encodeURIComponent(k)).join(";");
	const nowSec = Math.floor(Date.now() / 1e3);
	const keyTime = `${nowSec - 60};${nowSec + 600}`;
	const stringToSign = `sha1\n${keyTime}\n${sha1hex([
		method.toLowerCase(),
		signPath,
		fmt(paramPairs),
		fmt(headerPairs),
		""
	].join("\n"))}\n`;
	const signKey = createHmac("sha1", cfg.secretKey).update(keyTime).digest("hex");
	const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");
	const auth = `q-sign-algorithm=sha1&q-ak=${encodeURIComponent(cfg.accessKey)}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${list(headerPairs)}&q-url-param-list=${list(paramPairs)}&q-signature=${signature}`;
	const qs = Object.keys(query).sort().map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(query[k])).join("&");
	const res = await fetch(`https://${host}${wirePath}${qs ? "?" + qs : ""}`, {
		method,
		headers: { authorization: auth },
		body
	});
	return {
		status: res.status,
		buffer: Buffer.from(await res.arrayBuffer())
	};
}
async function cosList(cfg) {
	const out = [];
	let marker = "";
	for (;;) {
		const query = {
			prefix: prefixOf(cfg),
			"max-keys": "1000"
		};
		if (marker) query.marker = marker;
		const r = await cosRequest(cfg, "GET", "", query);
		const text = r.buffer.toString("utf8");
		if (r.status !== 200) throw new Error(`列出失败（HTTP ${r.status}）：${text.slice(0, 200)}`);
		const blocks = text.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
		for (const b of blocks) {
			const relKey = toRelKey(cfg, decodeURIComponent(b.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? ""));
			const size = Number(b.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
			const lastmod = Date.parse(b.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? "") || 0;
			if (relKey && !relKey.endsWith("/")) out.push({
				key: relKey,
				size,
				lastmod
			});
		}
		if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) break;
		marker = text.match(/<NextMarker>([^<]+)<\/NextMarker>/)?.[1] ?? "";
		if (!marker) break;
	}
	return out;
}
function davAuth(cfg) {
	return "Basic " + Buffer.from(`${cfg.accessKey}:${cfg.secretKey}`).toString("base64");
}
function davUrl(cfg, key) {
	return cfg.endpoint.replace(/\/+$/, "") + "/" + encodeKey(prefixOf(cfg) + key);
}
async function davList(cfg) {
	const res = await fetch(davUrl(cfg, ""), {
		method: "PROPFIND",
		headers: {
			authorization: davAuth(cfg),
			depth: "1",
			"content-type": "application/xml"
		},
		body: "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>"
	});
	if (res.status === 404) return [];
	if (res.status !== 207) throw new Error(`列出失败（HTTP ${res.status}）：${(await res.text()).slice(0, 200)}`);
	const text = await res.text();
	const out = [];
	const baseHref = new URL(davUrl(cfg, "")).pathname.replace(/\/+$/, "") + "/";
	for (const m of text.matchAll(/<d:response>([\s\S]*?)<\/d:response>/g)) {
		const block = m[1];
		if (/<d:collection/.test(block)) continue;
		const href = decodeURIComponent(block.match(/<d:href>([^<]+)<\/d:href>/)?.[1] ?? "");
		if (!href.startsWith(baseHref)) continue;
		const key = href.slice(baseHref.length);
		if (!key) continue;
		const size = Number(block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/)?.[1] ?? 0);
		const lastmod = Date.parse(block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/)?.[1] ?? "") || 0;
		out.push({
			key,
			size,
			lastmod
		});
	}
	return out;
}
async function remoteList(cfg) {
	return cfg.protocol === "s3" ? s3List(cfg) : cfg.protocol === "cos" ? cosList(cfg) : davList(cfg);
}
async function remoteGet(cfg, key) {
	const fullKey = prefixOf(cfg) + key;
	if (cfg.protocol === "s3") {
		const r = await s3Request(cfg, "GET", fullKey, {});
		if (r.status !== 200) throw new Error(`下载失败（HTTP ${r.status}）`);
		return r.buffer;
	}
	if (cfg.protocol === "cos") {
		const r = await cosRequest(cfg, "GET", fullKey, {});
		if (r.status !== 200) throw new Error(`下载失败（HTTP ${r.status}）`);
		return r.buffer;
	}
	const res = await fetch(davUrl(cfg, key), { headers: { authorization: davAuth(cfg) } });
	if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
	return Buffer.from(await res.arrayBuffer());
}
async function remotePut(cfg, key, body) {
	const fullKey = prefixOf(cfg) + key;
	if (cfg.protocol === "s3") {
		const r = await s3Request(cfg, "PUT", fullKey, {}, body);
		if (r.status !== 200) throw new Error(`上传失败（HTTP ${r.status}）：${r.buffer.toString("utf8").slice(0, 200)}`);
		return;
	}
	if (cfg.protocol === "cos") {
		const r = await cosRequest(cfg, "PUT", fullKey, {}, body);
		if (r.status !== 200) throw new Error(`上传失败（HTTP ${r.status}）：${r.buffer.toString("utf8").slice(0, 200)}`);
		return;
	}
	const segs = key.split("/").slice(0, -1);
	let cur = "";
	for (const seg of segs) {
		cur = cur ? cur + "/" + seg : seg;
		await fetch(cfg.endpoint.replace(/\/+$/, "") + "/" + encodeKey(prefixOf(cfg) + cur), {
			method: "MKCOL",
			headers: { authorization: davAuth(cfg) }
		}).catch(() => {});
	}
	const res = await fetch(davUrl(cfg, key), {
		method: "PUT",
		headers: { authorization: davAuth(cfg) },
		body
	});
	if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error(`上传失败（HTTP ${res.status}）`);
}
async function localList() {
	const out = [];
	async function walk(dir, rel) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (rel === "" && entry.name === "inbox") continue;
			const abs = join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walk(abs, relPath);
			else if (entry.isFile()) try {
				const st = await stat(abs);
				out.push({
					rel: relPath,
					size: st.size,
					mtime: st.mtimeMs
				});
			} catch {}
		}
	}
	await walk(LIBRARY_ROOT, "");
	return out;
}
/** 把库内单个文件推到云端（relKey 为库内相对路径）。 */
async function pushFile(cfg, relKey) {
	const abs = join(LIBRARY_ROOT, relKey);
	await remotePut(cfg, relKey, await readFile$1(abs));
}
/**
* 生成 COS 预签名 GET 链接（带过期时间）。
* 签名进查询参数：q-url-param-list 为空、q-header-list=host，
* 规范串与线上 query 用同一套编码（对齐 cos-js-sdk-v5 的 getAuth 行为）。
*/
function presignCosGet(cfg, relKey, expiresSec) {
	if (cfg.protocol !== "cos") throw new Error("分享链接目前仅支持腾讯云 COS");
	if (!cfg.bucket) throw new Error("COS 需要填 Bucket（存储桶名-APPID）");
	const host = `${cfg.bucket}.${new URL(cfg.endpoint).host}`;
	const fullKey = prefixOf(cfg) + relKey;
	const signPath = "/" + fullKey;
	const wirePath = "/" + encodeKey(fullKey);
	const nowSec = Math.floor(Date.now() / 1e3);
	const keyTime = `${nowSec - 60};${nowSec + expiresSec}`;
	const query = {
		"q-sign-algorithm": "sha1",
		"q-ak": cfg.accessKey,
		"q-sign-time": keyTime,
		"q-key-time": keyTime,
		"q-header-list": "host",
		"q-url-param-list": ""
	};
	const encodePairs = (pairs) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
	const stringToSign = `sha1\n${keyTime}\n${sha1hex([
		"get",
		signPath,
		"",
		encodePairs([["host", host]]),
		""
	].join("\n"))}\n`;
	const signKey = createHmac("sha1", cfg.secretKey).update(keyTime).digest("hex");
	const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");
	return `https://${host}${wirePath}?${Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&")}&q-signature=${signature}`;
}
const SKEW_MS = 2e3;
/** 双向镜像：本地新的推上去，云端新的拉下来；删除不传播。 */
async function syncNow(cfg) {
	const [remote, local] = await Promise.all([remoteList(cfg), localList()]);
	const remoteMap = new Map(remote.map((r) => [r.key, r]));
	const localMap = new Map(local.map((l) => [l.rel, l]));
	const result = {
		pushed: 0,
		pulled: 0,
		skipped: 0,
		errors: []
	};
	for (const l of local) {
		const r = remoteMap.get(l.rel);
		if (!(!r || r.lastmod < l.mtime - SKEW_MS || r.size !== l.size && Math.abs(r.lastmod - l.mtime) > SKEW_MS)) {
			result.skipped++;
			continue;
		}
		try {
			await remotePut(cfg, l.rel, await readFile$1(join(LIBRARY_ROOT, l.rel)));
			result.pushed++;
		} catch (e) {
			result.errors.push(`${l.rel}：${e instanceof Error ? e.message : String(e)}`);
		}
	}
	for (const r of remote) {
		if (r.key === "inbox" || r.key.startsWith("inbox/")) {
			result.skipped++;
			continue;
		}
		const l = localMap.get(r.key);
		if (!(!l || l.mtime < r.lastmod - SKEW_MS)) {
			result.skipped++;
			continue;
		}
		try {
			const abs = join(LIBRARY_ROOT, r.key);
			if (r.key.includes("..")) {
				result.errors.push(`${r.key}：非法路径，跳过`);
				continue;
			}
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, await remoteGet(cfg, r.key));
			await utimes(abs, /* @__PURE__ */ new Date(), new Date(r.lastmod));
			result.pulled++;
		} catch (e) {
			result.errors.push(`${r.key}：${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return result;
}
/** 连通性测试：列出前缀内容即可。 */
async function testCloud(cfg) {
	try {
		return {
			ok: true,
			detail: `连接成功，云端前缀下已有 ${(await remoteList(cfg)).length} 个文件`
		};
	} catch (e) {
		return {
			ok: false,
			detail: e instanceof Error ? e.message : String(e)
		};
	}
}
let pushTimer = null;
let pushing = false;
function scheduleAutoPush(onDone) {
	if (pushTimer) clearTimeout(pushTimer);
	pushTimer = setTimeout(async () => {
		if (pushing) return;
		pushing = true;
		try {
			const cfg = await loadCloudConfig();
			if (cfg && cfg.autoPush) {
				const r = await syncNow(cfg);
				onDone?.(r);
			}
		} catch {} finally {
			pushing = false;
		}
	}, 5e3);
}
const MAX_RULES = 50;
const CONFIG_FILE = join(META_DIR, "config.json");
function cleanText(input, max = 120) {
	if (typeof input !== "string") return "";
	return input.trim().replace(/[\u0000-\u001f]/g, "").slice(0, max);
}
/** 目标目录净化：统一正斜杠、去掉头尾斜杠、拒绝 .. 与插件元数据目录。 */
function cleanDir(input) {
	if (typeof input !== "string") return "";
	const norm = input.replaceAll("\\", "/").trim().replace(/^\/+|\/+$/g, "");
	if (!norm) return "";
	const segs = norm.split("/");
	if (segs.some((s) => s === "" || s === "." || s === "..")) return "";
	if (segs[0] === ".dsh-library") return "";
	return segs.join("/");
}
function cleanDays(input) {
	const n = typeof input === "number" ? input : Number(input);
	if (!Number.isFinite(n)) return 7;
	return Math.min(365, Math.max(1, Math.round(n)));
}
/** 宽松收编外部输入（POST 也可以只带部分字段；磁盘上的旧结构 placement.rules 同样接受）。 */
function sanitizeConfig(input) {
	const raw = input ?? {};
	const list = Array.isArray(raw.rules) ? raw.rules : Array.isArray(raw.placement?.rules) ? raw.placement.rules : [];
	const rules = [];
	for (const item of list.slice(0, MAX_RULES)) {
		const r = item ?? {};
		const ws = cleanText(r.ws);
		const session = cleanText(r.session);
		const dir = cleanDir(r.dir);
		if (!dir || !ws && !session) continue;
		rules.push({
			...ws ? { ws } : {},
			...session ? { session } : {},
			dir
		});
	}
	return {
		placement: { rules },
		pinRetentionDays: cleanDays(raw.pinRetentionDays)
	};
}
async function loadConfig() {
	try {
		return sanitizeConfig(JSON.parse(await readFile$1(CONFIG_FILE, "utf8")));
	} catch {
		return sanitizeConfig({});
	}
}
async function saveConfig(input) {
	const cfg = sanitizeConfig(input);
	await mkdir(META_DIR, { recursive: true });
	await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
	return cfg;
}
/**
* 按规则决定新产物落点：会话前缀命中优先，其次工作区名命中，都没有则 inbox。
* 返回库内相对目录（已净化，可直接 join）。
*/
async function resolvePlacementDir(ctx) {
	const cfg = await loadConfig();
	const sessionId = ctx.sessionId && ctx.sessionId !== "未知会话" ? ctx.sessionId : "";
	const ws = (ctx.wsName || "").toLowerCase();
	for (const r of cfg.placement.rules) if (r.session && sessionId && sessionId.startsWith(r.session)) return r.dir;
	if (ws) {
		for (const r of cfg.placement.rules) if (r.ws && r.ws.toLowerCase() === ws) return r.dir;
	}
	return "inbox";
}
// src/interceptor.ts
/**
* 分级写入拦截器（需求文档 3.1 / 第 6 节）。
*
* 挂载 `tools/pre-execute`（waterfall）与 `tools/post-execute`：
* - 库内已有文件的修改 → deny + 记入持久化待确认队列；
* - 库内新文件 → allow（直落盘，这就是"啊哈时刻"）；
* - �外写入 → allow 原流程，post 阶段按规则归位一份副本到 inbox/。
*
* 拦截的是工具调用而非裸 fs 写入；Agent 用 Bash 落盘拦不到，
* 缓解策略见需求文档第 9 节。
*/
/** 常见写入类工具名（宿主 write/edit/create_file 系；可按宿主实际注册名扩展）。 */
const WRITE_TOOLS$1 = /* @__PURE__ */ new Set([
	"write",
	"edit",
	"create_file",
	"multi_edit",
	"str_replace_based_edit_tool"
]);
/** 常见读取类工具名：pin 固定修订引用的触发点（需求文档 3.3）。 */
const READ_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"read_file",
	"view",
	"cat",
	"open"
]);
/** 从宽松的工具参数里提取目标文件路径。 */
function extractPath$1(args) {
	for (const key of [
		"path",
		"file_path",
		"filePath",
		"target",
		"targetPath",
		"filename"
	]) if (typeof args[key] === "string" && args[key].length > 0) return args[key];
}
/** pre-execute 的裁决：读取类做 pin，修改类写入拦截，其余放行。 */
async function preExecute(exec) {
	const args = exec.arguments ?? {};
	const target = extractPath$1(args);
	if (!target) return { kind: "allow" };
	if (READ_TOOLS.has(exec.name)) {
		if (!isInsideLibrary(target)) return { kind: "allow" };
		const rel = relative(LIBRARY_ROOT, target).replaceAll("\\", "/");
		const outcome = await pinForRead(target, rel, sessionIdOf(exec.agent));
		if (!outcome) return { kind: "allow" };
		if (!outcome.drifted) return { kind: "allow" };
		return {
			kind: "deny",
			reason: `「${rel}」在你引用之后已被修改。本次读取按固定修订引用返回 pin 时刻的版本：\n\n${outcome.pin.content.length > 49152 ? outcome.pin.content.slice(0, 49152) + "\n…（固定版本内容过长已截断，完整内容在 .dsh-library/pins/）" : outcome.pin.content}\n\n如需基于最新内容工作，请提示用户在资料库面板「固定引用」中释放该文件的 pin 后重新读取。`
		};
	}
	if (!WRITE_TOOLS$1.has(exec.name)) return { kind: "allow" };
	if (!isInsideLibrary(target)) return { kind: "allow" };
	if (existsSync(target)) {
		const { content, summary } = extractContent(args);
		const change = await enqueue({
			tool: exec.name,
			targetPath: target,
			summary: summary || `(工具 ${exec.name} 的待确认修改)`,
			content
		});
		await appendArtifact({
			sessionId: sessionIdOf(exec.agent),
			tool: exec.name,
			libPath: target,
			kind: "pending"
		});
		return {
			kind: "deny",
			reason: `对资料库内已有文件的修改已进入待确认队列（id: ${change.id.slice(0, 8)}），不会直接覆盖原文件。用户接受后内容将写入；如需立即写入请提示用户在资料库面板确认。`
		};
	}
	return { kind: "allow" };
}
/** post-execute 的裁决：库外成功写入的文件，复制一份按归位规则落库。 */
async function postExecute(exec, failed) {
	if (failed || !WRITE_TOOLS$1.has(exec.name)) return;
	const target = extractPath$1(exec.arguments ?? {});
	if (!target || isInsideLibrary(target) || !existsSync(target)) return;
	try {
		if (!(await stat(target)).isFile()) return;
		const sessionId = sessionIdOf(exec.agent);
		const dest = await relocatedPath(await resolvePlacementDir({
			sessionId,
			wsName: (await resolveSessionMeta(sessionId).catch(() => null))?.wsName
		}).catch(() => "inbox"), basename(target));
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(target, dest);
		await appendArtifact({
			sessionId,
			tool: exec.name,
			libPath: relative(LIBRARY_ROOT, dest).replaceAll("\\", "/"),
			sourcePath: target,
			kind: "relocated"
		});
		scheduleAutoPush();
	} catch {}
}
/** 归位目标内的重名文件用时间戳后缀分开保存（wuzeno 的同名分存思路）。 */
async function relocatedPath(dir, filename) {
	const targetDir = dir || "inbox";
	const primary = inLibrary(join(targetDir, filename));
	try {
		await stat(primary);
	} catch {
		return primary;
	}
	const dot = filename.lastIndexOf(".");
	const stem = dot > 0 ? filename.slice(0, dot) : filename;
	const ext = dot > 0 ? filename.slice(dot) : "";
	return inLibrary(join(targetDir, `${stem}-${Date.now()}${ext}`));
}
/** 供 post-execute 判断失败与否（结果形状宽松匹配，失败才有 isError/error）。 */
function isFailure(result) {
	if (result == null || typeof result !== "object") return false;
	return "isError" in result && result.isError === true || "error" in result;
}
// src/artifactindex.ts
/**
* 会话产物索引：遍历 $DSH_HOME/sessions 下全部会话日志，
* 解析每个会话里 write/edit 类工具调用的目标文件路径，产出
* 「工作区 / 会话标题 / 产物文件」三级视图数据（本地产物的历史回填）。
*
* 性能：178+ 个会话、百 M 级 zstd，不能请求时同步扫——
* 后台增量扫描（按日志文件 mtime 复用缓存），结果持久化到
* .dsh-library/artifact-index.json；接口先返回已有缓存 + scanning 标记，
* 前端轮询补齐。
*/
const zstdDecompress = zlib.zstdDecompressSync;
const SESSIONS_ROOT = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
const INDEX_FILE = join(META_DIR, "artifact-index.json");
const ZSTD_MAGIC = Buffer.from("28b52ffd", "hex");
const STALE_MS = 6e4;
/** 缓存结构版本：解析规则变化时 +1，旧缓存作废重扫。 */
const INDEX_VERSION = 2;
const WRITE_TOOLS = /* @__PURE__ */ new Set([
	"write",
	"edit",
	"create_file",
	"multi_edit",
	"str_replace_based_edit_tool",
	"ops_write_file",
	"ops_edit_file"
]);
let data = {
	scannedAt: 0,
	sessions: {}
};
let loaded = false;
let scanning = false;
async function loadIndex() {
	if (loaded) return;
	loaded = true;
	try {
		const parsed = JSON.parse(await readFile$1(INDEX_FILE, "utf8"));
		if (parsed && typeof parsed === "object" && parsed.sessions && parsed.version === INDEX_VERSION) data = parsed;
	} catch {}
}
async function saveIndex() {
	try {
		await mkdir(META_DIR, { recursive: true });
		data.version = INDEX_VERSION;
		await writeFile(INDEX_FILE, JSON.stringify(data), "utf8");
	} catch {}
}
/** 与 interceptor 同款：从宽松的工具参数里提取目标文件路径。 */
function extractPath(args) {
	for (const key of [
		"path",
		"file_path",
		"filePath",
		"target",
		"targetPath",
		"filename",
		"outputPath",
		"output_path",
		"output"
	]) if (typeof args[key] === "string" && args[key].length > 0) return args[key];
}
/**
* 一次工具调用产出的文件路径。
* - present：Agent 主动「展示产物」，files[].path 就是交付给用户的文件（含脚本生成的表格）
* - write/edit 系：参数里的目标路径
*/
function producedPaths(name, args) {
	if (name === "present") return (Array.isArray(args.files) ? args.files : []).map((f) => f && typeof f === "object" && typeof f.path === "string" ? f.path : "").filter((p) => p.length > 0);
	const path = extractPath(args);
	return path ? [path] : [];
}
/** 解析单个会话日志：cwd（工作区）、最后的标题、全部写入调用。 */
function parseSession(sessionId, mtimeMs, buf) {
	if (!zstdDecompress) return null;
	const offsets = [0];
	for (let i = buf.indexOf(ZSTD_MAGIC, 4); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 4)) offsets.push(i);
	let cwd = "";
	let title = "";
	const writes = /* @__PURE__ */ new Map();
	for (let k = 0; k < offsets.length; k++) {
		const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
		let out;
		try {
			out = zstdDecompress(buf.subarray(offsets[k], end));
		} catch {
			continue;
		}
		for (const line of out.toString("utf8").split("\n")) {
			if (!line) continue;
			if (!cwd && line.startsWith("{\"type\":\"session\"")) {
				try {
					const meta = JSON.parse(line);
					if (typeof meta.cwd === "string") cwd = meta.cwd;
				} catch {}
				continue;
			}
			if (line.startsWith("{\"type\":\"session/title\"")) {
				try {
					const ev = JSON.parse(line);
					if (typeof ev.data?.title === "string" && ev.data.title) title = ev.data.title;
				} catch {}
				continue;
			}
			if (!line.startsWith("{\"type\":\"tool/call\"")) continue;
			try {
				const ev = JSON.parse(line);
				const name = ev.data?.name;
				if (!name || !WRITE_TOOLS.has(name) && name !== "present" || typeof ev.data?.arguments !== "string") continue;
				const args = JSON.parse(ev.data.arguments);
				const time = typeof ev.time === "number" ? ev.time : 0;
				for (const raw of producedPaths(name, args)) {
					const abs = (isAbsolute(raw) ? raw : resolve(cwd || ".", raw)).replaceAll("\\", "/");
					if (!/^[A-Za-z]:\//.test(abs) && !abs.startsWith("/")) continue;
					const prev = writes.get(abs);
					if (!prev || time >= prev.time) writes.set(abs, {
						path: abs,
						tool: name,
						time
					});
				}
			} catch {}
		}
	}
	if (!cwd && writes.size === 0) return null;
	return {
		sessionId,
		mtimeMs,
		cwd,
		title,
		writes: [...writes.values()]
	};
}
/** 收集全部会话日志文件路径。 */
async function listSessionFiles() {
	const out = [];
	let wsDirs;
	try {
		wsDirs = await readdir(SESSIONS_ROOT, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const wsDir of wsDirs) {
		if (!wsDir.isDirectory()) continue;
		let sessions;
		try {
			sessions = await readdir(join(SESSIONS_ROOT, wsDir.name), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const s of sessions) {
			if (!s.isDirectory()) continue;
			const file = join(SESSIONS_ROOT, wsDir.name, s.name, "session.v4.jsonl.zstd");
			out.push({
				file,
				sessionId: s.name
			});
		}
	}
	return out;
}
/** 后台增量扫描：mtime 不变的会话直接复用缓存。 */
async function scan() {
	if (scanning) return;
	scanning = true;
	try {
		await loadIndex();
		const files = await listSessionFiles();
		const alive = new Set(files.map((f) => f.file));
		for (const key of Object.keys(data.sessions)) if (!alive.has(key)) delete data.sessions[key];
		const todo = [];
		for (const f of files) {
			let mtimeMs;
			try {
				mtimeMs = (await stat(f.file)).mtimeMs;
			} catch {
				continue;
			}
			const cached = data.sessions[f.file];
			if (cached && cached.mtimeMs === mtimeMs) continue;
			todo.push({
				...f,
				mtimeMs
			});
		}
		const CONCURRENCY = 4;
		for (let i = 0; i < todo.length; i += CONCURRENCY) await Promise.all(todo.slice(i, i + CONCURRENCY).map(async (t) => {
			try {
				const parsed = parseSession(t.sessionId, t.mtimeMs, await readFile$1(t.file));
				if (parsed) data.sessions[t.file] = parsed;
			} catch {}
		}));
		data.scannedAt = Date.now();
		await saveIndex();
	} finally {
		scanning = false;
	}
}
/**
* cwd → 展示用工作区名。主目录（没选工作区直接启动的会话）不叫
* 用户名目录，显示为「主目录」，与 DSH 侧的认知对齐。
*/
function wsNameOf(cwd) {
	if (!cwd) return "";
	const norm = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
	if (norm.toLowerCase() === homedir().replaceAll("\\", "/").toLowerCase()) return "主目录";
	return basename(norm);
}
/**
* 取当前派生产物（缓存视图）；缓存过期时踢后台扫描，不阻塞返回。
* entries 不做存在性过滤——调用方按需 stat。
*/
async function getDerivedArtifacts() {
	await loadIndex();
	if (!scanning && Date.now() - data.scannedAt > STALE_MS) scan();
	const entries = [];
	for (const s of Object.values(data.sessions)) {
		const ws = wsNameOf(s.cwd);
		for (const w of s.writes) entries.push({
			sessionId: s.sessionId,
			ws,
			title: s.title,
			tool: w.tool,
			sourcePath: w.path,
			time: w.time ? new Date(w.time).toISOString() : ""
		});
	}
	return {
		entries,
		scanning
	};
}
const DAY_MS = 864e5;
/** 回收站文件名形如 <url编码路径>.<删除时间戳>.trash；解析不出时间戳时退回 mtime。 */
async function cleanupTrash(now = Date.now()) {
	if (!existsSync(TRASH_DIR)) return 0;
	let removed = 0;
	let files = [];
	try {
		files = (await readdir(TRASH_DIR)).filter((f) => f.endsWith(".trash"));
	} catch {
		return 0;
	}
	for (const f of files) {
		const p = join(TRASH_DIR, f);
		const base = f.slice(0, -6);
		const ts = Number(base.slice(base.lastIndexOf(".") + 1));
		let deletedAt = Number.isFinite(ts) && ts > 0 ? ts : 0;
		if (!deletedAt) try {
			deletedAt = (await stat(p)).mtimeMs;
		} catch {
			continue;
		}
		if (now - deletedAt <= 30 * DAY_MS) continue;
		try {
			await rm(p, {
				recursive: true,
				force: true
			});
			removed++;
		} catch {}
	}
	return removed;
}
async function runMaintenance() {
	const cfg = await loadConfig().catch(() => null);
	let pins = 0;
	let trash = 0;
	try {
		pins = await cleanupPins(cfg?.pinRetentionDays ?? 7);
	} catch {}
	try {
		trash = await cleanupTrash();
	} catch {}
	return {
		pins,
		trash
	};
}
// src/routes.ts
/**
* dsh-wb-desk host 半 HTTP 路由：/dsh-wb-desk/*（同源）。
*
* 挂载方式对齐 dsh-doclib 的 webServer.prefix 模式（2026-11-18 已验证其可用）。
* 提供资料库面板所需的最小数据面：
*   GET  /tree              递归目录树（跳过 .dsh-library）
*   GET  /file?path=rel     读文本文件内容（限文本后缀与大小）
*   GET  /pending           待确认队列
*   POST /pending/resolve   接受/拒绝一条待确认修改
*   GET  /root              库根绝对路径
*/
/** 页面内可预览的文本后缀；其余一律提示不支持预览（防二进制塞爆响应）。 */
const TEXT_EXT = /* @__PURE__ */ new Set([
	".md",
	".txt",
	".json",
	".csv",
	".html",
	".htm",
	".js",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".jsx",
	".css",
	".yml",
	".yaml",
	".toml",
	".xml",
	".svg",
	".py",
	".rs",
	".go",
	".java",
	".sh",
	".ps1",
	".bat",
	".log",
	".ini",
	".sql",
	".vue"
]);
const MAX_PREVIEW_BYTES = 524288;
/** 最小合法 Office 模板（stored zip）：新建 .docx/.xlsx/.pptx 时落盘为可打开的空文件。 */
const OFFICE_TEMPLATES = {
	docx: "UEsDBBQAAAAAAAAAAAB5bjPXrQEAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3dvcmQvZG9jdW1lbnQueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWwiLz48L1R5cGVzPlBLAwQUAAAAAAAAAAAAm/036ikBAAApAQAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAAACZCVxZrgAAAK4AAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pjx3OnAvPjwvdzpib2R5Pjwvdzpkb2N1bWVudD5QSwECFAAUAAAAAAAAAAAAeW4z160BAACtAQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAAAAAAAACb/TfqKQEAACkBAAALAAAAAAAAAAAAAAAAAN4BAABfcmVscy8ucmVsc1BLAQIUABQAAAAAAAAAAACZCVxZrgAAAK4AAAARAAAAAAAAAAAAAAAAADADAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAAANBAAAAAA=",
	xlsx: "UEsDBBQAAAAAAAAAAABuYbgNLQIAAC0CAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtib29rLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnNoZWV0Lm1haW4reG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvd29ya3NoZWV0cy9zaGVldDEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnNwcmVhZHNoZWV0bWwud29ya3NoZWV0K3htbCIvPjwvVHlwZXM+UEsDBBQAAAAAAAAAAACY2uuLJwEAACcBAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ4bC93b3JrYm9vay54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAAACdbEO9GwEAABsBAAAPAAAAeGwvd29ya2Jvb2sueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pjx3b3JrYm9vayB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIiB4bWxuczpyPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzIj48c2hlZXRzPjxzaGVldCBuYW1lPSJTaGVldDEiIHNoZWV0SWQ9IjEiIHI6aWQ9InJJZDEiLz48L3NoZWV0cz48L3dvcmtib29rPlBLAwQUAAAAAAAAAAAAWv2CaygBAAAoAQAAGgAAAHhsL19yZWxzL3dvcmtib29rLnhtbC5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvd29ya3NoZWV0IiBUYXJnZXQ9IndvcmtzaGVldHMvc2hlZXQxLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAAJ6MqE6cAAAAnAAAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PHdvcmtzaGVldCB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIj48c2hlZXREYXRhLz48L3dvcmtzaGVldD5QSwECFAAUAAAAAAAAAAAAbmG4DS0CAAAtAgAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUABQAAAAAAAAAAACY2uuLJwEAACcBAAALAAAAAAAAAAAAAAAAAF4CAABfcmVscy8ucmVsc1BLAQIUABQAAAAAAAAAAACdbEO9GwEAABsBAAAPAAAAAAAAAAAAAAAAAK4DAAB4bC93b3JrYm9vay54bWxQSwECFAAUAAAAAAAAAAAAWv2CaygBAAAoAQAAGgAAAAAAAAAAAAAAAAD2BAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECFAAUAAAAAAAAAAAAnoyoTpwAAACcAAAAGAAAAAAAAAAAAAAAAABWBgAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsFBgAAAAAFAAUARQEAACgHAAAAAA==",
	pptx: "UEsDBBQAAAAAAAAAAACe0ypcsgEAALIBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3BwdC9wcmVzZW50YXRpb24ueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnByZXNlbnRhdGlvbm1sLnByZXNlbnRhdGlvbi5tYWluK3htbCIvPjwvVHlwZXM+UEsDBBQAAAAAAAAAAAAbyrjuLAEAACwBAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJwcHQvcHJlc2VudGF0aW9uLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAAB9BM7yqAAAAqgAAABQAAABwcHQvcHJlc2VudGF0aW9uLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48cDpwcmVzZW50YXRpb24geG1sbnM6cD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3ByZXNlbnRhdGlvbm1sLzIwMDYvbWFpbiI+PHA6c2xkSWRMc3QvPjwvcDpwcmVzZW50YXRpb24+UEsDBBQAAAAAAAAAAADp+cGTmwAAAJsAAAAfAAAAcHB0L19yZWxzL3ByZXNlbnRhdGlvbi54bWwucmVsczw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48L1JlbGF0aW9uc2hpcHM+UEsBAhQAFAAAAAAAAAAAAJ7TKlyyAQAAsgEAABMAAAAAAAAAAAAAAAAAAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAAUAAAAAAAAAAAAG8q47iwBAAAsAQAACwAAAAAAAAAAAAAAAADjAQAAX3JlbHMvLnJlbHNQSwECFAAUAAAAAAAAAAAAH0EzvKoAAACqAAAAFAAAAAAAAAAAAAAAAAA4AwAAcHB0L3ByZXNlbnRhdGlvbi54bWxQSwECFAAUAAAAAAAAAAAA6fnBk5sAAACbAAAAHwAAAAAAAAAAAAAAAAAUBAAAcHB0L19yZWxzL3ByZXNlbnRhdGlvbi54bWwucmVsc1BLBQYAAAAABAAEAAkBAADsBAAAAAA="
};
function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}
/** 只接受同源请求（对齐 doclib）。 */
function sameOrigin(req) {
	const origin = req.headers.origin;
	if (typeof origin !== "string" || origin === "") return true;
	const host = req.headers.host;
	if (typeof host !== "string") return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
async function readBody(req, limitBytes = 65536) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limitBytes) throw new Error("请求体超限");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** 库内相对路径 → 绝对路径；拒绝 .. 与绝对路径注入。 */
function safeJoin(relative) {
	const abs = resolve(LIBRARY_ROOT, "." + sep + relative);
	if (!abs.startsWith(LIBRARY_ROOT.endsWith(sep) ? LIBRARY_ROOT : LIBRARY_ROOT + sep)) throw new Error("非法路径");
	return abs;
}
/** 全文检索：递归扫库内文本文件，命中行按顺序返回（上限 50 条）。 */
async function searchAll(query) {
	const hits = [];
	const needle = query.toLowerCase();
	async function walk(dir, rel) {
		if (hits.length >= 50) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (rel === "" && entry.name === "inbox") continue;
			const abs = join(dir, entry.name);
			const relPath = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(abs, relPath);
				if (hits.length >= 50) return;
				continue;
			}
			if (!TEXT_EXT.has(extname(abs).toLowerCase())) continue;
			let text;
			try {
				text = await readFile$1(abs, "utf8");
			} catch {
				continue;
			}
			const lines = text.split("\n");
			for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(needle)) {
				hits.push({
					path: relPath,
					lineNo: i + 1,
					line: lines[i].trim().slice(0, 200)
				});
				if (hits.length >= 50) return;
			}
		}
	}
	await walk(LIBRARY_ROOT, "");
	return hits;
}
async function buildTree(absDir, relDir, depth) {
	const entries = await readdir(absDir, { withFileTypes: true });
	const out = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
		let meta = {};
		try {
			const st = await stat(join(absDir, entry.name));
			meta = {
				size: entry.isFile() ? st.size : void 0,
				mtime: st.mtimeMs
			};
		} catch {}
		if (entry.isDirectory()) {
			const node = {
				name: entry.name,
				path: rel,
				kind: "directory",
				...meta
			};
			if (depth > 0) node.children = await buildTree(join(absDir, entry.name), rel, depth - 1);
			out.push(node);
		} else if (entry.isFile()) out.push({
			name: entry.name,
			path: rel,
			kind: "file",
			...meta
		});
	}
	out.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, "zh") : a.kind === "directory" ? -1 : 1);
	return out;
}
/** 绝对路径是否为「会话日志里出现过的产物」（/read-abs、上传、分享共用的白名单）。 */
async function artifactAllowed(absPath) {
	const norm = absPath.replaceAll("\\", "/").toLowerCase();
	const { entries } = await getDerivedArtifacts();
	if (entries.some((e) => e.sourcePath.toLowerCase() === norm)) return true;
	return (await readArtifacts()).some((i) => typeof i.sourcePath === "string" && i.sourcePath.replaceAll("\\", "/").toLowerCase() === norm);
}
/**
* 解析上传目标：库内路径校验后原样返回（统一 / 分隔）；
* 会话产物（abs=true）先复制进库根（同名加序号不覆盖），返回库内相对路径。
*/
async function resolveUploadTarget(rawPath, abs) {
	if (typeof rawPath !== "string" || rawPath.trim() === "") throw new Error("参数错误");
	if (!abs) {
		const absPath = safeJoin(rawPath);
		if (!existsSync(absPath)) throw new Error("文件不存在");
		if (!statSync(absPath).isFile()) throw new Error("只能上传单个文件");
		return rawPath.replaceAll("\\", "/").replace(/^\/+/, "");
	}
	const src = rawPath.replaceAll("\\", "/");
	if (!await artifactAllowed(src)) throw new Error("路径不在会话产物白名单内");
	if (!existsSync(src)) throw new Error("源文件不存在，可能已被删除");
	const name = basename(src);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	let rel = name;
	for (let n = 1; existsSync(safeJoin(rel)); n++) {
		if (n > 500) throw new Error("同名文件过多");
		rel = `${stem}-${n}${ext}`;
	}
	await copyFile(src, safeJoin(rel));
	scheduleAutoPush();
	return rel;
}
/** 注册 /dsh-wb-desk/* 路由（webServer 存在时）。 */
function registerRoutes(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: "/dsh-wb-desk",
		handler: async (req, res) => {
			try {
				if (!sameOrigin(req)) {
					sendJson(res, 403, { error: "跨站请求已拒绝" });
					return;
				}
				const url = new URL(req.url || "/", "http://x");
				const route = url.pathname.replace(/^\/dsh-wb-desk/, "") || "/";
				if (route === "/root" && req.method === "GET") {
					sendJson(res, 200, { root: LIBRARY_ROOT });
					return;
				}
				if (route === "/config" && req.method === "GET") {
					sendJson(res, 200, await loadConfig());
					return;
				}
				if (route === "/config" && req.method === "POST") {
					const cfg = await saveConfig(JSON.parse(await readBody(req)));
					const maintenance = await runMaintenance().catch(() => ({
						pins: 0,
						trash: 0
					}));
					sendJson(res, 200, {
						ok: true,
						...cfg,
						maintenance
					});
					return;
				}
				if (route === "/tree" && req.method === "GET") {
					if (!existsSync(LIBRARY_ROOT)) {
						sendJson(res, 200, { items: [] });
						return;
					}
					sendJson(res, 200, { items: (await buildTree(LIBRARY_ROOT, "", 8)).filter((e) => e.name !== "inbox") });
					return;
				}
				if (route === "/metas" && req.method === "GET") {
					if (!existsSync(LIBRARY_ROOT)) {
						sendJson(res, 200, { items: {} });
						return;
					}
					const flat = {};
					const walk = (nodes) => {
						for (const n of nodes) {
							flat[n.path] = {
								size: n.size,
								mtime: n.mtime
							};
							if (n.children) walk(n.children);
						}
					};
					walk(await buildTree(LIBRARY_ROOT, "", 8));
					sendJson(res, 200, { items: flat });
					return;
				}
				if (route === "/search" && req.method === "GET") {
					const q = (url.searchParams.get("q") || "").trim();
					if (q === "") {
						sendJson(res, 200, { hits: [] });
						return;
					}
					if (!existsSync(LIBRARY_ROOT)) {
						sendJson(res, 200, { hits: [] });
						return;
					}
					sendJson(res, 200, { hits: await searchAll(q) });
					return;
				}
				if (route === "/file" && (req.method === "PUT" || req.method === "POST")) {
					const body = JSON.parse(await readBody(req, MAX_PREVIEW_BYTES));
					if (typeof body.path !== "string" || typeof body.content !== "string") {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					const abs = safeJoin(body.path);
					if (!TEXT_EXT.has(extname(abs).toLowerCase())) {
						sendJson(res, 400, { error: "这个文件不支持在页面里编辑" });
						return;
					}
					await writeFile(abs, body.content, "utf8");
					scheduleAutoPush();
					sendJson(res, 200, { ok: true });
					return;
				}
				if (route === "/file" && req.method === "GET") {
					const rel = url.searchParams.get("path") || "";
					const abs = safeJoin(rel);
					if (!existsSync(abs)) {
						sendJson(res, 404, { error: "文件不存在" });
						return;
					}
					if (!TEXT_EXT.has(extname(abs).toLowerCase())) {
						sendJson(res, 200, {
							path: rel,
							kind: "binary",
							text: null
						});
						return;
					}
					if ((await (await import("node:fs/promises")).stat(abs)).size > MAX_PREVIEW_BYTES) {
						sendJson(res, 200, {
							path: rel,
							kind: "too-large",
							text: null
						});
						return;
					}
					sendJson(res, 200, {
						path: rel,
						kind: "text",
						text: await readFile$1(abs, "utf8")
					});
					return;
				}
				if (route === "/pending" && req.method === "GET") {
					sendJson(res, 200, { items: await listPending() });
					return;
				}
				if (route === "/artifacts" && req.method === "GET") {
					const items = await readArtifacts();
					const metas = /* @__PURE__ */ new Map();
					for (const item of items) if (!metas.has(item.sessionId)) metas.set(item.sessionId, await resolveSessionMeta(item.sessionId));
					const ledgerPaths = new Set(items.filter((i) => i.sourcePath).map((i) => `${i.sessionId}|${i.sourcePath.replaceAll("\\", "/").toLowerCase()}`));
					const enriched = items.map((item) => {
						const meta = metas.get(item.sessionId);
						let st;
						try {
							st = statSync(join(LIBRARY_ROOT, item.libPath));
						} catch {
							st = void 0;
						}
						if (!st && typeof item.sourcePath === "string") try {
							st = statSync(item.sourcePath);
						} catch {
							st = void 0;
						}
						return {
							...item,
							ws: meta?.wsName || void 0,
							title: meta?.title || void 0,
							size: st?.isFile() ? st.size : void 0,
							mtime: st?.mtimeMs
						};
					});
					const { entries, scanning } = await getDerivedArtifacts();
					const derived = [];
					for (const e of entries) {
						const normKey = `${e.sessionId}|${e.sourcePath.toLowerCase()}`;
						if (ledgerPaths.has(normKey)) continue;
						let st;
						try {
							st = statSync(e.sourcePath);
						} catch {
							continue;
						}
						if (!st.isFile()) continue;
						derived.push({
							...e,
							kind: "session-file",
							size: st.size,
							mtime: st.mtimeMs
						});
					}
					sendJson(res, 200, {
						items: [...enriched, ...derived],
						scanning
					});
					return;
				}
				if (route === "/read-abs" && req.method === "GET") {
					const p = (url.searchParams.get("path") || "").replaceAll("\\", "/");
					if (!p || !await artifactAllowed(p)) {
						sendJson(res, 403, { error: "路径不在会话产物白名单内" });
						return;
					}
					if (!TEXT_EXT.has(extname(p).toLowerCase())) {
						sendJson(res, 200, {
							path: p,
							kind: "binary",
							text: null
						});
						return;
					}
					let st;
					try {
						st = await stat(p);
					} catch {
						sendJson(res, 404, { error: "文件不存在" });
						return;
					}
					if (st.size > MAX_PREVIEW_BYTES) {
						sendJson(res, 200, {
							path: p,
							kind: "too-large",
							text: null
						});
						return;
					}
					sendJson(res, 200, {
						path: p,
						kind: "text",
						text: await readFile$1(p, "utf8")
					});
					return;
				}
				if (route === "/open" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					const p = String(body.path || "");
					const wantFolder = body.action === "folder";
					let abs;
					if (body.abs) {
						if (!p || !await artifactAllowed(p)) {
							sendJson(res, 403, { error: "路径不在会话产物白名单内" });
							return;
						}
						abs = p;
					} else try {
						abs = safeJoin(p);
					} catch {
						sendJson(res, 400, { error: "非法路径" });
						return;
					}
					if (!existsSync(abs)) {
						sendJson(res, 404, { error: "文件不存在，可能已被移动或删除" });
						return;
					}
					const { spawn } = await import("node:child_process");
					const isDir = statSync(abs).isDirectory();
					const win = process.platform === "win32";
					const cmd = win ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
					const target = win ? abs.replaceAll("/", "\\") : abs;
					const args = wantFolder && !isDir ? win ? ["/select,", target] : [dirname(abs)] : [target];
					try {
						spawn(cmd, args, {
							detached: true,
							stdio: "ignore"
						}).unref();
					} catch {
						sendJson(res, 500, { error: "无法调起系统应用" });
						return;
					}
					sendJson(res, 200, { ok: true });
					return;
				}
				if (route === "/pins" && req.method === "GET") {
					sendJson(res, 200, { items: await listActivePins() });
					return;
				}
				if (route === "/pins/release" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					if (typeof body.path !== "string" || body.path === "") {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					if (!await releasePin(body.path)) {
						sendJson(res, 404, { error: "该文件没有生效的固定引用" });
						return;
					}
					sendJson(res, 200, {
						ok: true,
						items: await listActivePins()
					});
					return;
				}
				if (route === "/pending/resolve" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					if (typeof body.id !== "string" || body.action !== "accept" && body.action !== "reject") {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					if (!await resolvePending(body.id, body.action)) {
						sendJson(res, 404, { error: "没有找到这条待确认修改" });
						return;
					}
					sendJson(res, 200, {
						ok: true,
						items: await listPending()
					});
					return;
				}
				if (route === "/mkdir" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					if (typeof body.path !== "string" || body.path.trim() === "") {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					await mkdir(safeJoin(body.path), { recursive: true });
					scheduleAutoPush();
					sendJson(res, 200, { ok: true });
					return;
				}
				if (route === "/newfile" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					const dir = body.dir && body.dir.trim() !== "" ? body.dir : "";
					const officeExt = body.type === "docx" || body.type === "xlsx" || body.type === "pptx" ? body.type : null;
					const isCsv = body.type === "csv";
					const isHtml = body.type === "html";
					const stem = officeExt ? {
						docx: "未命名文档",
						xlsx: "未命名表格",
						pptx: "未命名演示"
					}[officeExt] : isCsv ? "未命名表格" : isHtml ? "未命名网页" : "未命名文档";
					const ext = officeExt ? "." + officeExt : isCsv ? ".csv" : isHtml ? ".html" : ".md";
					let rel = "";
					let n = 1;
					for (;;) {
						const candidate = join(dir, n === 1 ? stem + ext : `${stem}-${n}${ext}`);
						if (!existsSync(safeJoin(candidate))) {
							rel = candidate;
							break;
						}
						n++;
						if (n > 500) {
							sendJson(res, 400, { error: "同名文件过多" });
							return;
						}
					}
					await mkdir(dirname(safeJoin(rel)), { recursive: true });
					if (officeExt) await writeFile(safeJoin(rel), Buffer.from(OFFICE_TEMPLATES[officeExt], "base64"));
					else {
						const template = isCsv ? "名称,数值\n示例,1\n" : isHtml ? "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"><title>未命名网页</title></head>\n<body>\n  <h1>未命名网页</h1>\n</body>\n</html>\n" : "# 未命名文档\n\n";
						await writeFile(safeJoin(rel), template, "utf8");
					}
					scheduleAutoPush();
					sendJson(res, 200, {
						ok: true,
						path: rel.replaceAll("\\", "/")
					});
					return;
				}
				if (route === "/upload" && req.method === "POST") {
					const body = JSON.parse(await readBody(req, 67108864));
					if (typeof body.name !== "string" || body.name.trim() === "" || typeof body.base64 !== "string") {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					if (body.name.includes("..")) {
						sendJson(res, 400, { error: "非法文件名" });
						return;
					}
					const dir = body.dir && body.dir.trim() !== "" ? body.dir : "";
					const segs = body.name.split("/").map((s) => s.replace(/[\\/:*?"<>|]/g, "_")).filter((s) => s && s !== "." && s !== "..");
					if (segs.length === 0) {
						sendJson(res, 400, { error: "非法文件名" });
						return;
					}
					const last = segs[segs.length - 1];
					const dot = last.lastIndexOf(".");
					const stemN = dot > 0 ? last.slice(0, dot) : last;
					const extN = dot > 0 ? last.slice(dot) : "";
					let rel = "";
					let n = 1;
					for (;;) {
						const candidate = join(dir, ...segs.slice(0, -1), n === 1 ? last : `${stemN}-${n}${extN}`);
						if (!existsSync(safeJoin(candidate))) {
							rel = candidate;
							break;
						}
						n++;
						if (n > 500) {
							sendJson(res, 400, { error: "同名文件过多" });
							return;
						}
					}
					const abs = safeJoin(rel);
					await mkdir(dirname(abs), { recursive: true });
					await writeFile(abs, Buffer.from(body.base64, "base64"));
					scheduleAutoPush();
					sendJson(res, 200, {
						ok: true,
						path: rel.replaceAll("\\", "/")
					});
					return;
				}
				if (route === "/rename" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					if (typeof body.path !== "string" || typeof body.name !== "string" || body.name.trim() === "" || /[\\/:*?"<>|]/.test(body.name)) {
						sendJson(res, 400, { error: "名称为空或包含不允许的符号" });
						return;
					}
					const from = safeJoin(body.path);
					if (!existsSync(from)) {
						sendJson(res, 404, { error: "文件或文件夹不存在" });
						return;
					}
					const newRel = join(dirname(body.path), body.name.trim());
					await rename(from, safeJoin(newRel));
					sendJson(res, 200, {
						ok: true,
						path: newRel
					});
					return;
				}
				if (route === "/delete" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					if (typeof body.path !== "string" || body.path.trim() === "") {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					const from = safeJoin(body.path);
					if (!existsSync(from)) {
						sendJson(res, 404, { error: "文件或文件夹不存在" });
						return;
					}
					await mkdir(TRASH_DIR, { recursive: true });
					const trashName = body.path.replaceAll("\\", "/").replaceAll("/", "%2F") + "." + Date.now() + ".trash";
					await rename(from, join(TRASH_DIR, trashName));
					scheduleAutoPush();
					sendJson(res, 200, { ok: true });
					return;
				}
				if (route === "/trash" && req.method === "GET") {
					if (!existsSync(TRASH_DIR)) {
						sendJson(res, 200, { items: [] });
						return;
					}
					const raw = (await readdir(TRASH_DIR)).filter((f) => f.endsWith(".trash"));
					const items = await Promise.all(raw.map(async (f) => {
						const base = f.slice(0, -6);
						const dot = base.lastIndexOf(".");
						const originalPath = base.slice(0, dot).replaceAll("%2F", "/");
						const deletedAt = Number(base.slice(dot + 1)) || 0;
						let kind = "file";
						let size;
						try {
							const st = statSync(join(TRASH_DIR, f));
							kind = st.isDirectory() ? "directory" : "file";
							if (kind === "file") size = st.size;
						} catch {}
						return {
							name: f,
							originalPath,
							deletedAt,
							kind,
							size
						};
					}));
					items.sort((a, b) => b.deletedAt - a.deletedAt);
					sendJson(res, 200, { items });
					return;
				}
				if (route === "/trash-restore" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					const single = typeof body.name === "string" && !Array.isArray(body.names);
					const raw = Array.isArray(body.names) ? body.names : single ? [body.name] : [];
					const names = raw.filter((n) => typeof n === "string" && n.endsWith(".trash") && basename(n) === n);
					if (raw.length === 0 || names.length !== raw.length) {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					let ok = 0;
					const failed = [];
					for (const name of names) try {
						const trashFile = join(TRASH_DIR, name);
						if (!existsSync(trashFile)) {
							failed.push({
								name,
								error: "回收站里没有这个文件",
								status: 404
							});
							continue;
						}
						const base = basename(name, ".trash");
						const dot = base.lastIndexOf(".");
						const dest = safeJoin((dot > 0 ? base.slice(0, dot) : base).replaceAll("%2F", "/"));
						if (existsSync(dest)) {
							failed.push({
								name,
								error: "原位置已有同名文件，请先改名或移走后再恢复",
								status: 409
							});
							continue;
						}
						await mkdir(dirname(dest), { recursive: true });
						await rename(trashFile, dest);
						ok++;
					} catch (e) {
						failed.push({
							name,
							error: e.message || "恢复失败",
							status: 500
						});
					}
					if (single) {
						const f = failed[0];
						if (f) {
							sendJson(res, f.status, { error: f.error });
							return;
						}
						scheduleAutoPush();
						sendJson(res, 200, { ok: true });
						return;
					}
					if (ok > 0) scheduleAutoPush();
					sendJson(res, 200, {
						ok,
						failed: failed.map((f) => ({
							name: f.name,
							error: f.error
						}))
					});
					return;
				}
				if (route === "/trash-purge" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					const single = typeof body.name === "string" && !Array.isArray(body.names);
					const raw = Array.isArray(body.names) ? body.names : single ? [body.name] : [];
					const names = raw.filter((n) => typeof n === "string" && n.endsWith(".trash") && basename(n) === n);
					if (raw.length === 0 || names.length !== raw.length) {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					let ok = 0;
					const failed = [];
					for (const name of names) try {
						const target = join(TRASH_DIR, name);
						if (!existsSync(target)) {
							failed.push({
								name,
								error: "回收站里没有这个文件",
								status: 404
							});
							continue;
						}
						await rm(target, {
							recursive: true,
							force: true
						});
						ok++;
					} catch (e) {
						failed.push({
							name,
							error: e.message || "删除失败",
							status: 500
						});
					}
					if (single) {
						const f = failed[0];
						if (f) {
							sendJson(res, f.status, { error: f.error });
							return;
						}
						sendJson(res, 200, { ok: true });
						return;
					}
					sendJson(res, 200, {
						ok,
						failed: failed.map((f) => ({
							name: f.name,
							error: f.error
						}))
					});
					return;
				}
				if (route === "/move" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					if (typeof body.path !== "string" || typeof body.targetDir !== "string") {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					const from = safeJoin(body.path);
					if (!existsSync(from)) {
						sendJson(res, 404, { error: "文件或文件夹不存在" });
						return;
					}
					const name = basename(body.path);
					const destDir = body.targetDir === "" ? LIBRARY_ROOT : safeJoin(body.targetDir);
					if (!existsSync(destDir)) {
						sendJson(res, 404, { error: "目标文件夹不存在" });
						return;
					}
					let dest = join(destDir, name);
					if (dest !== from) {
						let n = 1;
						while (existsSync(dest)) {
							const dot = name.lastIndexOf(".");
							const stem = dot > 0 ? name.slice(0, dot) : name;
							const ext = dot > 0 ? name.slice(dot) : "";
							dest = join(destDir, `${stem}-${n}${ext}`);
							n++;
						}
						await rename(from, dest);
					}
					sendJson(res, 200, {
						ok: true,
						path: relative(LIBRARY_ROOT, dest).replaceAll("\\", "/")
					});
					return;
				}
				if (route === "/cloud/config" && req.method === "GET") {
					const cfg = await loadCloudConfig();
					if (!cfg) {
						sendJson(res, 200, { configured: false });
						return;
					}
					sendJson(res, 200, {
						configured: true,
						config: {
							...cfg,
							accessKey: cfg.accessKey,
							secretKey: "__keep__"
						}
					});
					return;
				}
				if (route === "/cloud/config" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					if (body.protocol !== "s3" && body.protocol !== "webdav" && body.protocol !== "cos") {
						sendJson(res, 400, { error: "协议只支持 s3 / cos / webdav" });
						return;
					}
					if (typeof body.endpoint !== "string" || !/^https?:\/\//.test(body.endpoint)) {
						sendJson(res, 400, { error: "地址要以 http(s):// 开头" });
						return;
					}
					const old = await loadCloudConfig();
					const cfg = {
						protocol: body.protocol,
						endpoint: body.endpoint,
						bucket: body.bucket || void 0,
						prefix: body.prefix || void 0,
						region: body.region || void 0,
						accessKey: typeof body.accessKey === "string" ? body.accessKey : old?.accessKey ?? "",
						secretKey: body.secretKey === "__keep__" || body.secretKey === void 0 ? old?.secretKey ?? "" : body.secretKey,
						autoPush: !!body.autoPush,
						pathStyle: !!body.pathStyle
					};
					if (!cfg.accessKey) {
						sendJson(res, 400, { error: "访问账号不能为空" });
						return;
					}
					await saveCloudConfig(cfg);
					scheduleAutoPush();
					sendJson(res, 200, { ok: true });
					return;
				}
				if (route === "/cloud/test" && req.method === "POST") {
					const cfg = await loadCloudConfig();
					if (!cfg) {
						sendJson(res, 400, { error: "还没配置云同步" });
						return;
					}
					sendJson(res, 200, await testCloud(cfg));
					return;
				}
				if (route === "/cloud/sync" && req.method === "POST") {
					const cfg = await loadCloudConfig();
					if (!cfg) {
						sendJson(res, 400, { error: "还没配置云同步" });
						return;
					}
					sendJson(res, 200, await syncNow(cfg));
					return;
				}
				if (route === "/cloud/push" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					const cfg = await loadCloudConfig();
					if (!cfg) {
						sendJson(res, 400, { error: "还没配置云同步，请先打开「云同步」填写 COS 信息" });
						return;
					}
					const relKey = await resolveUploadTarget(body.path, body.abs === true);
					await pushFile(cfg, relKey);
					sendJson(res, 200, {
						ok: true,
						path: relKey
					});
					return;
				}
				if (route === "/share" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					const cfg = await loadCloudConfig();
					if (!cfg) {
						sendJson(res, 400, { error: "还没配置云同步，请先打开「云同步」填写 COS 信息" });
						return;
					}
					const relKey = await resolveUploadTarget(body.path, body.abs === true);
					await pushFile(cfg, relKey);
					sendJson(res, 200, {
						ok: true,
						url: presignCosGet(cfg, relKey, 604800),
						expiresDays: 7
					});
					return;
				}
				res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "unknown route" }));
			} catch (error) {
				sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}
	}), "dsh-wb-desk: routes");
}
// src/index.ts
/**
* dsh-wb-desk host 半。
*
* 挂载点（需求文档第 6 节，2026-11-18 已对宿主 0.2.2-rc.3 源码验证）：
* - `tools/pre-execute`（waterfall）：写入分级裁决——库内修改转待确认，其余放行
* - `tools/post-execute`：库外产出归位副本到 inbox/
*
* 启动即初始化库目录（原地收编，不覆盖已有内容）。
*/
/** cordis 插件身份；inject 声明依赖 tools 服务，缺失时插件不挂载。 */
const name = "dsh-wb-desk";
const inject = ["tools"];
/** 定期维护间隔：回收站过期条目与 pin 快照。 */
const MAINTENANCE_INTERVAL_MS = 216e5;
async function apply(ctx) {
	await initLibrary();
	runMaintenance().catch(() => {});
	if (typeof ctx.effect === "function") ctx.effect(() => {
		const timer = setInterval(() => {
			runMaintenance().catch(() => {});
		}, MAINTENANCE_INTERVAL_MS);
		timer.unref?.();
		return () => clearInterval(timer);
	});
	if (typeof ctx.inject === "function") ctx.inject(["webServer"], (webCtx) => registerRoutes(webCtx));
	ctx.on("tools/pre-execute", async (exec, next) => {
		const decision = await preExecute(exec);
		if (decision.kind === "deny") return {
			kind: "deny",
			reason: decision.reason
		};
		return next();
	});
	ctx.on("tools/post-execute", async (exec, result, next) => {
		const accepted = await next();
		try {
			await postExecute(exec, isFailure(result));
		} catch {}
		return accepted;
	});
}
export { apply, inject, name };
