import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { call, login, startConnectControl, startConnectEnvironment, success } from "./support/connect-http.js";

const run = promisify(execFile);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

test("runs the packed package through explicit Connect registration, attachment and turn workflows", { timeout: 120_000 }, async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "t3-mcp-package-"));
  const packDirectory = path.join(temporaryDirectory, "pack");
  const installDirectory = path.join(temporaryDirectory, "install");
  const stateDirectory = path.join(temporaryDirectory, "state");
  const packageRoot = path.join(installDirectory, "node_modules", "t3-mcp");
  let client;
  const remote = await startConnectEnvironment("installed-remote");
  const direct = await startConnectEnvironment("installed-attached", { label: "Direct" });
  const attached = await startConnectEnvironment("installed-attached", { label: "Connect" });
  const control = await startConnectControl([remote, attached]);
  t.after(async () => { await control.close(); await remote.close(); await direct.close(); await attached.close(); });

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
    assert.ok(packedFiles.includes("docs/connect-auth-contract.md"));
    assert.ok(packedFiles.includes("docs/connect-registration-contract.md"));

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
      "attach_connect_environment",
      "connect_authenticate",
      "list_environments",
      "list_connect_environments",
      "list_projects",
      "register_connect_environment",
      "sign_out_connect",
      "start_turn",
      "continue_turn",
      "get_thread",
      "unregister_environment",
    ]) {
      assert.match(skill, new RegExp(`\\b${toolName}\\b`));
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(packageRoot, "dist", "index.js")],
      cwd: installDirectory,
      env: { ...process.env, ...control.env, T3_MCP_STATE_DIR: stateDirectory, NODE_NO_WARNINGS: "1" },
      stderr: "ignore",
    });
    client = new Client({ name: "installed-package-test", version: "1.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    const expectedArguments = {
      add_environment: ["endpoint", "environmentId", "grant", "label", "pairingUrl"],
      attach_connect_environment: ["environmentId", "label", "targetEnvironmentId"],
      connect_authenticate: ["action"],
      continue_turn: ["environmentId", "prompt", "threadId"],
      get_thread: ["beforeCursor", "environmentId", "threadId", "turnLimit"],
      list_connect_environments: [],
      list_environments: [],
      list_projects: ["environmentId"],
      register_connect_environment: ["environmentId", "label"],
      sign_out_connect: [],
      start_turn: ["environmentId", "modelSelection", "projectId", "prompt"],
      unregister_environment: ["environmentId"],
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
    const paired = success(await call(client, "add_environment", { endpoint: direct.baseUrl, grant: "direct-grant" })).environment;
    await login(client, control);
    success(await call(client, "list_connect_environments"));
    assert.deepEqual(success(await call(client, "list_environments")).environments, [paired]);
    success(await call(client, "register_connect_environment", { environmentId: "installed-remote" }));
    const attachment = success(await call(client, "attach_connect_environment", {
      environmentId: "installed-attached", targetEnvironmentId: paired.id,
    })).environment;
    assert.equal(attachment.id, paired.id);
    assert.equal(attachment.label, paired.label);
    assert.equal(attachment.source, "connect");
    assert.equal(attachment.connectAttached, true);
    assert.deepEqual(success(await call(client, "list_environments")).environments.map((entry) => entry.id),
      ["installed-attached", "installed-remote"]);
    success(await call(client, "sign_out_connect"));
    control.state.outage = true;
    for (const [environmentId, name] of [["installed-remote", "installed-remote"], ["installed-attached", "Connect"]]) {
      assert.deepEqual(success(await call(client, "list_projects", { environmentId })).projects,
        [{ id: "project", name }]);
      const start = success(await call(client, "start_turn", { environmentId, projectId: "project", prompt: "first" })).start;
      assert.equal(start.environmentId, environmentId);
      assert.equal(start.outcome, "acknowledged");
      const read = success(await call(client, "get_thread", { environmentId, threadId: start.threadId })).thread;
      assert.equal(read.status, "completed");
      assert.equal(read.messages.at(-1).text, "result 1");
      const continuation = success(await call(client, "continue_turn", { environmentId, threadId: start.threadId, prompt: "second" })).continuation;
      assert.equal(continuation.outcome, "acknowledged");
      assert.equal(continuation.threadId, start.threadId);
      assert.equal(success(await call(client, "get_thread", { environmentId, threadId: start.threadId })).thread.messages.at(-1).text, "result 2");
    }
    assert.equal(direct.commands.length, 0);
    for (const environment of [remote, attached]) {
      assert.deepEqual(environment.commands.map((command) => command.type), ["thread.create", "thread.turn.start", "thread.turn.start"]);
    }
  } finally {
    if (client) await client.close().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
