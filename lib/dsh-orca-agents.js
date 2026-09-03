import { defineTool } from "@deepseek-ai/dsh-tools";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
//#region src/skill.ts
function orcaAgentsSkill(appVersion) {
	return {
		name: "orca-agents",
		description: "Dispatch a coding job to the local Orca app. Trigger on 用 Orca / 在 Orca 里 / 开一栏 / 让 grok/codex/claude/agy/cursor 去做, and on 怎么样了 / 好了没 / 再跟他说 / 盯着做完. Natural language is enough. Users will not name tools, ids, or handles.",
		source: "bundled",
		provider: "dsh-orca-agents",
		invocation: {
			modelInvocable: true,
			userInvocable: true
		},
		content: `# Orca Agents

Users talk like people. Infer the worker and the job from the sentence.

Examples that mean dispatch:

- 用 Orca 让 grok 做个天气网页
- 帮我在 Orca 里开个 Codex 改登录
- 让 Claude 单独开一栏做这个
- Orca 里那个工人怎么样了
- 再跟他说一声别改数据库
- 盯着做完告诉我

Workers run in the Orca app. Write nothing yourself. Do not use ade_launch.

## What to do

Dispatch, and they did not say 盯着 / 做完告诉我 / 等结果: call \`orca_agent_launch\` once.
- Infer \`agent\` from grok, Codex, Claude, agy, Cursor. If the sentence already names one, you may omit \`agent\`.
- \`prompt\` is their task in their words. If they asked for a page or app, name the file to write (for example \`index.html\`).
- Omit \`repo\` and \`worktree\`. The tool makes a new empty Orca project. Do not send the current DSH folder. Only pass worktree current if they said 就在这个文件夹里改.
- \`supervise\` false.
Launch returns immediately and starts a background watch on Orca agent Stop hooks (\`agents[].state\`). Tell them it is running in Orca. Do not tell them to keep asking 好了没. Do not poll. When a background job notice arrives, read \`job_output\` and tell them it finished, with the path and files.

怎么样了 / 好了没: \`orca_agent_list\`, or \`orca_agent_get\` if they named a worker. If it is still working, the hook watcher will wake you; say that.

补一句 / 改方向: \`orca_agent_followup\` with their words. Omit \`terminal\` and \`worktree\` unless they named one.

盯着 / 做完告诉我 in this same turn: launch already watches; you may also call \`orca_agent_wait\` if you must stay in the turn.

If they named no worker, ask one short question: grok, Codex, Claude, Cursor, or Antigravity.

${appVersion ? `Orca ${appVersion}` : ""}
`
	};
}
//#endregion
//#region src/types.ts
const REQUIRED_COMMANDS = [
	"open",
	"status",
	"repo add",
	"project setup-existing-folder",
	"worktree create",
	"worktree ps",
	"worktree show",
	"terminal create",
	"terminal send",
	"terminal wait",
	"terminal list",
	"orchestration run-create",
	"orchestration task-create",
	"orchestration worker-start",
	"orchestration check",
	"orchestration worker-stop",
	"skills get",
	"agent-context"
];
//#endregion
//#region src/orca-exec.ts
function resolveCli() {
	const fromEnv = process.env.ORCA_CLI_COMMAND;
	if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	return "orca";
}
async function runOrca(cli, args, opts = {}) {
	if (opts.signal?.aborted) throw new Error("aborted");
	const argv = args.includes("--json") || args.includes("--help") ? [...args] : [...args, "--json"];
	return await new Promise((resolve, reject) => {
		const child = spawn(cli, argv, {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			signal: opts.signal
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		let timer;
		if (opts.timeoutMs && opts.timeoutMs > 0) timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(/* @__PURE__ */ new Error(`timeout after ${opts.timeoutMs}ms`));
		}, opts.timeoutMs);
		child.once("error", (err) => {
			if (timer) clearTimeout(timer);
			reject(err);
		});
		child.once("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({
				stdout,
				stderr,
				code
			});
		});
	});
}
function parseJsonText(text) {
	const trimmed = text.trim();
	if (!trimmed) throw new Error("empty orca stdout");
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
		throw new Error("orca stdout is not JSON");
	}
}
function asEnvelope(raw) {
	if (!raw || typeof raw !== "object") return {
		ok: true,
		result: raw
	};
	const rec = raw;
	if (rec.ok === true) return {
		ok: true,
		result: rec.result
	};
	if (rec.ok === false) {
		const err = rec.error;
		if (err && typeof err === "object") {
			const e = err;
			return {
				ok: false,
				error: {
					code: String(e.code ?? "orca_error"),
					message: String(e.message ?? "orca error"),
					data: e.data
				}
			};
		}
		return {
			ok: false,
			error: {
				code: "orca_error",
				message: String(rec.error ?? "orca error")
			}
		};
	}
	return {
		ok: true,
		result: raw
	};
}
async function orcaJson(cli, args, opts = {}) {
	const ran = await runOrca(cli, args, opts);
	let raw;
	try {
		raw = parseJsonText(ran.stdout);
	} catch (err) {
		const hint = ran.stderr.trim() || (err instanceof Error ? err.message : "parse failed");
		return {
			ok: false,
			error: {
				code: ran.code === 0 ? "invalid_runtime_response" : "orca_unavailable",
				message: hint.slice(0, 2e3)
			}
		};
	}
	const env = asEnvelope(raw);
	if (!env.ok) return env;
	if (ran.code !== 0 && ran.code !== null) return {
		ok: false,
		error: {
			code: "orca_exit",
			message: ran.stderr.trim() || `orca exited ${ran.code}`
		}
	};
	return env;
}
function record(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
//#endregion
//#region src/binder.ts
let cache = null;
function commandNamesFromAgentContext(raw) {
	const rec = record(raw);
	const commands = (record(rec && rec.ok === true ? rec.result : raw) ?? rec)?.commands;
	if (!Array.isArray(commands)) return [];
	const names = [];
	for (const item of commands) {
		const row = record(item);
		if (typeof row?.command === "string") names.push(row.command);
	}
	return names;
}
function missingRequired(commandSet) {
	return REQUIRED_COMMANDS.filter((name) => !commandSet.has(name));
}
async function bind(opts = {}) {
	const cli = resolveCli();
	if (cache && !opts.force && cache.binder.cli === cli && cache.binder.ok) return cache.binder;
	let commandSet = /* @__PURE__ */ new Set();
	let schemaVersion = "0";
	try {
		const ctxRaw = parseJsonText((await runOrca(cli, ["agent-context", "--json"], {
			signal: opts.signal,
			timeoutMs: 15e3
		})).stdout);
		const ctxBody = record(ctxRaw);
		schemaVersion = String(ctxBody?.schemaVersion ?? "1");
		commandSet = new Set(commandNamesFromAgentContext(ctxRaw));
	} catch (err) {
		const binder = {
			ok: false,
			code: "orca_unavailable",
			message: err instanceof Error ? err.message : "orca agent-context failed",
			missing: [...REQUIRED_COMMANDS],
			appVersion: null,
			cli
		};
		cache = {
			key: cli,
			binder
		};
		return binder;
	}
	const missing = missingRequired(commandSet);
	if (missing.length > 0) {
		const binder = {
			ok: false,
			code: "orca_cli_drift",
			message: `Orca CLI is missing required commands: ${missing.join(", ")}`,
			missing,
			appVersion: null,
			cli
		};
		cache = {
			key: cli,
			binder
		};
		return binder;
	}
	let appVersion = null;
	let capabilities = [];
	const status = await orcaJson(cli, ["status"], {
		signal: opts.signal,
		timeoutMs: 2e4
	});
	if (status.ok) {
		const runtime = record(record(status.result)?.runtime);
		if (typeof runtime?.appVersion === "string") appVersion = runtime.appVersion;
		if (Array.isArray(runtime?.capabilities)) capabilities = runtime.capabilities.filter((item) => typeof item === "string");
	}
	const binder = {
		ok: true,
		cli,
		appVersion,
		capabilities,
		commandSet
	};
	cache = {
		key: `${cli}:${appVersion}:${schemaVersion}`,
		binder
	};
	return binder;
}
async function ensureRuntime(binder, signal) {
	if (!binder.ok) return binder;
	const status = await orcaJson(binder.cli, ["status"], {
		signal,
		timeoutMs: 2e4
	});
	if (status.ok) {
		const result = record(status.result);
		if (record(result?.runtime)?.reachable === true || record(result?.app)?.running === true) return binder;
	}
	const opened = await orcaJson(binder.cli, ["open"], {
		signal,
		timeoutMs: 6e4
	});
	if (!opened.ok) return {
		ok: false,
		code: "orca_unavailable",
		message: opened.error.message,
		missing: [],
		appVersion: binder.appVersion,
		cli: binder.cli
	};
	return bind({
		signal,
		force: true
	});
}
function failPayload(binder) {
	return {
		ok: false,
		code: binder.code,
		message: binder.message,
		missing: [...binder.missing],
		appVersion: binder.appVersion
	};
}
//#endregion
//#region src/infer.ts
const AGENT_PATTERNS = [
	[/\bantigravity\b|\bagy\b/i, "antigravity"],
	[/\bclaude(?:[\s-]*code)?\b/i, "claude"],
	[/\bcodex\b/i, "codex"],
	[/\bcursor\b/i, "cursor"],
	[/\bgrok\b|\bxai\b/i, "grok"]
];
async function withRuntime(signal) {
	const bound = await bind({ signal });
	if (!bound.ok) return { error: failPayload(bound) };
	const live = await ensureRuntime(bound, signal);
	if (!live.ok) return { error: failPayload(live) };
	return { binder: live };
}
function taskName(name, prompt) {
	const given = name?.trim();
	if (given) return given.slice(0, 80);
	return prompt.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `dsh-${Date.now()}`;
}
function launchCommand(agent) {
	if (agent === "antigravity") return "agy";
	return agent;
}
function agentsIn(text) {
	if (!text) return [];
	const found = [];
	for (const [pattern, id] of AGENT_PATTERNS) if (pattern.test(text) && !found.includes(id)) found.push(id);
	return found;
}
function inferAgent(agent, prompt) {
	const direct = agent?.trim();
	if (direct) {
		const named = agentsIn(direct);
		if (named.length === 1) return named[0];
		if (direct.toLowerCase().replace(/\s+/g, " ") === "agy") return "antigravity";
	}
	const fromPrompt = agentsIn(prompt);
	if (fromPrompt.length === 1) return fromPrompt[0];
}
function sessionCwd(exec) {
	const cwd = exec.agent?.session?.header?.cwd;
	if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
}
function absPathOf(repo, cwd) {
	const raw = repo?.trim();
	if (raw) {
		if (raw.startsWith("path:")) {
			const path = raw.slice(5);
			return path.startsWith("/") ? path : void 0;
		}
		if (raw.startsWith("/")) return raw;
		return;
	}
	if (cwd?.startsWith("/")) return cwd;
}
function repoSelector(repo, cwd) {
	const raw = repo?.trim();
	if (raw) {
		if (raw.startsWith("path:") || raw.startsWith("id:") || raw.startsWith("name:")) return raw;
		if (raw.startsWith("/")) return `path:${raw}`;
		return raw;
	}
	if (cwd?.startsWith("/")) return `path:${cwd}`;
}
async function ensureRepo(cli, repo, cwd, signal) {
	const abs = absPathOf(repo, cwd);
	if (abs) {
		await importPath(cli, abs, signal);
		return { selector: `path:${abs}` };
	}
	const selector = repoSelector(repo, cwd);
	return selector ? { selector } : {};
}
function pickHandle(result) {
	const rec = record(result);
	const worktree = record(rec?.worktree);
	const agentId = typeof worktree?.id === "string" && worktree.id || typeof rec?.worktreeId === "string" && rec.worktreeId || "";
	const startup = record(rec?.startupTerminal);
	const runId = typeof rec?.agentTerminalHandle === "string" && rec.agentTerminalHandle || typeof startup?.handle === "string" && startup.handle || typeof rec?.handle === "string" && rec.handle || "";
	if (!agentId && !runId) return { error: "orca launch returned no worktree or terminal id" };
	return {
		agentId: agentId || runId,
		runId: runId || agentId
	};
}
async function importPath(cli, absPath, signal) {
	const added = await orcaJson(cli, [
		"repo",
		"add",
		"--path",
		absPath
	], {
		signal,
		timeoutMs: 3e4
	});
	if (!added.ok) return {
		ok: false,
		code: added.error.code,
		message: added.error.message
	};
	const repo = record(added.result);
	const nested = record(repo?.repo) ?? repo;
	return {
		ok: true,
		repoId: nested?.id ?? null,
		path: nested?.path ?? absPath,
		displayName: nested?.displayName ?? null
	};
}
//#endregion
//#region src/watch.ts
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hookRunStatus(row) {
	if (!row) return "unknown";
	const agents = Array.isArray(row.agents) ? row.agents.filter(isRecord$1) : [];
	if (agents.some((agent) => agent.interrupted === true)) return "interrupted";
	if (agents.some((agent) => agent.state === "done")) return "done";
	if (agents.some((agent) => agent.state === "working" || agent.state === "blocked" || agent.state === "waiting")) return "working";
	return "unknown";
}
function matchWorktree(row, selector) {
	const id = String(row.worktreeId ?? "");
	const name = String(row.displayName ?? "");
	const path = String(row.path ?? "");
	return id === selector || name === selector || path === selector || id.endsWith(selector);
}
function pickWorktree(rows, selector) {
	return rows.find((row) => matchWorktree(row, selector));
}
function worktreeRows(result) {
	const list = record(result)?.worktrees;
	if (!Array.isArray(list)) return [];
	return list.filter(isRecord$1);
}
function peekFiles(absPath) {
	if (typeof absPath !== "string" || !absPath.startsWith("/")) return [];
	try {
		return readdirSync(absPath).filter((name) => !name.startsWith(".")).slice(0, 24);
	} catch {
		return [];
	}
}
async function waitForHookDone(opts) {
	const budget = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 18e5;
	const pollMs = opts.pollMs && opts.pollMs > 0 ? opts.pollMs : 2e3;
	const started = Date.now();
	let last;
	while (!opts.signal?.aborted) {
		const ps = await orcaJson(opts.cli, ["worktree", "ps"], {
			signal: opts.signal,
			timeoutMs: 3e4
		});
		last = pickWorktree(ps.ok ? worktreeRows(ps.result) : [], opts.worktree);
		const status = hookRunStatus(last);
		if (status === "done" || status === "interrupted") return {
			status,
			worktree: last ?? null,
			files: peekFiles(last?.path),
			via: "orca-agent-hooks"
		};
		if (!last && Date.now() - started > 15e3) return {
			status: "gone",
			worktree: null,
			files: [],
			via: "orca-agent-hooks"
		};
		if (Date.now() - started > budget) return {
			status: "timeout",
			worktree: last ?? null,
			files: peekFiles(last?.path),
			via: "orca-agent-hooks"
		};
		await sleep(pollMs, opts.signal);
	}
	return {
		status: "aborted",
		worktree: last ?? null,
		files: peekFiles(last?.path),
		via: "orca-agent-hooks"
	};
}
async function ensureAgentHooks(cli, signal) {
	const status = await orcaJson(cli, [
		"agent",
		"hooks",
		"status"
	], {
		signal,
		timeoutMs: 15e3
	});
	if ((status.ok ? record(status.result) ?? record(status) : null)?.enabled === true) return { enabled: true };
	return { enabled: (await orcaJson(cli, [
		"agent",
		"hooks",
		"on"
	], {
		signal,
		timeoutMs: 2e4
	})).ok };
}
function startHookWatch(ctx, exec, opts) {
	let jobs;
	try {
		jobs = ctx.jobs;
	} catch {
		return;
	}
	const owner = exec.agent;
	if (jobs === void 0 || owner === void 0) return void 0;
	try {
		return jobs.start({
			kind: "orca",
			label: opts.label,
			owner,
			run: () => {
				const ac = new AbortController();
				return {
					cancel: () => ac.abort(),
					done: waitForHookDone({
						cli: opts.cli,
						worktree: opts.worktree,
						signal: ac.signal
					}).then((result) => {
						return {
							status: result.status === "timeout" || result.status === "gone" || result.status === "aborted" ? "failed" : result.status === "interrupted" ? "killed" : "completed",
							detail: result.status,
							output: JSON.stringify(result, null, 2)
						};
					})
				};
			}
		});
	} catch {
		return;
	}
}
function sleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
//#endregion
//#region src/fresh.ts
const STAY = /就在这|当前目录|这个文件夹|不要新开|原地改|就在这儿/;
function stayInPlace(prompt) {
	return STAY.test(prompt);
}
function createFreshRepo(name) {
	const base = join(homedir(), "orca", "projects");
	mkdirSync(base, { recursive: true });
	const slug = name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `dsh-${Date.now().toString(36)}`;
	let dir = join(base, slug);
	if (existsSync(dir)) dir = join(base, `${slug}-${Date.now().toString(36)}`);
	mkdirSync(dir, { recursive: true });
	const gitEnv = {
		...process.env,
		GIT_AUTHOR_NAME: "dsh-orca",
		GIT_AUTHOR_EMAIL: "dsh-orca@local",
		GIT_COMMITTER_NAME: "dsh-orca",
		GIT_COMMITTER_EMAIL: "dsh-orca@local"
	};
	execFileSync("git", ["init"], {
		cwd: dir,
		stdio: "ignore"
	});
	execFileSync("git", [
		"commit",
		"--allow-empty",
		"-m",
		"dsh dispatch"
	], {
		cwd: dir,
		stdio: "ignore",
		env: gitEnv
	});
	return dir;
}
//#endregion
//#region src/tools.ts
const OBJECT_OUT = {
	schema: {
		type: "object",
		additionalProperties: true
	},
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}]
};
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function worktreesOf(result) {
	const list = record(result)?.worktrees;
	if (!Array.isArray(list)) return [];
	return list.filter(isRecord);
}
function projectRow(row) {
	const agents = Array.isArray(row.agents) ? row.agents.filter(isRecord) : [];
	const primary = agents[0];
	return {
		worktreeId: row.worktreeId ?? null,
		displayName: row.displayName ?? null,
		path: row.path ?? null,
		repo: row.repo ?? null,
		branch: row.branch ?? null,
		comment: row.comment ?? "",
		workspaceStatus: row.workspaceStatus ?? null,
		runStatus: primary?.state ?? row.status ?? null,
		interrupted: Boolean(primary?.interrupted),
		agentType: primary?.agentType ?? null,
		lastAssistantMessage: primary?.lastAssistantMessage ?? null,
		liveTerminalCount: row.liveTerminalCount ?? 0,
		lastActivityAt: row.lastActivityAt ?? null,
		agents: agents.map((agent) => ({
			paneKey: agent.paneKey ?? null,
			agentType: agent.agentType ?? null,
			state: agent.state ?? null,
			interrupted: Boolean(agent.interrupted),
			lastAssistantMessage: agent.lastAssistantMessage ?? null,
			prompt: agent.prompt ?? null
		}))
	};
}
async function psRows(cli, signal) {
	const ps = await orcaJson(cli, ["worktree", "ps"], {
		signal,
		timeoutMs: 3e4
	});
	if (!ps.ok) return [];
	return worktreesOf(ps.result).map(projectRow);
}
function findRow(rows, selector) {
	const wt = selector.worktree?.trim();
	if (!wt) return void 0;
	return rows.find((row) => {
		const id = String(row.worktreeId ?? "");
		const name = String(row.displayName ?? "");
		const path = String(row.path ?? "");
		return id === wt || name === wt || path === wt || id.endsWith(wt);
	});
}
function latestRow(rows) {
	if (rows.length === 0) return void 0;
	return [...rows].sort((a, b) => {
		const ta = Date.parse(String(a.lastActivityAt ?? "")) || 0;
		return (Date.parse(String(b.lastActivityAt ?? "")) || 0) - ta;
	})[0];
}
function pickRow(rows, worktree) {
	return findRow(rows, { worktree }) ?? latestRow(rows);
}
function pickTerminalHandle(result) {
	const list = record(result)?.terminals;
	const live = (Array.isArray(list) ? list.filter(isRecord) : []).filter((row) => row.orphaned !== true && typeof row.handle === "string");
	const picked = live.find((row) => row.writable !== false) ?? live[0];
	return typeof picked?.handle === "string" ? picked.handle : void 0;
}
function registerOrcaTools(ctx) {
	ctx.tools.register(defineTool({
		name: "orca_runtime_status",
		description: "See if the local Orca app is running. Launch already opens Orca. Call this only when you need to report version or drift. Users will not ask for this by name.",
		parameters: {},
		timeoutMs: 9e4,
		output: OBJECT_OUT,
		async execute(_args, exec) {
			const bound = await bind({
				signal: exec.signal,
				force: true
			});
			if (!bound.ok) return failPayload(bound);
			if (!(await orcaJson(bound.cli, ["status"], {
				signal: exec.signal,
				timeoutMs: 2e4
			})).ok) {
				const opened = await orcaJson(bound.cli, ["open"], {
					signal: exec.signal,
					timeoutMs: 6e4
				});
				if (!opened.ok) return {
					ok: false,
					code: opened.error.code,
					message: opened.error.message,
					appVersion: bound.appVersion
				};
			}
			const live = await bind({
				signal: exec.signal,
				force: true
			});
			if (!live.ok) return failPayload(live);
			return {
				ok: true,
				appVersion: live.appVersion,
				capabilities: [...live.capabilities],
				drift: { missing: [] },
				guidesBound: true
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "orca_guides",
		description: "Print the version-matched Orca skill guide from the live binary (orca-cli or orchestration). Optional query keeps excerpts only.",
		parameters: {
			topic: {
				type: "string",
				required: true,
				enum: ["orca-cli", "orchestration"],
				description: "Which bundled Orca guide to fetch."
			},
			query: {
				type: "string",
				description: "Optional case-insensitive excerpt filter."
			}
		},
		timeoutMs: 2e4,
		output: OBJECT_OUT,
		async execute(args, exec) {
			const bound = await bind({ signal: exec.signal });
			const cli = bound.cli;
			const got = await orcaJson(cli, [
				"skills",
				"get",
				args.topic
			], {
				signal: exec.signal,
				timeoutMs: 15e3
			});
			if (!got.ok) return {
				ok: false,
				code: got.error.code,
				message: got.error.message
			};
			const body = record(got.result) ?? record(got);
			const markdown = typeof body?.markdown === "string" ? body.markdown : String(got.result ?? "");
			const q = args.query?.trim().toLowerCase();
			if (!q) return {
				ok: true,
				topic: args.topic,
				markdown,
				appVersion: bound.ok ? bound.appVersion : null
			};
			const lines = markdown.split("\n");
			const hits = [];
			for (let i = 0; i < lines.length; i += 1) {
				if (lines[i].toLowerCase().includes(q)) hits.push(lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 6)).join("\n"));
				if (hits.length >= 12) break;
			}
			return {
				ok: true,
				topic: args.topic,
				query: args.query,
				excerpts: hits,
				appVersion: bound.ok ? bound.appVersion : null
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "orca_project_import",
		description: "Register a local folder with Orca. Use when the user named a directory and it may not be in Orca yet. Users will not ask for this by name.",
		parameters: { path: {
			type: "string",
			required: true,
			description: "Folder the user mentioned, as an absolute path if they gave one."
		} },
		timeoutMs: 45e3,
		output: OBJECT_OUT,
		async execute(args, exec) {
			const path = args.path.trim();
			if (!path.startsWith("/")) return {
				ok: false,
				code: "invalid_argument",
				message: "path must be absolute"
			};
			const ready = await withRuntime(exec.signal);
			if ("error" in ready) return ready.error;
			return importPath(ready.binder.cli, path, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
		name: "orca_agent_launch",
		description: "Start Grok, Codex, Claude, Cursor, or Antigravity in a new empty Orca project. Use when the user says 用 Orca / 在 Orca 里 / 开一栏 / 让 grok 去做. Do not write into the current DSH folder. Omit repo and worktree unless they named a folder or said to stay in this folder. Returns immediately and starts a background watch on Orca agent Stop hooks.",
		parameters: {
			agent: {
				type: "string",
				description: "Who to start: grok, codex, claude, antigravity, or cursor. Infer from the sentence. Omit if the prompt already names one."
			},
			prompt: {
				type: "string",
				required: true,
				description: "The user task, in their words. If they asked for a page or app, name the file to write."
			},
			name: {
				type: "string",
				description: "Short label. Optional. Invented from the task if omitted."
			},
			repo: {
				type: "string",
				description: "Folder they named. Absolute path, or omit to use the current DSH folder."
			},
			supervise: {
				type: "boolean",
				description: "True only if they asked to watch, wait, or be told when it is done."
			},
			worktree: {
				type: "string",
				enum: ["new", "current"],
				description: "Ignored unless the user asked to stay in this folder. Default is a new empty project."
			}
		},
		timeoutMs: 12e4,
		output: OBJECT_OUT,
		async execute(args, exec) {
			const ready = await withRuntime(exec.signal);
			if ("error" in ready) return ready.error;
			const { cli, capabilities } = ready.binder;
			const agent = inferAgent(args.agent, args.prompt);
			if (!agent) return {
				ok: false,
				code: "need_agent",
				message: "Which worker should Orca start: grok, codex, claude, cursor, or antigravity?"
			};
			const prompt = args.prompt;
			const name = taskName(args.name, prompt);
			const supervise = args.supervise === true;
			const stay = stayInPlace(prompt);
			let worktreeMode = stay ? "current" : "new";
			let repoFlag;
			if (stay) repoFlag = (await ensureRepo(cli, args.repo, sessionCwd(exec), exec.signal)).selector;
			else if (args.repo?.trim()) repoFlag = (await ensureRepo(cli, args.repo, void 0, exec.signal)).selector;
			else {
				const fresh = createFreshRepo(name);
				await importPath(cli, fresh, exec.signal);
				repoFlag = `path:${fresh}`;
			}
			const hooks = await ensureAgentHooks(cli, exec.signal);
			const watch = (payload) => {
				const worktree = String(payload.agentId ?? "");
				if (!worktree || worktree === "active") return {
					...payload,
					hooksEnabled: hooks.enabled
				};
				const jobId = startHookWatch(ctx, exec, {
					cli,
					worktree,
					label: `Orca ${agent} ${payload.name ?? worktree}`
				});
				return jobId ? {
					...payload,
					hooksEnabled: hooks.enabled,
					jobId,
					watch: "orca-agent-hooks"
				} : {
					...payload,
					hooksEnabled: hooks.enabled
				};
			};
			if (supervise && !capabilities.includes("orchestration.contract.v1")) return {
				ok: false,
				code: "orchestration_unavailable",
				message: "Orca orchestration is not enabled. Turn on Settings → Experimental, then retry with supervise."
			};
			if (!supervise && worktreeMode === "current") {
				const created = await orcaJson(cli, [
					"terminal",
					"create",
					"--worktree",
					"active",
					"--title",
					name,
					"--command",
					launchCommand(agent)
				], {
					signal: exec.signal,
					timeoutMs: 6e4
				});
				if (created.ok) {
					const rec = record(created.result);
					const handle = typeof rec?.handle === "string" ? rec.handle : "";
					if (handle && prompt) {
						await orcaJson(cli, [
							"terminal",
							"wait",
							"--terminal",
							handle,
							"--for",
							"tui-idle",
							"--timeout-ms",
							"60000"
						], {
							signal: exec.signal,
							timeoutMs: 7e4
						});
						const sent = await orcaJson(cli, [
							"terminal",
							"send",
							"--terminal",
							handle,
							"--text",
							prompt,
							"--enter"
						], {
							signal: exec.signal,
							timeoutMs: 2e4
						});
						if (!sent.ok) return {
							ok: false,
							code: sent.error.code,
							message: sent.error.message
						};
					}
					return watch({
						ok: true,
						inspect: "orca",
						agent,
						name,
						agentId: typeof rec?.worktreeId === "string" ? rec.worktreeId : "active",
						runId: handle,
						supervise: false
					});
				}
				worktreeMode = "new";
			}
			if (!supervise) {
				const argv = [
					"worktree",
					"create",
					"--name",
					name,
					"--no-parent",
					"--agent",
					agent,
					"--prompt",
					prompt
				];
				if (repoFlag) argv.push("--repo", repoFlag);
				const created = await orcaJson(cli, argv, {
					signal: exec.signal,
					timeoutMs: 9e4
				});
				if (!created.ok) return {
					ok: false,
					code: created.error.code,
					message: created.error.message
				};
				const ids = pickHandle(created.result);
				if ("error" in ids) return {
					ok: false,
					code: "orca_error",
					message: ids.error
				};
				return watch({
					ok: true,
					inspect: "orca",
					agent,
					name,
					supervise: false,
					...ids
				});
			}
			const run = await orcaJson(cli, [
				"orchestration",
				"run-create",
				"--objective",
				prompt
			], {
				signal: exec.signal,
				timeoutMs: 3e4
			});
			if (!run.ok) return {
				ok: false,
				code: run.error.code,
				message: run.error.message
			};
			const runRec = record(run.result);
			const runId = typeof runRec?.id === "string" ? runRec.id : typeof runRec?.runId === "string" ? runRec.runId : "";
			const task = await orcaJson(cli, [
				"orchestration",
				"task-create",
				"--spec",
				prompt
			], {
				signal: exec.signal,
				timeoutMs: 3e4
			});
			if (!task.ok) return {
				ok: false,
				code: task.error.code,
				message: task.error.message
			};
			const taskRec = record(task.result);
			const taskId = typeof taskRec?.id === "string" && taskRec.id || typeof taskRec?.taskId === "string" && taskRec.taskId || "";
			if (!taskId) return {
				ok: false,
				code: "orca_error",
				message: "task-create returned no id"
			};
			const workerArgs = [
				"orchestration",
				"worker-start",
				"--task",
				taskId,
				"--worktree",
				worktreeMode === "current" ? "current" : "new-top-level",
				"--agent",
				agent,
				"--name",
				name
			];
			if (repoFlag) workerArgs.push("--repo", repoFlag);
			const worker = await orcaJson(cli, workerArgs, {
				signal: exec.signal,
				timeoutMs: 9e4
			});
			if (!worker.ok) return {
				ok: false,
				code: worker.error.code,
				message: worker.error.message
			};
			const workerRec = record(worker.result);
			const dispatchId = typeof workerRec?.dispatchId === "string" && workerRec.dispatchId || typeof record(workerRec?.dispatch)?.id === "string" && String(record(workerRec?.dispatch)?.id) || "";
			const ids = pickHandle(worker.result);
			return watch({
				ok: true,
				inspect: "orca",
				agent,
				name,
				supervise: true,
				runId: "error" in ids ? dispatchId : ids.runId || dispatchId,
				agentId: "error" in ids ? typeof workerRec?.worktreeId === "string" ? workerRec.worktreeId : runId : ids.agentId,
				dispatchId,
				orchestrationRunId: runId,
				taskId
			});
		}
	}));
	ctx.tools.register(defineTool({
		name: "orca_agent_list",
		description: "How the Orca workers are doing. Use when the user asks 怎么样了 / 好了没 / 进度. They will not name this tool.",
		parameters: {},
		timeoutMs: 3e4,
		output: OBJECT_OUT,
		async execute(_args, exec) {
			const ready = await withRuntime(exec.signal);
			if ("error" in ready) return ready.error;
			return {
				ok: true,
				worktrees: await psRows(ready.binder.cli, exec.signal)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "orca_agent_get",
		description: "Show one Orca worker plus its live terminals. Use when the user asks about a named worker, or after list. They will not pass ids.",
		parameters: { worktree: {
			type: "string",
			description: "Name, id, or path they mentioned. Omit to use the latest worker."
		} },
		timeoutMs: 3e4,
		output: OBJECT_OUT,
		async execute(args, exec) {
			const ready = await withRuntime(exec.signal);
			if ("error" in ready) return ready.error;
			const { cli } = ready.binder;
			const row = pickRow(await psRows(cli, exec.signal), args.worktree);
			if (!row) return {
				ok: false,
				code: "not_found",
				message: args.worktree ? `no worktree matching ${args.worktree}` : "no Orca worktrees"
			};
			const selector = typeof row.worktreeId === "string" ? `id:${row.worktreeId}` : args.worktree;
			const shown = await orcaJson(cli, [
				"worktree",
				"show",
				"--worktree",
				selector
			], {
				signal: exec.signal,
				timeoutMs: 2e4
			});
			const terminals = await orcaJson(cli, [
				"terminal",
				"list",
				"--worktree",
				selector
			], {
				signal: exec.signal,
				timeoutMs: 2e4
			});
			return {
				ok: true,
				worktree: row,
				show: shown.ok ? shown.result : shown.error,
				terminals: terminals.ok ? terminals.result : terminals.error
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "orca_agent_followup",
		description: "Send a follow-up into an Orca worker. Use when the user says 再跟他说 / 补一句 / 改方向. They will not pass handles. Deliver even if the worker is still working; Orca queues it.",
		parameters: {
			text: {
				type: "string",
				required: true,
				description: "The extra instruction, in their words."
			},
			worktree: {
				type: "string",
				description: "Name, id, or path they mentioned. Omit to use the latest worker."
			},
			terminal: {
				type: "string",
				description: "Optional terminal handle. Omit and the tool finds it."
			}
		},
		timeoutMs: 3e4,
		output: OBJECT_OUT,
		async execute(args, exec) {
			const ready = await withRuntime(exec.signal);
			if ("error" in ready) return ready.error;
			const { cli } = ready.binder;
			const row = pickRow(await psRows(cli, exec.signal), args.worktree);
			if (!row) return {
				ok: false,
				code: "not_found",
				message: args.worktree ? `no worktree matching ${args.worktree}` : "no Orca worktrees"
			};
			let handle = args.terminal?.trim();
			if (!handle) {
				const listed = await orcaJson(cli, [
					"terminal",
					"list",
					"--worktree",
					typeof row.worktreeId === "string" ? `id:${row.worktreeId}` : String(row.displayName ?? "")
				], {
					signal: exec.signal,
					timeoutMs: 2e4
				});
				handle = listed.ok ? pickTerminalHandle(listed.result) : void 0;
			}
			if (!handle) return {
				ok: false,
				code: "not_found",
				message: "no live terminal for that worker"
			};
			const busy = (Array.isArray(row.agents) ? row.agents : []).some((agent) => isRecord(agent) && agent.state === "working");
			const sent = await orcaJson(cli, [
				"terminal",
				"send",
				"--terminal",
				handle,
				"--text",
				args.text,
				"--enter"
			], {
				signal: exec.signal,
				timeoutMs: 2e4
			});
			if (!sent.ok) return {
				ok: false,
				code: sent.error.code,
				message: sent.error.message
			};
			return {
				ok: true,
				queued: busy,
				terminal: handle,
				worktree: row.worktreeId ?? null
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "orca_agent_cancel",
		description: "Stop an Orca worker. Use when the user says 停 / 取消 / 打断. They will not pass handles.",
		parameters: {
			terminal: {
				type: "string",
				description: "Optional terminal handle. Omit and the tool finds it."
			},
			worktree: {
				type: "string",
				description: "Name, id, or path they mentioned. Omit to use the latest worker."
			},
			dispatch: {
				type: "string",
				description: "Optional orchestration dispatch id."
			}
		},
		timeoutMs: 3e4,
		output: OBJECT_OUT,
		async execute(args, exec) {
			const ready = await withRuntime(exec.signal);
			if ("error" in ready) return ready.error;
			const { cli } = ready.binder;
			let handle = args.terminal?.trim();
			if (!handle) {
				const row = pickRow(await psRows(cli, exec.signal), args.worktree);
				if (!row) return {
					ok: false,
					code: "not_found",
					message: args.worktree ? `no worktree matching ${args.worktree}` : "no Orca worktrees"
				};
				const listed = await orcaJson(cli, [
					"terminal",
					"list",
					"--worktree",
					typeof row.worktreeId === "string" ? `id:${row.worktreeId}` : String(row.displayName ?? "")
				], {
					signal: exec.signal,
					timeoutMs: 2e4
				});
				handle = listed.ok ? pickTerminalHandle(listed.result) : void 0;
			}
			if (!handle) return {
				ok: false,
				code: "not_found",
				message: "no live terminal for that worker"
			};
			const sent = await orcaJson(cli, [
				"terminal",
				"send",
				"--terminal",
				handle,
				"--interrupt"
			], {
				signal: exec.signal,
				timeoutMs: 2e4
			});
			if (!sent.ok) return {
				ok: false,
				code: sent.error.code,
				message: sent.error.message
			};
			if (args.dispatch?.trim()) {
				const stopped = await orcaJson(cli, [
					"orchestration",
					"worker-stop",
					"--dispatch",
					args.dispatch.trim()
				], {
					signal: exec.signal,
					timeoutMs: 2e4
				});
				if (!stopped.ok) return {
					ok: true,
					interrupted: true,
					workerStop: {
						ok: false,
						message: stopped.error.message
					}
				};
			}
			return {
				ok: true,
				interrupted: true
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "orca_agent_wait",
		description: "Block until an Orca worker finishes. Launch already starts a hook watcher; call this only if the user said 盯着 / 做完告诉我 and you must stay in the turn. Handoff waits on agents[].state from Orca agent Stop hooks. tui-idle is not success.",
		parameters: {
			supervise: {
				type: "boolean",
				description: "True when launch used supervise: true."
			},
			worktree: {
				type: "string",
				description: "Name, id, or path. Omit to use the latest worker."
			},
			timeoutMs: {
				type: "number",
				description: "Max wait in milliseconds. Default 900000."
			}
		},
		timeoutMs: 91e4,
		output: OBJECT_OUT,
		async execute(args, exec) {
			const ready = await withRuntime(exec.signal);
			if ("error" in ready) return ready.error;
			const { cli, capabilities } = ready.binder;
			const budget = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : 9e5;
			if (args.supervise === true) {
				if (!capabilities.includes("orchestration.contract.v1")) return {
					ok: false,
					code: "orchestration_unavailable",
					message: "Orca orchestration is not enabled. Turn on Settings → Experimental."
				};
				const checked = await orcaJson(cli, [
					"orchestration",
					"check",
					"--wait",
					"--types",
					"worker_done,escalation,question",
					"--timeout-ms",
					String(budget)
				], {
					signal: exec.signal,
					timeoutMs: budget + 1e4
				});
				if (!checked.ok) return {
					ok: false,
					code: checked.error.code,
					message: checked.error.message
				};
				return {
					ok: true,
					status: "mailbox",
					result: checked.result
				};
			}
			const row = pickRow(await psRows(cli, exec.signal), args.worktree);
			const selector = typeof row?.worktreeId === "string" ? row.worktreeId : args.worktree?.trim();
			if (!selector) return {
				ok: false,
				code: "not_found",
				message: args.worktree ? `no worktree matching ${args.worktree}` : "no Orca worktrees"
			};
			const waited = await waitForHookDone({
				cli,
				worktree: selector,
				signal: exec.signal,
				timeoutMs: budget
			});
			if (waited.status === "done" || waited.status === "interrupted") return {
				ok: true,
				...waited
			};
			return {
				ok: false,
				code: waited.status,
				message: `wait ended: ${waited.status}`,
				...waited
			};
		}
	}));
}
//#endregion
//#region src/dsh-orca-agents.ts
const name = "dsh-orca-agents";
const inject = [
	"tools",
	"skills",
	"jobs"
];
function apply(ctx) {
	console.log("[my-plugins/dsh-orca-agents] loaded");
	console.log("[my-plugins/dsh-orca-agents] nl-infer");
	registerOrcaTools(ctx);
	ctx.skills.register(orcaAgentsSkill(null));
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=dsh-orca-agents.js.map