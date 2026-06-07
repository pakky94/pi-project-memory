import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, loadStores } from "./config.ts";

export default function (pi: ExtensionAPI) {
  // Load config on startup
  // cwd is not available at extension load time directly,
  // but we can get it from session_start events.
  // For now, just verify the module loads correctly.

  // We register a simple diagnostic command
  pi.registerCommand("memory", {
    description: "Manage project memory. Subcommands: refresh, status, rebuild",
    handler: async (args, ctx) => {
      const parts = (args || "").trim().split(/\s+/);
      const subcmd = parts[0] || "status";

      if (subcmd === "status") {
        const stores = loadStores(ctx.cwd);
        if (stores.length === 0) {
          ctx.ui.notify(
            "No memory stores configured. Create memory.config.json or .pi/memory.json",
            "warning",
          );
          return;
        }

        const lines = stores.map(
          (s) => `  ${s.name}: ${s.path}`,
        );
        ctx.ui.notify(
          `Memory stores (${stores.length}):\n${lines.join("\n")}`,
          "info",
        );
      } else {
        ctx.ui.notify(`Unknown subcommand: ${subcmd}. Use: status`, "warning");
      }
    },
  });
}