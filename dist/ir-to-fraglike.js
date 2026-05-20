import fs from 'node:fs/promises';
import path from 'node:path';
function usage() {
    console.error('Usage: node dist/ir-to-fraglike.js input.ir.json output.fraglike.json');
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
function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error(`${label} expected ${expected}, got ${actual}.`);
    }
}
function assertLessThan(actual, limit, label) {
    if (actual >= limit) {
        throw new Error(`${label} must be < ${limit}, got ${actual}.`);
    }
}
function positionsToPoints(positions) {
    if (positions.length === 0 || positions.length % 3 !== 0) {
        throw new Error(`positions.length must be a non-empty multiple of 3, got ${positions.length}.`);
    }
    const points = [];
    for (let index = 0; index < positions.length; index += 3) {
        points.push([positions[index], positions[index + 1], positions[index + 2]]);
    }
    return points;
}
function indicesToProfiles(indices) {
    if (indices.length === 0 || indices.length % 3 !== 0) {
        throw new Error(`indices.length must be a non-empty multiple of 3, got ${indices.length}.`);
    }
    const profiles = [];
    for (let index = 0; index < indices.length; index += 3) {
        profiles.push({ indices: [indices[index], indices[index + 1], indices[index + 2]] });
    }
    return profiles;
}
function getIndexMax(profiles) {
    return profiles.reduce((max, profile) => Math.max(max, ...profile.indices), Number.NEGATIVE_INFINITY);
}
function inferSchemaAttributeType(value) {
    if (typeof value === 'number') {
        return 'NUMBER';
    }
    if (typeof value === 'boolean') {
        return 'BOOLEAN';
    }
    return 'TEXT';
}
function toAttributeData(attributes) {
    return Object.entries(attributes).map(([key, value]) => JSON.stringify([key, value, inferSchemaAttributeType(value)]));
}
function toFragLikeTransform(transform) {
    const matrix = transform.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return {
        position: transform.position ?? [0, 0, 0],
        x_direction: [matrix[0], matrix[1], matrix[2]],
        y_direction: [matrix[4], matrix[5], matrix[6]],
    };
}
function validateShell(geometry, points, triangleProfiles) {
    if (geometry.mode !== 'TRIANGLES') {
        throw new Error(`geometry.mode expected TRIANGLES, got ${geometry.mode}.`);
    }
    assertEqual(points.length, geometry.stats.vertexCount, 'points.length');
    assertEqual(triangleProfiles.length, geometry.stats.triangleCount, 'triangleProfiles.length');
    for (const [profileIndex, profile] of triangleProfiles.entries()) {
        assertEqual(profile.indices.length, 3, `profiles[${profileIndex}].indices.length`);
    }
    const indexMax = getIndexMax(triangleProfiles);
    assertLessThan(indexMax, points.length, 'indexMax');
    return {
        point_count: points.length,
        profile_count: 0,
        big_profile_count: 0,
        triangle_count: triangleProfiles.length,
        index_max: indexMax,
    };
}
function getSampleGeometry(ir, sample) {
    if (sample.geometry) {
        return sample.geometry;
    }
    if (sample.geometryId && ir.geometries?.[sample.geometryId]) {
        return ir.geometries[sample.geometryId];
    }
    throw new Error(`Cannot find geometry for sample. geometryId=${sample.geometryId ?? '(missing)'}.`);
}
function convertIrToFragLike(ir) {
    if (ir.items.length === 0) {
        throw new Error('IR must contain at least one item.');
    }
    if (ir.materials.length === 0) {
        throw new Error('IR must contain at least one material.');
    }
    const localIds = ir.items.map((irItem) => irItem.localId);
    const materialIndexById = new Map(ir.materials.map((material, index) => [material.id, index]));
    const meshesItems = ir.items.map((_, itemIndex) => itemIndex);
    const samples = [];
    const representations = [];
    const shells = [];
    const localTransforms = [];
    const globalTransforms = [];
    const representationIndexByGeometryKey = new Map();
    let pointCountTotal = 0;
    let profileCountTotal = 0;
    let bigProfileCountTotal = 0;
    let triangleCountTotal = 0;
    let indexMaxTotal = Number.NEGATIVE_INFINITY;
    for (const [itemIndex, item] of ir.items.entries()) {
        if (item.samples.length === 0) {
            throw new Error(`IR item localId=${item.localId} must contain at least one sample.`);
        }
        for (const [sampleIndex, sample] of item.samples.entries()) {
            const geometry = getSampleGeometry(ir, sample);
            const materialIndex = materialIndexById.get(sample.materialId);
            if (materialIndex === undefined) {
                throw new Error(`Cannot find material for sample.materialId=${sample.materialId}. item=${item.localId} sample=${sampleIndex}.`);
            }
            const geometryKey = sample.geometryId ?? `${itemIndex}:${sampleIndex}`;
            let representationIndex = representationIndexByGeometryKey.get(geometryKey);
            if (representationIndex === undefined) {
                const points = positionsToPoints(geometry.positions);
                const triangleProfiles = indicesToProfiles(geometry.indices);
                const shellValidation = validateShell(geometry, points, triangleProfiles);
                const useBigProfiles = shellValidation.index_max > 65535;
                const profiles = useBigProfiles ? [] : triangleProfiles;
                const bigProfiles = useBigProfiles ? triangleProfiles : [];
                const shellType = useBigProfiles ? 'BIG' : 'NONE';
                representationIndex = representations.length;
                representationIndexByGeometryKey.set(geometryKey, representationIndex);
                representations.push({
                    id: representationIndex,
                    representation_class: 'SHELL',
                    bbox: geometry.bbox,
                });
                shells.push({
                    points,
                    profiles,
                    holes: [],
                    big_profiles: bigProfiles,
                    big_holes: [],
                    type: shellType,
                    profiles_face_ids: profiles.map((_, index) => index),
                });
                pointCountTotal += points.length;
                profileCountTotal += profiles.length;
                bigProfileCountTotal += bigProfiles.length;
                triangleCountTotal += triangleProfiles.length;
                indexMaxTotal = Math.max(indexMaxTotal, shellValidation.index_max);
            }
            const transformIndex = localTransforms.length;
            const transform = toFragLikeTransform(sample.transform);
            localTransforms.push(transform);
            globalTransforms.push(transform);
            samples.push({
                item: itemIndex,
                material: materialIndex,
                representation: representationIndex,
                local_transform: transformIndex,
            });
        }
    }
    const metadata = {
        sourceFile: ir.model.sourceFile,
        sourcePath: ir.model.sourcePath,
        converter: 'ir-to-fraglike-mvp',
        note: 'Schema-aligned JSON approximation. Not a binary .frag file.',
    };
    const meshes = {
        meshes_items: meshesItems,
        samples,
        representations,
        shells,
        materials: ir.materials.map((material) => ({
            r: material.r,
            g: material.g,
            b: material.b,
            a: material.a,
            rendered_faces: 'ONE',
            stroke: 'DEFAULT',
            source: {
                name: material.name,
                has_base_color_texture: material.source?.hasBaseColorTexture,
                base_color_texture_name: material.source?.baseColorTextureName,
                texture_conversion_supported: false,
            },
        })),
        circle_extrusions: [],
        local_transforms: localTransforms,
        global_transforms: globalTransforms,
        coordinates: toFragLikeTransform({}),
        material_ids: [],
        representation_ids: [],
        sample_ids: [],
        local_transform_ids: [],
        global_transform_ids: [],
    };
    for (const [sampleIndex, sample] of meshes.samples.entries()) {
        assertLessThan(sample.item, meshes.meshes_items.length, `samples[${sampleIndex}].item`);
        assertLessThan(meshes.meshes_items[sample.item], localIds.length, `meshes_items[samples[${sampleIndex}].item]`);
        assertLessThan(sample.local_transform, meshes.local_transforms.length, `samples[${sampleIndex}].local_transform`);
        assertLessThan(sample.material, meshes.materials.length, `samples[${sampleIndex}].material`);
        assertLessThan(sample.representation, meshes.representations.length, `samples[${sampleIndex}].representation`);
    }
    return {
        metadata: JSON.stringify(metadata),
        guids: [],
        guids_items: [],
        max_local_id: Math.max(...localIds) + 1,
        local_ids: localIds,
        categories: Array.from(new Set(ir.items.map((irItem) => irItem.category))),
        meshes,
        attributes: ir.items.map((item) => ({
            data: toAttributeData(item.attributes),
        })),
        relations: [],
        relations_items: [],
        guid: 'generated-model-guid',
        spatial_structure: null,
        unique_attributes: [],
        relation_names: [],
        indexes: [],
        debug: {
            source_stats: {
                model: ir.model,
                item_count: ir.items.length,
                sample_count: samples.length,
            },
            validation: {
                item_count: ir.items.length,
                sample_count: samples.length,
                shell_count: shells.length,
                representation_count: representations.length,
                material_count: meshes.materials.length,
                point_count_total: pointCountTotal,
                profile_count_total: profileCountTotal,
                big_profile_count_total: bigProfileCountTotal,
                triangle_count_total: triangleCountTotal,
                index_max: indexMaxTotal,
                local_ids_length: localIds.length,
                meshes_items_length: meshes.meshes_items.length,
                local_transforms_length: meshes.local_transforms.length,
                global_transforms_length: meshes.global_transforms.length,
                coordinates_present: Boolean(meshes.coordinates),
            },
        },
    };
}
async function main() {
    const { inputPath, outputPath } = getCliArgs();
    const ir = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    const fragLike = convertIrToFragLike(ir);
    await fs.writeFile(outputPath, `${JSON.stringify(fragLike, null, 2)}\n`, 'utf8');
    console.log(`wrote: ${outputPath}`);
    console.log(`local_ids.length: ${fragLike.local_ids.length}`);
    console.log(`categories: ${JSON.stringify(fragLike.categories)}`);
    console.log(`meshes.meshes_items.length: ${fragLike.meshes.meshes_items.length}`);
    console.log(`meshes.samples.length: ${fragLike.meshes.samples.length}`);
    console.log(`meshes.samples[0].item: ${fragLike.meshes.samples[0].item}`);
    console.log(`meshes.meshes_items[0]: ${fragLike.meshes.meshes_items[0]}`);
    console.log(`meshes.representations.length: ${fragLike.meshes.representations.length}`);
    console.log(`meshes.shells.length: ${fragLike.meshes.shells.length}`);
    console.log(`shell.points.length: ${fragLike.meshes.shells[0].points.length}`);
    console.log(`shell.profiles.length: ${fragLike.meshes.shells[0].profiles.length}`);
    console.log(`shell.big_profiles.length: ${fragLike.meshes.shells[0].big_profiles.length}`);
    console.log(`shell.type: ${fragLike.meshes.shells[0].type}`);
    console.log(`materials.length: ${fragLike.meshes.materials.length}`);
    console.log(`coordinates.position: ${JSON.stringify(fragLike.meshes.coordinates.position)}`);
    console.log(`index_max: ${fragLike.debug.validation.index_max}`);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
