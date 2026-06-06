/**
 * Fixture generator for the score stage tests.
 *
 * Run once to (re)produce the committed PNG fixtures:
 *
 *   bun run fixtures/generate.ts
 *
 * Every fixture is a tiny (8x8) synthetic image whose sharpness / delta / entropy
 * are KNOWN analytically, so score.test.ts can pin exact values rather than
 * trusting whatever a real frame happens to score. The math each fixture pins is
 * documented inline below and re-derived in the test file's comments.
 *
 * All fixtures are pure-gray where it matters (R == G == B), so the Rec.601
 * luminance used by the scorer (0.299R + 0.587G + 0.114B, weights sum to 1)
 * reproduces the channel value exactly with no rounding.
 */
import sharp from "sharp";
import { join } from "node:path";

const DIM = 8; // 8x8 keeps fixtures commit-tiny; interior (border-skipped) is 6x6.
const HERE = new URL(".", import.meta.url).pathname;

/** Build a width*height*3 RGB buffer from a per-pixel (x,y) -> [r,g,b] function. */
function rgbBuffer(
  width: number,
  height: number,
  px: (x: number, y: number) => [number, number, number],
): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  let i = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = px(x, y);
      buf[i++] = r;
      buf[i++] = g;
      buf[i++] = b;
    }
  }
  return buf;
}

async function writePng(name: string, buf: Buffer): Promise<void> {
  const out = join(HERE, name);
  await sharp(buf, { raw: { width: DIM, height: DIM, channels: 3 } })
    .png()
    .toFile(out);
  console.log(`wrote ${name}`);
}

/** Solid gray 128: every pixel identical -> Laplacian 0 everywhere (sharpness 0), one histogram bin (entropy 0). */
const solidGray = (v: number) => rgbBuffer(DIM, DIM, () => [v, v, v]);

/**
 * Vertical 1px stripes alternating 0 / hi by column.
 * Interior Laplacian alternates +2hi / -2hi: a 0-column pixel sees two hi
 * side-neighbors and two 0 vertical-neighbors -> 0+0+hi+hi - 4*0 = +2hi; an
 * hi-column pixel -> hi+hi+0+0 - 4*hi = -2hi. Equal counts of each -> mean 0,
 * variance = (2hi)^2 = 4*hi^2. So sharpness == 4*hi^2 exactly. Two occupied
 * histogram bins (the 0 column and the hi column) at 50/50 -> entropy == 1 bit.
 */
const stripes = (hi: number) =>
  rgbBuffer(DIM, DIM, (x) => {
    const v = x % 2 === 0 ? 0 : hi;
    return [v, v, v];
  });

/** Left half black, right half white: two histogram bins at 50/50 -> entropy == 1 bit. */
const blackWhite = () =>
  rgbBuffer(DIM, DIM, (x) => {
    const v = x < DIM / 2 ? 0 : 255;
    return [v, v, v];
  });

await Promise.all([
  writePng("solid_gray128.png", solidGray(128)), // sharpness 0, entropy 0
  writePng("solid_100.png", solidGray(100)), // delta vs solid_130 == 30
  writePng("solid_130.png", solidGray(130)),
  writePng("stripes_255.png", stripes(255)), // sharpness 4*255^2 = 260100
  writePng("stripes_128.png", stripes(128)), // sharpness 4*128^2 = 65536
  writePng("stripes_64.png", stripes(64)), // sharpness 4*64^2 = 16384
  writePng("black_white.png", blackWhite()), // entropy 1 bit
]);
