import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type CliArgs = {
  inputPath: string;
  outputRoot?: string;
};

function usage(): never {
  console.error('Usage: node dist/glb-to-frag-pipeline.js input.glb [--out absolute-output-dir]');
  process.exit(1);
}

function getCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const input = args.find((arg) => !arg.startsWith('--'));
  const outIndex = args.indexOf('--out');
  const outputRoot = outIndex === -1 ? undefined : args[outIndex + 1];

  if (!input || (outIndex !== -1 && !outputRoot)) {
    usage();
  }

  if (outputRoot && !path.isAbsolute(outputRoot)) {
    throw new Error(`--out must be an absolute path, got: ${outputRoot}`);
  }

  return {
    inputPath: path.resolve(input),
    outputRoot,
  };
}

function getDistDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function getModelName(inputPath: string): string {
  return path.basename(inputPath, path.extname(inputPath));
}

function getOutputPaths(inputPath: string, outputRoot?: string): { irPath: string; fragPath: string; materialPackageDir: string } {
  const modelName = getModelName(inputPath);
  const rootDir = outputRoot ?? path.dirname(inputPath);

  return {
    irPath: path.join(rootDir, `${modelName}.ir.json`),
    fragPath: path.join(rootDir, 'frag', `${modelName}.frag`),
    materialPackageDir: path.join(rootDir, '材質包', modelName),
  };
}

async function runNodeScript(scriptName: string, args: string[]): Promise<void> {
  const scriptPath = path.join(getDistDir(), scriptName);

  console.log(`\n> node ${scriptPath} ${args.join(' ')}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${scriptName} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

async function main(): Promise<void> {
  const { inputPath, outputRoot } = getCliArgs();
  const { irPath, fragPath, materialPackageDir } = getOutputPaths(inputPath, outputRoot);

  await fs.mkdir(path.dirname(irPath), { recursive: true });
  await fs.mkdir(path.dirname(fragPath), { recursive: true });
  await fs.mkdir(materialPackageDir, { recursive: true });

  console.log(`source: ${inputPath}`);
  console.log(`ir output: ${irPath}`);
  console.log(`frag output: ${fragPath}`);
  console.log(`material package output: ${materialPackageDir}`);

  await runNodeScript('glb-to-ir.js', [inputPath, irPath]);
  await runNodeScript('ir-to-frag.js', [irPath, fragPath]);
  await runNodeScript('frag-verify.js', [fragPath]);
  await runNodeScript('glb-extract-assets.js', [inputPath, materialPackageDir]);

  console.log('\nPipeline complete.');
  console.log(`frag: ${fragPath}`);
  console.log(`ir: ${irPath}`);
  console.log(`material package: ${materialPackageDir}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
