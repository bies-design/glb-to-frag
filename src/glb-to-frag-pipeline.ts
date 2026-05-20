import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type CliArgs = {
  inputPath: string;
  outputDir: string;
};

function usage(): never {
  console.error('Usage: node dist/glb-to-frag-pipeline.js absolute-input.glb absolute-output-dir');
  process.exit(1);
}

function getCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const [input, output] = args;

  if (!input || !output || args.length !== 2) {
    usage();
  }

  if (!path.isAbsolute(input)) {
    throw new Error(`input.glb must be an absolute path, got: ${input}`);
  }

  if (!path.isAbsolute(output)) {
    throw new Error(`output-dir must be an absolute path, got: ${output}`);
  }

  return {
    inputPath: input,
    outputDir: output,
  };
}

function getDistDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function getModelName(inputPath: string): string {
  return path.basename(inputPath, path.extname(inputPath));
}

function getOutputPaths(inputPath: string, outputDir: string): { irPath: string; fragPath: string; materialPackageDir: string } {
  const modelName = getModelName(inputPath);

  return {
    irPath: path.join(outputDir, `${modelName}.ir.json`),
    fragPath: path.join(outputDir, `${modelName}.frag`),
    materialPackageDir: path.join(outputDir, modelName),
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
  const { inputPath, outputDir } = getCliArgs();
  const { irPath, fragPath, materialPackageDir } = getOutputPaths(inputPath, outputDir);

  console.log(`source: ${inputPath}`);
  console.log(`output dir: ${outputDir}`);
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
