declare module 'draco3dgltf' {
  type DracoModule = unknown;

  const draco3d: {
    createDecoderModule(): Promise<DracoModule>;
    createEncoderModule(): Promise<DracoModule>;
  };

  export default draco3d;
}
