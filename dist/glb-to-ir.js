import fs from 'node:fs/promises';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { createGlbIO } from './gltf-io.js';
const TRIANGLES = 4;
const ITEM_CATEGORY = 'GLB_MESH';
const FIRST_LOCAL_ID = 1;
function usage() {
    console.error('Usage: node dist/glb-to-ir.js input.glb output.ir.json');
    process.exit(1);
}
function getCliArgs() {
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
function typedArrayToNumberArray(array, label) {
    if (!array) {
        throw new Error(`${label} accessor has no array data.`);
    }
    return Array.from(array, Number);
}
function colorFactorToByte(value) {
    return Math.max(0, Math.min(255, Math.round(value * 255)));
}
// get materials by reading textures pngs
function averageRgbaPixels(data) {
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
function getTextureAverageColor(texture) {
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
    console.warn(`Unsupported baseColorTexture mime type: ${mimeType}`);
    return undefined;
}
function multiplyTextureColorByFactor(textureColor, factor) {
    return {
        r: colorFactorToByte((textureColor.r / 255) * factor[0]),
        g: colorFactorToByte((textureColor.g / 255) * factor[1]),
        b: colorFactorToByte((textureColor.b / 255) * factor[2]),
        a: colorFactorToByte((textureColor.a / 255) * factor[3]),
    };
}
function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label} expected ${expected}, got ${actual}.`);
    }
}
function createSpatialTree(scene, nodeIndexByNode, itemByNode, sourceFile) {
    const createNode = (node) => {
        const nodeIndex = nodeIndexByNode.get(node);
        const item = itemByNode.get(node);
        const children = node.listChildren().map(createNode);
        if (item) {
            return {
                category: item.category,
                localId: item.localId,
                sourceNodeIndex: nodeIndex,
                sourceNodeName: node.getName() || undefined,
                children,
            };
        }
        return {
            category: node.getName() || (nodeIndex === undefined ? 'GLB_NODE' : `GLB_NODE_${nodeIndex}`),
            localId: null,
            sourceNodeIndex: nodeIndex,
            sourceNodeName: node.getName() || undefined,
            children,
        };
    };
    return {
        category: scene.getName() || path.basename(sourceFile, path.extname(sourceFile)),
        localId: null,
        children: scene.listChildren().map(createNode),
    };
}
// for changing the coordinate from y-up to z-up 
function convertYUpToZUpVector(x, y, z) {
    return [x, y, z];
}
function convertYUpToZUpArray(values, label) {
    if (values.length === 0 || values.length % 3 !== 0) {
        throw new Error(`${label}.length must be a non-empty multiple of 3, got ${values.length}.`);
    }
    const converted = [];
    for (let index = 0; index < values.length; index += 3) {
        converted.push(...convertYUpToZUpVector(values[index], values[index + 1], values[index + 2]));
    }
    return converted;
}
function computeBoundingBox(positions) {
    if (positions.length === 0 || positions.length % 3 !== 0) {
        throw new Error(`positions.length must be a non-empty multiple of 3, got ${positions.length}.`);
    }
    const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (let index = 0; index < positions.length; index += 3) {
        const x = positions[index];
        const y = positions[index + 1];
        const z = positions[index + 2];
        min[0] = Math.min(min[0], x);
        min[1] = Math.min(min[1], y);
        min[2] = Math.min(min[2], z);
        max[0] = Math.max(max[0], x);
        max[1] = Math.max(max[1], y);
        max[2] = Math.max(max[2], z);
    }
    return { min, max };
}
function createMaterialId(index) {
    return `material-${index}`;
}
function createIrMaterial(material, materialIndex) {
    const baseColorFactor = material.getBaseColorFactor();
    const [r, g, b, a] = baseColorFactor;
    const baseColorTexture = material.getBaseColorTexture();
    const textureAverageColor = getTextureAverageColor(baseColorTexture);
    const materialColor = textureAverageColor
        ? multiplyTextureColorByFactor(textureAverageColor, baseColorFactor)
        : {
            r: colorFactorToByte(r),
            g: colorFactorToByte(g),
            b: colorFactorToByte(b),
            a: colorFactorToByte(a),
        };
    return {
        id: createMaterialId(materialIndex),
        name: material.getName() || undefined,
        r: materialColor.r,
        g: materialColor.g,
        b: materialColor.b,
        a: materialColor.a,
        source: {
            hasBaseColorTexture: Boolean(baseColorTexture),
            baseColorTextureName: baseColorTexture?.getName() || undefined,
            textureAverageColor,
            colorSource: textureAverageColor ? 'baseColorTextureAverage' : 'baseColorFactor',
        },
    };
}
function createDefaultMaterial() {
    return {
        id: 'material-default',
        name: 'Default',
        r: 255,
        g: 255,
        b: 255,
        a: 255,
        source: {
            hasBaseColorTexture: false,
            colorSource: 'baseColorFactor',
        },
    };
}
function createGeometryId(index) {
    return `geometry-${index}`;
}
async function main() {
    const { inputPath, outputPath } = getCliArgs();
    const io = await createGlbIO();
    const document = await io.read(inputPath);
    const root = document.getRoot();
    const scenes = root.listScenes();
    const nodes = root.listNodes();
    const meshes = root.listMeshes();
    const materials = root.listMaterials();
    const primitiveCount = meshes.reduce((sum, mesh) => sum + mesh.listPrimitives().length, 0);
    assertEqual(scenes.length, 1, 'scene count');
    if (nodes.length === 0) {
        throw new Error('GLB must contain at least one node.');
    }
    const materialIndexByMaterial = new Map(materials.map((material, index) => [material, index]));
    const irMaterials = materials.map((material, index) => createIrMaterial(material, index));
    const defaultMaterial = createDefaultMaterial();
    const items = [];
    const geometryIdByPrimitive = new Map();
    const geometries = {};
    const nodeIndexByNode = new Map(nodes.map((node, index) => [node, index]));
    const itemByNode = new Map();
    let localId = FIRST_LOCAL_ID;
    let sampleCount = 0;
    for (const [nodeIndex, node] of nodes.entries()) {
        const mesh = node.getMesh();
        if (!mesh) {
            continue;
        }
        const nodeName = node.getName() || mesh.getName() || `item-${localId}`;
        const samples = [];
        for (const [primitiveIndex, primitive] of mesh.listPrimitives().entries()) {
            if (primitive.getMode() !== TRIANGLES) {
                throw new Error(`Only triangle mesh mode ${TRIANGLES} is supported. node=${nodeName} primitive=${primitiveIndex} mode=${primitive.getMode()}.`);
            }
            let geometryId = geometryIdByPrimitive.get(primitive);
            if (!geometryId) {
                const positionAccessor = primitive.getAttribute('POSITION');
                const indexAccessor = primitive.getIndices();
                const normalAccessor = primitive.getAttribute('NORMAL');
                const uvAccessor = primitive.getAttribute('TEXCOORD_0');
                if (!positionAccessor) {
                    throw new Error(`Primitive POSITION attribute is required. node=${nodeName} primitive=${primitiveIndex}.`);
                }
                if (!indexAccessor) {
                    throw new Error(`Indexed triangle geometry is required. node=${nodeName} primitive=${primitiveIndex}.`);
                }
                const sourcePositions = typedArrayToNumberArray(positionAccessor.getArray(), 'POSITION');
                const indices = typedArrayToNumberArray(indexAccessor.getArray(), 'indices');
                const positions = convertYUpToZUpArray(sourcePositions, 'positions');
                const positionCount = positionAccessor.getCount();
                const indexCount = indexAccessor.getCount();
                assertEqual(positions.length, positionCount * 3, `positions.length node=${nodeName} primitive=${primitiveIndex}`);
                assertEqual(indices.length, indexCount, `indices.length node=${nodeName} primitive=${primitiveIndex}`);
                if (indices.length % 3 !== 0) {
                    throw new Error(`indices.length must be divisible by 3, got ${indices.length}. node=${nodeName} primitive=${primitiveIndex}.`);
                }
                const geometryStats = {
                    vertexCount: positionCount,
                    positionComponentCount: positions.length,
                    indexCount: indices.length,
                    triangleCount: indices.length / 3,
                };
                if (normalAccessor) {
                    geometryStats.normalComponentCount = normalAccessor.getCount() * 3;
                }
                if (uvAccessor) {
                    geometryStats.uvComponentCount = uvAccessor.getCount() * 2;
                }
                const geometry = {
                    positions,
                    indices,
                    stats: geometryStats,
                    bbox: computeBoundingBox(positions),
                    mode: 'TRIANGLES',
                };
                geometryId = createGeometryId(geometryIdByPrimitive.size);
                geometryIdByPrimitive.set(primitive, geometryId);
                geometries[geometryId] = geometry;
            }
            const material = primitive.getMaterial();
            const materialIndex = material ? materialIndexByMaterial.get(material) : undefined;
            const materialId = materialIndex === undefined ? defaultMaterial.id : createMaterialId(materialIndex);
            samples.push({
                sourceMeshName: mesh.getName() || undefined,
                sourcePrimitiveIndex: primitiveIndex,
                materialId,
                transform: {
                    matrix: Array.from(node.getWorldMatrix(), Number),
                    position: [...node.getWorldTranslation()],
                    rotation: [...node.getWorldRotation()],
                    scale: [...node.getWorldScale()],
                },
                geometryId,
            });
            sampleCount += 1;
        }
        if (samples.length === 0) {
            continue;
        }
        const item = {
            localId,
            name: nodeName,
            category: ITEM_CATEGORY,
            sourceNodeName: node.getName() || undefined,
            samples,
            attributes: {
                Name: nodeName,
                SourceNodeName: node.getName() || '',
                SourceMeshName: mesh.getName() || '',
                SourceNodeIndex: nodeIndex,
            },
        };
        items.push(item);
        itemByNode.set(node, item);
        localId += 1;
    }
    if (items.length === 0) {
        throw new Error('No mesh nodes were found in the GLB.');
    }
    const outputMaterials = irMaterials.length > 0 ? irMaterials : [defaultMaterial];
    const ir = {
        model: {
            sourceFile: path.basename(inputPath),
            sourcePath: inputPath,
            sceneCount: scenes.length,
            nodeCount: nodes.length,
            meshCount: meshes.length,
            primitiveCount,
            sourceCoordinateSystem: 'GLB_Y_UP',
            targetCoordinateSystem: 'FRAG_Z_UP',
        },
        items,
        materials: outputMaterials,
        geometries,
        spatialTree: createSpatialTree(scenes[0], nodeIndexByNode, itemByNode, inputPath),
    };
    await fs.writeFile(outputPath, `${JSON.stringify(ir, null, 2)}\n`, 'utf8');
    console.log(`wrote: ${outputPath}`);
    console.log(`scene count: ${scenes.length}`);
    console.log(`node count: ${nodes.length}`);
    console.log(`mesh count: ${meshes.length}`);
    console.log(`primitive count: ${primitiveCount}`);
    console.log(`mesh node items: ${items.length}`);
    console.log(`samples.length: ${sampleCount}`);
    console.log(`materials.length: ${ir.materials.length}`);
    console.log(`geometries.length: ${Object.keys(geometries).length}`);
    console.log(`positions.length unique total: ${Object.values(geometries).reduce((sum, geometry) => sum + geometry.stats.positionComponentCount, 0)}`);
    console.log(`indices.length unique total: ${Object.values(geometries).reduce((sum, geometry) => sum + geometry.stats.indexCount, 0)}`);
    console.log(`triangles unique total: ${Object.values(geometries).reduce((sum, geometry) => sum + geometry.stats.triangleCount, 0)}`);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
