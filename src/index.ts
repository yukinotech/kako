#!/usr/bin/env bun

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const MAGIC = Buffer.from("KAKO", "ascii");
const FOOTER_SIZE = 16; // filenameLen(4) + secretLen(8) + magic(4)
const UINT32_MAX = 0xffff_ffff;

function printUsage(): void {
  console.log(`Kako - Media Steganography CLI

Usage:
  kako hide -s <secret_file> -h <host_media> -o <output_file>
  kako reveal -i <disguised_file> -d <out_dir>

Commands:
  hide    Append secret file payload to a host JPG/MP4 and produce disguised output
  reveal  Recover hidden file from a disguised media file
`);
}

function assertFileExists(path: string, label: string): Promise<void> {
  return stat(path).then(
    (info) => {
      if (!info.isFile()) {
        throw new Error(`${label} is not a regular file: ${path}`);
      }
    },
    () => {
      throw new Error(`${label} does not exist: ${path}`);
    },
  );
}

async function runHide(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      secret: { type: "string", short: "s" },
      host: { type: "string", short: "h" },
      output: { type: "string", short: "o" },
    },
    strict: true,
    allowPositionals: false,
  });

  const secretPath = values.secret;
  const hostPath = values.host;
  const outputPath = values.output;

  if (!secretPath || !hostPath || !outputPath) {
    throw new Error("hide requires -s <secret_file> -h <host_media> -o <output_file>");
  }

  await Promise.all([
    assertFileExists(secretPath, "Secret file"),
    assertFileExists(hostPath, "Host media"),
  ]);

  const [secretData, hostData] = await Promise.all([readFile(secretPath), readFile(hostPath)]);

  const fileName = basename(secretPath);
  const fileNameBytes = Buffer.from(fileName, "utf8");

  if (fileNameBytes.length > UINT32_MAX) {
    throw new Error("Secret filename is too long to encode");
  }

  const footer = Buffer.alloc(FOOTER_SIZE);
  footer.writeUInt32BE(fileNameBytes.length, 0);
  footer.writeBigUInt64BE(BigInt(secretData.length), 4);
  MAGIC.copy(footer, 12);

  const outputBuffer = Buffer.concat([hostData, secretData, fileNameBytes, footer]);
  await writeFile(outputPath, outputBuffer);

  console.log(`Hidden ${secretData.length} bytes into ${outputPath}`);
}

async function runReveal(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string", short: "i" },
      dir: { type: "string", short: "d" },
    },
    strict: true,
    allowPositionals: false,
  });

  const inputPath = values.input;
  const outputDir = values.dir;

  if (!inputPath || !outputDir) {
    throw new Error("reveal requires -i <disguised_file> -d <out_dir>");
  }

  await assertFileExists(inputPath, "Input disguised file");

  const blob = await readFile(inputPath);
  if (blob.length < FOOTER_SIZE) {
    throw new Error("Input file is too small to contain Kako footer");
  }

  const footerOffset = blob.length - FOOTER_SIZE;
  const footer = blob.subarray(footerOffset);

  const magic = footer.subarray(12, 16);
  if (!magic.equals(MAGIC)) {
    throw new Error("Magic signature mismatch: hidden payload not found");
  }

  const fileNameLen = footer.readUInt32BE(0);
  const secretLenBig = footer.readBigUInt64BE(4);

  if (secretLenBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Hidden secret length is too large for this runtime");
  }

  const secretLen = Number(secretLenBig);
  const totalEmbeddedSize = fileNameLen + secretLen + FOOTER_SIZE;

  if (totalEmbeddedSize > blob.length) {
    throw new Error("Corrupted metadata: embedded payload exceeds file size");
  }

  const hostEnd = blob.length - totalEmbeddedSize;
  if (hostEnd < 0) {
    throw new Error("Corrupted data: invalid host boundary");
  }

  const secretStart = hostEnd;
  const secretEnd = secretStart + secretLen;
  const fileNameStart = secretEnd;
  const fileNameEnd = fileNameStart + fileNameLen;

  const secretData = blob.subarray(secretStart, secretEnd);
  const fileNameBytes = blob.subarray(fileNameStart, fileNameEnd);
  const fileName = fileNameBytes.toString("utf8");

  if (!fileName) {
    throw new Error("Recovered filename is empty");
  }

  const normalizedDir = resolve(outputDir);
  const outPath = join(normalizedDir, basename(fileName));

  await mkdir(normalizedDir, { recursive: true });
  await writeFile(outPath, secretData);

  console.log(`Recovered ${secretData.length} bytes to ${outPath}`);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;

  if (!command || command === "-h" || command === "--help") {
    printUsage();
    return;
  }

  if (command === "hide") {
    await runHide(rest);
    return;
  }

  if (command === "reveal") {
    await runReveal(rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
