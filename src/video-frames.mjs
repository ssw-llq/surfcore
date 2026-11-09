// QQ 入站视频 → 九宫格抽帧（bridge.js 的视频看画面能力，逻辑抽成模块便于单测）。
//
// 背景（2026-11-07）：QQ 视频以前只被 segmentsToText 写成一行「[视频]」，模型完全
// 看不到画面。现在桥保留 video 段元数据，按需下载原片 → ffmpeg 按时间均匀抽 9 帧 →
// 拼成 3x3 九宫格 jpg，交给 mcp__snowluma__qq_get_message_images（纯透传）当图片返回。
//
// 为什么不用 src/safe-fetch.js 的 safeFetchBuffer：那个函数末尾强制 looksLikeImageBuffer，
// 只接受图片字节（SSRF 地址固定校验只覆盖图片路径）；视频要单独抓、单独限尺寸。
// 注意：这里只做「明显内网主机名/私有 IP」拦截 + 限制字节数，不做 DNS 解析后地址固定
// （视频 URL 一律来自 SnowLuma 网关事件里的 QQ CDN 直链，不接受用户任意输入）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const DEFAULT_MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB：手机拍的短视频够用，再大也不该塞进模型上下文
export const SHEET_COLUMNS = 3;
export const SHEET_ROWS = 3;
export const SHEET_FRAMES = SHEET_COLUMNS * SHEET_ROWS;
export const SHEET_CELL_WIDTH = 480;
export const SHEET_CELL_HEIGHT = 270;
// 下限要够低才能覆盖长视频：9 帧 ÷ 帧率 = 覆盖时长；0.001fps ≈ 2.5 小时全覆盖。
// （2026-11-07：原先 0.05 会让超过 3 分钟的视频只抽到前 3 分钟，后半段静默丢失。）
export const MIN_SHEET_FPS = 0.001;
export const MAX_SHEET_FPS = 60;
const PROBE_TIMEOUT_MS = 20000;
const RENDER_TIMEOUT_MS = 180000;

/** 内网/本机主机名判定（只认字面量；域名不解析）。 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false; // 域名：交给公网 DNS，不做内网猜测
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return true; // 非法 IP 一律拒绝
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** 从 ffmpeg -i 的输出里解析时长（秒）；解析不到返回 0。 */
export function probeDurationSeconds(output) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(output ?? ''));
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 让 9 帧均匀铺满整段视频：fps 取 9/时长，并夹在安全区间内。 */
export function pickSheetFps(durationSeconds, frameCount = SHEET_FRAMES) {
  const duration = Number(durationSeconds);
  const frames = Number(frameCount) > 0 ? Number(frameCount) : SHEET_FRAMES;
  if (!Number.isFinite(duration) || duration <= 0) return 1;
  return Math.min(MAX_SHEET_FPS, Math.max(MIN_SHEET_FPS, frames / duration));
}

/** 拼九宫格的 ffmpeg 参数（拆出来是为了单测能断言滤镜串，不用真跑 ffmpeg）。 */
export function buildSheetArgs({ inputPath, outputPath, fps }) {
  const filter = [
    `fps=${Number(fps).toFixed(4)}`,
    `scale=${SHEET_CELL_WIDTH}:${SHEET_CELL_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${SHEET_CELL_WIDTH}:${SHEET_CELL_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
    `tile=${SHEET_COLUMNS}x${SHEET_ROWS}`
  ].join(',');
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-an', '-vf', filter, '-frames:v', '1', '-q:v', '3', outputPath];
}

/**
 * 找 ffmpeg：显式配置 → SurfCore B站 插件装的静态版 → PATH 里的 ffmpeg。
 * B站 那个位置（~/.dsh/surfcore/bili/bin/ffmpeg.exe）是 2026-11-07 给 B站 抽帧装上的，
 * 视频抽帧直接复用，不要求用户再装第二份。
 */
export function resolveVideoFfmpeg({ explicit = null, homeDir = os.homedir(), platform = process.platform } = {}) {
  const wanted = explicit ? String(explicit) : '';
  if (wanted) {
    try {
      if (fs.statSync(wanted).isFile()) return wanted;
    } catch {}
  }
  const installed = path.join(homeDir, '.dsh', 'surfcore', 'bili', 'bin', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  try {
    if (fs.statSync(installed).isFile()) return installed;
  } catch {}
  return wanted || 'ffmpeg';
}

/** 子进程跑完/超时都 resolve，不 throw（错误统一由调用方判定）。 */
export function runProcessTimed(command, args, { timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: `启动失败：${error?.message ?? error}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ code: -1, stdout, stderr: `${stderr}\n处理超时（>${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-200_000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-200_000);
    });
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}\n${error?.message ?? error}` }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** 下载视频原片（限尺寸、限内网目标、限超时）。 */
export async function fetchHttpVideoBuffer(urlString, { maxBytes = DEFAULT_MAX_VIDEO_BYTES, timeoutMs = 120000 } = {}) {
  const raw = String(urlString ?? '').trim();
  if (!/^https?:\/\//i.test(raw)) throw new Error('不是 http(s) 地址');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('视频地址格式不对');
  }
  if (isPrivateHost(parsed.hostname)) throw new Error(`拒绝内网地址 ${parsed.hostname}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(parsed.toString(), { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`视频下载失败：HTTP ${res.status}`);
    const finalHost = (() => {
      try {
        return new URL(res.url).hostname;
      } catch {
        return parsed.hostname;
      }
    })();
    if (isPrivateHost(finalHost)) throw new Error(`拒绝内网地址 ${finalHost}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`视频太大（${(declared / 1048576).toFixed(1)}MB > 上限 ${Math.round(maxBytes / 1048576)}MB）`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error(`视频太大（${(buffer.length / 1048576).toFixed(1)}MB）`);
    if (buffer.length < 1024) throw new Error('视频下载结果为空');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Buffer 里的视频 → 3x3 九宫格 jpg。
 * 返回 { buffer, mimeType, durationSeconds, text }；失败抛 Error（信息给人看）。
 */
export async function buildVideoSheetFromBuffer(buffer, { ffmpegPath = null, tmpDir = null, timeoutMs = RENDER_TIMEOUT_MS, fps = null } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('视频数据为空');
  const ffmpeg = resolveVideoFfmpeg({ explicit: ffmpegPath });
  const dir = tmpDir ? path.resolve(tmpDir) : path.join(os.tmpdir(), 'qq-video-sheets');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(dir, `in-${stamp}.mp4`);
  const outputPath = path.join(dir, `sheet-${stamp}.jpg`);
  fs.writeFileSync(inputPath, buffer);
  try {
    const probe = await runProcessTimed(ffmpeg, ['-hide_banner', '-i', inputPath], { timeoutMs: Math.min(PROBE_TIMEOUT_MS, timeoutMs) });
    const probeText = `${probe.stderr}\n${probe.stdout}`;
    const duration = probeDurationSeconds(probeText);
    if (!duration && !/Stream #\d+:\d+.*Video:/i.test(probeText)) {
      throw new Error((probeText || '').trim().slice(0, 200) || '看起来不是能解码的视频文件');
    }
    const chosenFps = Number(fps) > 0 ? Number(fps) : pickSheetFps(duration);
    const render = await runProcessTimed(ffmpeg, buildSheetArgs({ inputPath, outputPath, fps: chosenFps }), { timeoutMs });
    if (render.code !== 0) throw new Error((render.stderr || '').trim().slice(0, 300) || `ffmpeg 退出码 ${render.code}`);
    const sheet = fs.readFileSync(outputPath);
    if (!sheet.length) throw new Error('ffmpeg 没有产出九宫格');
    return {
      buffer: sheet,
      mimeType: 'image/jpeg',
      durationSeconds: duration,
      text: `视频${duration > 0 ? `（约 ${duration.toFixed(1)} 秒）` : ''}：按时间均匀抽 ${SHEET_FRAMES} 帧拼成的 3x3 九宫格，大致从左到右、从上到下按时间排列`
    };
  } finally {
    for (const file of [inputPath, outputPath]) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
}
