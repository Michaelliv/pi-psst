/**
 * psst extension for pi
 *
 * - Injects psst vault secrets as env vars into bash commands
 * - Scrubs secret values from all tool output (bash, read, grep, etc.)
 * - Adds available secret names to the system prompt
 * - Provides /psst and /psst-set commands
 *
 * Install:
 *   pi install git:github.com/Michaelliv/pi-psst
 *   pi install npm:@miclivs/pi-psst
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import { Vault } from "psst-cli";

interface SecretEntry {
	name: string;
	value: string;
	tags: string[];
}

async function loadSecrets(filterTags?: string[]): Promise<SecretEntry[]> {
	try {
		const vaultPath = Vault.findVaultPath();
		if (!vaultPath) return [];

		const vault = new Vault(vaultPath);
		await vault.unlock();

		const list = vault.listSecrets(filterTags);
		const secrets: SecretEntry[] = [];

		for (const entry of list) {
			const value = await vault.getSecret(entry.name);
			if (value) {
				secrets.push({ name: entry.name, value, tags: entry.tags ?? [] });
			}
		}

		vault.close();
		return secrets;
	} catch {
		return [];
	}
}

function scrubOutput(text: string, secrets: SecretEntry[]): string {
	if (secrets.length === 0) return text;

	let result = text;
	const sorted = [...secrets].sort((a, b) => b.value.length - a.value.length);
	for (const secret of sorted) {
		if (secret.value.length < 4) continue;
		result = result.replaceAll(secret.value, `[REDACTED:${secret.name}]`);
	}
	return result;
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// Active tag filter — when set, only secrets matching these tags are loaded.
	// Cleared by /psst-tag with no args.
	let activeTags: string[] = [];

	const getSecretsForSession = () => loadSecrets(activeTags.length > 0 ? activeTags : undefined);

	const bashTool = createBashTool(cwd);

	// Scrub secrets from all tool results
	pi.on("tool_result", async (event) => {
		const secrets = await getSecretsForSession();
		if (secrets.length === 0) return;

		const scrubbed = event.content.map((c: any) =>
			c.type === "text" ? { ...c, text: scrubOutput(c.text, secrets) } : c,
		);

		return { content: scrubbed };
	});

	// Override built-in bash to inject secrets as env vars
	pi.registerTool({
		...bashTool,
		description: bashTool.description + "\n\nSecrets from psst vault are automatically injected as environment variables.",
		async execute(id, params, signal, onUpdate, ctx) {
			const secrets = await getSecretsForSession();

			const injectedBash = createBashTool(cwd, {
				spawnHook: ({ command, cwd, env }) => {
					const injectedEnv = { ...env };
					for (const secret of secrets) {
						injectedEnv[secret.name] = secret.value;
					}
					return { command, cwd, env: injectedEnv };
				},
			});

			return injectedBash.execute(id, params, signal, onUpdate);
		},
	});

	// Inject secrets into user ! commands too
	pi.on("user_bash", () => {
		const localOps = createLocalBashOperations();
		return {
			operations: {
				exec: async (command: string, execCwd: string, options: any) => {
					const secrets = await getSecretsForSession();
					const injectedEnv: Record<string, string> = {};
					for (const secret of secrets) {
						injectedEnv[secret.name] = secret.value;
					}
					return localOps.exec(command, execCwd, {
						...options,
						env: { ...process.env, ...options.env, ...injectedEnv },
					});
				},
			},
		};
	});

	// Inject secret names into system prompt so the LLM knows what's available
	pi.on("before_agent_start", async (event) => {
		const secrets = await getSecretsForSession();
		if (secrets.length === 0) return;

		const names = secrets.map((s) => s.name).join(", ");
		const tagNote = activeTags.length > 0 ? ` (filtered by tags: ${activeTags.join(", ")})` : "";
		const instruction = [
			"\n## psst — Secret Management",
			`Available secrets (injected as env vars in bash)${tagNote}: ${names}`,
			"Use $SECRET_NAME in bash commands to reference secrets. Never ask the user for secret values.",
			"Secret values are automatically scrubbed from command output.",
		].join("\n");

		return { systemPrompt: event.systemPrompt + instruction };
	});

	// Command to list secrets in vault (names only, never values)
	pi.registerCommand("psst-list", {
		description: "Show psst vault secrets with tags",
		handler: async (_args, ctx) => {
			const secrets = await getSecretsForSession();
			if (secrets.length === 0) {
				const hint = activeTags.length > 0
					? `No secrets matching tags: ${activeTags.join(", ")}`
					: "No psst secrets found. Run 'psst init' and 'psst set' to add secrets.";
				ctx.ui.notify(hint, "info");
				return;
			}

			const tagNote = activeTags.length > 0 ? ` (filtered by: ${activeTags.join(", ")})` : "";
			const formatLine = (s: SecretEntry) => {
				const tagStr = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
				return `  • ${s.name}${tagStr}`;
			};
			const list = secrets.map(formatLine).join("\n");
			ctx.ui.notify(`Vault secrets${tagNote}:\n${list}`, "info");

			// Also let the model see the list on the next turn
			const modelList = secrets
				.map((s) => (s.tags.length > 0 ? `${s.name} [${s.tags.join(", ")}]` : s.name))
				.join(", ");
			pi.sendMessage(
				{
					customType: "psst-event",
					content: `User listed psst vault secrets${tagNote}: ${modelList}.`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});

	// Command to set or clear the active tag filter
	pi.registerCommand("psst-tag", {
		description: "Filter loaded secrets by tag(s): /psst-tag [tag1,tag2] (no args = clear)",
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();

			if (!raw) {
				activeTags = [];
				ctx.ui.notify("psst: tag filter cleared", "info");
				pi.sendMessage(
					{
						customType: "psst-event",
						content: "User cleared the psst tag filter — all vault secrets are now available.",
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
				return;
			}

			activeTags = raw
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);

			const matched = await getSecretsForSession();
			ctx.ui.notify(
				`psst: filtering by [${activeTags.join(", ")}] — ${matched.length} secret(s) match`,
				"success",
			);
			pi.sendMessage(
				{
					customType: "psst-event",
					content: `User set psst tag filter to [${activeTags.join(", ")}]. ${matched.length} secret(s) now available: ${matched.map((s) => s.name).join(", ") || "(none)"}.`,
					display: true,
				},
				{ deliverAs: "nextTurn" },
			);
		},
	});

	// Command to set a secret — supports inline args or interactive prompts
	// Usage: /psst-set [NAME] [value] [tag1,tag2,...]
	pi.registerCommand("psst-set", {
		description: "Set a secret: /psst-set [NAME] [value] [tags]",
		handler: async (args, ctx) => {
			// Parse positional args: name, value, tags
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			let name = parts[0];
			let value = parts[1];
			let tagsRaw = parts[2];

			// Prompt for missing fields
			if (!name) {
				name = (await ctx.ui.input("Secret name (e.g. API_KEY):")) ?? "";
				if (!name) return ctx.ui.notify("Cancelled", "info");
			}

			if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
				return ctx.ui.notify(`Invalid name: ${name}. Must match [A-Z][A-Z0-9_]*`, "error");
			}

			if (!value) {
				value = (await ctx.ui.input(`Value for ${name}:`)) ?? "";
				if (!value) return ctx.ui.notify("Cancelled", "info");
			}

			if (tagsRaw === undefined) {
				tagsRaw = (await ctx.ui.input("Tags (comma-separated, optional):")) ?? "";
			}

			const tags = tagsRaw
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean);

			try {
				const vaultPath = Vault.findVaultPath();
				if (!vaultPath) {
					return ctx.ui.notify("No vault found. Run 'psst init' first.", "error");
				}
				const vault = new Vault(vaultPath);
				await vault.unlock();
				await vault.setSecret(name, value, tags.length > 0 ? tags : undefined);
				vault.close();

				const tagSuffix = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
				ctx.ui.notify(`Secret ${name} saved${tagSuffix}`, "success");

				// Tell the model about it on the next turn (no trigger)
				pi.sendMessage(
					{
						customType: "psst-event",
						content: `User added secret ${name}${tagSuffix} to the psst vault.`,
						display: true,
					},
					{ deliverAs: "nextTurn" },
				);
			} catch (e: any) {
				ctx.ui.notify(`Failed to set secret: ${e.message}`, "error");
			}
		},
	});
}
