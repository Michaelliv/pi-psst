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
}

async function loadSecrets(): Promise<SecretEntry[]> {
	try {
		const vaultPath = Vault.findVaultPath();
		if (!vaultPath) return [];

		const vault = new Vault(vaultPath);
		await vault.unlock();

		const list = vault.listSecrets();
		const secrets: SecretEntry[] = [];

		for (const entry of list) {
			const value = await vault.getSecret(entry.name);
			if (value) {
				secrets.push({ name: entry.name, value });
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

	const bashTool = createBashTool(cwd);

	// Scrub secrets from all tool results
	pi.on("tool_result", async (event) => {
		const secrets = await loadSecrets();
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
			const secrets = await loadSecrets();

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
					const secrets = await loadSecrets();
					const injectedEnv: Record<string, string> = {};
					for (const secret of secrets) {
						injectedEnv[secret.name] = secret.value;
					}
					return localOps.exec(command, execCwd, {
						...options,
						env: { ...options.env, ...injectedEnv },
					});
				},
			},
		};
	});

	// Inject secret names into system prompt so the LLM knows what's available
	pi.on("before_agent_start", async (event) => {
		const secrets = await loadSecrets();
		if (secrets.length === 0) return;

		const names = secrets.map((s) => s.name).join(", ");
		const instruction = [
			"\n## psst — Secret Management",
			`Available secrets (injected as env vars in bash): ${names}`,
			"Use $SECRET_NAME in bash commands to reference secrets. Never ask the user for secret values.",
			"Secret values are automatically scrubbed from command output.",
		].join("\n");

		return { systemPrompt: event.systemPrompt + instruction };
	});

	// Command to list secrets in vault (names only, never values)
	pi.registerCommand("psst", {
		description: "Show psst vault secrets (names only)",
		handler: async (_args, ctx) => {
			const secrets = await loadSecrets();
			if (secrets.length === 0) {
				ctx.ui.notify("No psst secrets found. Run 'psst init' and 'psst set' to add secrets.", "info");
				return;
			}
			const list = secrets.map((s) => `  • ${s.name}`).join("\n");
			ctx.ui.notify(`Vault secrets:\n${list}`, "info");
		},
	});

	// Command to set a secret
	pi.registerCommand("psst-set", {
		description: "Set a secret: /psst-set NAME value",
		handler: async (args, ctx) => {
			if (!args) {
				ctx.ui.notify("Usage: /psst-set NAME value", "error");
				return;
			}

			const spaceIdx = args.indexOf(" ");
			let name: string;
			let value: string | undefined;

			if (spaceIdx === -1) {
				name = args.trim();
			} else {
				name = args.slice(0, spaceIdx).trim();
				value = args.slice(spaceIdx + 1).trim();
			}

			if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
				ctx.ui.notify(`Invalid secret name: ${name}. Must match [A-Z][A-Z0-9_]*`, "error");
				return;
			}

			if (!value) {
				value = await ctx.ui.input(`Value for ${name}:`) ?? undefined;
				if (!value) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}
			}

			try {
				const vaultPath = Vault.findVaultPath();
				if (!vaultPath) {
					ctx.ui.notify("No vault found. Run 'psst init' first.", "error");
					return;
				}
				const vault = new Vault(vaultPath);
				await vault.unlock();
				await vault.setSecret(name, value);
				vault.close();
				ctx.ui.notify(`Secret ${name} saved`, "success");
			} catch (e: any) {
				ctx.ui.notify(`Failed to set secret: ${e.message}`, "error");
			}
		},
	});
}
