// Build a standalone bundle; the workspace source packages remain independent.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(process.argv[2] ?? join(root, '.dsh-verify/release'));
const bundleDir = join(root, 'packages/dsh-memory-bundle');
const manifest = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'));
const stage = await mkdtemp(join(tmpdir(), 'dsh-memory-release-'));
try {
  let patch = await readFile(join(bundleDir, 'cordis.patch.yml'), 'utf8');
  manifest.dependencies = {};
  manifest.peerDependencies = {};
  manifest.exports = { ...manifest.exports, './package.json': './package.json' };
  manifest.files = ['lib/', 'plugins/', 'cordis.patch.yml', 'README.md', 'LICENSE'];
  delete manifest.devDependencies;
  const names = (await readdir(join(root, 'packages'))).filter(name => name !== manifest.name).sort();
  for (const name of names) {
    const source = join(root, 'packages', name);
    const plugin = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    manifest.exports[`./${name}`] = `./plugins/${name}/lib/index.js`;
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const [dependency, range] of Object.entries(plugin[field] ?? {})) {
        if (names.includes(dependency)) continue;
        assert.ok(!/^(workspace:|file:|link:)/.test(range), `${dependency}: unresolved ${range}`);
        assert.ok(!manifest[field][dependency] || manifest[field][dependency] === range, `${dependency}: conflicting ranges`);
        manifest[field][dependency] = range;
      }
    }
    await cp(join(source, 'lib'), join(stage, 'plugins', name, 'lib'), { recursive: true });
    await cp(join(source, 'LICENSE'), join(stage, 'plugins', name, 'LICENSE'));
    patch = patch.replace(`name: ${name}\n`, `name: ${manifest.name}/${name}\n`);
  }
  for (const dependency of Object.keys(manifest.dependencies)) delete manifest.peerDependencies[dependency];
  await cp(join(bundleDir, 'lib'), join(stage, 'lib'), { recursive: true });
  await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(stage, 'cordis.patch.yml'), patch);
  await cp(join(root, 'README.en.md'), join(stage, 'README.md'));
  await cp(join(bundleDir, 'LICENSE'), join(stage, 'LICENSE'));
  await mkdir(output, { recursive: true });
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], {
    cwd: stage, encoding: 'utf8',
  }));
  const filename = packed[0].filename;
  const sha256 = createHash('sha256').update(await readFile(join(output, filename))).digest('hex');
  await writeFile(join(output, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
  console.log(join(output, filename));
} finally {
  await rm(stage, { recursive: true, force: true });
}
