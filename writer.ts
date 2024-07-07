import { Stream, TransformCallback } from 'stream';

export class Writer extends Stream.Transform {
  offset = 0;

  write(
    chunk: Buffer,
    encoding?: BufferEncoding,
    cb?: (error: Error | null | undefined) => void,
  ): boolean;
  write(chunk: Buffer, cb?: (error: Error | null | undefined) => void): boolean;
  write(
    chunk: Buffer,
    encoding?: unknown,
    cb?: (error: Error | null | undefined) => void,
  ): boolean {
    if (chunk) {
      this.offset += chunk.length;
    }

    return super.write(chunk, encoding as BufferEncoding, cb);
  }

  _transform(
    chunk: Buffer,
    encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    done(null, chunk);
  }
}
