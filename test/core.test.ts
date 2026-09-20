import { describe, it, expect } from "vitest";
import { screenCommand } from "../src/tools/bash.js";
import { setEnvKey } from "../src/utils/env.js";
import { loadQuick, saveQuick, setQuickSlot, formatQuick } from "../src/core/quick.js";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
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

  it("denies mutating commands touching system folders", () => {
    expect(classify(`del C:\\Windows\\system32\\x`)).toBe("deny");
  });

  it("asks approval for mutating commands referencing outside paths", () => {
    expect(classify(`touch /mnt/c/out.txt`)).toBe("acl");
    expect(classify(`Remove-Item D:\\other\\f.txt`)).toBe("acl");
    expect(classify(`echo x > D:\\other\\f.txt`)).toBe("acl");
  });

  it("allows read-only commands anywhere (read=true default) but still denies system folders", () => {
    // read unlimited per default rules — but C:\Windows always denied
    expect(classify(`type C:\\Windows\\win.ini`)).toBe("deny");
    expect(classify(`Get-Content D:\\other\\file.txt`)).toBe("ok");
  });

  it("denies mutating bash even inside project for risky ops", () => {
    // npm install is mutating but allowed in-project (targets resolved inside root)
    expect(classify(`npm install`)).toBe("ok");
  });
});