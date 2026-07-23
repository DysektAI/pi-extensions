import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRoot, isServerRequest, langFor, supportedLanguages } from "../extensions/lsp.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const container = mkdtempSync(join(tmpdir(), "pi-lsp-tests-"));
  tempDirs.push(container);
  const root = join(container, "project");
  mkdirSync(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LSP message routing", () => {
  it("treats method-bearing messages as server requests even when ids collide", () => {
    expect(isServerRequest({ id: 1, method: "workspace/configuration", params: {} })).toBe(true);
    expect(isServerRequest({ id: 1, result: {} })).toBe(false);
  });
});

describe("C# language registration", () => {
  it("maps .cs files to csharp-ls", () => {
    const lang = langFor("src/App/GitHubUpdateService.cs");

    expect(lang).toMatchObject({
      key: "csharp",
      cmd: "csharp-ls",
      languageId: "csharp",
      extensions: ["cs"],
    });
    expect(supportedLanguages()).toContain("C#");
  });

  it("finds a solution root using wildcard solution markers", () => {
    const root = tempProject();
    const sourceDir = join(root, "src", "App");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(root, "RatScanner.sln"), "");
    const file = join(sourceDir, "GitHubUpdateService.cs");
    writeFileSync(file, "class GitHubUpdateService {}\n");

    expect(findRoot(file, langFor(file)!.markers, true)).toBe(root);
  });

  it("prefers a parent solution over a nearer project file", () => {
    const root = tempProject();
    const projectDir = join(root, "src", "App");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(root, "RatScanner.sln"), "");
    writeFileSync(join(projectDir, "RatScanner.csproj"), "<Project />\n");
    const file = join(projectDir, "GitHubUpdateService.cs");
    writeFileSync(file, "class GitHubUpdateService {}\n");

    expect(findRoot(file, langFor(file)!.markers, true)).toBe(root);
  });

  it("finds a project root when no solution file exists", () => {
    const root = tempProject();
    const projectDir = join(root, "src", "App");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "RatScanner.csproj"), "<Project />\n");
    const file = join(projectDir, "GitHubUpdateService.cs");
    writeFileSync(file, "class GitHubUpdateService {}\n");

    expect(findRoot(file, langFor(file)!.markers, true)).toBe(projectDir);
  });
});
