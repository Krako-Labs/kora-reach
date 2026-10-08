// Hash-pinned production assets; absence or substitution must stop packaging.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const frozenHeroAssets = Object.freeze({
  light: Object.freeze({
    filename: 'ReachHeroFrozenLight.png',
    sourceSHA256: '298f48f2911b7f9fd69b2c5cfe3d6a8977fcff622c17d11962a39700f3042aae',
    pngSHA256: 'cc2b9fb19e8efb81dd2a35639f2d6519f17efa620dc3a9f814b10819699fb561',
    pixelSHA256: 'f6b313b49d9475a28d09e1f4412893055d11d7d20dae6195f85889a9167820c5',
  }),
  dark: Object.freeze({
    filename: 'ReachHeroFrozenDark.png',
    sourceSHA256: '52e0d8a8e926af9f3ab6723d85127327d6d959de420540b16655017d870efe1f',
    pngSHA256: '0db3fe838dbb8025f763c69f7dcb73646147b8f927af3cd663030a9a5bf3f45b',
    pixelSHA256: '08128425025032b61794219478943c027f79b5de345c3bb499eb11b4ada108e6',
  }),
});
export async function assertFrozenHeroAssets(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'ReachHeroFrozen.json'), 'utf8'));
  if (manifest.format !== 1 || manifest.method !== 'frozen-source-crop-resize-only' ||
      manifest.generatedArtwork !== false || manifest.recolored !== false || manifest.masked !== false ||
      JSON.stringify(manifest.sourceRectangle) !== '[375,69,1022,324]' ||
      JSON.stringify(manifest.outputPixels) !== '[448,177]') throw new Error('Invalid frozen hero crop contract');
  for (const [theme, expected] of Object.entries(frozenHeroAssets)) {
    const item = manifest.assets?.[theme];
    for (const field of ['filename', 'sourceSHA256', 'pngSHA256', 'pixelSHA256']) {
      if (item?.[field] !== expected[field]) throw new Error(`Frozen ${theme} ${field} mismatch`);
    }
    const data = await readFile(path.join(directory, expected.filename));
    if (data.length < 33 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        data.readUInt32BE(16) !== 448 || data.readUInt32BE(20) !== 177 ||
        createHash('sha256').update(data).digest('hex') !== expected.pngSHA256) {
      throw new Error(`Frozen ${theme} hero missing, truncated, or changed`);
    }
  }
  // Later user approval supersedes the legacy Dark image only; retain both frozen originals.
  const approvedDark = await readFile(path.join(directory, 'ReachHeroApprovedDark.png'));
  if (createHash('sha256').update(approvedDark).digest('hex') !==
      'b964667de71ab657aa9e1ad5e318017adedfd789e2b145ec4ac62825f2a45b9b')
    throw new Error('Approved 2026-09-25 Dark hero missing or changed');

  // R10 Figma visual master supersedes the previous Dark hero presentation.
  // Keep older approved assets for provenance, but pin the currently rendered Figma raster too.
  const figmaDark = await readFile(path.join(directory, 'ReachHeroFigmaDark.png'));
  if (figmaDark.length < 33 || figmaDark.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      figmaDark.readUInt32BE(16) !== 887 || figmaDark.readUInt32BE(20) !== 1774 ||
      createHash('sha256').update(figmaDark).digest('hex') !==
        '2b2f8ebf92aeab5a602780a5635b850c1df343498b828d9e25623d430d44c449')
    throw new Error('Figma 2026-09-26 Dark hero missing or changed');

  return {
    integrity: true,
    width: 448,
    height: 177,
    themes: ['light', 'dark'],
    activeDark: 'ReachHeroFigmaDark.png',
    visualAcceptance: false,
  };
}
