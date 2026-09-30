import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { call, failure, login, startConnectControl, startConnectEnvironment, success } from "./support/connect-http.js";

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
    assert.ok(packedFiles.includes("docs/smoke-live.md"));
    assert.ok(packedFiles.includes("scripts/smoke-live.mjs"));
    assert.ok(packedFiles.includes("scripts/smoke-connect.mjs"));

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

    async function connect() {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(packageRoot, "dist", "index.js")],
        cwd: installDirectory,
        env: { ...process.env, ...control.env, T3_MCP_STATE_DIR: stateDirectory, NODE_NO_WARNINGS: "1" },
        stderr: "ignore",
      });
      client = new Client({ name: "installed-package-test", version: "1.0.0" });
      await client.connect(transport);
    }
    await connect();

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

    // Re-authenticate explicitly so unregistration is checked independently of sign-out.
    control.state.outage = false;
    await login(client, control);
    success(await call(client, "unregister_environment", { environmentId: "installed-attached" }));
    await client.close();
    await connect();
    assert.deepEqual(success(await call(client, "list_environments")).environments.map((entry) => entry.id), ["installed-remote"]);
    assert.equal(success(await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
    assert.equal(success(await call(client, "list_connect_environments")).environments.length, 2);
    const requestsBefore = attached.requests.length + direct.requests.length;
    for (const [name, args] of [
      ["list_projects", {}],
      ["start_turn", { projectId: "project", prompt: "must not dispatch" }],
      ["get_thread", { threadId: "removed-thread" }],
      ["continue_turn", { threadId: "removed-thread", prompt: "must not dispatch" }],
    ]) {
      failure(await call(client, name, { environmentId: "installed-attached", ...args }), "environment_not_found");
    }
    assert.equal(attached.requests.length + direct.requests.length, requestsBefore);
    success(await call(client, "list_projects", { environmentId: "installed-remote" }));

    remote.state.dispatch = (command) => command.type === "thread.turn.start" ? { drop: true } : undefined;
    const unknown = success(await call(client, "start_turn", { environmentId: "installed-remote", projectId: "project", prompt: "unknown" })).start;
    assert.equal(unknown.outcome, "unknown");
    assert.ok(unknown.threadId);
    assert.deepEqual(remote.commands.slice(3).map((command) => command.type), ["thread.create", "thread.turn.start"]);
    remote.state.dispatch = undefined;

    await t.test("installed generic Connect runner exercises explicit registration and isolated lifecycle", async () => {
      const result = await smoke("smoke-connect.mjs", { T3_MCP_CONNECT_ACTION: "register" });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /smoke_complete=true/);
      assert.match(result.output, /unregister_restart outcome=accepted/);
      assert.match(result.output, /signout_access outcome=accepted/);
      await assertSavedStateUntouched();
    });

    await t.test("installed runner attaches explicitly and keeps the direct session independent", async () => {
      const before = direct.commands.length;
      const result = await smoke("smoke-connect.mjs", { T3_MCP_CONNECT_ACTION: "attach", T3_MCP_ENDPOINT: direct.baseUrl, T3_MCP_GRANT: "direct-grant" });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /stable_attachment outcome=accepted/);
      assert.equal(direct.commands.length, before);
    });

    await t.test("runner stops after a stale completed observation rather than claiming the continuation settled", async () => {
      const before = attached.commands.length;
      attached.state.dispatch = (command, count) => count === before + 3 ? { body: { sequence: count } } : undefined;
      try {
        const result = await smoke("smoke-connect.mjs", { T3_MCP_CONNECT_ACTION: "register", T3_MCP_WAIT_MS: "100" });
        assert.equal(result.code, 1, result.output);
        assert.match(result.output, /reason=thread_timeout_unknown/);
        assert.doesNotMatch(result.output, /smoke_complete=true/);
        assert.equal(attached.commands.length - before, 3);
      } finally { attached.state.dispatch = undefined; }
    });

    await t.test("runner never replays unknown start or continuation dispatches", async () => {
      for (const offset of [2, 3]) {
        const before = attached.commands.length;
        attached.state.dispatch = (command, count) => count === before + offset ? { drop: true } : undefined;
        try {
          const result = await smoke("smoke-connect.mjs", { T3_MCP_CONNECT_ACTION: "register" });
          assert.equal(result.code, 1, result.output);
          assert.match(result.output, /reason=(start_turn|continue_turn)_unknown_do_not_replay/);
          assert.doesNotMatch(result.output, /smoke_complete=true|signout_access/);
          assert.equal(attached.commands.length - before, offset);
        } finally { attached.state.dispatch = undefined; }
      }
    });

    await t.test("runner stops at approval and input requirements without continuing", async () => {
      for (const [activities, reason] of [
        [[{ id: "approval", tone: "approval", summary: "approval", turnId: null, kind: "approval.requested", createdAt: new Date().toISOString(), payload: { requestId: "request" } }], "approval_required"],
        [[{ id: "input", tone: "info", summary: "input", turnId: null, kind: "user-input.requested", createdAt: new Date().toISOString(), payload: { requestId: "request" } }], "input_required"],
      ]) {
        const before = attached.commands.length;
        attached.state.activities = activities;
        try {
          const result = await smoke("smoke-connect.mjs", { T3_MCP_CONNECT_ACTION: "register" });
          assert.equal(result.code, 1, result.output);
          assert.match(result.output, new RegExp(`reason=${reason}`));
          assert.doesNotMatch(result.output, /smoke_complete=true|continue_turn outcome/);
          assert.equal(attached.commands.length - before, 2);
        } finally { attached.state.activities = undefined; }
      }
    });

    await t.test("runner reports the opaque OAuth registration blocker without attempting relay exchange", async () => {
      const original = control.state.accessToken;
      const exchanges = control.relayRequests.filter((request) => request.path === "/v1/client/dpop-token").length;
      control.state.accessToken = "opaque-fixture-subject";
      try {
        const result = await smoke("smoke-connect.mjs", { T3_MCP_CONNECT_ACTION: "register" });
        assert.equal(result.code, 1, result.output);
        assert.match(result.output, /reason=upstream_incompatible/);
        assert.doesNotMatch(result.output, /smoke_complete=true/);
        assert.equal(control.relayRequests.filter((request) => request.path === "/v1/client/dpop-token").length, exchanges);
      } finally { control.state.accessToken = original; }
    });

    await t.test("generic direct smoke remains Connect-free and requires explicit targets", async () => {
      const relayRequests = control.relayRequests.length;
      const result = await smoke("smoke-live.mjs", { T3_MCP_ENDPOINT: direct.baseUrl, T3_MCP_GRANT: "direct-grant" });
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /smoke_complete=true/);
      assert.equal(control.relayRequests.length, relayRequests);
      const before = direct.requests.length;
      const missing = await smoke("smoke-live.mjs", { T3_MCP_PROJECT_ID: "", T3_MCP_ENDPOINT: direct.baseUrl, T3_MCP_GRANT: "direct-grant" });
      assert.equal(missing.code, 1, missing.output);
      assert.match(missing.output, /reason=t3_mcp_project_id_required/);
      assert.equal(direct.requests.length, before);
      const missingAction = await smoke("smoke-connect.mjs", { T3_MCP_CONNECT_ACTION: "" });
      assert.equal(missingAction.code, 1, missingAction.output);
      assert.match(missingAction.output, /reason=t3_mcp_connect_action_required/);
      assert.equal(control.relayRequests.length, relayRequests);
      await assertSavedStateUntouched();
    });

    async function assertSavedStateUntouched() {
      assert.deepEqual(success(await call(client, "list_environments")).environments.map((entry) => entry.id), ["installed-remote"]);
      assert.equal(success(await call(client, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
    }

    async function smoke(script, settings = {}) {
      const child = spawn(process.execPath, [path.join(packageRoot, "scripts", script)], {
        cwd: installDirectory,
        env: { ...process.env, ...control.env,
          T3_MCP_COMMAND: path.join(installDirectory, "node_modules", ".bin", "t3-mcp"),
          T3_MCP_STATE_DIR: stateDirectory,
          T3_MCP_ENVIRONMENT_ID: "installed-attached", T3_MCP_PROJECT_ID: "project",
          T3_MCP_SANITY_CONNECT_ENVIRONMENT_ID: "installed-remote", T3_MCP_POLL_MS: "10",
          ...settings },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let buffer = "";
      const callbacks = [];
      child.stdout.on("data", (chunk) => {
        output += chunk;
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("authorization_url=")) continue;
          const fragment = new URLSearchParams(new URL(line.slice("authorization_url=".length)).hash.slice(1));
          control.authorize(fragment);
          callbacks.push(fetch(`http://127.0.0.1:${fragment.get("port")}/callback?state=${encodeURIComponent(fragment.get("state"))}&code=browser-code`));
        }
      });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      clearTimeout(timer);
      await Promise.all(callbacks);
      for (const secret of [control.state.accessToken, "fixture-refresh", "direct-grant", ...remote.sessions.keys(), ...attached.sessions.keys()]) {
        assert.equal(output.includes(secret), false, "runner output must exclude credentials");
      }
      for (const line of output.trim().split("\n")) {
        assert.ok(/^(authorization_url=https:\/\/|[a-z_]+ outcome=accepted$|smoke_complete=true$|smoke_stopped reason=[a-z0-9_]+$)/.test(line), "runner must print only public authorization URLs and safe summary codes");
      }
      return { code, output };
    }
  } finally {
    if (client) await client.close().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
