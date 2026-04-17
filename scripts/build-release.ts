import { mkdir } from "node:fs/promises";

type TargetBuild = {
  name: string;
  target: string;
  outfile: string;
};

const builds: TargetBuild[] = [
  {
    name: "windows-x64",
    target: "bun-windows-x64-baseline",
    outfile: "dist/kako-windows-x64.exe",
  },
  {
    name: "macos-x64",
    target: "bun-darwin-x64-baseline",
    outfile: "dist/kako-macos-x64",
  },
  {
    name: "macos-arm64",
    target: "bun-darwin-arm64",
    outfile: "dist/kako-macos-arm64",
  },
  {
    name: "linux-x64",
    target: "bun-linux-x64-baseline",
    outfile: "dist/kako-linux-x64",
  },
];

await mkdir("dist", { recursive: true });

for (const build of builds) {
  console.log(`Building ${build.name} (${build.target}) ...`);

  const result = await Bun.build({
    entrypoints: ["./src/index.ts"],
    compile: {
      target: build.target as never,
      outfile: build.outfile,
    },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

console.log("Built release binaries:");
for (const build of builds) {
  console.log(`- ${build.outfile}`);
}
