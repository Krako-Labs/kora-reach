import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertFrozenHeroAssets, frozenHeroAssets } from '../scripts/lib/frozen-hero.mjs';

const roots = [];
async function fixture(change = () => {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reach-frozen-hero-test-'));
  roots.push(root);
  const manifest = {
    format: 1, method: 'frozen-source-crop-resize-only',
    sourceRectangle: [375, 69, 1022, 324], outputPixels: [448, 177],
    generatedArtwork: false, recolored: false, masked: false,
    assets: structuredClone(frozenHeroAssets),
  };
  change(manifest);
  await writeFile(path.join(root, 'ReachHeroFrozen.json'), JSON.stringify(manifest));
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('frozen hero raster contract', () => {
  it('pins distinct, immutable Light and Dark references', () => {
    expect(Object.isFrozen(frozenHeroAssets)).toBe(true);
    expect(Object.isFrozen(frozenHeroAssets.light)).toBe(true);
    expect(Object.isFrozen(frozenHeroAssets.dark)).toBe(true);
    expect(frozenHeroAssets.light.sourceSHA256).not.toBe(frozenHeroAssets.dark.sourceSHA256);
    expect(frozenHeroAssets.light.pngSHA256).not.toBe(frozenHeroAssets.dark.pngSHA256);
  });
  it.each(['generatedArtwork', 'recolored', 'masked'])('rejects a %s derivative', async field => {
    const root = await fixture(m => { m[field] = true; });
    await expect(assertFrozenHeroAssets(root)).rejects.toThrow('Invalid frozen hero crop contract');
  });
  it('rejects a changed source rectangle', async () => {
    const root = await fixture(m => { m.sourceRectangle = [350, 65, 1005, 320]; });
    await expect(assertFrozenHeroAssets(root)).rejects.toThrow('Invalid frozen hero crop contract');
  });
  it('rejects a resized derivative', async () => {
    const root = await fixture(m => { m.outputPixels = [460, 179]; });
    await expect(assertFrozenHeroAssets(root)).rejects.toThrow('Invalid frozen hero crop contract');
  });
  it('rejects a changed reference SHA before loading any artwork', async () => {
    const root = await fixture(m => { m.assets.light.sourceSHA256 = '0'.repeat(64); });
    await expect(assertFrozenHeroAssets(root)).rejects.toThrow('Frozen light sourceSHA256 mismatch');
  });
  it('fails closed when the exact PNG is absent', async () => {
    const root = await fixture();
    await expect(assertFrozenHeroAssets(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a truncated PNG rather than falling back to the old hero', async () => {
    const root = await fixture();
    await writeFile(path.join(root, frozenHeroAssets.light.filename), Buffer.from('89504e470d0a1a0a', 'hex'));
    await expect(assertFrozenHeroAssets(root)).rejects.toThrow('Frozen light hero missing, truncated, or changed');
  });
  it('rejects substituted image bytes even when dimensions match', async () => {
    const root = await fixture();
    const bytes = Buffer.alloc(64);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    bytes.writeUInt32BE(448, 16); bytes.writeUInt32BE(177, 20);
    await writeFile(path.join(root, frozenHeroAssets.light.filename), bytes);
    await expect(assertFrozenHeroAssets(root)).rejects.toThrow('Frozen light hero missing, truncated, or changed');
  });
});
