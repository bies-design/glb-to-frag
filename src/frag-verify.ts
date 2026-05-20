import * as flatbuffers from 'flatbuffers';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import { Model } from './generated/model.js';
import { SpatialStructure } from './generated/spatial-structure.js';

function usage(): never {
  console.error('Usage: node dist/frag-verify.js input.frag');
  process.exit(1);
}

function countSpatialTreeNodes(node: SpatialStructure | null): { nodeCount: number; localIdCount: number } {
  if (!node) {
    return { nodeCount: 0, localIdCount: 0 };
  }

  let nodeCount = 1;
  let localIdCount = node.localId() === null ? 0 : 1;

  for (let index = 0; index < node.childrenLength(); index++) {
    const childCount = countSpatialTreeNodes(node.children(index));
    nodeCount += childCount.nodeCount;
    localIdCount += childCount.localIdCount;
  }

  return { nodeCount, localIdCount };
}

async function main(): Promise<void> {
  const input = process.argv[2];

  if (!input) {
    usage();
  }

  const inputPath = path.resolve(input);
  const fileBytes = await fs.readFile(inputPath);
  let bytes = new Uint8Array(fileBytes);
  let byteBuffer = new flatbuffers.ByteBuffer(bytes);
  let encoding = 'raw-flatbuffers';

  if (!Model.bufferHasIdentifier(byteBuffer)) {
    bytes = inflateSync(fileBytes);
    byteBuffer = new flatbuffers.ByteBuffer(bytes);
    encoding = 'deflate';
  }

  if (!Model.bufferHasIdentifier(byteBuffer)) {
    throw new Error('Invalid .frag file identifier after raw/deflate checks. Expected 0001.');
  }

  const model = Model.getRootAsModel(byteBuffer);
  const meshes = model.meshes();
  const spatialTree = model.spatialStructure();

  if (!meshes) {
    throw new Error('Model.meshes is missing.');
  }

  if (meshes.shellsLength() === 0) {
    throw new Error('meshes.shells.length is 0.');
  }

  let totalPoints = 0;
  let totalProfiles = 0;
  let totalBigProfiles = 0;

  for (let shellIndex = 0; shellIndex < meshes.shellsLength(); shellIndex++) {
    const shell = meshes.shells(shellIndex);

    if (!shell) {
      throw new Error(`meshes.shells[${shellIndex}] is missing.`);
    }

    totalPoints += shell.pointsLength();
    totalProfiles += shell.profilesLength();
    totalBigProfiles += shell.bigProfilesLength();
  }

  console.log(`encoding: ${encoding}`);
  console.log(`local_ids.length: ${model.localIdsLength()}`);
  console.log(`meshes.samples.length: ${meshes.samplesLength()}`);
  console.log(`meshes.shells.length: ${meshes.shellsLength()}`);
  console.log(`meshes.shells.points.length total: ${totalPoints}`);
  console.log(`meshes.shells.profiles.length total: ${totalProfiles}`);
  console.log(`meshes.shells.big_profiles.length total: ${totalBigProfiles}`);

  const spatialTreeCounts = countSpatialTreeNodes(spatialTree);
  console.log(`spatial_structure.nodes.length total: ${spatialTreeCounts.nodeCount}`);
  console.log(`spatial_structure.local_ids.length total: ${spatialTreeCounts.localIdCount}`);
  console.log(`spatial_structure.root.category: ${spatialTree?.category() ?? '(missing)'}`);

  const firstShell = meshes.shells(0);

  if (firstShell) {
    console.log(`meshes.shells[0].points.length: ${firstShell.pointsLength()}`);
    console.log(`meshes.shells[0].profiles.length: ${firstShell.profilesLength()}`);
    console.log(`meshes.shells[0].big_profiles.length: ${firstShell.bigProfilesLength()}`);
    console.log(`meshes.shells[0].type: ${firstShell.type()}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});


