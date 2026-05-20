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
import { Stroke } from './generated/stroke.js';
import { Transform } from './generated/transform.js';
function usage() {
    console.error('Usage: node dist/fraglike-to-frag.js input.fraglike.json output.frag [--raw]');
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
        raw: process.argv.includes('--raw'),
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
function validateFragLike(model) {
    const meshes = model.meshes;
    for (const [sampleIndex, sample] of meshes.samples.entries()) {
        assertLessThan(sample.item, meshes.meshes_items.length, `samples[${sampleIndex}].item`);
        assertLessThan(sample.material, meshes.materials.length, `samples[${sampleIndex}].material`);
        assertLessThan(sample.representation, meshes.representations.length, `samples[${sampleIndex}].representation`);
        assertLessThan(sample.local_transform, meshes.local_transforms.length, `samples[${sampleIndex}].local_transform`);
    }
    for (const [meshItemIndex, localIdIndex] of meshes.meshes_items.entries()) {
        assertLessThan(localIdIndex, model.local_ids.length, `meshes_items[${meshItemIndex}]`);
    }
    if (meshes.shells.length === 0) {
        throw new Error('meshes.shells.length must be > 0.');
    }
    for (const [shellIndex, shell] of meshes.shells.entries()) {
        if (shell.points.length === 0) {
            throw new Error(`shells[${shellIndex}].points.length must be > 0.`);
        }
        const activeProfiles = shell.type === 'BIG' ? shell.big_profiles : shell.profiles;
        const activeProfileLabel = shell.type === 'BIG' ? `shells[${shellIndex}].big_profiles` : `shells[${shellIndex}].profiles`;
        if (activeProfiles.length === 0) {
            throw new Error(`${activeProfileLabel}.length must be > 0.`);
        }
        if (shell.type === 'NONE') {
            assertEqual(shell.profiles.length, shell.profiles_face_ids.length, `shells[${shellIndex}].profiles.length vs profiles_face_ids.length`);
        }
        if (shell.type === 'BIG' && shell.profiles.length !== 0) {
            throw new Error(`shells[${shellIndex}] BIG shell must not write ushort profiles.`);
        }
        let indexMax = Number.NEGATIVE_INFINITY;
        for (const [profileIndex, profile] of activeProfiles.entries()) {
            assertEqual(profile.indices.length, 3, `${activeProfileLabel}[${profileIndex}].indices.length`);
            for (const index of profile.indices) {
                if (shell.type === 'NONE') {
                    assertLessThan(index, 65536, `${activeProfileLabel}[${profileIndex}] index`);
                }
                indexMax = Math.max(indexMax, index);
            }
        }
        assertLessThan(indexMax, shell.points.length, `shells[${shellIndex}] max profile index`);
    }
}
function renderedFacesToEnum(value) {
    if (value === 'ONE') {
        return RenderedFaces.ONE;
    }
    throw new Error(`Unsupported rendered_faces enum: ${value}`);
}
function strokeToEnum(value) {
    if (value === 'DEFAULT') {
        return Stroke.DEFAULT;
    }
    throw new Error(`Unsupported stroke enum: ${value}`);
}
function representationClassToEnum(value) {
    if (value === 'SHELL') {
        return RepresentationClass.SHELL;
    }
    throw new Error(`Unsupported representation_class enum: ${value}`);
}
function shellTypeToEnum(value) {
    if (value === 'NONE') {
        return ShellType.NONE;
    }
    if (value === 'BIG') {
        return ShellType.BIG;
    }
    throw new Error(`Unsupported shell.type enum: ${value}`);
}
function createOffsetVector(builder, offsets) {
    builder.startVector(4, offsets.length, 4);
    for (let index = offsets.length - 1; index >= 0; index--) {
        builder.addOffset(offsets[index]);
    }
    return builder.endVector();
}
function createStringVector(builder, values) {
    return createOffsetVector(builder, values.map((value) => builder.createString(value)));
}
function createTransformStruct(builder, transform) {
    return Transform.createTransform(builder, transform.position[0], transform.position[1], transform.position[2], transform.x_direction[0], transform.x_direction[1], transform.x_direction[2], transform.y_direction[0], transform.y_direction[1], transform.y_direction[2]);
}
function createTransformVector(builder, transforms) {
    Meshes.startLocalTransformsVector(builder, transforms.length);
    for (let index = transforms.length - 1; index >= 0; index--) {
        createTransformStruct(builder, transforms[index]);
    }
    return builder.endVector();
}
function createPointsVector(builder, points) {
    Shell.startPointsVector(builder, points.length);
    for (let index = points.length - 1; index >= 0; index--) {
        FloatVector.createFloatVector(builder, points[index][0], points[index][1], points[index][2]);
    }
    return builder.endVector();
}
function createSamplesVector(builder, samples) {
    Meshes.startSamplesVector(builder, samples.length);
    for (let index = samples.length - 1; index >= 0; index--) {
        const sample = samples[index];
        Sample.createSample(builder, sample.item, sample.material, sample.representation, sample.local_transform);
    }
    return builder.endVector();
}
function createRepresentationsVector(builder, representations) {
    Meshes.startRepresentationsVector(builder, representations.length);
    for (let index = representations.length - 1; index >= 0; index--) {
        const representation = representations[index];
        Representation.createRepresentation(builder, representation.id, representation.bbox.min[0], representation.bbox.min[1], representation.bbox.min[2], representation.bbox.max[0], representation.bbox.max[1], representation.bbox.max[2], representationClassToEnum(representation.representation_class));
    }
    return builder.endVector();
}
function createMaterialsVector(builder, materials) {
    Meshes.startMaterialsVector(builder, materials.length);
    for (let index = materials.length - 1; index >= 0; index--) {
        const material = materials[index];
        Material.createMaterial(builder, material.r, material.g, material.b, material.a, renderedFacesToEnum(material.rendered_faces), strokeToEnum(material.stroke));
    }
    return builder.endVector();
}
function createShellProfile(builder, indices) {
    const indicesOffset = ShellProfile.createIndicesVector(builder, indices);
    return ShellProfile.createShellProfile(builder, indicesOffset);
}
function createBigShellProfile(builder, indices) {
    const indicesOffset = BigShellProfile.createIndicesVector(builder, indices);
    return BigShellProfile.createBigShellProfile(builder, indicesOffset);
}
function createShell(builder, shell) {
    const profileOffsets = shell.profiles.map((profile) => createShellProfile(builder, profile.indices));
    const bigProfileOffsets = shell.big_profiles.map((profile) => createBigShellProfile(builder, profile.indices));
    const profilesOffset = Shell.createProfilesVector(builder, profileOffsets);
    const holesOffset = Shell.createHolesVector(builder, []);
    const pointsOffset = createPointsVector(builder, shell.points);
    const bigProfilesOffset = Shell.createBigProfilesVector(builder, bigProfileOffsets);
    const bigHolesOffset = Shell.createBigHolesVector(builder, []);
    const profilesFaceIdsOffset = Shell.createProfilesFaceIdsVector(builder, shell.profiles_face_ids);
    return Shell.createShell(builder, profilesOffset, holesOffset, pointsOffset, bigProfilesOffset, bigHolesOffset, shellTypeToEnum(shell.type), profilesFaceIdsOffset);
}
function createShellsVector(builder, shells) {
    return Meshes.createShellsVector(builder, shells.map((shell) => createShell(builder, shell)));
}
function createAttributesVector(builder, attributes) {
    const attributeOffsets = attributes.map((attribute) => {
        const dataOffset = createStringVector(builder, attribute.data);
        return Attribute.createAttribute(builder, dataOffset);
    });
    return Model.createAttributesVector(builder, attributeOffsets);
}
function createMeshes(builder, meshes) {
    const meshesItemsOffset = Meshes.createMeshesItemsVector(builder, meshes.meshes_items);
    const samplesOffset = createSamplesVector(builder, meshes.samples);
    const representationsOffset = createRepresentationsVector(builder, meshes.representations);
    const materialsOffset = createMaterialsVector(builder, meshes.materials);
    const circleExtrusionsOffset = Meshes.createCircleExtrusionsVector(builder, []);
    const shellsOffset = createShellsVector(builder, meshes.shells);
    const localTransformsOffset = createTransformVector(builder, meshes.local_transforms);
    const globalTransformsOffset = createTransformVector(builder, meshes.global_transforms);
    const materialIdsOffset = Meshes.createMaterialIdsVector(builder, meshes.material_ids ?? []);
    const representationIdsOffset = Meshes.createRepresentationIdsVector(builder, meshes.representation_ids ?? []);
    const sampleIdsOffset = Meshes.createSampleIdsVector(builder, meshes.sample_ids ?? []);
    const localTransformIdsOffset = Meshes.createLocalTransformIdsVector(builder, meshes.local_transform_ids ?? []);
    const globalTransformIdsOffset = Meshes.createGlobalTransformIdsVector(builder, meshes.global_transform_ids ?? []);
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
    Meshes.addCoordinates(builder, createTransformStruct(builder, meshes.coordinates));
    return Meshes.endMeshes(builder);
}
function createModelBuffer(fragLike) {
    validateFragLike(fragLike);
    const builder = new flatbuffers.Builder(1024 * 1024);
    const metadataOffset = builder.createString(fragLike.metadata);
    const guidsOffset = createStringVector(builder, fragLike.guids);
    const guidsItemsOffset = Model.createGuidsItemsVector(builder, fragLike.guids_items);
    const localIdsOffset = Model.createLocalIdsVector(builder, fragLike.local_ids);
    const categoriesOffset = createStringVector(builder, fragLike.categories);
    const meshesOffset = createMeshes(builder, fragLike.meshes);
    const attributesOffset = createAttributesVector(builder, fragLike.attributes ?? []);
    const relationsOffset = Model.createRelationsVector(builder, []);
    const relationsItemsOffset = Model.createRelationsItemsVector(builder, fragLike.relations_items ?? []);
    const guidOffset = builder.createString(fragLike.guid);
    const uniqueAttributesOffset = createStringVector(builder, fragLike.unique_attributes ?? []);
    const relationNamesOffset = createStringVector(builder, fragLike.relation_names ?? []);
    const indexesOffset = Model.createIndexesVector(builder, []);
    Model.startModel(builder);
    Model.addMetadata(builder, metadataOffset);
    Model.addGuids(builder, guidsOffset);
    Model.addGuidsItems(builder, guidsItemsOffset);
    Model.addMaxLocalId(builder, fragLike.max_local_id);
    Model.addLocalIds(builder, localIdsOffset);
    Model.addCategories(builder, categoriesOffset);
    Model.addMeshes(builder, meshesOffset);
    Model.addAttributes(builder, attributesOffset);
    Model.addRelations(builder, relationsOffset);
    Model.addRelationsItems(builder, relationsItemsOffset);
    Model.addGuid(builder, guidOffset);
    Model.addUniqueAttributes(builder, uniqueAttributesOffset);
    Model.addRelationNames(builder, relationNamesOffset);
    Model.addIndexes(builder, indexesOffset);
    const modelOffset = Model.endModel(builder);
    Model.finishModelBuffer(builder, modelOffset);
    return builder.asUint8Array();
}
async function main() {
    const { inputPath, outputPath, raw } = getCliArgs();
    const fragLike = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    const rawBytes = createModelBuffer(fragLike);
    const outputBytes = raw ? rawBytes : deflateSync(rawBytes);
    await fs.writeFile(outputPath, outputBytes);
    console.log(`wrote: ${outputPath}`);
    console.log(`encoding: ${raw ? 'raw-flatbuffers' : 'deflate'}`);
    console.log(`raw bytes: ${rawBytes.length}`);
    console.log(`output bytes: ${outputBytes.length}`);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
