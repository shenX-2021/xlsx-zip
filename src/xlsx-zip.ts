import fs, { WriteStream } from 'fs';
import fsp from 'fs/promises';
import path from 'path';

import { DeflateCRC32Stream } from 'crc32-stream';
import { Writer } from './writer';
import {
  CompressMethodEnum,
  FlagEnum,
  SignatureEnum,
  SizeEnum,
  VersionEnum,
} from './enum';
import { ZlibOptions } from 'minizlib';
import zlib from 'zlib';

type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never };

interface EntryFilePath {
  filePath: string;
}
interface EntryBuffer {
  bufferList: Buffer[];
}

interface EntryBase {
  name: string;
  uncompressedSize: number;
  compressedSize: number;
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

  private adding = false;
  private finishing = false;

  private id = 0;
  private list: Entry[] = [];
  private set: Set<string> = new Set();

  private writer: Writer;
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
  async add(internalPath: string, bufferList: Buffer[]): Promise<void>;
  async add(
    internalPath: string,
    data: string | Buffer | Buffer[],
  ): Promise<void> {
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
        compressedSize: 0,
        crc32: 0,
        zip64: false,
        offsetMap: {
          lfh: 0,
        },
      };

      const fileStat = await fsp.stat(data);
      entry.uncompressedSize = fileStat.size;
      if (entry.uncompressedSize > 0xffffffff) {
        entry.zip64 = true;
      }
    } else {
      if (Buffer.isBuffer(data)) {
        data = [data];
      }
      const uncompressedSize = data.reduce((prev, cur) => prev + cur.length, 0);

      // buffer
      entry = {
        name: internalPath,
        bufferList: data,
        uncompressedSize,
        compressedSize: 0,
        crc32: 0,
        zip64: uncompressedSize > 0xffffffff,
        offsetMap: {
          lfh: 0,
        },
      };
    }

    this.list.push(entry);
    this.looping();
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
   * finish add action and ready to finalize central directory header and end record
   */
  finish(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.writer.on('end', () => {
        const buf = Buffer.concat(this.buffers);
        resolve(buf);
      });
      this.writer.on('error', (err) => {
        reject(err);
      });

      if (this.adding) {
        this.finishing = true;
        return;
      }

      this.finalize();
    });
  }

  /**
   * finalize handle, write central directory header and end record
   */
  private finalize() {
    if (this.adding || !this.finishing) return;
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
   * write local file header
   */
  private writeLFH(entry: Entry) {
    const flag = this.getFlag();
    const nameBuffer = Buffer.from(entry.name);
    const extra = this.getExtra(entry);

    entry.offsetMap.lfh = this.writer.offset;
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
      entry.zip64 ? SizeEnum.ZIP64_LIMITATION : entry.compressedSize,
    );
    // uncompressed size
    this.write32(
      entry.zip64 ? SizeEnum.ZIP64_LIMITATION : entry.uncompressedSize,
    );
    // filename length
    this.write16(nameBuffer.length);
    // extra field length
    this.write16(extra.length);
    // filename
    this.writer.write(nameBuffer);
    // extra field
    if (extra.length) {
      this.writer.write(extra);
    }
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
    this.write32(entry.compressedSize);
    // uncompressed size
    this.write32(
      entry.zip64 ? SizeEnum.ZIP64_LIMITATION : entry.uncompressedSize,
    );
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
    if (extra.length) {
      this.writer.write(extra);
    }
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
   * looping to write local file header and file chunk
   */
  private looping() {
    if (this.adding) return;

    const entry = this.list[this.id];
    if (entry) {
      this.adding = true;

      this.compress(entry);
    } else {
      this.adding = false;

      this.finalize();
    }
  }

  /**
   * compress file chunk through deflate
   */
  private compress(entry: Entry) {
    // @ts-expect-error ts(2554)
    const checksum = new DeflateCRC32Stream(this.option?.zlib ?? {});

    const bufferList: Buffer[] = [];
    checksum.on('data', (chunk) => {
      bufferList.push(chunk);
    });
    checksum.on('error', (err) => {
      this.writer.emit('error', err);
    });
    checksum.on('end', () => {
      entry.crc32 = checksum.digest().readUInt32LE();
      entry.compressedSize = checksum.size(true);

      this.writeLFH(entry);
      for (const buffer of bufferList) {
        this.writer.write(buffer);
      }

      this.id++;
      this.adding = false;
      this.looping();
    });

    if (entry.bufferList) {
      for (const buffer of entry.bufferList) {
        checksum.write(buffer);
      }
      checksum.end();
    } else {
      const rs = fs.createReadStream(entry.filePath);
      rs.pipe(checksum);
    }
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
    buffer.writeBigUint64LE(BigInt(entry.compressedSize), 12);

    return buffer;
  }

  /**
   * get ZIP file comment
   */
  private getFileComment(): Buffer {
    return Buffer.alloc(0);
  }
}
