import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_SETTINGS } from "../../src/config.js";
import type { RuntimeSettings } from "../../src/config.js";
import { RuntimeConfigWatcher, RuntimeSettingsHolder } from "../../src/adapters/runtime-config.js";
import { RecordingLogger } from "../support/fakes.js";

describe("RuntimeSettingsHolder", () => {
  it("hands out the quoting settings and copies what it is given", () => {
    const holder = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
    expect(holder.current()).toEqual(DEFAULT_RUNTIME_SETTINGS.quoting);
    const next: RuntimeSettings = { logLevel: "debug", quoting: { ...DEFAULT_RUNTIME_SETTINGS.quoting, enabled: false } };
    holder.set(next);
    next.quoting.enabled = true;
    expect(holder.current().enabled).toBe(false);
    expect(holder.get().logLevel).toBe("debug");
  });
});

describe("RuntimeConfigWatcher", () => {
  let folder: string;
  let file: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "market-maker-runtime-"));
    file = join(folder, "runtime.env");
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("applies the file at start and again only when its content changes", async () => {
    const logger = new RecordingLogger();
    const holder = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 60_000, startup: DEFAULT_RUNTIME_SETTINGS, current: () => holder.get(), logger, onChange: (s) => holder.set(s) });
    await writeFile(file, "QUOTING_ENABLED=false\n");
    await watcher.start();
    expect(holder.current().enabled).toBe(false);
    expect(await watcher.checkNow()).toBe(false);
    await writeFile(file, "QUOTING_ENABLED=flase\nSPREAD_MICRO=30000\n");
    expect(await watcher.checkNow()).toBe(true);
    // The typo keeps the bot switched off (and says so at error); the valid key applies.
    expect(holder.current()).toMatchObject({ enabled: false, spreadMicro: 30_000 });
    expect(logger.messages("warn")).toEqual(["Ignored a setting of the runtime configuration file"]);
    expect(logger.messages("error")).toEqual([expect.stringContaining("QUOTING_ENABLED in the runtime configuration file is invalid or empty")]);
    await watcher.stop();
  });

  it("switches quoting off for an invalid QUOTING_ENABLED in the first file a restarted process reads (nothing is in force yet)", async () => {
    const logger = new RecordingLogger();
    // As main.ts builds them: the holder starts from the startup settings, where quoting is on.
    const holder = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
    expect(holder.current().enabled).toBe(true);
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 60_000, startup: DEFAULT_RUNTIME_SETTINGS, current: () => holder.get(), logger, onChange: (s) => holder.set(s) });
    await writeFile(file, "QUOTING_ENABLED=flase\n");
    await watcher.checkNow();
    expect(holder.current().enabled).toBe(false);
    expect(logger.messages("error")).toHaveLength(1);
  });

  it("keeps quoting off when the value of QUOTING_ENABLED is deleted from the line, and quotes again only on an explicit true", async () => {
    const logger = new RecordingLogger();
    const holder = new RuntimeSettingsHolder(DEFAULT_RUNTIME_SETTINGS);
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 60_000, startup: DEFAULT_RUNTIME_SETTINGS, current: () => holder.get(), logger, onChange: (s) => holder.set(s) });
    await writeFile(file, "QUOTING_ENABLED=false\n");
    await watcher.checkNow();
    expect(holder.current().enabled).toBe(false);

    // `kubectl edit` that leaves the key without a value: not "unset", so the startup value (true) must not come back.
    await writeFile(file, "QUOTING_ENABLED=\n");
    await watcher.checkNow();
    expect(holder.current().enabled).toBe(false);
    expect(logger.messages("warn")).toEqual([expect.stringContaining("Ignored")]);
    expect(logger.messages("error")).toHaveLength(1);

    await writeFile(file, "QUOTING_ENABLED=true\n");
    await watcher.checkNow();
    expect(holder.current().enabled).toBe(true);
    expect(logger.messages("error")).toHaveLength(1);
  });

  it("keeps the settings and logs once while the file is missing", async () => {
    const logger = new RecordingLogger();
    const changes: RuntimeSettings[] = [];
    const watcher = new RuntimeConfigWatcher({ file, pollMs: 60_000, startup: DEFAULT_RUNTIME_SETTINGS, logger, onChange: (s) => changes.push(s) });
    expect(await watcher.checkNow()).toBe(false);
    expect(await watcher.checkNow()).toBe(false);
    expect(changes).toEqual([]);
    expect(logger.messages("warn")).toHaveLength(1);
  });
});
