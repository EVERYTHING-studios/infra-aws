// Generates the committed fixtures used by the stub pipeline:
//   fixtures/stub.glb      — minimal valid glTF 2.0 binary (a single triangle)
//   fixtures/thumbnail.jpg — tiny placeholder JPEG
// Re-run only if the fixtures need to change: node scripts/make-fixtures.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
await mkdir(fixturesDir, { recursive: true });

// ---- stub.glb: one triangle ------------------------------------------------
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const indices = new Uint16Array([0, 1, 2]);

const positionBytes = Buffer.from(positions.buffer);
const indexBytes = Buffer.from(indices.buffer);
const binChunkData = Buffer.concat([
  positionBytes,
  indexBytes,
  Buffer.alloc((4 - ((positionBytes.length + indexBytes.length) % 4)) % 4),
]);

const gltf = {
  asset: { version: '2.0', generator: 'generate-service fixture' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'StubTriangle' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126, // FLOAT
      count: 3,
      type: 'VEC3',
      min: [0, 0, 0],
      max: [1, 1, 0],
    },
    { bufferView: 1, componentType: 5123 /* UNSIGNED_SHORT */, count: 3, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
    { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length, target: 34963 },
  ],
  buffers: [{ byteLength: binChunkData.length }],
};

let jsonChunkData = Buffer.from(JSON.stringify(gltf));
jsonChunkData = Buffer.concat([
  jsonChunkData,
  Buffer.from(' '.repeat((4 - (jsonChunkData.length % 4)) % 4)),
]);

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.writeUInt32LE(type, 4);
  return Buffer.concat([header, data]);
}

const jsonChunk = chunk(0x4e4f534a, jsonChunkData); // 'JSON'
const binChunk = chunk(0x004e4942, binChunkData); // 'BIN\0'

const glbHeader = Buffer.alloc(12);
glbHeader.writeUInt32LE(0x46546c67, 0); // magic 'glTF'
glbHeader.writeUInt32LE(2, 4); // version
glbHeader.writeUInt32LE(12 + jsonChunk.length + binChunk.length, 8);

await writeFile(join(fixturesDir, 'stub.glb'), Buffer.concat([glbHeader, jsonChunk, binChunk]));

// ---- thumbnail.jpg: 1x1 grey pixel -----------------------------------------
const jpegBase64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
await writeFile(join(fixturesDir, 'thumbnail.jpg'), Buffer.from(jpegBase64, 'base64'));

console.log('fixtures written to', fixturesDir);
