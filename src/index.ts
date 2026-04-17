#!/usr/bin/env bun

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const KAK3_MAGIC = Buffer.from("KAK3", "ascii");
const KAK3_VERSION = 1;
const KAK3_HEADER_SIZE = 16; // magic(4)+version(1)+flags(1)+xorLen(1)+reserved(1)+nameLen(4)+secretLen(4)
const KAK3_CRC_SIZE = 4;
const UINT32_MAX = 0xffff_ffff;

const SIGNATURE_XOR_BYTES = 20;
const SIGNATURE_XOR_KEY = Buffer.from("KAKO_HEADER_XOR_KEY!", "ascii");

const JPEG_XMP_IDENTIFIER = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "ascii");
const JPEG_KAKO_NS = "https://kako.dev/ns/1.0/";
const JPEG_APP1_MARKER = 0xe1;
const JPEG_SOS_MARKER = 0xda;
const JPEG_EOI_MARKER = 0xd9;
const JPEG_SOI_MARKER = 0xd8;
const JPEG_SEGMENT_MAX_PAYLOAD = 65533;
const JPEG_CHUNK_DATA_MAX = 55000;

const MP4_UUID_USER_TYPE = Buffer.from("9f8c3fbc9e0f4e6ca1a7d2cd8b6e4f01", "hex");
const MP4_DEFAULT_RESERVE_BYTES = 4096;

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 1) !== 0 ? (0xedb8_8320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

type HostFormat = "jpeg" | "mp4";

type Mp4Box = {
  start: number;
  end: number;
  payloadStart: number;
  payloadEnd: number;
  size: number;
  type: string;
  headerSize: number;
};

type JpegSegment = {
  marker: number;
  start: number;
  end: number;
  payloadStart: number;
  payloadEnd: number;
};

type ParsedKakoPayload = {
  fileName: string;
  secretData: Buffer;
  xorLen: number;
};

function printUsage(): void {
  console.log(`Kako - Media Steganography CLI

Usage:
  kako hide -s <secret_file> -h <host_media> -o <output_file>
  kako reveal -i <disguised_file> -d <out_dir>

Commands:
  hide    Embed secret payload into JPEG APP1(XMP-like) or MP4 moov/udta/uuid metadata
  reveal  Recover hidden file from a disguised media file

Note:
  hide obfuscates the first 20 bytes of secret payload with fixed XOR
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

function crc32(data: Buffer): number {
  let crc = 0xffff_ffff;
  for (let i = 0; i < data.length; i += 1) {
    const tableValue = crc32Table[(crc ^ data.readUInt8(i)) & 0xff] ?? 0;
    crc = tableValue ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function xorSecretSignatureInPlace(data: Buffer, xorLen: number): number {
  const n = Math.min(xorLen, data.length, SIGNATURE_XOR_KEY.length);
  for (let i = 0; i < n; i += 1) {
    data.writeUInt8(data.readUInt8(i) ^ SIGNATURE_XOR_KEY.readUInt8(i), i);
  }
  return n;
}

function makeKakoPayload(secretPath: string, secretData: Buffer): { payload: Buffer; obfuscatedBytes: number } {
  const fileNameBytes = Buffer.from(basename(secretPath), "utf8");
  if (fileNameBytes.length > UINT32_MAX) {
    throw new Error("Secret filename is too long to encode");
  }
  if (secretData.length > UINT32_MAX) {
    throw new Error("Secret payload is too large to encode in KAK3 v1");
  }

  const encodedSecret = Buffer.from(secretData);
  const obfuscatedBytes = xorSecretSignatureInPlace(encodedSecret, SIGNATURE_XOR_BYTES);

  const header = Buffer.alloc(KAK3_HEADER_SIZE);
  KAK3_MAGIC.copy(header, 0);
  header.writeUInt8(KAK3_VERSION, 4);
  header.writeUInt8(0, 5); // flags
  header.writeUInt8(obfuscatedBytes, 6);
  header.writeUInt8(0, 7); // reserved
  header.writeUInt32BE(fileNameBytes.length, 8);
  header.writeUInt32BE(encodedSecret.length, 12);

  const body = Buffer.concat([header, fileNameBytes, encodedSecret]);
  const footer = Buffer.alloc(KAK3_CRC_SIZE);
  footer.writeUInt32BE(crc32(body), 0);

  return { payload: Buffer.concat([body, footer]), obfuscatedBytes };
}

function parseKakoPayload(raw: Buffer): ParsedKakoPayload {
  if (raw.length < KAK3_HEADER_SIZE + KAK3_CRC_SIZE) {
    throw new Error("unsupported legacy format");
  }

  if (!raw.subarray(0, 4).equals(KAK3_MAGIC)) {
    throw new Error("unsupported legacy format");
  }

  const version = raw.readUInt8(4);
  if (version !== KAK3_VERSION) {
    throw new Error(`unsupported kako payload version: ${version}`);
  }

  const xorLen = raw.readUInt8(6);
  const fileNameLen = raw.readUInt32BE(8);
  const secretLen = raw.readUInt32BE(12);

  const payloadEnd = KAK3_HEADER_SIZE + fileNameLen + secretLen;
  const crcOffset = payloadEnd;
  if (raw.length < crcOffset + KAK3_CRC_SIZE) {
    throw new Error("corrupted metadata: payload length overflow");
  }

  const body = raw.subarray(0, payloadEnd);
  const expectedCrc = raw.readUInt32BE(crcOffset);
  const actualCrc = crc32(Buffer.from(body));
  if (expectedCrc !== actualCrc) {
    throw new Error("invalid kako payload checksum");
  }

  const fileNameBytes = raw.subarray(KAK3_HEADER_SIZE, KAK3_HEADER_SIZE + fileNameLen);
  const fileName = basename(fileNameBytes.toString("utf8"));
  if (!fileName) {
    throw new Error("Recovered filename is empty");
  }

  const secretStart = KAK3_HEADER_SIZE + fileNameLen;
  const secretEnd = secretStart + secretLen;
  const secretData = Buffer.from(raw.subarray(secretStart, secretEnd));
  xorSecretSignatureInPlace(secretData, xorLen);

  return { fileName, secretData, xorLen };
}

function detectFormat(path: string, data: Buffer): HostFormat {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "jpeg";
  }
  if (ext === ".mp4") {
    return "mp4";
  }

  if (data.length >= 2 && data.readUInt8(0) === 0xff && data.readUInt8(1) === JPEG_SOI_MARKER) {
    return "jpeg";
  }
  if (data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp") {
    return "mp4";
  }

  throw new Error("unsupported host format: only .jpg/.jpeg and .mp4 are supported");
}

function findLastJpegEoi(data: Buffer): number {
  for (let i = data.length - 2; i >= 0; i -= 1) {
    if (data.readUInt8(i) === 0xff && data.readUInt8(i + 1) === JPEG_EOI_MARKER) {
      return i;
    }
  }
  return -1;
}

function parseJpegSegmentsUntilSos(data: Buffer): { segments: JpegSegment[]; sosStart: number; eoiIndex: number } {
  if (data.length < 4 || data.readUInt8(0) !== 0xff || data.readUInt8(1) !== JPEG_SOI_MARKER) {
    throw new Error("invalid jpeg: missing SOI marker");
  }

  const eoiIndex = findLastJpegEoi(data);
  if (eoiIndex < 0) {
    throw new Error("invalid jpeg: missing EOI marker");
  }

  const segments: JpegSegment[] = [];
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data.readUInt8(offset) !== 0xff) {
      throw new Error("invalid jpeg marker alignment");
    }

    let marker = data.readUInt8(offset + 1);
    let markerPos = offset;
    while (marker === 0xff) {
      markerPos += 1;
      if (markerPos + 1 >= data.length) {
        throw new Error("invalid jpeg marker stream");
      }
      marker = data.readUInt8(markerPos + 1);
    }

    if (marker === JPEG_SOS_MARKER) {
      return { segments, sosStart: markerPos, eoiIndex };
    }

    if (marker === JPEG_EOI_MARKER) {
      throw new Error("invalid jpeg: EOI appears before SOS");
    }

    if (marker >= 0xd0 && marker <= 0xd7) {
      segments.push({ marker, start: markerPos, end: markerPos + 2, payloadStart: markerPos + 2, payloadEnd: markerPos + 2 });
      offset = markerPos + 2;
      continue;
    }

    if (markerPos + 4 > data.length) {
      throw new Error("invalid jpeg: truncated segment header");
    }

    const segLen = data.readUInt16BE(markerPos + 2);
    if (segLen < 2) {
      throw new Error("invalid jpeg: segment length too small");
    }

    const end = markerPos + 2 + segLen;
    if (end > data.length) {
      throw new Error("invalid jpeg: segment overflows file");
    }

    segments.push({
      marker,
      start: markerPos,
      end,
      payloadStart: markerPos + 4,
      payloadEnd: end,
    });

    offset = end;
  }

  throw new Error("invalid jpeg: SOS marker not found");
}

function buildJpegKakoChunkXml(chunkIndex: number, totalChunks: number, dataBase64: string): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:kako="${JPEG_KAKO_NS}" kako:chunk="${chunkIndex}" kako:total="${totalChunks}" kako:data="${dataBase64}" /></rdf:RDF></x:xmpmeta>`;
}

function makeJpegKakoApp1Segments(payload: Buffer): Buffer[] {
  const payloadB64 = payload.toString("base64");
  const segments: Buffer[] = [];

  const chunks: string[] = [];
  for (let offset = 0; offset < payloadB64.length; offset += JPEG_CHUNK_DATA_MAX) {
    chunks.push(payloadB64.slice(offset, offset + JPEG_CHUNK_DATA_MAX));
  }
  if (chunks.length === 0) {
    chunks.push("");
  }

  const total = chunks.length;
  for (let i = 0; i < total; i += 1) {
    const xml = buildJpegKakoChunkXml(i + 1, total, chunks[i]!);
    const body = Buffer.concat([JPEG_XMP_IDENTIFIER, Buffer.from(xml, "utf8")]);
    if (body.length > JPEG_SEGMENT_MAX_PAYLOAD) {
      throw new Error("jpeg payload chunk exceeds APP1 segment size");
    }

    const segment = Buffer.alloc(4);
    segment.writeUInt8(0xff, 0);
    segment.writeUInt8(JPEG_APP1_MARKER, 1);
    segment.writeUInt16BE(body.length + 2, 2);
    segments.push(Buffer.concat([segment, body]));
  }

  return segments;
}

function isKakoJpegApp1Payload(payload: Buffer): boolean {
  if (payload.length < JPEG_XMP_IDENTIFIER.length) {
    return false;
  }

  if (!payload.subarray(0, JPEG_XMP_IDENTIFIER.length).equals(JPEG_XMP_IDENTIFIER)) {
    return false;
  }

  const xml = payload.subarray(JPEG_XMP_IDENTIFIER.length).toString("utf8");
  return xml.includes(`xmlns:kako=\"${JPEG_KAKO_NS}\"`);
}

function extractKakoPayloadFromJpeg(data: Buffer): Buffer | null {
  const { segments } = parseJpegSegmentsUntilSos(data);
  const chunkMap = new Map<number, string>();
  let expectedTotal = 0;

  for (const segment of segments) {
    if (segment.marker !== JPEG_APP1_MARKER) {
      continue;
    }

    const payload = data.subarray(segment.payloadStart, segment.payloadEnd);
    if (!isKakoJpegApp1Payload(payload)) {
      continue;
    }

    const xml = payload.subarray(JPEG_XMP_IDENTIFIER.length).toString("utf8");
    const chunkMatch = xml.match(/kako:chunk="(\d+)"/);
    const totalMatch = xml.match(/kako:total="(\d+)"/);
    const dataMatch = xml.match(/kako:data="([A-Za-z0-9+/=]*)"/);

    if (!chunkMatch || !totalMatch || !dataMatch) {
      continue;
    }

    const chunk = Number.parseInt(chunkMatch[1]!, 10);
    const total = Number.parseInt(totalMatch[1]!, 10);
    const chunkData = dataMatch[1]!;

    if (!Number.isFinite(chunk) || !Number.isFinite(total) || chunk < 1 || total < 1 || chunk > total) {
      continue;
    }

    expectedTotal = Math.max(expectedTotal, total);
    chunkMap.set(chunk, chunkData);
  }

  if (expectedTotal === 0) {
    return null;
  }

  const orderedChunks: string[] = [];
  for (let i = 1; i <= expectedTotal; i += 1) {
    const part = chunkMap.get(i);
    if (part === undefined) {
      throw new Error("corrupted jpeg kako metadata: missing chunk");
    }
    orderedChunks.push(part);
  }

  return Buffer.from(orderedChunks.join(""), "base64");
}

function embedPayloadInJpeg(hostData: Buffer, payload: Buffer): Buffer {
  const { segments, sosStart, eoiIndex } = parseJpegSegmentsUntilSos(hostData);

  const out: Buffer[] = [];
  out.push(hostData.subarray(0, 2)); // SOI

  for (const segment of segments) {
    const segmentPayload = hostData.subarray(segment.payloadStart, segment.payloadEnd);
    if (segment.marker === JPEG_APP1_MARKER && isKakoJpegApp1Payload(segmentPayload)) {
      continue;
    }
    out.push(hostData.subarray(segment.start, segment.end));
  }

  const kakoSegments = makeJpegKakoApp1Segments(payload);
  out.push(...kakoSegments);

  // Keep entropy-coded stream through EOI, drop any trailing bytes after EOI.
  out.push(hostData.subarray(sosStart, eoiIndex + 2));

  return Buffer.concat(out);
}

function readMp4BoxSize(data: Buffer, offset: number, end: number): { size: number; headerSize: number } {
  if (offset + 8 > end) {
    throw new Error("invalid mp4: truncated box header");
  }

  const size32 = data.readUInt32BE(offset);
  if (size32 === 0) {
    return { size: end - offset, headerSize: 8 };
  }

  if (size32 === 1) {
    if (offset + 16 > end) {
      throw new Error("invalid mp4: truncated extended box header");
    }
    const size64 = Number(data.readBigUInt64BE(offset + 8));
    if (!Number.isSafeInteger(size64) || size64 < 16) {
      throw new Error("invalid mp4: unsupported extended box size");
    }
    return { size: size64, headerSize: 16 };
  }

  return { size: size32, headerSize: 8 };
}

function parseMp4Boxes(data: Buffer, start = 0, end = data.length): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = start;

  while (offset < end) {
    const { size, headerSize } = readMp4BoxSize(data, offset, end);
    if (size < headerSize || offset + size > end) {
      throw new Error("invalid mp4: box size overflow");
    }

    const type = data.toString("ascii", offset + 4, offset + 8);
    const box: Mp4Box = {
      start: offset,
      end: offset + size,
      payloadStart: offset + headerSize,
      payloadEnd: offset + size,
      size,
      type,
      headerSize,
    };
    boxes.push(box);

    offset += size;
    if (size === 0) {
      break;
    }
  }

  if (offset !== end) {
    throw new Error("invalid mp4: trailing or malformed top-level data");
  }

  return boxes;
}

function createMp4Box(type: string, payload: Buffer): Buffer {
  if (type.length !== 4) {
    throw new Error(`invalid mp4 box type: ${type}`);
  }

  const size = payload.length + 8;
  if (size > UINT32_MAX) {
    throw new Error("mp4 box too large");
  }

  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function createMp4UuidBox(payload: Buffer): Buffer {
  const size = payload.length + 8 + 16;
  if (size > UINT32_MAX) {
    throw new Error("mp4 uuid box too large");
  }

  const header = Buffer.alloc(8);
  header.writeUInt32BE(size, 0);
  header.write("uuid", 4, 4, "ascii");
  return Buffer.concat([header, MP4_UUID_USER_TYPE, payload]);
}

function createMp4FreeBox(totalSize: number): Buffer {
  if (totalSize < 8) {
    throw new Error("mp4 free box size must be at least 8 bytes");
  }
  const payload = Buffer.alloc(totalSize - 8);
  return createMp4Box("free", payload);
}

function isKakoUuidBox(data: Buffer, box: Mp4Box): boolean {
  if (box.type !== "uuid") {
    return false;
  }
  if (box.payloadStart + 16 > box.payloadEnd) {
    return false;
  }
  return data.subarray(box.payloadStart, box.payloadStart + 16).equals(MP4_UUID_USER_TYPE);
}

function getKakoUuidPayload(data: Buffer, box: Mp4Box): Buffer {
  return Buffer.from(data.subarray(box.payloadStart + 16, box.payloadEnd));
}

function patchChunkOffsetsInMoov(moovPayload: Buffer, delta: number, threshold: number): void {
  if (delta === 0) {
    return;
  }

  const containerTypes = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex", "moof", "traf", "meta", "udta"]);

  const walk = (start: number, end: number): void => {
    let offset = start;
    while (offset < end) {
      const { size, headerSize } = readMp4BoxSize(moovPayload, offset, end);
      const type = moovPayload.toString("ascii", offset + 4, offset + 8);
      const boxStart = offset;
      const boxEnd = offset + size;
      const payloadStart = offset + headerSize;

      if (type === "stco") {
        if (payloadStart + 8 > boxEnd) {
          throw new Error("invalid mp4 stco box");
        }
        const entryCount = moovPayload.readUInt32BE(payloadStart + 4);
        const entriesStart = payloadStart + 8;
        const entriesEnd = entriesStart + entryCount * 4;
        if (entriesEnd > boxEnd) {
          throw new Error("invalid mp4 stco entries");
        }

        for (let i = 0; i < entryCount; i += 1) {
          const pos = entriesStart + i * 4;
          const value = moovPayload.readUInt32BE(pos);
          if (value >= threshold) {
            const shifted = value + delta;
            if (shifted < 0 || shifted > UINT32_MAX) {
              throw new Error("mp4 stco offset overflow during rewrite");
            }
            moovPayload.writeUInt32BE(shifted, pos);
          }
        }
      } else if (type === "co64") {
        if (payloadStart + 8 > boxEnd) {
          throw new Error("invalid mp4 co64 box");
        }
        const entryCount = moovPayload.readUInt32BE(payloadStart + 4);
        const entriesStart = payloadStart + 8;
        const entriesEnd = entriesStart + entryCount * 8;
        if (entriesEnd > boxEnd) {
          throw new Error("invalid mp4 co64 entries");
        }

        for (let i = 0; i < entryCount; i += 1) {
          const pos = entriesStart + i * 8;
          const value = Number(moovPayload.readBigUInt64BE(pos));
          if (value >= threshold) {
            const shifted = value + delta;
            if (!Number.isSafeInteger(shifted) || shifted < 0) {
              throw new Error("mp4 co64 offset overflow during rewrite");
            }
            moovPayload.writeBigUInt64BE(BigInt(shifted), pos);
          }
        }
      } else if (containerTypes.has(type)) {
        let childStart = payloadStart;
        if (type === "meta") {
          childStart += 4; // FullBox version+flags
        }
        if (childStart <= boxEnd) {
          walk(childStart, boxEnd);
        }
      }

      offset = boxEnd;
      if (size === 0) {
        break;
      }
      if (boxStart === boxEnd) {
        throw new Error("invalid mp4: zero-size box loop");
      }
    }
  };

  walk(0, moovPayload.length);
}

function upsertKakoIntoUdta(udtaPayload: Buffer, kakoPayload: Buffer): Buffer {
  const children = parseMp4Boxes(udtaPayload, 0, udtaPayload.length);
  let uuidIndex = -1;
  for (let i = 0; i < children.length; i += 1) {
    if (isKakoUuidBox(udtaPayload, children[i]!)) {
      uuidIndex = i;
      break;
    }
  }

  const out: Buffer[] = [];

  if (uuidIndex >= 0) {
    const uuidBox = children[uuidIndex]!;
    const oldPayloadLen = uuidBox.payloadEnd - (uuidBox.payloadStart + 16);

    let freeBoxSize = 0;
    let consumeNextFree = false;
    if (uuidIndex + 1 < children.length && children[uuidIndex + 1]!.type === "free") {
      freeBoxSize = children[uuidIndex + 1]!.size;
      consumeNextFree = true;
    }

    const slotSize = oldPayloadLen + freeBoxSize;
    if (kakoPayload.length > slotSize) {
      throw new Error("payload too large for reserved mp4 slot");
    }

    const remaining = slotSize - kakoPayload.length;
    const padInsideUuid = remaining > 0 && remaining < 8 ? remaining : 0;
    const paddedPayload =
      padInsideUuid > 0 ? Buffer.concat([kakoPayload, Buffer.alloc(padInsideUuid)]) : kakoPayload;

    const newUuidBox = createMp4UuidBox(paddedPayload);

    for (let i = 0; i < children.length; i += 1) {
      if (i < uuidIndex || i > uuidIndex + (consumeNextFree ? 1 : 0)) {
        const child = children[i]!;
        out.push(udtaPayload.subarray(child.start, child.end));
      } else if (i === uuidIndex) {
        out.push(newUuidBox);
        const freeRemaining = remaining - padInsideUuid;
        if (freeRemaining >= 8) {
          out.push(createMp4FreeBox(freeRemaining));
        }
      }
    }

    return Buffer.concat(out);
  }

  for (const child of children) {
    out.push(udtaPayload.subarray(child.start, child.end));
  }

  const reservedTotal = kakoPayload.length + MP4_DEFAULT_RESERVE_BYTES;
  out.push(createMp4UuidBox(kakoPayload));
  if (reservedTotal - kakoPayload.length >= 8) {
    out.push(createMp4FreeBox(reservedTotal - kakoPayload.length));
  }

  return Buffer.concat(out);
}

function embedPayloadInMp4(hostData: Buffer, kakoPayload: Buffer): Buffer {
  const topBoxes = parseMp4Boxes(hostData);
  const moovIndex = topBoxes.findIndex((box) => box.type === "moov");
  if (moovIndex < 0) {
    throw new Error("invalid mp4: moov box not found");
  }

  const moovBox = topBoxes[moovIndex]!;
  const moovPayload = Buffer.from(hostData.subarray(moovBox.payloadStart, moovBox.payloadEnd));
  const moovChildren = parseMp4Boxes(moovPayload, 0, moovPayload.length);

  const udtaIndex = moovChildren.findIndex((box) => box.type === "udta");

  const newMoovChildren: Buffer[] = [];
  if (udtaIndex >= 0) {
    for (let i = 0; i < moovChildren.length; i += 1) {
      const child = moovChildren[i]!;
      if (i !== udtaIndex) {
        newMoovChildren.push(moovPayload.subarray(child.start, child.end));
        continue;
      }

      const udtaPayload = Buffer.from(moovPayload.subarray(child.payloadStart, child.payloadEnd));
      const newUdtaPayload = upsertKakoIntoUdta(udtaPayload, kakoPayload);
      newMoovChildren.push(createMp4Box("udta", newUdtaPayload));
    }
  } else {
    for (const child of moovChildren) {
      newMoovChildren.push(moovPayload.subarray(child.start, child.end));
    }
    const udtaPayload = upsertKakoIntoUdta(Buffer.alloc(0), kakoPayload);
    newMoovChildren.push(createMp4Box("udta", udtaPayload));
  }

  let newMoovPayload = Buffer.concat(newMoovChildren);

  const oldMoovSize = moovBox.size;
  const newMoovSize = newMoovPayload.length + 8;
  const delta = newMoovSize - oldMoovSize;

  const firstMdat = topBoxes.find((box) => box.type === "mdat");
  if (delta !== 0 && firstMdat && moovBox.start < firstMdat.start) {
    patchChunkOffsetsInMoov(newMoovPayload, delta, moovBox.end);
  }

  const newMoovBox = createMp4Box("moov", newMoovPayload);

  const out: Buffer[] = [];
  for (let i = 0; i < topBoxes.length; i += 1) {
    const box = topBoxes[i]!;
    if (i === moovIndex) {
      out.push(newMoovBox);
    } else {
      out.push(hostData.subarray(box.start, box.end));
    }
  }

  return Buffer.concat(out);
}

function extractKakoPayloadFromMp4(data: Buffer): Buffer | null {
  const topBoxes = parseMp4Boxes(data);
  const moov = topBoxes.find((box) => box.type === "moov");
  if (!moov) {
    return null;
  }

  const moovPayload = data.subarray(moov.payloadStart, moov.payloadEnd);
  const moovChildren = parseMp4Boxes(moovPayload, 0, moovPayload.length);
  const udta = moovChildren.find((box) => box.type === "udta");
  if (!udta) {
    return null;
  }

  const udtaPayload = moovPayload.subarray(udta.payloadStart, udta.payloadEnd);
  const udtaChildren = parseMp4Boxes(udtaPayload, 0, udtaPayload.length);

  const uuid = udtaChildren.find((box) => isKakoUuidBox(udtaPayload, box));
  if (!uuid) {
    return null;
  }

  return getKakoUuidPayload(udtaPayload, uuid);
}

function hasLegacyEofFooter(data: Buffer): boolean {
  if (data.length < 16) {
    return false;
  }
  const tailMagic = data.subarray(data.length - 4, data.length).toString("ascii");
  return tailMagic === "KAKO" || tailMagic === "KAK2";
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

  await Promise.all([assertFileExists(secretPath, "Secret file"), assertFileExists(hostPath, "Host media")]);

  const [secretData, hostData] = await Promise.all([readFile(secretPath), readFile(hostPath)]);

  const { payload, obfuscatedBytes } = makeKakoPayload(secretPath, secretData);
  const format = detectFormat(hostPath, hostData);

  let outputBuffer: Buffer;
  if (format === "jpeg") {
    outputBuffer = embedPayloadInJpeg(hostData, payload);
  } else {
    outputBuffer = embedPayloadInMp4(hostData, payload);
  }

  await writeFile(outputPath, outputBuffer);

  console.log(
    `Hidden ${secretData.length} bytes into ${outputPath} via ${format.toUpperCase()} metadata (obfuscated first ${obfuscatedBytes} bytes)`,
  );
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
  const format = detectFormat(inputPath, blob);

  let kakoPayload: Buffer | null;
  if (format === "jpeg") {
    kakoPayload = extractKakoPayloadFromJpeg(blob);
  } else {
    kakoPayload = extractKakoPayloadFromMp4(blob);
  }

  if (!kakoPayload) {
    if (hasLegacyEofFooter(blob)) {
      throw new Error("unsupported legacy format");
    }
    throw new Error("kako metadata not found in container");
  }

  const parsed = parseKakoPayload(kakoPayload);
  const normalizedDir = resolve(outputDir);
  const outPath = join(normalizedDir, parsed.fileName);

  await mkdir(normalizedDir, { recursive: true });
  await writeFile(outPath, parsed.secretData);

  console.log(`Recovered ${parsed.secretData.length} bytes to ${outPath} (xor-len=${parsed.xorLen})`);
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
