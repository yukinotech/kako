import { existsSync } from "node:fs";

const candidates = ["dist/kako", "dist/kako.exe"];
const bin = candidates.find((file) => existsSync(file));

if (!bin) {
  console.error("Local binary not found. Expected dist/kako or dist/kako.exe");
  process.exit(1);
}

const proc = Bun.spawn([bin, "--help"], {
  stdout: "inherit",
  stderr: "inherit",
});

const code = await proc.exited;
if (code !== 0) {
  process.exit(code);
}
