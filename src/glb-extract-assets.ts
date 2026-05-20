import { type Material, type Texture, type TextureInfo } from '@gltf-transform/core';
import fs from 'node:fs/promises';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { createGlbIO } from './gltf-io.js';

type TextureSlot = {
  textureId: string;
  file: string;
  mimeType: string;
  uri?: string;
  texCoord?: number;
  wrapS?: number;
  wrapT?: number;
  magFilter?: number | null;
  minFilter?: number | null;
};

type FallbackColorSource = 'baseColorFactor' | 'baseColorTextureAverage';

type MaterialSidecar = {
  schemaVersion: 1;
  modelName: string;
  source: {
    type: 'glb';
    fileName: string;
    path: string;
  };
  materials: Array<{
    sourceMaterialIndex: number;
    sourceMaterialName?: string;
    fallbackColor: [number, number, number, number];
    fallbackColorSource: FallbackColorSource;
    baseColorFactor: number[];
    metallicFactor: number;
    roughnessFactor: number;
    emissiveFactor: number[];
    alphaMode: string;
    alphaCutoff: number;
    doubleSided: boolean;
    normalScale: number;
    occlusionStrength: number;
    baseColorTexture: TextureSlot | null;
    metallicRoughnessTexture: TextureSlot | null;
    normalTexture: TextureSlot | null;
    occlusionTexture: TextureSlot | null;
    emissiveTexture: TextureSlot | null;
  }>;
  assignments: Array<{
    fragmentMaterialIndex: number;
    sourceMaterialIndex: number;
  }>;
  geometryUvSets: GeometryUvSet[];
  uvBuffers: UvBufferSummary[];
  debug: {
    generator: string;
    textures: TextureSummary[];
    samples: SampleSummary[];
  };
};

type GeometryUvSet = {
  fragmentRepresentationIndex: number;
  fragmentShellIndex: number;
  sourceMeshName?: string;
  sourcePrimitiveIndex: number;
  texCoord: 0;
  sourceMaterialIndex: number | null;
  indexed: {
    vertexCount: number;
    uvComponentCount: number;
  };
  triangleExpanded: {
    vertexCount: number;
    uvComponentCount: number;
    triangleCount: number;
    buffer: UvBufferRef;
  };
};

type SampleSummary = {
  localId: number;
  sourceMeshName?: string;
  sourcePrimitiveIndex: number;
  sourceMaterialIndex: number | null;
  uvSet0?: {
    componentCount: number;
  };
};

type UvBufferRef = {
  file: string;
  byteOffset: number;
  byteLength: number;
  componentType: 'FLOAT32';
  componentCount: number;
};

type UvBufferSummary = {
  file: string;
  byteLength: number;
  componentType: 'FLOAT32';
  componentCount: number;
};

type TextureSummary = {
  id: string;
  name?: string;
  file: string;
  mimeType: string;
  byteLength: number;
};

type RgbaByteColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

function usage(): never {
  console.error('Usage: node dist/glb-extract-assets.js input.glb [output-dir]');
  process.exit(1);
}

function getCliArgs(): { inputPath: string; outputDir: string } {
  const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const [input, output] = positionalArgs;

  if (!input || positionalArgs.length > 2) {
    usage();
  }

  const inputPath = path.resolve(input);

  return {
    inputPath,
    outputDir: output ? path.resolve(output) : deriveOutputDir(inputPath),
  };
}

function deriveOutputDir(inputPath: string): string {
  return path.join(path.dirname(inputPath), '材質包', path.basename(inputPath, path.extname(inputPath)));
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'texture';
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  return '.bin';
}

function requireArray(array: ArrayLike<number> | null, label: string): ArrayLike<number> {
  if (!array) {
    throw new Error(`${label} accessor has no array data.`);
  }

  return array;
}

function buildTriangleExpandedUvs(indices: ArrayLike<number>, uvs: ArrayLike<number>): Float32Array {
  if (uvs.length === 0 || uvs.length % 2 !== 0) {
    throw new Error(`TEXCOORD_0.length must be a non-empty multiple of 2, got ${uvs.length}.`);
  }

  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw new Error(`indices.length must be a non-empty multiple of 3, got ${indices.length}.`);
  }

  const vertexCount = uvs.length / 2;
  const expanded = new Float32Array(indices.length * 2);

  for (let index = 0; index < indices.length; index += 1) {
    const vertexIndex = indices[index];
    if (vertexIndex < 0 || vertexIndex >= vertexCount) {
      throw new Error(`UV index ${vertexIndex} is outside TEXCOORD_0 vertex count ${vertexCount}.`);
    }

    expanded[index * 2] = uvs[vertexIndex * 2];
    expanded[index * 2 + 1] = uvs[vertexIndex * 2 + 1];
  }

  return expanded;
}

function float32ByteLength(array: Float32Array): number {
  return array.length * Float32Array.BYTES_PER_ELEMENT;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function byteToUnit(value: number): number {
  return clamp01(value / 255);
}

function averageRgbaPixels(data: Uint8Array | Buffer): RgbaByteColor {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const pixelCount = data.length / 4;

  if (!Number.isInteger(pixelCount) || pixelCount === 0) {
    throw new Error(`Invalid RGBA pixel data length: ${data.length}.`);
  }

  for (let index = 0; index < data.length; index += 4) {
    r += data[index];
    g += data[index + 1];
    b += data[index + 2];
    a += data[index + 3];
  }

  return {
    r: Math.round(r / pixelCount),
    g: Math.round(g / pixelCount),
    b: Math.round(b / pixelCount),
    a: Math.round(a / pixelCount),
  };
}

function getTextureAverageColor(texture: Texture | null): RgbaByteColor | undefined {
  if (!texture) {
    return undefined;
  }

  const image = texture.getImage();

  if (!image) {
    return undefined;
  }

  const mimeType = texture.getMimeType();

  if (mimeType === 'image/png') {
    const png = PNG.sync.read(Buffer.from(image));
    return averageRgbaPixels(png.data);
  }

  if (mimeType === 'image/jpeg') {
    const jpegData = jpeg.decode(Buffer.from(image), { useTArray: true });
    return averageRgbaPixels(jpegData.data);
  }

  console.warn(`Unsupported baseColorTexture mime type for fallbackColor: ${mimeType}`);
  return undefined;
}

function getFallbackColor(material: Material): { color: [number, number, number, number]; source: FallbackColorSource } {
  const baseColorFactor = material.getBaseColorFactor();
  const textureAverageColor = getTextureAverageColor(material.getBaseColorTexture());

  if (!textureAverageColor) {
    return {
      color: [
        clamp01(baseColorFactor[0]),
        clamp01(baseColorFactor[1]),
        clamp01(baseColorFactor[2]),
        clamp01(baseColorFactor[3]),
      ],
      source: 'baseColorFactor',
    };
  }

  return {
    color: [
      byteToUnit(textureAverageColor.r) * baseColorFactor[0],
      byteToUnit(textureAverageColor.g) * baseColorFactor[1],
      byteToUnit(textureAverageColor.b) * baseColorFactor[2],
      byteToUnit(textureAverageColor.a) * baseColorFactor[3],
    ],
    source: 'baseColorTextureAverage',
  };
}

function getTextureSlot(texture: Texture | null, info: TextureInfo | null, textureIdByTexture: Map<Texture, string>, fileByTexture: Map<Texture, string>): TextureSlot | undefined {
  if (!texture) {
    return undefined;
  }

  const textureId = textureIdByTexture.get(texture);
  const file = fileByTexture.get(texture);

  if (!textureId || !file) {
    throw new Error(`Texture was not exported: ${texture.getName() || texture.getURI() || '(unnamed texture)'}`);
  }

  return {
    textureId,
    file,
    mimeType: texture.getMimeType(),
    uri: texture.getURI() || undefined,
    texCoord: info?.getTexCoord(),
    wrapS: info?.getWrapS(),
    wrapT: info?.getWrapT(),
    magFilter: info?.getMagFilter(),
    minFilter: info?.getMinFilter(),
  };
}

async function main(): Promise<void> {
  const { inputPath, outputDir } = getCliArgs();
  const textureDir = path.join(outputDir, 'textures');
  const uvDir = path.join(outputDir, 'uv');
  const uvBufferFile = path.join('uv', 'triangle-expanded-uvs.bin').replaceAll('\\', '/');
  const uvBufferPath = path.join(outputDir, uvBufferFile);
  const io = await createGlbIO();
  const document = await io.read(inputPath);
  const root = document.getRoot();

  await fs.mkdir(textureDir, { recursive: true });
  await fs.mkdir(uvDir, { recursive: true });

  const textureIdByTexture = new Map<Texture, string>();
  const fileByTexture = new Map<Texture, string>();
  const textureSummaries: TextureSummary[] = [];

  for (const [textureIndex, texture] of root.listTextures().entries()) {
    const image = texture.getImage();

    if (!image) {
      continue;
    }

    const textureId = `texture-${textureIndex}`;
    const textureName = texture.getName() || texture.getURI() || textureId;
    const fileName = `${textureId}-${sanitizeFileName(textureName)}${extensionFromMimeType(texture.getMimeType())}`;
    const relativeFile = path.join('textures', fileName).replaceAll('\\', '/');
    const outputPath = path.join(outputDir, relativeFile);

    await fs.writeFile(outputPath, image);
    textureIdByTexture.set(texture, textureId);
    fileByTexture.set(texture, relativeFile);
    textureSummaries.push({
      id: textureId,
      name: texture.getName() || undefined,
      file: relativeFile,
      mimeType: texture.getMimeType(),
      byteLength: image.byteLength,
    });
  }

  const materials = root.listMaterials().map((material, materialIndex) => {
    const fallback = getFallbackColor(material);

    return {
      sourceMaterialIndex: materialIndex,
      sourceMaterialName: material.getName() || undefined,
      fallbackColor: fallback.color,
      fallbackColorSource: fallback.source,
      baseColorFactor: [...material.getBaseColorFactor()],
      metallicFactor: material.getMetallicFactor(),
      roughnessFactor: material.getRoughnessFactor(),
      emissiveFactor: [...material.getEmissiveFactor()],
      alphaMode: material.getAlphaMode(),
      alphaCutoff: material.getAlphaCutoff(),
      doubleSided: material.getDoubleSided(),
      normalScale: material.getNormalScale(),
      occlusionStrength: material.getOcclusionStrength(),
      baseColorTexture: getTextureSlot(material.getBaseColorTexture(), material.getBaseColorTextureInfo(), textureIdByTexture, fileByTexture) ?? null,
      metallicRoughnessTexture:
        getTextureSlot(material.getMetallicRoughnessTexture(), material.getMetallicRoughnessTextureInfo(), textureIdByTexture, fileByTexture) ?? null,
      normalTexture: getTextureSlot(material.getNormalTexture(), material.getNormalTextureInfo(), textureIdByTexture, fileByTexture) ?? null,
      occlusionTexture: getTextureSlot(material.getOcclusionTexture(), material.getOcclusionTextureInfo(), textureIdByTexture, fileByTexture) ?? null,
      emissiveTexture: getTextureSlot(material.getEmissiveTexture(), material.getEmissiveTextureInfo(), textureIdByTexture, fileByTexture) ?? null,
    };
  });

  const materialIndexByMaterial = new Map(root.listMaterials().map((material, index) => [material, index]));
  const samples: SampleSummary[] = [];
  const geometryUvSets: GeometryUvSet[] = [];
  let primitiveSequenceIndex = 0;
  let uvBufferByteOffset = 0;
  let uvBufferComponentCount = 0;
  const uvBufferHandle = await fs.open(uvBufferPath, 'w');

  try {
    for (const mesh of root.listMeshes()) {
      for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
        const uvAccessor = primitive.getAttribute('TEXCOORD_0');
        const indexAccessor = primitive.getIndices();
        const material = primitive.getMaterial();
        const sourceMaterialIndex = material ? materialIndexByMaterial.get(material) ?? null : null;
        const uvValues = uvAccessor ? requireArray(uvAccessor.getArray(), 'TEXCOORD_0') : undefined;

        samples.push({
          localId: 1,
          sourceMeshName: mesh.getName() || undefined,
          sourcePrimitiveIndex: primitiveIndex,
          sourceMaterialIndex,
          uvSet0: uvValues
            ? {
                componentCount: uvValues.length,
              }
            : undefined,
        });

        if (uvValues && indexAccessor) {
          const indices = requireArray(indexAccessor.getArray(), 'indices');
          const triangleExpandedUvs = buildTriangleExpandedUvs(indices, uvValues);
          const byteLength = float32ByteLength(triangleExpandedUvs);
          const byteOffset = uvBufferByteOffset;

          await uvBufferHandle.write(Buffer.from(triangleExpandedUvs.buffer), 0, byteLength, byteOffset);
          uvBufferByteOffset += byteLength;
          uvBufferComponentCount += triangleExpandedUvs.length;

          geometryUvSets.push({
            fragmentRepresentationIndex: primitiveSequenceIndex,
            fragmentShellIndex: primitiveSequenceIndex,
            sourceMeshName: mesh.getName() || undefined,
            sourcePrimitiveIndex: primitiveIndex,
            texCoord: 0,
            sourceMaterialIndex,
            indexed: {
              vertexCount: uvValues.length / 2,
              uvComponentCount: uvValues.length,
            },
            triangleExpanded: {
              vertexCount: indices.length,
              uvComponentCount: triangleExpandedUvs.length,
              triangleCount: indices.length / 3,
              buffer: {
                file: uvBufferFile,
                byteOffset,
                byteLength,
                componentType: 'FLOAT32',
                componentCount: triangleExpandedUvs.length,
              },
            },
          });
        }

        primitiveSequenceIndex += 1;
      }
    }
  } finally {
    await uvBufferHandle.close();
  }

  const assignments = materials.map((material) => ({
    fragmentMaterialIndex: material.sourceMaterialIndex,
    sourceMaterialIndex: material.sourceMaterialIndex,
  }));
  const modelName = path.basename(inputPath, path.extname(inputPath));
  const sidecar: MaterialSidecar = {
    schemaVersion: 1,
    modelName,
    source: {
      type: 'glb',
      fileName: path.basename(inputPath),
      path: inputPath,
    },
    materials,
    assignments,
    geometryUvSets,
    uvBuffers: [
      {
        file: uvBufferFile,
        byteLength: uvBufferByteOffset,
        componentType: 'FLOAT32',
        componentCount: uvBufferComponentCount,
      },
    ],
    debug: {
      generator: 'glb-extract-assets-mvp',
      textures: textureSummaries,
      samples,
    },
  };

  const outputJson = path.join(outputDir, `${modelName}.materials.json`);
  await fs.writeFile(outputJson, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

  console.log(`wrote: ${outputJson}`);
  console.log(`materials.length: ${sidecar.materials.length}`);
  console.log(`assignments.length: ${sidecar.assignments.length}`);
  console.log(`geometryUvSets.length: ${sidecar.geometryUvSets.length}`);
  console.log(`triangleExpanded uv vertices: ${sidecar.geometryUvSets.reduce((sum, set) => sum + set.triangleExpanded.vertexCount, 0)}`);
  console.log(`uv buffer bytes: ${uvBufferByteOffset}`);
  console.log(`textures.length: ${sidecar.debug.textures.length}`);
  console.log(`samples.length: ${sidecar.debug.samples.length}`);
  console.log(`uvSet0 samples: ${sidecar.debug.samples.filter((sample) => sample.uvSet0).length}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
