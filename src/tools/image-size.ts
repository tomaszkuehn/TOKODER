import { open } from "node:fs/promises";

/** minimal PNG/JPEG/GIF/WEBP/BMP dimension sniffing (no deps) */
export async function imageSize(path: string): Promise<{ w: number; h: number; ext: string }> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(32);
    await fh.read(buf, 0, 32, 0);
    // PNG: 8-byte signature, IHDR at offset 16 (big-endian)
    if (buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: "png" };
    }
    // GIF: "GIF8" + little-endian u16 u16 at 6
    if (buf.subarray(0, 4).toString("ascii") === "GIF8") {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), ext: "gif" };
    }
    // BMP: "BM" + little-endian i32 at 18/22
    if (buf.subarray(0, 2).toString("ascii") === "BM") {
      return { w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)), ext: "bmp" };
    }
    // JPEG: FF D8 ... scan SOF0/2 markers
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      const big = Buffer.alloc(2 * 64 * 1024);
      await fh.read(big, 0, big.length, 0);
      for (let i = 2; i < big.length - 9; ) {
        if (big[i] !== 0xff) { i++; continue; }
        const marker = big[i + 1];
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
          return { w: big.readUInt16BE(i + 7), h: big.readUInt16BE(i + 5), ext: "jpeg" };
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { i += 2; continue; }
        const len = big.readUInt16BE(i + 2);
        if (len <= 0) break;
        i += 2 + len;
      }
      return { w: 0, h: 0, ext: "jpeg" };
    }
    // WEBP: "RIFF"...."WEBP" + VP8 chunk
    if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
      const fourcc = buf.subarray(12, 16).toString("ascii");
      if (fourcc === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, ext: "webp" };
      if (fourcc === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, ext: "webp" };
      }
      if (fourcc === "VP8X") return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1, ext: "webp" };
      return { w: 0, h: 0, ext: "webp" };
    }
    return { w: 0, h: 0, ext: "unknown" };
  } finally {
    await fh.close();
  }
}