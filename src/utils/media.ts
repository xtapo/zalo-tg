import axios from 'axios';
import { createWriteStream, mkdirSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

const TMP_DIR = path.join(os.tmpdir(), 'zalo-tg');

/** Download a remote URL to a temp file. Returns the local file path. */
export async function downloadToTemp(url: string, fileName?: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });

  // Sanitize filename and add a unique prefix so concurrent downloads
  // with the same logical name (e.g. multiple 'photo.jpg' in a media group)
  // do not overwrite each other.
  const baseName = (fileName ?? `download_${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128);

  const filePath = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);

  const resp = await axios.get<NodeJS.ReadableStream>(url, {
    responseType: 'stream',
    timeout: 30_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZaloTGBridge/1.0)' },
  });

  await new Promise<void>((resolve, reject) => {
    const writer = createWriteStream(filePath);
    resp.data.pipe(writer);
    writer.on('finish', () => {
      try {
        const stats = statSync(filePath);
        if (stats.size === 0) {
          reject(new Error('Downloaded file is 0 bytes'));
        } else {
          resolve();
        }
      } catch (e) {
        reject(e);
      }
    });
    writer.on('error', reject);
  });

  return filePath;
}

/** Remove a temp file, ignoring errors. */
export async function cleanTemp(filePath: string): Promise<void> {
  try { await unlink(filePath); } catch { /* ignore */ }
}

/**
 * Convert an audio file to M4A (AAC) using ffmpeg.
 * Returns the path to the converted file (caller must clean it up).
 */
export async function convertToM4a(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `voice_${Date.now()}.m4a`);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-c:a', 'aac', '-b:a', '64k', '-ar', '44100',
      '-vn', outputPath,
    ]);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    ff.on('error', reject);
  });
  return outputPath;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv']);

/** Guess media type from filename or URL. */
export function detectMediaType(fileNameOrUrl: string): 'image' | 'video' | 'document' {
  const lower = fileNameOrUrl.toLowerCase();
  const ext = path.extname(lower.split('?')[0] ?? '');
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/.test(lower)) return 'image';
  if (/\.(mp4|mov|avi|mkv|webm)(\?|$)/.test(lower)) return 'video';
  return 'document';
}
