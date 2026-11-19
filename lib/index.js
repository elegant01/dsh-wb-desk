import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { appendFile, copyFile, mkdir, readFile as readFile$1, readdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash, createHmac, randomUUID } from "node:crypto";
// src/store.ts
/**
* dsh-wb-desk 存储层：文件本体直存，元数据收在 .dsh-library/ 隐藏目录。
*
* 布局（对应需求文档 3.4 / 第 6 节）：
*   $DSH_HOME/library/            库根（可配置覆盖）
*     inbox/                      Agent 自动归位的默认落点
*     projects/                   按项目手工归档
*     archive/                    归档区
*     .dsh-library/               插件元数据（不与用户文件混放）
*       pending/                  待确认队列（持久化，崩溃不丢）
*       pins/                     固定修订引用快照
*
* 初始化"原地收编"：只补建缺失目录，绝不移动/改写已有文件。
*/
/** 库根：DSH_LIBRARY_ROOT 覆盖 > DSH_HOME/library > ~/.dsh/library */
const LIBRARY_ROOT = process.env.DSH_WB_DESK_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "library");
/** 插件元数据目录（隐藏，与用户文件分离）。 */
const META_DIR = join(LIBRARY_ROOT, ".dsh-library");
const PENDING_DIR = join(META_DIR, "pending");
const PINS_DIR = join(META_DIR, "pins");
/** 回收站：删除的文件移到这里可恢复，不参与树与搜索。 */
const TRASH_DIR = join(META_DIR, ".trash");
/** 首次打开的默认目录结构（需求文档 3.4）。 */
const DEFAULT_DIRS = [
	"inbox",
	"projects",
	"archive"
];
/**
* 初始化库：mkdir recursive 对已存在目录是幂等 no-op，
* 因此天然满足"不覆盖已有内容、原地收编"的语义。
*/
async function initLibrary() {
	await mkdir(META_DIR, { recursive: true });
	await mkdir(PENDING_DIR, { recursive: true });
	await mkdir(PINS_DIR, { recursive: true });
	for (const dir of DEFAULT_DIRS) await mkdir(join(LIBRARY_ROOT, dir), { recursive: true });
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
async function pinForRead(absPath, relPath) {
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
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		await mkdir(PINS_DIR, { recursive: true });
		await writeFile(join(PINS_DIR, `${pin.hash.slice(0, 8)}-${Date.now()}.json`), JSON.stringify(pin, null, 2), "utf8");
		index[relPath] = {
			pinId: pin.id,
			hash: pin.hash,
			createdAt: pin.createdAt
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
			createdAt: active.createdAt
		},
		created: false,
		drifted: false
	};
	const pinFile = await findPinFile(active.pinId);
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
async function findPinFile(pinId) {
	try {
		const { readdir } = await import("node:fs/promises");
		const hit = (await readdir(PINS_DIR)).find((f) => f.endsWith(".json") && f !== "active.json" && f.includes(pinId.slice(0, 8)));
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
/** 释放（重新固定入口）：删除 pin 索引条目；下次读取会重新固定。 */
async function releasePin(relPath) {
	const index = await readActiveIndex();
	if (!(relPath in index)) return false;
	delete index[relPath];
	await writeActiveIndex(index);
	return true;
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
const WRITE_TOOLS = /* @__PURE__ */ new Set([
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
function extractPath(args) {
	for (const key of [
		"path",
		"file_path",
		"filePath",
		"target",
		"targetPath",
		"filename"
	]) if (typeof args[key] === "string" && args[key].length > 0) return args[key];
}
/** pre-execute 的裁决：拦截修改类写入，其余放行。 */
async function preExecute(exec) {
	if (!WRITE_TOOLS.has(exec.name)) return { kind: "allow" };
	const args = exec.arguments ?? {};
	const target = extractPath(args);
	if (!target) return { kind: "allow" };
	if (!isInsideLibrary(target)) return { kind: "allow" };
	if (READ_TOOLS.has(exec.name)) {
		const rel = relative(LIBRARY_ROOT, target).replaceAll("\\", "/");
		const outcome = await pinForRead(target, rel);
		if (!outcome) return { kind: "allow" };
		if (!outcome.drifted) return { kind: "allow" };
		return {
			kind: "deny",
			reason: `「${rel}」在你引用之后已被修改。本次读取按固定修订引用返回 pin 时刻的版本：\n\n${outcome.pin.content.length > 49152 ? outcome.pin.content.slice(0, 49152) + "\n…（固定版本内容过长已截断，完整内容在 .dsh-library/pins/）" : outcome.pin.content}\n\n如需基于最新内容工作，请提示用户在资料库面板「固定引用」中释放该文件的 pin 后重新读取。`
		};
	}
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
/** post-execute 的裁决：库外成功写入的文件，复制一份到 inbox/ 归位。 */
async function postExecute(exec, failed) {
	if (failed || !WRITE_TOOLS.has(exec.name)) return;
	const target = extractPath(exec.arguments ?? {});
	if (!target || isInsideLibrary(target) || !existsSync(target)) return;
	try {
		if (!(await stat(target)).isFile()) return;
		const dest = await relocatedPath(basename(target));
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(target, dest);
		await appendArtifact({
			sessionId: sessionIdOf(exec.agent),
			tool: exec.name,
			libPath: relative(LIBRARY_ROOT, dest).replaceAll("\\", "/"),
			sourcePath: target,
			kind: "relocated"
		});
	} catch {}
}
/** inbox 内的重名文件用时间戳后缀分开保存（wuzeno 的同名分存思路）。 */
async function relocatedPath(filename) {
	const primary = inLibrary(join("inbox", filename));
	try {
		await stat(primary);
	} catch {
		return primary;
	}
	const dot = filename.lastIndexOf(".");
	const stem = dot > 0 ? filename.slice(0, dot) : filename;
	const ext = dot > 0 ? filename.slice(dot) : "";
	return inLibrary(join("inbox", `${stem}-${Date.now()}${ext}`));
}
/** 供 post-execute 判断失败与否（结果形状宽松匹配，失败才有 isError/error）。 */
function isFailure(result) {
	if (result == null || typeof result !== "object") return false;
	return "isError" in result && result.isError === true || "error" in result;
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
const CONFIG_FILE = join(META_DIR, "cloud.json");
async function loadCloudConfig() {
	try {
		const cfg = JSON.parse(await readFile$1(CONFIG_FILE, "utf8"));
		if (!cfg.endpoint || !cfg.accessKey) return null;
		return cfg;
	} catch {
		return null;
	}
}
async function saveCloudConfig(cfg) {
	await mkdir(META_DIR, { recursive: true });
	await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
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
function s3Region(cfg) {
	if (cfg.region && cfg.region.trim()) return cfg.region.trim();
	const m = s3Host(cfg).host.match(/(?:oss|cos)\.([a-z0-9-]+)\./) || s3Host(cfg).host.match(/\.([a-z0-9-]+)\.amazonaws\./);
	return m ? m[1] : "us-east-1";
}
function encodeKey(key) {
	return key.split("/").map(encodeURIComponent).join("/");
}
async function s3Request(cfg, method, key, query, body) {
	const { host, basePath } = s3Host(cfg);
	const region = s3Region(cfg);
	const amzDate = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = sha256hex(body ?? "");
	const path = basePath + (key ? "/" + encodeKey(key) : "/");
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
				if (route === "/tree" && req.method === "GET") {
					if (!existsSync(LIBRARY_ROOT)) {
						sendJson(res, 200, { items: [] });
						return;
					}
					sendJson(res, 200, { items: await buildTree(LIBRARY_ROOT, "", 8) });
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
					sendJson(res, 200, { items: await readArtifacts() });
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
					const dir = body.dir && body.dir.trim() !== "" ? body.dir : "inbox";
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
						path: rel
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
					const dir = body.dir && body.dir.trim() !== "" ? body.dir : "inbox";
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
					const trashName = body.path.replaceAll("/", "%2F") + "." + Date.now() + ".trash";
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
					sendJson(res, 200, { items: (await readdir(TRASH_DIR)).filter((f) => f.endsWith(".trash")).reverse().map((f) => {
						const dot = f.lastIndexOf(".");
						return {
							name: f,
							originalPath: f.slice(0, dot).replaceAll("%2F", "/")
						};
					}) });
					return;
				}
				if (route === "/trash-restore" && req.method === "POST") {
					const body = JSON.parse(await readBody(req));
					if (typeof body.name !== "string" || !body.name.endsWith(".trash")) {
						sendJson(res, 400, { error: "参数错误" });
						return;
					}
					const trashFile = join(TRASH_DIR, basename(body.name));
					if (!existsSync(trashFile)) {
						sendJson(res, 404, { error: "回收站里没有这个文件" });
						return;
					}
					const dest = safeJoin(basename(body.name, ".trash").replaceAll("%2F", "/"));
					await mkdir(dirname(dest), { recursive: true });
					await rename(trashFile, dest);
					scheduleAutoPush();
					sendJson(res, 200, { ok: true });
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
						autoPush: !!body.autoPush
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
async function apply(ctx) {
	await initLibrary();
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
