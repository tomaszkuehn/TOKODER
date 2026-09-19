import { describe, it, expect } from "vitest";
import { screenCommand } from "../src/tools/bash.js";
import { setEnvKey } from "../src/utils/env.js";
import { loadQuick, saveQuick, setQuickSlot, formatQuick } from "../src/core/quick.js";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function classify(cmd: string): "ok" | "deny" | "acl" {
  const res = screenCommand(cmd);
  if (res === null) return "ok";
  if (res.includes("PENDING-APPROVAL")) return "acl";
  return "deny";
}

describe("screenCommand", () => {
  const root = process.cwd();

  it("allows safe commands in project", () => {
    for (const cmd of ["ls", "git status", "npm test"]) {
      expect(classify(cmd)).toBe("ok");
    }
  });

  it("denies relative traversal", () => {
    for (const cmd of ["echo x > ../../evil.txt", "cat ..\\..\\secret", "del ..\\..\\a"]) {
      expect(classify(cmd)).toBe("deny");
    }
  });

  it("denies bare root", () => {
    expect(classify("rm -rf /")).toBe("deny");
  });

  it("requests ACL or denies absolute paths outside project", () => {
    for (const cmd of [`del C:\\Windows\\system32\\x`, `cat /etc/passwd`, `touch /mnt/c/out.txt`]) {
      expect(classify(cmd)).not.toBe("ok");
    }
    expect(classify(`del C:\\Windows\\system32\\x`)).toBe("deny");
    expect(classify(`touch /mnt/c/out.txt`)).toBe("acl");
  });

  it("requests ACL for home and env refs", () => {
    for (const cmd of ["cat ~/.bashrc", "echo $HOME/x", "echo %USERPROFILE%"]) {
      expect(classify(cmd)).toBe("acl");
    }
  });

  it("never allows UNC paths", () => {
    expect(classify("dir \\\\server\\share")).not.toBe("ok");
  });
});

describe("setEnvKey", () => {
  it("sets key preserving comments and quotes", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-"));
    const file = join(dir, ".env");
    writeFileSync(file, "# my comment\nFOO=bar\nQUOTED='single'\n");
    setEnvKey("NEW_KEY", "val", dir);
    const out = readFileSync(file, "utf-8");
    expect(out).toContain("# my comment");
    expect(out).toContain("FOO=bar");
    expect(out).toContain("QUOTED='single'");
    expect(out).toContain("NEW_KEY=val");
  });

  it("replaces existing key", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-"));
    const file = join(dir, ".env");
    writeFileSync(file, "OLD=1\nOTHER=keep\n");
    setEnvKey("OLD", "2", dir);
    const out = readFileSync(file, "utf-8");
    expect(out).toContain("OLD=2");
    expect(out).toContain("OTHER=keep");
    expect(out).not.toContain("OLD=1");
  });
});

describe("stats path", () => {
  it("uses homedir, not hardcoded user path", () => {
    const src = readFileSync(join(process.cwd(), "src", "utils", "stats.ts"), "utf-8");
    expect(src).not.toContain("pantomas");
    expect(src).toContain("homedir");
  });
});

describe("quick slots", () => {
  it("set/load/clear roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "quick-"));
    let map = loadQuick(dir);
    expect(Object.keys(map).length).toBe(0);
    map = setQuickSlot(map, 3, "npm test");
    map = setQuickSlot(map, 5, ":plan on");
    saveQuick(map, dir);
    const loaded = loadQuick(dir);
    expect(loaded["3"]?.text).toBe("npm test");
    expect(loaded["5"]?.text).toBe(":plan on");
    const cleared = setQuickSlot(loaded, 3, "");
    expect(cleared["3"]).toBeUndefined();
    expect(cleared["5"]?.text).toBe(":plan on");
  });

  it("rejects slots outside 1-5", () => {
    let map = setQuickSlot({}, 9, "nope");
    expect(map["9"]).toBeUndefined();
    map = setQuickSlot({}, 5, "ok");
    expect(map["5"]?.text).toBe("ok");
  });

  it("formatQuick renders 5 rows with labels", () => {
    const map = setQuickSlot({}, 1, "git status --short");
    const out = formatQuick(map);
    expect(out.split("\n").length).toBe(5);
    expect(out).toContain("1| git status --short");
    expect(out).toContain("5| — empty —");
  });
});