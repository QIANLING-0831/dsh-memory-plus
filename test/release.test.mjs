import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the release tarball contains every plugin and resolves without workspace packages', async () => {
  const output = await mkdtemp(join(tmpdir(), 'dsh-release-test-'));
  try {
    execFileSync(process.execPath, [join(root, 'scripts/pack-release.mjs'), output]);
    const bundle = JSON.parse(await readFile(join(root, 'packages/dsh-memory-bundle/package.json'), 'utf8'));
    const filename = `${bundle.name}-${bundle.version}.tgz`;
    execFileSync('tar', ['-xzf', join(output, filename), '-C', output]);
    const packed = join(output, 'package');
    const manifest = JSON.parse(await readFile(join(packed, 'package.json'), 'utf8'));
    const patch = await readFile(join(packed, 'cordis.patch.yml'), 'utf8');
    const names = (await readdir(join(root, 'packages'))).filter(name => name !== bundle.name).sort();
    assert.equal(names.length, 7);
    for (const name of names) {
      assert.equal(manifest.exports[`./${name}`], `./plugins/${name}/lib/index.js`);
      assert.ok(patch.includes(`name: ${bundle.name}/${name}\n`), name);
      assert.equal(await readFile(join(packed, 'plugins', name, 'lib/index.js'), 'utf8'),
        await readFile(join(root, 'packages', name, 'lib/index.js'), 'utf8'));
      assert.ok((await readFile(join(packed, 'plugins', name, 'LICENSE'), 'utf8')).length > 0);
      assert.equal(manifest.dependencies[name], undefined);
      assert.equal(manifest.peerDependencies[name], undefined);
    }
    assert.doesNotMatch(JSON.stringify(manifest), /workspace:|file:|link:/);
    assert.ok(manifest.dependencies['sqlite-vec']);
    assert.ok(manifest.peerDependencies['@deepseek-ai/dsh-session-query']);
    assert.ok(Object.keys(manifest.dependencies).every(name => !name.startsWith('@deepseek-ai/dsh-')));
    const digest = createHash('sha256').update(await readFile(join(output, filename))).digest('hex');
    assert.equal(await readFile(join(output, 'SHA256SUMS'), 'utf8'), `${digest}  ${filename}\n`);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
