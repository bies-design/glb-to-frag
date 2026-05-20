import path from 'node:path';
import { createGlbIO } from './gltf-io.js';
function usage() {
    console.error('Usage: node dist/glb-smoke-test.js input.glb');
    process.exit(1);
}
function getInputPath() {
    const input = process.argv[2];
    if (!input) {
        usage();
    }
    return path.resolve(input);
}
async function main() {
    const inputPath = getInputPath();
    const io = await createGlbIO();
    const document = await io.read(inputPath);
    const root = document.getRoot();
    const scenes = root.listScenes();
    const nodes = root.listNodes();
    const meshes = root.listMeshes();
    const materials = root.listMaterials();
    const primitiveStats = [];
    for (const mesh of meshes) {
        mesh.listPrimitives().forEach((primitive, primitiveIndex) => {
            const positionAccessor = primitive.getAttribute('POSITION');
            const indexAccessor = primitive.getIndices();
            const material = primitive.getMaterial();
            primitiveStats.push({
                meshName: mesh.getName() || '(unnamed mesh)',
                primitiveIndex,
                positionCount: positionAccessor?.getCount() ?? 0,
                indexCount: indexAccessor?.getCount() ?? 0,
                materialName: material?.getName() || '(no material)',
            });
        });
    }
    const primitiveCount = primitiveStats.length;
    const totalPositionCount = primitiveStats.reduce((sum, primitive) => sum + primitive.positionCount, 0);
    const totalIndexCount = primitiveStats.reduce((sum, primitive) => sum + primitive.indexCount, 0);
    console.log(`source: ${inputPath}`);
    console.log(`scene count: ${scenes.length}`);
    console.log(`node count: ${nodes.length}`);
    console.log(`mesh count: ${meshes.length}`);
    console.log(`primitive count: ${primitiveCount}`);
    console.log(`position count: ${totalPositionCount}`);
    console.log(`index count: ${totalIndexCount}`);
    console.log(`material count: ${materials.length}`);
    console.log('');
    console.log('mesh primitives:');
    for (const primitive of primitiveStats) {
        console.log(`- mesh="${primitive.meshName}" primitive=${primitive.primitiveIndex} positions=${primitive.positionCount} indices=${primitive.indexCount} material="${primitive.materialName}"`);
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
