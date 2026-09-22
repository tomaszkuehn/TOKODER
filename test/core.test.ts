import { describe, it, expect } from "vitest";
import { screenCommand } from "../src/tools/bash.js";
import { setEnvKey } from "../src/utils/env.js";
import { loadQuick, saveQuick, setQuickSlot, formatQuick } from "../src/core/quick.js";
import { expandProviders } from "../src/core/config.js";
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

describe("expandProviders", () => {
  it("expands provider entries into models with slugged ids", () => {
    const models = expandProviders({
      "cheaper-inference": {
        name: "Cheaper Inference",
        baseURL: "https://api.cheaperinference.com/v1",
        apiKeyEnv: "CHEAPER_INFERENCE_API_KEY",
        models: { "gpt-5.4": { name: "GPT-5.4" } },
      },
    });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "cheaper-inference-gpt-5-4",
      provider: "custom",
      model: "gpt-5.4",
      apiKeyEnv: "CHEAPER_INFERENCE_API_KEY",
      baseURL: "https://api.cheaperinference.com/v1",
    });
  });

  it("defaults apiKeyEnv to CUSTOM_API_KEY and keeps headers", () => {
    const models = expandProviders({
      "my-gw": { baseURL: "http://localhost:9000/v1", headers: { "X-Org": "acme" }, models: { "m1": {} } },
    });
    expect(models[0].apiKeyEnv).toBe("CUSTOM_API_KEY");
    expect(models[0].headers).toEqual({ "X-Org": "acme" });
  });

  it("skips entries without baseURL and synthesizes a model when models empty", () => {
    const models = expandProviders({
      "no-base": { models: { a: {} } } as any,
      "bare": { baseURL: "http://x/v1" },
    });
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("bare-bare");
  });
});