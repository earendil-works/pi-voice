import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

const outputDirectory = await mkdtemp(join(process.cwd(), ".pi-voice-test-"));
try {
  await run(process.execPath, [
    join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
    "--noEmit",
    "false",
    "--outDir",
    outputDirectory,
  ]);
  // TypeScript doesn't copy the Markdown loaded by the ratings help view.
  await copyFile(
    join(process.cwd(), "src/model-ratings-help.md"),
    join(outputDirectory, "src/model-ratings-help.md"),
  );
  const testDirectory = join(outputDirectory, "test");
  const testFiles = (await readdir(testDirectory))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(testDirectory, name));
  await run(process.execPath, ["--experimental-test-module-mocks", "--test", ...testFiles]);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
