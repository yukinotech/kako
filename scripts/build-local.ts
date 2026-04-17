import { mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  compile: {
    outfile: "dist/kako",
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Built local binary to dist/");
