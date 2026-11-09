// QQ 视频抽帧链路自检（2026-11-07 加重）：
// 1. 纯函数断言：内网判定、时长解析、fps 选择、ffmpeg 参数、ffmpeg 查找顺序
// 2. 下载防护断言：内网/非 http 地址必须被拒
// 3. 可选真实渲染：本机有 ffmpeg 时，用 lavfi 生成 3 秒测试视频 → 抽成 3x3 九宫格 → 校验是 jpg
// 运行：node scripts/test-video-frames.mjs
//
// 不依赖桥运行中；没有 ffmpeg 的机器上第 3 段会跳过（不算失败），其余断言照常。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SHEET_FRAMES,
  buildSheetArgs,
  buildVideoSheetFromBuffer,
  fetchHttpVideoBuffer,
  isPrivateHost,
  pickSheetFps,
  probeDurationSeconds,
  resolveVideoFfmpeg,
  runProcessTimed
} from '../src/video-frames.mjs';

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function skip(name, reason) {
  skipped += 1;
  console.log(`⚠️ 跳过 ${name} — ${reason}`);
}

// ── 1. 纯函数 ─────────────────────────────────────────────────────────────
check('SHEET_FRAMES 是 9（3x3）', SHEET_FRAMES === 9);
check('isPrivateHost 拒绝 localhost/127/内网段', ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.8', '172.16.5.5', '172.31.255.1', '169.254.1.1', '[::1]', ''].every((h) => isPrivateHost(h)));
check('isPrivateHost 放行公网域名/公网 IP', ['upos-sz-mirrorcos.bilivideo.com', '8.8.8.8', '120.24.1.1', '172.32.0.1'].every((h) => !isPrivateHost(h)));
check('probeDurationSeconds 解析 ffmpeg -i 输出', probeDurationSeconds('  Duration: 00:01:30.50, start: 0.000000') === 90.5);
check('probeDurationSeconds 解析小时段', probeDurationSeconds('Duration: 01:02:03.00') === 3723);
check('probeDurationSeconds 认不出时返回 0', probeDurationSeconds('no duration here') === 0);
check('pickSheetFps 长视频取 9/时长', Math.abs(pickSheetFps(90) - 0.1) < 1e-9, `得到 ${pickSheetFps(90)}`);
check('pickSheetFps 短视频够 9 帧', Math.abs(pickSheetFps(3) - 3) < 1e-9, `得到 ${pickSheetFps(3)}`);
check('pickSheetFps 未知时长回退 1fps', pickSheetFps(0) === 1);
check('pickSheetFps 夹在 0.001~60', pickSheetFps(100000) === 0.001 && pickSheetFps(0.05) === 60, `极大 ${pickSheetFps(100000)} / 极小 ${pickSheetFps(0.05)}`);
check('pickSheetFps 5 分钟视频 0.03fps 全片覆盖', Math.abs(pickSheetFps(300) - 0.03) < 1e-9, `得到 ${pickSheetFps(300)}`);

const args = buildSheetArgs({ inputPath: 'in.mp4', outputPath: 'out.jpg', fps: 0.1 });
check('buildSheetArgs 用 3x3 tile', /tile=3x3/.test(args[args.indexOf('-vf') + 1]), args[args.indexOf('-vf') + 1]);
check('buildSheetArgs 只出一帧', args.includes('-frames:v') && args[args.indexOf('-frames:v') + 1] === '1');
check('buildSheetArgs 带 fps/scale/pad 滤镜', /^fps=0\.1000,scale=480:270.*,pad=480:270.*,tile=3x3$/.test(args[args.indexOf('-vf') + 1]), args[args.indexOf('-vf') + 1]);
check('buildSheetArgs 输出路径在最后一参', args[args.length - 1] === 'out.jpg');

// ffmpeg 查找顺序：显式文件优先 → home 下 B站 静态版 → 明确不存在时退回 'ffmpeg'
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frames-test-'));
const biliBin = path.join(tmpHome, '.dsh', 'surfcore', 'bili', 'bin');
fs.mkdirSync(biliBin, { recursive: true });
const fakeFfmpeg = path.join(biliBin, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
fs.writeFileSync(fakeFfmpeg, 'not really an executable');
check('resolveVideoFfmpeg 找到 B站 静态版', resolveVideoFfmpeg({ homeDir: tmpHome }) === fakeFfmpeg);
check('resolveVideoFfmpeg 显式路径优先', resolveVideoFfmpeg({ explicit: fakeFfmpeg, homeDir: path.join(tmpHome, 'nothome') }) === fakeFfmpeg);
check('resolveVideoFfmpeg 都没有时退回 ffmpeg', resolveVideoFfmpeg({ homeDir: path.join(tmpHome, 'nothome') }) === 'ffmpeg');

// ── 2. 下载防护 ───────────────────────────────────────────────────────────
const rejected = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
};
const localReason = await rejected(fetchHttpVideoBuffer('http://127.0.0.1:8080/a.mp4'));
check('fetchHttpVideoBuffer 拒绝 127.0.0.1', /内网/.test(String(localReason)), localReason);
const lanReason = await rejected(fetchHttpVideoBuffer('http://192.168.1.9/a.mp4'));
check('fetchHttpVideoBuffer 拒绝 192.168 段', /内网/.test(String(lanReason)), lanReason);
const schemeReason = await rejected(fetchHttpVideoBuffer('file:///c:/a.mp4'));
check('fetchHttpVideoBuffer 拒绝非 http 协议', /http/.test(String(schemeReason)), schemeReason);

// ── 3. 真实渲染（有 ffmpeg 才跑）──────────────────────────────────────────
const ffmpegPath = resolveVideoFfmpeg({});
const probe = spawnSync(ffmpegPath, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 15000 });
const hasFfmpeg = probe.status === 0 && /ffmpeg version/i.test(String(probe.stdout || ''));
if (!hasFfmpeg) {
  skip('真实渲染 3 秒测试视频 → 九宫格', `本机没有可用 ffmpeg（解析到 ${ffmpegPath}）`);
} else {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-frames-render-'));
  const clip = path.join(workDir, 'clip.mp4');
  const make = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=3', '-c:v', 'mpeg4', '-q:v', '5', clip], { encoding: 'utf8', timeout: 60000 });
  if (make.status !== 0 || !fs.existsSync(clip)) {
    skip('真实渲染 3 秒测试视频 → 九宫格', `lavfi 素材生成失败：${String(make.stderr || '').trim().slice(0, 120)}`);
  } else {
    try {
      const sheet = await buildVideoSheetFromBuffer(fs.readFileSync(clip), { tmpDir: workDir });
      check('真实渲染返回 jpg', sheet?.mimeType === 'image/jpeg' && sheet.buffer?.[0] === 0xff && sheet.buffer?.[1] === 0xd8, `前两字节 ${sheet?.buffer?.subarray(0, 2).toString('hex')}`);
      check('真实渲染九宫格够大', (sheet?.buffer?.length ?? 0) > 3000, `${sheet?.buffer?.length} bytes`);
      check('真实渲染识别出时长约 3 秒', Math.abs((sheet?.durationSeconds ?? 0) - 3) < 0.5, `${sheet?.durationSeconds}s`);
      check('真实渲染给出人读文案', /3x3/.test(String(sheet?.text || '')), sheet?.text);
    } catch (error) {
      check('真实渲染 3 秒测试视频 → 九宫格', false, String(error?.message ?? error));
    }
  }
  for (const file of ['clip.mp4']) {
    try {
      fs.unlinkSync(path.join(workDir, file));
    } catch {}
  }
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {}
}

// runProcessTimed 超时/正常退出都不 throw
const echo = await runProcessTimed(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 15000 });
check('runProcessTimed 正常命令返回 code 0', hasFfmpeg ? echo.code === 0 : true, hasFfmpeg ? '' : '没有 ffmpeg，跳过真实命令');
const bogus = await runProcessTimed('definitely-not-a-command-xyz', ['--help'], { timeoutMs: 5000 });
check('runProcessTimed 启动失败也不 throw', bogus.code === -1 && /启动失败|ENOENT|not found/i.test(String(bogus.stderr)), String(bogus.stderr).slice(0, 120));

// ── bridge.js 集成回归（源码断言）──────────────────────────────────────────
// 真实 QQ 视频进来的那天（2026-11-07 20:25）踩到两个「拍平」问题。单元测试够不到
// main() 闭包里的 appendSocialV2Message / findMessageMedia，所以在源码层面钉住不变量：
//   ① 入站媒体写进二代会话状态时，video 不能被拍平成 image——否则 mp4 被当图片下载、
//      超过 8MB 直接失败，用户发视频永远看不到画面；
//   ② findMessageMedia 必须先查 messageMediaStore（入站时原始字段最全），再退回 state。
const bridgeSourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bridge.js');
const bridgeSource = fs.readFileSync(bridgeSourcePath, 'utf8');
check(
  'bridge 存储层保留 video kind',
  /const kind = m\?\.kind === 'video'[\s\S]{0,40}\? 'video'/.test(bridgeSource),
  'appendSocialV2Message 的 safeMedia'
);
const findStart = bridgeSource.indexOf('function findMessageMedia(');
const findBody = findStart >= 0 ? bridgeSource.slice(findStart, findStart + 4000) : '';
const storeIdx = findBody.indexOf('messageMediaStore.get(key)');
const stateIdx = findBody.indexOf('getSocialV2State(key)');
check(
  'findMessageMedia 先查 messageMediaStore 再退回 state',
  storeIdx >= 0 && stateIdx >= 0 && storeIdx < stateIdx,
  `store@${storeIdx} state@${stateIdx}`
);
check(
  'bridge 视频抽帧分支存在',
  bridgeSource.includes("media.kind === 'video'") && bridgeSource.includes('buildVideoFrames(media)'),
  'fetchMediaData'
);

try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch {}

console.log(`\n结果：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`);
process.exit(failed === 0 ? 0 : 1);
