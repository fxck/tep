// Regenerate the social-share image from og.svg → public/og.png (1200x630).
//   cd web && npm i --no-save sharp && node og.render.mjs
// Needs the Inter font available to fontconfig (Alpine: `apk add font-inter fontconfig`).
import sharp from 'sharp';

await sharp('og.svg', { density: 300 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile('public/og.png');

console.log('wrote public/og.png');
