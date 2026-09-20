import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

test("runs the packed package through the public MCP seam", { timeout: 120_000 }, async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-package-"));
  const packDirectory = path.join(temporaryDirectory, "pack");
  const installDirectory = path.join(temporaryDirectory, "install");
  const stateDirectory = path.join(temporaryDirectory, "state");
  const packageRoot = path.join(installDirectory, "node_modules", "t3-mcp");
  let client;

  try {
    await mkdir(packDirectory);
    const packed = JSON.parse(
      (
        await run(npm, ["pack", "--json", "--pack-destination", packDirectory], {
          cwd: process.cwd(),
        })
      ).stdout,
    )[0];
    const packedFiles = packed.files.map(({ path: filePath }) => filePath.replace(/^package\//, ""));
    assert.ok(packedFiles.includes("dist/index.js"));
    assert.deepEqual(
      packedFiles.filter((filePath) => filePath.startsWith("skills/") && filePath.endsWith("SKILL.md")),
      ["skills/t3-run-turn/SKILL.md"],
    );
    assert.ok(packedFiles.includes("docs/compatibility.md"));

    await run(
      npm,
      [
        "install",
        "--prefix",
        installDirectory,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        path.join(packDirectory, packed.filename),
      ],
      { cwd: process.cwd() },
    );

    const skill = await readFile(path.join(packageRoot, "skills", "t3-run-turn", "SKILL.md"), "utf8");
    for (const toolName of [
      "add_environment",
      "list_environments",
      "list_projects",
      "start_turn",
      "continue_turn",
      "get_thread",
    ]) {
      assert.match(skill, new RegExp(`\\b${toolName}\\b`));
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageRoot, "dist", "index.js")],
      cwd: installDirectory,
      env: { ...process.env, T3_MCP_STATE_DIR: stateDirectory, NODE_NO_WARNINGS: "1" },
      stderr: "ignore",
    });
    client = new Client({ name: "installed-package-test", version: "1.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    const expectedArguments = {
      add_environment: ["endpoint", "environmentId", "grant", "label", "pairingUrl"],
      continue_turn: ["environmentId", "prompt", "threadId"],
      get_thread: ["beforeCursor", "environmentId", "threadId", "turnLimit"],
      list_environments: [],
      list_projects: ["environmentId"],
      start_turn: ["environmentId", "modelSelection", "projectId", "prompt"],
    };
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      Object.keys(expectedArguments).sort(),
    );
    for (const [toolName, arguments_] of Object.entries(expectedArguments)) {
      assert.deepEqual(
        Object.keys(tools.tools.find((tool) => tool.name === toolName).inputSchema.properties ?? {}).sort(),
        arguments_,
      );
    }

    const environments = await client.callTool({ name: "list_environments", arguments: {} });
    assert.deepEqual(environments.structuredContent ?? JSON.parse(environments.content[0].text), {
      environments: [],
    });
  } finally {
    if (client) await client.close().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
