import { createBrainClient } from "./brain-client";
import { loadConfig, needsConfirm } from "./config";
import { AgentJobs } from "./jobs";
import { buildContext, loadPlugins } from "./plugins";
import { createResolutionTable } from "./resolution";
import { routeLine } from "./router";

export async function runOverlay() {
	const shell = Bun.env.SHELL ?? "/bin/sh";
	if (!Bun.which("script")) {
		console.error(
			"dwim: the 'script' command is required to wrap your shell but was not found.",
		);
		process.exit(1);
	}
	const table = await createResolutionTable();
	const config = await loadConfig();
	const brain = createBrainClient({
		provider: config.provider,
		model: config.model,
	});
	const plugins = await loadPlugins(config.plugins);
	const jobs = new AgentJobs();
	const history: string[] = [];
	let line = "";
	let output = "";
	let childActive = false;
	let pendingRun: string | null = null;

	const child = Bun.spawn(
		process.platform === "linux"
			? ["script", "-qfc", shell, "/dev/null"]
			: ["script", "-q", "/dev/null", shell],
		{
			cwd: process.cwd(),
			env: process.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	process.stdin.setRawMode?.(true);
	process.stdin.resume();
	pump(child.stdout, (data) => {
		// Pass keystrokes straight through while a full-screen child (vim, less,
		// ssh+TUI) owns the alternate screen — never route its input to the brain.
		if (
			data.includes("[?1049h") ||
			data.includes("[?1047h") ||
			data.includes("[?47h")
		)
			childActive = true;
		if (
			data.includes("[?1049l") ||
			data.includes("[?1047l") ||
			data.includes("[?47l")
		)
			childActive = false;
		output = (output + data).slice(-12000);
		process.stdout.write(data);
	});
	pump(child.stderr, (data) => process.stderr.write(data));

	// Restore the terminal and tear down children on any exit path — otherwise
	// quitting leaves the parent terminal stuck in raw mode.
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		try {
			process.stdin.setRawMode?.(false);
		} catch {}
		brain.close();
		child.kill();
	};
	child.exited.then(() => {
		cleanup();
		process.exit(0);
	});
	process.on("exit", cleanup);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});

	process.stdin.on("data", async (chunk: Buffer) => {
		const text = chunk.toString("utf8");
		if (text === "\u0003" || text === "\u0004" || text === "\u001a") {
			child.stdin.write(text);
			return;
		}
		if (text === "\r") {
			if (handleInternalCommand(line, jobs, child.stdin)) {
				line = "";
				return;
			}
			const decision = routeLine(line, table, childActive);

			// Ambiguous = resolves but reads like prose. Never auto-run, never send
			// it to the brain. First Enter holds the line; a second Enter runs it.
			if (decision.kind === "ambiguous" && pendingRun !== line) {
				pendingRun = line;
				process.stdout.write(
					`\n⚠ dwim: ambiguous — Enter again to run as a command, or edit the line.\n`,
				);
				return;
			}
			pendingRun = null;
			history.push(line);
			await Promise.all(
				plugins.map((plugin) =>
					plugin.observeShellEvent?.({ type: "command", value: line }),
				),
			);
			if (decision.kind === "intent") {
				child.stdin.write("\u0015");
				process.stdout.write("\r\n");
				const context = await buildContext(
					{ cwd: process.cwd(), history, lastOutput: output },
					plugins,
				);
				const request = {
					type: "prompt" as const,
					message: decision.line,
					context,
					mode: decision.mode,
				};
				if (decision.mode === "agent") {
					const job = jobs.start(decision.line);
					line = "";
					process.stdout.write(`[dwim ${job.id}] started\n`);
					brain
						.ask(request, async (event) => {
							if (event.type === "text") jobs.append(job.id, event.text);
							if (event.type === "proposal") jobs.append(job.id, event.command);
							if (event.type === "error") jobs.finish(job.id, "error");
							if (event.type === "done") {
								jobs.finish(job.id);
								process.stdout.write(
									`\n[dwim ${job.id}] done; run dwim fg ${job.id}\n`,
								);
							}
						})
						.catch((error) => {
							jobs.finish(job.id, "error");
							process.stdout.write(
								`\n[dwim ${job.id}] error: ${error instanceof Error ? error.message : String(error)}\n`,
							);
						});
					return;
				}
				await brain.ask(request, async (event) => {
					if (event.type === "text") process.stdout.write(event.text);
					if (event.type === "proposal") {
						const command = await applyPostProcess(event.command, plugins);
						if (needsConfirm(command, config))
							process.stdout.write(
								`⚠ dwim: review this command before running.\n`,
							);
						line = command;
						child.stdin.write(line);
					}
					if (event.type === "error")
						process.stdout.write(`dwim error: ${event.message}\n`);
				});
				return;
			}
			line = "";
			child.stdin.write("\r");
			await table.refresh();
			return;
		}
		if (text === "\u007f") line = line.slice(0, -1);
		else if (!text.startsWith("\u001b")) line += text;
		child.stdin.write(text);
	});
}

function handleInternalCommand(
	line: string,
	jobs: AgentJobs,
	stdin: { write: (data: string) => void },
) {
	const trimmed = line.trim();
	if (trimmed === "dwim jobs") {
		stdin.write("\u0015");
		process.stdout.write(
			`\r\n${jobs
				.list()
				.map((job) => `[${job.id}] ${job.status} ${job.prompt}`)
				.join("\n")}\n`,
		);
		return true;
	}
	const match = trimmed.match(/^dwim fg (\d+)$/);
	if (match) {
		stdin.write("\u0015");
		const job = jobs.get(Number(match[1]));
		process.stdout.write(`\r\n${job?.output ?? "no such dwim job"}\n`);
		return true;
	}
	return false;
}

async function pump(
	stream: ReadableStream<Uint8Array>,
	write: (data: string) => void,
) {
	const decoder = new TextDecoder();
	for await (const chunk of stream) write(decoder.decode(chunk));
}

async function applyPostProcess(
	command: string,
	plugins: Awaited<ReturnType<typeof loadPlugins>>,
) {
	let next = command;
	for (const plugin of plugins)
		next = (await plugin.postProcessProposal?.(next)) ?? next;
	return next;
}
