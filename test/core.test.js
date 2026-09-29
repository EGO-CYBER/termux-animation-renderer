import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs } from '../src/cli.js';
import { staticLint } from '../src/lint.js';
import { unitTime, buildFfmpegArgs, runFramePipeline, resolveThreadCount } from '../src/renderer.js';
import { progressLine, formatDuration } from '../src/ui.js';
import { validateVideoConfig, sanitizeOutputName, computeRenderPlan } from '../src/animation-loader.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parseArgs: команды, сокращение и флаги', () => {
    assert.equal(parseArgs(['render', 'a.html', '-o', 'x', '--draft']).flags.o, 'x');
    assert.equal(parseArgs(['a.html']).command, 'render');
    const p = parseArgs(['queue', 'a.html', 'b.html', '--blur', '4']);
    assert.deepEqual(p.positional, ['a.html', 'b.html']);
    assert.equal(p.flags.blur, '4');
});

test('lint: находит недетерминизм и внешние ресурсы, игнорирует комментарии', () => {
    const html = `<script src="https://cdn.x/a.js"></script>
<script>
// Date.now() в комментарии не считается
const t = Math.random();
requestAnimationFrame(loop);
</script>`;
    const codes = staticLint(html).map((i) => i.code);
    assert.ok(codes.includes('ext-script'));
    assert.ok(codes.includes('math-random'));
    assert.ok(codes.includes('raf'));
    assert.ok(!codes.includes('date-now'));
});

test('unitTime: без blur = i/fps, с blur усредняет вокруг кадра', () => {
    assert.equal(unitTime(3, 30, 1), 3 / 30);
    const ts = [0, 1, 2, 3].map((i) => unitTime(i + 4, 10, 4)); // кадр 1
    assert.ok(ts.every((t, k) => k === 0 || t > ts[k - 1]));
    assert.ok(Math.abs((ts[0] + ts[3]) / 2 - 0.1) < 1e-9);
});

test('validateVideoConfig / sanitizeOutputName / plan', () => {
    assert.throws(() => validateVideoConfig({ width: -1, height: 1, fps: 30, duration: 1 }));
    assert.throws(() => validateVideoConfig({ width: 10, height: 10, fps: 30, duration: 1, audio: 5 }));
    assert.equal(computeRenderPlan({ width: 1, height: 1, fps: 30, duration: 10 }).frameCount, 300);
    assert.equal(sanitizeOutputName('a/b:c.mp4'), 'a_b_c.mp4');
});

test('resolveThreadCount: не больше числа кадров', () => {
    assert.equal(resolveThreadCount(8, 3), 3);
    assert.equal(resolveThreadCount(0, 10), 1);
});

test('progressLine / formatDuration', () => {
    const line = progressLine(50, 100, 0, 10000);
    assert.match(line, /50%/);
    assert.match(line, /осталось ~10с/);
    assert.equal(formatDuration(125), '2м 05с');
});

test('pipeline: кадры записываются строго по порядку при разной скорости', async () => {
    const out = [];
    await runFramePipeline({
        total: 40, workers: 4,
        renderFrame: async (w, i) => { await sleep((i * 7) % 11); return i; },
        sink: async (b) => { out.push(b); }
    });
    assert.deepEqual(out, Array.from({ length: 40 }, (_, i) => i));
});

test('pipeline: ошибка кадра прерывает рендер', async () => {
    await assert.rejects(runFramePipeline({
        total: 10, workers: 3,
        renderFrame: async (w, i) => { if (i === 4) throw new Error('boom'); return i; },
        sink: async () => {}
    }), /boom/);
});

test('pipeline: зависший кадр в хвосте дублируется и не тормозит финиш', async () => {
    const calls = new Map();
    const out = [];
    const started = Date.now();
    await runFramePipeline({
        total: 6, workers: 3,
        stragglerMs: () => 150,
        renderFrame: async (w, i) => {
            const n = (calls.get(i) || 0) + 1;
            calls.set(i, n);
            if (i === 5 && n === 1) await sleep(5000); // первая попытка зависает
            else await sleep(10);
            return i;
        },
        sink: async (b) => { out.push(b); }
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
    assert.ok(Date.now() - started < 2500, 'финиш не должен ждать зависший кадр');
    assert.equal(calls.get(5), 2);
});

test('pipeline: уменьшение limit останавливает лишних исполнителей', async () => {
    const limit = { value: 4 };
    const seen = new Set();
    await runFramePipeline({
        total: 30, workers: 4, limit,
        renderFrame: async (w, i) => { seen.add(w); if (i === 5) limit.value = 1; await sleep(5); return i; },
        sink: async () => {}
    });
    assert.ok(seen.size >= 1);
});

const ffmpegOk = spawnSync('ffmpeg', ['-version']).status === 0;
test('ffmpeg: кадры через pipe (обычный и motion blur) собираются в MP4', { skip: !ffmpegOk }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-test-'));
    const frame = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=101x75:rate=1', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { maxBuffer: 1 << 24 }).stdout;
    for (const blur of [1, 3]) {
        const outputPath = join(dir, `o${blur}.mp4`);
        const args = buildFfmpegArgs({ fps: 10, blur, format: 'png', preset: 'ultrafast', crf: 30, outputPath });
        const res = spawnSync('ffmpeg', args, { input: Buffer.concat(Array(10 * blur).fill(frame)), maxBuffer: 1 << 24 });
        assert.equal(res.status, 0, String(res.stderr));
        const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames,width,height', '-of', 'csv=p=0', outputPath], { encoding: 'utf8' });
        const [w, h, n] = probe.stdout.trim().split(',');
        assert.equal(Number(n), 10, `blur=${blur}: кадров ${n}`);
        assert.equal(Number(w) % 2, 0);
        assert.equal(Number(h) % 2, 0);
    }
});
