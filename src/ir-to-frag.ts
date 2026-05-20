import * as flatbuffers from 'flatbuffers';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

import { Attribute } from './generated/attribute.js';
import { BigShellProfile } from './generated/big-shell-profile.js';
import { FloatVector } from './generated/float-vector.js';
import { Material } from './generated/material.js';
import { Meshes } from './generated/meshes.js';
import { Model } from './generated/model.js';
import { RenderedFaces } from './generated/rendered-faces.js';
import { Representation } from './generated/representation.js';
import { RepresentationClass } from './generated/representation-class.js';
import { Sample } from './generated/sample.js';
import { Shell } from './generated/shell.js';
import { ShellProfile } from './generated/shell-profile.js';
import { ShellType } from './generated/shell-type.js';
import { SpatialStructure } from './generated/spatial-structure.js';
import { Stroke } from './generated/stroke.js';
import { Transform } from './generated/transform.js';

type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

type GlbToFragIR = {
  model: {
    sourceFile: string;
    sourcePath?: string;
    sceneCount: number;
    nodeCount: number;
    meshCount: number;
    primitiveCount: number;
  };
  items: IRItem[];
  materials: IRMaterial[];
  geometries?: Record<string, IRGeometry>;
  spatialTree?: IRSpatialTreeItem;
};

type IRItem = {
  localId: number;
  name: string;
  category: string;
  sourceNodeName?: string;
  samples: IRSample[];
  attributes: Record<string, string | number | boolean>;
};

type IRSpatialTreeItem = {
  category: string;
  localId: number | null;
  sourceNodeIndex?: number;
  sourceNodeName?: string;
  children?: IRSpatialTreeItem[];
};

type IRSample = {
  sourceMeshName?: string;
  sourcePrimitiveIndex: number;
  materialId: string;
  transform: IRTransform;
  geometry?: IRGeometry;
  geometryId?: string;
};

type IRGeometry = {
  positions: number[];
  indices: number[];
  stats: {
    vertexCount: number;
    positionComponentCount: number;
    indexCount: number;
    triangleCount: number;
    normalComponentCount?: number;
    uvComponentCount?: number;
  };
  bbox: {
    min: Vec3;
    max: Vec3;
  };
  mode: 'TRIANGLES';
};

type IRMaterial = {
  id: string;
  name?: string;
  r: number;
  g: number;
  b: number;
  a: number;
};

type IRTransform = {
  matrix?: number[];
  position?: Vec3;
  rotation?: Vec4;
  scale?: Vec3;
};

type MeshBuildData = {
  meshesItems: number[];
  samples: Array<{
    item: number;
    material: number;
    representation: number;
    localTransform: number;
  }>;
  representationGeometryKeys: string[];
  transforms: Array<{
    position: Vec3;
    xDirection: Vec3;
    yDirection: Vec3;
  }>;
};

function usage(): never {
  console.error('Usage: node dist/ir-to-frag.js input.ir.json [output.frag] [--raw]');
  process.exit(1);
}

function getCliArgs(): { inputPath: string; outputPath: string; raw: boolean } {
  const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const [input, output] = positionalArgs;

  if (!input || positionalArgs.length > 2) {
    usage();
  }

  const inputPath = path.resolve(input);

  return {
    inputPath,
    outputPath: output ? path.resolve(output) : deriveOutputPath(inputPath),
    raw: process.argv.includes('--raw'),
  };
}

function deriveOutputPath(inputPath: string): string {
  const inputDir = path.dirname(inputPath);
  const inputFile = path.basename(inputPath);
  const modelName = inputFile.endsWith('.ir.json') ? inputFile.slice(0, -'.ir.json'.length) : path.basename(inputFile, path.extname(inputFile));

  return path.join(inputDir, 'frag', `${modelName}.frag`);
}

function assertLessThan(actual: number, limit: number, label: string): void {
  if (actual >= limit) {
    throw new Error(`${label} must be < ${limit}, got ${actual}.`);
  }
}

function getSampleGeometry(ir: GlbToFragIR, sample: IRSample): IRGeometry {
  if (sample.geometry) {
    return sample.geometry;
  }

  if (sample.geometryId && ir.geometries?.[sample.geometryId]) {
    return ir.geometries[sample.geometryId];
  }

  throw new Error(`Cannot find geometry for sample. geometryId=${sample.geometryId ?? '(missing)'}.`);
}

function getGeometryKey(itemIndex: number, sampleIndex: number, sample: IRSample): string {
  return sample.geometryId ?? `${itemIndex}:${sampleIndex}`;
}

function toTransform(transform: IRTransform): MeshBuildData['transforms'][number] {
  const matrix = transform.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  return {
    position: transform.position ?? [0, 0, 0],
    xDirection: [matrix[0], matrix[1], matrix[2]],
    yDirection: [matrix[4], matrix[5], matrix[6]],
  };
}

function inferSchemaAttributeType(value: string | number | boolean): 'TEXT' | 'NUMBER' | 'BOOLEAN' {
  if (typeof value === 'number') return 'NUMBER';
  if (typeof value === 'boolean') return 'BOOLEAN';
  return 'TEXT';
}

function toAttributeData(attributes: Record<string, string | number | boolean>): string[] {
  return Object.entries(attributes).map(([key, value]) => JSON.stringify([key, value, inferSchemaAttributeType(value)]));
}

function createOffsetVector(builder: flatbuffers.Builder, offsets: flatbuffers.Offset[]): flatbuffers.Offset {
  builder.startVector(4, offsets.length, 4);
  for (let index = offsets.length - 1; index >= 0; index--) {
    builder.addOffset(offsets[index]);
  }
  return builder.endVector();
}

function createStringVector(builder: flatbuffers.Builder, values: string[]): flatbuffers.Offset {
  return createOffsetVector(
    builder,
    values.map((value) => builder.createString(value)),
  );
}

function createTransformStruct(builder: flatbuffers.Builder, transform: MeshBuildData['transforms'][number]): flatbuffers.Offset {
  return Transform.createTransform(
    builder,
    transform.position[0],
    transform.position[1],
    transform.position[2],
    transform.xDirection[0],
    transform.xDirection[1],
    transform.xDirection[2],
    transform.yDirection[0],
    transform.yDirection[1],
    transform.yDirection[2],
  );
}

function createTransformVector(builder: flatbuffers.Builder, transforms: MeshBuildData['transforms']): flatbuffers.Offset {
  Meshes.startLocalTransformsVector(builder, transforms.length);
  for (let index = transforms.length - 1; index >= 0; index--) {
    createTransformStruct(builder, transforms[index]);
  }
  return builder.endVector();
}

function createPointsVector(builder: flatbuffers.Builder, positions: number[]): flatbuffers.Offset {
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new Error(`positions.length must be a non-empty multiple of 3, got ${positions.length}.`);
  }

  const pointCount = positions.length / 3;
  Shell.startPointsVector(builder, pointCount);

  for (let pointIndex = pointCount - 1; pointIndex >= 0; pointIndex--) {
    const offset = pointIndex * 3;
    FloatVector.createFloatVector(builder, positions[offset], positions[offset + 1], positions[offset + 2]);
  }

  return builder.endVector();
}

function createShellProfile(builder: flatbuffers.Builder, indices: number[], offset: number): flatbuffers.Offset {
  const indicesOffset = ShellProfile.createIndicesVector(builder, [indices[offset], indices[offset + 1], indices[offset + 2]]);
  return ShellProfile.createShellProfile(builder, indicesOffset);
}

function createBigShellProfile(builder: flatbuffers.Builder, indices: number[], offset: number): flatbuffers.Offset {
  const indicesOffset = BigShellProfile.createIndicesVector(builder, [indices[offset], indices[offset + 1], indices[offset + 2]]);
  return BigShellProfile.createBigShellProfile(builder, indicesOffset);
}

function getIndexMax(indices: number[]): number {
  let indexMax = Number.NEGATIVE_INFINITY;

  for (const index of indices) {
    indexMax = Math.max(indexMax, index);
  }

  return indexMax;
}

function createProfilesVector(builder: flatbuffers.Builder, indices: number[], useBigProfiles: boolean): flatbuffers.Offset {
  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw new Error(`indices.length must be a non-empty multiple of 3, got ${indices.length}.`);
  }

  const profileCount = indices.length / 3;
  const offsets: flatbuffers.Offset[] = new Array(profileCount);

  for (let profileIndex = 0; profileIndex < profileCount; profileIndex++) {
    const offset = profileIndex * 3;
    offsets[profileIndex] = useBigProfiles ? createBigShellProfile(builder, indices, offset) : createShellProfile(builder, indices, offset);
  }

  return useBigProfiles ? Shell.createBigProfilesVector(builder, offsets) : Shell.createProfilesVector(builder, offsets);
}

function createProfilesFaceIdsVector(builder: flatbuffers.Builder, profileCount: number, useBigProfiles: boolean): flatbuffers.Offset {
  if (useBigProfiles) {
    return Shell.createProfilesFaceIdsVector(builder, []);
  }

  Shell.startProfilesFaceIdsVector(builder, profileCount);
  for (let index = profileCount - 1; index >= 0; index--) {
    builder.addInt16(index);
  }
  return builder.endVector();
}

function createShell(builder: flatbuffers.Builder, geometry: IRGeometry): flatbuffers.Offset {
  if (geometry.mode !== 'TRIANGLES') {
    throw new Error(`geometry.mode expected TRIANGLES, got ${geometry.mode}.`);
  }

  const pointCount = geometry.positions.length / 3;
  const indexMax = getIndexMax(geometry.indices);
  assertLessThan(indexMax, pointCount, 'max profile index');

  const useBigProfiles = indexMax > 65535;
  const profilesOffset = useBigProfiles ? Shell.createProfilesVector(builder, []) : createProfilesVector(builder, geometry.indices, false);
  const holesOffset = Shell.createHolesVector(builder, []);
  const pointsOffset = createPointsVector(builder, geometry.positions);
  const bigProfilesOffset = useBigProfiles ? createProfilesVector(builder, geometry.indices, true) : Shell.createBigProfilesVector(builder, []);
  const bigHolesOffset = Shell.createBigHolesVector(builder, []);
  const profilesFaceIdsOffset = createProfilesFaceIdsVector(builder, geometry.indices.length / 3, useBigProfiles);

  return Shell.createShell(
    builder,
    profilesOffset,
    holesOffset,
    pointsOffset,
    bigProfilesOffset,
    bigHolesOffset,
    useBigProfiles ? ShellType.BIG : ShellType.NONE,
    profilesFaceIdsOffset,
  );
}

function createShellsVector(builder: flatbuffers.Builder, ir: GlbToFragIR, geometryKeys: string[]): flatbuffers.Offset {
  const shellOffsets = geometryKeys.map((geometryKey) => {
    const geometry = ir.geometries?.[geometryKey];

    if (!geometry) {
      throw new Error(`Cannot find geometry for representation key ${geometryKey}.`);
    }

    return createShell(builder, geometry);
  });

  return Meshes.createShellsVector(builder, shellOffsets);
}

function createSamplesVector(builder: flatbuffers.Builder, samples: MeshBuildData['samples']): flatbuffers.Offset {
  Meshes.startSamplesVector(builder, samples.length);
  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index];
    Sample.createSample(builder, sample.item, sample.material, sample.representation, sample.localTransform);
  }
  return builder.endVector();
}

function createRepresentationsVector(builder: flatbuffers.Builder, ir: GlbToFragIR, geometryKeys: string[]): flatbuffers.Offset {
  Meshes.startRepresentationsVector(builder, geometryKeys.length);
  for (let index = geometryKeys.length - 1; index >= 0; index--) {
    const geometry = ir.geometries?.[geometryKeys[index]];

    if (!geometry) {
      throw new Error(`Cannot find geometry for representation key ${geometryKeys[index]}.`);
    }

    Representation.createRepresentation(
      builder,
      index,
      geometry.bbox.min[0],
      geometry.bbox.min[1],
      geometry.bbox.min[2],
      geometry.bbox.max[0],
      geometry.bbox.max[1],
      geometry.bbox.max[2],
      RepresentationClass.SHELL,
    );
  }
  return builder.endVector();
}

function createMaterialsVector(builder: flatbuffers.Builder, materials: IRMaterial[]): flatbuffers.Offset {
  Meshes.startMaterialsVector(builder, materials.length);
  for (let index = materials.length - 1; index >= 0; index--) {
    const material = materials[index];
    Material.createMaterial(builder, material.r, material.g, material.b, material.a, RenderedFaces.ONE, Stroke.DEFAULT);
  }
  return builder.endVector();
}

function createAttributesVector(builder: flatbuffers.Builder, items: IRItem[]): flatbuffers.Offset {
  const attributeOffsets = items.map((item) => {
    const dataOffset = createStringVector(builder, toAttributeData(item.attributes));
    return Attribute.createAttribute(builder, dataOffset);
  });

  return Model.createAttributesVector(builder, attributeOffsets);
}

function createSpatialStructure(builder: flatbuffers.Builder, node: IRSpatialTreeItem): flatbuffers.Offset {
  const childOffsets = (node.children ?? []).map((child) => createSpatialStructure(builder, child));
  const childrenOffset = SpatialStructure.createChildrenVector(builder, childOffsets);
  const categoryOffset = builder.createString(node.category);
  return SpatialStructure.createSpatialStructure(builder, node.localId, categoryOffset, childrenOffset);
}

function createFallbackSpatialTree(ir: GlbToFragIR): IRSpatialTreeItem {
  return {
    category: ir.model.sourceFile,
    localId: null,
    children: ir.items.map((item) => ({
      category: item.category,
      localId: item.localId,
      children: [],
    })),
  };
}

function buildMeshData(ir: GlbToFragIR): MeshBuildData {
  const materialIndexById = new Map(ir.materials.map((material, index) => [material.id, index]));
  const meshesItems = ir.items.map((_, index) => index);
  const samples: MeshBuildData['samples'] = [];
  const transforms: MeshBuildData['transforms'] = [];
  const representationIndexByGeometryKey = new Map<string, number>();
  const representationGeometryKeys: string[] = [];

  for (const [itemIndex, item] of ir.items.entries()) {
    for (const [sampleIndex, sample] of item.samples.entries()) {
      const geometry = getSampleGeometry(ir, sample);
      const geometryKey = getGeometryKey(itemIndex, sampleIndex, sample);
      const materialIndex = materialIndexById.get(sample.materialId);

      if (materialIndex === undefined) {
        throw new Error(`Cannot find material for sample.materialId=${sample.materialId}. item=${item.localId} sample=${sampleIndex}.`);
      }

      let representationIndex = representationIndexByGeometryKey.get(geometryKey);

      if (representationIndex === undefined) {
        representationIndex = representationGeometryKeys.length;
        representationIndexByGeometryKey.set(geometryKey, representationIndex);
        representationGeometryKeys.push(geometryKey);
      }

      assertLessThan(getIndexMax(geometry.indices), geometry.stats.vertexCount, `geometry ${geometryKey} max index`);

      const transformIndex = transforms.length;
      transforms.push(toTransform(sample.transform));
      samples.push({
        item: itemIndex,
        material: materialIndex,
        representation: representationIndex,
        localTransform: transformIndex,
      });
    }
  }

  return {
    meshesItems,
    samples,
    representationGeometryKeys,
    transforms,
  };
}

function createMeshes(builder: flatbuffers.Builder, ir: GlbToFragIR, meshData: MeshBuildData): flatbuffers.Offset {
  const meshesItemsOffset = Meshes.createMeshesItemsVector(builder, meshData.meshesItems);
  const samplesOffset = createSamplesVector(builder, meshData.samples);
  const representationsOffset = createRepresentationsVector(builder, ir, meshData.representationGeometryKeys);
  const materialsOffset = createMaterialsVector(builder, ir.materials);
  const circleExtrusionsOffset = Meshes.createCircleExtrusionsVector(builder, []);
  const shellsOffset = createShellsVector(builder, ir, meshData.representationGeometryKeys);
  const localTransformsOffset = createTransformVector(builder, meshData.transforms);
  const globalTransformsOffset = createTransformVector(builder, meshData.transforms);
  const materialIdsOffset = Meshes.createMaterialIdsVector(builder, []);
  const representationIdsOffset = Meshes.createRepresentationIdsVector(builder, []);
  const sampleIdsOffset = Meshes.createSampleIdsVector(builder, []);
  const localTransformIdsOffset = Meshes.createLocalTransformIdsVector(builder, []);
  const globalTransformIdsOffset = Meshes.createGlobalTransformIdsVector(builder, []);

  Meshes.startMeshes(builder);
  Meshes.addMeshesItems(builder, meshesItemsOffset);
  Meshes.addSamples(builder, samplesOffset);
  Meshes.addRepresentations(builder, representationsOffset);
  Meshes.addMaterials(builder, materialsOffset);
  Meshes.addCircleExtrusions(builder, circleExtrusionsOffset);
  Meshes.addShells(builder, shellsOffset);
  Meshes.addLocalTransforms(builder, localTransformsOffset);
  Meshes.addGlobalTransforms(builder, globalTransformsOffset);
  Meshes.addMaterialIds(builder, materialIdsOffset);
  Meshes.addRepresentationIds(builder, representationIdsOffset);
  Meshes.addSampleIds(builder, sampleIdsOffset);
  Meshes.addLocalTransformIds(builder, localTransformIdsOffset);
  Meshes.addGlobalTransformIds(builder, globalTransformIdsOffset);
  Meshes.addCoordinates(builder, createTransformStruct(builder, toTransform({})));
  return Meshes.endMeshes(builder);
}

function createModelBuffer(ir: GlbToFragIR): Uint8Array {
  if (!ir.geometries) {
    const geometries: Record<string, IRGeometry> = {};
    for (const [itemIndex, item] of ir.items.entries()) {
      for (const [sampleIndex, sample] of item.samples.entries()) {
        if (!sample.geometry) continue;
        const key = getGeometryKey(itemIndex, sampleIndex, sample);
        geometries[key] = sample.geometry;
        sample.geometryId = key;
      }
    }
    ir.geometries = geometries;
  }

  const meshData = buildMeshData(ir);
  const builder = new flatbuffers.Builder(1024 * 1024);
  const metadataOffset = builder.createString(
    JSON.stringify({
      sourceFile: ir.model.sourceFile,
      sourcePath: ir.model.sourcePath,
      converter: 'ir-to-frag-direct',
      note: 'Generated directly from deduplicated IR without fraglike JSON.',
    }),
  );
  const guidsOffset = createStringVector(builder, []);
  const guidsItemsOffset = Model.createGuidsItemsVector(builder, []);
  const localIdsOffset = Model.createLocalIdsVector(
    builder,
    ir.items.map((item) => item.localId),
  );
  const categoriesOffset = createStringVector(builder, Array.from(new Set(ir.items.map((item) => item.category))));
  const meshesOffset = createMeshes(builder, ir, meshData);
  const attributesOffset = createAttributesVector(builder, ir.items);
  const relationsOffset = Model.createRelationsVector(builder, []);
  const relationsItemsOffset = Model.createRelationsItemsVector(builder, []);
  const guidOffset = builder.createString('generated-model-guid');
  const spatialStructureOffset = createSpatialStructure(builder, ir.spatialTree ?? createFallbackSpatialTree(ir));
  const uniqueAttributesOffset = createStringVector(builder, []);
  const relationNamesOffset = createStringVector(builder, []);
  const indexesOffset = Model.createIndexesVector(builder, []);
  const maxLocalId = Math.max(...ir.items.map((item) => item.localId)) + 1;

  Model.startModel(builder);
  Model.addMetadata(builder, metadataOffset);
  Model.addGuids(builder, guidsOffset);
  Model.addGuidsItems(builder, guidsItemsOffset);
  Model.addMaxLocalId(builder, maxLocalId);
  Model.addLocalIds(builder, localIdsOffset);
  Model.addCategories(builder, categoriesOffset);
  Model.addMeshes(builder, meshesOffset);
  Model.addAttributes(builder, attributesOffset);
  Model.addRelations(builder, relationsOffset);
  Model.addRelationsItems(builder, relationsItemsOffset);
  Model.addGuid(builder, guidOffset);
  Model.addSpatialStructure(builder, spatialStructureOffset);
  Model.addUniqueAttributes(builder, uniqueAttributesOffset);
  Model.addRelationNames(builder, relationNamesOffset);
  Model.addIndexes(builder, indexesOffset);

  const modelOffset = Model.endModel(builder);
  Model.finishModelBuffer(builder, modelOffset);

  console.log(`local_ids.length: ${ir.items.length}`);
  console.log(`meshes.samples.length: ${meshData.samples.length}`);
  console.log(`meshes.shells.length: ${meshData.representationGeometryKeys.length}`);

  return builder.asUint8Array();
}

async function main(): Promise<void> {
  const { inputPath, outputPath, raw } = getCliArgs();
  const ir = JSON.parse(await fs.readFile(inputPath, 'utf8')) as GlbToFragIR;
  const rawBytes = createModelBuffer(ir);
  const outputBytes = raw ? rawBytes : deflateSync(rawBytes);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, outputBytes);

  console.log(`wrote: ${outputPath}`);
  console.log(`encoding: ${raw ? 'raw-flatbuffers' : 'deflate'}`);
  console.log(`raw bytes: ${rawBytes.length}`);
  console.log(`output bytes: ${outputBytes.length}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
