import { type Material, type Mesh, type Primitive, type Property, type Texture } from '@gltf-transform/core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGlbIO } from './gltf-io.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type MetadataSummary = {
  sourceFile: string;
  sourcePath: string;
  sceneCount: number;
  nodeCount: number;
  meshCount: number;
  primitiveCount: number;
  materialCount: number;
  textureCount: number;
  nodesWithName: number;
  nodesWithExtras: number;
  meshesWithName: number;
  meshesWithExtras: number;
  primitivesWithExtras: number;
  materialsWithName: number;
  materialsWithExtras: number;
  texturesWithName: number;
  texturesWithExtras: number;
  extensionNames: string[];
  detectedMetadataKeys: string[];
  rawJsonKeywordHits: RawJsonKeywordHit[];
};

type MetadataReport = {
  summary: MetadataSummary;
  asset: {
    generator?: string;
    version?: string;
    minVersion?: string;
    copyright?: string;
    extras?: JsonValue;
  };
  rawJson: {
    byteLength: number;
    keywordHits: RawJsonKeywordHit[];
  };
  scenes: Array<{
    sceneIndex: number;
    name?: string;
    extras?: JsonValue;
    extensions: string[];
  }>;
  nodes: Array<{
    nodeIndex: number;
    name?: string;
    extras?: JsonValue;
    extensions: string[];
    meshIndex: number | null;
    meshName?: string;
    meshExtras?: JsonValue;
    meshExtensions: string[];
    primitiveCount: number;
    primitives: Array<{
      primitiveIndex: number;
      mode: number;
      extras?: JsonValue;
      extensions: string[];
      attributes: string[];
      hasIndices: boolean;
      positionCount: number;
      indexCount: number;
      materialIndex: number | null;
      materialName?: string;
      materialExtras?: JsonValue;
      materialExtensions: string[];
    }>;
  }>;
  nodeHierarchy: NodeHierarchyItem[];
  meshes: Array<{
    meshIndex: number;
    name?: string;
    extras?: JsonValue;
    extensions: string[];
    primitiveCount: number;
  }>;
  materials: Array<{
    materialIndex: number;
    name?: string;
    extras?: JsonValue;
    extensions: string[];
    hasBaseColorTexture: boolean;
    baseColorFactor: number[];
    metallicFactor: number;
    roughnessFactor: number;
    doubleSided: boolean;
    alphaMode: string;
  }>;
  textures: Array<{
    textureIndex: number;
    name?: string;
    uri?: string;
    mimeType: string;
    extras?: JsonValue;
    extensions: string[];
    imageByteLength: number;
  }>;
  accessors: Array<{
    accessorIndex: number;
    name?: string;
    extras?: JsonValue;
    extensions: string[];
  }>;
  bufferViews: Array<{
    bufferViewIndex: number;
    name?: string;
    extras?: JsonValue;
    extensions: string[];
  }>;
};

type RawJsonKeywordHit = {
  keyword: string;
  count: number;
  samples: string[];
};

type NodeHierarchyItem = {
  nodeIndex: number;
  name?: string;
  meshIndex: number | null;
  meshName?: string;
  primitiveCount: number;
  extras?: JsonValue;
  children: NodeHierarchyItem[];
};

type RawGlbJson = {
  asset?: {
    generator?: string;
    version?: string;
    minVersion?: string;
    copyright?: string;
    extras?: JsonValue;
  };
  nodes?: Array<{
    children?: number[];
  }>;
  scenes?: Array<{
    nodes?: number[];
  }>;
  accessors?: Array<{
    name?: string;
    extras?: JsonValue;
    extensions?: Record<string, JsonValue>;
  }>;
  bufferViews?: Array<{
    name?: string;
    extras?: JsonValue;
    extensions?: Record<string, JsonValue>;
  }>;
};

const RAW_JSON_KEYWORDS = [
  'layer',
  'Layer',
  'LAYERS',
  'rhino',
  'Rhino',
  'object',
  'Object',
  'user',
  'UserText',
  'category',
  'Category',
  'name',
  'Name',
  'ifc',
  'IFC',
  'class',
  'Class',
];

function usage(): never {
  console.error('Usage: node dist/glb-inspect-metadata.js input.glb output.metadata.json');
  process.exit(1);
}

function getCliArgs(): { inputPath: string; outputPath: string } {
  const input = process.argv[2];
  const output = process.argv[3];

  if (!input || !output) {
    usage();
  }

  return {
    inputPath: path.resolve(input),
    outputPath: path.resolve(output),
  };
}

function hasObjectKeys(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function getExtras(property: Property): JsonValue | undefined {
  const extras = property.getExtras() as JsonValue;
  return hasObjectKeys(extras) ? extras : undefined;
}

function getExtensionNames(property: Property): string[] {
  const extensibleProperty = property as Property & {
    listExtensions?: () => Array<{ extensionName: string }>;
  };

  return extensibleProperty.listExtensions?.().map((extension) => extension.extensionName).sort() ?? [];
}

function addMetadataKeys(keys: Set<string>, value: JsonValue | undefined): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    addMetadataKeys(keys, child);
  }
}

function getMeshIndex(meshes: Mesh[], mesh: Mesh | null): number | null {
  return mesh ? meshes.indexOf(mesh) : null;
}

function getMaterialIndex(materials: Material[], material: Material | null): number | null {
  return material ? materials.indexOf(material) : null;
}

function getPrimitiveAttributes(primitive: Primitive): string[] {
  const attributes = ['POSITION', 'NORMAL', 'TANGENT', 'COLOR_0', 'TEXCOORD_0', 'TEXCOORD_1', 'JOINTS_0', 'WEIGHTS_0'];
  return attributes.filter((attribute) => primitive.getAttribute(attribute));
}

async function readGlbJson(inputPath: string): Promise<{ rawJson: RawGlbJson; jsonText: string }> {
  const bytes = await fs.readFile(inputPath);
  const magic = bytes.toString('utf8', 0, 4);

  if (magic !== 'glTF') {
    throw new Error(`Expected GLB magic "glTF", got "${magic}".`);
  }

  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = bytes.readUInt32LE(offset);
    const chunkType = bytes.toString('utf8', offset + 4, offset + 8);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;

    if (chunkType === 'JSON') {
      const jsonText = bytes.toString('utf8', chunkStart, chunkEnd).trim();
      return {
        rawJson: JSON.parse(jsonText) as RawGlbJson,
        jsonText,
      };
    }

    offset = chunkEnd;
  }

  throw new Error('GLB JSON chunk was not found.');
}

function findKeywordHits(jsonText: string): RawJsonKeywordHit[] {
  return RAW_JSON_KEYWORDS.map((keyword) => {
    const samples: string[] = [];
    let count = 0;
    let searchIndex = 0;

    while (true) {
      const index = jsonText.indexOf(keyword, searchIndex);
      if (index === -1) break;

      count += 1;
      if (samples.length < 5) {
        const start = Math.max(0, index - 80);
        const end = Math.min(jsonText.length, index + keyword.length + 80);
        samples.push(jsonText.slice(start, end).replace(/\s+/g, ' '));
      }
      searchIndex = index + keyword.length;
    }

    return { keyword, count, samples };
  }).filter((hit) => hit.count > 0);
}

function getRawExtensionNames(value: { extensions?: Record<string, JsonValue> } | undefined): string[] {
  return value?.extensions ? Object.keys(value.extensions).sort() : [];
}

function buildNodeHierarchy(rawJson: RawGlbJson, nodeReports: MetadataReport['nodes']): NodeHierarchyItem[] {
  const childNodeIndexes = new Set<number>();

  for (const node of rawJson.nodes ?? []) {
    for (const childIndex of node.children ?? []) {
      childNodeIndexes.add(childIndex);
    }
  }

  const sceneRootIndexes = (rawJson.scenes ?? []).flatMap((scene) => scene.nodes ?? []);
  const rootIndexes = sceneRootIndexes.length > 0 ? sceneRootIndexes : nodeReports.map((node) => node.nodeIndex).filter((nodeIndex) => !childNodeIndexes.has(nodeIndex));

  const buildNode = (nodeIndex: number): NodeHierarchyItem => {
    const node = nodeReports[nodeIndex];
    const rawNode = rawJson.nodes?.[nodeIndex];

    return {
      nodeIndex,
      name: node?.name,
      meshIndex: node?.meshIndex ?? null,
      meshName: node?.meshName,
      primitiveCount: node?.primitiveCount ?? 0,
      extras: node?.extras,
      children: (rawNode?.children ?? []).map(buildNode),
    };
  };

  return rootIndexes.map(buildNode);
}

async function main(): Promise<void> {
  const { inputPath, outputPath } = getCliArgs();
  const { rawJson, jsonText } = await readGlbJson(inputPath);
  const rawJsonKeywordHits = findKeywordHits(jsonText);
  const io = await createGlbIO();
  const document = await io.read(inputPath);
  const root = document.getRoot();

  const scenes = root.listScenes();
  const nodes = root.listNodes();
  const meshes = root.listMeshes();
  const materials = root.listMaterials();
  const textures = root.listTextures();
  const metadataKeys = new Set<string>();
  const extensionNames = new Set(root.listExtensionsUsed().map((extension) => extension.extensionName));

  const sceneReports = scenes.map((scene, sceneIndex) => {
    const extras = getExtras(scene);
    addMetadataKeys(metadataKeys, extras);
    getExtensionNames(scene).forEach((extensionName) => extensionNames.add(extensionName));

    return {
      sceneIndex,
      name: scene.getName() || undefined,
      extras,
      extensions: getExtensionNames(scene),
    };
  });

  const nodeReports = nodes.map((node, nodeIndex) => {
    const mesh = node.getMesh();
    const meshIndex = getMeshIndex(meshes, mesh);
    const nodeExtras = getExtras(node);
    const meshExtras = mesh ? getExtras(mesh) : undefined;
    const nodeExtensions = getExtensionNames(node);
    const meshExtensions = mesh ? getExtensionNames(mesh) : [];

    addMetadataKeys(metadataKeys, nodeExtras);
    addMetadataKeys(metadataKeys, meshExtras);
    nodeExtensions.forEach((extensionName) => extensionNames.add(extensionName));
    meshExtensions.forEach((extensionName) => extensionNames.add(extensionName));

    const primitives =
      mesh?.listPrimitives().map((primitive, primitiveIndex) => {
        const material = primitive.getMaterial();
        const materialIndex = getMaterialIndex(materials, material);
        const primitiveExtras = getExtras(primitive);
        const materialExtras = material ? getExtras(material) : undefined;
        const primitiveExtensions = getExtensionNames(primitive);
        const materialExtensions = material ? getExtensionNames(material) : [];
        const position = primitive.getAttribute('POSITION');
        const indices = primitive.getIndices();

        addMetadataKeys(metadataKeys, primitiveExtras);
        addMetadataKeys(metadataKeys, materialExtras);
        primitiveExtensions.forEach((extensionName) => extensionNames.add(extensionName));
        materialExtensions.forEach((extensionName) => extensionNames.add(extensionName));

        return {
          primitiveIndex,
          mode: primitive.getMode(),
          extras: primitiveExtras,
          extensions: primitiveExtensions,
          attributes: getPrimitiveAttributes(primitive),
          hasIndices: Boolean(indices),
          positionCount: position?.getCount() ?? 0,
          indexCount: indices?.getCount() ?? 0,
          materialIndex,
          materialName: material?.getName() || undefined,
          materialExtras,
          materialExtensions,
        };
      }) ?? [];

    return {
      nodeIndex,
      name: node.getName() || undefined,
      extras: nodeExtras,
      extensions: nodeExtensions,
      meshIndex,
      meshName: mesh?.getName() || undefined,
      meshExtras,
      meshExtensions,
      primitiveCount: primitives.length,
      primitives,
    };
  });

  const meshReports = meshes.map((mesh, meshIndex) => {
    const extras = getExtras(mesh);
    const extensions = getExtensionNames(mesh);
    addMetadataKeys(metadataKeys, extras);
    extensions.forEach((extensionName) => extensionNames.add(extensionName));

    return {
      meshIndex,
      name: mesh.getName() || undefined,
      extras,
      extensions,
      primitiveCount: mesh.listPrimitives().length,
    };
  });

  const materialReports = materials.map((material, materialIndex) => {
    const extras = getExtras(material);
    const extensions = getExtensionNames(material);
    addMetadataKeys(metadataKeys, extras);
    extensions.forEach((extensionName) => extensionNames.add(extensionName));

    return {
      materialIndex,
      name: material.getName() || undefined,
      extras,
      extensions,
      hasBaseColorTexture: Boolean(material.getBaseColorTexture()),
      baseColorFactor: [...material.getBaseColorFactor()],
      metallicFactor: material.getMetallicFactor(),
      roughnessFactor: material.getRoughnessFactor(),
      doubleSided: material.getDoubleSided(),
      alphaMode: material.getAlphaMode(),
    };
  });

  const textureReports = textures.map((texture: Texture, textureIndex) => {
    const extras = getExtras(texture);
    const extensions = getExtensionNames(texture);
    addMetadataKeys(metadataKeys, extras);
    extensions.forEach((extensionName) => extensionNames.add(extensionName));

    return {
      textureIndex,
      name: texture.getName() || undefined,
      uri: texture.getURI() || undefined,
      mimeType: texture.getMimeType(),
      extras,
      extensions,
      imageByteLength: texture.getImage()?.byteLength ?? 0,
    };
  });

  const accessorReports = (rawJson.accessors ?? []).map((accessor, accessorIndex) => {
    addMetadataKeys(metadataKeys, accessor.extras);
    getRawExtensionNames(accessor).forEach((extensionName) => extensionNames.add(extensionName));

    return {
      accessorIndex,
      name: accessor.name || undefined,
      extras: accessor.extras,
      extensions: getRawExtensionNames(accessor),
    };
  });

  const bufferViewReports = (rawJson.bufferViews ?? []).map((bufferView, bufferViewIndex) => {
    addMetadataKeys(metadataKeys, bufferView.extras);
    getRawExtensionNames(bufferView).forEach((extensionName) => extensionNames.add(extensionName));

    return {
      bufferViewIndex,
      name: bufferView.name || undefined,
      extras: bufferView.extras,
      extensions: getRawExtensionNames(bufferView),
    };
  });

  addMetadataKeys(metadataKeys, rawJson.asset?.extras);

  const report: MetadataReport = {
    summary: {
      sourceFile: path.basename(inputPath),
      sourcePath: inputPath,
      sceneCount: scenes.length,
      nodeCount: nodes.length,
      meshCount: meshes.length,
      primitiveCount: meshes.reduce((sum, mesh) => sum + mesh.listPrimitives().length, 0),
      materialCount: materials.length,
      textureCount: textures.length,
      nodesWithName: nodes.filter((node) => node.getName()).length,
      nodesWithExtras: nodes.filter((node) => getExtras(node)).length,
      meshesWithName: meshes.filter((mesh) => mesh.getName()).length,
      meshesWithExtras: meshes.filter((mesh) => getExtras(mesh)).length,
      primitivesWithExtras: meshes.reduce((sum, mesh) => sum + mesh.listPrimitives().filter((primitive) => getExtras(primitive)).length, 0),
      materialsWithName: materials.filter((material) => material.getName()).length,
      materialsWithExtras: materials.filter((material) => getExtras(material)).length,
      texturesWithName: textures.filter((texture) => texture.getName()).length,
      texturesWithExtras: textures.filter((texture) => getExtras(texture)).length,
      extensionNames: [...extensionNames].sort(),
      detectedMetadataKeys: [...metadataKeys].sort(),
      rawJsonKeywordHits,
    },
    asset: {
      generator: rawJson.asset?.generator,
      version: rawJson.asset?.version,
      minVersion: rawJson.asset?.minVersion,
      copyright: rawJson.asset?.copyright,
      extras: rawJson.asset?.extras,
    },
    rawJson: {
      byteLength: Buffer.byteLength(jsonText),
      keywordHits: rawJsonKeywordHits,
    },
    scenes: sceneReports,
    nodes: nodeReports,
    nodeHierarchy: buildNodeHierarchy(rawJson, nodeReports),
    meshes: meshReports,
    materials: materialReports,
    textures: textureReports,
    accessors: accessorReports,
    bufferViews: bufferViewReports,
  };

  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`wrote: ${outputPath}`);
  console.log(`scene count: ${report.summary.sceneCount}`);
  console.log(`node count: ${report.summary.nodeCount}`);
  console.log(`mesh count: ${report.summary.meshCount}`);
  console.log(`primitive count: ${report.summary.primitiveCount}`);
  console.log(`material count: ${report.summary.materialCount}`);
  console.log(`texture count: ${report.summary.textureCount}`);
  console.log(`nodes with name: ${report.summary.nodesWithName}`);
  console.log(`nodes with extras: ${report.summary.nodesWithExtras}`);
  console.log(`meshes with name: ${report.summary.meshesWithName}`);
  console.log(`meshes with extras: ${report.summary.meshesWithExtras}`);
  console.log(`primitives with extras: ${report.summary.primitivesWithExtras}`);
  console.log(`materials with extras: ${report.summary.materialsWithExtras}`);
  console.log(`detected metadata keys: ${report.summary.detectedMetadataKeys.join(', ') || '(none)'}`);
  console.log(`extensions: ${report.summary.extensionNames.join(', ') || '(none)'}`);
  console.log(`asset generator: ${report.asset.generator || '(none)'}`);
  console.log(`raw JSON keyword hits: ${report.summary.rawJsonKeywordHits.map((hit) => `${hit.keyword}=${hit.count}`).join(', ') || '(none)'}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
