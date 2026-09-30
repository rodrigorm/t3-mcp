import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { add, call, connectControl, failure, fixture, login, saved, success } from "./support/unregister-fixture.js";

test("unregistration wins over an in-flight direct re-pair and stays removed after restart", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const [a, b] = f.environments;
  const { client } = await f.client();
  success(await add(client, a));
  success(await add(client, b));
  const pause = f.pause(a, "repair");
  const repair = add(client, a, "repair", { environmentId: "a" });
  await pause.entered;
  success(await call(client, "unregister_environment", { environmentId: "a" }));
  pause.release();
  failure(await repair, "environment_not_found");
  assert.deepEqual((await saved(client)).map((entry) => entry.id), ["b"]);
  await client.close();
  const restarted = (await f.client()).client;
  assert.deepEqual((await saved(restarted)).map((entry) => entry.id), ["b"]);
  failure(await call(restarted, "list_projects", { environmentId: "a" }), "environment_not_found");
  assert.deepEqual(success(await call(restarted, "list_projects", { environmentId: "b" })).projects,
    [{ id: "project-b", name: "b" }]);
});

test("the installed package unregisters direct access and keeps another registration usable after restart", { timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const [a, b] = f.environments;
  const packDirectory = path.join(f.directory, "pack");
  const installDirectory = path.join(f.directory, "install");
  await mkdir(packDirectory);
  const run = promisify(execFile);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = JSON.parse((await run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory])).stdout)[0];
  await run(npm, ["install", "--prefix", installDirectory, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
    path.join(packDirectory, packed.filename)]);
  const packageRoot = path.join(installDirectory, "node_modules", "t3-mcp");
  const readme = await readFile(path.join(packageRoot, "README.md"), "utf8");
  assert.match(readme, /unregister_environment/);
  assert.match(readme, /does not revoke.*upstream/s);
  const entry = path.join(packageRoot, "dist", "index.js");
  const { client } = await f.client({}, entry);
  success(await add(client, a));
  success(await add(client, b));
  success(await call(client, "unregister_environment", { environmentId: "a" }));
  await client.close();
  const restarted = (await f.client({}, entry)).client;
  assert.deepEqual((await saved(restarted)).map((environment) => environment.id), ["b"]);
  failure(await call(restarted, "list_projects", { environmentId: "a" }), "environment_not_found");
  assert.deepEqual(success(await call(restarted, "list_projects", { environmentId: "b" })).projects,
    [{ id: "project-b", name: "b" }]);
});

test("direct unregistration validates targets, removes only local access, and survives restart", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const [a, b] = f.environments;
  const { client, stderr } = await f.client();
  const tool = (await client.listTools()).tools.find((entry) => entry.name === "unregister_environment");
  assert.deepEqual(tool.inputSchema.required, ["environmentId"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["environmentId"]);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.outputSchema.properties.unregistered.const, true);
  for (const args of [{}, { environmentId: "" }, { environmentId: " " }, { environmentId: 42 }]) {
    assert.equal((await call(client, "unregister_environment", args)).isError, true);
  }
  failure(await call(client, "unregister_environment", { environmentId: "missing" }), "environment_not_found");
  success(await add(client, a));
  success(await add(client, b));
  const before = await saved(client);
  const hits = a.requests.length;
  assert.deepEqual(success(await call(client, "unregister_environment", { environmentId: " a " })),
    { environmentId: "a", unregistered: true });
  assert.equal(a.requests.length, hits);
  // The upstream session is still valid. The connector only forgets its local access.
  const upstream = await fetch(`${a.baseUrl}/api/orchestration/snapshot`, {
    headers: { authorization: "Bearer session-a-direct" },
  });
  assert.equal(upstream.status, 200);
  failure(await call(client, "unregister_environment", { environmentId: "a" }), "environment_not_found");
  await client.close();
  const restarted = (await f.client()).client;
  assert.deepEqual(await saved(restarted), before.filter((entry) => entry.id === "b"));
  for (const [name, extra] of [
    ["list_projects", {}], ["get_thread", { threadId: "thread" }],
    ["start_turn", { projectId: "project", prompt: "Work" }],
    ["continue_turn", { threadId: "thread", prompt: "Continue" }],
  ]) {
    failure(await call(restarted, name, { environmentId: "a", ...extra }), "environment_not_found");
  }
  assert.deepEqual(success(await call(restarted, "list_projects", { environmentId: "b" })).projects,
    [{ id: "project-b", name: "b" }]);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(f.directory, "environments.json"))).mode & 0o777, 0o600);
  assert.equal(stderr().includes("session-a-direct"), false);
  assert.equal(stderr().includes("session-b-direct"), false);
});

test("unregistration preserves working legacy version-one direct registrations", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const [a, b] = f.environments;
  const { client } = await f.client();
  success(await add(client, a));
  success(await add(client, b));
  await client.close();
  const file = path.join(f.directory, "environments.json");
  // Seed the saved-state format used before optional Connect access was added.
  const legacy = JSON.parse(await readFile(file, "utf8"));
  for (const registration of Object.values(legacy.environments)) {
    delete registration.accessSource;
    delete registration.directAccess;
  }
  await writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
  const restarted = (await f.client()).client;
  const before = await saved(restarted);
  success(await call(restarted, "unregister_environment", { environmentId: "a" }));
  await restarted.close();
  const afterRemoval = (await f.client()).client;
  assert.deepEqual(await saved(afterRemoval), before.filter((entry) => entry.id === "b"));
  failure(await call(afterRemoval, "list_projects", { environmentId: "a" }), "environment_not_found");
  assert.deepEqual(success(await call(afterRemoval, "list_projects", { environmentId: "b" })).projects,
    [{ id: "project-b", name: "b" }]);
});

test("unregistration removes a registration with both access paths while preserving Connect login", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const [a, b] = f.environments;
  const env = await connectControl(t, f.environments);
  const { client } = await f.client(env);
  success(await add(client, a));
  success(await add(client, b));
  await login(client);
  assert.equal(success(await call(client, "attach_connect_environment", {
    environmentId: "a", targetEnvironmentId: "a",
  })).environment.connectAttached, true);
  success(await call(client, "unregister_environment", { environmentId: "a" }));
  await client.close();
  const restarted = (await f.client(env)).client;
  assert.deepEqual((await saved(restarted)).map((entry) => entry.id), ["b"]);
  failure(await call(restarted, "list_projects", { environmentId: "a" }), "environment_not_found");
  assert.equal(success(await call(restarted, "connect_authenticate", { action: "status" })).authentication.status, "authenticated");
  assert.deepEqual(success(await call(restarted, "list_connect_environments")).environments.map((entry) => entry.id), ["a", "b"]);
  assert.deepEqual(success(await call(restarted, "list_projects", { environmentId: "b" })).projects,
    [{ id: "project-b", name: "b" }]);
});

test("attachment preserves an unrelated removal and addition while its exchange is paused", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, ["a", "b", "c"]);
  const [a, b, c] = f.environments;
  const env = await connectControl(t, f.environments);
  const { client } = await f.client(env);
  success(await add(client, a));
  success(await add(client, b));
  await login(client);
  const pause = f.pause(a, "connect-a");
  const attachment = call(client, "attach_connect_environment", { environmentId: "a", targetEnvironmentId: "a" });
  await pause.entered;
  success(await call(client, "unregister_environment", { environmentId: "b" }));
  success(await add(client, c));
  pause.release();
  assert.equal(success(await attachment).environment.connectAttached, true);
  assert.deepEqual((await saved(client)).map((entry) => entry.id), ["a", "c"]);
  await client.close();
  const restarted = (await f.client(env)).client;
  assert.deepEqual((await saved(restarted)).map((entry) => entry.id), ["a", "c"]);
  failure(await call(restarted, "list_projects", { environmentId: "b" }), "environment_not_found");
  for (const id of ["a", "c"]) {
    assert.deepEqual(success(await call(restarted, "list_projects", { environmentId: id })).projects,
      [{ id: `project-${id}`, name: id }]);
  }
});

for (const operation of ["attachment", "re-pair"]) {
  for (const change of ["re-pair", "remove and re-register"]) {
    test(`${operation} rejects a target changed by ${change} during the exchange`, { timeout: 60_000 }, async (t) => {
      const f = await fixture(t, ["a"]);
      const [a] = f.environments;
      const env = operation === "attachment" ? await connectControl(t, f.environments) : {};
      const { client, stderr } = await f.client(env);
      success(await add(client, a));
      if (operation === "attachment") await login(client);
      const grant = operation === "attachment" ? "connect-a" : "stale-repair";
      const pause = f.pause(a, grant);
      const pending = operation === "attachment"
        ? call(client, "attach_connect_environment", { environmentId: "a", targetEnvironmentId: "a" })
        : add(client, a, grant, { environmentId: "a", label: "stale" });
      await pause.entered;
      if (change === "remove and re-register") {
        success(await call(client, "unregister_environment", { environmentId: "a" }));
        success(await add(client, a, "direct", { label: "replacement" }));
      } else {
        success(await add(client, a, "new-repair", { environmentId: "a", label: "replacement" }));
      }
      const replacement = await saved(client);
      pause.release();
      const rejected = await pending;
      failure(rejected, "environment_conflict");
      assert.equal(JSON.stringify(rejected).includes(`session-a-${grant}`), false);
      assert.equal(stderr().includes(`session-a-${grant}`), false);
      assert.deepEqual(await saved(client), replacement);
      assert.deepEqual(success(await call(client, "list_projects", { environmentId: "a" })).projects,
        [{ id: "project-a", name: "a" }]);
    });
  }
}

test("simultaneous direct registrations and removals commit without losing independent changes", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, ["a", "b", "c", "d", "e", "f"]);
  const { client } = await f.client();
  for (const environment of f.environments.slice(3)) success(await add(client, environment));
  const additions = f.environments.slice(0, 3);
  const pauses = additions.map((environment) => f.pause(environment, "direct"));
  const pending = additions.map((environment) => add(client, environment));
  await Promise.all(pauses.map((pause) => pause.entered));
  const removals = ["d", "e", "f"].map((environmentId) => call(client, "unregister_environment", { environmentId }));
  pauses.forEach((pause) => pause.release());
  (await Promise.all([...pending, ...removals])).forEach(success);
  assert.deepEqual((await saved(client)).map((entry) => entry.id), ["a", "b", "c"]);
});

test("a concurrent Connect registration cannot overwrite a new direct registration with the same identity", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, ["a"]);
  const [a] = f.environments;
  const env = await connectControl(t, f.environments);
  const { client } = await f.client(env);
  await login(client);
  const pause = f.pause(a, "connect-a");
  const registration = call(client, "register_connect_environment", { environmentId: "a" });
  await pause.entered;
  success(await add(client, a));
  const before = await saved(client);
  pause.release();
  failure(await registration, "environment_exists");
  assert.deepEqual(await saved(client), before);
});

test("storage failures during removal and re-pair preserve registrations and return sanitized errors", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const [a, b] = f.environments;
  const { client, stderr } = await f.client();
  success(await add(client, a));
  success(await add(client, b));
  const before = await saved(client);
  const file = path.join(f.directory, "environments.json");
  const original = await readFile(file, "utf8");
  // Unsafe permissions are rejected before any local removal.
  await chmod(file, 0o644);
  const denied = await call(client, "unregister_environment", { environmentId: "a" });
  failure(denied, "storage_error");
  await chmod(file, 0o600);
  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(await saved(client), before);

  const pause = f.pause(a, "failed-repair");
  const repair = add(client, a, "failed-repair", { environmentId: "a" });
  await pause.entered;
  // Make the configured storage directory unavailable at the filesystem boundary.
  const backup = `${f.directory}-backup`;
  await rename(f.directory, backup);
  await writeFile(f.directory, "unavailable", { mode: 0o600 });
  let failed;
  try {
    pause.release();
    failed = await repair;
    failure(failed, "storage_error");
    failure(await call(client, "unregister_environment", { environmentId: "b" }), "storage_error");
  } finally {
    await rm(f.directory, { force: true });
    await rename(backup, f.directory);
  }
  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(await saved(client), before);
  for (const result of [denied, failed]) {
    for (const secret of [f.directory, "session-a-direct", "session-b-direct", "failed-repair", "session-a-failed-repair"]) {
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(stderr().includes(secret), false);
    }
  }
  // Failed persistence does not poison the mutation queue.
  success(await call(client, "unregister_environment", { environmentId: "a" }));
  await client.close();
  const restarted = (await f.client()).client;
  assert.deepEqual(await saved(restarted), before.filter((entry) => entry.id === "b"));
  assert.deepEqual(success(await call(restarted, "list_projects", { environmentId: "b" })).projects,
    [{ id: "project-b", name: "b" }]);
});

test("parallel direct and Connect registrations retain independent additions and unrelated removal", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t, ["a", "b", "c", "d"]);
  const [a, b, c, d] = f.environments;
  const env = await connectControl(t, f.environments);
  const { client } = await f.client(env);
  success(await add(client, d));
  await login(client);
  const pauses = [f.pause(a, "connect-a"), f.pause(b, "connect-b"), f.pause(c, "direct")];
  const registrations = [call(client, "register_connect_environment", { environmentId: "a" }),
    call(client, "register_connect_environment", { environmentId: "b" }), add(client, c)];
  await Promise.all(pauses.map((pause) => pause.entered));
  success(await call(client, "unregister_environment", { environmentId: "d" }));
  for (const index of [2, 0, 1]) {
    pauses[index].release();
    success(await registrations[index]);
  }
  assert.deepEqual((await saved(client)).map((entry) => entry.id), ["a", "b", "c"]);
  await client.close();
  const restarted = (await f.client(env)).client;
  assert.deepEqual((await saved(restarted)).map((entry) => entry.id), ["a", "b", "c"]);
  for (const id of ["a", "b", "c"]) {
    assert.deepEqual(success(await call(restarted, "list_projects", { environmentId: id })).projects,
      [{ id: `project-${id}`, name: id }]);
  }
  failure(await call(restarted, "list_projects", { environmentId: "d" }), "environment_not_found");
});

test("unregistration wins over an in-flight Connect attachment without signing out", { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const [a, b] = f.environments;
  const env = await connectControl(t, f.environments);
  const { client } = await f.client(env);
  success(await add(client, a));
  success(await add(client, b));
  await login(client);
  const pause = f.pause(a, "connect-a");
  const attachment = call(client, "attach_connect_environment", { environmentId: "a", targetEnvironmentId: "a" });
  await pause.entered;
  success(await call(client, "unregister_environment", { environmentId: "a" }));
  pause.release();
  failure(await attachment, "environment_not_found");
  assert.deepEqual((await saved(client)).map((entry) => entry.id), ["b"]);
  assert.equal(success(await call(client, "list_connect_environments")).environments.length, 2);
  await client.close();
  const restarted = (await f.client(env)).client;
  assert.deepEqual((await saved(restarted)).map((entry) => entry.id), ["b"]);
  failure(await call(restarted, "list_projects", { environmentId: "a" }), "environment_not_found");
  assert.deepEqual(success(await call(restarted, "list_projects", { environmentId: "b" })).projects,
    [{ id: "project-b", name: "b" }]);
});
