import fs, { WriteStream } from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import { CRC32Stream } from 'crc32-stream';
import { Writer } from './writer';
import {
  CompressMethodEnum,
  FlagEnum,
  SignatureEnum,
  Size,
  VersionEnum,
} from './enum';
import { DeflateRaw, ZlibOptions } from 'minizlib';
import zlib from 'zlib';

type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };

interface EntryFilePath {
  filePath: string;
}
interface EntryBuffer {
  buffer: Buffer;
}

interface EntryBase {
  name: string;
  compressedBuffer: Buffer;
  uncompressedSize: number;
  crc32: number;
  zip64: boolean;
  offsetMap: {
    lfh: number;
  };
}
type Entry = EntryBase &
  (
    | (Without<EntryFilePath, EntryBuffer> & EntryBuffer)
    | (Without<EntryBuffer, EntryFilePath> & EntryFilePath)
  );

interface CentralDirHeaderAttr {
  offset: number;
  size: number;
}

interface Option {
  // zlib deflate options
  zlib?: ZlibOptions;
  // write stream. if set, finish method won't return ZIP Buffer
  stream?: WriteStream;
}

export class XlsxZip {
  private option: Option = {};

  private list: Entry[] = [];
  private set: Set<string> = new Set();

  private writer;
  private buffers: Buffer[] = [];

  constructor(option?: Option) {
    if (option) {
      this.option = option;
    }

    this.writer = new Writer();
    if (this.option.stream) {
      this.writer.pipe(this.option.stream);
    } else {
      this.writer.on('data', (chunk) => {
        this.buffers.push(chunk);
      });
    }
  }

  /**
   * add entry with buffer/file path
   */
  async add(internalPath: string, filePath: string): Promise<void>;
  async add(internalPath: string, buffer: Buffer): Promise<void>;
  async add(internalPath: string, data: string | Buffer): Promise<void> {
    if (this.set.has(internalPath)) {
      throw new Error(`exist entry name: ${internalPath}`);
    }
    this.set.add(internalPath);

    if (!/^[^/]+(?:\/[^/]+)*/.test(internalPath)) {
      throw new Error(`bad entry name: ${internalPath}`);
    }
    let entry: Entry;

    if (typeof data === 'string') {
      entry = {
        name: internalPath,
        filePath: data,
        uncompressedSize: 0,
        compressedBuffer: Buffer.alloc(0),
        crc32: await this.crc32(data),
        zip64: false,
        offsetMap: {
          lfh: this.writer.offset,
        },
      };

      const fileStat = await fsp.stat(data);
      entry.uncompressedSize = fileStat.size;
      if (entry.uncompressedSize > 0xffffffff) {
        entry.zip64 = true;
      }
    } else {
      // buffer
      entry = {
        name: internalPath,
        buffer: data,
        uncompressedSize: 0,
        compressedBuffer: Buffer.alloc(0),
        crc32: await this.crc32(data),
        zip64: false,
        offsetMap: {
          lfh: this.writer.offset,
        },
      };
    }

    this.list.push(entry);
    entry.compressedBuffer = await this.compress(entry);

    this.writeLFH(entry);
  }

  /**
   * add entry directory
   */
  async addDirectory(internalDir: string | null, dirPath: string) {
    if (!internalDir) {
      internalDir = './';
    }
    internalDir = path.posix.normalize(internalDir);
    await this.addRecursively(dirPath, internalDir);
  }

  /**
   * finish add action and flush stream
   */
  finish(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.writer.on('end', () => {
        resolve(Buffer.concat(this.buffers));
      });
      this.writer.on('error', (err) => {
        reject(err);
      });

      const offset = this.writer.offset;

      for (const entry of this.list) {
        this.writeCentralDirHeader(entry);
      }

      const size = this.writer.offset - offset;
      const centralDirHeaderAttr = {
        offset,
        size,
      };
      this.writeCentralDirEndRecord(centralDirHeaderAttr);

      this.writer.end();
    });
  }

  /**
   * add entry recursively
   */
  private async addRecursively(inputDir: string, base: string) {
    const dirPath = path.join(inputDir, base);
    const files = await fsp.readdir(dirPath);

    for (const filename of files) {
      const newBase = path.posix.join(base, filename);
      const filePath = path.join(inputDir, newBase);
      const fileStat = await fsp.stat(filePath);

      if (fileStat.isDirectory()) {
        await this.addRecursively(inputDir, newBase);
        continue;
      }

      await this.add(newBase, filePath);
    }
  }

  /**
   * CRC32 checksum
   */
  private crc32(buffer: Buffer): Promise<number>;
  private crc32(filePath: string): Promise<number>;
  private crc32(data: string | Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
      const checksum = new CRC32Stream();

      checksum.on('end', function (err: Error) {
        if (err) return reject(err);

        resolve(checksum.digest().readUInt32BE());
      });
      checksum.on('data', () => {});
      checksum.on('error', function (err) {
        return reject(err);
      });

      if (typeof data === 'string') {
        const source = fs.createReadStream(data);
        source.pipe(checksum);
      } else {
        checksum.write(data);
        checksum.end();
      }
    });
  }

  /**
   * write local file header
   */
  private writeLFH(entry: Entry) {
    const flag = this.getFlag();
    const nameBuffer = Buffer.from(entry.name);
    const extra = this.getExtra(entry);

    // signature
    this.write32(SignatureEnum.LFH);
    // extract version
    this.write16(
      entry.zip64 ? VersionEnum.ZIP64 : VersionEnum.EXTRACT_MIN_VERSION,
    );
    // general purpose bit flag
    this.write16(flag);
    // compress method
    this.write16(CompressMethodEnum.DEFLATE);
    // TODO: date and time
    this.write32(0);
    // crc32
    this.write32(entry.crc32);
    // compressed size
    this.write32(
      entry.zip64 ? Size.ZIP64_LIMITATION : entry.compressedBuffer.length,
    );
    // uncompressed size
    this.write32(entry.zip64 ? Size.ZIP64_LIMITATION : entry.uncompressedSize);
    // filename length
    this.write16(nameBuffer.length);
    // extra field length
    this.write16(extra.length);
    // filename
    this.writer.write(nameBuffer);
    // extra field
    this.writer.write(extra);
    // file chunk
    this.writer.write(entry.compressedBuffer);
  }

  /**
   * write central directory header
   */
  private writeCentralDirHeader(entry: Entry) {
    const flag = this.getFlag();
    const nameBuffer = Buffer.from(entry.name);
    const extra = this.getExtra(entry);
    const fileComment = Buffer.alloc(0);

    // signature
    this.write32(SignatureEnum.CENTRAL_DIRECTORY_HEADER);
    // compress version
    this.write16(
      entry.zip64 ? VersionEnum.ZIP64 : VersionEnum.EXTRACT_MIN_VERSION,
    );
    // extract version
    this.write16(
      entry.zip64 ? VersionEnum.ZIP64 : VersionEnum.EXTRACT_MIN_VERSION,
    );
    // general purpose bit flag
    this.write16(flag);
    // compress method
    this.write16(CompressMethodEnum.DEFLATE);
    // TODO: date and time
    this.write32(0);
    // crc32
    this.write32(entry.crc32);
    // compressed size
    this.write32(entry.compressedBuffer.length);
    // uncompressed size
    this.write32(entry.zip64 ? Size.ZIP64_LIMITATION : entry.uncompressedSize);
    // filename length
    this.write16(nameBuffer.length);
    // extra field length
    this.write16(extra.length);
    // file comment length
    this.write16(fileComment.length);
    // disk number
    this.write16(0);
    // internal attributes
    this.write16(0);
    // external attributes
    this.write32(0);
    // entry local file header offset
    this.write32(entry.offsetMap.lfh);

    // filename
    this.writer.write(nameBuffer);
    // extra field
    this.writer.write(extra);
    // file comment
    this.writer.write(fileComment);
  }

  /**
   * write central directory end record
   */
  private writeCentralDirEndRecord(centralDirHeaderAttr: CentralDirHeaderAttr) {
    const fileComment = this.getFileComment();

    // signature
    this.write32(SignatureEnum.CENTRAL_DIRECTORY_END_RECORD);
    // number of this disk
    this.write16(0);
    // number of the disk with the start of the central directory
    this.write16(0);
    // total number of entries in the central directory on this disk
    this.write16(this.list.length);
    // total number of entries in the central directory
    this.write16(this.list.length);
    // size of the central directory
    this.write32(centralDirHeaderAttr.size);
    // offset of start of central directory with respect to the starting disk number
    this.write32(centralDirHeaderAttr.offset);
    // ZIP file comment length
    this.write16(fileComment.length);
    // ZIP file comment
    this.writer.write(fileComment);
  }

  /**
   * write 2 bytes buffer
   */
  private write16(data: number) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(data);

    this.writer.write(buffer);
  }

  /**
   * write 4 bytes buffer
   */
  private write32(data: number) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(data);

    this.writer.write(buffer);
  }

  /**
   * write 8 bytes buffer
   */
  private write64(data: number | bigint) {
    const buffer = Buffer.alloc(8);
    if (typeof data === 'number') {
      data = BigInt(data);
    }
    buffer.writeBigUInt64LE(data);

    this.writer.write(buffer);
  }

  /**
   * get flat by deflate level
   */
  private getFlag(): number {
    switch (this.option?.zlib?.level) {
      case zlib.constants.Z_BEST_COMPRESSION: {
        return FlagEnum.DEFLATE_BEST_COMPRESSION;
      }
      case zlib.constants.Z_BEST_SPEED: {
        return FlagEnum.DEFLATE_FASTEST_COMPRESSION;
      }
      default: {
        return FlagEnum.DEFLATE_NORMAL_COMPRESSION;
      }
    }
  }

  /**
   * compress file chunk through deflate
   */
  private compress(entry: Entry): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const deflateRaw = new DeflateRaw(this.option?.zlib ?? {});

      const bufferList: Buffer[] = [];
      deflateRaw.on('data', (chunk) => {
        bufferList.push(chunk);
      });
      deflateRaw.on('error', (err) => {
        reject(err);
      });
      deflateRaw.on('end', () => {
        resolve(Buffer.concat(bufferList));
      });

      if (entry.buffer) {
        deflateRaw.end(entry.buffer);
      } else {
        const rs = fs.createReadStream(entry.filePath);
        rs.pipe(deflateRaw);
      }
    });
  }

  /**
   * get extra field buffer
   */
  private getExtra(entry: Entry): Buffer {
    if (!entry.zip64) {
      return Buffer.alloc(0);
    }

    // zip64 extra field
    const buffer = Buffer.alloc(20);
    buffer.writeUInt16LE(0x0001);
    buffer.writeUInt16LE(16, 2);
    buffer.writeBigUInt64LE(BigInt(entry.uncompressedSize), 4);
    buffer.writeBigUint64LE(BigInt(entry.compressedBuffer.length), 12);

    return buffer;
  }

  /**
   * get ZIP file comment
   */
  private getFileComment(): Buffer {
    return Buffer.alloc(0);
  }
}
