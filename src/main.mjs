import { loadConfig } from "./config.mjs";
import { runHookFromStdin } from "./hook.mjs";
import { runListener } from "./listener.mjs";

const config = loadConfig();
const mode = process.argv[2] || "help";

if (mode === "hook") {
  await runHookFromStdin(config);
} else if (mode === "listener") {
  await runListener(config);
} else {
  process.stderr.write(
    "Usage: node src/main.mjs <hook|listener>\n" +
      "  hook      Read one Codex hook JSON object from stdin\n" +
      "  listener  Consume Feishu message and bot-menu events\n",
  );
  process.exitCode = 2;
}
